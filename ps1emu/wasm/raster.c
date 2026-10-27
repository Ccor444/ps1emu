// Rasterizador da GPU do PS1 em C -> WebAssembly. Espelho exato de src/gpu.js (triangle/rect/lineCmd/fillRect/vramCopy):
// mesma regra de cobertura, mesmos gradientes em ponto fixo (aritmética de 32 bits que "dá a volta"), dither, máscara e semi-transparência.
// A VRAM (1024x512 x 16 bits) vive na memória do wasm; o JS (src/wasmgpu.js) preenche o bloco de parâmetros P e chama tri/rect/line/fill/copy.
typedef unsigned int u32; typedef int i32; typedef unsigned short u16; typedef unsigned char u8; typedef long long i64;
static u16 VRAM[1024 * 512] __attribute__((aligned(16)));
static i32 P[256];
static u16 CLUT[256];
static u16 SNAP[1024 * 512] __attribute__((aligned(16)));
static u8 MOT[1024 * 512] __attribute__((aligned(16)));
static u8 OUT[640 * 576 * 4] __attribute__((aligned(16)));
static i32 clutValid, clutX_, clutY_, clutCount;
static const signed char DITHER[16] = { -4, 0, -3, 1, 2, -2, 3, -1, -3, 1, -4, 0, 3, -1, 2, -2 };
static u8 QT[1024];
static int qt_ready;

#define S_DAX1 P[0]
#define S_DAY1 P[1]
#define S_DAX2 P[2]
#define S_DAY2 P[3]
#define S_TEXX P[4]
#define S_TEXY P[5]
#define S_SEMI P[6]
#define S_TD P[7]
#define S_DITHER P[8]
#define S_MX P[9]
#define S_MY P[10]
#define S_OX P[11]
#define S_OY P[12]
#define S_SETM P[13]
#define S_CHK P[14]
#define S_ROWMASK P[15]
#define S_FLIPX P[16]
#define S_FLIPY P[17]

__attribute__((export_name("ptr_vram"))) u32 ptr_vram(void) { return (u32)VRAM; }
__attribute__((export_name("ptr_p"))) u32 ptr_p(void) { return (u32)P; }
__attribute__((export_name("ptr_out"))) u32 ptr_out(void) { return (u32)OUT; }
__attribute__((export_name("ptr_snap"))) u32 ptr_snap(void) { return (u32)SNAP; }
__attribute__((export_name("ptr_mot"))) u32 ptr_mot(void) { return (u32)MOT; }
__attribute__((export_name("inv_clut"))) void inv_clut(void) { clutValid = 0; }

static inline void qtInit(void) { if (qt_ready) return; for (int i = 0; i < 1024; i++) { int v = i - 8; QT[i] = (u8)((v < 0 ? 0 : v > 255 ? 255 : v) >> 3); } qt_ready = 1; }
static void clutPrep(i32 cx, i32 cy) {
  if (S_TD > 1) return;
  i32 need = S_TD == 0 ? 16 : 256;
  if (clutValid && clutX_ == cx && clutY_ == cy && clutCount >= need) return;
  for (i32 i = 0; i < need; i++) CLUT[i] = VRAM[cy * 1024 + ((cx * 16 + i) & 0x3FF)];
  clutValid = 1; clutX_ = cx; clutY_ = cy; clutCount = need;
}

typedef struct { i32 x, y, r, g, b, u, v; } Vtx;

static inline i32 ceilDiv(i32 n, i32 d) { return n >= 0 ? (n + d - 1) / d : -((-n) / d); }   // d > 0

