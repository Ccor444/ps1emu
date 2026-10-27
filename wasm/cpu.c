// Núcleo da CPU R3000A em C -> WebAssembly (clang --target=wasm32, sem libc).
// Reproduz exatamente src/cpu.js (step/execute): mesmo modelo pc/nextPc, load delay, exceções e custos de ciclo.
// RAM, BIOS e scratchpad vivem na memória linear (o JS enxerga como Uint8Array); o resto do mapa (I/O) volta ao JS via bread/bwrite.
typedef unsigned int u32; typedef int i32; typedef unsigned char u8; typedef unsigned short u16; typedef long long i64; typedef unsigned long long u64;
#define IMP(n) __attribute__((import_module("env"), import_name(#n)))
IMP(bread) u32 bread(u32 a, u32 size);
IMP(bwrite) void bwrite(u32 a, u32 size, u32 v);
static void inval(u32 l);

typedef struct { u32 pc, npc, isbr, pendr, pendv, hi, lo, cur, indelay, nextLdReg, nextLdVal, wr; double cyc, icnt; } St;
static u32 R[40], C0[32];
static u32 S[32];
static double D[4];
static u8 RAM[2 * 1024 * 1024] __attribute__((aligned(16)));
static u8 BIOS[512 * 1024] __attribute__((aligned(16)));
static u8 SCR[1024] __attribute__((aligned(16)));
#define NBT 16384
static u32 BTK[NBT], BTV[4];           // cache de blocos recompilados (mapeado direto por PC): chave / índice na tabela de funções (0 = interpretar)
static u8 HOT[65536], CF[32768];          // contadores de "calor" por PC; CF = linhas de 64 B da RAM que contêm código compilado
#define GQN 65536
static u32 GQ[GQN];
static i32 GFP[32];   // 0 offX 1 offY 2 daX1 3 daY1 4 daX2 5 daY2 6 rowMask | 7 qn 8 nó 9 k(palavras já feitas no nó) 10 palavras (completas) 11 texpage 12 texpage válido
static double GFD[2]; // 0 agora (ciclos da CPU) 1 busyUntil
static double TM[32];                      // timers: [n*4+0..3] = counter, mode, target, frac; 24 = timerAt, 25 = dotDiv (o JS enxerga como timers.t[n].* / psx.timerAt)
static u32 IR[2];                          // I_STAT / I_MASK (o JS enxerga como bus.istat/imask)
static u32 g_js;                           // 1 = o último acesso de E/S foi para o JS (o bloco termina depois dele)
#define HI (s->hi)
#define LO (s->lo)
#define PC (s->pc)
#define NPC (s->npc)
#define ISBR (s->isbr)
#define PENDR (s->pendr)
#define PENDV (s->pendv)
#define IRQ S[7]
#define HOOK S[8]
#define SKIP S[9]
#define CUR (s->cur)
#define INDELAY (s->indelay)
#define CYC (s->cyc)
#define ICNT (s->icnt)
#define NEXT D[2]
#include "gte.c"
#ifdef NOGTE
static inline void gcmd(u32 w) { (void)w; }
#else
static inline void gcmd(u32 w) { gteCommand(w); }
#endif
static inline u32 gread(u32 k, u32 n) { return k == 0 ? gteReadData(n) : gteReadCtrl(n); }
static inline void gwrite(u32 k, u32 n, u32 v) { if (k == 0) gteWriteData(n, v); else gteWriteCtrl(n, v); }

static inline void syncIrq(void) { u32 c = C0[13]; C0[13] = IRQ ? (c | 0x400u) : (c & ~0x400u); }

__attribute__((export_name("ptr"))) u32 ptr(u32 i) {
  switch (i) { case 0: return (u32)R; case 1: return (u32)C0; case 2: return (u32)S; case 3: return (u32)D; case 4: return (u32)RAM; case 5: return (u32)BIOS; case 6: return (u32)SCR; case 7: return (u32)GD; case 8: return (u32)GC; case 9: return (u32)GRT; case 10: return (u32)GLL; case 11: return (u32)GLC; case 12: return (u32)BTK; case 13: return (u32)BTV; case 14: return (u32)HOT; case 16: return (u32)GFP; case 17: return (u32)GFD; case 18: return (u32)GQ; case 19: return (u32)IR; case 20: return (u32)TM; default: return (u32)CF; }
}

