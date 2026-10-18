import assert from 'node:assert/strict';
import { MDEC, defaultScaleTable } from '../src/mdec.js';
import { PSX } from '../src/psx.js';

let n = 0; const T = (name, fn) => { fn(); n++; console.log('  ok  ', name); };
const pack = hw => { const w = []; for (let i = 0; i < hw.length; i += 2) w.push(((hw[i + 1] ?? 0xFE00) << 16 | hw[i]) >>> 0); return w; };
const blockHW = (qscale, dc) => [((qscale << 10) | (dc & 0x3FF)) & 0xFFFF, 0xFE00];                 // bloco só com DC
const feed = (m, cmd, words) => { m.writeWord(cmd >>> 0); for (const w of words) m.writeWord(w); };
const take = (m, bytes) => { const w = m.dmaRead(bytes / 4), o = new Uint8Array(bytes); new DataView(o.buffer).setUint32; w.forEach((v, i) => { o[i * 4] = v & 255; o[i * 4 + 1] = (v >> 8) & 255; o[i * 4 + 2] = (v >> 16) & 255; o[i * 4 + 3] = v >>> 24; }); return o; };

T('IDCT inteira ≈ IDCT em ponto flutuante (erro ≤ 3; o hardware arredonda p/ cima em cada passada) com coeficientes aleatórios', () => {
  const m = new MDEC(); let seed = 12345; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7FFFFFFF) / 0x7FFFFFFF;
  for (let t = 0; t < 40; t++) {
    const F = new Int32Array(64); for (let i = 0; i < 64; i++) if (i === 0 || rnd() < 0.2) F[i] = Math.round((rnd() - 0.5) * (i === 0 ? 1600 : 500));
    const out = new Int32Array(64); m.idct(F, out);
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
      let s = 0; for (let v = 0; v < 8; v++) for (let u = 0; u < 8; u++)
        s += (v ? 1 : Math.SQRT1_2) * (u ? 1 : Math.SQRT1_2) * F[v * 8 + u] * Math.cos((2 * y + 1) * v * Math.PI / 16) * Math.cos((2 * x + 1) * u * Math.PI / 16);
      const ref = Math.max(-128, Math.min(127, s / 4)); assert.ok(Math.abs(out[y * 8 + x] - ref) <= 3, `t=${t} (${x},${y}) ${out[y * 8 + x]} vs ${ref.toFixed(2)}`);
    }
  }
});

T('DC puro: coeficiente 1000 -> pixel 125 em todo o bloco; saturação em ±128', () => {
  const m = new MDEC(), F = new Int32Array(64), o = new Int32Array(64); F[0] = 1000; m.idct(F, o);
  assert.ok(o.every(v => Math.abs(v - 125) <= 1)); F[0] = 1023; m.idct(F, o); assert.ok(o.every(v => v >= 127 && v <= 128 - 1 + 1));
});

T('comando 2: tabelas de quantização (luma, ou luma+croma)', () => {
  const m = new MDEC(), q = Array.from({ length: 32 }, (_, i) => (4 * i + 3) | ((4 * i + 2) << 8) | ((4 * i + 1) << 16) | ((4 * i) << 24));
  const bytes = []; for (const w of q) bytes.push(w & 255, (w >>> 8) & 255, (w >>> 16) & 255, w >>> 24);
  feed(m, 0x40000001, q); assert.deepEqual([...m.qtY], bytes.slice(0, 64)); assert.deepEqual([...m.qtC], bytes.slice(64, 128)); assert.equal(m.state, 0);
  feed(m, 0x40000000, q.slice(0, 16)); assert.deepEqual([...m.qtC], [...m.qtY]);
});

T('comando 3: tabela de escala do IDCT (64 halfwords)', () => {
  const m = new MDEC(), t = defaultScaleTable(), words = []; for (let i = 0; i < 64; i += 2) words.push(((t[i + 1] & 0xFFFF) << 16 | (t[i] & 0xFFFF)) >>> 0);
  m.scale.fill(0); feed(m, 0x60000000, words); assert.deepEqual([...m.scale], [...t]);
  assert.equal(t[0], 0x5A82); assert.equal(t[8], 0x7D8A); assert.ok(Math.abs(t[16] - 0x7641) <= 1);   // jogos enviam a tabela exata; este é só o padrão
});

