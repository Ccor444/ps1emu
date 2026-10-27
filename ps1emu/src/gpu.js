// ============================================================================
//  GPU do PS1 - rasterizador por software
// ============================================================================
//  Portas:  0x1F801810 GP0 (desenho/VRAM) / GPUREAD      0x1F801814 GP1 (controle) / GPUSTAT
//  VRAM:    1024x512 pixels de 16 bits (RGB555 + bit de máscara)
//
//  Implementado: fill, polígonos (flat/gouraud/texturizados 4/8/15 bits, semi-transparência
//  4 modos, dither, máscara), retângulos, linhas/polilinhas, cópias de VRAM (CPU<->VRAM,
//  VRAM->VRAM), janela de textura, area/offset de desenho, saída 15/24 bits.
//  Simplificações: sem timing real de GPU, interpolação em ponto flutuante (não bit-exata).
// ============================================================================

import { enableWasmRaster } from './wasmgpu.js';

const PH_CMD = 0, PH_VRAM_WRITE = 1, PH_POLYLINE = 2;
const LINE_EX = 1 / 4194304, LINE_EY = 0;                  // viés de arredondamento de x (medido no console real)
const DITHER = [-4, 0, -3, 1, 2, -2, 3, -1, -3, 1, -4, 0, 3, -1, 2, -2];
const sx11 = v => (v << 21) >> 21;                       // sinal 11 bits


// ---- scanline especializada (gerada por combinação de modos): mesma aritmética do plotNB/texel, sem ramos por pixel ----
const QT = new Uint8Array(1024); for (let i = 0; i < 1024; i++) { const v = i - 8; QT[i] = (v < 0 ? 0 : v > 255 ? 255 : v) >> 3; }   // clamp8(v) >> 3, índice v+8
const DITHER_T = new Int8Array(DITHER);
const SPANS = new Map();
function spanFor(tex, td, gour, raw, semi, dd, chk, win) {
  const key = (tex ? td : 'n') + (gour ? 'G' : 'f') + (raw ? 'R' : 'm') + (semi ? 'S' : 'o') + (dd ? 'D' : 'n') + (chk ? 'C' : '-') + (win ? 'W' : '-');
  let f = SPANS.get(key); if (f) return f;
  let c = 'const rowI = y * 1024, dRow = (y & 3) << 2;\nfor (let x = xl; x < xr; x++) {\n';
  c += gour ? 'let r = ((cr | 0) >> 12) & 255, g = ((cg | 0) >> 12) & 255, bl = ((cb | 0) >> 12) & 255; cr += rGx; cg += gGx; cb += bGx;\n' : 'let r = fr, g = fg, bl = fb;\n';
  if (tex) {
    c += win ? 'const u = (((cu | 0) >> 12) & 255 & uAnd) | uOr, v = (((cv | 0) >> 12) & 255 & vAnd) | vOr;\n' : 'const u = ((cu | 0) >> 12) & 255, v = ((cv | 0) >> 12) & 255;\n';
    c += 'cu += uGx; cv += vGx;\nconst row = ((tY + v) & 0x1FF) << 10;\n';
    if (td === 0) c += 'const texel = clut[(vram[row + ((tBase + (u >> 2)) & 0x3FF)] >> ((u & 3) << 2)) & 15];\n';
    else if (td === 1) c += 'const texel = clut[(vram[row + ((tBase + (u >> 1)) & 0x3FF)] >> ((u & 1) << 3)) & 255];\n';
    else c += 'const texel = vram[row + ((tBase + u) & 0x3FF)];\n';
    c += 'if (texel === 0) continue;\n';
    if (semi) c += 'const sm = (texel & 0x8000) !== 0;\n';
    c += 'const tr = texel & 31, tg = (texel >> 5) & 31, tb = (texel >> 10) & 31;\n';
    c += raw ? 'r = tr << 3; g = tg << 3; bl = tb << 3;\n' : 'r = (tr * r) >> 4; g = (tg * g) >> 4; bl = (tb * bl) >> 4;\n';
  }
  c += 'const idx = rowI + x;\n';
  if (chk || semi) c += 'const back = vram[idx];\n';
  if (chk) c += 'if (back & 0x8000) continue;\n';
  if (dd) c += 'const d = DITHER[dRow | (x & 3)]; r += d; g += d; bl += d;\n';
  c += 'r = QT[r + 8]; g = QT[g + 8]; bl = QT[bl + 8];\n';
  if (semi) {
    const blend = 'const br = back & 31, bg = (back >> 5) & 31, bb = (back >> 10) & 31;\n' +
      'switch (smode) {\ncase 0: r = (br + r) >> 1; g = (bg + g) >> 1; bl = (bb + bl) >> 1; break;\n' +
      'case 1: r = br + r > 31 ? 31 : br + r; g = bg + g > 31 ? 31 : bg + g; bl = bb + bl > 31 ? 31 : bb + bl; break;\n' +
      'case 2: r = br - r < 0 ? 0 : br - r; g = bg - g < 0 ? 0 : bg - g; bl = bb - bl < 0 ? 0 : bb - bl; break;\n' +
      'default: r = Math.min(31, br + (r >> 2)); g = Math.min(31, bg + (g >> 2)); bl = Math.min(31, bb + (bl >> 2));\n}\n';
    c += tex ? 'if (sm) {\n' + blend + '}\n' : '{\n' + blend + '}\n';
  }
  c += 'vram[idx] = r | (g << 5) | (bl << 10) | setM;\n}';
  f = new Function('vram', 'clut', 'QT', 'DITHER', 'y', 'xl', 'xr', 'cr', 'cg', 'cb', 'cu', 'cv', 'rGx', 'gGx', 'bGx', 'uGx', 'vGx', 'fr', 'fg', 'fb', 'tBase', 'tY', 'uAnd', 'uOr', 'vAnd', 'vOr', 'smode', 'setM', c);
  SPANS.set(key, f); return f;
}

export class GPU {
  constructor() {
    this.vram = new Uint16Array(1024 * 512);
    this.pal = false;
    this.onIrq = null;
    this.hw = null;                                          // renderizador WebGL (glgpu.js); null = software
    this.remote = null;                                      // GpuStream: o desenho acontece num worker (esta instância só analisa os comandos e mantém o estado/temporização)
    this.line = 0; this.vblank = false; this.field = 0;      // temporização (atualizada pelo PSX)
    this.reset();
  }

