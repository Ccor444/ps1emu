// ============================================================================
//  MDEC - decodificador de macroblocos (vídeo STR / imagens) 0x1F801820 / 0x1F801824
//   0x1F801820 W: comando/parâmetros   R: dados decodificados
//   0x1F801824 W: controle (b31 reset, b30 DMA0 on, b29 DMA1 on)   R: status
//  Comandos (bits 31-29 da palavra de comando):
//   1 = decodificar macroblocos (b28-27 profundidade: 0=4bit 1=8bit 2=24bit 3=15bit, b26 signed, b25 bit15, b15-0 = nº de palavras)
//   2 = tabelas de quantização (b0: 0 = só luma 64B, 1 = luma + croma 128B)
//   3 = tabela de escala do IDCT (64 halfwords)
//  Entrada: halfwords RLE: [qscale(6) | DC(10)] depois [run(6) | valor(10)] ... até 0xFE00 (fim de bloco)
//  Saída: macroblocos 16x16 (cores) na ordem do fluxo; cada um é decodificado de blocos Cr,Cb,Y1,Y2,Y3,Y4.
//  A decodificação é imediata (sem temporização); a conclusão do DMA é agendada pelo controlador de DMA.
// ============================================================================
const ZIGZAG = [0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28,
                35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63];
const IDLE = 0, DECODE = 1, QUANT = 2, SCALE = 3;
const sx10 = v => (v << 22) >> 22;
const clamp = (v, lo, hi) => v < lo ? lo : v > hi ? hi : v;

/** tabela de cossenos padrão: T[k*8+n] = a_k * cos((2n+1)kπ/16) * 32768  (a_0 = 1/√2) */
export function defaultScaleTable() {
  const t = new Int16Array(64);
  for (let k = 0; k < 8; k++) for (let n = 0; n < 8; n++) t[k * 8 + n] = Math.trunc((k === 0 ? Math.SQRT1_2 : 1) * Math.cos((2 * n + 1) * k * Math.PI / 16) * 32768);
  return t;
}

export class MDEC {
  constructor() {
    this.out = new Uint8Array(1 << 22); this.onOutput = null; this.pendingOut = null;
    this.qtY = new Uint8Array(64).fill(2); this.qtC = new Uint8Array(64).fill(2); this.scale = defaultScaleTable();
    this.reset();
  }

  reset() {
    this.state = IDLE; this.remaining = 0; this.depth = 0; this.signed = 0; this.bit15 = 0;
    this.hw = []; this.hwPos = 0; this.blocks = [0, 1, 2, 3, 4, 5].map(() => new Int32Array(64)); this.blk = 0;
    this.head = 0; this.tail = 0; this.dmaInEn = false; this.dmaOutEn = false; this.qbuf = []; this.sbuf = []; this.colorQ = false;
    this.coef = new Int32Array(64); this.tmp = new Int32Array(64); this.pendingOut = null; this.blocksDone = 0;
  }

  outWords() { return (this.tail - this.head) >> 2; }

  // ---------------- registradores ----------------
  read(addr) {
    if ((addr & 4) === 0) return this.dmaRead(1)[0];
    let s = 0;
    if (this.outWords() === 0) s |= 0x80000000;
    if (this.state !== IDLE) s |= 0x20000000;                       // comando em andamento (busy)
    if (this.dmaInEn) s |= 0x10000000;
    if (this.dmaOutEn && this.outWords() > 0) s |= 0x08000000;
    s |= (this.depth << 25) | (this.signed << 24) | (this.bit15 << 23) | ((this.blk < 6 ? (this.blk + 4) % 6 : 0) << 16);
    s |= this.state === IDLE ? 0 : ((this.remaining - 1) & 0xFFFF);
    return s >>> 0;
  }
  write(addr, v) {
    if ((addr & 4) === 0) { this.writeWord(v >>> 0); return; }
    if (v & 0x80000000) { const o = this.out; const e1 = this.onOutput; this.reset(); this.out = o; this.onOutput = e1; }
    this.dmaInEn = !!(v & 0x40000000); this.dmaOutEn = !!(v & 0x20000000);
  }

