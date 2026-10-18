// Roda todos os .psx (PS-X EXE) de uma pasta no emulador, sobre a BIOS real, e resume: travou/exceção, áudio, tela não vazia, JIT == interpretador.
// Uso: BIOS=SCPH1001.BIN node tools/demos/run-all.mjs pasta [quadros=300] [saida_ppm]   (grava a tela final em <saida>/<nome>.ppm)
import fs from 'node:fs'; import path from 'node:path'; import crypto from 'node:crypto';
import { PSX } from '../../src/psx.js';
const [dir, frArg, outDir] = process.argv.slice(2), FR = +frArg || 300;
const bios = new Uint8Array(fs.readFileSync(process.env.BIOS || '/mnt/user-data/uploads/SCPH1001.BIN'));
if (outDir) fs.mkdirSync(outDir, { recursive: true });
function boot(file, jit) {
  const psx = new PSX(); psx.onTTY = () => {}; psx.loadBios(bios); psx.reset(); psx.useJit = jit;
  if (!psx.bootToShell()) throw new Error('BIOS não chegou ao shell');
  const f = new Uint8Array(fs.readFileSync(file)), dv = new DataView(f.buffer, f.byteOffset), size = dv.getUint32(0x1C, true);
  psx.sideload({ pc: dv.getUint32(0x10, true), gp: dv.getUint32(0x14, true), textAddr: dv.getUint32(0x18, true), data: f.subarray(0x800, 0x800 + size), sp: dv.getUint32(0x30, true) });
  return psx;
}
const vh = p => crypto.createHash('md5').update(Buffer.from(p.gpu.vram.buffer, p.gpu.vram.byteOffset, 1024 * 1024)).digest('hex').slice(0, 8);
for (const name of fs.readdirSync(dir).filter(n => /\.(psx|exe)$/i.test(n)).sort()) {
  const file = path.join(dir, name); let res;
  try {
    const psx = boot(file, true); let peak = 0, exc = 0; const ox = psx.cpu.exception.bind(psx.cpu);
    psx.cpu.exception = function (c, x) { if (c !== 0 && c !== 8) exc++; return ox(c, x); };
    for (let i = 0; i < FR; i++) { const a = psx.runFrame(); for (let k = 0; k < a.length; k++) peak = Math.max(peak, Math.abs(a[k])); }
    const pc = psx.cpu.pc >>> 0, crashed = (pc & 0x1FFFFFFF) < 0x200; let nz = 0; for (let i = 0; i < 1024 * 512; i += 7) if (psx.gpu.vram[i]) nz++;
    const eq = vh(boot(file, true).constructor === PSX ? (() => { const p = boot(file, true); for (let i = 0; i < 40; i++) p.runFrame(); return p; })() : null) === vh((() => { const p = boot(file, false); for (let i = 0; i < 40; i++) p.runFrame(); return p; })());
    res = `${crashed ? 'TRAVOU(vetor de exceção da BIOS)' : 'ok'} exceções=${exc} áudio=${peak ? 'sim(' + peak + ')' : 'mudo'} tela=${nz ? 'desenhada' : 'vazia'} jit==interp(40q)=${eq ? 'sim' : 'NÃO'}`;
    if (outDir) { const w = psx.gpu.width, h = psx.gpu.height, img = new Uint8ClampedArray(w * h * 4); psx.gpu.renderRGBA(img);
      const o = Buffer.alloc(w * h * 3); for (let i = 0; i < w * h; i++) { o[i*3] = img[i*4]; o[i*3+1] = img[i*4+1]; o[i*3+2] = img[i*4+2]; }
      fs.writeFileSync(path.join(outDir, name.replace(/\.\w+$/, '.ppm')), Buffer.concat([Buffer.from(`P6 ${w} ${h} 255\n`), o])); }
  } catch (e) { res = 'ERRO ' + e.message; }
  console.log(name.padEnd(28), res);
}
