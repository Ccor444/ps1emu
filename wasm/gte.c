// GTE (COP2) em C: port 1:1 de src/gte.js (aritmética 44 bits em int64, mesmas flags, mesmos casos de borda do hardware).
static i32 GD[32], GC[64];
static short GRT[9], GLL[9], GLC[9];
#define GFLAG S[12]
static i32 UNR[257];
static int unrOk;

static inline i64 sar12(i64 v, int sf) { return sf ? (v >> 12) : v; }
static inline i32 trunc32(i64 v) { return (i32)(u32)(u64)v; }
static inline int s16(i32 v) { return (short)v; }
static inline i64 clampv(i64 v, i64 lo, i64 hi) { return v < lo ? lo : v > hi ? hi : v; }
static inline i64 wrap44(i64 v) { return (i64)((u64)v << 20) >> 20; }
static const i64 H44 = 8796093022208LL;

static inline i64 chk(int i, i64 v) {
  if (v >= H44) GFLAG |= 1u << (31 - i); else if (v < -H44) GFLAG |= 1u << (28 - i);
  return wrap44(v);
}
static inline i64 chk0(i64 v) { if (v > 2147483647LL) GFLAG |= 1u << 16; else if (v < -2147483648LL) GFLAG |= 1u << 15; return v; }
static inline i32 setMac(int i, i64 v, int sf) { i32 m = trunc32(sar12(v, sf)); GD[24 + i] = m; return m; }
static inline void setIr(int i, i64 v, int lm) {
  i64 lo = lm ? 0 : -0x8000, r = v;
  if (v < lo) { r = lo; GFLAG |= 1u << (25 - i); } else if (v > 0x7FFF) { r = 0x7FFF; GFLAG |= 1u << (25 - i); }
  GD[8 + i] = (i32)r;
}
static inline void setMacIr(int i, i64 v, int sf, int lm) { setIr(i, setMac(i, v, sf), lm); }
static inline void pushSZ(i64 v) {
  i64 r = v;
  if (v < 0) { r = 0; GFLAG |= 1u << 18; } else if (v > 0xFFFF) { r = 0xFFFF; GFLAG |= 1u << 18; }
  GD[16] = GD[17]; GD[17] = GD[18]; GD[18] = GD[19]; GD[19] = (i32)r;
}
static inline void pushSXY(i64 x, i64 y) {
  if (x < -0x400) { x = -0x400; GFLAG |= 1u << 14; } else if (x > 0x3FF) { x = 0x3FF; GFLAG |= 1u << 14; }
  if (y < -0x400) { y = -0x400; GFLAG |= 1u << 13; } else if (y > 0x3FF) { y = 0x3FF; GFLAG |= 1u << 13; }
  GD[12] = GD[13]; GD[13] = GD[14]; GD[14] = (i32)(((u32)(i32)y << 16) | ((u32)(i32)x & 0xFFFF));
}
static inline void pushColor(void) {
  u32 cc = 0;
  for (int i = 0; i < 3; i++) {
    i32 v = GD[25 + i] >> 4;
    if (v < 0) { v = 0; GFLAG |= 1u << (21 - i); } else if (v > 255) { v = 255; GFLAG |= 1u << (21 - i); }
    cc |= (u32)v << (8 * i);
  }
  GD[20] = GD[21]; GD[21] = GD[22]; GD[22] = (i32)(cc | ((u32)GD[6] & 0xFF000000u));
}
static inline void vec(int n, i32 v[3]) {
  if (n == 0) { v[0] = s16(GD[0]); v[1] = GD[0] >> 16; v[2] = s16(GD[1]); }
  else if (n == 1) { v[0] = s16(GD[2]); v[1] = GD[2] >> 16; v[2] = s16(GD[3]); }
  else { v[0] = s16(GD[4]); v[1] = GD[4] >> 16; v[2] = s16(GD[5]); }
}
static inline void irv(i32 v[3]) { v[0] = GD[9]; v[1] = GD[10]; v[2] = GD[11]; }
static inline void rgbv(i32 v[3]) { u32 w = (u32)GD[6]; v[0] = w & 255; v[1] = (w >> 8) & 255; v[2] = (w >> 16) & 255; }

// MACi = (tr*0x1000 + M*v) >> sf ; IRi = lim(MACi)
static void mulMat(const short *M, const i32 v[3], const i32 *tr, int sf, int lm, int doIr, i64 out[3]) {
  for (int r = 0; r < 3; r++) {
    i64 t = tr ? (i64)tr[r] * 4096 : 0;
    t = chk(r + 1, t + (i64)M[r * 3] * v[0]); t = chk(r + 1, t + (i64)M[r * 3 + 1] * v[1]); t = chk(r + 1, t + (i64)M[r * 3 + 2] * v[2]);
    out[r] = t; setMac(r + 1, t, sf);
    if (doIr) setIr(r + 1, GD[25 + r], lm);
  }
}

