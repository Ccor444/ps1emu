// cpu/cop (ps1-tests): exceções de coprocessador não habilitado, COP0 inválido, SWC0/2/3 — saída idêntica ao log do console real
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { PSX } from '../src/psx.js';
const BIOS = process.env.BIOS || '/mnt/user-data/uploads/SCPH1001.BIN';
if (!fs.existsSync(BIOS)) { console.log('cop: sem BIOS, pulado'); process.exit(0); }
const bios = new Uint8Array(fs.readFileSync(BIOS));
const real = fs.readFileSync(new URL('./fixtures/cpu/cop.log', import.meta.url), 'utf8').split('\n').filter(l => l.startsWith('% ')).map(l => l.slice(2)).filter(l => l.startsWith('pass') || l.startsWith('fail'));
for (const jit of [true, false]) {
  let out = ''; const psx = new PSX(); psx.onTTY = s => { out += s; }; psx.useJit = jit;
  psx.loadBios(bios); psx.reset(); psx.bootToShell();
  const f = new Uint8Array(fs.readFileSync(new URL('./fixtures/cpu/cop.exe', import.meta.url))), dv = new DataView(f.buffer, f.byteOffset), size = dv.getUint32(0x1C, true);
  psx.sideload({ pc: dv.getUint32(0x10, true), gp: dv.getUint32(0x14, true), textAddr: dv.getUint32(0x18, true), data: f.subarray(0x800, 0x800 + size), sp: dv.getUint32(0x30, true) });
  for (let i = 0; i < 150; i++) psx.runFrame();
  const ours = out.split('\n').map(l => l.trim()).filter(l => l.startsWith('pass') || l.startsWith('fail'));
  assert.deepEqual(ours, real, `jit=${jit}\n${out}`);
}
console.log(`  ok   cpu/cop: ${real.length} asserções idênticas ao console real (JIT e interpretador)`);