  reset() {
    if (this.sh) this.sh[21] = 0;
    this.phase = PH_CMD; this.buf = []; this.need = 1;
    // ---- estado de desenho (GP0 E1..E6) ----
    this.texX = 0; this.texY = 0; this.semiMode = 0; this.texDepth = 0; this.dither = false;
    this.drawToDisplay = false; this.texDisable = false; this.texDisAllow = false; this.busyUntil = 0; this.skipDraw = false; this.flipX = false; this.flipY = false;
    this.twMaskX = 0; this.twMaskY = 0; this.twOffX = 0; this.twOffY = 0;
    this.daX1 = 0; this.daY1 = 0; this.daX2 = 0; this.daY2 = 0;
    this.offX = 0; this.offY = 0;
    this.setMask = false; this.checkMask = false;
    this.clutValid = false; this.clutX = 0; this.clutY = 0; this.clutCount = 0; this.clut ??= new Uint16Array(256);   // cache de CLUT
    // ---- display (GP1) ----
    this.dispOn = false; this.dmaDir = 0; this.startX = 0; this.startY = 0;
    this.hx1 = 0x200; this.hx2 = 0xC00; this.vy1 = 0x10; this.vy2 = 0x100;
    this.hres1 = 0; this.hres2 = 0; this.vres = 0; this.rgb24 = false; this.interlace = false; this.reverse = false; this.deint = 1; this.snapPar = 0;
    this.irq1 = false;
    this.gpuRead = 0; this.infoSel = 0;
    // ---- transferências ----
    this.vw = null; this.vr = null;
    this.toggle = 0; this.line = 0; this.vblank = false; this.field = 0;
    this.frameCount = 0; this.snap = null; this.snapKey = '';
  }

  // ===================== Registradores =====================
  touch() { if (this.sh) this.sh[21] = 0; }                                       // o wasm serve o GPUSTAT a partir de uma cópia publicada: qualquer mudança de estado a invalida
  readStatus() {
    let s = (this.texX & 15) | ((this.texY & 1) << 4) | (this.semiMode << 5) | (this.texDepth << 7) |
            ((this.dither ? 1 : 0) << 9) | ((this.drawToDisplay ? 1 : 0) << 10) | ((this.setMask ? 1 : 0) << 11) |
            ((this.checkMask ? 1 : 0) << 12) | (1 << 13) | ((this.reverse ? 1 : 0) << 14) | ((this.texDisable ? 1 : 0) << 15) |
            (this.hres2 << 16) | (this.hres1 << 17) | (this.vres << 19) | ((this.pal ? 1 : 0) << 20) |
            ((this.rgb24 ? 1 : 0) << 21) | ((this.interlace ? 1 : 0) << 22) | ((this.dispOn ? 0 : 1) << 23) |
            ((this.irq1 ? 1 : 0) << 24);
    const s0 = s, busy = !!this.clock && this.clock() < this.busyUntil;          // GPU ainda desenhando o último comando
    const readyCmd = this.phase === PH_CMD && !this.vr && !busy;
    s |= (readyCmd ? 1 << 26 : 0) | (this.vr ? 1 << 27 : 0) | ((this.dmaDir === 0 || !busy ? 1 : 0) << 28) | (this.dmaDir << 29);
    // bit 25 = DMA data request, depende da direção
    const req = this.dmaDir === 0 ? 0 : this.dmaDir === 1 ? 1 : this.dmaDir === 2 ? (readyCmd ? 1 : 0) : (this.vr ? 1 : 0);
    s |= req << 25;
    // bit 31: campo par/ímpar - alterna (aproximação até existir timing de scanline)
    const odd = (this.interlace && this.vres) ? this.field : (this.vblank ? 0 : (this.line & 1));
    s |= (odd << 31);
    const sh = this.sh; if (sh) { sh[16] = s0; sh[17] = this.dmaDir; sh[18] = this.vr ? 1 : 0; sh[19] = this.phase === PH_CMD ? 1 : 0; sh[20] = odd; sh[21] = 1; }
    return s >>> 0;
  }

  readData() {                                    // GPUREAD
    this.touch();
    if (this.vr) return this.vramReadWord();
    return this.gpuRead >>> 0;
  }

  // ===================== GP1 =====================
  writeGP1(w) {
    this.touch();
    if (this.remote) this.remote.push(1, w >>> 0);
    const cmd = w >>> 24, p = w & 0xFFFFFF;
    switch (cmd) {
      case 0x00: this.reset(); break;
      case 0x01: this.phase = PH_CMD; this.buf = []; this.vw = null; this.vr = null; break;
      case 0x02: this.irq1 = false; break;
      case 0x03: this.dispOn = !(p & 1); break;
      case 0x04: this.dmaDir = p & 3; break;
      case 0x05: this.startX = p & 0x3FE; this.startY = (p >> 10) & 0x1FF; break;
      case 0x06: this.hx1 = p & 0xFFF; this.hx2 = (p >> 12) & 0xFFF; break;
      case 0x07: this.vy1 = p & 0x3FF; this.vy2 = (p >> 10) & 0x3FF; break;
      case 0x08:
        this.hres1 = p & 3; this.vres = (p >> 2) & 1; this.pal = !!((p >> 3) & 1);
        this.rgb24 = !!((p >> 4) & 1); this.interlace = !!((p >> 5) & 1); this.hres2 = (p >> 6) & 1; this.reverse = !!((p >> 7) & 1);
        break;
      case 0x09: this.texDisAllow = !!(p & 1); break;   // permite o bit "texture disable" (E1.11)
      default:
        if (cmd >= 0x10 && cmd <= 0x1F) {           // GET GPU INFO
          switch (p & 7) {
            case 2: this.gpuRead = this.twMaskX | (this.twMaskY << 5) | (this.twOffX << 10) | (this.twOffY << 15); break;
            case 3: this.gpuRead = this.daX1 | (this.daY1 << 10); break;
            case 4: this.gpuRead = this.daX2 | (this.daY2 << 10); break;
            case 5: this.gpuRead = (this.offX & 0x7FF) | ((this.offY & 0x7FF) << 11); break;
            case 7: this.gpuRead = 2; break;        // tipo de GPU
            default: break;
          }
        }
    }
  }

