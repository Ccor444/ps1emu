// Regressões descobertas com a suíte ps1-tests (hardware real): GPUSTAT/E1, GPU ocupada, duração e início de DMA
import assert from 'node:assert/strict';
import { PSX } from '../src/psx.js';
import { memCost } from '../src/cpu.js';

const tests = []; const test = (n, f) => tests.push([n, f]);
const E1 = 0x87FF;
const stat = p => p.gpu.readStatus() >>> 0;

test('E1: bits 0-10 voltam no GPUSTAT; textura=3 é preservada; bit 11 só com GP1(09)', () => {
  const g = new PSX().gpu;
  g.writeGP1((0x09 << 24) | 0); g.writeGP0(0xE1000FFF); assert.equal((g.readStatus() & E1) >>> 0, 0x7FF);
  g.writeGP1((0x09 << 24) | 1); g.writeGP0(0xE1000FFF); assert.equal((g.readStatus() & E1) >>> 0, 0x87FF);
});
test('GP1(09)=0 não apaga o bit já gravado; a próxima escrita de E1 o zera', () => {
  const g = new PSX().gpu; g.writeGP1((0x09 << 24) | 1); g.writeGP0(0xE1000800); g.writeGP1((0x09 << 24) | 0);
  assert.equal(g.readStatus() & 0x8000, 0x8000); g.writeGP0(0xE1000000); assert.equal(g.readStatus() & 0x8000, 0);
});
test('Polígono texturizado: texpage do comando altera bits 0-8 (+bit 11 se permitido), não os bits 9-10', () => {
  const g = new PSX().gpu; g.writeGP1((0x09 << 24) | 0); g.writeGP0(0xE1000000);
  for (const w of [0x2C808080, 0, 0, 0x00200000, 0x01FF0020, 0x00200000, 0x0020, 0x00200020, 0x2020]) g.writeGP0(w);
  assert.equal((g.readStatus() & E1) >>> 0, 0x1FF);
});
test('GPU ocupada: bits 26/28 caem durante o desenho e voltam depois (com relógio)', () => {
  const p = new PSX(); let t = 0; p.gpu.clock = () => t; p.gpu.writeGP1((4 << 24) | 2);
  assert.ok(stat(p) & (1 << 26)); p.gpu.writeGP0(0x60008000); p.gpu.writeGP0(0); p.gpu.writeGP0(0x00800080);   // retângulo 128x128
  assert.equal(stat(p) & (1 << 26), 0); assert.equal(stat(p) & (1 << 28), 0); assert.equal(stat(p) & (1 << 25), 0);
  t += 20000; assert.ok(stat(p) & (1 << 26)); assert.ok(stat(p) & (1 << 28));
});
test('GPU ocupada: com DMA desligada (dir 0) o bit 28 continua 1 durante o desenho', () => {
  const p = new PSX(); let t = 0; p.gpu.clock = () => t; p.gpu.writeGP1((4 << 24) | 0);
  p.gpu.writeGP0(0x60008000); p.gpu.writeGP0(0); p.gpu.writeGP0(0x00800080); assert.equal(stat(p) & (1 << 26), 0); assert.ok(stat(p) & (1 << 28));
});
test('GPU ocupada: só a parte visível do polígono conta (metade fora da tela = ~metade do custo)', () => {
  const mk = x => { const p = new PSX(); p.gpu.clock = () => 0; const g = p.gpu; g.daX1 = 0; g.daY1 = 0; g.daX2 = 319; g.daY2 = 239;
    g.writeGP0(0x28808080); for (const [a, b] of [[x, 0], [x + 128, 0], [x, 128], [x + 128, 128]]) g.writeGP0(((b & 0x7FF) << 16) | (a & 0x7FF)); return g.busyUntil; };
  const full = mk(100), half = mk(-64); assert.ok(half < full * 0.6 && half > full * 0.4, `${half} vs ${full}`);
});
test('DMA: modo 0 do GPU inicia sozinho (sem bit de trigger); OTC e PIO exigem o trigger', () => {
  const p = new PSX(), d = p.dma; d.write(0x1F8010F0, 4, 0x0B333B33 >>> 0);
  d.write(0x1F8010A0, 4, 0x1000); d.write(0x1F8010A4, 4, 4); d.write(0x1F8010A8, 4, 0x01000200 | 1);       // GPU, sync 0, da RAM
  assert.equal(d.chcr[2] & 0x01000000, 0x01000000, 'busy até finalizar'); p.sched.run(p.cpu.cycles + 1e6); assert.equal(d.chcr[2] & 0x01000000, 0);
  d.write(0x1F8010E0, 4, 0x2000); d.write(0x1F8010E4, 4, 4); d.write(0x1F8010E8, 4, 0x01000002); p.sched.run(p.cpu.cycles + 1e6);
  assert.equal(d.chcr[6] & 0x01000000, 0x01000000, 'OTC sem trigger não inicia');
});
test('DMA: duração ~ palavras + 10 ciclos por bloco (sync 1) e chopping (janela + pausa da CPU)', () => {
  const d = new PSX().dma; d.bcr[2] = (2048 << 16) | 1;
  const sync1 = d.duration(2, 2048, 0x01000201); assert.ok(sync1 > 22000 && sync1 < 23500, String(sync1));
  d.bcr[2] = 2048; const chop = d.duration(2, 2048, 0x01000001 | 0x100 | (0 << 16) | (3 << 20)); assert.ok(chop > 30000 && chop < 32000, String(chop));    // janela 1 palavra, CPU 8 clks
  assert.ok(d.duration(2, 2048, 0x01000001) < 2500);
});

test('Tempo de acesso por região e largura (ps1-tests/cpu/access-time): ciclos = 1 + custo', () => {
  assert.equal(memCost(0x80000000, 4), 4); assert.equal(memCost(0xBFC00000, 1), 6); assert.equal(memCost(0xBFC00000, 4), 24);
  assert.equal(memCost(0x1F800000, 4), 0); assert.equal(memCost(0x1F801070, 4), 2); assert.equal(memCost(0x1F801DAA, 4), 38);
  assert.equal(memCost(0x1F802000, 4), 55); assert.equal(memCost(0x1FA00000, 2), 5); assert.equal(memCost(0x1F801800, 2), 13);
});
test('Um lw da RAM custa 5 ciclos no total (igual ao medido 5,1-5,3 no console)', () => {
  const p = new PSX(), A = 0x80010000; p.bus.write32(A, 0x8C080000 | 0); p.bus.write32(A + 4, 0); p.cpu.pc = A; p.cpu.nextPc = A + 4; p.cpu.r[8] = 0x80020000; p.useJit = false;
  const c0 = p.cpu.cycles; p.cpu.step(); assert.equal(p.cpu.cycles - c0, 5);
});

let ok = 0;
for (const [n, f] of tests) { try { f(); console.log('  ok  ', n); ok++; } catch (e) { console.log('  FALHOU', n, '\n', e.stack); process.exitCode = 1; } }
console.log(`\n${ok} testes de regressão do hardware ok`);