#define SR_IEC 1u
#define SR_KUC 2u
#define SR_ISC 0x10000u
#define SR_BEV 0x400000u
#define SR_CU0 0x10000000u
#define SR_CU2 0x40000000u
enum { X_INT = 0, X_ADEL = 4, X_ADES = 5, X_SYS = 8, X_BP = 9, X_RI = 10, X_CPU = 11, X_OV = 12 };


static inline void exc(St *s, u32 code, u32 cop) {
  u32 sr = C0[12], h = (sr & SR_BEV) ? 0xBFC00180u : 0x80000080u;
  C0[12] = (sr & 0xFFFFFFC0u) | ((sr << 2) & 0x3Fu);
  u32 cause = (C0[13] & ~0x3000007Cu) | (code << 2) | (cop << 28);
  if (INDELAY) { C0[14] = CUR - 4; cause |= 0x80000000u; } else { C0[14] = CUR; cause &= 0x7FFFFFFFu; }
  C0[13] = cause; PC = h; NPC = h + 4; ISBR = 0;
}
static inline void setR(St *s, u32 i, u32 v) { R[i] = v; s->wr = i; }
static inline void setLoad(St *s, u32 i, u32 v) { s->nextLdReg = i; s->nextLdVal = v; }

static inline u32 memCost(u32 a, u32 size) {
  u32 p = a & 0x1FFFFFFFu, k = size == 1 ? 0 : size == 2 ? 1 : 2;
  if (p < 0x800000u) return 4;
  if (p >= 0x1FC00000u) { static const u8 t[3] = {6, 12, 24}; return t[k]; }
  if (p >= 0x1FA00000u) { static const u8 t[3] = {6, 5, 9}; return t[k]; }
  if (p >= 0x1F800000u) {
    if (p < 0x1F800400u) return 0;
    if (p >= 0x1F802000u) { static const u8 t[3] = {10, 25, 55}; return t[k]; }
    if (p >= 0x1F801C00u) { static const u8 t[3] = {17, 17, 38}; return t[k]; }
    if (p >= 0x1F801800u && p < 0x1F801804u) { static const u8 t[3] = {6, 13, 25}; return t[k]; }
    return 2;
  }
  if (p >= 0x1F000000u) { static const u8 t[3] = {5, 12, 24}; return t[k]; }
  return 3;
}

static inline u32 physOf(u32 a) { u32 s = a >> 29; return s == 4 ? a & 0x7FFFFFFFu : s == 5 ? a & 0x1FFFFFFFu : a; }

static inline void spill(St *s) { S[0] = s->hi; S[1] = s->lo; S[2] = s->pc; S[3] = s->npc; S[4] = s->isbr; S[5] = s->pendr; S[6] = s->pendv; S[10] = s->cur; S[11] = s->indelay; D[0] = s->cyc; D[1] = s->icnt; }
static inline void reload(St *s) { s->cyc = D[0]; }
// leitura crua (sem checagem de alinhamento/custo): RAM / BIOS / scratch direto, resto no JS
// repetição: depois de 6 leituras idênticas seguidas o acesso volta ao JS, onde o atalho de laços de espera (pollSkip) pode agir
static inline int fastOk(u32 p, u32 v) {
  if ((i32)p == GFP[23] && (i32)v == GFP[24]) GFP[25]++; else { GFP[23] = (i32)p; GFP[24] = (i32)v; GFP[25] = 0; }
  if (GFP[22] && GFP[25] >= 6) return 0;
  GFP[26]++; return 1;
}

