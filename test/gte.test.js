import assert from 'node:assert/strict';
import { GTE } from '../src/gte.js';
import { PSX } from '../src/psx.js';

let n = 0; const T = (name, fn) => { fn(); n++; console.log('  ok  ', name); };
const s16 = v => (v << 16) >> 16;
const pack = (lo, hi) => ((hi << 16) | (lo & 0xFFFF)) | 0;
// comando: opcode | sf<<19 | mx<<17 | vx<<15 | tx<<13 | lm<<10
const CMD = (op, { sf = 1, lm = 0, mx = 0, vx = 0, tx = 0 } = {}) => (op | (sf << 19) | (mx << 17) | (vx << 15) | (tx << 13) | (lm << 10)) >>> 0;
const RTPS = 0x01, NCLIP = 0x06, OP = 0x0C, DPCS = 0x10, MVMVA = 0x12, NCDS = 0x13, NCCS = 0x1B, NCS = 0x1E, SQR = 0x28, AVSZ3 = 0x2D, AVSZ4 = 0x2E, RTPT = 0x30, GPF = 0x3D;
const bit = (g, b) => (g.readCtrl(31) >>> b) & 1;

function setup({ rt = [0x1000, 0, 0, 0, 0x1000, 0, 0, 0, 0x1000], tr = [0, 0, 0], h = 256, ofx = 0, ofy = 0, dqa = 0, dqb = 0 } = {}) {
  const g = new GTE();
  g.writeCtrl(0, pack(rt[0], rt[1])); g.writeCtrl(1, pack(rt[2], rt[3])); g.writeCtrl(2, pack(rt[4], rt[5])); g.writeCtrl(3, pack(rt[6], rt[7])); g.writeCtrl(4, rt[8]);
  g.writeCtrl(5, tr[0]); g.writeCtrl(6, tr[1]); g.writeCtrl(7, tr[2]);
  g.writeCtrl(24, ofx); g.writeCtrl(25, ofy); g.writeCtrl(26, h); g.writeCtrl(27, dqa); g.writeCtrl(28, dqb);
  return g;
}
const setV = (g, i, x, y, z) => { g.writeData(i * 2, pack(x, y)); g.writeData(i * 2 + 1, z); };
const sxy = (g, i) => { const w = g.readData(12 + i); return [s16(w), w >> 16]; };

T('registradores: sinal em VZ/IR/H, OTZ/SZ sem sinal, SXYP empurra a FIFO, LZCR, IRGB/ORGB', () => {
  const g = new GTE();
  g.writeData(1, 0x8000); assert.equal(g.readData(1), -32768); g.writeData(9, 0xFFFF); assert.equal(g.readData(9), -1);
  g.writeData(7, 0x1FFFF); assert.equal(g.readData(7), 0xFFFF); g.writeData(19, -1); assert.equal(g.readData(19), 0xFFFF);
  g.writeCtrl(26, 0xFFFF); assert.equal(g.readCtrl(26), -1, 'H lê com sinal (bug do hardware)');
  g.writeData(15, 0x11111111); g.writeData(15, 0x22222222); g.writeData(15, 0x33333333);
  assert.deepEqual([g.readData(12), g.readData(13), g.readData(14), g.readData(15)], [0x11111111, 0x22222222, 0x33333333, 0x33333333]);
  for (const [v, z] of [[0, 32], [-1, 32], [1, 31], [0x80000000 | 0, 1], [0x00FF0000, 8], [-0x00FF0001, 8]]) { g.writeData(30, v); assert.equal(g.readData(31), z, 'lzcs=' + v); }
  g.writeData(28, 0x7FFF); assert.deepEqual([g.readData(9), g.readData(10), g.readData(11)], [0xF80, 0xF80, 0xF80]); assert.equal(g.readData(29), 0x7FFF);
  g.writeData(9, 0x4000); g.writeData(10, -5); assert.equal(g.readData(29) & 0x3FF, 0x1F | 0);   // IR1 sat 1F, IR2 negativo -> 0
});

