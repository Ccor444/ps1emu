// CPU em WebAssembly (BLOCOS) x interpretador JS: programas aleatórios (ALU, desvios, load/store, HI/LO, COP0, exceções) devem dar o MESMO estado, ciclo a ciclo.
delete process.env.PS1_WASMJIT; globalThis.PS1_WASMJIT = 1;   // blocos pré-decodificados ligados já na 1ª entrada: compara com o interpretador JS ciclo a ciclo
import assert from 'node:assert/strict';
import { PSX } from '../src/psx.js';

let seed = 12345; const rnd = n => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return (seed >>> 8) % n; };
const SPECIAL = [0, 2, 3, 4, 6, 7, 0x10, 0x11, 0x12, 0x13, 0x18, 0x19, 0x1A, 0x1B, 0x20, 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x2A, 0x2B, 0x0C, 0x0D, 0x08, 0x09];
const IMM = [8, 9, 0x0A, 0x0B, 0x0C, 0x0D, 0x0E, 0x0F];
const MEM = [0x20, 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x28, 0x29, 0x2A, 0x2B, 0x2E];
function word() {
  const k = rnd(10), rs = 1 + rnd(7), rt = 1 + rnd(7), rd = 1 + rnd(7);
  if (k < 4) return ((rs << 21) | (rt << 16) | (rd << 11) | (rnd(32) << 6) | SPECIAL[rnd(SPECIAL.length)]) >>> 0;
  if (k < 6) return ((IMM[rnd(IMM.length)] << 26) | (rs << 21) | (rt << 16) | rnd(65536)) >>> 0;
  if (k < 8) return rnd(4) === 0 ? ((MEM[rnd(MEM.length)] << 26) | (30 << 21) | (rt << 16) | rnd(1600)) >>> 0 : ((MEM[rnd(MEM.length)] << 26) | (29 << 21) | (rt << 16) | rnd(256)) >>> 0;          // base fixo ($sp) -> RAM
  if (k === 9 && rnd(2)) {                                                                                   // COP2 (GTE): comandos e transferências
    const q = rnd(6);
    if (q < 2) return ((0x12 << 26) | (1 << 25) | (rnd(2) << 19) | (rnd(2) << 10) | (rnd(4) << 17) | (rnd(4) << 15) | (rnd(4) << 13) | [1, 0x30, 6, 0x0C, 0x10, 0x2A, 0x11, 0x12, 0x13, 0x16, 0x1B, 0x3F, 0x1E, 0x20, 0x14, 0x1C, 0x29, 0x28, 0x2D, 0x2E, 0x3D, 0x3E][rnd(22)]) >>> 0;
    if (q < 4) return ((0x12 << 26) | ([0, 2, 4, 6][rnd(4)] << 21) | (rt << 16) | (rnd(32) << 11)) >>> 0;
    return (((q === 4 ? 0x32 : 0x3A) << 26) | (29 << 21) | (rnd(32) << 16) | (rnd(64) * 4)) >>> 0;
  }
  if (k === 8) return (((4 + rnd(4)) << 26) | (rs << 21) | (rt << 16) | (rnd(8) - 2 & 0xFFFF)) >>> 0;       // desvios curtos
  return ((0x10 << 26) | ((rnd(2) ? 0 : 4) << 21) | (rt << 16) | (rnd(16) << 11)) >>> 0;                   // MFC0/MTC0
}
function mk(wasm, prog) {
  const p = new PSX(); const c = p.cpu;
  if (wasm) assert.ok(p.enableWasm(), 'wasm indisponível');
  p.useJit = false; p.hookTTY = false;
  for (let i = 0; i < prog.length; i++) p.bus.write(0x80010000 + i * 4, 4, prog[i]);
  for (let i = 0; i < 64; i++) p.bus.write(0x80000080 + i * 4, 4, 0x42424242 + i);     // handler: lixo -> RI em laço (cobre exceção em exceção)
  c.cop0[12] = 0x40000000; c.pc = 0x80010000; c.nextPc = 0x80010004; c.r[29] = 0x80100000; c.r[30] = 0x80010000 + ((prog[3] & 1) ? 0x20000000 : 0);
  for (let i = 1; i < 8; i++) c.r[i] = (Math.imul(i, 0x9E3779B1) ^ 0x1234567) >>> 0;
  p.nextTick = 1e12;
  return p;
}
const sig = p => [p.cpu.pc, p.cpu.nextPc, p.cpu.cycles, p.cpu.instrCount, p.cpu.hi, p.cpu.lo, p.cpu.pendReg, p.cpu.pendVal >>> 0, p.cpu.isBranch, ...p.cpu.r, ...p.cpu.cop0, ...p.cpu.gte.d, ...p.cpu.gte.c, p.cpu.gte.flag].join(',');
let total = 0, stats = 0, fl = 0;
for (let round = 0; round < 200; round++) {
  const prog = []; for (let i = 0; i < 400; i++) prog.push(word());
  prog.push(((2 << 26) | (0x10000 >> 2)) >>> 0, 0);   // j início: laço (os blocos só ficam quentes em laços)
  const a = mk(false, prog), b = mk(true, prog);
  const n = 6000;
  for (let i = 0; i < n; i++) a.cpu.step();
  b.nextTick = b.cpu.cycles + (a.cpu.cycles - b.cpu.cycles);       // roda o mesmo nº de ciclos
  b.wasm.run();
  const ram = (x) => Buffer.from(x.bus.ram.subarray(0x10000, 0x110000 + 0x1000)).toString('hex');
  assert.equal(sig(b), sig(a), 'estado da CPU diverge na rodada ' + round);
  assert.equal(ram(b), ram(a), 'RAM diverge na rodada ' + round);
  total += n; stats = (stats || 0) + a.cpu.gte.commandCount; fl = (fl || 0) + (a.cpu.gte.flag ? 1 : 0);
}
console.log(`wasm == interpretador em ${total} instruções aleatórias (200 programas; ${stats} comandos GTE, flags em ${fl} programas)`);
