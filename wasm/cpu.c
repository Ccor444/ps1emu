// Núcleo da CPU R3000A em C -> WebAssembly (clang --target=wasm32, sem libc).
// Reproduz exatamente src/cpu.js (step/execute): mesmo modelo pc/nextPc, load delay, exceções e custos de ciclo.
// RAM, BIOS e scratchpad vivem na memória linear (o JS enxerga como Uint8Array); o resto do mapa (I/O) volta ao JS via bread/bwrite.
typedef unsigned int u32; typedef int i32; typedef unsigned char u8; typedef unsigned short u16; typedef long long i64; typedef unsigned long long u64;
#define IMP(n) __attribute__((import_module("env"), import_name(#n)))
IMP(bread) u32 bread(u32 a, u32 size);
IMP(bwrite) void bwrite(u32 a, u32 size, u32 v);

static u32 R[32], C0[32];
static u32 S[16];
static double D[4];
static u8 RAM[2 * 1024 * 1024] __attribute__((aligned(16)));
static u8 BIOS[512 * 1024] __attribute__((aligned(16)));
static u8 SCR[1024] __attribute__((aligned(16)));
#define HI S[0]
#define LO S[1]
#define PC S[2]
#define NPC S[3]
#define ISBR S[4]
#define PENDR S[5]
#define PENDV S[6]
#define IRQ S[7]
#define HOOK S[8]
#define SKIP S[9]
#define CUR S[10]
#define INDELAY S[11]
#define CYC D[0]
#define ICNT D[1]
#define NEXT D[2]
#include "gte.c"
static inline void gcmd(u32 w) { gteCommand(w); }
static inline u32 gread(u32 k, u32 n) { return k == 0 ? gteReadData(n) : gteReadCtrl(n); }
static inline void gwrite(u32 k, u32 n, u32 v) { if (k == 0) gteWriteData(n, v); else gteWriteCtrl(n, v); }

__attribute__((export_name("ptr"))) u32 ptr(u32 i) {
  switch (i) { case 0: return (u32)R; case 1: return (u32)C0; case 2: return (u32)S; case 3: return (u32)D; case 4: return (u32)RAM; case 5: return (u32)BIOS; case 6: return (u32)SCR; case 7: return (u32)GD; case 8: return (u32)GC; case 9: return (u32)GRT; case 10: return (u32)GLL; default: return (u32)GLC; }
}

#define SR_IEC 1u
#define SR_KUC 2u
#define SR_ISC 0x10000u
#define SR_BEV 0x400000u
#define SR_CU0 0x10000000u
#define SR_CU2 0x40000000u
enum { X_INT = 0, X_ADEL = 4, X_ADES = 5, X_SYS = 8, X_BP = 9, X_RI = 10, X_CPU = 11, X_OV = 12 };

static u32 nextLdReg, nextLdVal, wr;

static inline void exc(u32 code, u32 cop) {
  u32 sr = C0[12], h = (sr & SR_BEV) ? 0xBFC00180u : 0x80000080u;
  C0[12] = (sr & 0xFFFFFFC0u) | ((sr << 2) & 0x3Fu);
  u32 cause = (C0[13] & ~0x3000007Cu) | (code << 2) | (cop << 28);
  if (INDELAY) { C0[14] = CUR - 4; cause |= 0x80000000u; } else { C0[14] = CUR; cause &= 0x7FFFFFFFu; }
  C0[13] = cause; PC = h; NPC = h + 4; ISBR = 0;
}
static inline void setR(u32 i, u32 v) { R[i] = v; wr = i; }
static inline void setLoad(u32 i, u32 v) { nextLdReg = i; nextLdVal = v; }

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

