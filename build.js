// Gera dist/ps1emu.js: junta todos os módulos em UM script clássico (funciona em file://).
// Uso: node build.js      (rode de novo sempre que editar algo em src/ ou web/*-out.js)
import fs from 'node:fs';

const FILES = ['src/gte.js', 'src/cpu.js', 'src/jit.js', 'src/disasm.js', 'src/bus.js', 'src/gpu.js', 'src/gauss.js', 'src/spu.js', 'src/disc.js', 'src/scheduler.js', 'src/timers.js', 'src/dma.js', 'src/mdec.js', 'src/memcard.js', 'src/sio.js', 'src/cdrom.js', 'src/state.js', 'src/psx.js', 'src/input.js', 'src/debug.js', 'src/glgpu.js',
               'web/video-out.js', 'web/audio-out.js', 'web/remote.js'];
const id = f => '__' + f.replace(/\.js$/, '').replace(/[^a-z0-9]/gi, '_');
const byBase = Object.fromEntries(FILES.map(f => [f.split('/').pop(), id(f)]));

let out = '/* PS1 Emu - bundle gerado por build.js (não edite) */\n(function (global) {\n"use strict";\n';
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
out += `global.PS1 = Object.assign({}, ${all.join(', ')});\n})(typeof window !== 'undefined' ? window : globalThis);\n`;
// código do Web Worker = o próprio bundle + web/worker.js, embutido como texto (Blob URL funciona em file://)
const workerSrc = out + '\n' + fs.readFileSync(new URL('./web/worker.js', import.meta.url), 'utf8');
out += `\nvar PS1_WORKER_SRC = ${JSON.stringify(workerSrc).replace(/<\/script/gi, '<\\/script')};\n`;
fs.mkdirSync(new URL('./dist/', import.meta.url), { recursive: true });
fs.writeFileSync(new URL('./dist/ps1emu.js', import.meta.url), out);
console.log(`dist/ps1emu.js gerado (${(out.length / 1024).toFixed(0)} KB, ${FILES.length} módulos)`);