T('matrizes: ctrl regs são desempacotados (RT, luz, cor) e RT33 lê com sinal', () => {
  const g = setup({ rt: [1, -2, 3, -4, 5, -6, 7, -8, -9] });
  assert.deepEqual([...g.rt], [1, -2, 3, -4, 5, -6, 7, -8, -9]); assert.equal(g.readCtrl(4), -9);
  g.writeCtrl(8, pack(11, 12)); g.writeCtrl(12, 13); g.writeCtrl(16, pack(21, 22)); g.writeCtrl(20, 23);
  assert.deepEqual([g.ll[0], g.ll[1], g.ll[8], g.lc[0], g.lc[1], g.lc[8]], [11, 12, 13, 21, 22, 23]);
});

T('divisão UNR ≈ (H*65536)/SZ3 (erro ≤ 3) e overflow (H >= 2*SZ3) -> 0x1FFFF + flag 17', () => {
  const g = new GTE(); let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7FFFFFFF) / 0x7FFFFFFF;
  for (let t = 0; t < 3000; t++) {
    const sz = 1 + Math.floor(rnd() * 0xFFFE), h = Math.floor(rnd() * Math.min(0xFFFF, sz * 2 - 1)) + 1;
    const r = g.divide(h, sz), ref = Math.min(0x1FFFF, Math.round(h * 65536 / sz));
    assert.ok(Math.abs(r - ref) <= 3, `h=${h} sz=${sz}: ${r} vs ${ref}`);
  }
  g.flag = 0; assert.equal(g.divide(600, 300), 0x1FFFF); assert.ok(g.flag & (1 << 17)); g.flag = 0; assert.equal(g.divide(5, 0), 0x1FFFF);
});

T('RTPS com matriz identidade: IR=V, SZ3=z, SX/SY = H*x/z', () => {
  const g = setup({ h: 256 }); setV(g, 0, 100, 200, 300); g.command(CMD(RTPS));
  assert.deepEqual([g.readData(9), g.readData(10), g.readData(11)], [100, 200, 300]); assert.equal(g.readData(19), 300);
  const [x, y] = sxy(g, 2); assert.ok(Math.abs(x - 85) <= 1 && Math.abs(y - 170) <= 1, `sx=${x} sy=${y}`); assert.equal(g.readCtrl(31), 0);
});

T('RTPS com rotação, translação, OFX/OFY e depth cue ≈ projeção em ponto flutuante', () => {
  let seed = 99; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7FFFFFFF) / 0x7FFFFFFF;
  for (let t = 0; t < 200; t++) {
    const a = rnd() * 6.28, c = Math.round(Math.cos(a) * 4096), s = Math.round(Math.sin(a) * 4096);
    const rt = [c, -s, 0, s, c, 0, 0, 0, 4096], tr = [Math.round((rnd() - .5) * 400), Math.round((rnd() - .5) * 400), 800 + Math.round(rnd() * 3000)];
    const g = setup({ rt, tr, h: 200 + Math.floor(rnd() * 600), ofx: Math.round(rnd() * 64) << 16, ofy: Math.round(rnd() * 64) << 16, dqa: 50 + Math.round(rnd() * 100), dqb: 0x800000 });
    const v = [Math.round((rnd() - .5) * 400), Math.round((rnd() - .5) * 400), Math.round(rnd() * 400)]; setV(g, 0, ...v); g.command(CMD(RTPS));
    const X = (rt[0] * v[0] + rt[1] * v[1] + rt[2] * v[2]) / 4096 + tr[0], Y = (rt[3] * v[0] + rt[4] * v[1] + rt[5] * v[2]) / 4096 + tr[1], Z = (rt[6] * v[0] + rt[7] * v[1] + rt[8] * v[2]) / 4096 + tr[2];
    const H = g.readCtrl(26) & 0xFFFF, sx = (g.readCtrl(24) / 65536) + H * X / Z, sy = (g.readCtrl(25) / 65536) + H * Y / Z;
    const [rx, ry] = sxy(g, 2); assert.ok(Math.abs(rx - Math.max(-1024, Math.min(1023, sx))) <= 1.5, `t=${t} sx ${rx} vs ${sx.toFixed(2)}`); assert.ok(Math.abs(ry - Math.max(-1024, Math.min(1023, sy))) <= 1.5, `t=${t} sy`);
    assert.ok(Math.abs(g.readData(19) - Math.max(0, Math.min(65535, Math.floor(Z)))) <= 1, 'SZ3');
    const ir0 = ((H * 65536 / Z) * g.readCtrl(27) + g.readCtrl(28)) / 4096;                           // (n*DQA + DQB) >> 12
    assert.ok(Math.abs(g.readData(8) - Math.max(0, Math.min(4096, ir0))) <= 4, `IR0 ${g.readData(8)} vs ${ir0.toFixed(1)}`);
  }
});

