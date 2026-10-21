// ============================================================================
//  CPU em WebAssembly (wasm/cpu.c): liga o núcleo compilado ao PSX.
//  RAM, BIOS e scratchpad passam a viver na memória linear do wasm (o JS enxerga como os mesmos Uint8Array de sempre);
//  os registradores da CPU também (cpu.r, cpu.cop0 e as propriedades pc/nextPc/cycles... viram janelas para essa memória).
//  Acessos a I/O e o GTE voltam ao JS por imports. Sem JIT: o núcleo é um interpretador compilado (sem aquecimento).
// ============================================================================
import { WASM_B64 } from './wasmbin.js';

let compiled = null;
function module_() {
  if (!compiled) {
    const bin = atob(WASM_B64), u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    compiled = new WebAssembly.Module(u8);
  }
  return compiled;
}

export function wasmAvailable() { return typeof WebAssembly === 'object' && typeof WebAssembly.Module === 'function'; }

/** troca a CPU do `psx` pelo núcleo wasm. Pode ser chamado com a máquina em qualquer estado (copia o que já existe). */
export function enableWasm(psx) {
  if (psx.wasm) return psx.wasm;
  const cpu = psx.cpu, bus = psx.bus, gte = cpu.gte;
  const memory = new WebAssembly.Memory({ initial: 64, maximum: 64 });
  const env = {
    memory,
    bread: (a, s) => { const v = bus.read(a >>> 0, s); S[7] = (bus.istat & bus.imask) !== 0 ? 1 : 0; return v | 0; },
    bwrite: (a, s, v) => { bus.write(a >>> 0, s, v >>> 0); S[7] = (bus.istat & bus.imask) !== 0 ? 1 : 0; },
  };
  const inst = new WebAssembly.Instance(module_(), { env });
  const x = inst.exports, buf = memory.buffer, P = i => x.ptr(i);
  const R = new Uint32Array(buf, P(0), 32), C0 = new Uint32Array(buf, P(1), 32), S = new Uint32Array(buf, P(2), 16), D = new Float64Array(buf, P(3), 4);
  const RAM = new Uint8Array(buf, P(4), 2 * 1024 * 1024), BIOS = new Uint8Array(buf, P(5), 512 * 1024), SCR = new Uint8Array(buf, P(6), 1024);

  // GTE: registradores na memória do wasm (o GTE em C substitui o de JS)
  const gd = new Int32Array(buf, P(7), 32), gc = new Int32Array(buf, P(8), 64), grt = new Int16Array(buf, P(9), 9), gll = new Int16Array(buf, P(10), 9), glc = new Int16Array(buf, P(11), 9);
  gd.set(gte.d); gc.set(gte.c); grt.set(gte.rt); gll.set(gte.ll); glc.set(gte.lc); const gflag = gte.flag;
  gte.d = gd; gte.c = gc; gte.rt = grt; gte.ll = gll; gte.lc = glc;
  Object.defineProperty(gte, 'flag', { get: () => S[12], set: v => { S[12] = v >>> 0; }, enumerable: true, configurable: true }); gte.flag = gflag;
  // copia o estado atual para a memória do wasm
  R.set(cpu.r); C0.set(cpu.cop0); RAM.set(bus.ram); BIOS.set(bus.bios); SCR.set(bus.scratch);
  const cur = { hi: cpu.hi, lo: cpu.lo, pc: cpu.pc, nextPc: cpu.nextPc, isBranch: cpu.isBranch, pendReg: cpu.pendReg, pendVal: cpu.pendVal, cycles: cpu.cycles, instrCount: cpu.instrCount, nextTick: psx.nextTick };
  cpu.r = R; cpu.cop0 = C0;
  bus.ram = RAM; bus.ramView = new DataView(buf, P(4), RAM.length);
  bus.bios = BIOS; bus.biosView = new DataView(buf, P(5), BIOS.length);
  bus.scratch = SCR; bus.scratchView = new DataView(buf, P(6), SCR.length);

  const u32 = (o, name, i) => Object.defineProperty(o, name, { get: () => S[i], set: v => { S[i] = v; }, enumerable: true, configurable: true });
  const bool = (o, name, i) => Object.defineProperty(o, name, { get: () => S[i] !== 0, set: v => { S[i] = v ? 1 : 0; }, enumerable: true, configurable: true });
  const f64 = (o, name, i) => Object.defineProperty(o, name, { get: () => D[i], set: v => { D[i] = v; }, enumerable: true, configurable: true });
  u32(cpu, 'hi', 0); u32(cpu, 'lo', 1); u32(cpu, 'pc', 2); u32(cpu, 'nextPc', 3); bool(cpu, 'isBranch', 4); u32(cpu, 'pendReg', 5); u32(cpu, 'pendVal', 6);
  f64(cpu, 'cycles', 0); f64(cpu, 'instrCount', 1); f64(psx, 'nextTick', 2);
  cpu.hi = cur.hi; cpu.lo = cur.lo; cpu.pc = cur.pc; cpu.nextPc = cur.nextPc; cpu.isBranch = cur.isBranch; cpu.pendReg = cur.pendReg; cpu.pendVal = cur.pendVal;
  cpu.cycles = cur.cycles; cpu.instrCount = cur.instrCount; psx.nextTick = cur.nextTick;
  S[8] = psx.hookTTY ? 1 : 0;

  psx.useJit = false; psx.jit.flush();
  const w = psx.wasm = {
    memory, exports: x, S,
    /** roda até o próximo tick; devolve 1 se parou no vetor A0/B0 (TTY) */
    run() { S[7] = (bus.istat & bus.imask) !== 0 ? 1 : 0; S[8] = psx.hookTTY ? 1 : 0; return x.run(); },
    skipHook() { S[9] = 1; },
  };
  return w;
}
