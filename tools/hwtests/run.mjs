// Roda um PS-X EXE de teste no emulador (BIOS real, sem disco) e compara a saída com o log do console real.
// Uso: node run.mjs teste.exe [psx.log] [maxQuadros]   (env: BIOS=SCPH1001.BIN, JIT=0 para interpretar)
import fs from 'node:fs';
import { PSX } from '../../src/psx.js';
const [exePath, logPath, maxArg] = process.argv.slice(2), maxFrames = +maxArg || 1500;
const psx = new PSX(); let out = ''; psx.onTTY = s => { out += s; };
psx.loadBios(new Uint8Array(fs.readFileSync(process.env.BIOS || '/mnt/user-data/uploads/SCPH1001.BIN')));
if (process.env.JIT === '0') psx.useJit = false;
psx.reset();
if (!psx.bootToShell()) { console.log('BIOS não chegou ao shell'); process.exit(2); }
const f = new Uint8Array(fs.readFileSync(exePath)), dv = new DataView(f.buffer, f.byteOffset), size = dv.getUint32(0x1C, true);
out = '';
psx.sideload({ pc: dv.getUint32(0x10, true), gp: dv.getUint32(0x14, true), textAddr: dv.getUint32(0x18, true), data: f.subarray(0x800, 0x800 + size), sp: dv.getUint32(0x30, true) });
let frames = 0, err = null;
try { for (; frames < maxFrames && !/\bDone\.?\s*$/m.test(out); frames++) psx.runFrame(); } catch (e) { err = e; }
const name = process.env.NAME || '';
const got = out.split(/\r?\n/).map(l => l.trimEnd()).filter(l => l.length && !/^psn: /.test(l) && l !== name);
if (!/\bDone\.?\s*$/m.test(out)) console.log(`   (não terminou) pc=${(psx.cpu.pc >>> 0).toString(16)} istat=${psx.bus.istat.toString(16)} imask=${psx.bus.imask.toString(16)}`);
console.log(`-- ${exePath.split('/').pop()}: ${frames} quadros${err ? ' ERRO ' + err.message : ''}, ${got.length} linhas`);
if (!logPath) { console.log(got.join('\n')); process.exit(0); }
const exp = fs.readFileSync(logPath, 'utf8').split(/\r?\n/).map(l => l.replace(/^% ?/, '').trimEnd()).filter((l, i) => l.length && !(i === 0 && /^[\w\/-]+$/.test(l)));
let same = 0; const diffs = [];
const n = Math.max(got.length, exp.length);
for (let i = 0; i < n; i++) { if (got[i] === exp[i]) same++; else diffs.push(`  linha ${i + 1}\n    real:  ${exp[i] ?? '(nada)'}\n    nosso: ${got[i] ?? '(nada)'}`); }
console.log(`   iguais: ${same}/${exp.length}  diferentes: ${diffs.length}`);
if (diffs.length) console.log(diffs.slice(0, +(process.env.SHOW || 12)).join('\n'));
process.exitCode = diffs.length ? 1 : 0;