T('RTPT: 3 vértices entram na FIFO na ordem V0,V1,V2 (SXY0..2 e SZ1..3)', () => {
  const g = setup({ h: 100 }); setV(g, 0, 10, 0, 100); setV(g, 1, 0, 20, 200); setV(g, 2, -30, 0, 300); g.command(CMD(RTPT));
  const pts = [0, 1, 2].map(i => sxy(g, i));
  assert.ok(Math.abs(pts[0][0] - 10) <= 1 && pts[0][1] === 0); assert.ok(pts[1][0] === 0 && Math.abs(pts[1][1] - 10) <= 1); assert.ok(Math.abs(pts[2][0] + 10) <= 1 && pts[2][1] === 0);
  assert.deepEqual([g.readData(17), g.readData(18), g.readData(19)], [100, 200, 300]); assert.equal(g.readCtrl(31), 0);
  const o = setup({ h: 256 }); setV(o, 0, 10, 0, 100); o.command(CMD(RTPS));                                  // H >= 2*SZ3: o hardware satura a divisão
  assert.ok(bit(o, 17)); assert.ok(sxy(o, 2)[0] >= 19);
});

T('NCLIP: sinal = orientação do triângulo', () => {
  const g = new GTE(); g.writeData(12, pack(0, 0)); g.writeData(13, pack(10, 0)); g.writeData(14, pack(0, 10)); g.command(CMD(NCLIP)); assert.equal(g.readData(24), 100);
  g.writeData(12, pack(0, 0)); g.writeData(13, pack(0, 10)); g.writeData(14, pack(10, 0)); g.command(CMD(NCLIP)); assert.equal(g.readData(24), -100);
});

T('AVSZ3/AVSZ4 -> OTZ, com saturação e flag 18', () => {
  const g = new GTE(); for (const [i, z] of [[16, 100], [17, 200], [18, 300], [19, 400]]) g.writeData(i, z);
  g.writeCtrl(29, 0x155); g.command(CMD(AVSZ3)); assert.equal(g.readData(7), (0x155 * 900) >> 12); assert.equal(g.readData(24), 0x155 * 900);
  g.writeCtrl(30, 0x100); g.command(CMD(AVSZ4)); assert.equal(g.readData(7), (0x100 * 1000) >> 12);
  g.writeData(17, 0xFFFF); g.writeData(18, 0xFFFF); g.writeData(19, 0xFFFF); g.writeCtrl(29, 0x7FFF); g.command(CMD(AVSZ3)); assert.equal(g.readData(7), 0xFFFF); assert.ok(bit(g, 18) && bit(g, 31));
});

T('SQR, OP e MVMVA (matriz, vetor, translação)', () => {
  const g = setup(); g.writeData(9, 100); g.writeData(10, 200); g.writeData(11, 300);
  g.command(CMD(SQR, { sf: 0 })); assert.deepEqual([g.readData(25), g.readData(26), g.readData(27)], [10000, 40000, 90000]);
  assert.equal(g.readData(10), 0x7FFF); assert.ok(bit(g, 23) && bit(g, 31) && !bit(g, 24));                        // IR2 saturou
  const h = setup(); h.writeData(9, 1); h.writeData(10, 2); h.writeData(11, 3); h.command(CMD(OP));
  assert.deepEqual([h.readData(25), h.readData(26), h.readData(27)], [1, 0, 0].map((v, i) => [(3 * 4096 - 2 * 4096) >> 12, (1 * 4096 - 3 * 4096) >> 12, (2 * 4096 - 1 * 4096) >> 12][i]));
  const m = setup({ tr: [10, 20, 30] }); setV(m, 1, 5, 6, 7); m.command(CMD(MVMVA, { vx: 1, tx: 0 }));       // RT * V1 + TR
  assert.deepEqual([m.readData(9), m.readData(10), m.readData(11)], [15, 26, 37]);
  const m2 = setup(); m2.writeCtrl(13, 100); m2.writeCtrl(14, 200); m2.writeCtrl(15, 300); m2.writeData(9, 1); m2.writeData(10, 2); m2.writeData(11, 3);
  m2.command(CMD(MVMVA, { vx: 3, tx: 1 })); assert.deepEqual([m2.readData(9), m2.readData(10), m2.readData(11)], [101, 202, 303]);                  // RT * IR + BK
  const m3 = setup(); m3.writeData(9, -5); m3.command(CMD(MVMVA, { vx: 3, tx: 3, lm: 1 })); assert.equal(m3.readData(9), 0); assert.ok(bit(m3, 24));    // lm=1 satura em 0
});