// leitura do contador de um timer sem sync com blank (mode b0 = 0): mesma conta de Timers.advance/add, mas sem gravar nada (retorna -1 = deixa para o JS)
static inline i32 timerPeek(St *s, u32 p) {
  const u32 n = (p >> 4) & 3;
  if (n > 2 || (p & 0xF) != 0 || TM[24] < 0) return -1;
  const double *t = TM + n * 4; const u32 mode = (u32)t[1];
  if (mode & 1) return -1;
  const u32 src = (mode >> 8) & 3; const double dt = s->cyc - TM[24]; if (dt < 0 || dt > 4e6) return -1;
  double ticks = 0;
  if (n == 0) { if (src & 1) { double f = t[3] + dt * 11 / (7 * TM[25]); ticks = (double)(i64)f; } else ticks = dt; }
  else if (n == 1) { if (!(src & 1)) ticks = dt; }
  else { if (src & 2) { double f = t[3] + dt / 8; ticks = (double)(i64)f; } else ticks = dt; }
  const int reset = (mode & 8) != 0; const i64 target = (i64)t[2]; i64 v = (i64)t[0], left = (i64)ticks;
  while (left > 0) {
    const i64 limit = (reset && v <= target) ? target : 0xFFFF, room = limit - v;
    if (left <= room) { v += left; left = 0; } else { left -= room + 1; v = 0; }
  }
  return (i32)v;
}
static inline u32 busRead(St *s, u32 a, u32 size) {
  u32 p = physOf(a); g_js = 0;
  if (p < 0x800000u) { u32 o = p & 0x1FFFFFu; return size == 4 ? *(u32 *)(RAM + o) : size == 2 ? *(u16 *)(RAM + o) : RAM[o]; }
  if (p - 0x1FC00000u < 0x80000u) { u32 o = p - 0x1FC00000u; return size == 4 ? *(u32 *)(BIOS + o) : size == 2 ? *(u16 *)(BIOS + o) : BIOS[o]; }
  if (p - 0x1F800000u < 0x400u) { u32 o = p - 0x1F800000u; return size == 4 ? *(u32 *)(SCR + o) : size == 2 ? *(u16 *)(SCR + o) : SCR[o]; }
  g_js = 0;
  if (size == 4) {                                                   // E/S mais lidas em laços de espera: servidas aqui, sem ir ao JS
    if (p == 0x1F801814u && GFP[21]) {                              // GPUSTAT (mesma conta de gpu.js readStatus; o JS publica a parte estática em GFP[16..21])
      const int busy = s->cyc < GFD[1], cmd = GFP[19] && !GFP[18];
      const u32 ready = cmd && !busy, dd = (u32)GFP[17];
      u32 v = (u32)GFP[16] | (ready ? 1u << 26 : 0) | (GFP[18] ? 1u << 27 : 0) | ((dd == 0 || !busy) ? 1u << 28 : 0) | (dd << 29) | ((u32)GFP[20] << 31);
      v |= (dd == 0 ? 0u : dd == 1 ? 1u : dd == 2 ? (ready ? 1u : 0u) : (u32)(GFP[18] ? 1 : 0)) << 25;
      if (fastOk(p, v)) return v;
    } else if (p == 0x1F801070u) { const u32 v = IR[0]; if (fastOk(p, v)) return v; }
  }
  if (size >= 2 && p - 0x1F801100u < 0x30u) { const i32 v = timerPeek(s, p); if (v >= 0 && fastOk(p, (u32)v)) return (u32)v; }
  g_js = 1; spill(s); u32 v = bread(a, size); reload(s); syncIrq(); return v;
}
static inline void busWrite(St *s, u32 a, u32 size, u32 v) {
  u32 p = physOf(a); g_js = 0;
  if (p < 0x800000u) { u32 o = p & 0x1FFFFFu; if (size == 4) *(u32 *)(RAM + o) = v; else if (size == 2) *(u16 *)(RAM + o) = (u16)v; else RAM[o] = (u8)v; if (CF[o >> 6]) inval(o >> 6); return; }
  if (p - 0x1F800000u < 0x400u) { u32 o = p - 0x1F800000u; if (size == 4) *(u32 *)(SCR + o) = v; else if (size == 2) *(u16 *)(SCR + o) = (u16)v; else SCR[o] = (u8)v; return; }
  if (p - 0x1FC00000u < 0x80000u) return;
  g_js = 1;
  if (p == 0x1F801070u || p == 0x1F801074u) {                          // I_STAT (reconhece) / I_MASK
    const u32 m = size == 4 ? 0xFFFFFFFFu : size == 2 ? 0xFFFFu : 0xFFu;
    if (p == 0x1F801070u) IR[0] = (IR[0] & (~m | v)) & 0x7FFu; else IR[1] = ((IR[1] & ~m) | (v & m)) & 0x7FFu;
    IRQ = (IR[0] & IR[1]) != 0; syncIrq(); return;
  }
  spill(s); bwrite(a, size, v); reload(s); syncIrq();
}
// 1 = ok; 0 = gerou exceção
static inline int rdMem(St *s, u32 a, u32 size, u32 *out) {
  if (__builtin_expect(!(C0[12] & (SR_KUC | SR_ISC)) && !(a & (size - 1)) && ((a & 0x1F800000u) == 0) && ((0x31u >> (a >> 29)) & 1), 1)) {
    CYC += 4; const u32 o = a & 0x1FFFFFu;
    *out = size == 4 ? *(u32 *)(RAM + o) : size == 2 ? *(u16 *)(RAM + o) : RAM[o]; return 1;
  }
  if ((a & (size - 1)) || ((a & 0x80000000u) && (C0[12] & SR_KUC))) { C0[8] = a; exc(s, X_ADEL, 0); return 0; }
  if (C0[12] & SR_ISC) { *out = 0; return 1; }
  CYC += memCost(a, size);
  *out = busRead(s, a, size); return 1;
}
static inline int wrMem(St *s, u32 a, u32 size, u32 v) {
  if (__builtin_expect(!(C0[12] & (SR_KUC | SR_ISC)) && !(a & (size - 1)) && ((a & 0x1F800000u) == 0) && ((0x31u >> (a >> 29)) & 1), 1)) {
    const u32 o = a & 0x1FFFFFu;
    if (size == 4) *(u32 *)(RAM + o) = v; else if (size == 2) *(u16 *)(RAM + o) = (u16)v; else RAM[o] = (u8)v;
    if (__builtin_expect(CF[o >> 6], 0)) inval(o >> 6);
    return 1;
  }
  if ((a & (size - 1)) || ((a & 0x80000000u) && (C0[12] & SR_KUC))) { C0[8] = a; exc(s, X_ADES, 0); return 0; }
  if (C0[12] & SR_ISC) return 1;
  busWrite(s, a, size, v); return 1;
}

