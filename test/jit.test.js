// Teste diferencial: programas MIPS aleatórios rodam no interpretador e no JIT; estados devem ser idênticos.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Bus } from '../src/bus.js';
import { CPU } from '../src/cpu.js';
import { JIT } from '../src/jit.js';

const BASE = 0x80010000, DATA = 0x80100000, END_IDX = 400;

function rng(seed) { let s = seed >>> 0; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }

// monta um programa aleatório; só branches para frente; termina em "j end"
function genProgram(seed, len) {
  const R = rng(seed), ri = n => Math.floor(R() * n), pick = a => a[ri(a.length)];
  const dst = () => 1 + ri(24), src = () => (R() < 0.1 ? 0 : 1 + ri(28));      // r1..r24 destino; fontes incluem r25..r28
  const words = [];
  const I = (op, rs, rt, imm) => ((op << 26) | (rs << 21) | (rt << 16) | (imm & 0xFFFF)) >>> 0;
  const Rr = (rs, rt, rd, sh, fn) => ((rs << 21) | (rt << 16) | (rd << 11) | (sh << 6) | fn) >>> 0;
  for (let i = 0; i < len; i++) {
    const k = ri(100);
    if (k < 28) words.push(Rr(src(), src(), dst(), 0, pick([0x21, 0x23, 0x24, 0x25, 0x26, 0x27, 0x2A, 0x2B, 0x20, 0x22])));
    else if (k < 36) words.push(Rr(0, src(), dst(), ri(32), pick([0x00, 0x02, 0x03])));
    else if (k < 40) words.push(Rr(src(), src(), dst(), 0, pick([0x04, 0x06, 0x07])));
    else if (k < 55) words.push(I(pick([0x08, 0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x0E]), src(), dst(), ri(65536)));
    else if (k < 58) words.push(I(0x0F, 0, dst(), ri(65536)));
    else if (k < 62) words.push(Rr(src(), src(), 0, 0, pick([0x18, 0x19, 0x1A, 0x1B])));
    else if (k < 65) words.push(Rr(0, 0, dst(), 0, pick([0x10, 0x12])));
    else if (k < 67) words.push(Rr(src(), 0, 0, 0, pick([0x11, 0x13])));
    else if (k < 80) {                                                         // loads (rs=r29 = base de dados)
      const op = pick([0x20, 0x21, 0x23, 0x24, 0x25, 0x22, 0x26]);
      words.push(I(op, 29, dst(), ri(0x100) - (R() < 0.05 ? 0x200 : 0)));
    } else if (k < 88) {
      const op = pick([0x28, 0x29, 0x2B, 0x2A, 0x2E]);
      words.push(I(op, 29, src(), ri(0x100)));
    } else if (k < 95) {                                                       // branch p/ frente (+ delay slot comum)
      const off = 1 + ri(5), kind = ri(7);
      if (kind < 4) words.push(I(pick([4, 5, 6, 7]), src(), kind < 2 ? src() : 0, off));
      else if (kind === 4) words.push(I(1, src(), pick([0, 1, 0x10, 0x11]), off));
      else if (kind === 5) words.push((0x03 << 26) | (((BASE >>> 2) + i + 1 + off) & 0x3FFFFFF));   // JAL pra frente
      else words.push((0x02 << 26) | (((BASE >>> 2) + i + 1 + off) & 0x3FFFFFF));                     // J
    } else if (k < 97) words.push(pick([0x0000000C, 0x0000000D]));            // SYSCALL / BREAK
    else words.push(Rr(0, 0, 0, 0, 0));                                        // nop
  }
  return words;
}