  // palavra de comando ou de parâmetro (via CPU ou DMA0)
  writeWord(w) {
    if (this.state === IDLE) {
      const cmd = w >>> 29;
      if (cmd === 1) {
        this.depth = (w >>> 27) & 3; this.signed = (w >>> 26) & 1; this.bit15 = (w >>> 25) & 1; this.remaining = w & 0xFFFF;
        this.state = this.remaining ? DECODE : IDLE; this.blk = 0; this.hw = []; this.hwPos = 0;
      } else if (cmd === 2) { this.colorQ = !!(w & 1); this.remaining = this.colorQ ? 32 : 16; this.qbuf = []; this.state = QUANT; }
      else if (cmd === 3) { this.remaining = 32; this.sbuf = []; this.state = SCALE; }
      return;
    }
    if (this.state === QUANT) {
      this.qbuf.push(w & 255, (w >>> 8) & 255, (w >>> 16) & 255, w >>> 24);
      if (--this.remaining === 0) {
        this.qtY.set(this.qbuf.slice(0, 64));
        if (this.colorQ) this.qtC.set(this.qbuf.slice(64, 128)); else this.qtC.set(this.qtY);
        this.state = IDLE;
      }
    } else if (this.state === SCALE) {
      this.sbuf.push(((w & 0xFFFF) << 16) >> 16, (w >> 16));
      if (--this.remaining === 0) { this.scale.set(this.sbuf); this.state = IDLE; }
    } else {                                                          // DECODE
      this.hw.push(w & 0xFFFF, w >>> 16);
      if (this.hw.length > 8192) { this.hw = this.hw.slice(this.hwPos); this.hwPos = 0; }   // evita crescer sem limite
      this.decodeAvailable();
      if (--this.remaining === 0) {
        this.state = IDLE; this.hw = []; this.hwPos = 0;
        if (this.outWords() > 0) this.onOutput?.();
      }
    }
  }

  dmaWrite(words) { for (let i = 0; i < words.length; i++) this.writeWord(words[i]); }
  /** retira n palavras da saída (as que faltarem vêm como zero) */
  dmaRead(n) {
    const o = new Uint32Array(n); let p = this.head;
    for (let i = 0; i < n && p + 4 <= this.tail; i++, p += 4) o[i] = (this.out[p] | (this.out[p + 1] << 8) | (this.out[p + 2] << 16) | (this.out[p + 3] << 24)) >>> 0;
    this.head = Math.min(this.tail, p); if (this.head === this.tail) this.head = this.tail = 0;
    return o;
  }

  // ---------------- decodificação ----------------
  /** decodifica todos os blocos completos disponíveis na fila de halfwords */
  decodeAvailable() {
    const color = this.depth >= 2;
    for (;;) {
      const res = this.decodeBlock(color ? (this.blk < 2 ? this.qtC : this.qtY) : this.qtY, this.blocks[color ? this.blk : 0]);
      if (!res) return;
      if (!color) { this.emitMono(this.blocks[0]); continue; }
      if (++this.blk === 6) { this.blk = 0; this.emitColor(); }
    }
  }