  // ===================== GP0 =====================
  writeGP0(w) {
    w >>>= 0; if (this.sh) this.sh[21] = 0;
    const R = this.remote; if (R) { if (R.n >= R.q.length) R.flush(); R.q[R.n++] = 0; R.q[R.n++] = w; }
    if (this.phase === PH_VRAM_WRITE) { this.vramWriteWord(w); return; }
    if (this.phase === PH_POLYLINE) { this.polylineWord(w); return; }
    if (this.buf.length === 0) this.need = this.wordsFor(w >>> 24);
    this.buf.push(w);
    if (this.buf.length >= this.need) {
      const b = this.buf; this.buf = [];
      this.exec(b);
    }
  }
  /** Para DMA (canal 2): bloco de palavras em RAM */
  dmaWrite(words) { for (let i = 0; i < words.length; i++) this.writeGP0(words[i]); }
  dmaRead(n) { const o = new Uint32Array(n); for (let i = 0; i < n; i++) o[i] = this.readData(); return o; }

  wordsFor(c) {
    if (c === 0x02) return 3;
    if (c >= 0x20 && c <= 0x3F) { const v = (c & 8) ? 4 : 3; return 1 + v + ((c & 4) ? v : 0) + ((c & 0x10) ? v - 1 : 0); }
    if (c >= 0x40 && c <= 0x5F) return (c & 0x10) ? 4 : 3;           // polilinha trata o resto
    if (c >= 0x60 && c <= 0x7F) return 2 + ((c & 4) ? 1 : 0) + (((c >> 3) & 3) === 0 ? 1 : 0);
    if (c >= 0x80 && c <= 0x9F) return 4;
    if (c >= 0xA0 && c <= 0xDF) return 3;
    return 1;
  }

  exec(b) {
    const c = b[0] >>> 24;
    if (this.clock) this.chargeBusy(c, b);
    if (c === 0x02) return this.fillRect(b);
    if (c >= 0x20 && c <= 0x3F) return this.polygon(b, c);
    if (c >= 0x40 && c <= 0x5F) return this.lineCmd(b, c);
    if (c >= 0x60 && c <= 0x7F) return this.rect(b, c);
    if (c >= 0x80 && c <= 0x9F) return this.vramCopy(b);
    if (c >= 0xA0 && c <= 0xBF) return this.beginVramWrite(b);
    if (c >= 0xC0 && c <= 0xDF) return this.beginVramRead(b);
    switch (c) {
      case 0x01: this.clutValid = false; break;                  // limpa o cache de CLUT
      case 0x1F: this.irq1 = true; this.onIrq?.(); break;
      case 0xE1: {
        this.texX = b[0] & 15; this.texY = (b[0] >> 4) & 1; this.semiMode = (b[0] >> 5) & 3; this.texDepth = (b[0] >> 7) & 3;      // 3 é reservado: lido de volta como 3, tratado como 15 bits
        this.dither = !!((b[0] >> 9) & 1); this.drawToDisplay = !!((b[0] >> 10) & 1); this.texDisable = this.texDisAllow && !!((b[0] >> 11) & 1);
        this.flipX = !!((b[0] >> 12) & 1); this.flipY = !!((b[0] >> 13) & 1); break;
      }
      case 0xE2: this.twMaskX = b[0] & 31; this.twMaskY = (b[0] >> 5) & 31; this.twOffX = (b[0] >> 10) & 31; this.twOffY = (b[0] >> 15) & 31; break;
      case 0xE3: this.daX1 = b[0] & 0x3FF; this.daY1 = (b[0] >> 10) & 0x3FF; break;
      case 0xE4: this.daX2 = b[0] & 0x3FF; this.daY2 = (b[0] >> 10) & 0x3FF; break;
      case 0xE5: this.offX = sx11(b[0] & 0x7FF); this.offY = sx11((b[0] >> 11) & 0x7FF); break;
      case 0xE6: this.setMask = !!(b[0] & 1); this.checkMask = !!(b[0] & 2); break;
      default: break;                                // NOP / clear cache / etc.
    }
  }

