// Compara o rasterizador por software com o renderizador WebGL (1x) usando comandos GP0 sintéticos.
// Uso:  node tools/gl-gpu-compare.mjs [classes...]       (precisa do pacote "playwright" e do Chromium)
// Classes: flat gouraud dither tex4 tex8 tex15 semiflat semitex window mask rect rectflip semirect line gline semiline fill copy
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
const root = path.resolve(new URL('..', import.meta.url).pathname);
const { chromium } = await import('playwright');
const srv = http.createServer((q, r) => {
  const f = path.join(root, decodeURIComponent(q.url.split('?')[0]).replace(/^\/+/, '') || 'index.html');
  fs.readFile(f, (e, d) => { if (e) { r.writeHead(404); r.end(); } else { r.writeHead(200, { 'content-type': f.endsWith('.html') ? 'text/html' : 'text/javascript' }); r.end(d); } });
}).listen(0);
const port = srv.address().port;
const all = 'flat gouraud dither tex4 tex8 tex15 semiflat semitex window mask rect rectflip semirect line gline semiline fill copy'.split(' ');
const classes = process.argv.slice(2).length ? process.argv.slice(2) : all;
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const pg = await b.newPage(); pg.on('pageerror', e => console.log('[pageerror]', e.message));
await pg.goto(`http://localhost:${port}/tools/gl-gpu-compare.html`);
for (const c of classes) {
  const res = await pg.evaluate(([c, n]) => window.runClass(c, n), [c, 6]);
  console.log(c.padEnd(9), 'pixels diferentes por seed:', res.map(r => r.bad).join(','));
}
await b.close(); srv.close();
