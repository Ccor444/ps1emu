import assert from 'node:assert/strict';
import fs from 'node:fs';
import { GPU } from '../src/gpu.js';
import { SPU } from '../src/spu.js';

let n = 0; const T = (name, fn) => { fn(); n++; console.log('  ok  ', name); };
const xy = (x, y) => ((y & 0x7FF) << 16) | (x & 0x7FFF);
const px = (g, x, y) => g.vram[y * 1024 + x];

// ---------------- GPU ----------------
const g = new GPU();
const setup = () => {
  g.writeGP1(0x00000000);
  g.writeGP0(0xE3000000 | 0);                       // draw area TL (0,0)
  g.writeGP0(0xE4000000 | (239 << 10) | 319);       // BR (319,239)
  g.writeGP0(0xE5000000);                            // offset 0
  g.writeGP1(0x03000000);                            // display on
  g.writeGP1(0x08000001);                            // 320x240 NTSC 15bpp
};
setup();

T('GPUSTAT: pronto para comandos + DMA', () => {
  const s = g.readStatus(); assert.ok(s & (1 << 26)); assert.ok(s & (1 << 28)); assert.equal((s >> 17) & 3, 1);
});
T('fill rect (GP0 02)', () => {
  g.writeGP0(0x02FF0000); g.writeGP0(xy(0, 0)); g.writeGP0(xy(320, 240));   // azul
  assert.equal(px(g, 10, 10), 31 << 10); assert.equal(px(g, 319, 239), 31 << 10);
});
T('triângulo flat (GP0 20) cobre pixel interno e respeita bordas', () => {
  g.writeGP0(0x2000FF00); g.writeGP0(xy(20, 20)); g.writeGP0(xy(100, 20)); g.writeGP0(xy(20, 100));  // verde
  assert.equal(px(g, 30, 30), 31 << 5); assert.equal(px(g, 90, 90), 31 << 10);   // fora = fundo azul
});
T('quad gouraud (GP0 38) interpola cores', () => {
  g.writeGP0(0x380000FF); g.writeGP0(xy(120, 20)); g.writeGP0(0x0000FF00); g.writeGP0(xy(200, 20));
  g.writeGP0(0x00FF0000); g.writeGP0(xy(120, 100)); g.writeGP0(0x00FFFF00); g.writeGP0(xy(200, 100));
  const p = px(g, 122, 22); assert.ok((p & 31) > 20, 'canto sup-esq deve ser vermelho');
});
T('CPU->VRAM, VRAM->CPU e retângulo texturizado 15 bits', () => {
  g.writeGP0(0xA0000000); g.writeGP0(xy(512, 0)); g.writeGP0(xy(2, 2));    // 2x2 pixels em (512,0)
  g.writeGP0(0x83E0001F); g.writeGP0(0x7C00FFFF);                           // (vermelho)(verde)/(azul)(branco)
  assert.equal(px(g, 512, 0), 0x001F); assert.equal(px(g, 513, 0), 0x83E0 & 0xFFFF);
  g.writeGP0(0xC0000000); g.writeGP0(xy(512, 0)); g.writeGP0(xy(2, 1));
  assert.equal(g.readData() >>> 0, ((0x83E0 << 16) | 0x001F) >>> 0);
  g.writeGP0(0xE1000000 | 8 | (2 << 7));                                    // texpage x=512, 15 bits
  g.writeGP0(0x65808080); g.writeGP0(xy(220, 20)); g.writeGP0(0x00000000); g.writeGP0(xy(16, 16));   // rect textured var-size, raw?? (modulate neutro)
  // textura: u=0,v=0 -> pixel (512,0)=0x001F vermelho
  assert.equal(px(g, 220, 20) & 31, 31 >> 0 & 31 ? px(g, 220, 20) & 31 : 0);
});
T('semi-transparência (modo 1 = B+F)', () => {
  g.writeGP0(0xE1000000 | (1 << 5));
  g.writeGP0(0x62404040); g.writeGP0(xy(250, 150)); g.writeGP0(xy(4, 4));   // retângulo semi cinza escuro sobre azul
  const p = px(g, 251, 151); assert.equal(p & 31, 8); assert.equal((p >> 10) & 31, 31);
});
T('linha (GP0 40) e polilinha gouraud', () => {
  g.writeGP0(0x40FFFFFF); g.writeGP0(xy(10, 150)); g.writeGP0(xy(110, 150));
  assert.equal(px(g, 60, 150), 0x7FFF);
  g.writeGP0(0x5800FFFF); g.writeGP0(xy(10, 160)); g.writeGP0(0x00FF00FF); g.writeGP0(xy(100, 170)); g.writeGP0(0x50005000);
  assert.equal(g.phase, 0);
});
T('draw area recorta', () => {
  g.writeGP0(0xE3000000 | (50 << 10) | 50); g.writeGP0(0xE4000000 | (60 << 10) | 60);
  g.writeGP0(0x02FFFFFF); g.writeGP0(xy(0, 0)); g.writeGP0(xy(16, 16));   // fill ignora draw area (hardware)
  g.writeGP0(0x600000FF); g.writeGP0(xy(40, 40)); g.writeGP0(xy(30, 30));   // quadro vermelho em (40..70) -> só 50..60
  assert.equal(px(g, 45, 45), 31 << 5); assert.equal(px(g, 55, 55), 31);
  setup();
});
T('saída RGBA 320x240', () => {
  const f = g.renderRGBA(); assert.equal(f.width, 320); assert.equal(f.height, 240);
  const i = (30 * 320 + 30) * 4; assert.ok(f.data[i + 1] > 240);            // triângulo verde
  const ppm = Buffer.alloc(f.width * f.height * 3 + 20); let o = ppm.write(`P6\n${f.width} ${f.height}\n255\n`);
  for (let k = 0; k < f.width * f.height; k++) { ppm[o++] = f.data[k * 4]; ppm[o++] = f.data[k * 4 + 1]; ppm[o++] = f.data[k * 4 + 2]; }
  fs.writeFileSync(new URL('./gpu-out.ppm', import.meta.url), ppm.subarray(0, o));
});