T('flags: overflow de 44 bits em MAC1, saturação de SX2 e erro (bit 31)', () => {
  const g = setup({ tr: [0x7FFFFFFF, 0, 0] }); setV(g, 0, 0x7FFF, 0, 100); g.writeCtrl(0, pack(0x7FFF, 0)); g.command(CMD(RTPS));
  assert.ok(bit(g, 30), 'MAC1 overflow positivo'); assert.ok(bit(g, 31));
  const h = setup({ h: 1000 }); setV(h, 0, 20000, 0, 1000); h.command(CMD(RTPS)); assert.equal(sxy(h, 2)[0], 0x3FF); assert.ok(bit(h, 14) && bit(h, 31));
  const k = setup({ tr: [-0x7FFFFFFF, 0, 0] }); k.writeCtrl(0, pack(0x7FFF, 0)); setV(k, 0, -0x7FFF, 0, 100); k.command(CMD(RTPS)); assert.ok(bit(k, 27), 'MAC1 overflow negativo');
  const z = setup(); setV(z, 0, 1, 1, 0); z.command(CMD(RTPS)); assert.ok(bit(z, 17), 'divisão por SZ3=0'); assert.equal(sxy(z, 2)[0], 1, '0x1FFFF * IR1(1) >> 16');
});

T('luz e cor: NCS, NCCS e NCDS (interpolação com FC), DPCS, GPF', () => {
  const lights = () => { const g = setup(); for (const r of [8, 9, 10, 11, 12, 16, 17, 18, 19, 20]) g.writeCtrl(r, 0);
    g.writeCtrl(8, pack(0x1000, 0)); g.writeCtrl(10, pack(0x1000, 0)); g.writeCtrl(12, 0x1000);       // LLM = identidade
    g.writeCtrl(16, pack(0x1000, 0)); g.writeCtrl(18, pack(0x1000, 0)); g.writeCtrl(20, 0x1000);       // LCM = identidade
    return g; };
  let g = lights(); setV(g, 0, 0x800, 0x400, 0x200); g.writeData(6, 0x44201080 | 0); g.command(CMD(NCS, { lm: 1 }));
  assert.equal(g.readData(22) & 0xFFFFFF, 0x20_40_80 >>> 0 & 0xFFFFFF ? (0x20 << 16) | (0x40 << 8) | 0x80 : 0, 'NCS: cor = IR>>4');
  g = lights(); setV(g, 0, 0x800, 0x400, 0x200); g.writeData(6, 0x44201080 | 0);
  g.command(CMD(NCCS, { lm: 1 })); const c = g.readData(22); assert.equal(c >>> 24, 0x44, 'CODE preservado');
  assert.equal(c & 255, (0x80 * 0x800 * 16 >> 12) >> 4); assert.equal((c >> 8) & 255, (0x10 * 0x400 * 16 >> 12) >> 4); assert.equal((c >> 16) & 255, (0x20 * 0x200 * 16 >> 12) >> 4);
  g = lights(); setV(g, 0, 0x800, 0x400, 0x200); g.writeData(6, 0x00201080); g.writeData(8, 0); g.command(CMD(NCDS, { lm: 1 })); assert.equal(g.readData(22) & 255, 0x40, 'IR0=0: sem névoa (igual ao NCCS)');
  g = lights(); setV(g, 0, 0x800, 0x400, 0x200); g.writeData(6, 0x00201080); g.writeData(8, 0x1000); g.writeCtrl(21, 0x400); g.writeCtrl(22, 0); g.writeCtrl(23, 0);
  g.command(CMD(NCDS, { lm: 1 })); assert.ok(Math.abs((g.readData(22) & 255) - 0x40) <= 1, 'IR0=1.0: cor = FC (0x400>>4)');
  const d = setup(); d.writeData(6, 0x00201080); d.writeData(8, 0); d.command(CMD(DPCS)); assert.deepEqual([d.readData(22) & 255, (d.readData(22) >> 8) & 255, (d.readData(22) >> 16) & 255], [0x80, 0x10, 0x20]);
  d.writeData(8, 0x1000); d.writeCtrl(21, 0x1000); d.writeCtrl(22, 0x1000); d.writeCtrl(23, 0x1000); d.command(CMD(DPCS)); assert.ok(Math.abs((d.readData(22) & 255) - 0xFF) <= 1, 'DPCS -> FC (saturado em FF)');
  const p = setup(); p.writeData(9, 100); p.writeData(10, 200); p.writeData(11, 300); p.writeData(8, 0x1000); p.command(CMD(GPF));
  assert.deepEqual([p.readData(25), p.readData(26), p.readData(27)], [100, 200, 300]); assert.deepEqual([p.readData(22) & 255, (p.readData(22) >> 8) & 255, (p.readData(22) >> 16) & 255], [6, 12, 18]);
});