// leitura crua (sem checagem de alinhamento/custo): RAM / BIOS / scratch direto, resto no JS
static inline u32 busRead(u32 a, u32 size) {
  u32 p = physOf(a);
  if (p < 0x800000u) { u32 o = p & 0x1FFFFFu; return size == 4 ? *(u32 *)(RAM + o) : size == 2 ? *(u16 *)(RAM + o) : RAM[o]; }
  if (p - 0x1FC00000u < 0x80000u) { u32 o = p - 0x1FC00000u; return size == 4 ? *(u32 *)(BIOS + o) : size == 2 ? *(u16 *)(BIOS + o) : BIOS[o]; }
  if (p - 0x1F800000u < 0x400u) { u32 o = p - 0x1F800000u; return size == 4 ? *(u32 *)(SCR + o) : size == 2 ? *(u16 *)(SCR + o) : SCR[o]; }
  return bread(a, size);
}
static inline void busWrite(u32 a, u32 size, u32 v) {
  u32 p = physOf(a);
  if (p < 0x800000u) { u32 o = p & 0x1FFFFFu; if (size == 4) *(u32 *)(RAM + o) = v; else if (size == 2) *(u16 *)(RAM + o) = (u16)v; else RAM[o] = (u8)v; return; }
  if (p - 0x1F800000u < 0x400u) { u32 o = p - 0x1F800000u; if (size == 4) *(u32 *)(SCR + o) = v; else if (size == 2) *(u16 *)(SCR + o) = (u16)v; else SCR[o] = (u8)v; return; }
  if (p - 0x1FC00000u < 0x80000u) return;
  bwrite(a, size, v);
}
// 1 = ok; 0 = gerou exceção
static inline int rdMem(u32 a, u32 size, u32 *out) {
  if ((a & (size - 1)) || ((a & 0x80000000u) && (C0[12] & SR_KUC))) { C0[8] = a; exc(X_ADEL, 0); return 0; }
  if (C0[12] & SR_ISC) { *out = 0; return 1; }
  CYC += memCost(a, size);
  *out = busRead(a, size); return 1;
}
static inline int wrMem(u32 a, u32 size, u32 v) {
  if ((a & (size - 1)) || ((a & 0x80000000u) && (C0[12] & SR_KUC))) { C0[8] = a; exc(X_ADES, 0); return 0; }
  if (C0[12] & SR_ISC) return 1;
  busWrite(a, size, v); return 1;
}

static inline void writeCop0(u32 n, u32 v) {
  switch (n) {
    case 3: case 5: case 7: case 9: case 11: C0[n] = v; break;
    case 12: C0[12] = v & 0xF27FFF3Fu; break;
    case 13: C0[13] = (C0[13] & ~0x300u) | (v & 0x300u); break;
    default: break;
  }
}