T('decodifica macroblock 24 bits: cinza (Y=0,Cr=Cb=0) -> 768 bytes = 128', () => {
  const m = new MDEC(); let notified = 0; m.onOutput = () => notified++;
  const hw = []; for (let b = 0; b < 6; b++) hw.push(...blockHW(1, 0));
  feed(m, 0x30000000 | 6, pack(hw));
  assert.equal(m.outWords(), 192); assert.equal(notified, 1);
  const o = take(m, 768); assert.ok(o.every(v => v === 128)); assert.equal(m.outWords(), 0);
});

T('luma DC=60 (coef 120 -> pixel ~15) em 24 bits: R=G=B≈143; croma muda as cores', () => {
  const m = new MDEC(), hw = [];
  hw.push(...blockHW(1, 0), ...blockHW(1, 0));                                    // Cr, Cb
  for (let b = 0; b < 4; b++) hw.push(...blockHW(1, 60));                         // Y1..Y4
  feed(m, 0x30000000 | 6, pack(hw)); const o = take(m, 768);
  for (let i = 0; i < 256; i++) { assert.ok(Math.abs(o[i * 3] - 143) <= 1); assert.equal(o[i * 3], o[i * 3 + 1]); assert.equal(o[i * 3 + 1], o[i * 3 + 2]); }   // ±1: arredondamento p/ cima do IDCT
  const m2 = new MDEC(), h2 = [...blockHW(1, 80), ...blockHW(1, 0)]; for (let b = 0; b < 4; b++) h2.push(...blockHW(1, 0));   // Cr forte -> mais vermelho
  feed(m2, 0x30000000 | 6, pack(h2)); const p = take(m2, 768); assert.ok(p[0] > 128 + 20 && p[1] < 128 - 10 && p[2] === 128, `rgb=${p[0]},${p[1]},${p[2]}`);
});

T('15 bits com bit15, saída "signed" e modo monocromático 8 bits', () => {
  const hw = []; for (let b = 0; b < 6; b++) hw.push(...blockHW(1, 0));
  let m = new MDEC(); feed(m, 0x38000000 | 0x02000000 | 6, pack(hw)); let o = take(m, 512);
  for (let i = 0; i < 256; i++) assert.equal(o[i * 2] | (o[i * 2 + 1] << 8), 0xC210);          // 16,16,16 + bit15
  m = new MDEC(); feed(m, 0x30000000 | 0x04000000 | 6, pack(hw)); o = take(m, 768); assert.ok(o.every(v => v === 0));   // signed: sem +128
  m = new MDEC(); feed(m, 0x28000000 | 1, pack(blockHW(1, 60))); o = take(m, 64); assert.ok(o.every(v => Math.abs(v - 143) <= 1));
});

T('AC com run/valor, zigzag e EOB; qscale=0 usa valor*2', () => {
  const m = new MDEC();
  // DC=0, depois run=0 valor=+16 (1º AC, índice zigzag 1 = coef[1]); coef = (16*qt[1]*qscale+4)>>3 = (16*2*8+4)>>3 = 32
  const hw = [(8 << 10) | 0, (0 << 10) | 16, 0xFE00]; feed(m, 0x28000000 | 2, pack(hw)); const o = take(m, 64);
  assert.notEqual(o[0], o[7], 'o AC horizontal cria gradiente em x'); assert.equal(o[0], o[8 * 7], 'constante em y');
  const m2 = new MDEC(), q0 = [(0 << 10) | 100, 0xFE00]; feed(m2, 0x28000000 | 1, pack(q0)); const p = take(m2, 64);
  assert.ok(Math.abs(p[0] - (128 + 200 / 8)) <= 1, 'qscale=0: DC*2 = 200 -> pixel 25');
});