// scanline especializada por (tex/profundidade, gouraud, raw, semi); dither, máscara e janela de textura em tempo de execução (ramos previsíveis)
#define SPAN_ARGS i32 y, i32 xl, i32 xr, u32 cr, u32 cg, u32 cb, u32 cu, u32 cv, i32 rGx, i32 gGx, i32 bGx, i32 uGx, i32 vGx, i32 fr, i32 fg, i32 fb, i32 tBase, i32 tY, i32 uAnd, i32 uOr, i32 vAnd, i32 vOr, i32 smode, u32 setM, i32 dd, i32 chk, i32 win
static inline __attribute__((always_inline)) void span_t(int tex, int td, int gour, int raw, int semi, SPAN_ARGS) {
  const i32 rowI = y * 1024, dRow = (y & 3) << 2;
  for (i32 x = xl; x < xr; x++) {
    i32 r, g, bl;
    if (gour) { r = ((i32)cr >> 12) & 255; g = ((i32)cg >> 12) & 255; bl = ((i32)cb >> 12) & 255; cr += rGx; cg += gGx; cb += bGx; }
    else { r = fr; g = fg; bl = fb; }
    int sm = 1;
    if (tex) {
      i32 u, v;
      if (win) { u = (((i32)cu >> 12) & 255 & uAnd) | uOr; v = (((i32)cv >> 12) & 255 & vAnd) | vOr; }
      else { u = ((i32)cu >> 12) & 255; v = ((i32)cv >> 12) & 255; }
      cu += uGx; cv += vGx;
      const i32 row = ((tY + v) & 0x1FF) << 10;
      u32 texel;
      if (td == 0) texel = CLUT[(VRAM[row + ((tBase + (u >> 2)) & 0x3FF)] >> ((u & 3) << 2)) & 15];
      else if (td == 1) texel = CLUT[(VRAM[row + ((tBase + (u >> 1)) & 0x3FF)] >> ((u & 1) << 3)) & 255];
      else texel = VRAM[row + ((tBase + u) & 0x3FF)];
      if (texel == 0) continue;
      if (semi) sm = (texel & 0x8000) != 0;
      i32 tr = texel & 31, tg = (texel >> 5) & 31, tb = (texel >> 10) & 31;
      if (raw) { r = tr << 3; g = tg << 3; bl = tb << 3; } else { r = (tr * r) >> 4; g = (tg * g) >> 4; bl = (tb * bl) >> 4; }
    }
    const i32 idx = rowI + x;
    u32 back = 0;
    if (chk || semi) back = VRAM[idx];
    if (chk && (back & 0x8000)) continue;
    if (dd) { i32 d = DITHER[dRow | (x & 3)]; r += d; g += d; bl += d; }
    r = QT[r + 8]; g = QT[g + 8]; bl = QT[bl + 8];
    if (semi && sm) {
      i32 br = back & 31, bg = (back >> 5) & 31, bb = (back >> 10) & 31;
      switch (smode) {
        case 0: r = (br + r) >> 1; g = (bg + g) >> 1; bl = (bb + bl) >> 1; break;
        case 1: r = br + r > 31 ? 31 : br + r; g = bg + g > 31 ? 31 : bg + g; bl = bb + bl > 31 ? 31 : bb + bl; break;
        case 2: r = br - r < 0 ? 0 : br - r; g = bg - g < 0 ? 0 : bg - g; bl = bb - bl < 0 ? 0 : bb - bl; break;
        default: { i32 a = br + (r >> 2), b2 = bg + (g >> 2), c2 = bb + (bl >> 2); r = a > 31 ? 31 : a; g = b2 > 31 ? 31 : b2; bl = c2 > 31 ? 31 : c2; }
      }
    }
    VRAM[idx] = (u16)(r | (g << 5) | (bl << 10) | setM);
  }
}
#define SPAN_CALL(tex, td, gour, raw, semi) span_t(tex, td, gour, raw, semi, y, xl, xr, cr, cg, cb, cu, cv, rGx, gGx, bGx, uGx, vGx, fr, fg, fb, tBase, tY, uAnd, uOr, vAnd, vOr, smode, setM, dd, chk, win)
static void span(int tex, int td, int gour, int raw, int semi, SPAN_ARGS) {
  if (!tex) {
    if (gour) { if (semi) SPAN_CALL(0, 0, 1, 0, 1); else SPAN_CALL(0, 0, 1, 0, 0); }
    else { if (semi) SPAN_CALL(0, 0, 0, 0, 1); else SPAN_CALL(0, 0, 0, 0, 0); }
    return;
  }
#define TD(T) \
  if (td == T) { \
    if (gour) { if (raw) { if (semi) SPAN_CALL(1, T, 1, 1, 1); else SPAN_CALL(1, T, 1, 1, 0); } else { if (semi) SPAN_CALL(1, T, 1, 0, 1); else SPAN_CALL(1, T, 1, 0, 0); } } \
    else { if (raw) { if (semi) SPAN_CALL(1, T, 0, 1, 1); else SPAN_CALL(1, T, 0, 1, 0); } else { if (semi) SPAN_CALL(1, T, 0, 0, 1); else SPAN_CALL(1, T, 0, 0, 0); } } \
    return; }
  TD(0) TD(1) TD(2)
#undef TD
}