static inline void writeCop0(u32 n, u32 v) {
  switch (n) {
    case 3: case 5: case 7: case 9: case 11: C0[n] = v; break;
    case 12: C0[12] = v & 0xF27FFF3Fu; break;
    case 13: C0[13] = (C0[13] & ~0x300u) | (v & 0x300u); break;
    default: break;
  }
}

static inline void execute(St *s) {
  const u32 cur = PC;
  CUR = cur; INDELAY = ISBR; ISBR = 0;
  const u32 sr = C0[12];
  if (__builtin_expect((sr & SR_IEC) && (C0[13] & sr & 0xFF00u), 0)) { exc(s, X_INT, 0); return; }
  if (__builtin_expect(cur & 3, 0)) { C0[8] = cur; exc(s, X_ADEL, 0); return; }
  u32 w;
  if (__builtin_expect(((cur & 0x1F800000u) == 0) && ((0x31u >> (cur >> 29)) & 1), 1)) {      // RAM (kuseg/kseg0/kseg1)
    w = *(u32 *)(RAM + (cur & 0x1FFFFFu));
    if (cur >= 0xA0000000u) CYC += 4;
  } else {
    w = busRead(s, cur, 4);
    if (cur - 0xA0000000u < 0x20000000u) CYC += ((cur & 0x1FFFFFFFu) >= 0x1FC00000u) ? 22 : 4;
  }
  PC = NPC; NPC += 4;

  const u32 op = w >> 26, rs = (w >> 21) & 31, rt = (w >> 16) & 31, rd = (w >> 11) & 31, sh = (w >> 6) & 31;
  const u32 imm = w & 0xFFFF; const i32 simm = (i32)(w << 16) >> 16;
  u32 *r = R;
  switch (op) {
    case 0x00:
      switch (w & 0x3F) {
        case 0x00: setR(s, rd, r[rt] << sh); return;
        case 0x02: setR(s, rd, r[rt] >> sh); return;
        case 0x03: setR(s, rd, (u32)((i32)r[rt] >> sh)); return;
        case 0x04: setR(s, rd, r[rt] << (r[rs] & 31)); return;
        case 0x06: setR(s, rd, r[rt] >> (r[rs] & 31)); return;
        case 0x07: setR(s, rd, (u32)((i32)r[rt] >> (r[rs] & 31))); return;
        case 0x08: NPC = r[rs]; ISBR = 1; return;
        case 0x09: { u32 t = r[rs]; setR(s, rd, cur + 8); NPC = t; ISBR = 1; return; }
        case 0x0C: exc(s, X_SYS, 0); return;
        case 0x0D: exc(s, X_BP, 0); return;
        case 0x10: setR(s, rd, HI); return;
        case 0x11: HI = r[rs]; return;
        case 0x12: setR(s, rd, LO); return;
        case 0x13: LO = r[rs]; return;
        case 0x18: { i64 p = (i64)(i32)r[rs] * (i64)(i32)r[rt]; LO = (u32)p; HI = (u32)((u64)p >> 32); return; }
        case 0x19: { u64 p = (u64)r[rs] * (u64)r[rt]; LO = (u32)p; HI = (u32)(p >> 32); return; }
        case 0x1A: { i32 n = (i32)r[rs], d = (i32)r[rt];
          if (d == 0) { HI = (u32)n; LO = n >= 0 ? 0xFFFFFFFFu : 1u; }
          else if (n == (i32)0x80000000 && d == -1) { HI = 0; LO = 0x80000000u; }
          else { LO = (u32)(n / d); HI = (u32)(n % d); }
          return; }
        case 0x1B: { u32 n = r[rs], d = r[rt]; if (d == 0) { HI = n; LO = 0xFFFFFFFFu; } else { LO = n / d; HI = n % d; } return; }
        case 0x20: { i32 a = (i32)r[rs], b = (i32)r[rt]; i32 sm = (i32)((u32)a + (u32)b); if (((a ^ sm) & (b ^ sm)) < 0) { exc(s, X_OV, 0); return; } setR(s, rd, (u32)sm); return; }
        case 0x21: setR(s, rd, r[rs] + r[rt]); return;
        case 0x22: { i32 a = (i32)r[rs], b = (i32)r[rt]; i32 sm = (i32)((u32)a - (u32)b); if (((a ^ b) & (a ^ sm)) < 0) { exc(s, X_OV, 0); return; } setR(s, rd, (u32)sm); return; }
        case 0x23: setR(s, rd, r[rs] - r[rt]); return;
        case 0x24: setR(s, rd, r[rs] & r[rt]); return;
        case 0x25: setR(s, rd, r[rs] | r[rt]); return;
        case 0x26: setR(s, rd, r[rs] ^ r[rt]); return;
        case 0x27: setR(s, rd, ~(r[rs] | r[rt])); return;
        case 0x2A: setR(s, rd, (i32)r[rs] < (i32)r[rt] ? 1 : 0); return;
        case 0x2B: setR(s, rd, r[rs] < r[rt] ? 1 : 0); return;
        default: exc(s, X_RI, 0); return;
      }
    case 0x01: {
      i32 v = (i32)r[rs]; int cond = (rt & 1) ? v >= 0 : v < 0;
      if ((rt & 0x1E) == 0x10) setR(s, 31, cur + 8);
      ISBR = 1; if (cond) NPC = cur + 4 + ((u32)simm << 2);
      return;
    }
    case 0x02: NPC = (PC & 0xF0000000u) | ((w & 0x3FFFFFFu) << 2); ISBR = 1; return;
    case 0x03: setR(s, 31, cur + 8); NPC = (PC & 0xF0000000u) | ((w & 0x3FFFFFFu) << 2); ISBR = 1; return;
    case 0x04: ISBR = 1; if (r[rs] == r[rt]) NPC = cur + 4 + ((u32)simm << 2); return;
    case 0x05: ISBR = 1; if (r[rs] != r[rt]) NPC = cur + 4 + ((u32)simm << 2); return;
    case 0x06: ISBR = 1; if ((i32)r[rs] <= 0) NPC = cur + 4 + ((u32)simm << 2); return;
    case 0x07: ISBR = 1; if ((i32)r[rs] > 0) NPC = cur + 4 + ((u32)simm << 2); return;
    case 0x08: { i32 a = (i32)r[rs], sm = (i32)((u32)a + (u32)simm); if (((a ^ sm) & (simm ^ sm)) < 0) { exc(s, X_OV, 0); return; } setR(s, rt, (u32)sm); return; }
    case 0x09: setR(s, rt, r[rs] + (u32)simm); return;
    case 0x0A: setR(s, rt, (i32)r[rs] < simm ? 1 : 0); return;
    case 0x0B: setR(s, rt, r[rs] < (u32)simm ? 1 : 0); return;
    case 0x0C: setR(s, rt, r[rs] & imm); return;
    case 0x0D: setR(s, rt, r[rs] | imm); return;
    case 0x0E: setR(s, rt, r[rs] ^ imm); return;
    case 0x0F: setR(s, rt, imm << 16); return;
    case 0x10:
      if ((sr & SR_KUC) && !(sr & SR_CU0)) { exc(s, X_CPU, 0); return; }
      switch (rs) {
        case 0x00: setLoad(s, rt, C0[rd]); return;
        case 0x04: writeCop0(rd, r[rt]); return;
        case 0x10:
          if ((w & 0x3F) == 0x10) { C0[12] = (sr & 0xFFFFFFF0u) | ((sr >> 2) & 0xFu); return; }
          exc(s, X_RI, 0); return;
        default: return;
      }
    case 0x12:
      if (!(sr & SR_CU2)) { exc(s, X_CPU, 2); return; }
      if (w & 0x02000000u) { gcmd(w & 0x1FFFFFFu); return; }
      switch (rs) {
        case 0x00: setLoad(s, rt, gteReadData(rd)); return;
        case 0x02: setLoad(s, rt, gteReadCtrl(rd)); return;
        case 0x04: gteWriteData(rd, r[rt]); return;
        case 0x06: gteWriteCtrl(rd, r[rt]); return;
        default: exc(s, X_RI, 0); return;
      }
    case 0x11: case 0x13: case 0x30: case 0x31: case 0x33: case 0x38: case 0x39: case 0x3B:
      if (!(sr & (0x10000000u << (op & 3)))) exc(s, X_CPU, op & 3);
      return;
    case 0x20: { u32 v; if (!rdMem(s, r[rs] + (u32)simm, 1, &v)) return; setLoad(s, rt, (u32)((i32)(v << 24) >> 24)); return; }
    case 0x21: { u32 v; if (!rdMem(s, r[rs] + (u32)simm, 2, &v)) return; setLoad(s, rt, (u32)((i32)(v << 16) >> 16)); return; }
    case 0x23: { u32 v; if (!rdMem(s, r[rs] + (u32)simm, 4, &v)) return; setLoad(s, rt, v); return; }
    case 0x24: { u32 v; if (!rdMem(s, r[rs] + (u32)simm, 1, &v)) return; setLoad(s, rt, v); return; }
    case 0x25: { u32 v; if (!rdMem(s, r[rs] + (u32)simm, 2, &v)) return; setLoad(s, rt, v); return; }
    case 0x22: {
      u32 a = r[rs] + (u32)simm, m; if (!rdMem(s, a & ~3u, 4, &m)) return;
      u32 c = (PENDR == rt) ? PENDV : r[rt], v;
      switch (a & 3) { case 0: v = (c & 0x00FFFFFFu) | (m << 24); break; case 1: v = (c & 0x0000FFFFu) | (m << 16); break; case 2: v = (c & 0x000000FFu) | (m << 8); break; default: v = m; }
      setLoad(s, rt, v); return;
    }
    case 0x26: {
      u32 a = r[rs] + (u32)simm, m; if (!rdMem(s, a & ~3u, 4, &m)) return;
      u32 c = (PENDR == rt) ? PENDV : r[rt], v;
      switch (a & 3) { case 0: v = m; break; case 1: v = (c & 0xFF000000u) | (m >> 8); break; case 2: v = (c & 0xFFFF0000u) | (m >> 16); break; default: v = (c & 0xFFFFFF00u) | (m >> 24); }
      setLoad(s, rt, v); return;
    }
    case 0x32: { if (!(sr & SR_CU2)) { exc(s, X_CPU, 2); return; } u32 v; if (!rdMem(s, r[rs] + (u32)simm, 4, &v)) return; gteWriteData(rt, v); return; }
    case 0x28: wrMem(s, r[rs] + (u32)simm, 1, r[rt] & 0xFF); return;
    case 0x29: wrMem(s, r[rs] + (u32)simm, 2, r[rt] & 0xFFFF); return;
    case 0x2B: wrMem(s, r[rs] + (u32)simm, 4, r[rt]); return;
    case 0x2A: {
      u32 a = r[rs] + (u32)simm, al = a & ~3u, m; if (!rdMem(s, al, 4, &m)) return;
      u32 t = r[rt], v;
      switch (a & 3) { case 0: v = (m & 0xFFFFFF00u) | (t >> 24); break; case 1: v = (m & 0xFFFF0000u) | (t >> 16); break; case 2: v = (m & 0xFF000000u) | (t >> 8); break; default: v = t; }
      wrMem(s, al, 4, v); return;
    }
    case 0x2E: {
      u32 a = r[rs] + (u32)simm, al = a & ~3u, m; if (!rdMem(s, al, 4, &m)) return;
      u32 t = r[rt], v;
      switch (a & 3) { case 0: v = t; break; case 1: v = (m & 0x000000FFu) | (t << 8); break; case 2: v = (m & 0x0000FFFFu) | (t << 16); break; default: v = (m & 0x00FFFFFFu) | (t << 24); }
      wrMem(s, al, 4, v); return;
    }
    case 0x3A: if (!(sr & SR_CU2)) { exc(s, X_CPU, 2); return; } wrMem(s, r[rs] + (u32)simm, 4, gteReadData(rt)); return;
    default: exc(s, X_RI, 0); return;
  }
}

