// 480i: o GPU só desenha as linhas do campo que NÃO está sendo exibido; o campo muda no início do vblank;
// a saída tece as linhas do campo exibido (completas) com as do campo anterior.
import assert from 'node:assert/strict';
import { GPU } from '../src/gpu.js';
import { PSX } from '../src/psx.js';
const g = new GPU(); let clk = 0; g.clock = () => clk;
g.writeGP1(0x08000025);                                   // 368 x 480 entrelaçado? (bit 2 = 480, bit 5 = interlace)
g.writeGP1(0x08000000 | (1 << 2) | (1 << 5) | (1 << 6));
assert.ok(g.interlace && g.vres, 'modo 480i');
g.writeGP0(0xE1000000); g.writeGP0(0xE3000000); g.writeGP0(0xE4000000 | (511 << 10) | 1023);   // desenhar na área de display: proibido; área de desenho = VRAM toda
const rows = () => { const r = []; for (let y = 0; y < 16; y++) r.push(g.vram[y * 1024 + 4]); return r; };
const draw = col => { g.writeGP0(0x60000000 | col); g.writeGP0(0x00000000); g.writeGP0(0x00100010); };   // retângulo 16x16 em (0,0)
for (const f of [0, 1]) {
  g.vram.fill(0); g.field = f; draw(0xFF);
  const r = rows();
  for (let y = 0; y < 16; y++) assert.equal(r[y] !== 0, (y & 1) !== f, `campo ${f}: linha ${y} ${(y & 1) === f ? 'não deve' : 'deve'} ser desenhada`);
}
g.vram.fill(0); g.field = 1; g.writeGP0(0xE1000400); draw(0xFF);        // com "desenhar na área de display" permitido: tudo
assert.ok(rows().every(v => v !== 0), 'drawToDisplay libera todas as linhas');
// campo alterna no início do vblank (não no fim do quadro)
const psx = new PSX(); psx.reset(); let pv = psx.gpu.vblank, pf = psx.gpu.field, done = false;
for (let i = 0; i < 4000000 && !done; i++) {
  psx.cpu.cycles += 64; if (psx.cpu.cycles >= psx.nextTick) psx.tick();
  if (!pv && psx.gpu.vblank) { assert.notEqual(psx.gpu.field, pf, 'o campo muda quando o vblank começa'); done = true; }
  pv = psx.gpu.vblank; pf = psx.gpu.field;
}
assert.ok(done, 'vblank alcançado');
console.log('interlace ok');