static void triangle(Vtx a, Vtx b, Vtx c, int tex, int gour, int raw, int semi) {
  Vtx A = a, B = b, C = c, t;
  if (C.y < B.y) { t = B; B = C; C = t; }
  if (B.y < A.y) { t = A; A = B; B = t; }
  if (C.y < B.y) { t = B; B = C; C = t; }
  if (C.y == A.y) return;
  const i32 D = (B.x - A.x) * (C.y - A.y) - (C.x - A.x) * (B.y - A.y);
  if (D == 0) return;
  i32 minX = A.x < B.x ? A.x : B.x; if (C.x < minX) minX = C.x;
  i32 maxX = A.x > B.x ? A.x : B.x; if (C.x > maxX) maxX = C.x;
  if (maxX - minX > 1023 || C.y - A.y > 511) return;
  i32 yS = A.y > S_DAY1 ? A.y : S_DAY1; if (yS < 0) yS = 0;
  i32 yE = C.y - 1 < S_DAY2 ? C.y - 1 : S_DAY2; if (yE > 511) yE = 511;
  if (yS > yE) return;
  i32 xMin = S_DAX1 > 0 ? S_DAX1 : 0, xMax = S_DAX2 < 1023 ? S_DAX2 : 1023;
  const int shortRight = D > 0;
  const i32 dxL = C.x - A.x, dyL = C.y - A.y;
  i32 rGx = 0, rGy = 0, gGx = 0, gGy = 0, bGx = 0, bGy = 0, uGx = 0, uGy = 0, vGx = 0, vGy = 0;
#define GRAD(ca, cb, cc, GX, GY) { i64 nx = (i64)((cb) - (ca)) * (C.y - A.y) - (i64)((cc) - (ca)) * (B.y - A.y); i64 ny = (i64)((cc) - (ca)) * (B.x - A.x) - (i64)((cb) - (ca)) * (C.x - A.x); GX = (i32)(nx * 4096 / D); GY = (i32)(ny * 4096 / D); }
  if (gour) { GRAD(A.r, B.r, C.r, rGx, rGy); GRAD(A.g, B.g, C.g, gGx, gGy); GRAD(A.b, B.b, C.b, bGx, bGy); }
  if (tex) { GRAD(A.u, B.u, C.u, uGx, uGy); GRAD(A.v, B.v, C.v, vGx, vGy); }
  const Vtx Pv = a;
  const u32 r0 = ((u32)Pv.r << 12) + 2048, g0 = ((u32)Pv.g << 12) + 2048, b0 = ((u32)Pv.b << 12) + 2048, u0 = ((u32)Pv.u << 12) + 2048, v0 = ((u32)Pv.v << 12) + 2048;
  const int dthrOn = S_DITHER != 0;
  const int dith = dthrOn && (gour || (tex && !raw));
  const u32 setM = S_SETM ? 0x8000 : 0;
  const i32 smode = S_SEMI, chk = S_CHK, td = S_TD, tBase = S_TEXX * 64, tY = S_TEXY * 256;
  const i32 mx = S_MX, my = S_MY, uAnd = ~(mx << 3), uOr = (S_OX & mx) << 3, vAnd = ~(my << 3), vOr = (S_OY & my) << 3;
  const i32 dd = tex ? (!raw && dthrOn) : dith;
  const i32 win = tex && (mx | my) != 0;
  const i32 mk = S_ROWMASK;
  for (i32 y = yS; y <= yE; y++) {
    if (mk >= 0 && (y & 1) == mk) continue;
    const i32 nL = A.x * dyL + (y - A.y) * dxL;
    const i32 lx = ceilDiv(nL, dyL);
    i32 sx, xl, xr;
    if (y < B.y) sx = ceilDiv(A.x * (B.y - A.y) + (y - A.y) * (B.x - A.x), B.y - A.y);
    else sx = ceilDiv(B.x * (C.y - B.y) + (y - B.y) * (C.x - B.x), C.y - B.y);
    if (shortRight) { xl = lx; xr = sx; } else { xl = sx; xr = lx; }
    if (xl < xMin) xl = xMin;
    if (xr > xMax + 1) xr = xMax + 1;
    if (xl >= xr) continue;
    const i32 dy = y - Pv.y, dx = xl - Pv.x;
    u32 cr = (u32)((i64)r0 + (i64)rGy * dy + (i64)rGx * dx), cg = (u32)((i64)g0 + (i64)gGy * dy + (i64)gGx * dx), cb = (u32)((i64)b0 + (i64)bGy * dy + (i64)bGx * dx);
    u32 cu = (u32)((i64)u0 + (i64)uGy * dy + (i64)uGx * dx), cv = (u32)((i64)v0 + (i64)vGy * dy + (i64)vGx * dx);
    span(tex, tex ? td : 0, gour, raw && tex, semi, y, xl, xr, cr, cg, cb, cu, cv, rGx, gGx, bGx, uGx, vGx, A.r, A.g, A.b, tBase, tY, uAnd, uOr, vAnd, vOr, smode, setM, dd, chk, win);
  }
}