// ---- ajudantes chamados pelos blocos recompilados em wasm (src/wasmjit.js); operam direto sobre S[]/D[] ----
static u32 gRead(u32 a, u32 size) {
  u32 p = physOf(a);
  if (p < 0x800000u) { u32 o = p & 0x1FFFFFu; return size == 4 ? *(u32 *)(RAM + o) : size == 2 ? *(u16 *)(RAM + o) : RAM[o]; }
  if (p - 0x1FC00000u < 0x80000u) { u32 o = p - 0x1FC00000u; return size == 4 ? *(u32 *)(BIOS + o) : size == 2 ? *(u16 *)(BIOS + o) : BIOS[o]; }
  if (p - 0x1F800000u < 0x400u) { u32 o = p - 0x1F800000u; return size == 4 ? *(u32 *)(SCR + o) : size == 2 ? *(u16 *)(SCR + o) : SCR[o]; }
  u32 v = bread(a, size); syncIrq(); return v;
}
static void gWrite(u32 a, u32 size, u32 v) {
  u32 p = physOf(a);
  if (p < 0x800000u) { u32 o = p & 0x1FFFFFu; if (size == 4) *(u32 *)(RAM + o) = v; else if (size == 2) *(u16 *)(RAM + o) = (u16)v; else RAM[o] = (u8)v; if (CF[o >> 6]) inval(o >> 6); return; }
  if (p - 0x1F800000u < 0x400u) { u32 o = p - 0x1F800000u; if (size == 4) *(u32 *)(SCR + o) = v; else if (size == 2) *(u16 *)(SCR + o) = (u16)v; else SCR[o] = (u8)v; return; }
  if (p - 0x1FC00000u < 0x80000u) return;
  bwrite(a, size, v); syncIrq();
}
#define XP(n) __attribute__((export_name(#n)))
XP(jrd) u32 jrd(u32 a, u32 size) { D[0] += (double)((i32)memCost(a, size) - 4); return gRead(a, size); }
XP(jwr) void jwr(u32 a, u32 size, u32 v) { gWrite(a, size, v); }
XP(jexc) void jexc(u32 code, u32 cop) { St st; st.cur = S[10]; st.indelay = S[11]; st.pc = st.npc = st.isbr = 0; exc(&st, code, cop); S[2] = st.pc; S[3] = st.npc; S[4] = st.isbr; }
XP(jdiv) void jdiv(u32 a, u32 b) {
  i32 n = (i32)a, d = (i32)b;
  if (d == 0) { S[0] = (u32)n; S[1] = n >= 0 ? 0xFFFFFFFFu : 1u; }
  else if (n == (i32)0x80000000 && d == -1) { S[0] = 0; S[1] = 0x80000000u; }
  else { S[1] = (u32)(n / d); S[0] = (u32)(n % d); }
}
XP(jdivu) void jdivu(u32 n, u32 d) { if (d == 0) { S[0] = n; S[1] = 0xFFFFFFFFu; } else { S[1] = n / d; S[0] = n % d; } }
XP(jcop0w) void jcop0w(u32 n, u32 v) { writeCop0(n, v); }
XP(jlwl) u32 jlwl(u32 a, u32 c) {
  u32 m = jrd(a & ~3u, 4);
  switch (a & 3) { case 0: return (c & 0x00FFFFFFu) | (m << 24); case 1: return (c & 0x0000FFFFu) | (m << 16); case 2: return (c & 0x000000FFu) | (m << 8); default: return m; }
}
XP(jlwr) u32 jlwr(u32 a, u32 c) {
  u32 m = jrd(a & ~3u, 4);
  switch (a & 3) { case 0: return m; case 1: return (c & 0xFF000000u) | (m >> 8); case 2: return (c & 0xFFFF0000u) | (m >> 16); default: return (c & 0xFFFFFF00u) | (m >> 24); }
}
XP(jswl) void jswl(u32 a, u32 t) {
  u32 al = a & ~3u, m = jrd(al, 4), v;
  switch (a & 3) { case 0: v = (m & 0xFFFFFF00u) | (t >> 24); break; case 1: v = (m & 0xFFFF0000u) | (t >> 16); break; case 2: v = (m & 0xFF000000u) | (t >> 8); break; default: v = t; }
  gWrite(al, 4, v);
}
XP(jswr) void jswr(u32 a, u32 t) {
  u32 al = a & ~3u, m = jrd(al, 4), v;
  switch (a & 3) { case 0: v = t; break; case 1: v = (m & 0x000000FFu) | (t << 8); break; case 2: v = (m & 0x0000FFFFu) | (t << 16); break; default: v = (m & 0x00FFFFFFu) | (t << 24); }
  gWrite(al, 4, v);
}
static inline void reloadAll(St *s) { s->pc = S[2]; s->npc = S[3]; s->isbr = S[4]; s->pendr = S[5]; s->pendv = S[6]; s->hi = S[0]; s->lo = S[1]; s->cur = S[10]; s->indelay = S[11]; s->cyc = D[0]; s->icnt = D[1]; }
#include "blk.c"
#include "gpf.c"
#include "mdec.c"