  // ===================== Tempo de desenho (GPUSTAT: pronto p/ comando / DMA) =====================
  /** estima quantos ciclos de CPU o comando mantém a GPU ocupada e soma em busyUntil */
  chargeBusy(c, b) {
    let cyc = 0;
    const semi = !!(c & 2), tex = !!(c & 4);
    // fatores calibrados com ps1-tests/gpu/bandwidth (PS1 real): ciclos de CPU por pixel
    if (c === 0x02) cyc = (((b[2] & 0x3FF) + 15) & ~15) * ((b[2] >>> 16) & 0x1FF) * 0.085 + 30;
    else if (c >= 0x20 && c <= 0x3F) {
      const n = (c & 8) ? 4 : 3, gour = !!(c & 0x10), tx = !!(c & 4);
      let p = 1, x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
      for (let i = 0; i < n; i++) {
        if (i > 0 && gour) p++;
        const v = b[p++], x = ((v << 21) >> 21) + this.offX, y = ((v << 5) >> 21) + this.offY; if (tx) p++;
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
      x0 = Math.max(x0, this.daX1); y0 = Math.max(y0, this.daY1); x1 = Math.min(x1, this.daX2); y1 = Math.min(y1, this.daY2);   // só conta a parte visível
      const area = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
      cyc = area * (n === 4 ? 0.54 : 0.27) * (semi ? 1.5 : 1) * (tx ? 5.2 : 1) + 60;
    } else if (c >= 0x40 && c <= 0x5F) {
      const a = b[1], d = b[(c & 0x10) ? 3 : 2], dx = Math.abs(((a << 21) >> 21) - ((d << 21) >> 21)), dy = Math.abs(((a << 5) >> 21) - ((d << 5) >> 21));
      cyc = Math.max(dx, dy) * 1.2 + 40;
    } else if (c >= 0x60 && c <= 0x7F) {
      const sz = (c >> 3) & 3, w = sz === 0 ? b[b.length - 1] & 0x3FF : sz === 1 ? 1 : sz === 2 ? 8 : 16, h = sz === 0 ? (b[b.length - 1] >>> 16) & 0x1FF : sz === 1 ? 1 : sz === 2 ? 8 : 16;
      cyc = w * h * (tex ? 1.06 : semi ? 0.8 : 0.53) + 30;
    } else if (c >= 0x80 && c <= 0x9F) cyc = (((b[3] - 1) & 0x3FF) + 1) * ((((b[3] >>> 16) - 1) & 0x1FF) + 1) * 1.33 + 40;
    if (cyc > 0 && this.rowMask >= 0 && c !== 0x80 && !(c >= 0x80 && c <= 0x9F)) cyc *= 0.5;   // 480i: só metade das linhas é desenhada
    if (cyc > 0) { const now = this.clock(); this.busyUntil = Math.max(now, this.busyUntil) + cyc; }
  }

  // ===================== Transferências VRAM =====================
  fillRect(b) {
    const col = rgb24to15(b[0]);
    const x0 = b[1] & 0x3F0, y0 = (b[1] >>> 16) & 0x1FF;
    const w = ((b[2] & 0x3FF) + 0xF) & ~0xF, h = (b[2] >>> 16) & 0x1FF;
    if (this.remote) return;
    if (this.hw) return this.hw.fill(x0, y0, w, h, b[0]);
    if (this.wr) { const wr = this.wr, P = wr.P; wr.sync(this); P[112] = x0; P[113] = y0; P[114] = w; P[115] = h; P[116] = col; return wr.x.fill(); }
    const mk = this.rowMask;
    for (let y = 0; y < h; y++) {
      if (mk >= 0 && ((y0 + y) & 1) === mk) continue;
      const row = ((y0 + y) & 0x1FF) * 1024;
      for (let x = 0; x < w; x++) this.vram[row + ((x0 + x) & 0x3FF)] = col;
    }
  }

  beginVramWrite(b) {
    const x = b[1] & 0x3FF, y = (b[1] >>> 16) & 0x1FF;
    const w = ((b[2] - 1) & 0x3FF) + 1, h = (((b[2] >>> 16) - 1) & 0x1FF) + 1;
    if (this.hw && this.checkMask) this.hw.rects(x, y, w, h, (rx, ry, rw, rh) => this.hw.syncNative(rx, ry, rw, rh));
    this.vw = { x, y, w, h, i: 0, total: w * h };
    this.phase = PH_VRAM_WRITE;
  }
  vramWriteWord(word) {
    const t = this.vw;
    if (this.remote) { t.i += 2; if (t.i >= t.total) { this.phase = PH_CMD; this.vw = null; } return; }
    for (let k = 0; k < 2 && t.i < t.total; k++, t.i++) {
      const px = (word >>> (16 * k)) & 0xFFFF;
      const xx = (t.x + (t.i % t.w)) & 0x3FF, yy = (t.y + ((t.i / t.w) | 0)) & 0x1FF;
      const idx = yy * 1024 + xx;
      if (this.checkMask && (this.vram[idx] & 0x8000)) continue;
      this.vram[idx] = px | (this.setMask ? 0x8000 : 0);
    }
    if (t.i >= t.total) { this.phase = PH_CMD; this.vw = null; if (this.hw) this.hw.uploaded(t.x, t.y, t.w, t.h); }
  }

  beginVramRead(b) {
    const x = b[1] & 0x3FF, y = (b[1] >>> 16) & 0x1FF;
    const w = ((b[2] - 1) & 0x3FF) + 1, h = (((b[2] >>> 16) - 1) & 0x1FF) + 1;
    if (this.remote) this.remote.onRead?.();                   // o jogo lê a VRAM de volta: o worker volta para esta thread (a leitura atual sai defasada)
    if (this.hw) this.hw.rects(x, y, w, h, (rx, ry, rw, rh) => this.hw.syncNative(rx, ry, rw, rh));
    this.vr = { x, y, w, h, i: 0, total: w * h };
  }
  vramReadWord() {
    const t = this.vr; let out = 0;
    for (let k = 0; k < 2; k++) {
      let px = 0;
      if (t.i < t.total) { px = this.vram[((t.y + ((t.i / t.w) | 0)) & 0x1FF) * 1024 + ((t.x + (t.i % t.w)) & 0x3FF)]; t.i++; }
      out |= px << (16 * k);
    }
    if (t.i >= t.total) this.vr = null;
    return out >>> 0;
  }

  vramCopy(b) {
    const sx = b[1] & 0x3FF, sy = (b[1] >>> 16) & 0x1FF, dx = b[2] & 0x3FF, dy = (b[2] >>> 16) & 0x1FF;
    const w = ((b[3] - 1) & 0x3FF) + 1, h = (((b[3] >>> 16) - 1) & 0x1FF) + 1;
    if (this.remote) return;
    if (this.hw && this.hw.copy(sx, sy, dx, dy, w, h)) return;
    if (!this.hw && this.wr) { const wr = this.wr, P = wr.P; wr.sync(this); P[120] = sx; P[121] = sy; P[122] = dx; P[123] = dy; P[124] = w; P[125] = h; return wr.x.copy(); }
    const CH = 16, buf = new Uint16Array(CH);          // o hardware lê/escreve em rajadas de 16 pixels (medido)
    for (let y = 0; y < h; y++) for (let x0 = 0; x0 < w; x0 += CH) {
      const n = Math.min(CH, w - x0);
      for (let k = 0; k < n; k++) buf[k] = this.vram[((sy + y) & 0x1FF) * 1024 + ((sx + x0 + k) & 0x3FF)];
      for (let k = 0; k < n; k++) {
        const di = ((dy + y) & 0x1FF) * 1024 + ((dx + x0 + k) & 0x3FF);
        if (this.checkMask && (this.vram[di] & 0x8000)) continue;
        this.vram[di] = buf[k] | (this.setMask ? 0x8000 : 0);
      }
    }
    if (this.hw) this.hw.uploaded(dx, dy, w, h);
  }

  // ===================== Pixel =====================
  /** Escreve um pixel já com offset aplicado. r,g,b: 0..255. */
  plot(x, y, r, g, b, semi, dith) {
    if (x < this.daX1 || x > this.daX2 || y < this.daY1 || y > this.daY2 || x < 0 || x > 1023 || y < 0 || y > 511) return;
    this.plotNB(x, y, r, g, b, semi, dith);
  }
  /** plot sem checagem de limites (o chamador já recortou para a área de desenho e para a VRAM) */
  plotNB(x, y, r, g, b, semi, dith) {
    const idx = y * 1024 + x, back = this.vram[idx];
    if (this.checkMask && (back & 0x8000)) return;
    if (dith) { const d = DITHER[((y & 3) << 2) | (x & 3)]; r += d; g += d; b += d; }
    r = clamp8(r) >> 3; g = clamp8(g) >> 3; b = clamp8(b) >> 3;
    if (semi) {
      const br = back & 31, bg = (back >> 5) & 31, bb = (back >> 10) & 31;
      switch (this.semiMode) {
        case 0: r = (br + r) >> 1; g = (bg + g) >> 1; b = (bb + b) >> 1; break;
        case 1: r = Math.min(31, br + r); g = Math.min(31, bg + g); b = Math.min(31, bb + b); break;
        case 2: r = Math.max(0, br - r); g = Math.max(0, bg - g); b = Math.max(0, bb - b); break;
        default: r = Math.min(31, br + (r >> 2)); g = Math.min(31, bg + (g >> 2)); b = Math.min(31, bb + (b >> 2));
      }
    }
    this.vram[idx] = r | (g << 5) | (b << 10) | (this.setMask ? 0x8000 : 0);
  }

  /** Cache de CLUT da GPU: carregado só ao desenhar com textura 4/8 bits; chave = posição; 4 bits carrega 16 entradas, 8 bits 256. */
  clutPrep(cx, cy) {
    if (this.texDepth > 1) return;
    const need = this.texDepth === 0 ? 16 : 256;
    if (this.clutValid && this.clutX === cx && this.clutY === cy && this.clutCount >= need) return;
    for (let i = 0; i < need; i++) this.clut[i] = this.vram[cy * 1024 + ((cx * 16 + i) & 0x3FF)];
    this.clutValid = true; this.clutX = cx; this.clutY = cy; this.clutCount = need;
  }

  /** Busca um texel (devolve a palavra de 16 bits; 0 = transparente). */
  texel(u, v, clutX, clutY) {
    u &= 255; v &= 255;
    u = (u & ~(this.twMaskX << 3)) | ((this.twOffX & this.twMaskX) << 3);
    v = (v & ~(this.twMaskY << 3)) | ((this.twOffY & this.twMaskY) << 3);
    const base = this.texX * 64, row = ((this.texY * 256 + v) & 0x1FF) * 1024;
    if (this.texDepth === 0) {
      const w = this.vram[row + ((base + (u >> 2)) & 0x3FF)];
      return this.clut[(w >> ((u & 3) * 4)) & 15];
    }
    if (this.texDepth === 1) {
      const w = this.vram[row + ((base + (u >> 1)) & 0x3FF)];
      return this.clut[(w >> ((u & 1) * 8)) & 255];
    }
    return this.vram[row + ((base + u) & 0x3FF)];
  }

  /** Aplica o texel + cor do vértice e plota. */
  shadeTexel(x, y, t, r, g, b, raw, semi, gour, clutX, clutY, u, v, noClip, dith) {
    const texel = this.texel(u, v, clutX, clutY);
    if (texel === 0) return;
    const tr = texel & 31, tg = (texel >> 5) & 31, tb = (texel >> 10) & 31;
    const s = semi && (texel & 0x8000);
    if (noClip) {
      if (raw) this.plotNB(x, y, tr << 3, tg << 3, tb << 3, s, false);
      else this.plotNB(x, y, (tr * r) >> 4, (tg * g) >> 4, (tb * b) >> 4, s, dith);
    } else if (raw) this.plot(x, y, tr << 3, tg << 3, tb << 3, s, false);
    else this.plot(x, y, (tr * r) >> 4, (tg * g) >> 4, (tb * b) >> 4, s, dith);
  }

  // ===================== Polígonos =====================
  polygon(b, c) {
    const quad = !!(c & 8), tex = !!(c & 4), gour = !!(c & 0x10), semi = !!(c & 2), raw = !!(c & 1);
    const n = quad ? 4 : 3, V = []; let i = 1;
    let clutX = 0, clutY = 0;
    for (let k = 0; k < n; k++) {
      const col = (gour && k > 0) ? b[i++] : b[0];
      const pos = b[i++];
      let u = 0, v = 0;
      if (tex) {
        const t = b[i++]; u = t & 255; v = (t >> 8) & 255;
        if (k === 0) { clutX = (t >>> 16) & 63; clutY = (t >>> 22) & 511; }
        if (k === 1) {                                   // texpage atualiza o estado do GPU
          const tp = t >>> 16;
          this.texX = tp & 15; this.texY = (tp >> 4) & 1; this.semiMode = (tp >> 5) & 3; this.texDepth = (tp >> 7) & 3;
          this.texDisable = this.texDisAllow && !!((tp >> 11) & 1);
        }
      }
      V.push({ x: sx11(pos & 0x7FF) + this.offX, y: sx11((pos >>> 16) & 0x7FF) + this.offY,
               r: col & 255, g: (col >> 8) & 255, b: (col >> 16) & 255, u, v });
    }
    const o = { tex, gour, semi, raw, clutX, clutY };
    if (this.skipDraw || this.remote) return;                   // quadro descartado (frameskip): mantém o estado, não desenha
    if (this.hw) return this.hw.polygon(V, quad, o);
    if (this.wr) {
      const w = this.wr, P = w.P; w.sync(this);
      P[32] = (tex ? 1 : 0) | (gour ? 2 : 0) | (semi ? 4 : 0) | (raw ? 8 : 0) | (quad ? 16 : 0); P[33] = clutX; P[34] = clutY;
      for (let k = 0, j = 36; k < n; k++, j += 7) { const q = V[k]; P[j] = q.x; P[j + 1] = q.y; P[j + 2] = q.r; P[j + 3] = q.g; P[j + 4] = q.b; P[j + 5] = q.u; P[j + 6] = q.v; }
      return w.x.tri();
    }
    if (tex) this.clutPrep(clutX, clutY);
    this.triangle(V[0], V[1], V[2], o);
    if (quad) this.triangle(V[1], V[2], V[3], o);
  }

  /**
   * Triângulo estilo hardware: arestas exatas (regra de cobertura do PS1: linhas [yTopo, yBase), colunas [ceil(xE), ceil(xD)))
   * e atributos (cor, u, v) interpolados em ponto fixo com gradientes truncados a 12 bits fracionários, a partir do
   * primeiro vértice do comando (medido contra o console real; aritmética de 32 bits que "dá a volta").
   */
  triangle(a, b, c, o) {
    let A = a, B = b, C = c, t;
    if (C.y < B.y) { t = B; B = C; C = t; }
    if (B.y < A.y) { t = A; A = B; B = t; }
    if (C.y < B.y) { t = B; B = C; C = t; }
    if (C.y === A.y) return;
    const D = (B.x - A.x) * (C.y - A.y) - (C.x - A.x) * (B.y - A.y);
    if (D === 0) return;
    const minX = Math.min(A.x, B.x, C.x), maxX = Math.max(A.x, B.x, C.x);
    if (maxX - minX > 1023 || C.y - A.y > 511) return;          // limite do hardware
    const yS = Math.max(A.y, this.daY1, 0), yE = Math.min(C.y - 1, this.daY2, 511);
    if (yS > yE) return;
    const xMin = Math.max(this.daX1, 0), xMax = Math.min(this.daX2, 1023);
    const shortRight = D > 0;
    const dxL = C.x - A.x, dyL = C.y - A.y;
    const ceilDiv = (n, d) => Math.ceil(n / d);                  // d > 0; n/d exato o bastante (|n| < 2^31, d < 2^11)
    // gradientes (12 bits fracionários, truncados para zero)
    const tex = o.tex, gour = o.gour, raw = o.raw, semi = o.semi, clutX = o.clutX, clutY = o.clutY;
    const grad = (ca, cb, cc) => {
      const nx = (cb - ca) * (C.y - A.y) - (cc - ca) * (B.y - A.y);
      const ny = (cc - ca) * (B.x - A.x) - (cb - ca) * (C.x - A.x);
      return [Math.trunc(nx * 4096 / D), Math.trunc(ny * 4096 / D)];
    };
    let rGx = 0, rGy = 0, gGx = 0, gGy = 0, bGx = 0, bGy = 0, uGx = 0, uGy = 0, vGx = 0, vGy = 0;
    if (gour) { [rGx, rGy] = grad(A.r, B.r, C.r); [gGx, gGy] = grad(A.g, B.g, C.g); [bGx, bGy] = grad(A.b, B.b, C.b); }
    if (tex) { [uGx, uGy] = grad(A.u, B.u, C.u); [vGx, vGy] = grad(A.v, B.v, C.v); }
    const P = a;                                                 // o hardware parte do 1o vértice do comando
    const r0 = (P.r << 12) + 2048, g0 = (P.g << 12) + 2048, b0 = (P.b << 12) + 2048, u0 = (P.u << 12) + 2048, v0 = (P.v << 12) + 2048;
    const dith = this.dither && (gour || (tex && !raw));
    const vram = this.vram, chk = this.checkMask, setM = this.setMask ? 0x8000 : 0, smode = this.semiMode, dthrOn = !!this.dither;
    const clut = this.clut, td = this.texDepth, tBase = this.texX * 64, tY = this.texY * 256;
    const mx = this.twMaskX, my = this.twMaskY, uAnd = ~(mx << 3), uOr = (this.twOffX & mx) << 3, vAnd = ~(my << 3), vOr = (this.twOffY & my) << 3;
    const ddOn = tex ? (!raw && dthrOn) : dith;
    const span = spanFor(tex, tex ? td : 0, gour, raw && tex, semi && true, ddOn, chk, tex && (mx | my) !== 0);
    const mk = this.rowMask;                                     // 480i: o hardware não desenha as linhas do campo exibido
    for (let y = yS; y <= yE; y++) {
      if (mk >= 0 && (y & 1) === mk) continue;
      const nL = A.x * dyL + (y - A.y) * dxL;                      // aresta longa: x = nL / dyL
      let xl, xr;
      const lx = ceilDiv(nL, dyL);
      let sx;
      if (y < B.y) sx = ceilDiv(A.x * (B.y - A.y) + (y - A.y) * (B.x - A.x), B.y - A.y);
      else sx = ceilDiv(B.x * (C.y - B.y) + (y - B.y) * (C.x - B.x), C.y - B.y);
      if (shortRight) { xl = lx; xr = sx; } else { xl = sx; xr = lx; }
      if (xl < xMin) xl = xMin;
      if (xr > xMax + 1) xr = xMax + 1;
      if (xl >= xr) continue;
      const dy = y - P.y, dx = xl - P.x;
      let cr = r0 + rGy * dy + rGx * dx, cg = g0 + gGy * dy + gGx * dx, cb = b0 + bGy * dy + bGx * dx;
      let cu = u0 + uGy * dy + uGx * dx, cv = v0 + vGy * dy + vGx * dx;
      span(vram, clut, QT, DITHER_T, y, xl, xr, cr, cg, cb, cu, cv, rGx, gGx, bGx, uGx, vGx, A.r, A.g, A.b, tBase, tY, uAnd, uOr, vAnd, vOr, smode, setM);
    }
  }

  // ===================== Retângulos =====================
  rect(b, c) {
    const tex = !!(c & 4), semi = !!(c & 2), raw = !!(c & 1), sz = (c >> 3) & 3;
    let i = 1;
    const col = b[0], r = col & 255, g = (col >> 8) & 255, bl = (col >> 16) & 255;
    const pos = b[i++];
    let u0 = 0, v0 = 0, clutX = 0, clutY = 0;
    if (tex) { const t = b[i++]; u0 = t & 255; v0 = (t >> 8) & 255; clutX = (t >>> 16) & 63; clutY = (t >>> 22) & 511; }
    let w, h;
    if (sz === 0) { const s = b[i++]; w = s & 0x3FF; h = (s >>> 16) & 0x1FF; }
    else if (sz === 1) { w = 1; h = 1; } else if (sz === 2) { w = 8; h = 8; } else { w = 16; h = 16; }
    const x0 = sx11(pos & 0x7FF) + this.offX, y0 = sx11((pos >>> 16) & 0x7FF) + this.offY;
    if (this.skipDraw || this.remote) return;
    if (this.hw) return this.hw.rect(x0, y0, w, h, { tex, semi, raw, r, g, b: bl, u0, v0, clutX, clutY, flipX: this.flipX, flipY: this.flipY });
    if (this.wr) {
      const wr = this.wr, P = wr.P; wr.sync(this);
      P[80] = x0; P[81] = y0; P[82] = w; P[83] = h; P[84] = r; P[85] = g; P[86] = bl; P[87] = u0; P[88] = v0; P[89] = (tex ? 1 : 0) | (semi ? 2 : 0) | (raw ? 4 : 0); P[90] = clutX; P[91] = clutY;
      return wr.x.rect();
    }
    if (tex) this.clutPrep(clutX, clutY);
    const mk = this.rowMask;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const px = x0 + x, py = y0 + y;
      if (mk >= 0 && (py & 1) === mk) continue;
      if (px < this.daX1 || px > this.daX2 || py < this.daY1 || py > this.daY2) continue;
      if (tex) {
        const u = this.flipX ? u0 + 1 - x : u0 + x, v = this.flipY ? v0 - y : v0 + y;   // flip X: o hardware começa em u0+1 (medido)
        this.shadeTexel(px, py, true, r, g, bl, raw, semi, false, clutX, clutY, u, v, false, false);
      } else this.plot(px, py, r, g, bl, semi, false);
    }
  }