static i64 divide(u32 h, u32 sz3) {
  if (h >= sz3 * 2) { GFLAG |= 1u << 17; return 0x1FFFF; }
  int z = (sz3 ? __builtin_clz(sz3) : 32) - 16;
  i64 n = (i64)h << z; u32 d = sz3 << z;
  i32 u = UNR[(i32)(d - 0x7FC0) >> 7] + 0x101;
  i32 dd = (i32)((0x2000080 - (i64)d * u) >> 8);
  dd = (i32)((0x80 + (i64)dd * u) >> 8);
  i64 q = (n * dd + 0x8000) >> 16;
  return q > 0x1FFFF ? 0x1FFFF : q;
}

static void rtp(int vi, int last, int sf, int lm) {
  i32 v[3], tr[3] = {GC[37], GC[38], GC[39]}; vec(vi, v);
  i64 t[3]; mulMat(GRT, v, tr, sf, lm, 0, t);
  setIr(1, GD[25], lm); setIr(2, GD[26], lm);
  i64 z12 = t[2] >> 12;
  if (z12 < -0x8000 || z12 > 0x7FFF) GFLAG |= 1u << 22;
  GD[11] = (i32)clampv(GD[27], lm ? 0 : -0x8000, 0x7FFF);
  pushSZ(z12);
  i64 n = divide((u32)GC[58] & 0xFFFF, (u32)GD[19] & 0xFFFF);
  i64 m0x = chk0(n * s16(GD[9]) + GC[56]), m0y = chk0(n * s16(GD[10]) + GC[57]);
  GD[24] = trunc32(m0y);
  pushSXY(m0x >> 16, m0y >> 16);
  if (last) {
    i64 m = chk0(n * s16(GC[59]) + GC[60]); GD[24] = trunc32(m);
    i64 ir0 = m >> 12;
    GD[8] = (i32)clampv(ir0, 0, 0x1000); if (ir0 < 0 || ir0 > 0x1000) GFLAG |= 1u << 12;
  }
}
static void nclip(void) {
  i64 x0 = s16(GD[12]), y0 = GD[12] >> 16, x1 = s16(GD[13]), y1 = GD[13] >> 16, x2 = s16(GD[14]), y2 = GD[14] >> 16;
  GD[24] = trunc32(chk0(x0 * y1 + x1 * y2 + x2 * y0 - x0 * y2 - x1 * y0 - x2 * y1));
}
static void gop(int sf, int lm) {
  i32 ir[3]; irv(ir); i64 d1 = GRT[0], d2 = GRT[4], d3 = GRT[8];
  setMacIr(1, chk(1, ir[2] * d2 - ir[1] * d3), sf, lm);
  setMacIr(2, chk(2, ir[0] * d3 - ir[2] * d1), sf, lm);
  setMacIr(3, chk(3, ir[1] * d1 - ir[0] * d2), sf, lm);
}
static void interp(const i64 mac[3], int sf, int lm) {
  i64 ir0 = s16(GD[8]);
  for (int i = 0; i < 3; i++) {
    i64 diff = chk(i + 1, (i64)GC[53 + i] * 4096 - mac[i]);
    setIr(i + 1, trunc32(sar12(diff, sf)), 0);
    i64 v = chk(i + 1, (i64)s16(GD[9 + i]) * ir0 + mac[i]);
    setMacIr(i + 1, v, sf, lm);
  }
  pushColor();
}
static void dpcs(const i32 rgb[3], int sf, int lm) { i64 m[3] = {(i64)rgb[0] * 65536, (i64)rgb[1] * 65536, (i64)rgb[2] * 65536}; interp(m, sf, lm); }
static void intpl(int sf, int lm) { i32 ir[3]; irv(ir); i64 m[3] = {(i64)ir[0] * 4096, (i64)ir[1] * 4096, (i64)ir[2] * 4096}; interp(m, sf, lm); }
static void rgbir16(i64 m[3]) { i32 rgb[3], ir[3]; rgbv(rgb); irv(ir); for (int i = 0; i < 3; i++) m[i] = chk(i + 1, (i64)rgb[i] * ir[i] * 16); }
static void nc(const i32 v[3], int mode, int sf, int lm) {
  i64 t[3]; mulMat(GLL, v, 0, sf, lm, 1, t);
  i32 ir[3], tr[3] = {GC[45], GC[46], GC[47]}; irv(ir);
  mulMat(GLC, ir, tr, sf, lm, 1, t);
  if (mode == 0) { pushColor(); return; }
  if (mode == 1) { i32 rgb[3]; rgbv(rgb); irv(ir); for (int i = 0; i < 3; i++) setMacIr(i + 1, chk(i + 1, (i64)rgb[i] * ir[i] * 16), sf, lm); pushColor(); return; }
  i64 m[3]; rgbir16(m); interp(m, sf, lm);
}
static void cdp(int sf, int lm) {
  i64 t[3]; i32 ir[3], tr[3] = {GC[45], GC[46], GC[47]}; irv(ir);
  mulMat(GLC, ir, tr, sf, lm, 1, t);
  i64 m[3]; rgbir16(m); interp(m, sf, lm);
}
static void cc(int sf, int lm) {
  i64 t[3]; i32 ir[3], rgb[3], tr[3] = {GC[45], GC[46], GC[47]}; irv(ir);
  mulMat(GLC, ir, tr, sf, lm, 1, t);
  rgbv(rgb); irv(ir);
  for (int i = 0; i < 3; i++) setMacIr(i + 1, chk(i + 1, (i64)rgb[i] * ir[i] * 16), sf, lm);
  pushColor();
}
static void dcpl(int sf, int lm) { i64 m[3]; rgbir16(m); interp(m, sf, lm); }
static void sqr(int sf, int lm) { i32 ir[3]; irv(ir); for (int i = 0; i < 3; i++) setMacIr(i + 1, (i64)ir[i] * ir[i], sf, lm); }
static void gpf(int sf, int lm) { i32 ir[3]; irv(ir); i64 ir0 = s16(GD[8]); for (int i = 0; i < 3; i++) setMacIr(i + 1, chk(i + 1, ir[i] * ir0), sf, lm); pushColor(); }
static void gpl(int sf, int lm) {
  i32 ir[3]; irv(ir); i64 ir0 = s16(GD[8]);
  for (int i = 0; i < 3; i++) setMacIr(i + 1, chk(i + 1, (sf ? (i64)GD[25 + i] * 4096 : (i64)GD[25 + i]) + ir[i] * ir0), sf, lm);
  pushColor();
}
static void avsz(i64 zsf, int n) {
  i64 sum = n == 3 ? (GD[17] & 0xFFFF) + (GD[18] & 0xFFFF) + (GD[19] & 0xFFFF) : (GD[16] & 0xFFFF) + (GD[17] & 0xFFFF) + (GD[18] & 0xFFFF) + (GD[19] & 0xFFFF);
  i64 m = chk0(zsf * sum); GD[24] = trunc32(m);
  i64 o = m >> 12;
  if (o < 0) { GD[7] = 0; GFLAG |= 1u << 18; } else if (o > 0xFFFF) { GD[7] = 0xFFFF; GFLAG |= 1u << 18; } else GD[7] = (i32)o;
}
static void mvmva(u32 cmd, int sf, int lm) {
  int mx = (cmd >> 17) & 3, vx = (cmd >> 15) & 3, tx = (cmd >> 13) & 3;
  short junk[9]; const short *M;
  if (mx == 0) M = GRT; else if (mx == 1) M = GLL; else if (mx == 2) M = GLC;
  else {
    i32 r = (GD[6] & 255) << 4;
    junk[0] = (short)-r; junk[1] = (short)r; junk[2] = (short)GD[8]; junk[3] = junk[4] = junk[5] = GRT[2]; junk[6] = junk[7] = junk[8] = GRT[4]; M = junk;
  }
  i32 v[3]; if (vx == 3) irv(v); else vec(vx, v);
  if (tx == 2) {
    for (int r = 0; r < 3; r++) {
      i64 part = chk(r + 1, (i64)GC[53 + r] * 4096 + (i64)M[r * 3] * v[0]);
      i64 pv = sar12(part, sf), lo = lm ? 0 : -0x8000;
      if (pv < lo || pv > 0x7FFF) GFLAG |= 1u << (24 - r);
      i64 t = chk(r + 1, (i64)M[r * 3 + 1] * v[1] + (i64)M[r * 3 + 2] * v[2]);
      setMac(r + 1, t, sf); setIr(r + 1, GD[25 + r], lm);
    }
    return;
  }
  i32 tr[3]; const i32 *trp = 0;
  if (tx == 0) { tr[0] = GC[37]; tr[1] = GC[38]; tr[2] = GC[39]; trp = tr; } else if (tx == 1) { tr[0] = GC[45]; tr[1] = GC[46]; tr[2] = GC[47]; trp = tr; }
  i64 t[3]; mulMat(M, v, trp, sf, lm, 1, t);
}

