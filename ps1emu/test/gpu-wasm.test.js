// Rasterizador em WebAssembly x rasterizador em JS: o mesmo fluxo aleatório de comandos GP0 (polígonos de todos os tipos, retângulos,
// linhas/polilinhas, fill, cópias, janela de textura, máscara, dither, semi-transparência, 480i) tem de dar a MESMA VRAM, bit a bit.
import assert from 'node:assert/strict';
import { GPU } from '../src/gpu.js';
const A = new GPU(), B = new GPU(); assert.ok(B.enableWasmRaster(), 'wasm indisponível');
let seed = +process.env.GW_SEED || 20241021; const rnd = n => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return (seed >>> 8) % n; };
const w = x => { A.writeGP0(x >>> 0); B.writeGP0(x >>> 0); };
const g1 = x => { A.writeGP1(x >>> 0); B.writeGP1(x >>> 0); };
const pos = (x, y) => ((y & 0x7FF) << 16) | (x & 0x7FF);
const coord = () => rnd(7) === 0 ? rnd(2000) - 500 : rnd(420);
const col = () => (rnd(256) | (rnd(256) << 8) | (rnd(256) << 16)) >>> 0;
function upload(x, y, cw, ch) { w(0xA0000000); w(pos(x, y)); w((ch << 16) | cw); const n = (cw * ch + 1) >> 1; for (let i = 0; i < n; i++) w((rnd(65536) | (rnd(65536) << 16)) >>> 0 ^ (rnd(3) === 0 ? 0 : 0)); }
// VRAM inicial: ruído com muitos zeros (texels transparentes) e bits de máscara
for (let k = 0; k < 8; k++) { w(0xA0000000); w(pos((k & 3) * 256, (k >> 2) * 256)); w((256 << 16) | 256); for (let i = 0; i < 32768; i++) { const a = rnd(5) === 0 ? 0 : rnd(65536), b = rnd(5) === 0 ? 0 : rnd(65536); w((a | (b << 16)) >>> 0); } }
let cmds = 0;
const ROUNDS = +process.env.GW_ROUNDS || 60;
for (let round = 0; round < ROUNDS; round++) {
  const inter = rnd(3) === 0;
  g1(0x08000000 | (rnd(4)) | (inter ? (1 << 2) | (1 << 5) : 0) | (rnd(5) === 0 ? 1 << 4 : 0)); g1(0x05000000 | (rnd(500) & ~1) | (rnd(100) << 10)); g1(0x03000000 | (rnd(8) === 0 ? 1 : 0)); g1(0x07000000 | (16 | (16 + (rnd(2) ? 240 : 120)) << 10)); if (inter) { const f = rnd(2); A.field = f; B.field = f; }
  w(0xE1000000 | rnd(4096) | (rnd(4) << 5 & 0) | ((rnd(4)) << 7) | (rnd(2) << 9) | (rnd(2) << 10) | (rnd(2) << 12) | (rnd(2) << 13));
  { const tp = rnd(16) | (rnd(2) << 4) | (rnd(4) << 5) | (rnd(4) << 7) | (rnd(2) << 9); w(0xE1000000 | tp | (rnd(2) << 10) | (rnd(2) << 12) | (rnd(2) << 13)); }
  w(0xE2000000 | (rnd(3) === 0 ? rnd(1 << 20) : 0));
  w(0xE3000000 | (rnd(3) === 0 ? 0 : (rnd(200) | (rnd(100) << 10)))); w(0xE4000000 | ((200 + rnd(300)) | ((100 + rnd(300)) << 10)));
  w(0xE5000000 | (rnd(80) | (rnd(80) << 11)) | (rnd(5) === 0 ? 0x400 : 0));
  w(0xE6000000 | rnd(4));
  for (let n = 0; n < 40; n++) {
    const k = rnd(10); cmds++;
    if (k < 4) {                                              // polígono: cmd 0x20..0x3F
      const c = 0x20 + rnd(32), quad = !!(c & 8), tex = !!(c & 4), gour = !!(c & 0x10), nv = quad ? 4 : 3;
      w(((c << 24) | col()) >>> 0);
      for (let v = 0; v < nv; v++) {
        if (gour && v > 0) w(col());
        w(pos(coord(), coord()));
        if (tex) { const uv = rnd(65536); let hi = 0; if (v === 0) hi = rnd(64) | (rnd(512) << 6); if (v === 1) hi = rnd(16) | (rnd(2) << 4) | (rnd(4) << 5) | (rnd(3) << 7) | (rnd(2) << 11); w(((hi << 16) | uv) >>> 0); }
      }
    } else if (k < 6) {                                       // retângulo 0x60..0x7F
      const c = 0x60 + rnd(32), tex = !!(c & 4), sz = (c >> 3) & 3;
      w(((c << 24) | col()) >>> 0); w(pos(coord(), coord()));
      if (tex) w(((rnd(64) | (rnd(512) << 6)) << 16 | rnd(65536)) >>> 0);
      if (sz === 0) w(((rnd(40) << 16) | rnd(70)) >>> 0);
    } else if (k === 6) {                                     // linha / polilinha 0x40..0x5F
      const c = 0x40 + rnd(32), gour = !!(c & 0x10), poly = !!(c & 8);
      w(((c << 24) | col()) >>> 0); w(pos(coord(), coord())); if (gour) w(col()); w(pos(coord(), coord()));
      if (poly) { const m = rnd(4); for (let i = 0; i < m; i++) { if (gour) w(col()); w(pos(coord(), coord())); } w(0x55555555); }
    } else if (k === 7) {                                     // fill
      w(((0x02 << 24) | col()) >>> 0); w((rnd(60) << 16) | rnd(300)); w(((rnd(40) + 1) << 16) | (rnd(80) + 1));
    } else if (k === 8) {                                     // cópia VRAM->VRAM
      w(0x80000000); w(pos(rnd(1024), rnd(512))); w(pos(rnd(1024), rnd(512))); w(((rnd(30) + 1) << 16) | (rnd(60) + 1));
    } else upload(rnd(900), rnd(450), 1 + rnd(40), 1 + rnd(20));   // upload (também com máscara/checkMask)
  }
  for (const f of [0, 1, 0]) {                                  // saída de vídeo: captura de campo + conversão RGBA nos 3 modos de desentrelaçamento
    A.field = f; B.field = f; A.captureField(); B.captureField();
    for (const d of [0, 1, 2]) { A.deint = d; B.deint = d; const ra = A.renderRGBA(), rb = B.renderRGBA(); assert.equal(rb.width, ra.width); assert.equal(rb.height, ra.height); assert.ok(Buffer.from(rb.data.buffer, rb.data.byteOffset, rb.data.length).equals(Buffer.from(ra.data.buffer, ra.data.byteOffset, ra.data.length)), `RGBA diverge (rodada ${round}, campo ${f}, deint ${d})`); }
    // um pouco de movimento entre campos
    w(((0x60 << 24) | col()) >>> 0); w(pos(rnd(300), rnd(300))); w(((rnd(60) + 1) << 16) | (rnd(60) + 1));
  }
  assert.deepEqual(Buffer.from(B.vram.buffer, B.vram.byteOffset, B.vram.byteLength), Buffer.from(A.vram.buffer, A.vram.byteOffset, A.vram.byteLength), 'VRAM diverge na rodada ' + round);
}
console.log(`GPU wasm == GPU js em ${cmds} comandos aleatórios (${ROUNDS} rodadas, VRAM idêntica)`);
// sanidade: o teste realmente desenhou (a VRAM mudou muito em relação ao ruído inicial) 
assert.ok(B.vram.reduce((a, v) => a + (v & 0x8000 ? 1 : 0), 0) > 1000, 'a VRAM tem bits de máscara (desenho/uploads ocorreram)');
