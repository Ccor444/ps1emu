// SPU do PS1 em WebAssembly: mixagem de 24 vozes (ADPCM, ADSR, gauss, pitch mod, ruído), sweeps, CD, reverb.
// Registradores/escritas continuam em JS (src/spu.js); todo o estado vive aqui, na memória compartilhada.
typedef unsigned char u8; typedef short i16; typedef unsigned short u16; typedef int i32; typedef unsigned int u32;
#define EXP(n) __attribute__((export_name(#n)))
#define RAMSZ (512 * 1024)
#define VS 40                                     // ints por voz
enum { G_ENDX, G_IRQF, G_IRQP, G_REVPOS, G_REVTOG, G_REVOL, G_REVOR, G_NOISE, G_NTIMER, G_SCOUNT, G_REVHEAD, G_CDH, G_CDT };
enum { V_ADDR, V_COUNTER, V_PHASE, V_LEVEL, V_ENVCNT, V_IDX, V_OLD1, V_OLD2, V_PREV, V_CUR, V_REPEAT, V_LOOPEND, V_LAST, V_H1, V_H2, V_H3, V_FLAGS, V_SAMPLES = 20 };
enum { ATTACK, DECAY, SUSTAIN, RELEASE, OFF };
static i32 G[32], V[24 * VS], SW[50 * 4], RHL[64], RHR[64], RUL[64], RUR[64];
static u16 REGS[0x200];
static i16 GAUSS[512], CDL[65536], CDR[65536], OUTB[2 * 4096];
static u8 RAM[RAMSZ], SEC[2448];
static i32 XOLD[4];
static double XPH;
static i16 XL[4040], XR[4040];
EXP(ptr) u32 ptr(int i) {
  switch (i) { case 0: return (u32)G; case 1: return (u32)V; case 2: return (u32)SW; case 3: return (u32)REGS; case 4: return (u32)RHL; case 5: return (u32)RHR;
    case 6: return (u32)RUL; case 7: return (u32)RUR; case 8: return (u32)GAUSS; case 9: return (u32)CDL; case 10: return (u32)CDR; case 11: return (u32)OUTB; case 12: return (u32)RAM; case 13: return (u32)SEC; case 14: return (u32)XOLD; case 15: return (u32)&XPH; }
  return 0;
}
#define REG(a) REGS[((a) - 0x1C00) >> 1]
static const i32 POS[5] = {0, 60, 115, 98, 122}, NEG[5] = {0, 0, -52, -55, -60};
static const i32 FIR[39] = {-1, 0, 2, 0, -10, 0, 35, 0, -103, 0, 266, 0, -616, 0, 1332, 0, -2960, 0, 10246, 0x4000, 10246, 0, -2960, 0, 1332, 0, -616, 0, 266, 0, -103, 0, 35, 0, -10, 0, 2, 0, -1};
static inline i32 sat16(i32 v) { return v > 32767 ? 32767 : v < -32768 ? -32768 : v; }
static inline i32 s16(i32 v) { return (i16)v; }
static inline void raise(void) { if (!G[G_IRQF]) { G[G_IRQF] = 1; G[G_IRQP] = 1; } }
static inline i16 *vsamp(int n) { return (i16 *)&V[n * VS + V_SAMPLES]; }
static void decode_block(int n) {
  i32 *v = &V[n * VS];
  if (REG(0x1DAA) & 0x40) { i32 ia = (REG(0x1DA4) << 3) & (RAMSZ - 1); if (ia >= v[V_ADDR] && ia < v[V_ADDR] + 16) raise(); }
  i32 o = v[V_ADDR], head = RAM[o], flags = RAM[o + 1], shift = head & 15, filter = (head >> 4) & 7; if (filter > 4) filter = 4;
  if (flags & 4) v[V_REPEAT] = v[V_ADDR];
  i32 o1 = v[V_OLD1], o2 = v[V_OLD2]; i16 *sm = vsamp(n);
  for (int i = 0; i < 28; i++) {
    i32 byte = RAM[o + 2 + (i >> 1)], nib = (i & 1) ? byte >> 4 : byte & 15;
    i32 s = s16(nib << 12) >> (shift > 12 ? 9 : shift);
    s += (o1 * POS[filter] + o2 * NEG[filter] + 32) >> 6;
    s = sat16(s); o2 = o1; o1 = s; sm[i] = s;
  }
  v[V_OLD1] = o1; v[V_OLD2] = o2; v[V_FLAGS] = flags;
}
EXP(key_on) void key_on(int n) {
  i32 *v = &V[n * VS]; i32 base = 0x1C00 + n * 16;
  v[V_ADDR] = (REG(base + 6) << 3) & (RAMSZ - 1);
  v[V_REPEAT] = v[V_ADDR]; v[V_COUNTER] = 0; v[V_IDX] = 28; v[V_OLD1] = 0; v[V_OLD2] = 0; v[V_PREV] = 0; v[V_CUR] = 0;
  v[V_LEVEL] = 0; v[V_ENVCNT] = 0; v[V_H1] = v[V_H2] = v[V_H3] = 0; v[V_PHASE] = ATTACK; G[G_ENDX] &= ~(1 << n);
  decode_block(n); v[V_IDX] = 0; v[V_CUR] = vsamp(n)[0];
}
static void envelope(i32 *v, int n) {
  i32 base = 0x1C00 + n * 16, a1 = REG(base + 8), a2 = REG(base + 10), mode, dec, shift, step;
  switch (v[V_PHASE]) {
    case ATTACK: mode = a1 >> 15; dec = 0; shift = (a1 >> 10) & 31; step = 7 - ((a1 >> 8) & 3); break;
    case DECAY: mode = 1; dec = 1; shift = (a1 >> 4) & 15; step = -8; break;
    case SUSTAIN: mode = a2 >> 15; dec = (a2 >> 14) & 1; shift = (a2 >> 8) & 31; step = dec ? -8 + ((a2 >> 6) & 3) : 7 - ((a2 >> 6) & 3); break;
    case RELEASE: mode = (a2 >> 5) & 1; dec = 1; shift = a2 & 31; step = -8; break;
    default: return;
  }
  i32 cycles = 1 << (shift > 11 ? shift - 11 : 0);
  step *= 1 << (shift < 11 ? 11 - shift : 0);
  if (mode && !dec && v[V_LEVEL] > 0x6000) cycles *= 4;
  if (mode && dec) step = (step * v[V_LEVEL]) >> 15;
  if (++v[V_ENVCNT] >= cycles) { v[V_ENVCNT] = 0; i32 l = v[V_LEVEL] + step; v[V_LEVEL] = l < 0 ? 0 : l > 0x7FFF ? 0x7FFF : l; }
  i32 ph = v[V_PHASE];
  if (ph == ATTACK && v[V_LEVEL] >= 0x7FFF) { v[V_PHASE] = DECAY; v[V_ENVCNT] = 0; }
  else if (ph == DECAY && v[V_LEVEL] <= (((a1 & 15) + 1) << 11)) { v[V_PHASE] = SUSTAIN; v[V_ENVCNT] = 0; }
  else if (ph == RELEASE && v[V_LEVEL] <= 0) v[V_PHASE] = OFF;
}
static void sweep_tick(i32 *s) {
  i32 v = s[0]; if (!(v & 0x8000)) return;
  i32 ex = (v >> 14) & 1, dec = (v >> 13) & 1, shift = (v >> 2) & 31, stp = v & 3;
  i32 step = dec ? -8 + stp : 7 - stp, cycles = 1 << (shift > 11 ? shift - 11 : 0), m = s[1] < 0 ? -s[1] : s[1];
  step *= 1 << (shift < 11 ? 11 - shift : 0);
  if (ex && !dec && m > 0x6000) cycles *= 4;
  if (ex && dec) step = (step * m) >> 15;
  if (++s[2] >= cycles) { s[2] = 0; m = m + step; m = m < 0 ? 0 : m > 0x7FFF ? 0x7FFF : m; }
  s[1] = (v & 0x1000) ? -m : m;
}
static inline i32 rev_addr(i32 base, i32 size, i32 reg, i32 extra) {
  i32 t = ((G[G_REVPOS] - base) + (reg << 3) + extra) % size; if (t < 0) t += size;
  return (base + t) & ~1;
}
static inline void chk_irq(i32 a) { if ((REG(0x1DAA) & 0x40) && (u32)(a >> 3) == (u32)REG(0x1DA4)) raise(); }
static inline i32 rd(i32 base, i32 size, i32 reg, i32 extra) { i32 a = rev_addr(base, size, reg, extra); chk_irq(a); return *(i16 *)&RAM[a]; }
static inline void wr(i32 base, i32 size, i32 en, i32 reg, i32 val) { i32 a = rev_addr(base, size, reg, 0); chk_irq(a); if (en) *(i16 *)&RAM[a] = sat16(val); }
static void rev_advance(i32 base) { G[G_REVPOS] += 2; if (G[G_REVPOS] >= RAMSZ) G[G_REVPOS] = base; }
#define RG(i) ((i32)REGS[0xE0 + (i)])
#define GR(i) s16(RG(i))
static void reverb_step(i32 inL, i32 inR) {
  i32 base = (REG(0x1DA2) << 3) & (RAMSZ - 1), size = RAMSZ - base; if (size <= 0) return;
  i32 en = (REG(0x1DAA) & 0x80) != 0;
  i32 dAPF1 = RG(0), dAPF2 = RG(1), vIIR = GR(2), vCOMB1 = GR(3), vCOMB2 = GR(4), vCOMB3 = GR(5), vCOMB4 = GR(6), vWALL = GR(7), vAPF1 = GR(8), vAPF2 = GR(9);
  i32 mLSAME = RG(10), mRSAME = RG(11), mLCOMB1 = RG(12), mRCOMB1 = RG(13), mLCOMB2 = RG(14), mRCOMB2 = RG(15), dLSAME = RG(16), dRSAME = RG(17),
      mLDIFF = RG(18), mRDIFF = RG(19), mLCOMB3 = RG(20), mRCOMB3 = RG(21), mLCOMB4 = RG(22), mRCOMB4 = RG(23), dLDIFF = RG(24), dRDIFF = RG(25),
      mLAPF1 = RG(26), mRAPF1 = RG(27), mLAPF2 = RG(28), mRAPF2 = RG(29), vLIN = GR(30), vRIN = GR(31);
  i32 Lin = (sat16(inL) * vLIN) >> 15, Rin = (sat16(inR) * vRIN) >> 15;
#define RD(r, e) rd(base, size, r, e)
#define WR(r, v) wr(base, size, en, r, v)
#define IIR(x, prev, d) (((((x) + (((d) * vWALL) >> 15) - (prev)) * vIIR) >> 15) + (prev))
  { i32 p = RD(mLSAME, -2), d = RD(dLSAME, 0); WR(mLSAME, IIR(Lin, p, d)); }
  { i32 p = RD(mRSAME, -2), d = RD(dRSAME, 0); WR(mRSAME, IIR(Rin, p, d)); }
  { i32 p = RD(mLDIFF, -2), d = RD(dRDIFF, 0); WR(mLDIFF, IIR(Lin, p, d)); }
  { i32 p = RD(mRDIFF, -2), d = RD(dLDIFF, 0); WR(mRDIFF, IIR(Rin, p, d)); }
  i32 a, b, c, d2;
  a = RD(mLCOMB1, 0) * vCOMB1; b = RD(mLCOMB2, 0) * vCOMB2; c = RD(mLCOMB3, 0) * vCOMB3; d2 = RD(mLCOMB4, 0) * vCOMB4; i32 L = (a + b + c + d2) >> 15;
  a = RD(mRCOMB1, 0) * vCOMB1; b = RD(mRCOMB2, 0) * vCOMB2; c = RD(mRCOMB3, 0) * vCOMB3; d2 = RD(mRCOMB4, 0) * vCOMB4; i32 Rr = (a + b + c + d2) >> 15;
#define APF(x, m, dd, vv) { i32 t = RD((m) - (dd), 0); i32 y = (x) - ((t * (vv)) >> 15); WR(m, y); x = ((y * (vv)) >> 15) + t; }
  APF(L, mLAPF1, dAPF1, vAPF1); APF(Rr, mRAPF1, dAPF1, vAPF1);
  APF(L, mLAPF2, dAPF2, vAPF2); APF(Rr, mRAPF2, dAPF2, vAPF2);
  G[G_REVOL] = (sat16(L) * s16(REG(0x1D84))) >> 15;
  G[G_REVOR] = (sat16(Rr) * s16(REG(0x1D86))) >> 15;
  rev_advance(base);
}
static inline i32 volfix(i32 v) { return s16((v & 0x7FFF) << 1); }
static void tick1(i16 *out) {
  i32 mixL = 0, mixR = 0, rIL = 0, rIR = 0, cnt = REG(0x1DAA);
  u32 eon = REG(0x1D98) | ((u32)REG(0x1D9A) << 16), pmon = REG(0x1D90) | ((u32)REG(0x1D92) << 16), non = REG(0x1D94) | ((u32)REG(0x1D96) << 16);
  G[G_NTIMER] -= 4 + ((cnt >> 8) & 3);
  if (G[G_NTIMER] < 0) {
    G[G_NTIMER] += 0x20000 >> ((cnt >> 10) & 15); if (G[G_NTIMER] < 0) G[G_NTIMER] = 0;
    i32 nz = G[G_NOISE]; G[G_NOISE] = ((nz << 1) | (((nz >> 15) ^ (nz >> 12) ^ (nz >> 11) ^ (nz >> 10) ^ 1) & 1)) & 0xFFFF;
  }
  for (int i = 0; i < 50; i++) if (SW[i * 4] & 0x8000) sweep_tick(&SW[i * 4]);
  for (int n = 0; n < 24; n++) {
    i32 *v = &V[n * VS]; if (v[V_PHASE] == OFF) continue;
    i32 base = 0x1C00 + n * 16, smp;
    if (non & (1u << n)) smp = s16(G[G_NOISE]);
    else {
      i32 i = (v[V_COUNTER] >> 4) & 0xFF;
      smp = sat16((GAUSS[0xFF - i] * v[V_H3] + GAUSS[0x1FF - i] * v[V_H2] + GAUSS[0x100 + i] * v[V_H1] + GAUSS[i] * v[V_CUR]) >> 15);
    }
    envelope(v, n);
    smp = (smp * v[V_LEVEL]) >> 15; v[V_LAST] = smp;
    i32 l = (smp * SW[n * 8 + 1]) >> 15, r = (smp * SW[n * 8 + 5]) >> 15;
    mixL += l; mixR += r; if (eon & (1u << n)) { rIL += l; rIR += r; }
    i32 step = REG(base + 4) & 0x3FFF;
    if ((pmon & (1u << n)) && n > 0) step = (step * (V[(n - 1) * VS + V_LAST] + 0x8000)) >> 15;
    v[V_COUNTER] += step < 0x3FFF ? step : 0x3FFF;
    while (v[V_COUNTER] >= 0x1000) {
      v[V_COUNTER] -= 0x1000; v[V_IDX]++;
      if (v[V_IDX] >= 28) {
        i32 f = v[V_FLAGS];
        if (f & 1) { G[G_ENDX] |= 1 << n; if (f & 2) v[V_ADDR] = v[V_REPEAT]; else { v[V_PHASE] = OFF; v[V_LEVEL] = 0; break; } }
        else v[V_ADDR] = (v[V_ADDR] + 16) & (RAMSZ - 1);
        decode_block(n); v[V_IDX] = 0;
      }
      v[V_H3] = v[V_H2]; v[V_H2] = v[V_H1]; v[V_H1] = v[V_CUR]; v[V_CUR] = vsamp(n)[v[V_IDX]];
    }
  }
  if (G[G_CDH] != G[G_CDT]) {
    i32 l = CDL[G[G_CDH]], r = CDR[G[G_CDH]]; G[G_CDH] = (G[G_CDH] + 1) & 0xFFFF;
    if (cnt & 1) {
      i32 cl = (l * volfix(REG(0x1DB0))) >> 15, cr = (r * volfix(REG(0x1DB2))) >> 15;
      mixL += cl; mixR += cr; if (cnt & 4) { rIL += cl; rIR += cr; }
    }
  }
  i32 hd = G[G_REVHEAD] = (G[G_REVHEAD] + 1) & 63;
  RHL[hd] = sat16(rIL); RHR[hd] = sat16(rIR);
  G[G_REVTOG] ^= 1;
  i32 newL = 0, newR = 0;
  if (G[G_REVTOG]) {
    i32 aL = 0, aR = 0;
    if (cnt & 0x80) for (int k = 0; k < 39; k++) { i32 c = FIR[k]; if (c) { i32 j = (hd - k) & 63; aL += c * RHL[j]; aR += c * RHR[j]; } }
    if (cnt & 0x80) reverb_step(sat16(aL >> 15), sat16(aR >> 15)); else { G[G_REVOL] = G[G_REVOR] = 0; rev_advance((REG(0x1DA2) << 3) & (RAMSZ - 1)); }
    newL = G[G_REVOL]; newR = G[G_REVOR];
  }
  RUL[hd] = newL; RUR[hd] = newR;
  if (cnt & 0x80) {
    i32 uL = 0, uR = 0;
    for (int k = 0; k < 39; k++) { i32 c = FIR[k]; if (c) { i32 j = (hd - k) & 63; uL += c * RUL[j]; uR += c * RUR[j]; } }
    mixL += sat16(uL >> 14); mixR += sat16(uR >> 14);
  }
  if (!(cnt & 0x8000)) { out[0] = 0; out[1] = 0; return; }
  i32 mL = (mixL * SW[48 * 4 + 1]) >> 15, mR = (mixR * SW[49 * 4 + 1]) >> 15;
  G[G_SCOUNT]++;
  out[0] = sat16(cnt & 0x4000 ? mL : 0); out[1] = sat16(cnt & 0x4000 ? mR : 0);
}
EXP(render) void render(int frames) { if (frames > 4096) frames = 4096; for (int i = 0; i < frames; i++) tick1(&OUTB[i * 2]); }