function setup(words, seed, useJit) {
  const bus = new Bus(), cpu = new CPU(bus);
  const wr = (a, w) => bus.write(a, 4, w);
  words.forEach((w, i) => wr(BASE + 4 * i, w));
  const endAddr = BASE + 4 * END_IDX;
  for (let i = 0; i < 64; i++) wr(BASE + 4 * words.length + 4 * i, 0);          // nops até o fim
  wr(endAddr, (0x02 << 26) | ((endAddr >>> 2) & 0x3FFFFFF)); wr(endAddr + 4, 0);   // j end; nop
  // handler de exceção em 0x80000080: k0=EPC; k0+=4; jr k0; rfe
  const H = 0x80000080;
  wr(H, 0x401A7000); wr(H + 4, 0);                                              // mfc0 k0,EPC ; nop
  wr(H + 8, 0x275A0004); wr(H + 12, 0x03400008); wr(H + 16, 0x42000010);        // addiu k0,k0,4 ; jr k0 ; rfe
  const R = rng(seed ^ 0xABCDEF);
  for (let i = 0; i < 0x400; i += 4) wr(DATA + i - 0x200, (R() * 4294967296) >>> 0);
  cpu.reset();
  cpu.cop0[12] = 0x40000000;                       // BEV=0, CU2, kernel, IE=0
  for (let i = 1; i < 26; i++) cpu.r[i] = (R() * 4294967296) >>> 0;
  for (let i = 25; i < 29; i++) cpu.r[i] = [0, 1, 0xFFFFFFFF, 0x80000000][i - 25];
  cpu.r[29] = DATA; cpu.r[30] = 5; cpu.r[31] = 7;
  cpu.pc = BASE; cpu.nextPc = BASE + 4;
  const jit = new JIT(cpu, bus);
  return { bus, cpu, jit, endAddr, useJit };
}

function snapshot(s) {
  const c = s.cpu;
  return { r: [...c.r], hi: c.hi, lo: c.lo, pc: c.pc, nextPc: c.nextPc, pendReg: c.pendReg, pendVal: c.pendReg ? c.pendVal >>> 0 : 0,
           cycles: c.cycles, ic: c.instrCount, c0: [c.cop0[12], c.cop0[13] & ~0x400, c.cop0[14], c.cop0[8]],
           ram: Buffer.from(s.bus.ram.buffer, 0, 0x200000).toString('hex') };
}

for (let seed = 1; seed <= 60; seed++) {
  test(`JIT == interpretador, programa aleatório #${seed}`, () => {
    const words = genProgram(seed, 300);
    const a = setup(words, seed, true), b = setup(words, seed, false);
    let guard = 0;
    while ((a.cpu.pc >>> 0) !== a.endAddr && guard++ < 200000) a.jit.exec();
    assert.ok(guard < 200000, 'JIT travou');
    const target = a.cpu.instrCount;
    guard = 0;
    while (b.cpu.instrCount < target && guard++ < 400000) b.cpu.step();
    assert.equal(b.cpu.instrCount, target, 'interpretador não alinhou a contagem de instruções');
    const sa = snapshot(a), sb = snapshot(b);
    for (const key of ['pc', 'nextPc', 'hi', 'lo', 'pendReg', 'pendVal', 'cycles', 'ic']) assert.equal(sa[key], sb[key], `${key} (seed ${seed})`);
    assert.deepEqual(sa.c0, sb.c0, 'COP0');
    assert.deepEqual(sa.r, sb.r, 'registradores');
    assert.equal(sa.ram, sb.ram, 'RAM');
  });
}

test('JIT invalida bloco quando a RAM é sobrescrita (código auto-modificável)', () => {
  const bus = new Bus(), cpu = new CPU(bus), jit = new JIT(cpu, bus);
  const P = 0x80020000;
  bus.write(P, 4, 0x24020001);          // addiu v0,zero,1
  bus.write(P + 4, 4, 0x03E00008);      // jr ra
  bus.write(P + 8, 4, 0);               // nop
  const run = () => { cpu.cop0[12] = 0; cpu.r[31] = 0x80030000; cpu.pc = P; cpu.nextPc = P + 4; cpu.isBranch = false; cpu.pendReg = 0; jit.exec(); };
  run(); assert.equal(cpu.r[2], 1);
  bus.write(P, 4, 0x24020007);          // vira addiu v0,zero,7
  run(); assert.equal(cpu.r[2], 7);
});
