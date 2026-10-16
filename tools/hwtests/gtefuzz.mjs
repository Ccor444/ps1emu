// Valida o GTE contra 1150 vetores medidos no console real (ps1-tests/gte-fuzz/gte_valid_0xc0ffee_50.log):
// cada teste grava os 64 registradores (0-31 dados, 32-63 controle), executa um comando e lê os 64 de volta.
// Uso: node gtefuzz.mjs caminho/gte_valid_0xc0ffee_50.log [-v]
import fs from 'node:fs'; import zlib from 'node:zlib';
import { GTE } from '../../src/gte.js';
const [logPath, verbose] = process.argv.slice(2);
let raw = fs.readFileSync(logPath); if (logPath.endsWith('.gz')) raw = zlib.gunzipSync(raw);
const lines = raw.toString('utf8').split(/\r?\n/);
const tests = []; let cur = null;
for (const l of lines) {
  let m;
  if ((m = /^Test (\d+)/.exec(l))) { cur = { n: +m[1], inp: [], out: [], cmd: null }; tests.push(cur); }
  else if (cur && (m = /^> r\[(\d+)\] = 0x([0-9a-f]+)/.exec(l))) cur.inp[+m[1]] = parseInt(m[2], 16) | 0;
  else if (cur && (m = /^< r\[(\d+)\] = 0x([0-9a-f]+)/.exec(l))) cur.out[+m[1]] = parseInt(m[2], 16) | 0;
  else if (cur && (m = /^GTE 0x([0-9a-f]+) (\S+) \(sf=(\d), lm=(\d), tx=(\d), vx=(\d), mx=(\d)\)/.exec(l)))
    cur.cmd = { op: parseInt(m[1], 16), name: m[2], sf: +m[3], lm: +m[4], tx: +m[5], vx: +m[6], mx: +m[7] };
  else if (cur && (m = /^-------------- GTE 0x([0-9a-f]+) (\S+)/.exec(l))) { /* cabeçalho de grupo */ }
}
// nome do grupo para testes sem comando (0x40)
const groups = {}; let ok = 0, bad = 0; const badRegs = {};
for (const t of tests) {
  if (t.inp.length < 64 || t.out.length < 64) continue;
  const g = new GTE();
  for (let i = 0; i < 32; i++) g.writeData(i, t.inp[i]);
  for (let i = 0; i < 32; i++) g.writeCtrl(i, t.inp[32 + i]);
  const name = t.cmd ? t.cmd.name : 'nenhum(0x40)';
  if (t.cmd) { const c = t.cmd; g.command((c.op | (c.sf << 19) | (c.mx << 17) | (c.vx << 15) | (c.tx << 13) | (c.lm << 10)) >>> 0); }
  const diffs = [];
  for (let i = 0; i < 64; i++) { const v = (i < 32 ? g.readData(i) : g.readCtrl(i - 32)) | 0; if (v !== t.out[i]) diffs.push([i, v, t.out[i]]); }
  const G = groups[name] ??= { ok: 0, bad: 0, regs: {} };
  if (diffs.length) { G.bad++; bad++; for (const [i] of diffs) G.regs[i] = (G.regs[i] || 0) + 1; if (verbose && G.bad <= 2) console.log(`teste ${t.n} ${name} ${JSON.stringify(t.cmd)}:\n` + diffs.slice(0, 8).map(([i, a, b]) => `   r[${i}] nosso=${(a >>> 0).toString(16)} real=${(b >>> 0).toString(16)}`).join('\n')); }
  else { G.ok++; ok++; }
}
for (const [n, G] of Object.entries(groups)) console.log(`${n.padEnd(14)} ${G.ok}/${G.ok + G.bad} iguais${G.bad ? '   regs divergentes: ' + Object.entries(G.regs).map(([r, c]) => `r${r}×${c}`).join(' ') : ''}`);
console.log(`TOTAL: ${ok}/${ok + bad} testes idênticos ao console real`);
process.exitCode = bad ? 1 : 0;