  /** lê 1 bloco (DC + ACs até EOB). Devolve false se faltarem halfwords (nada é consumido). */
  decodeBlock(qt, dst) {
    const hw = this.hw; let p = this.hwPos;
    while (p < hw.length && hw[p] === 0xFE00) p++;                   // preenchimento antes do bloco
    if (p >= hw.length) { this.hwPos = p; return false; }
    const first = hw[p++], qscale = first >>> 10, coef = this.coef; coef.fill(0);
    coef[0] = clamp(qscale === 0 ? sx10(first & 0x3FF) * 2 : sx10(first & 0x3FF) * qt[0], -1024, 1023);
    let k = 0, done = false;
    while (p < hw.length) {
      const h = hw[p++];
      if (h === 0xFE00) { done = true; break; }
      k += (h >>> 10) + 1;
      if (k > 63) { done = true; break; }
      { const n = sx10(h & 0x3FF), q = qscale === 0 ? n * 2 : (n * qt[k] * qscale + 4) >> 3; coef[ZIGZAG[k]] = q < -1024 ? -1024 : q > 1023 ? 1023 : q; }
      if (k === 63) { done = true; break; }
    }
    if (!done) return false;                                         // bloco incompleto: espera mais dados
    this.hwPos = p; this.idct(coef, dst); this.blocksDone++; return true;
  }

  /** IDCT 2D inteira (2 passadas), resultado saturado em -128..127 */
  idct(src, dst) {
    const T = this.scale, tmp = this.tmp, nzz = this.nzz || (this.nzz = new Int32Array(8)), nzv = this.nzv || (this.nzv = new Int32Array(8));
    for (let pass = 0; pass < 2; pass++) {
      const s = pass === 0 ? src : tmp, d = pass === 0 ? tmp : dst;
      for (let y = 0; y < 8; y++) {
        let n = 0;                                                    // só os coeficientes não nulos da coluna entram na soma (resultado idêntico, bem menos multiplicações)
        for (let z = 0; z < 8; z++) { const v = s[y + z * 8]; if (v !== 0) { nzz[n] = z * 8; nzv[n++] = v; } }
        if (n === 0) { for (let x = 0; x < 8; x++) d[x + y * 8] = 0; continue; }
        for (let x = 0; x < 8; x++) {
          let sum = 0;
          for (let i = 0; i < n; i++) sum += nzv[i] * T[x + nzz[i]];
          d[x + y * 8] = pass === 0 ? sum >> 13 : Math.floor((sum + 0x4000) / 32768);   // medido contra o console real (ps1-tests/mdec/frame)
        }
      }
    }
    for (let i = 0; i < 64; i++) { const v = (dst[i] + 8) >> 4; dst[i] = v < -128 ? -128 : v > 127 ? 127 : v; }
  }

  put(b) { if (this.tail < this.out.length) this.out[this.tail++] = b; }

  emitMono(blk) {
    const off = this.signed ? 0 : 128;
    if (this.depth === 1) for (let i = 0; i < 64; i++) this.put((blk[i] + off) & 255);              // 8 bits
    else for (let i = 0; i < 64; i += 2) this.put((((blk[i] + off) & 255) >> 4) | ((((blk[i + 1] + off) & 255) >> 4) << 4));   // 4 bits
  }

  emitColor() {
    const [cr, cb, y1, y2, y3, y4] = this.blocks, off = this.signed ? 0 : 128, b15 = this.bit15 << 15, ys = [y1, y2, y3, y4];
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
      const Y = ys[((y >> 3) << 1) | (x >> 3)][((y & 7) << 3) | (x & 7)], ci = ((y >> 1) << 3) | (x >> 1), Cr = cr[ci], Cb = cb[ci];
      const r = clamp(Y + ((359 * Cr + 128) >> 8), -128, 127), g = clamp(Y - ((88 * Cb + 183 * Cr + 128) >> 8), -128, 127), b = clamp(Y + ((454 * Cb + 128) >> 8), -128, 127);
      if (this.depth === 2) { this.put((r + off) & 255); this.put((g + off) & 255); this.put((b + off) & 255); }          // 24 bits
      else {                                                                                                          // 15 bits
        const q = v => Math.min(((v + off) & 255) + 4 >> 3, 31);   // 15 bits: arredonda (confirmado no console real)
        const px = q(r) | (q(g) << 5) | (q(b) << 10) | b15;
        this.put(px & 255); this.put(px >> 8);
      }
    }
  }
}
