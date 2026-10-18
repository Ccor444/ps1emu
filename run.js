// Uso: node run.js <BIOS.BIN> [disco.bin] [--steps N] [--trace N] [--sideload] [--dump frame.ppm] [--mc0 cartao.mcr] [--mc1 cartao.mcr]
import fs from 'node:fs';
import { PSX } from './src/psx.js';
import { disasm } from './src/disasm.js';
import { hex } from './src/cpu.js';

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); return i < 0 ? d : (args.splice(i, 2)[1]); };
const steps = +flag('--steps', 5_000_000), traceN = +flag('--trace', 0), dump = flag('--dump', null);
const mc0 = flag('--mc0', null), mc1 = flag('--mc1', null);
const nojit = args.includes('--nojit'); if (nojit) args.splice(args.indexOf('--nojit'), 1);
const sideload = args.includes('--sideload'); if (sideload) args.splice(args.indexOf('--sideload'), 1);
const [biosPath, discPath] = args;
if (!biosPath) { console.log('uso: node run.js BIOS.BIN [disco.bin] [--steps N] [--trace N] [--sideload] [--dump out.ppm]'); process.exit(1); }

const psx = new PSX(); if (nojit) psx.useJit = false;
console.log('BIOS :', psx.loadBios(new Uint8Array(fs.readFileSync(biosPath))));
if (discPath) console.log('Disco:', psx.loadDisc(new Uint8Array(fs.readFileSync(discPath))));

for (const [slot, path] of [[0, mc0], [1, mc1]]) if (path) {
  const info = psx.loadMemoryCard(slot, new Uint8Array(fs.readFileSync(path)));
  console.log(`Cartão ${slot + 1}:`, info.saves.map(s => `${s.code} "${s.title}"`).join('; ') || 'vazio', `(${info.livres} livres)`);
}
let tty = ''; psx.onTTY = s => { tty += s; };
psx.bus.logIo = args.includes("--io") ? true : false; if (args.includes("--io")) args.splice(args.indexOf("--io"), 1);

if (traceN) {                                    // mostra as primeiras N instruções
  let k = 0; psx.onTrace = (pc, w) => { if (k++ < traceN) console.log(`${hex(pc)}: ${hex(w)}  ${disasm(w, pc)}`); };
}

const t0 = Date.now(), hist = new Map();
if (sideload) {
  const ok = psx.bootToShell(steps);
  console.log(ok ? `BIOS chegou ao shell (0x80030000) após ${psx.cpu.instrCount} instruções` : 'BIOS NÃO chegou ao shell no limite de passos');
  if (ok && psx.disc) { const exe = psx.bootDiscExe(); console.log(`EXE ${exe.path} carregado: PC=${hex(exe.pc)} texto=${hex(exe.textAddr)}+${exe.textSize.toString(16)}`); psx.runInstr(steps); }
} else {
  for (let i = 0; psx.cpu.instrCount < steps; i++) { psx.step(); if ((i & 0xFF) === 0) { const k = psx.cpu.pc >>> 0; hist.set(k, (hist.get(k) || 0) + 1); } }
}
const dt = (Date.now() - t0) / 1000;
console.log(`\n${psx.cpu.instrCount} instruções em ${dt.toFixed(2)}s (${(psx.cpu.instrCount / dt / 1e6).toFixed(1)} MIPS)`);
console.log(psx.cpu.dump());
if (tty) console.log('\n--- TTY ---\n' + tty);
if (psx.postCodes.length) console.log('POST codes:', psx.postCodes.map(c => c.toString(16)).join(' '));

console.log('\nPCs mais frequentes:');
for (const [pc, c] of [...hist].sort((a, b) => b[1] - a[1]).slice(0, 5)) console.log(`  ${hex(pc)}  x${c}  ${disasm(psx.bus.read32(pc), pc)}`);
console.log('\nAcessos I/O (top 15):');
for (const [k, c] of [...psx.bus.ioStats].sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log(`  ${k}  x${c}`);
if (psx.bus.unmapped.size) { console.log('Endereços sem mapeamento:'); for (const [k, c] of [...psx.bus.unmapped].slice(0, 8)) console.log(`  ${k} x${c}`); }

for (const [slot, path] of [[0, mc0], [1, mc1]]) {              // grava de volta o que o jogo alterou
  const c = psx.sio.cards[slot]; if (path && c?.dirty) { fs.writeFileSync(path, c.export()); console.log(`Cartão ${slot + 1} alterado -> salvo em ${path}`); }
}
if (dump) {
  const f = psx.gpu.renderRGBA(); const buf = Buffer.alloc(f.width * f.height * 3 + 32); let o = buf.write(`P6\n${f.width} ${f.height}\n255\n`);
  for (let i = 0; i < f.width * f.height; i++) { buf[o++] = f.data[i * 4]; buf[o++] = f.data[i * 4 + 1]; buf[o++] = f.data[i * 4 + 2]; }
  fs.writeFileSync(dump, buf.subarray(0, o)); console.log('frame salvo em', dump);
}
