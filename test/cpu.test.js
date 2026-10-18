import assert from 'node:assert/strict';
import { PSX } from '../src/psx.js';

// mini-assembler
const Rt = (rs, rt, rd, sh, f) => ((rs << 21) | (rt << 16) | (rd << 11) | (sh << 6) | f) >>> 0;
const It = (op, rs, rt, imm) => ((op << 26) | (rs << 21) | (rt << 16) | (imm & 0xFFFF)) >>> 0;
const A = {
  addiu: (rt, rs, i) => It(9, rs, rt, i), lui: (rt, i) => It(15, 0, rt, i), ori: (rt, rs, i) => It(13, rs, rt, i),
  lw: (rt, o, rs) => It(0x23, rs, rt, o), sw: (rt, o, rs) => It(0x2B, rs, rt, o), lwl: (rt, o, rs) => It(0x22, rs, rt, o), lwr: (rt, o, rs) => It(0x26, rs, rt, o),
  addu: (rd, rs, rt) => Rt(rs, rt, rd, 0, 0x21), add: (rd, rs, rt) => Rt(rs, rt, rd, 0, 0x20), beq: (rs, rt, o) => It(4, rs, rt, o),
  mult: (rs, rt) => Rt(rs, rt, 0, 0, 0x18), multu: (rs, rt) => Rt(rs, rt, 0, 0, 0x19), div: (rs, rt) => Rt(rs, rt, 0, 0, 0x1A),
  mflo: rd => Rt(0, 0, rd, 0, 0x12), mfhi: rd => Rt(0, 0, rd, 0, 0x10), syscall: () => 0x0C, jal: t => ((3 << 26) | ((t >>> 2) & 0x3FFFFFF)) >>> 0,
  lw_bad: () => It(0x23, 8, 9, 1), nop: () => 0,
};
const [t0, t1, t2, t3, t4] = [8, 9, 10, 11, 12];
const li = (r, v) => [A.lui(r, v >>> 16), A.ori(r, r, v & 0xFFFF)];

function run(prog, setup) {
  const psx = new PSX(); const cpu = psx.cpu, base = 0x80010000;
  cpu.cop0[12] = 0;                                  // BEV=0 -> handler em 0x80000080
  prog.forEach((w, i) => psx.bus.write32(base + i * 4, w));
  psx.bus.write32(0x80020000, 0x44332211); psx.bus.write32(0x80020004, 0x88776655);
  cpu.pc = base; cpu.nextPc = base + 4;
  setup?.(cpu);
  for (let i = 0; i < prog.length; i++) cpu.step();
  return cpu;
}
let n = 0; const T = (name, fn) => { fn(); n++; console.log('  ok  ', name); };

T('load delay slot enxerga valor antigo', () => {
  const c = run([...li(t1, 0x80020000), A.addiu(t0, 0, 1), A.lw(t0, 0, t1), A.addu(t2, t0, 0), A.addu(t3, t0, 0)]);
  assert.equal(c.r[t2], 1); assert.equal(c.r[t3], 0x44332211);
});
T('escrita no delay slot cancela a carga', () => {
  const c = run([...li(t1, 0x80020000), A.lw(t0, 0, t1), A.addiu(t0, 0, 7), A.nop()]);
  assert.equal(c.r[t0], 7);
});
T('branch delay slot executa e pula', () => {
  const c = run([A.beq(0, 0, 2), A.addiu(t0, 0, 1), A.addiu(t0, 0, 2), A.addiu(t1, 0, 3)].concat([A.nop()]));
  assert.equal(c.r[t0], 1); assert.equal(c.r[t1], 3);
});
T('LWR+LWL: leitura desalinhada com forwarding', () => {
  const c = run([...li(t1, 0x80020000), A.lwr(t0, 1, t1), A.lwl(t0, 4, t1), A.nop()]);
  assert.equal(c.r[t0], 0x55443322);
});
T('MULTU 0xFFFFFFFF^2', () => {
  const c = run([...li(t0, 0xFFFFFFFF), A.multu(t0, t0), A.mfhi(t1), A.mflo(t2)]);
  assert.equal(c.r[t1], 0xFFFFFFFE); assert.equal(c.r[t2], 1);
});
T('MULT com sinais e 0x7FFFFFFF^2', () => {
  let c = run([...li(t0, 0xFFFFFFFF), A.mult(t0, t0), A.mfhi(t1), A.mflo(t2)]);
  assert.equal(c.r[t1], 0); assert.equal(c.r[t2], 1);
  c = run([...li(t0, 0x7FFFFFFF), A.mult(t0, t0), A.mfhi(t1), A.mflo(t2)]);
  assert.equal(c.r[t1], 0x3FFFFFFF); assert.equal(c.r[t2], 1);
  c = run([...li(t0, 0x80000000), ...li(t3, 2), A.mult(t0, t3), A.mfhi(t1), A.mflo(t2)]);   // -2^31 * 2 = -2^32
  assert.equal(c.r[t1], 0xFFFFFFFF); assert.equal(c.r[t2], 0);
});
T('DIV: -7/2 e divisão por zero', () => {
  let c = run([...li(t0, 0xFFFFFFF9), ...li(t3, 2), A.div(t0, t3), A.mflo(t1), A.mfhi(t2)]);
  assert.equal(c.r[t1], 0xFFFFFFFD); assert.equal(c.r[t2], 0xFFFFFFFF);
  c = run([...li(t0, 5), A.div(t0, 0), A.mflo(t1), A.mfhi(t2)]);
  assert.equal(c.r[t1], 0xFFFFFFFF); assert.equal(c.r[t2], 5);
});
T('ADD overflow gera exceção (code 12) e não escreve', () => {
  const c = run([...li(t0, 0x7FFFFFFF), A.addiu(t1, 0, 1), A.add(t2, t0, t1)]);
  assert.equal((c.cop0[13] >> 2) & 31, 12); assert.equal(c.r[t2], 0);
  assert.equal(c.pc, 0x80000080); assert.equal(c.cop0[14], 0x8001000C);
});
T('SYSCALL no delay slot: EPC = branch, BD=1', () => {
  const c = run([A.beq(0, 0, 4), A.syscall()]);
  assert.equal((c.cop0[13] >>> 31), 1); assert.equal(c.cop0[14], 0x80010000);
});
T('lw desalinhado -> AdEL + BadVAddr', () => {
  const c = run([...li(t0, 0x80020000), A.lw_bad()]);
  assert.equal((c.cop0[13] >> 2) & 31, 4); assert.equal(c.cop0[8], 0x80020001);
});
T('JAL grava $ra = PC+8', () => {
  const c = run([A.jal(0x80010100), A.nop()]);
  assert.equal(c.r[31], 0x80010008); assert.equal(c.pc, 0x80010100);
});
T('cache isolado: escrita não vai pra RAM', () => {
  const c = run([...li(t0, 0x80020100), ...li(t1, 0xDEAD), A.sw(t1, 0, t0)], cpu => { cpu.cop0[12] = 0x10000; });
  assert.equal(c.bus.read32(0x80020100), 0);
});
console.log(`${n} testes de CPU passaram`);