static void gteCommand(u32 cmd) {
  if (!unrOk) { unrOk = 1; for (int i = 0; i <= 256; i++) { i32 x = ((0x40000 / (i + 0x100) + 1) >> 1) - 0x101; UNR[i] = x < 0 ? 0 : x; } }
  GFLAG = 0;
  int sf = (cmd >> 19) & 1, lm = (cmd >> 10) & 1;
  i32 v[3];
  switch (cmd & 0x3F) {
    case 0x01: rtp(0, 1, sf, lm); break;
    case 0x30: rtp(0, 0, sf, lm); rtp(1, 0, sf, lm); rtp(2, 1, sf, lm); break;
    case 0x06: nclip(); break;
    case 0x0C: gop(sf, lm); break;
    case 0x10: rgbv(v); dpcs(v, sf, lm); break;
    case 0x2A: for (int i = 0; i < 3; i++) { u32 w = (u32)GD[20]; i32 c[3] = {(i32)(w & 255), (i32)((w >> 8) & 255), (i32)((w >> 16) & 255)}; dpcs(c, sf, lm); } break;
    case 0x11: intpl(sf, lm); break;
    case 0x12: mvmva(cmd, sf, lm); break;
    case 0x13: vec(0, v); nc(v, 2, sf, lm); break;
    case 0x16: for (int i = 0; i < 3; i++) { vec(i, v); nc(v, 2, sf, lm); } break;
    case 0x1B: vec(0, v); nc(v, 1, sf, lm); break;
    case 0x3F: for (int i = 0; i < 3; i++) { vec(i, v); nc(v, 1, sf, lm); } break;
    case 0x1E: vec(0, v); nc(v, 0, sf, lm); break;
    case 0x20: for (int i = 0; i < 3; i++) { vec(i, v); nc(v, 0, sf, lm); } break;
    case 0x14: cdp(sf, lm); break;
    case 0x1C: cc(sf, lm); break;
    case 0x29: dcpl(sf, lm); break;
    case 0x28: sqr(sf, lm); break;
    case 0x2D: avsz(s16(GC[61]), 3); break;
    case 0x2E: avsz(s16(GC[62]), 4); break;
    case 0x3D: gpf(sf, lm); break;
    case 0x3E: gpl(sf, lm); break;
    default: break;
  }
}

