// Gera dist/ps1emu.js: junta todos os módulos em UM script clássico (funciona em file://).
// Uso: node build.js      (rode de novo sempre que editar algo em src/ ou web/*-out.js)
import fs from 'node:fs';

const FILES = ['src/gte.js', 'src/cpu.js', 'src/jit.js', 'src/wasmbin.js', 'src/wasmmdec.js', 'src/wasmcpu.js', 'src/wasmraster.js', 'src/wasmgpu.js', 'src/wasmspu.js', 'src/disasm.js', 'src/bus.js', 'src/gpu.js', 'src/gauss.js', 'src/spu.js', 'src/disc.js', 'src/scheduler.js', 'src/timers.js', 'src/dma.js', 'src/mdec.js', 'src/memcard.js', 'src/sio.js', 'src/cdrom.js', 'src/state.js', 'src/psx.js', 'src/input.js', 'src/debug.js', 'src/glgpu.js',
               'web/video-out.js', 'web/audio-out.js', 'web/remote.js'];
const id = f => '__' + f.replace(/\.js$/, '').replace(/[^a-z0-9]/gi, '_');
const byBase = Object.fromEntries(FILES.map(f => [f.split('/').pop(), id(f)]));

let out = '"use strict";\n';
const all = [];
for (const f of FILES) {
  let src = fs.readFileSync(new URL('./' + f, import.meta.url), 'utf8');
  const names = [];
  // imports -> destructuring dos módulos já definidos
  src = src.replace(/^import\s*\{([^}]*)\}\s*from\s*'\.\/([^']+)';?\s*$/gm, (_, list, file) => {
    const mod = byBase[file.split('/').pop()]; if (!mod) throw new Error(`import desconhecido ${file} em ${f}`);
    return `const {${list}} = ${mod};`;
  });
  src = src.replace(/^import\s*\{([^}]*)\}\s*from\s*'\.\.\/src\/([^']+)';?\s*$/gm, (_, list, file) => `const {${list}} = ${byBase[file]};`);
  // exports -> coleta nomes
  src = src.replace(/^export\s+(class|const|function|let)\s+([A-Za-z0-9_$]+)/gm, (_, k, n) => { names.push(n); return `${k} ${n}`; });
  out += `const ${id(f)} = (() => {\n${src}\nreturn { ${names.join(', ')} };\n})();\n`;
  all.push(id(f));
}
out += `global.PS1 = Object.assign({}, ${all.join(', ')});\n`;
// O núcleo vira UMA função (PS1_CORE_FN): roda na thread principal e o texto dela (Function.toString) é reutilizado em tempo de execução para
// montar o Worker e o Worker aninhado da GPU — o código existe uma única vez no arquivo (antes: 3 cópias embutidas como texto, sem minificar).
let fn = `var PS1_CORE_FN = function (global) {\n${out}};\n`;
try {
  const { createRequire } = await import('node:module');
  const req = createRequire(import.meta.url);
  let esb; for (const p of ['esbuild', '/opt/npm-tools/node_modules/esbuild']) { try { esb = req(p); break; } catch {} }
  if (esb && !process.env.NO_MIN) fn = esb.transformSync(fn, { minify: true, target: 'es2022', legalComments: 'none' }).code;
} catch (e) { console.warn('minificação indisponível:', e.message); }
const q = t => JSON.stringify(t).replace(/<\/script/gi, '<\\/script');
const gpuw = fs.readFileSync(new URL('./web/gpuworker.js', import.meta.url), 'utf8');      // rasterizador em Worker aninhado (GPU em 2ª thread)
const wrk = fs.readFileSync(new URL('./web/worker.js', import.meta.url), 'utf8');
out = `/* PS1 Emu - bundle gerado por build.js (não edite) */\n${fn}\nPS1_CORE_FN(typeof window !== 'undefined' ? window : globalThis);\n`
  + `var PS1_BOOT = 'var PS1_CORE_FN = ' + PS1_CORE_FN.toString() + ';\\nPS1_CORE_FN(self);\\n';\n`
  + `var PS1_GPUW_SRC = PS1_BOOT + ${q(gpuw)};\n`
  + `var PS1_WORKER_SRC = PS1_BOOT + 'var PS1_GPUW_SRC = ' + JSON.stringify(PS1_GPUW_SRC) + ';\\n' + ${q(wrk)};\n`;
fs.mkdirSync(new URL('./dist/', import.meta.url), { recursive: true });
fs.writeFileSync(new URL('./dist/ps1emu.js', import.meta.url), out);
console.log(`dist/ps1emu.js gerado (${(out.length / 1024).toFixed(0)} KB, ${FILES.length} módulos)`);