  // ===================== Linhas =====================
  lineCmd(b, c) {
    const gour = !!(c & 0x10), poly = !!(c & 8);
    this.line = { semi: !!(c & 2), gour, pts: [], cols: [] };
    const L = this.line;
    L.pts.push(b[1]); L.cols.push(b[0] & 0xFFFFFF);
    if (gour) { L.cols.push(b[2] & 0xFFFFFF); L.pts.push(b[3]); } else { L.cols.push(b[0] & 0xFFFFFF); L.pts.push(b[2]); }
    if (!poly) { this.drawSeg(L, 0); this.line = null; return; }
    this.drawSeg(L, 0); this.phase = PH_POLYLINE; this.polyExpectColor = gour;
  }
  polylineWord(w) {
    const L = this.line;
    if ((w & 0xF000F000) === 0x50005000) { this.phase = PH_CMD; this.line = null; return; }
    if (L.gour && this.polyExpectColor) { this.polyColor = w & 0xFFFFFF; this.polyExpectColor = false; return; }
    L.pts.push(w); L.cols.push(L.gour ? this.polyColor : L.cols[0]);
    this.drawSeg(L, L.pts.length - 2);
    if (L.gour) this.polyExpectColor = true;
  }
  drawSeg(L, i) {
    const p0 = L.pts[i], p1 = L.pts[i + 1], c0 = L.cols[i], c1 = L.cols[i + 1];
    const x0 = sx11(p0 & 0x7FF) + this.offX, y0 = sx11((p0 >>> 16) & 0x7FF) + this.offY;
    const x1 = sx11(p1 & 0x7FF) + this.offX, y1 = sx11((p1 >>> 16) & 0x7FF) + this.offY;
    if (this.skipDraw || this.remote) return;
    if (this.hw) return this.hw.line(x0, y0, x1, y1, c0, c1, L.semi, L.gour);
    if (this.wr) { const wr = this.wr, P = wr.P; wr.sync(this); P[96] = x0; P[97] = y0; P[98] = x1; P[99] = y1; P[100] = c0; P[101] = c1; P[102] = (L.semi ? 1 : 0) | (L.gour ? 2 : 0); return wr.x.line(); }
    // Algoritmo do hardware: passo em ponto fixo 32.32 (arredondado "para longe do zero"), pixel = floor(pos + 0.5 - eps)
    let ax = x0, ay = y0, bx = x1, by = y1, ca = c0, cb = c1;
    const adx = Math.abs(x1 - x0), ady = Math.abs(y1 - y0), k = Math.max(adx, ady);
    if (adx >= 1024 || ady >= 512) return;
    if (ax >= bx && k) { ax = x1; ay = y1; bx = x0; by = y0; ca = c1; cb = c0; }
    const div = d => { if (k === 0) return 0; const n = d * 4294967296, q = n / k; return (q < 0 ? Math.floor(q) : Math.ceil(q)) / 4294967296; };
    const sx = div(bx - ax), sy = div(by - ay);
    const EX = LINE_EX, EY = LINE_EY;
    let px = ax + 0.5 - EX, py = ay + 0.5 - EY;
    const gour = L.gour, dither = this.dither;                 // linhas flat também recebem dithering (medido)
    const r0 = ca & 255, g0 = (ca >> 8) & 255, b0 = (ca >> 16) & 255;
    const tr = (cb & 255) - r0, tg = ((cb >> 8) & 255) - g0, tb = ((cb >> 16) & 255) - b0;
    const kk = k || 1, mk = this.rowMask;
    const dr = Math.trunc((tr * 4096) / kk), dg = Math.trunc((tg * 4096) / kk), db = Math.trunc((tb * 4096) / kk);
    for (let i = 0; i <= k; i++, px += sx, py += sy) {
      const x = Math.floor(px), y = Math.floor(py);
      if (mk >= 0 && (y & 1) === mk) continue;
      let r = r0, g = g0, bl = b0;
      if (gour) { r = ((r0 << 12) + 2048 + dr * i) >> 12; g = ((g0 << 12) + 2048 + dg * i) >> 12; bl = ((b0 << 12) + 2048 + db * i) >> 12; }
      this.plot(x, y, r, g, bl, L.semi, dither);
    }
  }

