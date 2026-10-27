// ============================================================================
//  CPU em WebAssembly (wasm/cpu.c): liga o núcleo compilado ao PSX.
//  RAM, BIOS e scratchpad passam a viver na memória linear do wasm (o JS enxerga como os mesmos Uint8Array de sempre);
//  os registradores da CPU também (cpu.r, cpu.cop0 e as propriedades pc/nextPc/cycles... viram janelas para essa memória).
//  Acessos a I/O e o GTE voltam ao JS por imports. Sem JIT: o núcleo é um interpretador compilado (sem aquecimento).
// ============================================================================
import { WASM_B64 } from './wasmbin.js';
import { enableWasmMdec } from './wasmmdec.js';

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
  const memory = new WebAssembly.Memory({ initial: 160, maximum: 160 });
  const st = { n: 0, io: 0, run: 0, tick: 0, cat: new Uint32Array(20), ar: new Uint32Array(2048), aw: new Uint32Array(2048) };
  // custo de uma leitura do relógio (o diagnóstico de E/S mede 1 acesso a cada 32; sem descontar isso o tempo de E/S sai inflado)
  let nowCost = 0; { let a = performance.now(), b = a, k = 0; while (b - a < 2 && k < 20000) { b = performance.now(); k++; } nowCost = k > 1 ? (b - a) / k : 0; }
  const ioCat = a => { const p = a & 0x1FFFFFFF; return p >= 0x1F801C00 && p < 0x1F802000 ? 1 : p >= 0x1F801810 && p < 0x1F801818 ? 0 : p >= 0x1F801100 && p < 0x1F801130 ? 2 : p >= 0x1F801070 && p < 0x1F801078 ? 3 : p >= 0x1F801080 && p < 0x1F801100 ? 4 : p >= 0x1F801800 && p < 0x1F801804 ? 5 : p >= 0x1F801040 && p < 0x1F801050 ? 6 : p >= 0x1F801820 && p < 0x1F801828 ? 7 : 8; };
  const env = {
    memory,
    // diagnóstico: conta os acessos que voltam ao JS e mede 1 a cada 32 (performance.now a cada acesso distorceria)
    bread: (a, s) => { let t0 = 0; st.cat[ioCat(a)]++; st.ar[(a >>> 2) & 2047]++; if ((++st.n & 31) === 0) t0 = performance.now(); const v = bus.read(a >>> 0, s); S[7] = (bus.istat & bus.imask) !== 0 ? 1 : 0; if (t0) st.io += Math.max(0, performance.now() - t0 - nowCost) * 32; return v | 0; },
    bwrite: (a, s, v) => { let t0 = 0; st.cat[10 + ioCat(a)]++; st.aw[(a >>> 2) & 2047]++; if ((++st.n & 31) === 0) t0 = performance.now(); bus.write(a >>> 0, s, v >>> 0); S[7] = (bus.istat & bus.imask) !== 0 ? 1 : 0; if (t0) st.io += Math.max(0, performance.now() - t0 - nowCost) * 32; },
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

  // blocos pré-decodificados dentro do próprio núcleo (wasm/blk.c). Limiar de "calor" = PS1_WASMJIT (0 desliga; padrão 2)
  const cf = new Uint8Array(buf, P(15), 32768); bus.codeFlags = cf;
  bus.onCodeWrite = o => x.blk_inval(o >>> 6);
  const envThr = (typeof process !== 'undefined' && process.env && process.env.PS1_WASMJIT !== undefined) ? +process.env.PS1_WASMJIT : (globalThis.PS1_WASMJIT ?? 2);
  S[15] = Math.min(255, envThr | 0);
  psx.useJit = false; psx.jit.flush();
  { const f0 = psx.jit.flush.bind(psx.jit); psx.jit.flush = () => { f0(); x.blk_flush(); }; }
  // E/S servida dentro do wasm: GPUSTAT e I_STAT/I_MASK (laços de espera leem isso milhares de vezes por quadro). I_STAT/I_MASK passam a viver na memória do wasm;
  // a parte estática do GPUSTAT é publicada pelo gpu.js em GF[16..21] (GF[21] = válido; qualquer mudança do estado da GPU invalida) e busyUntil também fica compartilhado.
  const GF = new Int32Array(buf, P(16), 32), GDd = new Float64Array(buf, P(17), 2), IR = new Uint32Array(buf, P(19), 2);
  IR[0] = bus.istat; IR[1] = bus.imask;
  {   // contadores dos timers (e timerAt/dotDiv) vivem na memória do wasm: o núcleo lê o contador sem ir ao JS (timerPeek); o JS continua enxergando as mesmas propriedades
    const TM = new Float64Array(buf, P(20), 32), tm = psx.timers; TM[24] = psx.timerAt; TM[25] = tm.dotDiv;
    tm.t.forEach((t, n) => { const o = n * 4, v = [t.counter, t.mode, t.target, t.frac]; ['counter', 'mode', 'target', 'frac'].forEach((k, j) => { TM[o + j] = v[j]; Object.defineProperty(t, k, { get: () => TM[o + j], set: z => { TM[o + j] = z; }, enumerable: true, configurable: true }); }); });
    Object.defineProperty(psx, 'timerAt', { get: () => TM[24], set: z => { TM[24] = z; }, enumerable: true, configurable: true });
    Object.defineProperty(tm, 'dotDiv', { get: () => TM[25], set: z => { TM[25] = z; }, enumerable: true, configurable: true });
  }
  Object.defineProperty(bus, 'istat', { get: () => IR[0], set: v => { IR[0] = v; }, enumerable: true, configurable: true });
  Object.defineProperty(bus, 'imask', { get: () => IR[1], set: v => { IR[1] = v; }, enumerable: true, configurable: true });
  { const po = bus.pollOn; Object.defineProperty(bus, 'pollOn', { get: () => GF[22] !== 0, set: v => { GF[22] = v ? 1 : 0; }, enumerable: true, configurable: true }); bus.pollOn = po; }
  { const g = psx.gpu, bu = g.busyUntil; Object.defineProperty(g, 'busyUntil', { get: () => GDd[1], set: v => { GDd[1] = v; }, enumerable: true, configurable: true }); g.busyUntil = bu; g.sh = GF; GF[21] = 0; }
  if (!((typeof process !== 'undefined' && process.env && process.env.PS1_WASMMDEC === '0') || globalThis.PS1_WASMMDEC === 0)) enableWasmMdec(psx, x, buf);   // MDEC em C (PS1_WASMMDEC=0 desliga)
  // front-end do GP0 (modo GPU em Worker): PS1_WASMGPF=0 desliga
  { const off = (typeof process !== 'undefined' && process.env && process.env.PS1_WASMGPF === '0') || globalThis.PS1_WASMGPF === 0;
    if (!off) psx.dma.gpf = { x, P: new Int32Array(buf, P(16), 32), D: new Float64Array(buf, P(17), 2), q: new Uint32Array(buf, P(18), 65536) }; }
  const w = psx.wasm = {
    memory, exports: x, S, st,
    /** roda até o próximo tick; devolve 1 se parou no vetor A0/B0 (TTY) */
    run() { S[7] = (bus.istat & bus.imask) !== 0 ? 1 : 0; S[8] = psx.hookTTY ? 1 : 0; return x.run(); },
    skipHook() { S[9] = 1; },
    /** nº de acessos de E/S servidos no wasm desde a última chamada (diagnóstico) */
    fastIo() { const n = GF[26] >>> 0; GF[26] = 0; return n; },
  };
  return w;
}