static inline Vtx loadV(const i32 *p) { Vtx v = { p[0], p[1], p[2], p[3], p[4], p[5], p[6] }; return v; }

// P[32]=flags (b0 tex, b1 gour, b2 semi, b3 raw, b4 quad), P[33]=clutX, P[34]=clutY, vértices (x,y,r,g,b,u,v) a partir de P[36]
__attribute__((export_name("tri"))) void tri(void) {
  qtInit();
  const i32 f = P[32]; const int tex = f & 1, gour = (f >> 1) & 1, semi = (f >> 2) & 1, raw = (f >> 3) & 1, quad = (f >> 4) & 1;
  if (tex) clutPrep(P[33], P[34]);
  Vtx v0 = loadV(P + 36), v1 = loadV(P + 43), v2 = loadV(P + 50);
  triangle(v0, v1, v2, tex, gour, raw, semi);
  if (quad) { Vtx v3 = loadV(P + 57); triangle(v1, v2, v3, tex, gour, raw, semi); }
}

static inline void plotNB(i32 x, i32 y, i32 r, i32 g, i32 b, int semi, int dith) {
  const i32 idx = y * 1024 + x; const u32 back = VRAM[idx];
  if (S_CHK && (back & 0x8000)) return;
  if (dith) { i32 d = DITHER[((y & 3) << 2) | (x & 3)]; r += d; g += d; b += d; }
  r = (r < 0 ? 0 : r > 255 ? 255 : r) >> 3; g = (g < 0 ? 0 : g > 255 ? 255 : g) >> 3; b = (b < 0 ? 0 : b > 255 ? 255 : b) >> 3;
  if (semi) {
    i32 br = back & 31, bg = (back >> 5) & 31, bb = (back >> 10) & 31;
    switch (S_SEMI) {
      case 0: r = (br + r) >> 1; g = (bg + g) >> 1; b = (bb + b) >> 1; break;
      case 1: r = br + r > 31 ? 31 : br + r; g = bg + g > 31 ? 31 : bg + g; b = bb + b > 31 ? 31 : bb + b; break;
      case 2: r = br - r < 0 ? 0 : br - r; g = bg - g < 0 ? 0 : bg - g; b = bb - b < 0 ? 0 : bb - b; break;
      default: { i32 a = br + (r >> 2), b2 = bg + (g >> 2), c2 = bb + (b >> 2); r = a > 31 ? 31 : a; g = b2 > 31 ? 31 : b2; b = c2 > 31 ? 31 : c2; }
    }
  }
  VRAM[idx] = (u16)(r | (g << 5) | (b << 10) | (S_SETM ? 0x8000 : 0));
}
static inline void plot(i32 x, i32 y, i32 r, i32 g, i32 b, int semi, int dith) {
  if (x < S_DAX1 || x > S_DAX2 || y < S_DAY1 || y > S_DAY2 || x < 0 || x > 1023 || y < 0 || y > 511) return;
  plotNB(x, y, r, g, b, semi, dith);
}