// ---- áudio do CD (usado por src/cdrom.js): o setor de 2352 bytes é copiado para SEC ----
static void push_cd(i32 l, i32 r) { i32 t = G[G_CDT], nx = (t + 1) & 0xFFFF; if (nx == G[G_CDH]) return; CDL[t] = sat16(l); CDR[t] = sat16(r); G[G_CDT] = nx; }
static const i32 XPOS[4] = {0, 60, 115, 98}, XNEG[4] = {0, 0, -52, -55};
/** XA-ADPCM 4 bits: decodifica os 18 grupos de SEC, reamostra (linear, 37800/18900 -> 44100) e empurra na fila do CD */
EXP(xa_decode) void xa_decode(int coding, int muted) {
  int stereo = coding & 1, n = 0; double ratio = ((coding & 4) ? 18900.0 : 37800.0) / 44100.0; i16 units[8][28];
  for (int g = 0; g < 18; g++) {
    int base = 24 + g * 128;
    for (int i = 0; i < 8; i++) {
      i32 hdr = SEC[base + (i < 4 ? i : i + 4)], range = hdr & 15, filt = (hdr >> 4) & 3, shift = range > 12 ? 9 : range;
      i32 *old = &XOLD[(stereo ? (i & 1) : 0) * 2];
      for (int w = 0; w < 28; w++) {
        i32 byte = SEC[base + 16 + w * 4 + (i >> 1)], nib = (i & 1) ? byte >> 4 : byte & 15;
        i32 s = ((i16)(nib << 12)) >> shift;
        s = sat16(s + ((old[0] * XPOS[filt] + old[1] * XNEG[filt] + 32) >> 6));
        old[1] = old[0]; old[0] = s; units[i][w] = s;
      }
    }
    if (stereo) { for (int q = 0; q < 4; q++) for (int k = 0; k < 28; k++) { XL[n] = units[2 * q][k]; XR[n] = units[2 * q + 1][k]; n++; } }
    else { for (int i = 0; i < 8; i++) for (int k = 0; k < 28; k++) { XL[n] = XR[n] = units[i][k]; n++; } }
  }
  double t = XPH;
  while (t < n - 1) {
    int i = (int)t; double f = t - i;
    if (!muted) push_cd((i32)((double)XL[i] + (double)(XL[i + 1] - XL[i]) * f), (i32)((double)XR[i] + (double)(XR[i + 1] - XR[i]) * f));
    t += ratio;
  }
  XPH = t - (n - 1);
}
/** CD-DA: 588 amostras estéreo de SEC; devolve o pico (|l|,|r|) */
EXP(cdda) int cdda(int muted) {
  int pk = 0;
  for (int i = 0; i < 588; i++) {
    int o = i * 4; i32 l = (i16)(SEC[o] | (SEC[o + 1] << 8)), r = (i16)(SEC[o + 2] | (SEC[o + 3] << 8));
    if (!muted) push_cd(l, r);
    i32 a = l < 0 ? -l : l, b = r < 0 ? -r : r; if (a > pk) pk = a; if (b > pk) pk = b;
  }
  return pk;
}
EXP(rev_step) void rev_step(i32 l, i32 r) { reverb_step(l, r); }   // (testes) um passo do motor de reverb
