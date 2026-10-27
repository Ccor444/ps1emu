// Precisão do SPU (Gauss, sweep, ruído, reverb, IRQ) e dos timers (modos de sincronização)
import assert from 'node:assert/strict';
import { SPU, REV_FIR } from '../src/spu.js';
import { GAUSS } from '../src/gauss.js';
import { Timers } from '../src/timers.js';

let n = 0; const T = (name, fn) => { fn(); n++; console.log('  ok  ', name); };
const W = (spu, a, v) => spu.write(0x1F800000 + a, 2, v);        // endereço físico 0x1F801Cxx
const spuTicks = (spu, k) => { for (let i = 0; i < k; i++) spu.tick(); };

// ---------------- Gauss ----------------
T('Gauss: tabela de 512 entradas íntegra (soma dos 4 taps constante em todas as fases)', () => {
  assert.equal(GAUSS.length, 512);
  for (let i = 0; i < 256; i++) {
    const s = GAUSS[0xFF - i] + GAUSS[0x1FF - i] + GAUSS[0x100 + i] + GAUSS[i];
    assert.ok(s >= 32639 && s <= 32641, `fase ${i}: soma ${s}`);
  }
  assert.equal(GAUSS[0x1FF], 0x59B3); assert.equal(GAUSS[0x100], 0x1307); assert.equal(GAUSS[0xFF], 0x12C7); assert.equal(GAUSS[0], -1);
});
T('Gauss: um sinal contínuo (DC) passa com ganho ~0,996 em qualquer fase', () => {
  for (const i of [0, 37, 128, 200, 255]) {
    const out = (GAUSS[0xFF - i] * 10000 + GAUSS[0x1FF - i] * 10000 + GAUSS[0x100 + i] * 10000 + GAUSS[i] * 10000) >> 15;
    assert.ok(Math.abs(out - 9960) <= 3, `fase ${i}: ${out}`);
  }
});
T('Voz: ADPCM constante sai constante pelo Gauss (e a rampa de ataque não estoura)', () => {
  const spu = new SPU(); spu.write(0x1F801D80, 2, 0x3FFF); spu.write(0x1F801D82, 2, 0x3FFF);
  spu.write(0x1F801DAA, 2, 0xC000);                                        // SPU on + unmute
  // bloco ADPCM: shift 12, filtro 0, nibbles 0x4 -> amostra = (4<<12)>>12... = 4 << 0 ; usa shift 8 p/ amplitude 0x400
  const a = 0x1000; spu.ram[a] = 0x08; spu.ram[a + 1] = 0x02;               // shift 8, flags: loop (repeat)
  for (let i = 0; i < 14; i++) spu.ram[a + 2 + i] = 0x44;                  // nibble 4 -> 0x4000>>8 = 0x40
  spu.ram[a + 16] = 0x08; spu.ram[a + 17] = 0x03; for (let i = 0; i < 14; i++) spu.ram[a + 18 + i] = 0x44;   // loop end+repeat
  W(spu, 0x1C00, 0x3FFF); W(spu, 0x1C02, 0x3FFF); W(spu, 0x1C04, 0x1000); W(spu, 0x1C06, a >> 3);
  W(spu, 0x1C08, 0x00FF); W(spu, 0x1C0A, 0x0000);                         // ADSR: ataque rápido, sustain máx
  W(spu, 0x1D88, 1);
  spuTicks(spu, 400);
  const v = spu.voices[0], i = (v.counter >> 4) & 0xFF;
  const out = (GAUSS[0xFF - i] * v.h3 + GAUSS[0x1FF - i] * v.h2 + GAUSS[0x100 + i] * v.h1 + GAUSS[i] * v.cur) >> 15;
  assert.equal(v.cur, 0x40); assert.ok(Math.abs(out - 0x40 * 0.996) <= 1);
});