// P[80..]: x0,y0,w,h,r,g,b,u0,v0,flags(b0 tex,b1 semi,b2 raw),clutX,clutY
__attribute__((export_name("rect"))) void rect(void) {
  const i32 x0 = P[80], y0 = P[81], w = P[82], h = P[83], r = P[84], g = P[85], bl = P[86], u0 = P[87], v0 = P[88], f = P[89];
  const int tex = f & 1, semi = (f >> 1) & 1, raw = (f >> 2) & 1;
  if (tex) clutPrep(P[90], P[91]);
  const i32 mk = S_ROWMASK, flipX = S_FLIPX, flipY = S_FLIPY;
  const i32 mx = S_MX, my = S_MY, ox = S_OX, oy = S_OY, td = S_TD, base = S_TEXX * 64;
  for (i32 y = 0; y < h; y++) for (i32 x = 0; x < w; x++) {
    const i32 px = x0 + x, py = y0 + y;
    if (mk >= 0 && (py & 1) == mk) continue;
    if (px < S_DAX1 || px > S_DAX2 || py < S_DAY1 || py > S_DAY2) continue;
    if (tex) {
      i32 u = flipX ? u0 + 1 - x : u0 + x, v = flipY ? v0 - y : v0 + y;
      u &= 255; v &= 255;
      u = (u & ~(mx << 3)) | ((ox & mx) << 3); v = (v & ~(my << 3)) | ((oy & my) << 3);
      const i32 row = ((S_TEXY * 256 + v) & 0x1FF) * 1024;
      u32 texel;
      if (td == 0) texel = CLUT[(VRAM[row + ((base + (u >> 2)) & 0x3FF)] >> ((u & 3) * 4)) & 15];
      else if (td == 1) texel = CLUT[(VRAM[row + ((base + (u >> 1)) & 0x3FF)] >> ((u & 1) * 8)) & 255];
      else texel = VRAM[row + ((base + u) & 0x3FF)];
      if (texel == 0) continue;
      i32 tr = texel & 31, tg = (texel >> 5) & 31, tb = (texel >> 10) & 31; const int s = semi && (texel & 0x8000);
      if (raw) plot(px, py, tr << 3, tg << 3, tb << 3, s, 0); else plot(px, py, (tr * r) >> 4, (tg * g) >> 4, (tb * bl) >> 4, s, 0);
    } else plot(px, py, r, g, bl, semi, 0);
  }
}