// Roda até cycles >= nextTick. Devolve 0 (fim do prazo), 1 (parou no vetor A0/B0 para o JS tratar o TTY da BIOS) ou
// 2 (pedido de compilação: o PC em S[13] ficou "quente"; o JS gera o bloco e chama run() de novo).
// S[15] = limiar de calor (0 desliga os blocos); S[14] != 0 = só interpretar (passo a passo).
__attribute__((export_name("run"))) int run(void) {
  St st = { S[2], S[3], S[4], S[5], S[6], S[0], S[1], S[10], S[11], 0, 0, 0, D[0], D[1] }, *s = &st;
  syncIrq();
  int ret = 0; u32 seq = 1; const u32 thr = S[15];
  while (CYC < D[2]) {
    if (__builtin_expect((PC & 0x1FFFFF00u) == 0, 0) && HOOK && ((PC & 0x1FFFFFEFu) == 0xA0u)) { if (SKIP) SKIP = 0; else { ret = 1; break; } }
    if (thr && !S[14] && !ISBR && !PENDR && !(C0[12] & (SR_ISC | SR_KUC)) && !(PC & 3)) {
      const u32 pc = PC, h = (pc >> 2) & (NBT - 1);
      if (BTK[h] == pc) {
        if (BLK[h].n) {                                                    // encadeia blocos: só reexamina o que um bloco pode ter mudado
          u32 hh = h; int ran = 0;
          for (;;) {
            if (CYC + BLK[hh].total > D[2]) break;
            syncIrq(); const u32 sr = C0[12];
            if ((sr & SR_IEC) && (C0[13] & sr & 0xFF00u)) break;
#ifdef BLKSTAT
            S[16]++; S[17] += BLK[hh].n;
#endif
            runBlock(s, hh); ran = 1;
            if (PENDR || (C0[12] & (SR_ISC | SR_KUC))) break;
            const u32 p2 = PC; hh = (p2 >> 2) & (NBT - 1); if (BTK[hh] != p2 || !BLK[hh].n) break;
          }
          if (ran) { seq = 1; continue; }
        }
      } else if (pc != seq) { u8 *hc = &HOT[(pc >> 2) & 0xFFFF]; if (*hc < 255 && ++*hc >= thr) translate(pc); }
    }
    u32 lr = PENDR, lv = PENDV;
    s->nextLdReg = 0; s->wr = 0;
#ifdef BLKSTAT
    S[18]++;
#endif
    execute(s);
    seq = CUR + 4;
    if (lr != 0 && lr != s->wr) R[lr] = lv;
    PENDR = s->nextLdReg; PENDV = s->nextLdVal;
    R[0] = 0; CYC += 1; ICNT += 1;
  }
  spill(s);
  return ret;
}

// entradas para teste/uso direto do GTE
__attribute__((export_name("gte_cmd"))) void gte_cmd(u32 w) { gcmd(w); }
__attribute__((export_name("gte_rd"))) u32 gte_rd(u32 k, u32 n) { return gread(k, n); }
__attribute__((export_name("gte_wr"))) void gte_wr(u32 k, u32 n, u32 v) { gwrite(k, n, v); }