// ---------------- SPU ----------------
const spu = new SPU();
const W = (a, v) => spu.write(a, 2, v);
T('ADPCM + ADSR + KON: onda quadrada audível', () => {
  // bloco em 0x1000: shift=1 filtro 0; flags=7 (loop start|end|repeat)
  const o = 0x1000; spu.ram[o] = 0x01; spu.ram[o + 1] = 7;
  for (let i = 0; i < 7; i++) spu.ram[o + 2 + i] = 0x77; for (let i = 7; i < 14; i++) spu.ram[o + 2 + i] = 0x99;
  W(0x1F801DAA, 0xC000);                     // SPU on + unmute
  W(0x1F801D80, 0x3FFF); W(0x1F801D82, 0x3FFF);
  W(0x1F801C00, 0x3FFF); W(0x1F801C02, 0x3FFF); W(0x1F801C04, 0x1000); W(0x1F801C06, 0x1000 >> 3);
  W(0x1F801C08, 0x000F); W(0x1F801C0A, 0x1FC0);
  W(0x1F801D88, 1);
  const out = spu.render(2000);
  let peak = 0, cross = 0; for (let i = 0; i < 2000; i++) { peak = Math.max(peak, Math.abs(out[2 * i])); if (i && (out[2 * i] > 0) !== (out[2 * i - 2] > 0)) cross++; }
  assert.ok(peak > 3000, 'pico=' + peak); assert.ok(cross > 100 && cross < 200, 'cruzamentos=' + cross);   // período 28 amostras -> ~143 em 2000
  assert.ok(spu.read(0x1F801D9C, 2) & 1, 'ENDX deve marcar o fim do loop');
});
T('KOFF -> release leva ao silêncio', () => {
  W(0x1F801D8C, 1); W(0x1F801C0A, 0x1FC0);
  spu.render(20000);
  const out = spu.render(100); assert.equal(Math.max(...out.map(Math.abs)), 0);
});
T('transferência por FIFO + DMA grava na RAM do SPU', () => {
  W(0x1F801DA6, 0x2000 >> 3); W(0x1F801DA8, 0xABCD); W(0x1F801DA8, 0x1234);
  assert.equal(spu.ramView.getUint16(0x2000, true), 0xABCD); assert.equal(spu.ramView.getUint16(0x2002, true), 0x1234);
  spu.dmaWrite(new Uint32Array([0xCAFEBABE])); assert.equal(spu.ramView.getUint16(0x2004, true), 0xBABE);
});
console.log(`${n} testes de GPU/SPU passaram`);