#define LINE_EX (1.0 / 4194304.0)
// P[96..]: x0,y0,x1,y1,c0,c1,flags(b0 semi, b1 gour)
__attribute__((export_name("line"))) void line(void) {
  const i32 x0 = P[96], y0 = P[97], x1 = P[98], y1 = P[99]; const u32 c0 = (u32)P[100], c1 = (u32)P[101]; const int semi = P[102] & 1, gour = (P[102] >> 1) & 1;
  i32 ax = x0, ay = y0, bx = x1, by = y1; u32 ca = c0, cb = c1;
  const i32 adx = x1 > x0 ? x1 - x0 : x0 - x1, ady = y1 > y0 ? y1 - y0 : y0 - y1, k = adx > ady ? adx : ady;
  if (adx >= 1024 || ady >= 512) return;
  if (ax >= bx && k) { ax = x1; ay = y1; bx = x0; by = y0; ca = c1; cb = c0; }
  double sx, sy;
  if (k == 0) { sx = 0; sy = 0; }
  else {
    double n = (double)(bx - ax) * 4294967296.0, q = n / k; double qi = q < 0 ? __builtin_floor(q) : __builtin_ceil(q); sx = qi / 4294967296.0;
    n = (double)(by - ay) * 4294967296.0; q = n / k; qi = q < 0 ? __builtin_floor(q) : __builtin_ceil(q); sy = qi / 4294967296.0;
  }
  double px = ax + 0.5 - LINE_EX, py = ay + 0.5 - 0.0;
  const int dither = S_DITHER != 0;
  const i32 r0 = ca & 255, g0 = (ca >> 8) & 255, b0 = (ca >> 16) & 255;
  const i32 tr = (i32)(cb & 255) - r0, tg = (i32)((cb >> 8) & 255) - g0, tb = (i32)((cb >> 16) & 255) - b0;
  const i32 kk = k ? k : 1, mk = S_ROWMASK;
  const i32 dr = (tr * 4096) / kk, dg = (tg * 4096) / kk, db = (tb * 4096) / kk;
  for (i32 i = 0; i <= k; i++, px += sx, py += sy) {
    const i32 x = (i32)__builtin_floor(px), y = (i32)__builtin_floor(py);
    if (mk >= 0 && (y & 1) == mk) continue;
    i32 r = r0, g = g0, bl = b0;
    if (gour) { r = (i32)(((u32)r0 << 12) + 2048 + (u32)(dr * i)) >> 12; g = (i32)(((u32)g0 << 12) + 2048 + (u32)(dg * i)) >> 12; bl = (i32)(((u32)b0 << 12) + 2048 + (u32)(db * i)) >> 12; }
    plot(x, y, r, g, bl, semi, dither);
  }
}

// P[112..]: x0,y0,w,h,col15
__attribute__((export_name("fill"))) void fill(void) {
  const i32 x0 = P[112], y0 = P[113], w = P[114], h = P[115]; const u16 col = (u16)P[116]; const i32 mk = S_ROWMASK;
  for (i32 y = 0; y < h; y++) {
    if (mk >= 0 && ((y0 + y) & 1) == mk) continue;
    u16 *row = VRAM + ((y0 + y) & 0x1FF) * 1024;
    for (i32 x = 0; x < w; x++) row[(x0 + x) & 0x3FF] = col;
  }
}

