// MDEC (decodificador de macroblocos) em C: porta exata de src/mdec.js (referência em test/mdec-ref.js).
// Roda dentro do módulo da CPU para que o DMA0/DMA1 leiam/escrevam a RAM direto, sem passar palavra por palavra pelo JS.
typedef short i16;
#define MOUTSZ (1 << 22)
static u8 MOUT[MOUTSZ];
static u8 QTY[64], QTC[64];
static i16 MSC[64];
static i32 MBLK[6][64], MCOEF[64], MTMP[64];
static i32 MS[16];                      // 0 state 1 remaining 2 depth 3 signed 4 bit15 5 blk 6 head 7 tail 8 dmaInEn 9 dmaOutEn 10 colorQ 11 blocksDone 12 hwPos 13 hwLen 14 qn 15 sn
static u16 HW[16384];
static u8 QB[128];
static i16 SB[64];
enum { M_IDLE, M_DECODE, M_QUANT, M_SCALE };
static const u8 ZZ[64] = {0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28,
                          35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63};
static inline i32 sx10(u32 v) { return ((i32)(v << 22)) >> 22; }
static inline i32 clampi(i32 v, i32 lo, i32 hi) { return v < lo ? lo : v > hi ? hi : v; }
XP(mdec_ptr) u32 mdec_ptr(u32 i) {
  switch (i) { case 0: return (u32)MS; case 1: return (u32)MOUT; case 2: return (u32)QTY; case 3: return (u32)QTC; case 4: return (u32)MSC; case 5: return (u32)MBLK; case 6: return (u32)HW; case 7: return (u32)QB; default: return (u32)SB; }
}
XP(mdec_reset) void mdec_reset(void) {  // mesma coisa que MDEC.reset() do JS (tabelas e saída ficam)
  for (int i = 0; i < 16; i++) MS[i] = 0;
  for (int b = 0; b < 6; b++) for (int i = 0; i < 64; i++) MBLK[b][i] = 0;
  for (int i = 0; i < 64; i++) { MCOEF[i] = 0; MTMP[i] = 0; }
}
static inline u32 outWords(void) { return (u32)(MS[7] - MS[6]) >> 2; }
static inline void put(u8 b) { if (MS[7] < MOUTSZ) MOUT[MS[7]++] = b; }

