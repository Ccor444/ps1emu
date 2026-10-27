// SPU em wasm x implementação de referência em JS (spu-ref.js): mesmos registradores/RAM aleatórios => mesma saída e estado
import test from 'node:test'; import assert from 'node:assert/strict';
import { SPU } from '../src/spu.js'; import { SPU as REF } from './spu-ref.js';
let seed = +(process.env.SP_SEED || 12345); const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
const ri = n => Math.floor(rnd() * n);
test('SPU wasm == referência JS (programas aleatórios)', () => {
  for (let round = 0; round < 12; round++) {
    const a = new SPU(), b = new REF(); let ia = 0, ib = 0; a.onIrq = () => ia++; b.onIrq = () => ib++;
    for (let i = 0; i < 0x20000; i++) { const v = ri(256); a.ram[i] = v; b.ram[i] = v; if (i % 16 === 1) { const f = ri(8) === 0 ? 3 : ri(8) === 0 ? 1 : ri(4) === 0 ? 4 : 0; a.ram[i] = b.ram[i] = f; } }
    const W = (ad, v) => { a.write(0x1F800000 + ad, 2, v); b.write(0x1F800000 + ad, 2, v); };
    W(0x1DAA, 0xC000 | (round & 1 ? 0x80 : 0) | (round & 2 ? 0x40 : 0) | (round & 4 ? 0x0100 * ri(4) : 0) | ri(8)); W(0x1D80, 0x3FFF); W(0x1D82, 0x3FFF);
    W(0x1DA2, 0x4000 + ri(0x2000)); W(0x1DA4, ri(0x4000)); W(0x1D84, 0x2000 + ri(0x3000)); W(0x1D86, 0x2000 + ri(0x3000));
    for (let i = 0; i < 32; i++) W(0x1DC0 + i * 2, ri(65536) & (i < 2 || (i >= 10 && i < 30) ? 0x3FFF : 0xFFFF));
    W(0x1D98, ri(65536)); W(0x1D9A, ri(256)); W(0x1D90, ri(65536)); W(0x1D94, round > 5 ? ri(65536) : 0); W(0x1DB0, 0x3FFF); W(0x1DB2, 0x3FFF);
    for (let n = 0; n < 24; n++) {
      const c = 0x1C00 + n * 16; W(c, ri(2) ? 0x8000 | ri(0x7FFF) : ri(0x4000)); W(c + 2, ri(0x4000)); W(c + 4, ri(0x3000)); W(c + 6, ri(0x3000));
      W(c + 8, ri(65536)); W(c + 10, ri(65536));
    }
    W(0x1D88, ri(65536)); W(0x1D8A, ri(256));
    for (let i = 0; i < 4000; i++) { a.pushCd(ri(65536) - 32768, ri(65536) - 32768); b.pushCd(a.cdBufL[(a.cdTail - 1) & 0xFFFF], a.cdBufR[(a.cdTail - 1) & 0xFFFF]); }
    for (let k = 0; k < 6000; k++) {
      if (k % 700 === 0) { const n = ri(24); if (ri(2)) { W(0x1D88, (1 << (n % 16)) & 0xFFFF); W(0x1D8A, n >= 16 ? 1 << (n - 16) : 0); } else { W(0x1D8C, (1 << (n % 16)) & 0xFFFF); W(0x1D8E, n >= 16 ? 1 << (n - 16) : 0); } }
      if (k % 1500 === 700) { const n = ri(24), c = 0x1C00 + n * 16; W(c + 4, ri(0x3FFF)); W(c, ri(2) ? 0x8000 | ri(0x7FFF) : ri(0x4000)); }
      const [l1, r1] = a.tick(), [l2, r2] = b.tick();
      if (l1 !== l2 || r1 !== r2) assert.fail(`round ${round} k ${k}: (${l1},${r1}) != (${l2},${r2})`);
    }
    assert.equal(ia, ib, 'IRQs'); assert.equal(a.endx, b.endx); assert.equal(a.revPos, b.revPos); assert.equal(a.noise, b.noise);
    for (let n = 0; n < 24; n++) for (const f of ['addr', 'counter', 'phase', 'level', 'envCnt', 'idx', 'old1', 'old2', 'cur', 'h1', 'h2', 'h3', 'last']) assert.equal(a.voices[n][f], b.voices[n][f], `voz ${n}.${f}`);
    for (let i = 0; i < 50; i++) assert.equal(a.sw[i].level, b.sw[i].level | 0, 'sweep ' + i);
    assert.deepEqual(a.ram, b.ram);
  }
});
test('SPU wasm: render em lote == tick a tick', () => {
  const a = new SPU(), b = new SPU(); for (const s of [a, b]) { s.write(0x1F801DAA, 2, 0xC000); s.write(0x1F801D80, 2, 0x3FFF); s.write(0x1F801D82, 2, 0x3FFF); s.ram.fill(0x77, 0x1000, 0x2000); s.ram[0x1001] = 2; }
  for (const s of [a, b]) { s.write(0x1F801C00, 2, 0x3FFF); s.write(0x1F801C02, 2, 0x3FFF); s.write(0x1F801C04, 2, 0x1000); s.write(0x1F801C06, 2, 0x200); s.write(0x1F801C08, 2, 0x00FF); s.write(0x1F801D88, 2, 1); }
  const o = a.render(9000), p = new Int16Array(18000); for (let i = 0; i < 9000; i++) { const [l, r] = b.tick(); p[2 * i] = l; p[2 * i + 1] = r; }
  assert.deepEqual(o, p);
});
