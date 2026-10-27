// Front-end do GP0 em wasm (wasm/gpf.c) x caminho JS (modo GPU em Worker): listas encadeadas e uploads aleatórios têm que gerar
// EXATAMENTE o mesmo fluxo de comandos, o mesmo tempo de ocupação da GPU e o mesmo estado (texpage, offsets...).
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
delete process.env.PS1_WASMGPF; globalThis.PS1_WASM = 1;
import { PSX } from '../src/psx.js';
import { GpuStream } from '../src/gpu.js';

let seed = 777; const rnd = n => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return (seed >>> 8) % n; };
const pos = () => ((rnd(700) - 100) & 0x7FF) | (((rnd(500) - 50) & 0x7FF) << 16);
let PURE = false;
function packet() {
  const k = PURE ? rnd(10) : rnd(16), col = (rnd(256) | (rnd(256) << 8) | (rnd(256) << 16)) >>> 0, r = [];
  if (k < 5) {                                       // polígono (flat/gouraud, tri/quad, textura, semi, raw)
    const c = 0x20 | rnd(32), quad = c & 8, tex = c & 4, gour = c & 0x10, n = quad ? 4 : 3;
    r.push(((c << 24) | col) >>> 0);
    for (let i = 0; i < n; i++) { if (gour && i > 0) r.push(col ^ (i * 0x10203)); r.push(pos()); if (tex) r.push((rnd(256) | (rnd(256) << 8) | ((i === 1 ? rnd(0x10000) : rnd(0x10000)) << 16)) >>> 0); }
  } else if (k < 8) {                                // retângulo (livre / 1x1 / 8x8 / 16x16)
    const c = 0x60 | rnd(32), sz = (c >> 3) & 3; r.push(((c << 24) | col) >>> 0, pos()); if (c & 4) r.push(rnd(0x10000) | (rnd(0x10000) << 16)); if (sz === 0) r.push(rnd(300) | (rnd(250) << 16));
  } else if (k === 8) r.push(((0x02 << 24) | col) >>> 0, (rnd(64) * 16) | (rnd(480) << 16), rnd(1024) | (rnd(512) << 16));          // fill
  else if (k === 9) r.push((0x80 << 24) >>> 0, pos() & 0x1FF03FF, pos() & 0x1FF03FF, (1 + rnd(200)) | ((1 + rnd(150)) << 16));      // VRAM->VRAM
  else if (k === 10) { const e = [0xE1, 0xE2, 0xE3, 0xE4, 0xE5, 0xE6][rnd(6)]; r.push(((e << 24) | (rnd(0x1000000) & (e === 0xE5 ? 0x3FFFFF : e === 0xE1 ? 0xFFF : 0xFFFFF))) >>> 0); }
  else if (k === 11) { const w = 1 + rnd(9), h = 1 + rnd(5); r.push((0xA0 << 24) >>> 0, rnd(900) | (rnd(400) << 16), w | (h << 16)); for (let i = 0; i < Math.ceil(w * h / 2); i++) r.push((Math.imul(i + 1, 0x9E3779B1) ^ seed) >>> 0); }   // upload
  else if (k === 12) { r.push(((0x40 | (rnd(2) << 4)) << 24 | col) >>> 0, pos()); if (r[0] >>> 28 & 1) r.push(col); r.push(pos()); if ((r[0] >>> 24) & 0x10) r.push(col); r.push(0x55555555); }   // linha
  else if (k === 13) r.push(0);                      // NOP
  else if (k === 14) r.push(0x01000000);             // limpa cache de CLUT
  else r.push(((0xE1 << 24) | (rnd(0x800) | 0x600)) >>> 0);
  return r;
}
// monta uma lista encadeada em RAM (base 0x10000) com uma sequência contínua de pacotes cortada em nós; `split` permite cortar no meio de um pacote
function build(p, count, split) {
  const bounds = [], all = [];
  for (let i = 0; i < count; i++) { all.push(...packet()); bounds.push(all.length); }
  const cuts = [0]; let at = 0;
  while (at < all.length) {
    let end;
    if (split && rnd(6) === 0) end = Math.min(all.length, at + 1 + rnd(12));
    else { const cand = bounds.filter(b => b > at && b - at <= 255); end = cand.length ? cand[Math.min(cand.length - 1, rnd(3))] : Math.min(all.length, at + 255); }
    end = Math.min(end, at + 255); cuts.push(end); at = end;
  }
  let addr = 0x10000;
  for (let n = 0; n + 1 < cuts.length; n++) {
    const words = all.slice(cuts[n], cuts[n + 1]), last = n + 2 === cuts.length, next = addr + 4 + words.length * 4;
    p.bus.write(0x80000000 + addr, 4, ((words.length << 24) | (last ? 0xFFFFFF : next)) >>> 0);
    for (let i = 0; i < words.length; i++) p.bus.write(0x80000000 + addr + 4 + 4 * i, 4, words[i]);
    addr = next;
  }
  return 0x10000;
}
const COV = { list: [0, 0, 0], copy: 0, fast: 0 };
function run(on, rounds) {
  seed = 777; globalThis.PS1_WASMGPF = on ? 1 : 0;
  const p = new PSX(); assert.ok(p.enableWasm()); p.hookTTY = false; p.nextTick = 1e12;
  const h = crypto.createHash('sha1'), st = crypto.createHash('sha1'); let words = 0;
  p.gpu.remote = new GpuStream(m => { h.update(Buffer.from(m.q.buffer, m.q.byteOffset, m.q.byteLength)); words += m.q.length; });
  p.bus.write(0x1F8010F0, 4, 0x07654B21);
  if (p.dma.gpf) { const x0 = p.dma.gpf.x; p.dma.gpf.x = { gpf_list: () => { const q0 = p.dma.gpf.P[7]; const s = x0.gpf_list(); COV.list[s]++; COV.fast += p.dma.gpf.P[7] - q0; return s; }, gpf_copy: (a, n) => { const k = x0.gpf_copy(a, n); COV.copy += k; return k; } }; }
  for (let r = 0; r < rounds; r++) {
    const big = r % 5 === 4;                                              // listas longas: enchem a fila (65536 palavras) e forçam o esvaziamento no meio
    PURE = big; p.gpu.writeGP1(0x01000000);
    const head = build(p, big ? 12000 : 30 + rnd(80), r % 2 === 1);
    p.cpu.cycles += 1000 + rnd(5000);
    const c0 = JSON.stringify(COV.list), f0 = COV.fast; p.bus.write(0x1F8010A0, 4, head); p.bus.write(0x1F8010A4, 4, 0); p.bus.write(0x1F8010A8, 4, 0x01000401); if (process.env.DBG && big) console.log(r, c0, JSON.stringify(COV.list), COV.fast - f0, p.gpu.remote.n);
    // upload em bloco (DMA sync 1) depois do cabeçalho A0 enviado pela CPU
    const w = 2 + rnd(40), hh = 1 + rnd(20); p.bus.write(0x1F801810, 4, 0xA0000000); p.bus.write(0x1F801810, 4, rnd(900) | (rnd(400) << 16)); p.bus.write(0x1F801810, 4, w | (hh << 16));
    const tw = Math.ceil(w * hh / 2), blk = rnd(2) ? tw : Math.max(1, tw - rnd(tw));
    for (let i = 0; i < blk; i++) p.bus.write(0x80020000 + i * 4, 4, (i * 2654435761 + r) >>> 0);
    p.bus.write(0x1F8010A0, 4, 0x20000); p.bus.write(0x1F8010A4, 4, blk | (1 << 16)); p.bus.write(0x1F8010A8, 4, 0x01000201);
    const g = p.gpu; st.update([g.busyUntil, g.texX, g.texY, g.semiMode, g.texDepth, g.texDisable, g.offX, g.offY, g.daX1, g.daY1, g.daX2, g.daY2, g.phase, g.buf.length, g.vw ? g.vw.i : -1, p.dma.madr[2]].join(','));
    g.writeGP1(0x01000000);                                                // GP1 reset do buffer de comando: cada rodada começa em fase de comando
    p.gpu.remote.flush();
  }
  return { stream: h.digest('hex'), state: st.digest('hex'), words, fast: !!p.dma.gpf };
}
const a = run(false, 40), b = run(true, 40);
assert.equal(a.fast, false); assert.equal(b.fast, true);
assert.ok(a.words > 100000, 'poucos comandos gerados: ' + a.words);
assert.equal(b.words, a.words, 'tamanho do fluxo de comandos');
assert.equal(b.stream, a.stream, 'fluxo de comandos diverge');
assert.equal(b.state, a.state, 'estado da GPU (busyUntil/texpage/offsets/fase) diverge');
assert.ok(COV.list[0] > 5 && COV.list[1] > 100 && COV.list[2] > 0 && COV.fast > 100000 && COV.copy > 100, 'cobertura insuficiente: ' + JSON.stringify(COV));
console.log(`cobertura: listas concluídas ${COV.list[0]}, desvios p/ JS ${COV.list[1]}, fila cheia ${COV.list[2]}, palavras copiadas em bloco ${COV.copy}, palavras do fluxo pelo wasm ${COV.fast}`);
console.log(`front-end GP0 em wasm == JS: ${a.words / 2} palavras de GP0 em 40 rodadas de listas/uploads`);