  // ===================== Saída de vídeo =====================
  /** paridade das linhas que NÃO podem ser desenhadas (campo exibido) em 480i com 'desenhar na área de display' proibido; -1 = sem restrição */
  /** liga o rasterizador em WebAssembly (VRAM na memória do wasm); false se indisponível */
  enableWasmRaster() { try { return enableWasmRaster(this); } catch (e) { return false; } }

  get rowMask() { return (this.interlace && this.vres && !this.drawToDisplay) ? this.field : -1; }

  /** Chamado a cada fim de quadro: guarda as linhas do campo exibido (completas) para tecer com o campo anterior na saída. */
  toggleField() { this.field ^= 1; if (this.remote) this.remote.push(6, this.field); }
  captureField() {
    if (this.remote) { this.remote.push(2, 0); return; }
    if (this.hw) return this.hw.captureField(this);
    this.captureFieldSW();
  }
  captureFieldSW() {
    if (!(this.interlace && this.vres) || !this.dispOn) { this.snapKey = ''; return; }
    const w = this.width, h = this.height, wv = this.rgb24 ? Math.ceil(w * 1.5) + 2 : w + 2;
    const key = this.startX + ',' + this.startY + ',' + w + ',' + h + ',' + (this.rgb24 ? 1 : 0);
    if (this.wr && !this.hw) {                                  // campo exibido + mapa de movimento no wasm
      const P = this.wr.P, par = this.field; this.snapPar = par;
      const full = key !== this.snapKey || !this.wr.snapReady; this.snapKey = key; this.wr.snapReady = true;
      P[128] = this.startX; P[129] = this.startY; P[130] = w; P[131] = h; P[132] = wv; P[133] = par; P[134] = full ? 1 : 0;
      return this.wr.x.capture();
    }
    if (!this.snap) { this.snap = new Uint16Array(1024 * 512); this.mot = new Uint8Array(1024 * 512); }
    const vr = this.vram, sn = this.snap, mot = this.mot, par = this.field; this.snapPar = par;
    const full = key !== this.snapKey; this.snapKey = key;
    for (let y = 0; y < h; y++) {
      const ry = (this.startY + y) & 0x1FF;
      if (!full && (ry & 1) !== par) continue;
      const row = ry * 1024;
      for (let x = 0; x < wv; x++) {
        const i = row + ((this.startX + x) & 0x3FF), n = vr[i], o = sn[i];
        // movimento = este pixel mudou em relação ao MESMO campo de 2 quadros atrás (o campo velho é do instante t-1: usado no desentrelaçamento adaptativo)
        mot[i] = full || ((((n & 31) - (o & 31)) + 1) >>> 0) > 2 || (((((n >> 5) & 31) - ((o >> 5) & 31)) + 1) >>> 0) > 2 || (((((n >> 10) & 31) - ((o >> 10) & 31)) + 1) >>> 0) > 2 ? 1 : 0;
        sn[i] = n;
      }
    }
  }