T('bloco dividido entre palavras e vários macroblocos seguidos', () => {
  const m = new MDEC(), hw = []; for (let mb = 0; mb < 3; mb++) for (let b = 0; b < 6; b++) hw.push(...blockHW(1, mb * 10));
  const words = pack(hw); m.writeWord((0x30000000 | words.length) >>> 0); for (const w of words) m.writeWord(w);
  assert.equal(m.outWords(), 3 * 192);
});

T('status: reset, FIFO vazia, bits de profundidade e DMA habilitado', () => {
  const m = new MDEC(); m.write(0x1F801824, 0x80000000); assert.equal(m.read(0x1F801824) >>> 0, 0x80040000);
  m.write(0x1F801824, 0x60000000); const s = m.read(0x1F801824); assert.ok(s & 0x10000000, 'pedido DMA0'); assert.equal((s >>> 27) & 1, 0, 'sem dados p/ DMA1');
  const hw = []; for (let b = 0; b < 6; b++) hw.push(...blockHW(1, 0)); feed(m, 0x38000000 | 6, pack(hw));
  const t = m.read(0x1F801824); assert.ok(!(t & 0x80000000)); assert.ok(t & 0x08000000); assert.equal((t >>> 25) & 3, 3);
});

T('DMA0 -> MDEC -> DMA1 pela máquina completa (RAM -> RAM)', () => {
  const p = new PSX(), hw = []; for (let b = 0; b < 6; b++) hw.push(...blockHW(1, 0));
  const words = [(0x30000000 | 6) >>> 0, ...pack(hw)], rv = p.bus.ramView;
  words.forEach((w, i) => rv.setUint32(0x1000 + i * 4, w, true));
  p.dma.write(0x1F8010F0, 4, 0x07654321 | 0x8 | 0x80);                                // habilita canais 0 e 1
  p.mdec.write(0x1F801824, 0x60000000);
  p.dma.write(0x1F801080, 4, 0x1000); p.dma.write(0x1F801084, 4, (1 << 16) | words.length); p.dma.write(0x1F801088, 4, 0x01000201);   // MDEC in
  p.dma.write(0x1F801090, 4, 0x2000); p.dma.write(0x1F801094, 4, (1 << 16) | 192); p.dma.write(0x1F801098, 4, 0x01000200);           // MDEC out
  p.cpu.cycles += 5000; p.sched.run(p.cpu.cycles);
  for (let i = 0; i < 768; i++) assert.equal(p.bus.ram[0x2000 + i], 128);
  assert.equal(p.dma.chcr[1] & 0x01000000, 0, 'DMA1 concluído'); assert.equal(p.dma.chcr[0] & 0x01000000, 0, 'DMA0 concluído');
});

T('DMA1 pedido ANTES dos dados fica pendente e conclui quando o DMA0 chega', () => {
  const p = new PSX(), hw = []; for (let b = 0; b < 6; b++) hw.push(...blockHW(1, 0));
  const words = [(0x30000000 | 6) >>> 0, ...pack(hw)], rv = p.bus.ramView;
  words.forEach((w, i) => rv.setUint32(0x1000 + i * 4, w, true));
  p.dma.write(0x1F8010F0, 4, 0x07654321 | 0x8 | 0x80);
  p.dma.write(0x1F801090, 4, 0x2000); p.dma.write(0x1F801094, 4, (1 << 16) | 192); p.dma.write(0x1F801098, 4, 0x01000200);           // MDEC out primeiro
  assert.ok(p.dma.chcr[1] & 0x01000000, 'ainda ocupado'); assert.ok(p.mdec.pendingOut);
  p.dma.write(0x1F801080, 4, 0x1000); p.dma.write(0x1F801084, 4, (1 << 16) | words.length); p.dma.write(0x1F801088, 4, 0x01000201);
  p.cpu.cycles += 5000; p.sched.run(p.cpu.cycles);
  assert.equal(p.bus.ram[0x2000], 128); assert.equal(p.bus.ram[0x2000 + 767], 128); assert.equal(p.dma.chcr[1] & 0x01000000, 0); assert.equal(p.mdec.pendingOut, null);
});
console.log(`${n} testes de MDEC passaram`);