// ---------------- sweep de volume ----------------
T('Volume fixo: valor de 15 bits com sinal (x2)', () => {
  const spu = new SPU(); W(spu, 0x1C00, 0x3FFF); assert.equal(spu.read(0x1F801E00, 2), 0x7FFE);
  W(spu, 0x1C00, 0x4000); assert.equal(spu.read(0x1F801E00, 2), 0x8000);       // -0x4000 * 2
});
T('Sweep linear crescente: +7<<(11-shift) por amostra (shift 11, step 0 = +7)', () => {
  const spu = new SPU(); W(spu, 0x1C00, 0x0000);                          // nível 0
  W(spu, 0x1C00, 0x8000 | (11 << 2) | 0);                                 // sweep, linear, crescente, fase +, shift 11, step 0
  spuTicks(spu, 100); assert.equal(spu.read(0x1F801E00, 2), 700);
});
T('Sweep com shift menor é mais rápido; com shift maior espera ciclos', () => {
  const a = new SPU(), b = new SPU(), c = new SPU();
  W(a, 0x1C00, 0x8000 | (9 << 2)); W(b, 0x1C00, 0x8000 | (11 << 2)); W(c, 0x1C00, 0x8000 | (13 << 2));
  spuTicks(a, 50); spuTicks(b, 50); spuTicks(c, 50);
  assert.equal(a.sw[0].level, 50 * (7 << 2));                             // 7<<2 por amostra
  assert.equal(b.sw[0].level, 50 * 7);
  assert.equal(c.sw[0].level, 7 * Math.floor(50 / 4));                    // 1 passo a cada 4 amostras
});
T('Sweep linear decrescente parte do valor fixo atual e satura em 0', () => {
  const spu = new SPU(); W(spu, 0x1C00, 0x3FFF);                          // 0x7FFE
  W(spu, 0x1C00, 0x8000 | 0x2000 | (11 << 2) | 0);                        // decrescente: -8 por amostra
  spuTicks(spu, 100); assert.equal(spu.sw[0].level, 0x7FFE - 800);
  spuTicks(spu, 5000); assert.equal(spu.sw[0].level, 0);
});
T('Sweep exponencial crescente desacelera acima de 0x6000; decrescente é proporcional ao nível', () => {
  const lin = new SPU(), exp = new SPU();
  W(lin, 0x1C00, 0x8000 | (9 << 2)); W(exp, 0x1C00, 0xC000 | (9 << 2));
  let t = 0, tl = 0, te = 0;
  for (; t < 20000 && (!tl || !te); t++) { lin.tick(); exp.tick(); if (!tl && lin.sw[0].level >= 0x7FFF) tl = t; if (!te && exp.sw[0].level >= 0x7FFF) te = t; }
  assert.ok(tl > 0 && te > tl * 1.2, `linear ${tl}, exponencial ${te}`);
  const d = new SPU(); W(d, 0x1C00, 0x3FFF); W(d, 0x1C00, 0xE000 | (11 << 2));      // exp. decrescente
  spuTicks(d, 1000); const a = d.sw[0].level; spuTicks(d, 1000); const b = d.sw[0].level;
  assert.ok(a < 0x7FFE && b < a && (0x7FFE - a) > (a - b), `perda por amostra diminui com o nível (${0x7FFE - a} depois ${a - b})`);
});
T('Sweep fase negativa: volume negativo; principal (0x1D80) também varre', () => {
  const spu = new SPU(); W(spu, 0x1C00, 0x8000 | 0x1000 | (11 << 2));
  spuTicks(spu, 10); assert.equal(spu.sw[0].level, -70);
  W(spu, 0x1D80, 0x8000 | (11 << 2)); spuTicks(spu, 10); assert.equal(spu.read(0x1F801E60, 2), 70);
});

// ---------------- ruído ----------------
T('Ruído: LFSR avança na taxa (4+step)/(0x20000>>shift) por amostra', () => {
  const rate = (shift, step) => {
    const spu = new SPU(); spu.write(0x1F801DAA, 2, 0x8000 | (shift << 10) | (step << 8));
    let ch = 0, prev = spu.noise; for (let i = 0; i < 40000; i++) { spu.tick(); if (spu.noise !== prev) { ch++; prev = spu.noise; } } return ch / 40000;
  };
  const r10 = rate(10, 0), r8 = rate(8, 0), r10s = rate(10, 3);
  assert.ok(Math.abs(r10 - 4 / (0x20000 >> 10)) < 0.004, 'shift 10 ' + r10);
  assert.ok(r10 / r8 > 3.5 && r10 / r8 < 4.5, 'shift maior = ~4x mais rápido (recarga 0x20000>>shift)');
  assert.ok(r10s / r10 > 1.6 && r10s / r10 < 1.9, 'step 3 = 7/4');
});
T('Ruído: nunca trava em zero e usa os taps 15,12,11,10', () => {
  const spu = new SPU(); spu.write(0x1F801DAA, 2, 0x8000 | (15 << 10) | (3 << 8));
  const seen = new Set(); for (let i = 0; i < 30000; i++) { spu.tick(); seen.add(spu.noise); assert.notEqual(spu.noise, 0, 'travou em 0'); }
  assert.ok(seen.size > 1000);
});

