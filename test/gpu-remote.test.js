// GPU em 2ª thread: o fluxo de comandos (GpuStream) reproduzido num GPU separado deve dar exatamente a mesma VRAM,
// e a leitura de VRAM de volta deve avisar (onRead).
import assert from 'node:assert/strict';
import { GPU, GpuStream } from '../src/gpu.js';
const ref = new GPU(), em = new GPU(), W = new GPU();
em.remote = new GpuStream(m => { const q = m.q; for (let i = 0; i < q.length; i += 2) { const t = q[i], v = q[i + 1]; if (t === 0) W.writeGP0(v); else if (t === 1) W.writeGP1(v); else if (t === 6) W.field = v; else if (t === 2) W.captureFieldSW(); } });
const both = (w, gp1) => { for (const g of [ref, em]) gp1 ? g.writeGP1(w) : g.writeGP0(w); };
let seed = 12345; const rnd = n => (seed = (seed * 1103515245 + 12345) >>> 0, (seed >>> 8) % n);
both(0x08000000 | (1 << 2) | (1 << 5) | (1 << 6), true);                         // 368x480i
both(0xE3000000, false); both(0xE4000000 | (511 << 10) | 1023, false); both(0xE6000000 | 3, false);
for (const f of [0, 1]) {
  ref.field = f; em.toggleField(); if (em.field !== f) em.toggleField(); ref.field = em.field;
  both(0x02112233, false); both(0, false); both((64 << 16) | 128, false);              // fill
  both(0xA0000000, false); both(0x00100010, false); both((8 << 16) | 8, false); for (let i = 0; i < 32; i++) both(0x7FFF03E0 ^ (i * 977), false);   // upload 8x8
  for (let n = 0; n < 40; n++) {
    both(0x30000000 | (rnd(0xFFFFFF)), false); both((rnd(200) << 16) | rnd(300), false);
    both(rnd(0xFFFFFF), false); both((rnd(200) << 16) | rnd(300), false); both(rnd(0xFFFFFF), false); both((rnd(200) << 16) | rnd(300), false);
    both(0x64000000 | rnd(0xFFFFFF), false); both((rnd(200) << 16) | rnd(300), false); both(0x0000, false); both((12 << 16) | 20, false);
  }
  both(0x80000000, false); both(0, false); both((40 << 16) | 40, false); both((16 << 16) | 16, false);                    // vram->vram
  em.captureField(); ref.captureField();
}
em.remote.flush();
assert.deepEqual(Buffer.from(W.vram.buffer), Buffer.from(ref.vram.buffer), 'VRAM do worker idêntica à de uma thread');
assert.ok(ref.vram.some(v => v !== 0), 'desenhou algo');
assert.ok(em.vram.every(v => v === 0), 'a thread do emulador não rasteriza');
let reads = 0; em.remote.onRead = () => reads++;
em.writeGP0(0xC0000000); em.writeGP0(0); em.writeGP0((4 << 16) | 4);
assert.equal(reads, 1, 'leitura de VRAM avisa');
console.log('ok - GPU em 2ª thread: VRAM idêntica (' + ref.vram.reduce((a, v) => a + (v ? 1 : 0), 0) + ' pixels), leitura avisa');
