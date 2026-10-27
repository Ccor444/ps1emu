// XA-ADPCM, CD-DA e leitura por DMA do CD-ROM (wasm) x implementação de referência em JS (cdrom-ref.js)
import test from 'node:test'; import assert from 'node:assert/strict';
import { CDROM } from '../src/cdrom.js'; import { CDROM as REF } from './cdrom-ref.js'; import { SPU } from '../src/spu.js';
let seed = +(process.env.CD_SEED || 7); const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296, ri = n => Math.floor(rnd() * n);
const mk = () => { const sys = { now: () => 0, sched: { call: () => 1, cancel() {} }, bus: { raiseIrq() {} } }, c = new CDROM(sys), r = new REF(sys); c.spu = new SPU(); r.spu = new SPU(); return [c, r]; };
const ring = s => { const o = []; for (let i = s.cdHead; i !== s.cdTail; i = (i + 1) & 0xFFFF) o.push(s.cdBufL[i], s.cdBufR[i]); return o; };
test('XA-ADPCM wasm == JS', () => {
  const [c, r] = mk();
  for (let k = 0; k < 60; k++) {
    const sec = new Uint8Array(2352); for (let i = 0; i < 2352; i++) sec[i] = ri(256);
    for (let g = 0; g < 18; g++) for (let i = 0; i < 16; i++) sec[24 + g * 128 + i] = ri(8) === 0 ? 0xFF : (ri(5) << 4) | ri(14);      // cabeçalhos: filtros 0..3(+4), ranges até 13
    const coding = ri(2) | (ri(2) << 2); c.muted = r.muted = k % 17 === 5;
    c.decodeXA(sec, coding); r.decodeXA(sec, coding);
    assert.equal(c.xaPhase, r.xaPhase, 'fase ' + k); assert.deepEqual(c.xaOld, r.xaOld, 'old ' + k);
    if (k % 7 === 6) { assert.deepEqual(ring(c.spu), ring(r.spu), 'fila ' + k); c.spu.cdHead = c.spu.cdTail; r.spu.cdHead = r.spu.cdTail; }
  }
});
test('CD-DA wasm == JS', () => {
  const [c, r] = mk();
  for (const x of [c, r]) { x.disc = { sectorCount: 1000, readSector: l => data, tracks: [{ n: 1, type: 'audio', start: 0, end: 1000 }] }; x.playing = true; x.mode = 0; }
  let data; for (let k = 0; k < 5; k++) {
    data = new Uint8Array(2352); for (let i = 0; i < 2352; i++) data[i] = ri(256);
    c.muted = r.muted = k === 3; c.pos = r.pos = k; c.playSector(); r.playSector();
  }
  assert.deepEqual(ring(c.spu), ring(r.spu));
});
test('dmaRead em bloco == byte a byte', () => {
  const [c, r] = mk(); const d = new Uint8Array(2048); for (let i = 0; i < 2048; i++) d[i] = ri(256);
  c.data = d.slice(); c.dpos = 0; r.data = d.slice(); r.dpos = 0;
  for (const n of [1, 5, 100, 400, 6]) { assert.deepEqual(c.dmaRead(n), r.dmaRead(n)); assert.equal(c.dpos, r.dpos); }
  assert.equal(c.data, r.data);
});