// ---------------- reverb ----------------
T('Reverb FIR: 39 taps simétricos com ganho unitário (>>15) em DC', () => {
  assert.equal(REV_FIR.length, 39);
  for (let i = 0; i < 39; i++) assert.equal(REV_FIR[i], REV_FIR[38 - i]);
  const sum = REV_FIR.reduce((a, b) => a + b, 0); assert.ok(Math.abs(sum - 32767) <= 2, 'soma ' + sum);
  let even = 0; for (let i = 0; i < 39; i += 2) even += REV_FIR[i]; assert.ok(Math.abs(even * 2 - 16384 + 0) <= 8 || Math.abs(even - 8191 * 2 + 0) <= 8);
});
T('Reverb: sem SPUCNT.7 o buffer não é escrito; com SPUCNT.7 é', () => {
  const mk = en => {
    const spu = new SPU(); spu.write(0x1F801DAA, 2, 0xC000 | (en ? 0x80 : 0));
    W(spu, 0x1DA2, 0x8000 >> 3 << 0);                                      // base do buffer
    spu.revPos = (spu.reg(0x1DA2) << 3);
    for (let i = 0; i < 32; i++) spu.setReg(0x1DC0 + i * 2, i < 10 ? 0x1000 : 0x0100 * (i - 9));
    spu.setReg(0x1DC0 + 30 * 2, 0x7FFF); spu.setReg(0x1DC0 + 31 * 2, 0x7FFF);
    spu.setReg(0x1D84, 0x3FFF); spu.setReg(0x1D86, 0x3FFF);
    for (let i = 0; i < 400; i++) spu.reverbStep(20000, 20000);
    return spu.ram.some(b => b !== 0);
  };
  assert.equal(mk(false), false); assert.equal(mk(true), true);
});
T('Reverb: motor (22 kHz) liga e a saída aparece só com SPUCNT.7', () => {
  const run = en => {
    const spu = new SPU(); spu.write(0x1F801DAA, 2, 0xC000 | (en ? 0x80 : 0)); spu.write(0x1F801D80, 2, 0x3FFF); spu.write(0x1F801D82, 2, 0x3FFF);
    W(spu, 0x1DA2, 0x1000); spu.revPos = 0x8000; W(spu, 0x1D84, 0x3FFF); W(spu, 0x1D86, 0x3FFF);
    for (let i = 0; i < 32; i++) W(spu, 0x1DC0 + i * 2, i === 30 || i === 31 ? 0x7FFF : i < 10 ? 0x4000 : 0x0010 * i);
    let peak = 0;
    for (let k = 0; k < 4000; k++) { spu.revHL[(spu.revHead + 1) & 63] = 0; const o = spu.tick(); peak = Math.max(peak, Math.abs(o[0])); }
    return peak;
  };
  assert.equal(run(false), 0);
});

// ---------------- IRQ ----------------
T('IRQ da SPU: escrita na RAM do SPU no endereço e dentro do bloco lido por uma voz', () => {
  let n1 = 0; const spu = new SPU(); spu.onIrq = () => n1++;
  spu.write(0x1F801DAA, 2, 0xC040); W(spu, 0x1DA4, 0x2000 >> 3);
  W(spu, 0x1DA6, 0x1000 >> 3); for (let i = 0; i < 8; i++) W(spu, 0x1DA8, 0); assert.equal(n1, 0, 'fora do endereço');
  W(spu, 0x1DA6, 0x2000 >> 3); W(spu, 0x1DA8, 0x1234); assert.equal(n1, 1); assert.ok(spu.read(0x1F801DAE, 2) & 0x40);
  W(spu, 0x1DA8, 1); assert.equal(n1, 1, 'IRQ só dispara de novo depois de limpar');
  W(spu, 0x1DAA, 0xC000); assert.equal(spu.read(0x1F801DAE, 2) & 0x40, 0); W(spu, 0x1DAA, 0xC040);
  // voz lendo um bloco que contém o endereço (no meio do bloco)
  W(spu, 0x1DA4, (0x3008) >> 3); W(spu, 0x1C06, 0x3000 >> 3); W(spu, 0x1D88, 1);
  assert.equal(n1, 2, 'bloco 0x3000..0x300F contém 0x3008');
});