  get dotDiv() { return this.hres2 ? 7 : [10, 8, 5, 4][this.hres1]; }   // divisor do dot clock
  get width() { return this.hres2 ? 368 : [256, 320, 512, 640][this.hres1]; }
  get height() {
    const lines = Math.max(0, this.vy2 - this.vy1);
    const h = (lines > 0 && lines <= 288) ? lines * (this.vres ? 2 : 1) : (this.vres ? 480 : 240);
    return Math.min(h, 576);
  }

  /** Converte a área de display da VRAM para RGBA (Uint8ClampedArray width*height*4). */
  renderRGBA(out) {
    const w = this.width, h = this.height;
    out = out ?? new Uint8ClampedArray(w * h * 4);
    if (!this.dispOn) { out.fill(0); for (let i = 3; i < out.length; i += 4) out[i] = 255; return { data: out, width: w, height: h }; }
    if (this.wr && !this.hw) {                                  // conversão VRAM -> RGBA (com desentrelaçamento) no wasm
      const wr = this.wr, P = wr.P, useSnap = !!(wr.snapReady && this.snapKey && this.interlace && this.vres);
      P[136] = this.startX; P[137] = this.startY; P[138] = w; P[139] = h; P[140] = this.rgb24 ? 1 : 0; P[141] = useSnap ? 1 : 0; P[142] = this.deint; P[143] = this.snapPar;
      wr.x.render(); out.set(wr.OUT.subarray(0, w * h * 4)); this.frameCount++;
      return { data: out, width: w, height: h };
    }
    const vram = (this.snap && this.snapKey && this.interlace && this.vres) ? this.snap : this.vram;   // 480i: dois últimos campos completos
    const dmode = (vram === this.snap && !this.rgb24) ? this.deint : 0, spar = this.snapPar;
    for (let y = 0; y < h; y++) {
      const ry = (this.startY + y) & 0x1FF, row = ry * 1024;
      // 480i: as linhas do campo ANTIGO podem estar "fantasmas" onde algo se mexeu -> adaptativo troca pela média das vizinhas do campo atual
      const di = dmode !== 0 && (ry & 1) !== spar;
      const rA = di && y > 0 ? ((ry - 1) & 0x1FF) * 1024 : -1, rB = di && y < h - 1 ? ((ry + 1) & 0x1FF) * 1024 : -1;
      for (let x = 0; x < w; x++) {
        let r, g, b;
        if (this.rgb24) {
          const bx = ((this.startX * 2 + x * 3) >> 0);             // posição em bytes
          const wi = row + ((bx >> 1) & 0x3FF), lo = vram[wi], hi = vram[(wi & ~1023) + (((bx >> 1) + 1) & 0x3FF)];
          const bytes = (bx & 1) ? [lo >> 8, hi & 255, hi >> 8] : [lo & 255, lo >> 8, hi & 255];
          r = bytes[0]; g = bytes[1]; b = bytes[2];
        } else {
          const p = vram[row + ((this.startX + x) & 0x3FF)];
          r = (p & 31) << 3; g = ((p >> 5) & 31) << 3; b = ((p >> 10) & 31) << 3;
          r |= r >> 5; g |= g >> 5; b |= b >> 5;
          if (di && (rA >= 0 || rB >= 0)) {
            const xi = (this.startX + x) & 0x3FF, pa = vram[(rA >= 0 ? rA : rB) + xi], pb = vram[(rB >= 0 ? rB : rA) + xi];
            if (dmode === 1 && !(this.mot[(rA >= 0 ? rA : rB) + xi] | this.mot[(rB >= 0 ? rB : rA) + xi])) { /* sem movimento perto: mantém a linha do campo antigo (tecer) */ } else {
            let ar = (((pa & 31) + (pb & 31)) << 2) , ag = ((((pa >> 5) & 31) + ((pb >> 5) & 31)) << 2), ab = ((((pa >> 10) & 31) + ((pb >> 10) & 31)) << 2);
            ar |= ar >> 5; ag |= ag >> 5; ab |= ab >> 5;
            r = ar; g = ag; b = ab; }
          }
        }
        const o = (y * w + x) * 4; out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = 255;
      }
    }
    this.frameCount++;
    return { data: out, width: w, height: h };
  }
}

export const DEINT_THR = 40;
function rgb24to15(c) { return (((c & 255) >> 3) | ((((c >> 8) & 255) >> 3) << 5) | ((((c >> 16) & 255) >> 3) << 10)); }
function clamp8(v) { return v < 0 ? 0 : v > 255 ? 255 : v; }

/** Fluxo de comandos para o rasterizador em worker: pares [tipo, valor] (0=GP0, 1=GP1, 2=captura do campo, 3=apresentar, 6=campo atual). */
export class GpuStream {
  constructor(post) { this.post = post; this.q = new Uint32Array(1 << 16); this.n = 0; this.inflight = 0; this.onRead = null; }
  push(t, v) { if (this.n >= this.q.length) this.flush(); this.q[this.n++] = t; this.q[this.n++] = v; }
  flush() {
    if (!this.n) return;
    const o = this.q.slice(0, this.n); this.n = 0;
    this.post({ t: 'cmds', q: o }, [o.buffer]);
  }
}