// P[120..]: sx,sy,dx,dy,w,h
__attribute__((export_name("copy"))) void copy(void) {
  const i32 sx = P[120], sy = P[121], dx = P[122], dy = P[123], w = P[124], h = P[125]; u16 buf[16];
  const u32 setm = S_SETM ? 0x8000 : 0;
  for (i32 y = 0; y < h; y++) for (i32 x0 = 0; x0 < w; x0 += 16) {
    const i32 n = w - x0 < 16 ? w - x0 : 16;
    for (i32 k = 0; k < n; k++) buf[k] = VRAM[((sy + y) & 0x1FF) * 1024 + ((sx + x0 + k) & 0x3FF)];
    for (i32 k = 0; k < n; k++) {
      const i32 di = ((dy + y) & 0x1FF) * 1024 + ((dx + x0 + k) & 0x3FF);
      if (S_CHK && (VRAM[di] & 0x8000)) continue;
      VRAM[di] = (u16)(buf[k] | setm);
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Saída de vídeo (480i): guarda o campo exibido + mapa de movimento, e converte a área de display para RGBA (com desentrelaçamento)
// P[128..]: startX,startY,w,h,wv,par,full  (capture)
__attribute__((export_name("capture"))) void capture(void) {
  const i32 sX = P[128], sY = P[129], h = P[131], wv = P[132], par = P[133], full = P[134];
  for (i32 y = 0; y < h; y++) {
    const i32 ry = (sY + y) & 0x1FF;
    if (!full && (ry & 1) != par) continue;
    const i32 row = ry * 1024;
    for (i32 x = 0; x < wv; x++) {
      const i32 i = row + ((sX + x) & 0x3FF); const i32 n = VRAM[i], o = SNAP[i];
      // movimento = pixel mudou (>= 2 níveis de 5 bits) em relação ao MESMO campo de 2 quadros atrás
      i32 d0 = (n & 31) - (o & 31), d1 = ((n >> 5) & 31) - ((o >> 5) & 31), d2 = ((n >> 10) & 31) - ((o >> 10) & 31);
      MOT[i] = (full || d0 > 1 || d0 < -1 || d1 > 1 || d1 < -1 || d2 > 1 || d2 < -1) ? 1 : 0;
      SNAP[i] = (u16)n;
    }
  }
}
// P[136..]: startX,startY,w,h,rgb24,useSnap,dmode,spar
__attribute__((export_name("render"))) void render(void) {
  const i32 sX = P[136], sY = P[137], w = P[138], h = P[139], rgb24 = P[140], useSnap = P[141], spar = P[143];
  const u16 *vram = useSnap ? SNAP : VRAM; const i32 dmode = (useSnap && !rgb24) ? P[142] : 0;
  u8 *out = OUT;
  for (i32 y = 0; y < h; y++) {
    const i32 ry = (sY + y) & 0x1FF, row = ry * 1024;
    const int di = dmode != 0 && (ry & 1) != spar;
    const i32 rA = (di && y > 0) ? ((ry - 1) & 0x1FF) * 1024 : -1, rB = (di && y < h - 1) ? ((ry + 1) & 0x1FF) * 1024 : -1;
    for (i32 x = 0; x < w; x++) {
      i32 r, g, b;
      if (rgb24) {
        const i32 bx = sX * 2 + x * 3;
        const i32 wi = row + ((bx >> 1) & 0x3FF); const i32 lo = vram[wi], hi = vram[(wi & ~1023) + (((bx >> 1) + 1) & 0x3FF)];
        if (bx & 1) { r = lo >> 8; g = hi & 255; b = hi >> 8; } else { r = lo & 255; g = lo >> 8; b = hi & 255; }
      } else {
        const i32 p = vram[row + ((sX + x) & 0x3FF)];
        r = (p & 31) << 3; g = ((p >> 5) & 31) << 3; b = ((p >> 10) & 31) << 3;
        r |= r >> 5; g |= g >> 5; b |= b >> 5;
        if (di && (rA >= 0 || rB >= 0)) {
          const i32 xi = (sX + x) & 0x3FF, ia = (rA >= 0 ? rA : rB) + xi, ib = (rB >= 0 ? rB : rA) + xi;
          if (!(dmode == 1 && !(MOT[ia] | MOT[ib]))) {
            const i32 pa = vram[ia], pb = vram[ib];
            i32 ar = (((pa & 31) + (pb & 31)) << 2), ag = ((((pa >> 5) & 31) + ((pb >> 5) & 31)) << 2), ab = ((((pa >> 10) & 31) + ((pb >> 10) & 31)) << 2);
            ar |= ar >> 5; ag |= ag >> 5; ab |= ab >> 5;
            r = ar; g = ag; b = ab;
          }
        }
      }
      const i32 o = (y * w + x) * 4; out[o] = (u8)r; out[o + 1] = (u8)g; out[o + 2] = (u8)b; out[o + 3] = 255;
    }
  }
}