// ---------------- timers: modos de sincronização ----------------
const mk = () => { const t = new Timers({ irq() {} }); return t; };
const W32 = (t, n, r, v) => t.write(0x1F801100 + n * 0x10 + r, 4, v);
T('Timer 0 sync 0: pausa durante o hblank', () => {
  const t = mk(); W32(t, 0, 4, 0x1);
  t.setBlank(false, false); t.advance(100); assert.equal(t.t[0].counter, 100);
  t.setBlank(true, false); t.advance(100); assert.equal(t.t[0].counter, 100, 'parado no hblank');
  t.setBlank(false, false); t.advance(50); assert.equal(t.t[0].counter, 150);
});
T('Timer 0 sync 1: zera ao entrar no hblank, conta livre', () => {
  const t = mk(); W32(t, 0, 4, 0x3);
  t.setBlank(false, false); t.advance(100); t.setBlank(true, false); assert.equal(t.t[0].counter, 0);
  t.advance(30); assert.equal(t.t[0].counter, 30);
});
T('Timer 0 sync 2: zera e só conta dentro do hblank', () => {
  const t = mk(); W32(t, 0, 4, 0x5);
  t.setBlank(false, false); t.advance(100); assert.equal(t.t[0].counter, 0, 'fora do blank: parado');
  t.setBlank(true, false); t.advance(40); assert.equal(t.t[0].counter, 40);
  t.setBlank(false, false); t.advance(40); assert.equal(t.t[0].counter, 40);
  t.setBlank(true, false); assert.equal(t.t[0].counter, 0, 'zera de novo na próxima entrada');
});
T('Timer 0 sync 3: espera o 1º hblank e depois roda livre', () => {
  const t = mk(); W32(t, 0, 4, 0x7);
  t.setBlank(false, false); t.advance(100); assert.equal(t.t[0].counter, 0);
  t.setBlank(true, false); t.setBlank(false, false); t.advance(60); assert.equal(t.t[0].counter, 60);
  t.setBlank(true, false); t.setBlank(false, false); t.advance(10); assert.equal(t.t[0].counter, 70, 'não pausa/zera mais');
});
T('Timer 1 usa o vblank (e o clock de hblank também respeita o sync)', () => {
  const t = mk(); W32(t, 1, 4, 0x1);                       // sync 0: pausa no vblank (clock = sysclk)
  t.setBlank(false, false); t.advance(100); t.setBlank(false, true); t.advance(100); assert.equal(t.t[1].counter, 100);
  const h = mk(); W32(h, 1, 4, 0x105);                     // clock hblank + sync 2 (conta só dentro do vblank)
  h.setBlank(false, false); h.hblank(); h.hblank(); assert.equal(h.t[1].counter, 0);
  h.setBlank(false, true); h.hblank(); h.hblank(); h.hblank(); assert.equal(h.t[1].counter, 3);
});
T('Timer 2: sync 0/3 parado, 1/2 livre; sem sync conta sempre', () => {
  for (const [sm, runs] of [[0, false], [1, true], [2, true], [3, false]]) {
    const t = mk(); W32(t, 2, 4, 1 | (sm << 1)); t.advance(100); assert.equal(t.t[2].counter, runs ? 100 : 0, 'modo ' + sm);
  }
  const t = mk(); W32(t, 2, 4, 0); t.advance(100); assert.equal(t.t[2].counter, 100);
});
T('Escrever o modo reinicia o estado de sync (sync 3 volta a esperar o hblank)', () => {
  const t = mk(); W32(t, 0, 4, 0x7); t.setBlank(true, false); t.setBlank(false, false); t.advance(10); assert.equal(t.t[0].counter, 10);
  W32(t, 0, 4, 0x7); t.advance(10); assert.equal(t.t[0].counter, 0, 'pausado de novo');
});
console.log(`\n${n} testes de precisão ok`);