static inline void execute(void) {
  const u32 cur = PC;
  CUR = cur; INDELAY = ISBR; ISBR = 0;
  u32 cause = C0[13]; cause = IRQ ? (cause | 0x400u) : (cause & ~0x400u); C0[13] = cause;
  const u32 sr = C0[12];
  if ((sr & SR_IEC) && (cause & sr & 0xFF00u)) { exc(X_INT, 0); return; }
  if (cur & 3) { C0[8] = cur; exc(X_ADEL, 0); return; }
  u32 w;
  { u32 p = physOf(cur);
    if (p < 0x800000u) w = *(u32 *)(RAM + (p & 0x1FFFFFu)); else w = busRead(cur, 4); }
  if (cur - 0xA0000000u < 0x20000000u) CYC += ((cur & 0x1FFFFFFFu) >= 0x1FC00000u) ? 22 : 4;
  PC = NPC; NPC += 4;

  const u32 op = w >> 26, rs = (w >> 21) & 31, rt = (w >> 16) & 31, rd = (w >> 11) & 31, sh = (w >> 6) & 31;
  const u32 imm = w & 0xFFFF; const i32 simm = (i32)(w << 16) >> 16;
  u32 *r = R;
  switch (op) {
    case 0x00:
      switch (w & 0x3F) {
        case 0x00: setR(rd, r[rt] << sh); return;
        case 0x02: setR(rd, r[rt] >> sh); return;
        case 0x03: setR(rd, (u32)((i32)r[rt] >> sh)); return;
        case 0x04: setR(rd, r[rt] << (r[rs] & 31)); return;
        case 0x06: setR(rd, r[rt] >> (r[rs] & 31)); return;
        case 0x07: setR(rd, (u32)((i32)r[rt] >> (r[rs] & 31))); return;
        case 0x08: NPC = r[rs]; ISBR = 1; return;
        case 0x09: { u32 t = r[rs]; setR(rd, cur + 8); NPC = t; ISBR = 1; return; }
        case 0x0C: exc(X_SYS, 0); return;
        case 0x0D: exc(X_BP, 0); return;
        case 0x10: setR(rd, HI); return;
        case 0x11: HI = r[rs]; return;
        case 0x12: setR(rd, LO); return;
        case 0x13: LO = r[rs]; return;
        case 0x18: { i64 p = (i64)(i32)r[rs] * (i64)(i32)r[rt]; LO = (u32)p; HI = (u32)((u64)p >> 32); return; }
        case 0x19: { u64 p = (u64)r[rs] * (u64)r[rt]; LO = (u32)p; HI = (u32)(p >> 32); return; }
        case 0x1A: { i32 n = (i32)r[rs], d = (i32)r[rt];
          if (d == 0) { HI = (u32)n; LO = n >= 0 ? 0xFFFFFFFFu : 1u; }
          else if (n == (i32)0x80000000 && d == -1) { HI = 0; LO = 0x80000000u; }
          else { LO = (u32)(n / d); HI = (u32)(n % d); }
          return; }
        case 0x1B: { u32 n = r[rs], d = r[rt]; if (d == 0) { HI = n; LO = 0xFFFFFFFFu; } else { LO = n / d; HI = n % d; } return; }
        case 0x20: { i32 a = (i32)r[rs], b = (i32)r[rt]; i32 s = (i32)((u32)a + (u32)b); if (((a ^ s) & (b ^ s)) < 0) { exc(X_OV, 0); return; } setR(rd, (u32)s); return; }
        case 0x21: setR(rd, r[rs] + r[rt]); return;
        case 0x22: { i32 a = (i32)r[rs], b = (i32)r[rt]; i32 s = (i32)((u32)a - (u32)b); if (((a ^ b) & (a ^ s)) < 0) { exc(X_OV, 0); return; } setR(rd, (u32)s); return; }
        case 0x23: setR(rd, r[rs] - r[rt]); return;
        case 0x24: setR(rd, r[rs] & r[rt]); return;
        case 0x25: setR(rd, r[rs] | r[rt]); return;
        case 0x26: setR(rd, r[rs] ^ r[rt]); return;
        case 0x27: setR(rd, ~(r[rs] | r[rt])); return;
        case 0x2A: setR(rd, (i32)r[rs] < (i32)r[rt] ? 1 : 0); return;
        case 0x2B: setR(rd, r[rs] < r[rt] ? 1 : 0); return;
        default: exc(X_RI, 0); return;
      }
    case 0x01: {
      i32 v = (i32)r[rs]; int cond = (rt & 1) ? v >= 0 : v < 0;
      if ((rt & 0x1E) == 0x10) setR(31, cur + 8);
      ISBR = 1; if (cond) NPC = cur + 4 + ((u32)simm << 2);
      return;
    }
    case 0x02: NPC = (PC & 0xF0000000u) | ((w & 0x3FFFFFFu) << 2); ISBR = 1; return;
    case 0x03: setR(31, cur + 8); NPC = (PC & 0xF0000000u) | ((w & 0x3FFFFFFu) << 2); ISBR = 1; return;
    case 0x04: ISBR = 1; if (r[rs] == r[rt]) NPC = cur + 4 + ((u32)simm << 2); return;
    case 0x05: ISBR = 1; if (r[rs] != r[rt]) NPC = cur + 4 + ((u32)simm << 2); return;
    case 0x06: ISBR = 1; if ((i32)r[rs] <= 0) NPC = cur + 4 + ((u32)simm << 2); return;
    case 0x07: ISBR = 1; if ((i32)r[rs] > 0) NPC = cur + 4 + ((u32)simm << 2); return;
    case 0x08: { i32 a = (i32)r[rs], s = (i32)((u32)a + (u32)simm); if (((a ^ s) & (simm ^ s)) < 0) { exc(X_OV, 0); return; } setR(rt, (u32)s); return; }
    case 0x09: setR(rt, r[rs] + (u32)simm); return;
    case 0x0A: setR(rt, (i32)r[rs] < simm ? 1 : 0); return;
    case 0x0B: setR(rt, r[rs] < (u32)simm ? 1 : 0); return;
    case 0x0C: setR(rt, r[rs] & imm); return;
    case 0x0D: setR(rt, r[rs] | imm); return;
    case 0x0E: setR(rt, r[rs] ^ imm); return;
    case 0x0F: setR(rt, imm << 16); return;
    case 0x10:
      if ((sr & SR_KUC) && !(sr & SR_CU0)) { exc(X_CPU, 0); return; }
      switch (rs) {
        case 0x00: setLoad(rt, C0[rd]); return;
        case 0x04: writeCop0(rd, r[rt]); return;
        case 0x10:
          if ((w & 0x3F) == 0x10) { C0[12] = (sr & 0xFFFFFFF0u) | ((sr >> 2) & 0xFu); return; }
          exc(X_RI, 0); return;
        default: return;
      }
    case 0x12:
      if (!(sr & SR_CU2)) { exc(X_CPU, 2); return; }
      if (w & 0x02000000u) { gteCommand(w & 0x1FFFFFFu); return; }
      switch (rs) {
        case 0x00: setLoad(rt, gteReadData(rd)); return;
        case 0x02: setLoad(rt, gteReadCtrl(rd)); return;
        case 0x04: gteWriteData(rd, r[rt]); return;
        case 0x06: gteWriteCtrl(rd, r[rt]); return;
        default: exc(X_RI, 0); return;
      }
    case 0x11: case 0x13: case 0x30: case 0x31: case 0x33: case 0x38: case 0x39: case 0x3B:
      if (!(sr & (0x10000000u << (op & 3)))) exc(X_CPU, op & 3);
      return;
    case 0x20: { u32 v; if (!rdMem(r[rs] + (u32)simm, 1, &v)) return; setLoad(rt, (u32)((i32)(v << 24) >> 24)); return; }
    case 0x21: { u32 v; if (!rdMem(r[rs] + (u32)simm, 2, &v)) return; setLoad(rt, (u32)((i32)(v << 16) >> 16)); return; }
    case 0x23: { u32 v; if (!rdMem(r[rs] + (u32)simm, 4, &v)) return; setLoad(rt, v); return; }
    case 0x24: { u32 v; if (!rdMem(r[rs] + (u32)simm, 1, &v)) return; setLoad(rt, v); return; }
    case 0x25: { u32 v; if (!rdMem(r[rs] + (u32)simm, 2, &v)) return; setLoad(rt, v); return; }
    case 0x22: {
      u32 a = r[rs] + (u32)simm, m; if (!rdMem(a & ~3u, 4, &m)) return;
      u32 c = (PENDR == rt) ? PENDV : r[rt], v;
      switch (a & 3) { case 0: v = (c & 0x00FFFFFFu) | (m << 24); break; case 1: v = (c & 0x0000FFFFu) | (m << 16); break; case 2: v = (c & 0x000000FFu) | (m << 8); break; default: v = m; }
      setLoad(rt, v); return;
    }
    case 0x26: {
      u32 a = r[rs] + (u32)simm, m; if (!rdMem(a & ~3u, 4, &m)) return;
      u32 c = (PENDR == rt) ? PENDV : r[rt], v;
      switch (a & 3) { case 0: v = m; break; case 1: v = (c & 0xFF000000u) | (m >> 8); break; case 2: v = (c & 0xFFFF0000u) | (m >> 16); break; default: v = (c & 0xFFFFFF00u) | (m >> 24); }
      setLoad(rt, v); return;
    }
    case 0x32: { if (!(sr & SR_CU2)) { exc(X_CPU, 2); return; } u32 v; if (!rdMem(r[rs] + (u32)simm, 4, &v)) return; gteWriteData(rt, v); return; }
    case 0x28: wrMem(r[rs] + (u32)simm, 1, r[rt] & 0xFF); return;
    case 0x29: wrMem(r[rs] + (u32)simm, 2, r[rt] & 0xFFFF); return;
    case 0x2B: wrMem(r[rs] + (u32)simm, 4, r[rt]); return;
    case 0x2A: {
      u32 a = r[rs] + (u32)simm, al = a & ~3u, m; if (!rdMem(al, 4, &m)) return;
      u32 t = r[rt], v;
      switch (a & 3) { case 0: v = (m & 0xFFFFFF00u) | (t >> 24); break; case 1: v = (m & 0xFFFF0000u) | (t >> 16); break; case 2: v = (m & 0xFF000000u) | (t >> 8); break; default: v = t; }
      wrMem(al, 4, v); return;
    }
    case 0x2E: {
      u32 a = r[rs] + (u32)simm, al = a & ~3u, m; if (!rdMem(al, 4, &m)) return;
      u32 t = r[rt], v;
      switch (a & 3) { case 0: v = t; break; case 1: v = (m & 0x000000FFu) | (t << 8); break; case 2: v = (m & 0x0000FFFFu) | (t << 16); break; default: v = (m & 0x00FFFFFFu) | (t << 24); }
      wrMem(al, 4, v); return;
    }
    case 0x3A: if (!(sr & SR_CU2)) { exc(X_CPU, 2); return; } wrMem(r[rs] + (u32)simm, 4, gteReadData(rt)); return;
    default: exc(X_RI, 0); return;
  }
}

// Roda até cycles >= nextTick. Devolve 0 (fim do prazo) ou 1 (parou no vetor A0/B0 para o JS tratar o TTY da BIOS).
__attribute__((export_name("run"))) int run(void) {
  while (CYC < NEXT) {
    if (HOOK && ((PC & 0x1FFFFFEFu) == 0xA0u)) { if (SKIP) SKIP = 0; else return 1; }
    u32 lr = PENDR, lv = PENDV;
    nextLdReg = 0; wr = 0;
    execute();
    if (lr != 0 && lr != wr) R[lr] = lv;
    PENDR = nextLdReg; PENDV = nextLdVal;
    R[0] = 0; CYC += 1; ICNT += 1;
  }
  return 0;
}

// entradas para teste/uso direto do GTE
__attribute__((export_name("gte_cmd"))) void gte_cmd(u32 w) { gcmd(w); }
__attribute__((export_name("gte_rd"))) u32 gte_rd(u32 k, u32 n) { return gread(k, n); }
__attribute__((export_name("gte_wr"))) void gte_wr(u32 k, u32 n, u32 v) { gwrite(k, n, v); }