T('FIFO de cor satura em 0..255 e acende as flags 21-19', () => {
  const g = setup(); g.writeData(6, 0x00000000); g.writeData(9, 0x7000); g.writeData(10, 0); g.writeData(11, 0); g.writeData(8, 0x1000); g.command(CMD(GPF, { lm: 1 }));
  assert.equal(g.readData(22) & 255, 255); assert.ok(bit(g, 21) && !bit(g, 31), 'flags 21-19 não entram no bit de erro');
});

// ---- a CPU executando instruções COP2 (valida o mapeamento CTC2/CFC2: índice 0..31 = cop2r32..63) ----
const COP2 = (rs, rt, rd) => ((0x12 << 26) | (rs << 21) | (rt << 16) | (rd << 11)) >>> 0;
const MTC2 = (rt, rd) => COP2(4, rt, rd), CTC2 = (rt, rd) => COP2(6, rt, rd), MFC2 = (rt, rd) => COP2(0, rt, rd), CFC2 = (rt, rd) => COP2(2, rt, rd);
const LUI = (rt, i) => ((15 << 26) | (rt << 16) | i) >>> 0, ORI = (rt, rs, i) => ((13 << 26) | (rs << 21) | (rt << 16) | i) >>> 0;
const li = (r, v) => [LUI(r, v >>> 16), ORI(r, r, v & 0xFFFF)];

T('CPU executa mtc2/ctc2/cop2 RTPS/mfc2/cfc2 (pelo barramento da máquina)', () => {
  const psx = new PSX(), cpu = psx.cpu, base = 0x80010000;
  cpu.cop0[12] = 0x40000000;                                                   // CU2 ligado
  const prog = [
    ...li(8, 0x1000), CTC2(8, 0), CTC2(8, 2), CTC2(8, 4),                       // RT11 = RT22 = RT33 = 0x1000
    ...li(9, 256), CTC2(9, 26),                                                 // H = 256
    ...li(10, (200 << 16) | 100), MTC2(10, 0), ...li(11, 300), MTC2(11, 1),     // V0 = (100,200,300)
    ...li(12, 0x4A080001), 0,                                                    // placeholder p/ montar abaixo
  ];
  prog.length -= 2; prog.push(0x4A080001);                                      // cop2 RTPS sf=1
  prog.push(MFC2(13, 14), MFC2(14, 19), CFC2(15, 26), CFC2(16, 31), 0);
  prog.forEach((w, i) => psx.bus.write32(base + i * 4, w)); cpu.pc = base; cpu.nextPc = base + 4;
  for (let i = 0; i < prog.length + 2; i++) cpu.step();
  const sx = s16(cpu.r[13]), sy = cpu.r[13] >> 16; assert.ok(Math.abs(sx - 85) <= 1 && Math.abs(sy - 170) <= 1, `sx=${sx} sy=${sy}`);
  assert.equal(cpu.r[14], 300); assert.equal(cpu.r[15] | 0, 256); assert.equal(cpu.r[16], 0);
  assert.equal(psx.cpu.gte.commandCount, 1);
});
console.log(`${n} testes de GTE passaram`);
