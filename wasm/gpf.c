// Front-end do GP0 para o modo "GPU em Worker" (gpu.remote): percorre a lista encadeada do DMA 2 direto na RAM, empurra as palavras
// para a fila do GpuStream (pares [0, palavra]) e calcula o tempo de ocupação da GPU (chargeBusy do gpu.js, mesma aritmética em double).
// Só cobre o caminho comum: preenchimento (02), polígonos (20-3F), retângulos (60-7F) e cópia VRAM->VRAM (80-9F). Qualquer outro comando
// (E1-E6, A0/C0, linhas, IRQ...) devolve o controle ao JS na PRIMEIRA palavra do pacote, que o trata como sempre.
static inline u32 rdw(u32 a) { return *(u32 *)(RAM + (a & 0x1FFFFCu)); }
static inline i32 sx(u32 v, int sh) { return ((i32)(v << sh)) >> 21; }
static void charge(u32 c, const u32 *b, u32 len) {
  double cyc = 0; const int semi = (c & 2) != 0, tex = (c & 4) != 0;
  if (c == 0x02) cyc = (double)((((b[2] & 0x3FFu) + 15u) & ~15u) * ((b[2] >> 16) & 0x1FFu)) * 0.085 + 30.0;
  else if (c >= 0x20 && c <= 0x3F) {
    const int n = (c & 8) ? 4 : 3, gour = (c & 0x10) != 0, tx = tex; u32 p = 1; i32 x0 = 1000000000, y0 = 1000000000, x1 = -1000000000, y1 = -1000000000;
    for (int i = 0; i < n; i++) {
      if (i > 0 && gour) p++;
      const u32 v = b[p++]; const i32 x = sx(v, 21) + GFP[0], y = ((i32)(v << 5) >> 21) + GFP[1]; if (tx) p++;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    if (x0 < GFP[2]) x0 = GFP[2]; if (y0 < GFP[3]) y0 = GFP[3]; if (x1 > GFP[4]) x1 = GFP[4]; if (y1 > GFP[5]) y1 = GFP[5];
    i32 dx = x1 - x0, dy = y1 - y0; if (dx < 0) dx = 0; if (dy < 0) dy = 0;
    cyc = (double)(dx * dy) * (n == 4 ? 0.54 : 0.27) * (semi ? 1.5 : 1.0) * (tex ? 5.2 : 1.0) + 60.0;
  } else if (c >= 0x60 && c <= 0x7F) {
    const u32 sz = (c >> 3) & 3, l = b[len - 1]; const u32 w = sz == 0 ? (l & 0x3FFu) : sz == 1 ? 1 : sz == 2 ? 8 : 16, h = sz == 0 ? ((l >> 16) & 0x1FFu) : sz == 1 ? 1 : sz == 2 ? 8 : 16;
    cyc = (double)(w * h) * (tex ? 1.06 : semi ? 0.8 : 0.53) + 30.0;
  } else if (c >= 0x80 && c <= 0x9F) cyc = (double)((((b[3] - 1) & 0x3FFu) + 1) * ((((b[3] >> 16) - 1) & 0x1FFu) + 1)) * 1.33 + 40.0;
  if (cyc > 0 && GFP[6] >= 0 && !(c >= 0x80 && c <= 0x9F)) cyc *= 0.5;
  if (cyc > 0) { const double now = GFD[0], bu = GFD[1]; GFD[1] = (now > bu ? now : bu) + cyc; }
}
// 0 = lista terminou (GFP[8] = último nó), 1 = JS precisa tratar o pacote em (nó GFP[8], palavra GFP[9]), 2 = fila cheia (esvazie e chame de novo)
XP(gpf_list) int gpf_list(void) {
  u32 a = (u32)GFP[8], k = (u32)GFP[9], n = 0, qn = (u32)GFP[7];
  int st = 0; u32 i_ = 0;
  for (u32 g = 0; g < 0x100000; g++) {
    const u32 hdr = rdw(a), cnt = hdr >> 24; u32 i = k; k = 0;
    while (i < cnt) {
      i_ = i;
      u32 b[16]; b[0] = rdw(a + 4 + 4 * i); const u32 c = b[0] >> 24; u32 need;
      if (c == 0x02) need = 3;
      else if (c >= 0x20 && c <= 0x3F) { const u32 v = (c & 8) ? 4 : 3; need = 1 + v + ((c & 4) ? v : 0) + ((c & 0x10) ? v - 1 : 0); }
      else if (c >= 0x60 && c <= 0x7F) need = 2 + ((c & 4) ? 1 : 0) + (((c >> 3) & 3) == 0 ? 1 : 0);
      else if (c >= 0x80 && c <= 0x9F) need = 4;
      else { st = 1; goto out; }
      if (i + need > cnt) { st = 1; goto out; }
      if (qn + 2 * need > GQN) { st = 2; goto out; }
      for (u32 j = 1; j < need; j++) b[j] = rdw(a + 4 + 4 * (i + j));
      for (u32 j = 0; j < need; j++) { GQ[qn++] = 0; GQ[qn++] = b[j]; }
      charge(c, b, need);
      if (c >= 0x24 && c <= 0x3F && (c & 4)) {          // polígono texturizado: o texpage está na 2ª textura (estado do GPU)
        u32 p = 1; for (int v = 0; v < 2; v++) { if (v > 0 && (c & 0x10)) p++; p++; if (v == 1) { GFP[11] = (i32)(b[p] >> 16); GFP[12] = 1; } p++; }
      }
      i += need;
    }
    n += cnt + 1;
    if (hdr & 0x800000u) { st = 0; goto fin; }
    a = hdr & 0x1FFFFCu;
  }
fin:
  GFP[8] = (i32)a; GFP[9] = 0; GFP[10] = (i32)n; GFP[7] = (i32)qn; return st;
out:
  GFP[8] = (i32)a; GFP[9] = (i32)i_; GFP[10] = (i32)n; GFP[7] = (i32)qn; return st;
}

// cópia em bloco de palavras da RAM (passo +4) para a fila, como pares [0, palavra] (upload de imagem em andamento). Devolve quantas copiou.
XP(gpf_copy) u32 gpf_copy(u32 a, u32 words) {
  u32 qn = (u32)GFP[7], room = (GQN - qn) >> 1, k = words < room ? words : room;
  for (u32 i = 0; i < k; i++) { GQ[qn++] = 0; GQ[qn++] = rdw(a + 4 * i); }
  GFP[7] = (i32)qn; return k;
}
