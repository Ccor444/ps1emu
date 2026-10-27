// Teste diferencial dos laços internos / chamadas embutidas do JIT: programas com laços para trás (bne/beq/j para o início do bloco),
// sub-rotinas folha (jal ... jr $ra) e retorno alterado ($ra modificado). JIT (com saídas forçadas no meio dos laços) == interpretador.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Bus } from '../src/bus.js';
import { CPU } from '../src/cpu.js';
import { JIT } from '../src/jit.js';

const BASE = 0x80010000, DATA = 0x80100000, FN = BASE + 0x2000, END = BASE + 0x1000;
const rng = seed => { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; };
const I = (op, rs, rt, imm) => ((op << 26) | (rs << 21) | (rt << 16) | (imm & 0xFFFF)) >>> 0;
const Rr = (rs, rt, rd, sh, fn) => ((rs << 21) | (rt << 16) | (rd << 11) | (sh << 6) | fn) >>> 0;
const J = (op, a) => ((op << 26) | ((a >>> 2) & 0x3FFFFFF)) >>> 0;

function build(seed) {
  const R = rng(seed), ri = n => Math.floor(R() * n), pick = a => a[ri(a.length)];
  const reg = () => 1 + ri(14);                                              // r1..r14 (r20/r21 = contadores, r29 = dados)
  const op = () => {                                                         // uma instrução comum, sem desvios
    const k = ri(10);
    if (k < 5) return Rr(reg(), reg(), reg(), 0, pick([0x21, 0x23, 0x24, 0x25, 0x26, 0x27, 0x2A, 0x2B]));
    if (k < 7) return I(pick([0x08, 0x09, 0x0C, 0x0D, 0x0E, 0x0A, 0x0B]), reg(), reg(), ri(65536));
    if (k < 8) return Rr(0, reg(), reg(), ri(32), pick([0x00, 0x02, 0x03]));
    if (k < 9) return I(pick([0x23, 0x21, 0x25, 0x24, 0x20]), 29, reg(), ri(0x40) * 4);
    return I(pick([0x2B, 0x29, 0x28]), 29, reg(), ri(0x40) * 4);
  };
  const main = [], fns = [], fnAddr = [];
  const nFn = 3;
  for (let f = 0; f < nFn; f++) {                                            // sub-rotinas folha; a última altera $ra (retorno +8)
    fnAddr.push(FN + 4 * fns.length);
    const n = 2 + ri(6); for (let i = 0; i < n; i++) fns.push(op());
    if (f === nFn - 1) fns.push(I(0x09, 31, 31, 8));                         // addiu ra,ra,8
    fns.push(Rr(31, 0, 0, 0, 0x08), op());                                   // jr ra ; delay
  }
  const segs = 6 + ri(6);
  for (let s = 0; s < segs; s++) {
    const kind = ri(6), n = 2 + ri(14);
    if (kind === 0) { const m = 2 + ri(5); for (let i = 0; i < m; i++) main.push(op()); }
    else if (kind === 1 || kind === 2) {                                     // laço com contador: L: corpo ; addiu ; bne L ; delay
      main.push(I(0x09, 0, 20, n));
      const L = BASE + 4 * main.length, body = 2 + ri(6);
      for (let i = 0; i < body; i++) main.push(op());
      if (kind === 2) main.push(J(3, fnAddr[ri(2)]), op());                  // laço com chamada (como um laço de espera)
      main.push(I(0x09, 20, 20, -1));
      const here = BASE + 4 * main.length; main.push(I(5, 20, 0, ((L - (here + 4)) >> 2) & 0xFFFF), R() < 0.5 ? 0 : op());
    } else if (kind === 3) {                                                 // laço com saída no topo e j para o início
      main.push(I(0x09, 0, 21, 1 + ri(9)));
      const L = BASE + 4 * main.length;
      main.push(I(0x09, 21, 21, -1));
      const here = BASE + 4 * main.length; main.push(I(4, 21, 0, 0), 0);      // beq r21,zero,EXIT (ajustado abaixo)
      const body = 1 + ri(5); for (let i = 0; i < body; i++) main.push(op());
      main.push(J(2, L), op());
      const exit = BASE + 4 * main.length;
      main[(here - BASE) / 4] = I(4, 21, 0, ((exit - (here + 4)) >> 2) & 0xFFFF);
    } else if (kind === 4) { main.push(J(3, fnAddr[ri(2)]), op()); for (let i = 0; i < 2; i++) main.push(op()); }     // chamada simples
    else { main.push(J(3, fnAddr[nFn - 1]), op(), I(0x09, 0, 1, 0x1111), I(0x09, 0, 2, 0x2222)); }                    // retorno alterado: pula os 2 addiu
  }
  return { main, fns };
}

function setup(p, seed) {
  const bus = new Bus(), cpu = new CPU(bus), wr = (a, w) => bus.write(a, 4, w);
  p.main.forEach((w, i) => wr(BASE + 4 * i, w));
  wr(BASE + 4 * p.main.length, J(2, END)); wr(BASE + 4 * p.main.length + 4, 0);
  wr(END, J(2, END)); wr(END + 4, 0);
  p.fns.forEach((w, i) => wr(FN + 4 * i, w));
  const H = 0x80000080; wr(H, 0x401A7000); wr(H + 4, 0); wr(H + 8, 0x275A0004); wr(H + 12, 0x03400008); wr(H + 16, 0x42000010);
  const R = rng(seed ^ 0x5151); for (let i = 0; i < 0x400; i += 4) wr(DATA + i, (R() * 4294967296) >>> 0);
  cpu.reset(); cpu.cop0[12] = 0x40000000;
  for (let i = 1; i < 16; i++) cpu.r[i] = (R() * 4294967296) >>> 0;
  cpu.r[29] = DATA; cpu.pc = BASE; cpu.nextPc = BASE + 4;
  return { bus, cpu, jit: new JIT(cpu, bus) };
}

const TOTAL = { loops: 0, inlined: 0 };
for (let seed = 1; seed <= 60; seed++) {
  test(`JIT laços/chamadas == interpretador, programa #${seed}`, () => {
    const p = build(seed), a = setup(p, seed), b = setup(p, seed), rr = rng(seed * 77);
    let guard = 0;
    while ((a.cpu.pc >>> 0) !== END && guard++ < 400000) { a.jit.H.ps.nextTick = a.cpu.cycles + 3 + Math.floor(rr() * 120); a.jit.exec(); }
    assert.ok(guard < 400000, 'JIT travou');
    const target = a.cpu.instrCount; guard = 0;
    while (b.cpu.instrCount < target && guard++ < 4000000) b.cpu.step();
    assert.equal(b.cpu.instrCount, target, 'contagem de instruções');
    for (const k of ['pc', 'nextPc', 'hi', 'lo', 'pendReg', 'cycles']) assert.equal(a.cpu[k], b.cpu[k], `${k} (seed ${seed})`);
    assert.deepEqual([...a.cpu.r], [...b.cpu.r], 'registradores');
    assert.equal(Buffer.from(a.bus.ram.buffer, 0, 0x200000).toString('hex'), Buffer.from(b.bus.ram.buffer, 0, 0x200000).toString('hex'), 'RAM');
    assert.ok(a.jit.stats.compiled > 0);
    TOTAL.loops += a.jit.stats.loops; TOTAL.inlined += a.jit.stats.inlined;
  });
}

test('os testes de laço realmente geraram laços internos e chamadas embutidas', () => { assert.ok(TOTAL.loops > 20, 'laços: ' + TOTAL.loops); assert.ok(TOTAL.inlined > 20, 'embutidas: ' + TOTAL.inlined); });
