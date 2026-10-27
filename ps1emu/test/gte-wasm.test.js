// GTE em C/WASM x GTE em JS: mesmas escritas de registradores + comandos aleatórios => mesmos registradores e flags.
import assert from 'node:assert/strict';
import { GTE } from '../src/gte.js';
import { WASM_B64 } from '../src/wasmbin.js';

const bin = Buffer.from(WASM_B64, 'base64');
const memory = new WebAssembly.Memory({ initial: 160, maximum: 160 });
const { exports: x } = new WebAssembly.Instance(new WebAssembly.Module(bin), { env: { memory, bread: () => 0, bwrite: () => {}, codewr: () => {}, __indirect_function_table: new WebAssembly.Table({ initial: 8, element: 'anyfunc' }) } });
let seed = 987654321; const rnd = n => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return (seed >>> 4) % n; };
const r32 = () => { const m = rnd(5); return m === 0 ? (rnd(65536) - 32768) >>> 0 : m === 1 ? (rnd(0x2000) - 0x1000) >>> 0 : m === 2 ? (Math.imul(rnd(65536), 65536) ^ rnd(65536)) >>> 0 : m === 3 ? [0, 0xFFFFFFFF, 0x7FFFFFFF, 0x80000000, 0x7FFF, 0x8000, 0xFFFF][rnd(7)] : (rnd(0x200000) - 0x100000) >>> 0; };
const CMDS = [1, 0x30, 6, 0x0C, 0x10, 0x2A, 0x11, 0x12, 0x13, 0x16, 0x1B, 0x3F, 0x1E, 0x20, 0x14, 0x1C, 0x29, 0x28, 0x2D, 0x2E, 0x3D, 0x3E, 0x00, 0x05];
const g = new GTE();
let n = 0, withFlags = 0;
for (let round = 0; round < 3000; round++) {
  for (let i = 0; i < 32; i++) { if (i === 29 || i === 31) continue; const v = r32(); g.writeData(i, v); x.gte_wr(0, i, v); }
  for (let i = 0; i < 32; i++) { const v = r32(); g.writeCtrl(i, v); x.gte_wr(1, i, v); }
  for (let k = 0; k < 6; k++) {
    const cmd = (rnd(2) << 19) | (rnd(2) << 10) | (rnd(4) << 17) | (rnd(4) << 15) | (rnd(4) << 13) | CMDS[rnd(CMDS.length)];
    g.command(cmd); x.gte_cmd(cmd); n++;
    if (g.flag) withFlags++;
    for (let i = 0; i < 32; i++) assert.equal(x.gte_rd(0, i) >>> 0, g.readData(i) >>> 0, `dado ${i} após cmd ${cmd.toString(16)} (rodada ${round})`);
    for (let i = 0; i < 32; i++) assert.equal(x.gte_rd(1, i) >>> 0, g.readCtrl(i) >>> 0, `ctrl ${i} após cmd ${cmd.toString(16)} (rodada ${round})`);
  }
}
console.log(`GTE wasm == GTE js em ${n} comandos aleatórios (${withFlags} com flags de saturação/overflow)`);
