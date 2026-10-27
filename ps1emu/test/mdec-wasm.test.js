// MDEC em wasm (wasm/mdec.c) x implementação JS original (test/mdec-ref.js): fluxos aleatórios têm que dar status, saída e eventos idênticos.
import assert from 'node:assert/strict';
delete process.env.PS1_WASMMDEC; globalThis.PS1_WASM = 1;
import { PSX } from '../src/psx.js';
import { MDEC as Ref } from './mdec-ref.js';

let seed = 4242; const rnd = n => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return (seed >>> 8) % n; };
const p = new PSX(); assert.ok(p.enableWasm()); const W = p.mdec; assert.ok(W.wasm, 'MDEC em wasm ativo');
const R = new Ref(); let evW = 0, evR = 0; W.onOutput = () => evW++; R.onOutput = () => evR++;
const same = (what) => {
  assert.equal(W.read(4), R.read(4), what + ': status'); assert.equal(W.outWords(), R.outWords(), what + ': palavras de saída');
  assert.equal(evW, evR, what + ': eventos');
};
const both = f => { f(W); f(R); };
// fluxo de macroblocos aleatório: halfwords RLE
function mbStream(nmb, depth) {
  const hw = [];
  for (let m = 0; m < nmb; m++) for (let b = 0; b < 6; b++) {
    hw.push((rnd(64) << 10) | rnd(1024));
    const n = rnd(12); for (let i = 0; i < n; i++) hw.push((rnd(20) << 10) | rnd(1024));
    hw.push(0xFE00);
  }
  if (hw.length & 1) hw.push(0xFE00);
  const w = []; for (let i = 0; i < hw.length; i += 2) w.push((hw[i] | (hw[i + 1] << 16)) >>> 0);
  return w;
}
let total = 0;
for (let round = 0; round < 300; round++) {
  const depth = rnd(4), sg = rnd(2), b15 = rnd(2);
  if (rnd(10) === 0) both(m => m.write(4, 0x80000000));
  both(m => m.write(4, 0x60000000));
  if (rnd(3) === 0) {                                  // tabelas
    const q = []; for (let i = 0; i < 32; i++) q.push((Math.imul(i + round, 0x01010101) ^ (rnd(0x7FFFFFFF))) >>> 0);
    both(m => { m.write(0, (0x40000000 | 1) >>> 0); q.forEach(w => m.write(0, w)); });
    same('quant');
  }
  if (rnd(4) === 0) { const t = []; for (let i = 0; i < 32; i++) t.push((rnd(0x10000) | (rnd(0x10000) << 16)) >>> 0); both(m => { m.write(0, 0x60000000); t.forEach(w => m.write(0, w)); }); same('escala'); }
  const nmb = 1 + rnd(4), w = mbStream(nmb, depth);
  const cmd = ((0x20000000 | (depth << 27) | (sg << 26) | (b15 << 25) | w.length) >>> 0);
  both(m => m.write(0, cmd));
  same('cmd');
  const mode = rnd(3);
  if (mode === 0) both(m => w.forEach(x => m.write(0, x)));
  else if (mode === 1) both(m => m.dmaWrite(w));
  else {                                               // DMA0 direto da RAM (passo ±4)
    const base = 0x10000, step = rnd(2) ? 4 : -4, addr = step > 0 ? base : base + 4 * (w.length - 1);
    w.forEach((x, i) => p.bus.ramView.setUint32(base + 4 * i, x, true));
    W.feedRam(addr, w.length, step); R.dmaWrite(w.map((_, i) => p.bus.ramView.getUint32(base + 4 * i, true)).slice().sort(() => 0).map((_, i) => w[step > 0 ? i : w.length - 1 - i]));
  }
  same('dados');
  const n = Math.min(W.outWords(), 4 + rnd(4000)); total += n;
  if (rnd(2)) { const a = W.dmaRead(n), b = R.dmaRead(n); assert.deepEqual(Array.from(a), Array.from(b), 'saída ' + round); }
  else {                                               // DMA1 para a RAM (pede mais do que existe: completa com zeros)
    const ask = n + rnd(8), addr = 0x20000; W.toRam(addr, ask, 4); const b = R.dmaRead(ask);
    for (let i = 0; i < ask; i++) assert.equal(p.bus.ramView.getUint32(addr + 4 * i, true), b[i] >>> 0, 'toRam ' + round + ' @' + i);
  }
  same('pós-leitura');
  // saída residual: lê por palavra
  for (let i = 0; i < 3; i++) assert.equal(W.read(0), R.read(0));
  same('residual');
}
// estado serializável continua enxergável (state.js lê as propriedades)
for (const k of ['state', 'remaining', 'depth', 'signed', 'bit15', 'blk', 'head', 'tail', 'dmaInEn', 'dmaOutEn', 'hw', 'qbuf', 'sbuf', 'blocks']) assert.ok(k in W, 'propriedade ' + k);
console.log('  ok   MDEC wasm == JS (300 rodadas, ' + total + ' palavras de saída comparadas)');