static inline u32 orgb(void) { u32 r = 0; for (int k = 0; k < 3; k++) { i32 x = s16(GD[9 + k]) >> 7; if (x < 0) x = 0; if (x > 0x1F) x = 0x1F; r |= (u32)x << (5 * k); } return r; }
static u32 gteReadData(u32 i) {
  switch (i) {
    case 1: case 3: case 5: case 8: case 9: case 10: case 11: return (u32)s16(GD[i]);
    case 7: case 16: case 17: case 18: case 19: return (u32)GD[i] & 0xFFFF;
    case 15: return (u32)GD[14];
    case 28: case 29: return orgb();
    case 31: { i32 v = GD[30]; u32 x = v >= 0 ? (u32)v : ~(u32)v; return x ? (u32)__builtin_clz(x) : 32; }
    default: return (u32)GD[i];
  }
}
static void gteWriteData(u32 i, u32 vv) {
  i32 v = (i32)vv;
  switch (i) {
    case 1: case 3: case 5: case 8: case 9: case 10: case 11: GD[i] = s16(v); return;
    case 7: case 16: case 17: case 18: case 19: GD[i] = v & 0xFFFF; return;
    case 15: GD[12] = GD[13]; GD[13] = GD[14]; GD[14] = v; return;
    case 28: GD[28] = v; GD[9] = (v & 0x1F) * 0x80; GD[10] = ((v >> 5) & 0x1F) * 0x80; GD[11] = ((v >> 10) & 0x1F) * 0x80; return;
    case 29: case 31: return;
    default: GD[i] = v;
  }
}
static u32 gteReadCtrl(u32 n) {
  u32 i = n + 32;
  switch (i) {
    case 36: case 44: case 52: case 59: case 61: case 62: case 58: return (u32)s16(GC[i]);
    case 63: return GFLAG | ((GFLAG & 0x7F87E000u) ? 0x80000000u : 0);
    default: return (u32)GC[i];
  }
}
static void unpackM(short *m, int base) { for (int e = 0; e < 9; e++) { i32 w = GC[base + (e >> 1)]; m[e] = (e & 1) ? (short)(w >> 16) : (short)w; } }
static void gteWriteCtrl(u32 n, u32 vv) {
  u32 i = n + 32; i32 v = (i32)vv;
  if (i == 63) { GFLAG = vv & 0x7FFFF000u; return; }
  GC[i] = i == 58 ? (v & 0xFFFF) : v;
  if (i <= 36) unpackM(GRT, 32); else if (i >= 40 && i <= 44) unpackM(GLL, 40); else if (i >= 48 && i <= 52) unpackM(GLC, 48);
}
