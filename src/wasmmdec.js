// ============================================================================
//  MDEC em WebAssembly (wasm/mdec.c, no módulo da CPU): troca os métodos da instância MDEC pelos do núcleo compilado.
//  O estado fica na memória do wasm; as mesmas propriedades de sempre (state, remaining, out, qtY, hw...) viram janelas para ela,
//  então save states e testes continuam enxergando a estrutura antiga. O DMA0/DMA1 leem/escrevem a RAM direto (feedRam/toRam).
// ============================================================================
export function enableWasmMdec(psx, x, buf) {
  const m = psx.mdec; if (!m || m.wasm) return;
  const P = i => x.mdec_ptr(i);
  const MS = new Int32Array(buf, P(0), 16), OUT = new Uint8Array(buf, P(1), 1 << 22), QY = new Uint8Array(buf, P(2), 64), QC = new Uint8Array(buf, P(3), 64);
  const SC = new Int16Array(buf, P(4), 64), BL = new Int32Array(buf, P(5), 6 * 64), HW = new Uint16Array(buf, P(6), 16384), QB = new Uint8Array(buf, P(7), 128), SB = new Int16Array(buf, P(8), 64);
  const blocks = [0, 1, 2, 3, 4, 5].map(i => BL.subarray(i * 64, i * 64 + 64));
  // estado atual (JS) -> memória do wasm
  OUT.set(m.out); QY.set(m.qtY); QC.set(m.qtC); SC.set(m.scale);
  x.mdec_reset();
  const num = ['state', 'remaining', 'depth', 'signed', 'bit15', 'blk', 'head', 'tail'];
  const old = { hw: m.hw, hwPos: m.hwPos, qbuf: m.qbuf, sbuf: m.sbuf, blocks: m.blocks, blocksDone: m.blocksDone };
  num.forEach((k, i) => { MS[i] = m[k] | 0; });
  MS[8] = m.dmaInEn ? 1 : 0; MS[9] = m.dmaOutEn ? 1 : 0; MS[10] = m.colorQ ? 1 : 0; MS[11] = old.blocksDone | 0; MS[12] = old.hwPos | 0;
  { const h = old.hw || []; HW.set(h.slice(0, 16384)); MS[13] = Math.min(h.length, 16384); }
  { const q = old.qbuf || []; QB.set(q.slice(0, 128)); MS[14] = Math.min(q.length, 128); }
  { const s = old.sbuf || []; SB.set(s.slice(0, 64)); MS[15] = Math.min(s.length, 64); }
  (old.blocks || []).forEach((b, i) => { if (i < 6) blocks[i].set(b); });
  const def = (k, get, set) => Object.defineProperty(m, k, { get, set, enumerable: true, configurable: true });
  num.forEach((k, i) => def(k, () => MS[i], v => { MS[i] = v | 0; }));
  [['dmaInEn', 8], ['dmaOutEn', 9], ['colorQ', 10]].forEach(([k, i]) => def(k, () => MS[i] !== 0, v => { MS[i] = v ? 1 : 0; }));
  def('blocksDone', () => MS[11], v => { MS[11] = v | 0; });
  def('hwPos', () => MS[12], v => { MS[12] = v | 0; });
  def('hw', () => Array.from(HW.subarray(0, MS[13])), v => { const a = v || []; HW.set(a.slice(0, 16384)); MS[13] = Math.min(a.length, 16384); });
  def('qbuf', () => Array.from(QB.subarray(0, MS[14])), v => { const a = v || []; QB.set(a.slice(0, 128)); MS[14] = Math.min(a.length, 128); });
  def('sbuf', () => Array.from(SB.subarray(0, MS[15])), v => { const a = v || []; SB.set(a.slice(0, 64)); MS[15] = Math.min(a.length, 64); });
  def('blocks', () => blocks, v => { (v || []).forEach((b, i) => { if (i < 6) blocks[i].set(b); }); });
  m.out = OUT; m.qtY = QY; m.qtC = QC; m.scale = SC;
  delete m.coef; delete m.tmp; delete m.nzz; delete m.nzv;

  m.reset = function () { x.mdec_reset(); this.pendingOut = null; };
  m.outWords = () => x.mdec_outwords() >>> 0;
  m.read = function (addr) { return (addr & 4) === 0 ? x.mdec_pop() >>> 0 : x.mdec_status() >>> 0; };
  m.writeWord = function (w) { if (x.mdec_word(w >>> 0)) this.onOutput?.(); };
  m.write = function (addr, v) {
    if ((addr & 4) === 0) { this.writeWord(v >>> 0); return; }
    if (v & 0x80000000) { const e1 = this.onOutput; this.reset(); this.onOutput = e1; }
    MS[8] = (v & 0x40000000) ? 1 : 0; MS[9] = (v & 0x20000000) ? 1 : 0;
  };
  m.dmaWrite = function (words) { for (let i = 0; i < words.length; i++) this.writeWord(words[i]); };
  m.dmaRead = function (n) { const o = new Uint32Array(n); for (let i = 0; i < n; i++) o[i] = x.mdec_pop() >>> 0; return o; };
  /** DMA0: `words` palavras da RAM (a partir de addr, com passo step) para o MDEC; onOutput dispara no instante em que um comando termina com saída */
  m.feedRam = function (addr, words, step) {
    let left = words, a = addr;
    while (left > 0) { const n = x.mdec_feed(a >>> 0, left, step | 0); a += n * step; left -= n; if (x.mdec_evt()) this.onOutput?.(); }
  };
  /** DMA1: `words` palavras da saída para a RAM (as que faltarem vão como zero) */
  m.toRam = function (addr, words, step) { x.mdec_to_ram(addr >>> 0, words, step | 0); };
  m.wasm = true;
}
