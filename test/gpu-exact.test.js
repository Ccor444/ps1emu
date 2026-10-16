// GPU bit-exata: roda programas de teste de hardware (ps1-tests/gpu, compilados) sobre a BIOS real e compara a VRAM
// pixel a pixel com a captura feita no console de verdade (vram.png, 15 bits). Precisa de BIOS (env BIOS ou /mnt/user-data/uploads/SCPH1001.BIN).
import fs from 'node:fs';
import zlib from 'node:zlib';
import assert from 'node:assert/strict';
import { PSX } from '../src/psx.js';

const BIOS = process.env.BIOS || '/mnt/user-data/uploads/SCPH1001.BIN';
if (!fs.existsSync(BIOS)) { console.log('gpu-exact: sem BIOS, pulado'); process.exit(0); }
const bios = new Uint8Array(fs.readFileSync(BIOS));
const dir = new URL('./fixtures/gpu/', import.meta.url).pathname;

function run(name, frames, snap) {
  const psx = new PSX(); psx.onTTY = () => {};
  psx.loadBios(bios); psx.reset(); psx.bootToShell();
  const f = new Uint8Array(fs.readFileSync(dir + name + '.exe')), dv = new DataView(f.buffer, f.byteOffset), size = dv.getUint32(0x1C, true);
  psx.sideload({ pc: dv.getUint32(0x10, true), gp: dv.getUint32(0x14, true), textAddr: dv.getUint32(0x18, true), data: f.subarray(0x800, 0x800 + size), sp: dv.getUint32(0x30, true) });
  const g = psx.gpu, ow = g.writeGP0.bind(g); let drew = false, shot = null;
  if (snap) g.writeGP0 = function (w) {            // testes que limpam a tela em loop: guarda a VRAM antes do próximo "clear"
    if (g.phase === 0) { const c = w >>> 24; if (c === 2 && drew) { shot = new Uint16Array(g.vram); drew = false; } else if (c >= 0x20 && c < 0xE0) drew = true; }
    return ow(w);
  };
  for (let i = 0; i < frames; i++) psx.runFrame();
  return (snap && shot) || g.vram;
}
const ref = n => { const b = zlib.gunzipSync(fs.readFileSync(dir + n + '.ref.gz')); return new Uint16Array(b.buffer, b.byteOffset, b.length >> 1); };

// quais pixels comparar (alguns testes têm lixo de pilha / texto da fonte do SDK, que não dependem da GPU)
const all = () => true;
const cases = [
  ['quad', 200, false, all], ['texture-overflow', 200, false, all], ['transparency', 400, true, all],
  ['triangle', 200, true, all], ['uv-interpolation', 400, false, all], ['texture-flip', 400, false, all], ['clut-cache', 400, false, all],
  ['lines', 300, true, (x, y) => !(x >= 150 && x < 260 && y >= 140 && y < 180)],          // 3º segmento do multi-linha usa cor não inicializada
  ['vram-to-vram-overlap', 400, false, (x, y) => { const t = Math.floor(y / 42), i = Math.floor(x / 42); const s = [2, 8, 15, 16, 16, 16, 16][t];
    return s !== undefined && i >= 1 && i <= 21 && y >= t * 42 + 2 && y < t * 42 + s + 7 && x >= i * 42 && x < i * 42 + s + 9; }],
];
let fail = 0;
for (const [name, frames, snap, sel] of cases) {
  const got = run(name, frames, snap), exp = ref(name); let bad = 0, n = 0;
  for (let y = 0; y < 512; y++) for (let x = 0; x < 1024; x++) {
    if (!sel(x, y)) continue; n++;
    const a = got[y * 1024 + x] & 0x7FFF, b = exp[y * 1024 + x] & 0x7FFF;
    if (a !== b) bad++;
  }
  try { assert.equal(bad, 0, `${name}: ${bad} pixels diferentes de ${n}`); console.log(`ok - gpu exata: ${name} (${n} pixels)`); }
  catch (e) { fail++; console.log(`FALHA - ${e.message}`); }
}
process.exitCode = fail ? 1 : 0;