static void idct(const i32 *src, i32 *dst) {
  for (int pass = 0; pass < 2; pass++) {
    const i32 *s = pass == 0 ? src : MTMP; i32 *d = pass == 0 ? MTMP : dst;
    for (int y = 0; y < 8; y++) {
      int n = 0; int nz[8]; i32 nv[8];
      for (int z = 0; z < 8; z++) { const i32 v = s[y + z * 8]; if (v != 0) { nz[n] = z * 8; nv[n++] = v; } }
      if (n == 0) { for (int x = 0; x < 8; x++) d[x + y * 8] = 0; continue; }
      for (int x = 0; x < 8; x++) {
        i64 sum = 0;
        for (int i = 0; i < n; i++) sum += (i64)nv[i] * (i64)MSC[x + nz[i]];
        d[x + y * 8] = pass == 0 ? (i32)(sum >> 13) : (i32)((sum + 0x4000) >> 15);
      }
    }
  }
  for (int i = 0; i < 64; i++) { const i32 v = (dst[i] + 8) >> 4; dst[i] = v < -128 ? -128 : v > 127 ? 127 : v; }
}
static int decodeBlock(const u8 *qt, i32 *dst) {
  u32 p = (u32)MS[12], len = (u32)MS[13];
  while (p < len && HW[p] == 0xFE00) p++;
  if (p >= len) { MS[12] = (i32)p; return 0; }
  const u32 first = HW[p++], qscale = first >> 10;
  for (int i = 0; i < 64; i++) MCOEF[i] = 0;
  MCOEF[0] = clampi(qscale == 0 ? sx10(first & 0x3FF) * 2 : sx10(first & 0x3FF) * (i32)qt[0], -1024, 1023);
  u32 k = 0; int done = 0;
  while (p < len) {
    const u32 h = HW[p++];
    if (h == 0xFE00) { done = 1; break; }
    k += (h >> 10) + 1;
    if (k > 63) { done = 1; break; }
    { const i32 n = sx10(h & 0x3FF), q = qscale == 0 ? n * 2 : (n * (i32)qt[k] * (i32)qscale + 4) >> 3; MCOEF[ZZ[k]] = q < -1024 ? -1024 : q > 1023 ? 1023 : q; }
    if (k == 63) { done = 1; break; }
  }
  if (!done) return 0;
  MS[12] = (i32)p; idct(MCOEF, dst); MS[11]++; return 1;
}
static void emitMono(const i32 *blk) {
  const i32 off = MS[3] ? 0 : 128;
  if (MS[2] == 1) for (int i = 0; i < 64; i++) put((u8)((blk[i] + off) & 255));
  else for (int i = 0; i < 64; i += 2) put((u8)((((blk[i] + off) & 255) >> 4) | ((((blk[i + 1] + off) & 255) >> 4) << 4)));
}
static inline i32 q5(i32 v, i32 off) { const i32 r = (((v + off) & 255) + 4) >> 3; return r > 31 ? 31 : r; }
static void emitColor(void) {
  const i32 *cr = MBLK[0], *cb = MBLK[1], off = MS[3] ? 0 : 128, b15 = MS[4] << 15; const i32 *ys[4] = { MBLK[2], MBLK[3], MBLK[4], MBLK[5] };
  for (int y = 0; y < 16; y++) for (int x = 0; x < 16; x++) {
    const i32 Y = ys[((y >> 3) << 1) | (x >> 3)][((y & 7) << 3) | (x & 7)], ci = ((y >> 1) << 3) | (x >> 1), Cr = cr[ci], Cb = cb[ci];
    const i32 r = clampi(Y + ((359 * Cr + 128) >> 8), -128, 127), g = clampi(Y - ((88 * Cb + 183 * Cr + 128) >> 8), -128, 127), b = clampi(Y + ((454 * Cb + 128) >> 8), -128, 127);
    if (MS[2] == 2) { put((u8)((r + off) & 255)); put((u8)((g + off) & 255)); put((u8)((b + off) & 255)); }
    else { const i32 px = q5(r, off) | (q5(g, off) << 5) | (q5(b, off) << 10) | b15; put((u8)(px & 255)); put((u8)(px >> 8)); }
  }
}
static void decodeAvailable(void) {
  const int color = MS[2] >= 2;
  for (;;) {
    const u8 *qt = color ? (MS[5] < 2 ? QTC : QTY) : QTY;
    if (!decodeBlock(qt, MBLK[color ? MS[5] : 0])) return;
    if (!color) { emitMono(MBLK[0]); continue; }
    if (++MS[5] == 6) { MS[5] = 0; emitColor(); }
  }
}
// uma palavra de comando/parâmetro. Devolve 1 se o comando terminou e há saída (o JS então chama onOutput)
XP(mdec_word) int mdec_word(u32 w) {
  if (MS[0] == M_IDLE) {
    const u32 cmd = w >> 29;
    if (cmd == 1) { MS[2] = (i32)((w >> 27) & 3); MS[3] = (i32)((w >> 26) & 1); MS[4] = (i32)((w >> 25) & 1); MS[1] = (i32)(w & 0xFFFF); MS[0] = MS[1] ? M_DECODE : M_IDLE; MS[5] = 0; MS[13] = 0; MS[12] = 0; }
    else if (cmd == 2) { MS[10] = (w & 1) != 0; MS[1] = MS[10] ? 32 : 16; MS[14] = 0; MS[0] = M_QUANT; }
    else if (cmd == 3) { MS[1] = 32; MS[15] = 0; MS[0] = M_SCALE; }
    return 0;
  }
  if (MS[0] == M_QUANT) {
    QB[MS[14]++] = (u8)(w & 255); QB[MS[14]++] = (u8)((w >> 8) & 255); QB[MS[14]++] = (u8)((w >> 16) & 255); QB[MS[14]++] = (u8)(w >> 24);
    if (--MS[1] == 0) {
      for (int i = 0; i < 64; i++) QTY[i] = QB[i];
      if (MS[10]) for (int i = 0; i < 64; i++) QTC[i] = QB[64 + i]; else for (int i = 0; i < 64; i++) QTC[i] = QTY[i];
      MS[0] = M_IDLE;
    }
  } else if (MS[0] == M_SCALE) {
    SB[MS[15]++] = (i16)(w & 0xFFFF); SB[MS[15]++] = (i16)(w >> 16);
    if (--MS[1] == 0) { for (int i = 0; i < 64; i++) MSC[i] = SB[i]; MS[0] = M_IDLE; }
  } else {                                                            // DECODE
    if (MS[13] + 2 > 16384) { const u32 pos = (u32)MS[12], n = (u32)MS[13] - pos; for (u32 i = 0; i < n; i++) HW[i] = HW[pos + i]; MS[13] = (i32)n; MS[12] = 0; }
    HW[MS[13]++] = (u16)(w & 0xFFFF); HW[MS[13]++] = (u16)(w >> 16);
    if (MS[13] > 8192) { const u32 pos = (u32)MS[12], n = (u32)MS[13] - pos; for (u32 i = 0; i < n; i++) HW[i] = HW[pos + i]; MS[13] = (i32)n; MS[12] = 0; }
    decodeAvailable();
    if (--MS[1] == 0) {
      MS[0] = M_IDLE; MS[13] = 0; MS[12] = 0;
      if (outWords() > 0) return 1;
    }
  }
  return 0;
}
// DMA0: consome palavras da RAM até acabarem ou até um comando terminar com saída. Devolve quantas consumiu (o JS chama onOutput se `*evt`)
static i32 g_mevt;
XP(mdec_feed) u32 mdec_feed(u32 addr, u32 words, i32 step) {
  g_mevt = 0;
  for (u32 i = 0; i < words; i++) {
    const u32 w = rdw(addr); addr += (u32)step;
    if (mdec_word(w)) { g_mevt = 1; return i + 1; }
  }
  return words;
}
XP(mdec_evt) i32 mdec_evt(void) { return g_mevt; }
// próxima palavra da saída (0 se não houver); mesma contabilidade de head/tail do JS
static u32 popWord(void) {
  u32 v = 0, p = (u32)MS[6];
  if (p + 4 <= (u32)MS[7]) { v = (u32)MOUT[p] | ((u32)MOUT[p + 1] << 8) | ((u32)MOUT[p + 2] << 16) | ((u32)MOUT[p + 3] << 24); p += 4; }
  MS[6] = (i32)p; if (MS[6] == MS[7]) MS[6] = MS[7] = 0;
  return v;
}
XP(mdec_pop) u32 mdec_pop(void) { return popWord(); }
XP(mdec_outwords) u32 mdec_outwords(void) { return outWords(); }
// DMA1: escreve `words` palavras na RAM (as que faltarem vão como zero)
XP(mdec_to_ram) void mdec_to_ram(u32 addr, u32 words, i32 step) {
  for (u32 i = 0; i < words; i++) {
    const u32 v = popWord(), o = addr & 0x1FFFFCu; *(u32 *)(RAM + o) = v; if (CF[o >> 6]) inval(o >> 6);
    addr += (u32)step;
  }
}
XP(mdec_status) u32 mdec_status(void) {
  u32 s = 0;
  if (outWords() == 0) s |= 0x80000000u;
  if (MS[0] != M_IDLE) s |= 0x20000000u;
  if (MS[8]) s |= 0x10000000u;
  if (MS[9] && outWords() > 0) s |= 0x08000000u;
  s |= ((u32)MS[2] << 25) | ((u32)MS[3] << 24) | ((u32)MS[4] << 23) | ((u32)(MS[5] < 6 ? (MS[5] + 4) % 6 : 0) << 16);
  s |= MS[0] == M_IDLE ? 0u : (u32)((MS[1] - 1) & 0xFFFF);
  return s;
}
