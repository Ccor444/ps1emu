/* PS1 Emu - bundle gerado por build.js (não edite) */
(function (global) {
"use strict";
const __src_gte = (() => {
// ============================================================================
//  GTE (COP2) - Geometry Transformation Engine
//  Registradores: 32 de dados (cop2r0-31) e 32 de controle (cop2r32-63), acessados por
//  MFC2/MTC2/CFC2/CTC2/LWC2/SWC2 (a CPU passa 0..31; os de controle são somados a 32 aqui)
//  e por comandos "cop2 imm25".
//
//  Aritmética: MAC1-3 acumulam em 44 bits com sinal (detecção de overflow a cada soma),
//  MAC0 em 32 bits. Os valores cabem em doubles (< 2^53), então usamos Number puro (sem BigInt).
//  Flags (reg 63): bits 30-25 overflow MAC1-3 (+/-), 24-22 IR1-3 saturado, 21-19 FIFO de cor,
//  18 SZ3/OTZ, 17 divisão, 16/15 MAC0 (+/-), 14/13 SX2/SY2, 12 IR0; bit 31 = erro (OU de 30-23 e 18-13).
//
//  Comando (25 bits): b5-0 opcode, b10 lm, b14-13 MVMVA translation, b16-15 MVMVA vetor,
//  b18-17 MVMVA matriz, b19 sf (1 = resultado >> 12).
//  Não emulado: ciclos reais de cada comando (a CPU não "trava" lendo registrador ocupado).
// ============================================================================
const M44 = 17592186044416, H44 = 8796093022208;                 // 2^44, 2^43
const wrap44 = v => (v >= H44 || v < -H44) ? ((((v + H44) % M44) + M44) % M44) - H44 : v;
const trunc32 = v => (v >= -2147483648 && v <= 2147483647) ? v : ((((v % 4294967296) + 4294967296) % 4294967296) | 0);
const s16 = v => (v << 16) >> 16;
const clampv = (v, lo, hi) => v < lo ? lo : v > hi ? hi : v;
const sar = (v, sf) => sf ? Math.floor(v / 4096) : v;            // sf = 0 ou 1  (>> 12)

// tabela da divisão Newton-Raphson (UNR): max(0, ((0x40000/(i+0x100)+1)/2) - 0x101)
const UNR = new Int32Array(257);
for (let i = 0; i <= 256; i++) UNR[i] = Math.max(0, ((((0x40000 / (i + 0x100)) | 0) + 1) >> 1) - 0x101);

class GTE {
  constructor() {
    this.d = new Int32Array(32); this.c = new Int32Array(64);     // c indexado por nº do registrador (32..63)
    this.rt = new Int16Array(9); this.ll = new Int16Array(9); this.lc = new Int16Array(9);
    this.flag = 0; this.commandCount = 0; this.lastCommand = 0;
  }
  reset() { this.d.fill(0); this.c.fill(0); this.rt.fill(0); this.ll.fill(0); this.lc.fill(0); this.flag = 0; }

  // ---------------------------------------------------------------- registradores
  readData(i) {
    const d = this.d;
    switch (i) {
      case 1: case 3: case 5: case 8: case 9: case 10: case 11: return s16(d[i]);       // VZn, IR0-3
      case 7: case 16: case 17: case 18: case 19: return d[i] & 0xFFFF;                 // OTZ, SZ0-3
      case 15: return d[14];                                                            // SXYP lê SXY2
      case 28: case 29: return this.orgb();
      case 31: return this.lzcr();
      default: return d[i];
    }
  }
  writeData(i, v) {
    const d = this.d; v |= 0;
    switch (i) {
      case 1: case 3: case 5: case 8: case 9: case 10: case 11: d[i] = s16(v); return;
      case 7: case 16: case 17: case 18: case 19: d[i] = v & 0xFFFF; return;
      case 15: d[12] = d[13]; d[13] = d[14]; d[14] = v; return;                         // SXYP: empurra a FIFO
      case 28: d[28] = v; d[9] = (v & 0x1F) * 0x80; d[10] = ((v >> 5) & 0x1F) * 0x80; d[11] = ((v >> 10) & 0x1F) * 0x80; return;
      case 29: case 31: return;                                                         // somente leitura
      default: d[i] = v;
    }
  }
  orgb() { const d = this.d, f = x => clampv(s16(x) >> 7, 0, 0x1F); return f(d[9]) | (f(d[10]) << 5) | (f(d[11]) << 10); }
  lzcr() { const v = this.d[30]; return v >= 0 ? Math.clz32(v) : Math.clz32(~v); }      // bits iguais ao sinal (v=0 -> 32)

  /** CFC2: n = 0..31 (cop2r32..63) */
  readCtrl(n) {
    const i = n + 32, c = this.c;
    switch (i) {
      case 36: case 44: case 52: case 59: case 61: case 62: case 58: return s16(c[i]);  // RT33/L33/LB3, DQA, ZSF, H (H lê com sinal: bug do hw)
      case 63: return (this.flag | ((this.flag & 0x7F87E000) ? 0x80000000 : 0)) | 0;
      default: return c[i];
    }
  }
  /** CTC2 */
  writeCtrl(n, v) {
    const i = n + 32; v |= 0; const c = this.c;
    if (i === 63) { this.flag = v & 0x7FFFF000; return; }
    c[i] = i === 58 ? (v & 0xFFFF) : v;                                                  // H é unsigned 16 em uso
    if (i <= 36) this.unpack(this.rt, 32);
    else if (i >= 40 && i <= 44) this.unpack(this.ll, 40);
    else if (i >= 48 && i <= 52) this.unpack(this.lc, 48);
  }
  unpack(m, base) { const c = this.c; for (let e = 0; e < 9; e++) { const w = c[base + (e >> 1)]; m[e] = (e & 1) ? (w >> 16) : s16(w); } }

  // ---------------------------------------------------------------- utilitários de cálculo
  chk(i, v) {                                                                            // MAC1-3: flags de overflow 44 bits
    if (v >= H44) this.flag |= 1 << (31 - i); else if (v < -H44) this.flag |= 1 << (28 - i);
    return wrap44(v);
  }
  chk0(v) { if (v > 2147483647) this.flag |= 1 << 16; else if (v < -2147483648) this.flag |= 1 << 15; return v; }
  setMac(i, v, sf) { const m = trunc32(sar(v, sf)); this.d[24 + i] = m; return m; }
  setIr(i, v, lm) {
    const lo = lm ? 0 : -0x8000; let r = v;
    if (v < lo) { r = lo; this.flag |= 1 << (25 - i); } else if (v > 0x7FFF) { r = 0x7FFF; this.flag |= 1 << (25 - i); }
    this.d[8 + i] = r;
  }
  setMacIr(i, v, sf, lm) { this.setIr(i, this.setMac(i, v, sf), lm); }
  pushSZ(v) {
    const d = this.d; let r = v;
    if (v < 0) { r = 0; this.flag |= 1 << 18; } else if (v > 0xFFFF) { r = 0xFFFF; this.flag |= 1 << 18; }
    d[16] = d[17]; d[17] = d[18]; d[18] = d[19]; d[19] = r;
  }
  pushSXY(x, y) {
    const d = this.d;
    if (x < -0x400) { x = -0x400; this.flag |= 1 << 14; } else if (x > 0x3FF) { x = 0x3FF; this.flag |= 1 << 14; }
    if (y < -0x400) { y = -0x400; this.flag |= 1 << 13; } else if (y > 0x3FF) { y = 0x3FF; this.flag |= 1 << 13; }
    d[12] = d[13]; d[13] = d[14]; d[14] = (y << 16) | (x & 0xFFFF);
  }
  pushColor() {                                                                          // FIFO de cor a partir de MAC1-3 >> 4
    const d = this.d; let cc = 0;
    for (let i = 0; i < 3; i++) {
      let v = d[25 + i] >> 4;
      if (v < 0) { v = 0; this.flag |= 1 << (21 - i); } else if (v > 255) { v = 255; this.flag |= 1 << (21 - i); }
      cc |= v << (8 * i);
    }
    d[20] = d[21]; d[21] = d[22]; d[22] = (cc | (d[6] & 0xFF000000)) | 0;
  }
  vec(n) { const d = this.d; return n === 0 ? [s16(d[0]), d[0] >> 16, s16(d[1])] : n === 1 ? [s16(d[2]), d[2] >> 16, s16(d[3])] : [s16(d[4]), d[4] >> 16, s16(d[5])]; }
  ir() { const d = this.d; return [d[9], d[10], d[11]]; }
  rgb() { const w = this.d[6]; return [w & 255, (w >> 8) & 255, (w >> 16) & 255]; }

  /** MACi = (tr*0x1000 + M*v) >> sf ; IRi = lim(MACi). Devolve os 3 valores de 44 bits (antes do shift). */
  mulMat(M, v, tr, sf, lm, setIr = true) {
    const out = [0, 0, 0];
    for (let r = 0; r < 3; r++) {
      let t = tr ? tr[r] * 4096 : 0;
      t = this.chk(r + 1, t + M[r * 3] * v[0]); t = this.chk(r + 1, t + M[r * 3 + 1] * v[1]); t = this.chk(r + 1, t + M[r * 3 + 2] * v[2]);
      out[r] = t; this.setMac(r + 1, t, sf);
      if (setIr) this.setIr(r + 1, this.d[25 + r], lm);
    }
    return out;
  }

  /** divisão UNR: ~ (H * 0x20000 / SZ3 + 1) / 2, saturada em 0x1FFFF */
  divide(h, sz3) {
    if (h >= sz3 * 2) { this.flag |= 1 << 17; return 0x1FFFF; }
    const z = Math.clz32(sz3) - 16, n = h * Math.pow(2, z); let d = (sz3 << z) >>> 0;   // sz3 tratado como 16 bits
    const u = UNR[(d - 0x7FC0) >> 7] + 0x101;
    d = (0x2000080 - d * u) >> 8; d = (0x80 + d * u) >> 8;
    return Math.min(0x1FFFF, Math.floor((n * d + 0x8000) / 65536));
  }

  // ---------------------------------------------------------------- comandos
  command(cmd) {
    this.commandCount++; this.lastCommand = cmd; this.flag = 0;
    const sf = (cmd >> 19) & 1, lm = (cmd >> 10) & 1, c = this.c;
    switch (cmd & 0x3F) {
      case 0x01: this.rtp(0, true, sf, lm); break;                                       // RTPS
      case 0x30: this.rtp(0, false, sf, lm); this.rtp(1, false, sf, lm); this.rtp(2, true, sf, lm); break;   // RTPT
      case 0x06: this.nclip(); break;                                                    // NCLIP
      case 0x0C: this.op(sf, lm); break;                                                 // OP
      case 0x10: this.dpcs(this.rgb(), sf, lm); break;                                   // DPCS
      case 0x2A: for (let i = 0; i < 3; i++) { const w = this.d[20]; this.dpcs([w & 255, (w >> 8) & 255, (w >> 16) & 255], sf, lm); } break;   // DPCT
      case 0x11: this.intpl(sf, lm); break;                                              // INTPL
      case 0x12: this.mvmva(cmd, sf, lm); break;                                         // MVMVA
      case 0x13: this.nc(this.vec(0), 2, sf, lm); break;                                 // NCDS
      case 0x16: for (let i = 0; i < 3; i++) this.nc(this.vec(i), 2, sf, lm); break;     // NCDT
      case 0x1B: this.nc(this.vec(0), 1, sf, lm); break;                                 // NCCS
      case 0x3F: for (let i = 0; i < 3; i++) this.nc(this.vec(i), 1, sf, lm); break;     // NCCT
      case 0x1E: this.nc(this.vec(0), 0, sf, lm); break;                                 // NCS
      case 0x20: for (let i = 0; i < 3; i++) this.nc(this.vec(i), 0, sf, lm); break;     // NCT
      case 0x14: this.cdp(sf, lm); break;                                                // CDP
      case 0x1C: this.cc(sf, lm); break;                                                 // CC
      case 0x29: this.dcpl(sf, lm); break;                                               // DCPL
      case 0x28: this.sqr(sf, lm); break;                                                // SQR
      case 0x2D: this.avsz(s16(c[61]), 3); break;                                        // AVSZ3
      case 0x2E: this.avsz(s16(c[62]), 4); break;                                        // AVSZ4
      case 0x3D: this.gpf(sf, lm); break;                                                // GPF
      case 0x3E: this.gpl(sf, lm); break;                                                // GPL
      default: break;                                                                    // opcode inválido: sem efeito
    }
  }

  /** transformação de perspectiva de um vértice (RTPS/RTPT) */
  rtp(vi, last, sf, lm) {
    const d = this.d, c = this.c, v = this.vec(vi), tr = [c[37], c[38], c[39]];
    const t = this.mulMat(this.rt, v, tr, sf, lm, false);
    this.setIr(1, d[25], lm); this.setIr(2, d[26], lm);
    // IR3: valor saturado normalmente, mas a flag vem de (soma >> 12) (comportamento do hardware)
    const z12 = Math.floor(t[2] / 4096);
    if (z12 < -0x8000 || z12 > 0x7FFF) this.flag |= 1 << 22;
    d[11] = clampv(d[27], lm ? 0 : -0x8000, 0x7FFF);
    this.pushSZ(z12);
    const n = this.divide(c[58] & 0xFFFF, d[19] & 0xFFFF);
    const m0x = this.chk0(n * s16(d[9]) + c[56]), m0y = this.chk0(n * s16(d[10]) + c[57]);
    d[24] = trunc32(m0y);
    this.pushSXY(Math.floor(m0x / 65536), Math.floor(m0y / 65536));     // sem truncar em 32 bits: o hardware satura o valor completo
    if (last) {
      const m = this.chk0(n * s16(c[59]) + c[60]); d[24] = trunc32(m);
      const ir0 = Math.floor(m / 4096);
      d[8] = clampv(ir0, 0, 0x1000); if (ir0 < 0 || ir0 > 0x1000) this.flag |= 1 << 12;
    }
  }

  nclip() {
    const d = this.d, x0 = s16(d[12]), y0 = d[12] >> 16, x1 = s16(d[13]), y1 = d[13] >> 16, x2 = s16(d[14]), y2 = d[14] >> 16;
    d[24] = trunc32(this.chk0(x0 * y1 + x1 * y2 + x2 * y0 - x0 * y2 - x1 * y0 - x2 * y1));
  }

  op(sf, lm) {                                                                           // produto vetorial com a diagonal de RT
    const r = this.rt, ir = this.ir(), d1 = r[0], d2 = r[4], d3 = r[8];
    this.setMacIr(1, this.chk(1, ir[2] * d2 - ir[1] * d3), sf, lm);
    this.setMacIr(2, this.chk(2, ir[0] * d3 - ir[2] * d1), sf, lm);
    this.setMacIr(3, this.chk(3, ir[1] * d1 - ir[0] * d2), sf, lm);
  }

  /** interpolação em direção à cor de distância (FC): usada por DPCS/INTPL/NCDS/CDP/DCPL */
  interp(mac, sf, lm) {
    const c = this.c, d = this.d, fc = [c[53], c[54], c[55]], ir0 = s16(d[8]);
    for (let i = 0; i < 3; i++) {
      const diff = this.chk(i + 1, fc[i] * 4096 - mac[i]);
      this.setIr(i + 1, trunc32(sar(diff, sf)), false);
      const v = this.chk(i + 1, s16(d[9 + i]) * ir0 + mac[i]);
      this.setMacIr(i + 1, v, sf, lm);
    }
    this.pushColor();
  }
  dpcs(rgb, sf, lm) { this.interp([rgb[0] * 65536, rgb[1] * 65536, rgb[2] * 65536], sf, lm); }
  intpl(sf, lm) { const ir = this.ir(); this.interp([ir[0] * 4096, ir[1] * 4096, ir[2] * 4096], sf, lm); }

  /** normal color: matriz de luz e depois matriz de cor; mode 0=NCS 1=NCCS 2=NCDS */
  nc(v, mode, sf, lm) {
    this.mulMat(this.ll, v, null, sf, lm);
    this.mulMat(this.lc, this.ir(), [this.c[45], this.c[46], this.c[47]], sf, lm);
    if (mode === 0) { this.pushColor(); return; }
    const rgb = this.rgb(), ir = this.ir();
    if (mode === 1) { for (let i = 0; i < 3; i++) this.setMacIr(i + 1, this.chk(i + 1, rgb[i] * ir[i] * 16), sf, lm); this.pushColor(); return; }
    this.interp([0, 1, 2].map(i => this.chk(i + 1, rgb[i] * ir[i] * 16)), sf, lm);
  }
  cdp(sf, lm) {
    this.mulMat(this.lc, this.ir(), [this.c[45], this.c[46], this.c[47]], sf, lm);
    const rgb = this.rgb(), ir = this.ir();
    this.interp([0, 1, 2].map(i => this.chk(i + 1, rgb[i] * ir[i] * 16)), sf, lm);
  }
  cc(sf, lm) {
    this.mulMat(this.lc, this.ir(), [this.c[45], this.c[46], this.c[47]], sf, lm);
    const rgb = this.rgb(), ir = this.ir();
    for (let i = 0; i < 3; i++) this.setMacIr(i + 1, this.chk(i + 1, rgb[i] * ir[i] * 16), sf, lm);
    this.pushColor();
  }
  dcpl(sf, lm) {
    const rgb = this.rgb(), ir = this.ir();
    this.interp([0, 1, 2].map(i => this.chk(i + 1, rgb[i] * ir[i] * 16)), sf, lm);
  }
  sqr(sf, lm) { const ir = this.ir(); for (let i = 0; i < 3; i++) this.setMacIr(i + 1, ir[i] * ir[i], sf, lm); }
  gpf(sf, lm) { const ir = this.ir(), ir0 = s16(this.d[8]); for (let i = 0; i < 3; i++) this.setMacIr(i + 1, this.chk(i + 1, ir[i] * ir0), sf, lm); this.pushColor(); }
  gpl(sf, lm) {
    const ir = this.ir(), ir0 = s16(this.d[8]);
    for (let i = 0; i < 3; i++) this.setMacIr(i + 1, this.chk(i + 1, (sf ? this.d[25 + i] * 4096 : this.d[25 + i]) + ir[i] * ir0), sf, lm);
    this.pushColor();
  }
  avsz(zsf, n) {
    const d = this.d, z = i => d[i] & 0xFFFF;
    const sum = n === 3 ? z(17) + z(18) + z(19) : z(16) + z(17) + z(18) + z(19);
    const m = this.chk0(zsf * sum); d[24] = trunc32(m);
    const o = Math.floor(m / 4096);                                                       // MAC0 sem truncar (hardware)
    if (o < 0) { d[7] = 0; this.flag |= 1 << 18; } else if (o > 0xFFFF) { d[7] = 0xFFFF; this.flag |= 1 << 18; } else d[7] = o;
  }

  mvmva(cmd, sf, lm) {
    const mx = (cmd >> 17) & 3, vx = (cmd >> 15) & 3, tx = (cmd >> 13) & 3, c = this.c, d = this.d;
    const M = mx === 0 ? this.rt : mx === 1 ? this.ll : mx === 2 ? this.lc
      : Int16Array.from([-((d[6] & 255) << 4), (d[6] & 255) << 4, s16(d[8]), this.rt[2], this.rt[2], this.rt[2], this.rt[4], this.rt[4], this.rt[4]]);   // matriz "lixo"
    const v = vx === 3 ? this.ir() : this.vec(vx);
    if (tx === 2) {                                                                      // translation FC: bug do hardware
      for (let r = 0; r < 3; r++) {
        const part = this.chk(r + 1, c[53 + r] * 4096 + M[r * 3] * v[0]);                  // só levanta flags; resultado descartado
        const pv = sar(part, sf), lo = lm ? 0 : -0x8000;                                  // ...inclusive a de saturação de IR da soma parcial
        if (pv < lo || pv > 0x7FFF) this.flag |= 1 << (24 - r);
        const t = this.chk(r + 1, M[r * 3 + 1] * v[1] + M[r * 3 + 2] * v[2]);
        this.setMac(r + 1, t, sf); this.setIr(r + 1, d[25 + r], lm);
      }
      return;
    }
    const tr = tx === 0 ? [c[37], c[38], c[39]] : tx === 1 ? [c[45], c[46], c[47]] : null;
    this.mulMat(M, v, tr, sf, lm);
  }
}

return { GTE };
})();
const __src_cpu = (() => {
// ============================================================================
//  CPU MIPS R3000A (LSI LR33300) do PS1 - interpretador
// ============================================================================
//  Características emuladas:
//   - 32 registradores + HI/LO
//   - Branch delay slot (modelo pc / nextPc)
//   - Load delay slot (1 instrução, com cancelamento e forwarding p/ LWL/LWR)
//   - COP0: SR, CAUSE, EPC, BadVAddr, PRID, breakpoints (só armazenados)
//   - Exceções (IRQ, AdEL, AdES, SYSCALL, BREAK, RI, CpU, Overflow)
//   - Cache isolado (SR.IsC): escritas não chegam à memória
//   - COP2 (GTE): acesso aos registradores; comandos ainda em stub
//
//  NÃO emulado ainda: I-Cache (só importa p/ código auto-modificável),
//  timing real de MULT/DIV, bus error, write buffer, GTE.
// ============================================================================
const { GTE } = __src_gte;
const EXC = { INT: 0, ADEL: 4, ADES: 5, IBE: 6, DBE: 7, SYS: 8, BP: 9, RI: 10, CPU: 11, OV: 12 };

const REG_NAMES = [
  'zero', 'at', 'v0', 'v1', 'a0', 'a1', 'a2', 'a3',
  't0', 't1', 't2', 't3', 't4', 't5', 't6', 't7',
  's0', 's1', 's2', 's3', 's4', 's5', 's6', 's7',
  't8', 't9', 'k0', 'k1', 'gp', 'sp', 'fp', 'ra',
];

// COP0 register indices
const C0_BPC = 3, C0_BDA = 5, C0_JUMPDEST = 6, C0_DCIC = 7, C0_BADVADDR = 8,
      C0_BDAM = 9, C0_BPCM = 11, C0_SR = 12, C0_CAUSE = 13, C0_EPC = 14, C0_PRID = 15;

const SR_IEC = 0x1, SR_KUC = 0x2, SR_ISC = 0x10000, SR_BEV = 0x400000,
      SR_CU0 = 0x10000000, SR_CU2 = 0x40000000;
const SR_WRITE_MASK = 0xF27FFF3F;

const RESET_VECTOR = 0xBFC00000;

// custo extra (ciclos, além do 1 da instrução) de um load, por região e largura (1/2/4 bytes).
// Valores medidos no PS1 real com ps1-tests/cpu/access-time (ciclos por acesso - 1).
const LD_RAM = 4;
function memCost(a, size = 4) {
  const p = a & 0x1FFFFFFF, k = size === 1 ? 0 : size === 2 ? 1 : 2;
  if (p < 0x800000) return LD_RAM;                                                    // RAM
  if (p >= 0x1FC00000) return [6, 12, 24][k];                                         // BIOS ROM (barramento de 8 bits)
  if (p >= 0x1FA00000) return [6, 5, 9][k];                                           // expansão 3
  if (p >= 0x1F800000) {
    if (p < 0x1F800400) return 0;                                                     // scratchpad
    if (p >= 0x1F802000) return [10, 25, 55][k];                                      // expansão 2
    if (p >= 0x1F801C00) return [17, 17, 38][k];                                      // SPU
    if (p >= 0x1F801800 && p < 0x1F801804) return [6, 13, 25][k];                     // CD-ROM
    return 2;                                                                         // registradores de I/O
  }
  if (p >= 0x1F000000) return [5, 12, 24][k];                                         // expansão 1
  return 3;
}

class CPU {
  constructor(bus) {
    this.bus = bus;
    this.gte = new GTE();
    this.r = new Uint32Array(32);
    this.cop0 = new Uint32Array(32);
    this.reset();
  }

  reset() {
    this.r.fill(0);
    this.cop0.fill(0);
    this.hi = 0; this.lo = 0;
    this.pc = RESET_VECTOR;
    this.nextPc = RESET_VECTOR + 4;
    this.currentPc = this.pc;
    this.isBranch = false;     // a instrução atual é um branch/jump?
    this.inDelay = false;      // a instrução atual está num delay slot?
    // load delay: carga pendente vinda da instrução anterior
    this.pendReg = 0; this.pendVal = 0;
    // carga gerada pela instrução atual (vira pendente no próximo passo)
    this.nextLdReg = 0; this.nextLdVal = 0;
    this.wr = 0;               // registrador escrito pela instrução atual
    this.cop0[C0_SR] = SR_BEV; // BEV=1 após reset
    this.cop0[C0_PRID] = 0x00000002;
    this.cycles = 0;
    this.instrCount = 0;
  }

  // -------------------------------------------------------------------------
  //  Helpers
  // -------------------------------------------------------------------------
  setR(i, v) { this.r[i] = v; this.wr = i; }
  setLoad(i, v) { this.nextLdReg = i; this.nextLdVal = v; }

  jump(target) { this.nextPc = target >>> 0; this.isBranch = true; }

  exception(code, cop = 0) {
    const c0 = this.cop0;
    const sr = c0[C0_SR];
    const handler = (sr & SR_BEV) ? 0xBFC00180 : 0x80000080;
    // empilha o modo: (KUo,IEo)<-(KUp,IEp)<-(KUc,IEc)<-0
    c0[C0_SR] = (sr & 0xFFFFFFC0) | ((sr << 2) & 0x3F);
    let cause = (c0[C0_CAUSE] & ~0x3000007C) | (code << 2) | (cop << 28);
    if (this.inDelay) {
      c0[C0_EPC] = (this.currentPc - 4) >>> 0;
      cause |= 0x80000000;                       // BD
    } else {
      c0[C0_EPC] = this.currentPc;
      cause &= 0x7FFFFFFF;
    }
    c0[C0_CAUSE] = cause;
    this.pc = handler;
    this.nextPc = (handler + 4) >>> 0;
    this.isBranch = false;
  }

  addrError(addr, store) {
    this.cop0[C0_BADVADDR] = addr;
    this.exception(store ? EXC.ADES : EXC.ADEL);
  }

  // leitura/escrita de memória com checagem de alinhamento, modo usuário e cache isolado
  rdMem(a, size) {
    if ((a & (size - 1)) !== 0 || ((a & 0x80000000) && (this.cop0[C0_SR] & SR_KUC))) {
      this.addrError(a, false); return null;
    }
    if (this.cop0[C0_SR] & SR_ISC) return 0;
    this.cycles += memCost(a, size);                 // custo de acesso por região/largura
    return this.bus.read(a, size);
  }
  wrMem(a, size, v) {
    if ((a & (size - 1)) !== 0 || ((a & 0x80000000) && (this.cop0[C0_SR] & SR_KUC))) {
      this.addrError(a, true); return false;
    }
    if (this.cop0[C0_SR] & SR_ISC) return true;   // cache isolado: escrita vai pra "cache" e some
    this.bus.write(a, size, v);
    return true;
  }

  writeCop0(n, v) {
    const c0 = this.cop0;
    switch (n) {
      case C0_BPC: case C0_BDA: case C0_DCIC: case C0_BDAM: case C0_BPCM:
        c0[n] = v; break;
      case C0_SR: c0[C0_SR] = v & SR_WRITE_MASK; break;
      case C0_CAUSE: c0[C0_CAUSE] = (c0[C0_CAUSE] & ~0x300) | (v & 0x300); break;
      default: break;                              // BadVAddr/EPC/PRID/JUMPDEST: somente leitura
    }
  }

  // multiplicação 32x32 -> 64 sem BigInt
  mul64(a, b, signed) {
    const a0 = a & 0xFFFF, a1 = a >>> 16, b0 = b & 0xFFFF, b1 = b >>> 16;
    const p00 = a0 * b0, p01 = a0 * b1, p10 = a1 * b0, p11 = a1 * b1;
    const mid = p01 + p10 + (p00 >>> 16);
    this.lo = (((mid & 0xFFFF) << 16) | (p00 & 0xFFFF)) >>> 0;
    let hi = p11 + Math.floor(mid / 65536);
    if (signed) hi -= (a >>> 31 ? b : 0) + (b >>> 31 ? a : 0);
    this.hi = hi >>> 0;
  }

  div(a, b) {
    const n = a | 0, d = b | 0;
    if (d === 0) { this.hi = n >>> 0; this.lo = n >= 0 ? 0xFFFFFFFF : 1; }
    else if (n === -2147483648 && d === -1) { this.hi = 0; this.lo = 0x80000000; }
    else { this.lo = ((n / d) | 0) >>> 0; this.hi = (n % d) >>> 0; }
  }
  divu(n, d) {
    if (d === 0) { this.hi = n; this.lo = 0xFFFFFFFF; }
    else { this.lo = Math.floor(n / d) >>> 0; this.hi = n % d; }
  }

  // -------------------------------------------------------------------------
  //  Um passo = uma instrução
  // -------------------------------------------------------------------------
  step() {
    const lr = this.pendReg, lv = this.pendVal;
    this.nextLdReg = 0; this.wr = 0;

    this.execute();

    // aplica a carga da instrução anterior, a menos que esta tenha escrito o mesmo reg
    if (lr !== 0 && lr !== this.wr) this.r[lr] = lv;
    this.pendReg = this.nextLdReg; this.pendVal = this.nextLdVal;
    this.r[0] = 0;
    this.cycles++; this.instrCount++;
  }

  execute() {
    const bus = this.bus, r = this.r, c0 = this.cop0;
    const cur = this.pc;
    this.currentPc = cur;
    this.inDelay = this.isBranch;
    this.isBranch = false;

    // ---- interrupções ----
    if (bus.irqPending()) c0[C0_CAUSE] |= 0x400; else c0[C0_CAUSE] &= ~0x400;
    const sr = c0[C0_SR];
    if ((sr & SR_IEC) && (c0[C0_CAUSE] & sr & 0xFF00)) { this.exception(EXC.INT); return; }

    // ---- fetch ----
    if (cur & 3) { c0[C0_BADVADDR] = cur; this.exception(EXC.ADEL); return; }
    const w = bus.read(cur, 4);
    if (cur >= 0xA0000000 && cur < 0xC0000000) this.cycles += (cur & 0x1FFFFFFF) >= 0x1FC00000 ? 22 : 4;   // fetch sem cache
    this.pc = this.nextPc;
    this.nextPc = (this.nextPc + 4) >>> 0;

    const op = w >>> 26, rs = (w >>> 21) & 31, rt = (w >>> 16) & 31, rd = (w >>> 11) & 31;
    const sh = (w >>> 6) & 31, imm = w & 0xFFFF, simm = (w << 16) >> 16;

    switch (op) {
      // ======================= SPECIAL =======================
      case 0x00:
        switch (w & 0x3F) {
          case 0x00: this.setR(rd, r[rt] << sh); return;                    // SLL
          case 0x02: this.setR(rd, r[rt] >>> sh); return;                   // SRL
          case 0x03: this.setR(rd, (r[rt] | 0) >> sh); return;              // SRA
          case 0x04: this.setR(rd, r[rt] << (r[rs] & 31)); return;          // SLLV
          case 0x06: this.setR(rd, r[rt] >>> (r[rs] & 31)); return;         // SRLV
          case 0x07: this.setR(rd, (r[rt] | 0) >> (r[rs] & 31)); return;    // SRAV
          case 0x08: this.jump(r[rs]); return;                              // JR
          case 0x09: { const t = r[rs]; this.setR(rd, cur + 8); this.jump(t); return; } // JALR
          case 0x0C: this.exception(EXC.SYS); return;                       // SYSCALL
          case 0x0D: this.exception(EXC.BP); return;                        // BREAK
          case 0x10: this.setR(rd, this.hi); return;                        // MFHI
          case 0x11: this.hi = r[rs]; return;                               // MTHI
          case 0x12: this.setR(rd, this.lo); return;                        // MFLO
          case 0x13: this.lo = r[rs]; return;                               // MTLO
          case 0x18: this.mul64(r[rs], r[rt], true); return;                // MULT
          case 0x19: this.mul64(r[rs], r[rt], false); return;               // MULTU
          case 0x1A: this.div(r[rs], r[rt]); return;                        // DIV
          case 0x1B: this.divu(r[rs], r[rt]); return;                       // DIVU
          case 0x20: {                                                      // ADD
            const a = r[rs] | 0, b = r[rt] | 0, s = (a + b) | 0;
            if (((a ^ s) & (b ^ s)) < 0) { this.exception(EXC.OV); return; }
            this.setR(rd, s); return;
          }
          case 0x21: this.setR(rd, r[rs] + r[rt]); return;                  // ADDU
          case 0x22: {                                                      // SUB
            const a = r[rs] | 0, b = r[rt] | 0, s = (a - b) | 0;
            if (((a ^ b) & (a ^ s)) < 0) { this.exception(EXC.OV); return; }
            this.setR(rd, s); return;
          }
          case 0x23: this.setR(rd, r[rs] - r[rt]); return;                  // SUBU
          case 0x24: this.setR(rd, r[rs] & r[rt]); return;                  // AND
          case 0x25: this.setR(rd, r[rs] | r[rt]); return;                  // OR
          case 0x26: this.setR(rd, r[rs] ^ r[rt]); return;                  // XOR
          case 0x27: this.setR(rd, ~(r[rs] | r[rt])); return;               // NOR
          case 0x2A: this.setR(rd, (r[rs] | 0) < (r[rt] | 0) ? 1 : 0); return; // SLT
          case 0x2B: this.setR(rd, r[rs] < r[rt] ? 1 : 0); return;          // SLTU
          default: this.exception(EXC.RI); return;
        }

      // ======================= REGIMM (BLTZ/BGEZ/BLTZAL/BGEZAL) =======================
      case 0x01: {
        const v = r[rs] | 0;
        const cond = (rt & 1) ? v >= 0 : v < 0;
        if ((rt & 0x1E) === 0x10) this.setR(31, cur + 8);      // link sempre, mesmo sem tomar o branch
        this.isBranch = true;
        if (cond) this.nextPc = (cur + 4 + (simm << 2)) >>> 0;
        return;
      }

      // ======================= Jumps =======================
      case 0x02: this.nextPc = ((this.pc & 0xF0000000) | ((w & 0x3FFFFFF) << 2)) >>> 0; this.isBranch = true; return; // J
      case 0x03: this.setR(31, cur + 8);                                                                              // JAL
                 this.nextPc = ((this.pc & 0xF0000000) | ((w & 0x3FFFFFF) << 2)) >>> 0; this.isBranch = true; return;

      // ======================= Branches =======================
      case 0x04: this.isBranch = true; if (r[rs] === r[rt]) this.nextPc = (cur + 4 + (simm << 2)) >>> 0; return;  // BEQ
      case 0x05: this.isBranch = true; if (r[rs] !== r[rt]) this.nextPc = (cur + 4 + (simm << 2)) >>> 0; return;  // BNE
      case 0x06: this.isBranch = true; if ((r[rs] | 0) <= 0) this.nextPc = (cur + 4 + (simm << 2)) >>> 0; return; // BLEZ
      case 0x07: this.isBranch = true; if ((r[rs] | 0) > 0)  this.nextPc = (cur + 4 + (simm << 2)) >>> 0; return; // BGTZ

      // ======================= Imediatos =======================
      case 0x08: {                                                          // ADDI
        const a = r[rs] | 0, s = (a + simm) | 0;
        if (((a ^ s) & (simm ^ s)) < 0) { this.exception(EXC.OV); return; }
        this.setR(rt, s); return;
      }
      case 0x09: this.setR(rt, r[rs] + simm); return;                       // ADDIU
      case 0x0A: this.setR(rt, (r[rs] | 0) < simm ? 1 : 0); return;         // SLTI
      case 0x0B: this.setR(rt, r[rs] < (simm >>> 0) ? 1 : 0); return;       // SLTIU
      case 0x0C: this.setR(rt, r[rs] & imm); return;                        // ANDI
      case 0x0D: this.setR(rt, r[rs] | imm); return;                        // ORI
      case 0x0E: this.setR(rt, r[rs] ^ imm); return;                        // XORI
      case 0x0F: this.setR(rt, imm << 16); return;                          // LUI

      // ======================= COP0 =======================
      case 0x10:
        if ((sr & SR_KUC) && !(sr & SR_CU0)) { this.exception(EXC.CPU, 0); return; }
        switch (rs) {
          case 0x00: this.setLoad(rt, c0[rd]); return;                      // MFC0 (tem load delay)
          case 0x04: this.writeCop0(rd, r[rt]); return;                     // MTC0
          case 0x10:
            if ((w & 0x3F) === 0x10) {                                      // RFE
              c0[C0_SR] = (sr & 0xFFFFFFF0) | ((sr >>> 2) & 0xF); return;
            }
            this.exception(EXC.RI); return;
          default: return;                                                  // cop0 com rs desconhecido: não gera exceção no console (ps1-tests/cpu/cop)
        }

      // ======================= COP2 (GTE) =======================
      case 0x12:
        if (!(sr & SR_CU2)) { this.exception(EXC.CPU, 2); return; }
        if (w & 0x02000000) { this.gte.command(w & 0x1FFFFFF); return; }    // comando GTE
        switch (rs) {
          case 0x00: this.setLoad(rt, this.gte.readData(rd)); return;       // MFC2
          case 0x02: this.setLoad(rt, this.gte.readCtrl(rd)); return;       // CFC2
          case 0x04: this.gte.writeData(rd, r[rt]); return;                 // MTC2
          case 0x06: this.gte.writeCtrl(rd, r[rt]); return;                 // CTC2
          default: this.exception(EXC.RI); return;
        }

      // COP1/COP3 e LWC/SWC 0,1,3 não existem no PS1 -> Coprocessor Unusable
      // só geram a exceção se o bit CU do coprocessador estiver desligado; ligado, são NOPs
      case 0x11: case 0x13: case 0x30: case 0x31: case 0x33: case 0x38: case 0x39: case 0x3B:
        if (!(sr & (0x10000000 << (op & 3)))) this.exception(EXC.CPU, op & 3);
        return;

      // ======================= Loads =======================
      case 0x20: { const v = this.rdMem((r[rs] + simm) >>> 0, 1); if (v === null) return; this.setLoad(rt, (v << 24) >> 24); return; } // LB
      case 0x21: { const v = this.rdMem((r[rs] + simm) >>> 0, 2); if (v === null) return; this.setLoad(rt, (v << 16) >> 16); return; } // LH
      case 0x23: { const v = this.rdMem((r[rs] + simm) >>> 0, 4); if (v === null) return; this.setLoad(rt, v); return; }               // LW
      case 0x24: { const v = this.rdMem((r[rs] + simm) >>> 0, 1); if (v === null) return; this.setLoad(rt, v); return; }               // LBU
      case 0x25: { const v = this.rdMem((r[rs] + simm) >>> 0, 2); if (v === null) return; this.setLoad(rt, v); return; }               // LHU
      case 0x22: {                                                          // LWL
        const a = (r[rs] + simm) >>> 0;
        const m = this.rdMem((a & 0xFFFFFFFC) >>> 0, 4); if (m === null) return;
        const c = (this.pendReg === rt) ? this.pendVal : r[rt];             // enxerga a carga em andamento
        let v;
        switch (a & 3) {
          case 0: v = (c & 0x00FFFFFF) | (m << 24); break;
          case 1: v = (c & 0x0000FFFF) | (m << 16); break;
          case 2: v = (c & 0x000000FF) | (m << 8); break;
          default: v = m;
        }
        this.setLoad(rt, v); return;
      }
      case 0x26: {                                                          // LWR
        const a = (r[rs] + simm) >>> 0;
        const m = this.rdMem((a & 0xFFFFFFFC) >>> 0, 4); if (m === null) return;
        const c = (this.pendReg === rt) ? this.pendVal : r[rt];
        let v;
        switch (a & 3) {
          case 0: v = m; break;
          case 1: v = (c & 0xFF000000) | (m >>> 8); break;
          case 2: v = (c & 0xFFFF0000) | (m >>> 16); break;
          default: v = (c & 0xFFFFFF00) | (m >>> 24);
        }
        this.setLoad(rt, v); return;
      }
      case 0x32: { if (!(sr & SR_CU2)) { this.exception(EXC.CPU, 2); return; } const v = this.rdMem((r[rs] + simm) >>> 0, 4); if (v === null) return; this.gte.writeData(rt, v); return; } // LWC2

      // ======================= Stores =======================
      case 0x28: this.wrMem((r[rs] + simm) >>> 0, 1, r[rt] & 0xFF); return;   // SB
      case 0x29: this.wrMem((r[rs] + simm) >>> 0, 2, r[rt] & 0xFFFF); return; // SH
      case 0x2B: this.wrMem((r[rs] + simm) >>> 0, 4, r[rt]); return;          // SW
      case 0x2A: {                                                          // SWL
        const a = (r[rs] + simm) >>> 0, al = (a & 0xFFFFFFFC) >>> 0;
        const m = this.rdMem(al, 4); if (m === null) return;
        const t = r[rt]; let v;
        switch (a & 3) {
          case 0: v = (m & 0xFFFFFF00) | (t >>> 24); break;
          case 1: v = (m & 0xFFFF0000) | (t >>> 16); break;
          case 2: v = (m & 0xFF000000) | (t >>> 8); break;
          default: v = t;
        }
        this.wrMem(al, 4, v >>> 0); return;
      }
      case 0x2E: {                                                          // SWR
        const a = (r[rs] + simm) >>> 0, al = (a & 0xFFFFFFFC) >>> 0;
        const m = this.rdMem(al, 4); if (m === null) return;
        const t = r[rt]; let v;
        switch (a & 3) {
          case 0: v = t; break;
          case 1: v = (m & 0x000000FF) | (t << 8); break;
          case 2: v = (m & 0x0000FFFF) | (t << 16); break;
          default: v = (m & 0x00FFFFFF) | (t << 24);
        }
        this.wrMem(al, 4, v >>> 0); return;
      }
      case 0x3A: if (!(sr & SR_CU2)) { this.exception(EXC.CPU, 2); return; } this.wrMem((r[rs] + simm) >>> 0, 4, this.gte.readData(rt)); return; // SWC2

      default: this.exception(EXC.RI); return;
    }
  }

  dump() {
    let s = `PC=${hex(this.pc)} NPC=${hex(this.nextPc)} HI=${hex(this.hi)} LO=${hex(this.lo)}\n`;
    for (let i = 0; i < 32; i += 4) {
      s += [0, 1, 2, 3].map(j => `${REG_NAMES[i + j].padStart(4)}=${hex(this.r[i + j])}`).join('  ') + '\n';
    }
    s += `SR=${hex(this.cop0[C0_SR])} CAUSE=${hex(this.cop0[C0_CAUSE])} EPC=${hex(this.cop0[C0_EPC])} BADV=${hex(this.cop0[C0_BADVADDR])}`;
    return s;
  }
}

const hex = (v, n = 8) => (v >>> 0).toString(16).toUpperCase().padStart(n, '0');

return { EXC, REG_NAMES, RESET_VECTOR, LD_RAM, memCost, CPU, hex };
})();
const __src_jit = (() => {
// ============================================================================
//  Recompilador dinâmico MIPS R3000A -> JavaScript
// ============================================================================
//  Cada "bloco" é uma sequência linear de instruções que começa num PC e termina
//  num branch/jump (incluindo o delay slot), SYSCALL/BREAK, MTC0 em SR/CAUSE, RFE
//  ou ao atingir MAX_BLOCK instruções. O bloco vira uma função JS (new Function).
//
//  Semântica preservada em relação ao interpretador (cpu.js):
//   - delay slot de branch e load delay slot são resolvidos ESTATICAMENTE na geração
//     (a carga pendente cruza o fim do bloco via cpu.pendReg/pendVal; se um bloco é
//     entrado com carga pendente, roda-se 1 passo no interpretador);
//   - exceções (AdEL/AdES/Overflow/SYSCALL/BREAK/RI/CpU) saem do bloco com o estado exato
//     (EPC, BD, BadVAddr, ciclos, instrCount);
//   - ciclos: 1/instrução + custo de fetch KSEG1 + 5 por load (corrigido no acesso lento),
//     descarregados em cpu.cycles antes de cada acesso à memória (I/O vê o relógio certo);
//   - interrupções são verificadas na ENTRADA de cada bloco (blocos curtos: ≤ MAX_BLOCK).
//  Blocos só são usados em modo kernel e sem cache isolado; senão cai no interpretador.
//
//  Invalidação: a RAM é dividida em linhas de 64 B; bus.codeFlags marca as que têm código.
//  Escritas da CPU (inline), do interpretador e de DMA chamam bus.onCodeWrite -> descarta os
//  blocos que tocam a linha.
// ============================================================================
const { EXC, memCost, LD_RAM } = __src_cpu;
const MAX_BLOCK = 48;
const INTERP = function interp() {};            // sentinela: "este PC é executado pelo interpretador"

const isBranchWord = w => {
  const op = w >>> 26;
  return op === 1 || (op >= 2 && op <= 7) || (op === 0 && ((w & 0x3F) === 8 || (w & 0x3F) === 9));
};

class JIT {
  constructor(cpu, bus) {
    this.cpu = cpu; this.bus = bus; this.epoch = 0;
    this.gp = new Uint32Array(0x4000); this.gb = new Array(0x4000).fill(null); this.ge = new Int32Array(0x4000).fill(-1);
    this.cf = bus.codeFlags;
    this.lineBlocks = new Array(this.cf.length).fill(null);
    this.tables = [];
    this.stats = { compiled: 0, interp: 0, invalidations: 0, loops: 0, inlined: 0 };
    bus.onCodeWrite = o => this.invalidateLine(o >>> 6);

    const ram = bus.ram;
    const self = this;
    this.H = {
      r: cpu.r, c0: cpu.cop0, gte: cpu.gte, bus, ps: { nextTick: 0 }, J: this,   // ps: o PSX (nextTick) para laços internos; J: este JIT (epoch)
      ram8: ram, ram16: new Uint16Array(ram.buffer, ram.byteOffset, ram.length >> 1), ram32: new Uint32Array(ram.buffer, ram.byteOffset, ram.length >> 2),
      cf: this.cf,
      inv: o => self.invalidateLine(o >>> 6),
      rd(a, size) { cpu.cycles += memCost(a, size) - LD_RAM; return bus.read(a, size); },
      lwl(a, c) {
        const m = this.rd((a & 0xFFFFFFFC) >>> 0, 4);
        switch (a & 3) { case 0: return (c & 0x00FFFFFF) | (m << 24); case 1: return (c & 0x0000FFFF) | (m << 16); case 2: return (c & 0x000000FF) | (m << 8); default: return m; }
      },
      lwr(a, c) {
        const m = this.rd((a & 0xFFFFFFFC) >>> 0, 4);
        switch (a & 3) { case 0: return m; case 1: return (c & 0xFF000000) | (m >>> 8); case 2: return (c & 0xFFFF0000) | (m >>> 16); default: return (c & 0xFFFFFF00) | (m >>> 24); }
      },
      swl(a, t) {
        const al = (a & 0xFFFFFFFC) >>> 0, m = this.rd(al, 4); let v;
        switch (a & 3) { case 0: v = (m & 0xFFFFFF00) | (t >>> 24); break; case 1: v = (m & 0xFFFF0000) | (t >>> 16); break; case 2: v = (m & 0xFF000000) | (t >>> 8); break; default: v = t; }
        bus.write(al, 4, v >>> 0);
      },
      swr(a, t) {
        const al = (a & 0xFFFFFFFC) >>> 0, m = this.rd(al, 4); let v;
        switch (a & 3) { case 0: v = t; break; case 1: v = (m & 0x000000FF) | (t << 8); break; case 2: v = (m & 0x0000FFFF) | (t << 16); break; default: v = (m & 0x00FFFFFF) | (t << 24); }
        bus.write(al, 4, v >>> 0);
      },
    };
  }

  /** descarta tudo (após carregar código na RAM por fora, reset, etc.) */
  flush() {
    this.tables = []; this.cf.fill(0); this.lineBlocks.fill(null); this.epoch++;
  }

  invalidateLine(l) {
    this.epoch++;
    const list = this.lineBlocks[l];
    if (list) { for (const e of list) e.t[e.i] = undefined; this.lineBlocks[l] = null; this.stats.invalidations++; }
    this.cf[l] = 0;
  }

  table(key, size) {
    return this.tables[key] || (this.tables[key] = new Array(size).fill(undefined));
  }

  /** executa um bloco (ou 1 instrução no interpretador, nos casos especiais) */
  exec() {
    const cpu = this.cpu, c0 = cpu.cop0, sr = c0[12], pc = cpu.pc;
    if (cpu.isBranch || cpu.pendReg !== 0 || (sr & 0x10002) !== 0 || (pc & 3) !== 0) { cpu.step(); return; }
    if (this.bus.irqPending()) c0[13] |= 0x400; else c0[13] &= ~0x400;
    if ((sr & 1) && (c0[13] & sr & 0xFF00)) { cpu.step(); return; }

    const seg = pc >>> 29;
    if (seg >= 6) { cpu.step(); return; }
    const phys = seg < 4 ? pc : (seg === 4 ? pc & 0x7FFFFFFF : pc & 0x1FFFFFFF);
    let t, idx, isRam;
    if (phys < 0x800000) { t = this.table(seg * 2, 0x80000); idx = (phys & 0x1FFFFF) >>> 2; isRam = true; }
    else if (phys >= 0x1FC00000 && phys < 0x1FC80000) { t = this.table(seg * 2 + 1, 0x20000); idx = (phys - 0x1FC00000) >>> 2; isRam = false; }
    else { cpu.step(); return; }

    let b = t[idx];
    if (b === undefined) b = t[idx] = this.compile(pc, isRam, t, idx);
    if (b === INTERP) { cpu.step(); return; }
    b();
  }

  /** laço quente: executa blocos até cpu.cycles alcançar psx.nextTick (mesma lógica de exec(), sem a sobrecarga por chamada).
   *  Encadeamento: cada bloco lembra o último sucessor (b.lp = pc, b.lb = bloco, b.le = época); qualquer invalidação/flush muda a época. */
  runBlocks(psx) {
    const cpu = this.cpu, c0 = cpu.cop0, bus = this.bus, hook = psx.hookTTY;
    const gp = this.gp, gb = this.gb, ge = this.ge;                  // cache global direto-mapeado pc -> bloco (evita a busca nas tabelas)
    let prev = null;
    while (cpu.cycles < psx.nextTick) {
      const sr = c0[12], pc = cpu.pc;
      if (cpu.isBranch || cpu.pendReg !== 0 || (sr & 0x10002) !== 0 || (pc & 3) !== 0) { cpu.step(); prev = null; continue; }
      let cz = c0[13];
      if (bus.istat & bus.imask) { if ((cz & 0x400) === 0) c0[13] = cz |= 0x400; } else if ((cz & 0x400) !== 0) c0[13] = cz &= ~0x400;
      if ((sr & 1) && (cz & sr & 0xFF00)) { cpu.step(); prev = null; continue; }
      let b;
      if (prev !== null && prev.lp === pc && prev.le === this.epoch) b = prev.lb;
      else if (gp[(pc >>> 2) & 0x3FFF] === pc && ge[(pc >>> 2) & 0x3FFF] === this.epoch) {
        b = gb[(pc >>> 2) & 0x3FFF];
        if (prev !== null) { prev.lp = pc; prev.lb = b; prev.le = this.epoch; }
      } else {
        const seg = pc >>> 29;
        if (seg >= 6) { cpu.step(); prev = null; continue; }
        const phys = seg < 4 ? pc : (seg === 4 ? pc & 0x7FFFFFFF : pc & 0x1FFFFFFF);
        let t, idx, isRam;
        if (phys < 0x800000) {
          if (hook && (phys === 0xA0 || phys === 0xB0)) { psx.tty(); }
          t = this.tables[seg * 2] || this.table(seg * 2, 0x80000); idx = (phys & 0x1FFFFF) >>> 2; isRam = true;
        } else if (phys >= 0x1FC00000 && phys < 0x1FC80000) { t = this.tables[seg * 2 + 1] || this.table(seg * 2 + 1, 0x20000); idx = (phys - 0x1FC00000) >>> 2; isRam = false; }
        else { cpu.step(); prev = null; continue; }
        b = t[idx];
        if (b === undefined) b = t[idx] = this.compile(pc, isRam, t, idx);
        if (b === INTERP) { cpu.step(); prev = null; continue; }
        if (!(hook && phys < 0x100)) {
          if (prev !== null) { prev.lp = pc; prev.lb = b; prev.le = this.epoch; }
          const h = (pc >>> 2) & 0x3FFF; gp[h] = pc; gb[h] = b; ge[h] = this.epoch;
        }
      }
      b(); prev = b;
    }
  }

  // -------------------------------------------------------------------------
  //  Geração de código
  // -------------------------------------------------------------------------
  compile(startPc, isRam, tbl, tidx) {
    const cpu = this.cpu, bus = this.bus;
    const code = [];
    let unf = 0, cnt = 0, k = 0, pend = null, ipc = startPc, delay = false;
    const tmp = () => 't' + (k++);
    const dirty = new Set();                                         // registradores MIPS escritos até aqui (vivem em variáveis locais r<N>; gravados em r[] nas saídas)
    const R = n => n === 0 ? '0' : `r${n}`;
    const flushSets = [];                                            // pontos de gravação dos registradores: marcador \u0001<id>\u0002, resolvido no fim
    const flushRegs = () => { let o = ''; for (const n of dirty) o += `r[${n}]=r${n};`; flushSets.push(o); return `\u0001${flushSets.length - 1}\u0002`; };
    let hasLoop = false, knownRa = null, segStart = startPc; const segs = [], vis = new Set();
    const fetchCost = a => (a >>> 29) === 5 ? (((a & 0x1FFFFFFF) >= 0x1FC00000) ? 22 : 4) : 0;
    const pendApply = () => pend ? `r[${pend.reg}]=${pend.tmp};` : '';
    const X = (c, cop = 0, bad = null, refund = 0) =>
      `{cpu.cycles+=${unf - refund};cpu.instrCount+=${cnt};${flushRegs()}${pendApply()}cpu.currentPc=${ipc};cpu.inDelay=${delay};${bad ? `c0[8]=${bad};` : ''}cpu.exception(${c},${cop});return;}`;
    const flushCyc = () => { if (unf) { code.push(`cpu.cycles+=${unf};`); unf = 0; } };
    const RAMFAST = a => `(${a}&0x1FFFFFFF)<0x800000`;

    // finaliza o bloco: pc/nextPc, ciclos, carga pendente
    const finish = (pcExpr) => {
      let s = `cpu.cycles+=${unf};cpu.instrCount+=${cnt};${flushRegs()}`;
      if (pend) s += `cpu.pendReg=${pend.reg};cpu.pendVal=${pend.tmp};`;
      s += pcExpr;
      code.push(s);
    };
    const finishSeq = (next) => finish(`cpu.pc=${next >>> 0};cpu.nextPc=${(next + 4) >>> 0};`);

    // aplica o efeito de "fim de instrução": carga anterior (se não cancelada) e nova carga
    let newLd = null;
    const post = (dest) => {
      if (dest === 31 || (newLd && newLd.reg === 31) || (pend && pend.reg === 31)) knownRa = null;
      if (pend && pend.reg !== dest) { code.push(`r${pend.reg}=${pend.tmp}>>>0;`); dirty.add(pend.reg); }
      pend = newLd; newLd = null;
    };

    // emite UMA instrução não-branch. Devolve { dest, term }.
    const emit = (w, pcv) => {
      const op = w >>> 26, rs = (w >>> 21) & 31, rt = (w >>> 16) & 31, rd = (w >>> 11) & 31;
      const sh = (w >>> 6) & 31, imm = w & 0xFFFF, simm = (w << 16) >> 16;
      const RS = R(rs), RT = R(rt);
      const W = (d, e) => { if (d) { code.push(e.endsWith('?1:0') && !e.includes('?1:0)') ? `r${d}=${e};` : `r${d}=(${e})>>>0;`); dirty.add(d); } return d; };   // locais guardam uint32 (como o Uint32Array r[])
      let dest = 0, term = false;
      newLd = null;

      const load = (size, conv) => {
        const a = tmp(), v = tmp();
        flushCyc();
        code.push(`const ${a}=(${RS}+${simm})>>>0;`);
        if (size > 1) code.push(`if(${a}&${size - 1})${X(EXC.ADEL, 0, a, LD_RAM)}`);
        const fast = size === 4 ? `ram32[(${a}&0x1FFFFF)>>>2]` : size === 2 ? `ram16[(${a}&0x1FFFFF)>>>1]` : `ram8[${a}&0x1FFFFF]`;
        code.push(`const ${v}=${conv(`(${RAMFAST(a)}?${fast}:rd(${a},${size}))`)};`);
        if (rt) newLd = { reg: rt, tmp: v };
      };
      const store = (size, valExpr) => {
        const a = tmp(), v = tmp();
        flushCyc();
        code.push(`const ${a}=(${RS}+${simm})>>>0;`);
        if (size > 1) code.push(`if(${a}&${size - 1})${X(EXC.ADES, 0, a)}`);
        code.push(`const ${v}=${valExpr};`);
        const arr = size === 4 ? `ram32[q>>>2]` : size === 2 ? `ram16[q>>>1]` : `ram8[q]`;
        code.push(`if(${RAMFAST(a)}){const q=${a}&0x1FFFFF;${arr}=${v};if(cf[q>>>6])inv(q);}else bus.write(${a},${size},${v});`);
      };

      switch (op) {
        case 0x00:
          switch (w & 0x3F) {
            case 0x00: dest = W(rd, `${RT}<<${sh}`); break;
            case 0x02: dest = W(rd, `${RT}>>>${sh}`); break;
            case 0x03: dest = W(rd, `(${RT}|0)>>${sh}`); break;
            case 0x04: dest = W(rd, `${RT}<<(${RS}&31)`); break;
            case 0x06: dest = W(rd, `${RT}>>>(${RS}&31)`); break;
            case 0x07: dest = W(rd, `(${RT}|0)>>(${RS}&31)`); break;
            case 0x0C: code.push(X(EXC.SYS)); term = 'x'; break;
            case 0x0D: code.push(X(EXC.BP)); term = 'x'; break;
            case 0x10: dest = W(rd, 'cpu.hi'); break;
            case 0x11: code.push(`cpu.hi=${RS};`); break;
            case 0x12: dest = W(rd, 'cpu.lo'); break;
            case 0x13: code.push(`cpu.lo=${RS};`); break;
            case 0x18: code.push(`cpu.mul64(${RS},${RT},true);`); break;
            case 0x19: code.push(`cpu.mul64(${RS},${RT},false);`); break;
            case 0x1A: code.push(`cpu.div(${RS},${RT});`); break;
            case 0x1B: code.push(`cpu.divu(${RS},${RT});`); break;
            case 0x20: { const a = tmp(), b = tmp(), s = tmp();
              code.push(`const ${a}=${RS}|0,${b}=${RT}|0,${s}=(${a}+${b})|0;if(((${a}^${s})&(${b}^${s}))<0)${X(EXC.OV)}`);
              dest = W(rd, s); break; }
            case 0x21: dest = W(rd, `${RS}+${RT}`); break;
            case 0x22: { const a = tmp(), b = tmp(), s = tmp();
              code.push(`const ${a}=${RS}|0,${b}=${RT}|0,${s}=(${a}-${b})|0;if(((${a}^${b})&(${a}^${s}))<0)${X(EXC.OV)}`);
              dest = W(rd, s); break; }
            case 0x23: dest = W(rd, `${RS}-${RT}`); break;
            case 0x24: dest = W(rd, `${RS}&${RT}`); break;
            case 0x25: dest = W(rd, `${RS}|${RT}`); break;
            case 0x26: dest = W(rd, `${RS}^${RT}`); break;
            case 0x27: dest = W(rd, `~(${RS}|${RT})`); break;
            case 0x2A: dest = W(rd, `(${RS}|0)<(${RT}|0)?1:0`); break;
            case 0x2B: dest = W(rd, `${RS}<${RT}?1:0`); break;
            default: code.push(X(EXC.RI)); term = 'x';
          }
          break;
        case 0x08: { const a = tmp(), s = tmp();
          code.push(`const ${a}=${RS}|0,${s}=(${a}+${simm})|0;if(((${a}^${s})&(${simm}^${s}))<0)${X(EXC.OV)}`);
          dest = W(rt, s); break; }
        case 0x09: dest = W(rt, `${RS}+${simm}`); break;
        case 0x0A: dest = W(rt, `(${RS}|0)<${simm}?1:0`); break;
        case 0x0B: dest = W(rt, `${RS}<${simm >>> 0}?1:0`); break;
        case 0x0C: dest = W(rt, `${RS}&${imm}`); break;
        case 0x0D: dest = W(rt, `${RS}|${imm}`); break;
        case 0x0E: dest = W(rt, `${RS}^${imm}`); break;
        case 0x0F: dest = W(rt, `${(imm << 16) >>> 0}`); break;

        case 0x10:                                                // COP0 (modo kernel garantido na entrada)
          if (rs === 0x00) { const v = tmp(); code.push(`const ${v}=c0[${rd}];`); if (rt) newLd = { reg: rt, tmp: v }; }
          else if (rs === 0x04) { code.push(`cpu.writeCop0(${rd},${RT});`); if (rd === 12 || rd === 13) term = 'seq'; }
          else if (rs === 0x10 && (w & 0x3F) === 0x10) { code.push('c0[12]=(c0[12]&0xFFFFFFF0)|((c0[12]>>>2)&0xF);'); term = 'seq'; }
          else if (rs === 0x10) { code.push(X(EXC.RI)); term = 'x'; }
          break;

        case 0x12:                                                // COP2 / GTE
          code.push(`if(!(c0[12]&0x40000000))${X(EXC.CPU, 2)}`);
          if (w & 0x02000000) code.push(`gte.command(${w & 0x1FFFFFF});`);
          else if (rs === 0x00) { const v = tmp(); code.push(`const ${v}=gte.readData(${rd});`); if (rt) newLd = { reg: rt, tmp: v }; }
          else if (rs === 0x02) { const v = tmp(); code.push(`const ${v}=gte.readCtrl(${rd});`); if (rt) newLd = { reg: rt, tmp: v }; }
          else if (rs === 0x04) code.push(`gte.writeData(${rd},${RT});`);
          else if (rs === 0x06) code.push(`gte.writeCtrl(${rd},${RT});`);
          else { code.push(X(EXC.RI)); term = 'x'; }
          break;

        case 0x11: case 0x13: case 0x30: case 0x31: case 0x33: case 0x38: case 0x39: case 0x3B:
          code.push(`if(!(c0[12]&${0x10000000 * (1 << (op & 3))}))${X(EXC.CPU, op & 3)}`); break;

        case 0x20: load(1, e => `((${e}<<24)>>24)`); break;
        case 0x21: load(2, e => `((${e}<<16)>>16)`); break;
        case 0x23: load(4, e => e); break;
        case 0x24: load(1, e => e); break;
        case 0x25: load(2, e => e); break;
        case 0x22: case 0x26: {                                   // LWL / LWR
          const a = tmp(), v = tmp();
          flushCyc();
          const cur = (pend && pend.reg === rt) ? pend.tmp : R(rt);
          code.push(`const ${a}=(${RS}+${simm})>>>0;const ${v}=H.${op === 0x22 ? 'lwl' : 'lwr'}(${a},${cur});`);
          if (rt) newLd = { reg: rt, tmp: v };
          break;
        }
        case 0x32: {                                              // LWC2
          const a = tmp(), v = tmp();
          flushCyc();
          code.push(`if(!(c0[12]&0x40000000))${X(EXC.CPU, 2)}`);
          code.push(`const ${a}=(${RS}+${simm})>>>0;`);
          code.push(`if(${a}&3)${X(EXC.ADEL, 0, a, LD_RAM)}`);
          code.push(`const ${v}=(${RAMFAST(a)}?ram32[(${a}&0x1FFFFF)>>>2]:rd(${a},4));gte.writeData(${rt},${v});`);
          break;
        }
        case 0x28: store(1, `${RT}&0xFF`); break;
        case 0x29: store(2, `${RT}&0xFFFF`); break;
        case 0x2B: store(4, `${RT}`); break;
        case 0x2A: case 0x2E: {                                   // SWL / SWR
          const a = tmp();
          flushCyc();
          code.push(`const ${a}=(${RS}+${simm})>>>0;H.${op === 0x2A ? 'swl' : 'swr'}(${a},${RT});`);
          break;
        }
        case 0x3A: {                                              // SWC2
          const a = tmp(), v = tmp();
          flushCyc();
          code.push(`if(!(c0[12]&0x40000000))${X(EXC.CPU, 2)}`);
          code.push(`const ${a}=(${RS}+${simm})>>>0;`);
          code.push(`if(${a}&3)${X(EXC.ADES, 0, a)}`);
          code.push(`const ${v}=gte.readData(${rt});`);
          code.push(`if(${RAMFAST(a)}){const q=${a}&0x1FFFFF;ram32[q>>>2]=${v};if(cf[q>>>6])inv(q);}else bus.write(${a},4,${v}>>>0);`);
          break;
        }
        default: code.push(X(EXC.RI)); term = 'x';
      }
      return { dest, term };
    };

    // custo estático de uma instrução (1 + fetch KSEG1 + 5 se faz acesso de leitura)
    const instCost = (w, a) => {
      const op = w >>> 26;
      const rdAccess = op === 0x20 || op === 0x21 || op === 0x22 || op === 0x23 || op === 0x24 || op === 0x25 || op === 0x26 || op === 0x32 || op === 0x2A || op === 0x2E;
      return 1 + fetchCost(a) + (rdAccess ? LD_RAM : 0);
    };
    const fetch = a => bus.read(a, 4);

    // volta ao início do próprio bloco (laço): mantém os registradores em variáveis locais; sai para o despachante quando acabar o tempo
    // do tick, houver IRQ pendente ou o código for invalidado
    const backedge = () => { hasLoop = true; return `cpu.cycles+=${unf};cpu.instrCount+=${cnt};if(cpu.cycles>=ps.nextTick||(bus.istat&bus.imask)!==0||J.epoch!==E0){${flushRegs()}cpu.pc=${startPc};cpu.nextPc=${(startPc + 4) >>> 0};return;}continue;`; };
    const inlineOk = t => { const ph = t & 0x1FFFFFFF; return (t & 3) === 0 && ph >= 0x100 && !vis.has(t) && (isRam ? ph < 0x800000 : (ph >= 0x1FC00000 && ph < 0x1FC80000)); };

    let done = false;
    while (!done) {
      const w = fetch(ipc); vis.add(ipc);
      if (isBranchWord(w)) {
        const dw = fetch((ipc + 4) >>> 0);
        if (isBranchWord(dw)) { // branch no delay slot: deixa para o interpretador
          if (cnt === 0) { this.stats.interp++; this.register(startPc, isRam, tbl, tidx, ipc); return INTERP; }
          finishSeq(ipc); done = true; break;
        }
        const op = w >>> 26, rs = (w >>> 21) & 31, rt = (w >>> 16) & 31, rd = (w >>> 11) & 31, simm = (w << 16) >> 16;
        const RS = R(rs), RT = R(rt);
        const tgt = (ipc + 4 + (simm << 2)) >>> 0;
        let target, cond = null, dest = 0, link = '', bkn = '';
        cnt++; unf += instCost(w, ipc); delay = false;
        let jt = -1, raNew = null, jrKnown = false, btn = 'bt';
        if (op === 0x02 || op === 0x03) {
          jt = (((ipc + 4) & 0xF0000000) | ((w & 0x3FFFFFF) << 2)) >>> 0; target = `${jt}`;
          if (op === 3) { link = `r31=${(ipc + 8) >>> 0};`; dest = 31; dirty.add(31); raNew = (ipc + 8) >>> 0; }
          btn = tmp(); code.push(`const ${btn}=${target};${link}`);
        } else if (op === 0 /* JR/JALR */) {
          if ((w & 0x3F) === 8 && rs === 31 && knownRa !== null && cnt < MAX_BLOCK - 8 && inlineOk(knownRa)) { jt = knownRa; jrKnown = true; }
          btn = tmp(); code.push(`const ${btn}=${RS}>>>0;`);
          if ((w & 0x3F) === 9 && rd) { code.push(`r${rd}=${(ipc + 8) >>> 0};`); dest = rd; dirty.add(rd); }
        } else {
          const cexp = op === 4 ? `${RS}===${RT}` : op === 5 ? `${RS}!==${RT}` : op === 6 ? `(${RS}|0)<=0` : op === 7 ? `(${RS}|0)>0`
            : ((rt & 1) ? `(${RS}|0)>=0` : `(${RS}|0)<0`);
          bkn = tmp(); code.push(`const ${bkn}=${cexp};`);
          if (op === 1 && (rt & 0x1E) === 0x10) { code.push('r31=' + ((ipc + 8) >>> 0) + ';'); dest = 31; dirty.add(31); }
          cond = true;
        }
        post(dest);
        // delay slot
        delay = true; cnt++; const dpc = (ipc + 4) >>> 0; ipc = dpc; unf += instCost(dw, dpc);
        const res = emit(dw, dpc);
        post(res.dest);
        const dualExit = res.term === 'x';           // exceção incondicional no delay slot: o resto é morto
        if (!dualExit) {
          if (!cond && jt >= 0 && !res.term) {
            if (jt === startPc && !pend) { code.push(backedge()); done = true; break; }          // salto incondicional para o próprio início: laço interno
            if (jt !== startPc && (jrKnown || cnt < MAX_BLOCK - 8) && inlineOk(jt)) {              // j/jal/jr $ra conhecido: embute o destino no mesmo bloco
              segs.push([segStart, dpc]); segStart = jt; ipc = jt; delay = false;
              if (raNew !== null) knownRa = raNew; else if (jrKnown) knownRa = null;
              continue;
            }
          }
          if (cond) {
            if (!res.term && cnt < MAX_BLOCK - 3) {   // superbloco: o desvio tomado vira saída lateral; o fluxo sequencial continua no mesmo bloco
              if (tgt === startPc && !pend) code.push(`if(${bkn}){${backedge()}}`);              // desvio para trás até o início: laço interno
              else {
                let s = `cpu.cycles+=${unf};cpu.instrCount+=${cnt};${flushRegs()}`;
                if (pend) s += `cpu.pendReg=${pend.reg};cpu.pendVal=${pend.tmp};`;
                code.push(`if(${bkn}){${s}cpu.pc=${tgt};cpu.nextPc=${(tgt + 4) >>> 0};return;}`);
              }
              ipc = (dpc + 4) >>> 0; delay = false; continue;
            }
            finish(`if(${bkn}){cpu.pc=${tgt};cpu.nextPc=${(tgt + 4) >>> 0};}else{cpu.pc=${(dpc + 4) >>> 0};cpu.nextPc=${(dpc + 8) >>> 0};}`);
          } else finish(`cpu.pc=${btn};cpu.nextPc=(${btn}+4)>>>0;`);
        }
        done = true; break;
      }

      // instrução comum
      cnt++; unf += instCost(w, ipc); delay = false;
      const res = emit(w, ipc);
      post(res.dest);
      if (res.term === 'x') { done = true; break; }
      if (res.term === 'seq' || cnt >= MAX_BLOCK) { finishSeq((ipc + 4) >>> 0); done = true; break; }
      ipc = (ipc + 4) >>> 0;
    }

    segs.push([segStart, ipc]);
    const fullFlush = [...dirty].map(n => `r[${n}]=r${n};`).join('');       // num laço, qualquer saída grava TODOS os registradores alterados no corpo
    let body = code.join('\n').replace(/\u0001(\d+)\u0002/g, (_, i) => hasLoop ? fullFlush : flushSets[+i]);
    const used = new Set(); for (const m of body.matchAll(/\br(\d{1,2})\b/g)) used.add(+m[1]);
    const load = used.size ? 'let ' + [...used].map(n => `r${n}=r[${n}]`).join(',') + ';\n' : '';
    if (hasLoop) body = `const E0=J.epoch;\nfor(;;){\n${body}\nreturn;\n}`;
    const src = `const {r,c0,gte,ram8,ram16,ram32,cf,inv,rd,bus,ps,J}=H;return function block(){\n${load}${body}\n}\n//# sourceURL=jit_${startPc.toString(16)}`;
    let fn;
    try { fn = new Function('cpu', 'H', src)(cpu, this.H); }
    catch (e) { this.stats.interp++; for (const [a, b] of segs) this.register(a, isRam, tbl, tidx, b); return INTERP; }
    this.stats.compiled++; if (hasLoop) this.stats.loops++; this.stats.inlined += segs.length - 1;
    fn.lp = -1; fn.lb = null; fn.le = -1;                  // cache de sucessor (ver runBlocks)
    for (const [a, b] of segs) this.register(a, isRam, tbl, tidx, b);
    return fn;
  }

  /** marca as linhas de RAM cobertas pelo bloco [start, endPc] para invalidação */
  register(startPc, isRam, tbl, tidx, endPc) {
    if (!isRam) return;
    const seg = startPc >>> 29;
    const p0 = (seg < 4 ? startPc : seg === 4 ? startPc & 0x7FFFFFFF : startPc & 0x1FFFFFFF) & 0x1FFFFF;
    const p1 = (p0 + ((endPc - startPc) >>> 0) + 3) & 0x1FFFFF;
    const l0 = p0 >>> 6, l1 = p1 >>> 6;
    for (let l = l0; ; l = (l + 1) & (this.cf.length - 1)) {
      (this.lineBlocks[l] ??= []).push({ t: tbl, i: tidx });
      this.cf[l] = 1;
      if (l === l1) break;
    }
  }
}

return { JIT };
})();
const __src_wasmbin = (() => {
// gerado por wasm/build.sh (não edite)
const WASM_B64 = 'AGFzbQEAAAABOgpgAn9/AX9gA39/fwBgAABgAX8Bf2AAAX9gAn9/AGABfwBgA39/fwF/YAR/f39/AGAHf39/f39/fwACKQMDZW52Bm1lbW9yeQIBQEADZW52BWJyZWFkAAADZW52BmJ3cml0ZQABAxEQAgMEBQYDBQUHBgABAQgJCAQFAXABAQEGCQF/AUGAn6IBCwcpBQNwdHIAAwNydW4ABAdndGVfY21kAAsGZ3RlX3JkAAwGZ3RlX3dyAA0IAQIKoMUBEA8AQaAIQQBB1JagAfwLAAuQAQEBf0GgiICAACEBAkACQAJAAkACQAJAAkACQAJAAkACQAJAIAAOCwsAAQIDBAUGBwgJCgtBoImAgAAPC0GgioCAAA8LQeCKgIAADwtBgIuAgAAPC0GAi4CBAA8LQYCLoIEADwtBgJOggQAPC0GAlKCBAA8LQYCWoIEADwtBoJaggQAPC0HAlqCBACEBCyABC9ZEAg5/AXwjgICAgABBEGsiACSAgICAAEEAIQECQEEAKwPgioCAAEEAKwPwioCAAGNFDQADQEEAKAKoioCAACEBAkBBACgCwIqAgABFDQAgAUHv////AXFBoAFHDQACQEEAKALEioCAAA0AQQEhAQwDC0EAQQA2AsSKgIAAC0EAIAE2AsiKgIAAQQBBACgCsIqAgAAiAjYCzIqAgABBAEEAKAK8ioCAAEEAR0EKdEEAKALUiYCAAEH/d3FyIgM2AtSJgIAAQQBBADYC1JaggQBBAEEANgLYlqCBAEEAQQA2ArCKgIAAQQAoAriKgIAAIQRBACgCtIqAgAAhBQJAAkBBACgC0ImAgAAiBkEBcUUNACAGIANxQYD+A3FFDQBBACABQXxqIAEgAhs2AtiJgIAAQQBBgIOA/ntBgIGAgHggBkGAgIACcRsiATYCqIqAgABBACAGQQJ0QTxxIAZBQHFyNgLQiYCAAEEAIANBg////wRxIAJBAEdBH3RyNgLUiYCAAEEAIAFBBHI2AqyKgIAAQQBBADYCsIqAgAAMAQsCQCABQQNxRQ0AQQAgATYCwImAgABBACABQXxqIAEgAhs2AtiJgIAAQQAgA0GD////BHFBkICAgHhBECACG3I2AtSJgIAAQQBBgIOA/ntBgIGAgHggBkGAgIACcRsiATYCqIqAgABBACAGQQJ0QTxxIAZBQHFyNgLQiYCAAEEAIAFBBHI2AqyKgIAAQQBBADYCsIqAgAAMAQsCQAJAIAFB/P///wFxIAEgAUGAgICAfHFBgICAgHhGGyICQf///wNLDQAgAkH8//8AcUGAi4CAAGooAgAhAgwBCwJAIAJBgICAgn5qIgNB//8fSw0AIANBgIuAgQBqKAIAIQIMAQsCQCACQYCAgIR+aiICQf8HSw0AIAJBgIuggQBqKAIAIQIMAQsgAUEEEICAgIAAIQILAkAgAUGAgICAfnFBgICAgHpHDQBBAEEAKwPgioCAAEEWQQQgAUGAgID+AXFBgICA/gFGG7egOQPgioCAAAtBAEEAKAKsioCAACIDNgKoioCAAEEAIANBBGo2AqyKgIAAIAJBEHQhByACQf//A3EhCCACQQt2QR9xIQkgAkEQdkEfcSEKIAJBFXZBH3EhCyACwSEMAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAIAJBGnYiDQ48AAECAwQFBgcICQoLDA0ODxASERIhISEhISEhISEhISETFBgVFhcZIRscHh0hIR8hEhIaEiEhISESEiASIQsgAkEGdkEfcSEGAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQCACQT9xDiwAHAECAxwEBQYHHBwICRwcCgsMDRwcHBwODxARHBwcHBITFBUWFxgZHBwaGxwLQQAgCTYC2JaggQAgCUECdEGgiICAAGogCkECdEGgiICAAGooAgAgBnQ2AgAMPwtBACAJNgLYlqCBACAJQQJ0QaCIgIAAaiAKQQJ0QaCIgIAAaigCACAGdjYCAAw+C0EAIAk2AtiWoIEAIAlBAnRBoIiAgABqIApBAnRBoIiAgABqKAIAIAZ1NgIADD0LQQAgCTYC2JaggQAgCUECdEGgiICAAGogCkECdEGgiICAAGooAgAgC0ECdEGgiICAAGooAgB0NgIADDwLQQAgCTYC2JaggQAgCUECdEGgiICAAGogCkECdEGgiICAAGooAgAgC0ECdEGgiICAAGooAgB2NgIADDsLQQAgCTYC2JaggQAgCUECdEGgiICAAGogCkECdEGgiICAAGooAgAgC0ECdEGgiICA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dEGgiICAAGogBDYCAAtBACEBQQBBACgC1JaggQA2ArSKgIAAQQBBACgC3JaggQA2AriKgIAAQQBBACsD4IqAgABEAAAAAAAA8D+gIg45A+CKgIAAQQBBACsD6IqAgABEAAAAAAAA8D+gOQPoioCAAEEAQQA2AqCIgIAAIA5BACsD8IqAgABjDQALCyAAQRBqJICAgIAAIAELsAEBA39BAEEAKALIioCAACICQXxqIAJBACgCzIqAgAAiAxs2AtiJgIAAQQBBgIOA/ntBgIGAgHhBACgC0ImAgAAiAkGAgIACcRsiBDYCqIqAgABBACACQQJ0QTxxIAJBQHFyNgLQiYCAAEEAIAFBHHQgAEECdHJBACgC1ImAgABBg////wRxciADQQBHQR90cjYC1ImAgABBACAEQQRyNgKsioCAAEEAQQA2ArCKgIAAC+tHAwR/CX4EfyOAgICAAEHgAGsiASSAgICAAAJAQQAtAOCWoIEADQBBAEEBOgDglqCBAEHwlqCBACECQYECIQMDQCACQYCAECADQX9qbkEBakEBdiIEQYECIARBgQJKG0H/fWo2AgAgA0GBBEYNASACQQRqQYCAECADbkEBakEBdiIEQYECIARBgQJKG0H/fWo2AgAgAkEIaiECIANBAmohAwwACwtBAEEANgLQioCAACAAQQp2QQFxIQIgAEETdkEBcSEDAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQCAAQT9xQX9qDj8BHBwcHAMcHBwcHAQcHBwFBgcIDhwJHBwcHAoPHAwcDRwcHBwcHBwREAAcHBITHAIcHBwcHBwcHBwcHBwUFQscCyABQQAoAtCToIEAIgRBgID8B3GtNwNQIAEgBEEIdEGAgPwHca03A0ggASAEQRB0QYCA/AdxrTcDQCABQcAAaiADIAIQjoCAgAAgAUEAKALQk6CBACIEQYCA/AdxrTcDUCABIARBCHRBgID8B3GtNwNIIAEgBEEQdEGAgPwHca03A0AgAUHAAGogAyACEI6AgIAAIAFBACgC0JOggQAiBEGAgPwHca03A1AgASAEQQh0QYCA/AdxrTcDSCABIARBEHRBgID8B3GtNwNAIAFBwABqIAMgAhCOgICAAAwbC0EAQQEgAyACEI+AgIAADBoLQQBBACADIAIQj4CAgABBAUEAIAMgAhCPgICAAEECQQEgAyACEI+AgIAADBkLQYCABCEDAkACQEEAKAK0k6CBACICwawiBUEAKAK4k6CBACIEQRB1rCIGfkEAKAKwk6CBACIAwawiByACQRB1rCIIfnwgBMGsIgkgAEEQdawiCn58IAYgB34gBSAKfnwgCSAIfnx9IgVC/////wdVDQBBgIACIQMgBUL/////d1UNAQtBACADNgLQioCAAAtBACAFPgLgk6CBAAwYC0GAgICABCEAAkACQEEAMgGIlqCBACIJQQA0AqyToIEAIgp+QQAyAZCWoIEAIgtBADQCqJOggQAiDH59IgVC////////AVUNAEGAgIDAACEAQQAhBCAFQv///////31VDQELQQAgADYC0IqAgAAgACEEC0EAMgGAlqCBACEGQQA0AqSToIEAIQdBACAFQhSGQhSHIgVCDIggBSADGyINPgLkk6CBAEIAQoCAfiACGyIFIQgCQAJAIAUgDcQiDVUNAEL//wEhCCANQoCAAlkNACANIQgMAQtBACAEQYCAgAhyIgQ2AtCKgIAAC0EAIAg+AqSToIEAQYCAgIACIQICQAJAIAsgB34gBiAKfn0iCEL///////8BVQ0AQYCAgCAhAiAIQv///////31VDQELQQAgBCACciIENgLQioCAAAtBACAIQhSGQhSHIghCDIggCCADGyIKPgLok6CBACAFIQgCQAJAIAUgCsQiClUNAEL//wEhCCAKQoCAAlkNACAKIQgMAQtBACAEQYCAgARyIgQ2AtCKgIAAC0EAIAg+AqiToIEAQYCAgIABIQICQAJAIAYgDH4gCSAHfn0iBkL///////8BVQ0AQYCAgBAhAiAGQv///////31VDQELQQAgBCACciIENgLQioCAAAtBACAGQhSGQhSHIgZCDIggBiADGyIGPgLsk6CBAAJAAkAgBSAGxCIGVQ0AQv//ASEFIAZCgIACUw0BC0EAIARBgICAAnI2AtCKgIAAIAUhBgtBACAGPgKsk6CBAAwXCyABQQAoApiToIEAIgRBgID8B3GtNwNQIAEgBEEIdEGAgPwHca03A0ggASAEQRB0QYCA/AdxrTcDQCABQcAAaiADIAIQjoCAgAAMFgtBADQCpJOggQAhBUEANAKok6CBACEGIAFBADQCrJOggQBCDIY3A1AgASAGQgyGNwNIIAEgBUIMhjcDQCABQcAAaiADIAIQjoCAgAAMFQsgAEENdiEOIABBD3ZBA3EhDwJAAkAgAEERdkEDcSIEQQNHDQAgAUEAKAKgk6CBADsBFCABQQAvAYSWoIEAIgQ7ARogASAEOwEYIAEgBDsBFiABQQAvAYiWoIEAIgQ7ASAgASAEOwEeIAEgBDsBHCABQQAvAZiToIEAQQR0QfAfcSIEOwESIAFBACAEazsBECABQRBqIQQMAQsgBEECdEGUiICAAGooAgAhBAsgDkEDcSEAAkACQAJAAkACQAJAIA8OBAECAwADCyABQQAoAqSToIEAIg82AjQgAUEAKAKok6CBACIQNgI4QQAoAqyToIEAIQ4MBAsgAUEAKAKAk6CBACIOwSIPNgI0QYSToIEAIREMAgsgAUEAKAKIk6CBACIOwSIPNgI0QYyToIEAIREMAQsgAUEAKAKQk6CBACIOwSIPNgI0QZSToIEAIRELIAEgDkEQdSIQNgI4IBEuAQAhDgsgASAONgI8AkAgAEECRw0AQgBCgIB+IAIbIQVCIEIUIAMbIQZBACECQYCAgIAEIQACQAJAIAQyAQAgD6wiCn5BADQC1JWggQBCDIZ8IglC////////AVUNAEGAgIDAACEAIAlC////////fVUNAQtBACAANgLQioCAACAAIQILIA6sIQcgEKwhCAJAAkAgCUIUhiAGhyIJIAVTDQAgCUKAgAJTDQELQQAgAkGAgIAIciICNgLQioCAAAtBgICAgAQhAAJAAkAgBDIBBCAHfiAEMgECIAh+fCIJQv///////wFVDQBBgICAwAAhACAJQv///////31VDQELQQAgACACciICNgLQioCAAAtBACAJQgyIIAkgAxsiC6ciADYC5JOggQAgBSEJAkACQCAFIAvEIgtVDQBC//8BIQkgAEGAgAJODQAgCyEJDAELQQAgAkGAgIAIciICNgLQioCAAAtBACAJPgKkk6CBAEGAgICAAiEAAkACQCAEMgEGIAp+QQA0AtiVoIEAQgyGfCIJQv///////wFVDQBBgICAICEAIAlC////////fVUNAQtBACAAIAJyIgI2AtCKgIAACwJAAkAgCUIUhiAGhyIJIAVTDQAgCUKAgAJTDQELQQAgAkGAgIAEciICNgLQioCAAAtBgICAgAIhAAJAAkAgBDIBCiAHfiAEMgEIIAh+fCIJQv///////wFVDQBBgICAICEAIAlC////////fVUNAQtBACAAIAJyIgI2AtCKgIAAC0EAIAlCDIggCSADGyILpyIANgLok6CBACAFIQkCQAJAIAUgC8QiC1UNAEL//wEhCSAAQYCAAk4NACALIQkMAQtBACACQYCAgARyIgI2AtCKgIAAC0EAIAk+AqiToIEAQYCAgIABIQACQAJAIAQyAQwgCn5BADQC3JWggQBCDIZ8IglC////////AVUNAEGAgIAQIQAgCUL///////99VQ0BC0EAIAAgAnIiAjYC0IqAgAALAkACQCAJQhSGIAaHIgYgBVMNACAGQoCAAlMNAQtBACACQYCAgAJyIgI2AtCKgIAAC0GAgICAASEAAkACQCAEMgEQIAd+IAQyAQ4gCH58IgZC////////AVUNAEGAgIAQIQAgBkL///////99VQ0BC0EAIAAgAnIiAjYC0IqAgAALQQAgBkIMiCAGIAMbIganIgM2AuyToIEAAkACQCAFIAbEIgZVDQBC//8BIQUgA0GAgAJIDQELQQAgAkGAgIACcjYC0IqAgAAgBSEGC0EAIAY+AqyToIEADBULQZyVoIEAIQ9BmJWggQAhEEGUlaCBACERQQAhDgJAAkACQCAADgIBAAILQbyVoIEAIQ9BuJWggQAhEEG0laCBACERCyABIBEoAgA2AiggASAQKAIANgIsIAEgDygCADYCMCABQShqIQ4LIAQgAUE0aiAOIAMgAkEBIAFBwABqEJCAgIAADBQLIAFBAC4BhJOggQA2AgwgAUEAKAKAk6CBACIEQRB1NgIIIAEgBME2AgRBoJaggQAgAUEEakEAIAMgAkEBIAFBwABqEJCAgIAAIAFBACgCpJOggQA2AjQgAUEAKQOok6CBADcCOCABQQAoArSVoIEANgIoIAFBACkDuJWggQA3AixBwJaggQAgAUE0aiABQShqIAMgAkEBIAFBwABqEJCAgIAAIAFBADQCrJOggQBBACgCmJOggQAiBEEMdkHwH3GtfjcDICABIARBBHZB8B9xrUEANAKok6CBAH43AxggASAEQQR0QfAfca1BADQCpJOggQB+NwMQIAFBEGogAyACEI6AgIAADBMLIAFBAC4BhJOggQA2AgwgAUEAKAKAk6CBACIEQRB1NgIIIAEgBME2AgRBoJaggQAgAUEEakEAIAMgAkEBIAFBwABqEJCAgIAAIAFBACgCpJOggQA2AjQgAUEAKQOok6CBADcCOCABQQAoArSVoIEANgIoIAFBACkDuJWggQA3AixBwJaggQAgAUE0aiABQShqIAMgAkEBIAFBwABqEJCAgIAAIAFBADQCrJOggQBBACgCmJOggQAiBEEMdkHwH3GtfjcDICABIARBBHZB8B9xrUEANAKok6CBAH43AxggASAEQQR0QfAfca1BADQCpJOggQB+NwMQIAFBEGogAyACEI6AgIAAIAFBAC4BjJOggQA2AgwgAUEAKAKIk6CBACIEQRB1NgIIIAEgBME2AgRBoJaggQAgAUEEakEAIAMgAkEBIAFBwABqEJCAgIAAIAFBACgCpJOggQA2AjQgAUEAKQOok6CBADcCOCABQQAoArSVoIEANgIoIAFBACkDuJWggQA3AixBwJaggQAgAUE0aiABQShqIAMgAkEBIAFBwABqEJCAgIAAIAFBADQCrJOggQBBACgCmJOggQAiBEEMdkHwH3GtfjcDICABIARBBHZB8B9xrUEANAKok6CBAH43AxggASAEQQR0QfAfca1BADQCpJOggQB+NwMQIAFBEGogAyACEI6AgIAAIAFBAC4BlJOggQA2AgwgAUEAKAKQk6CBACIEQRB1NgIIIAEgBME2AgRBoJaggQAgAUEEakEAIAMgAkEBIAFBwABqEJCAgIAAIAFBACgCpJOggQA2AjQgAUEAKQOok6CBADcCOCABQQAoArSVoIEANgIoIAFBACkDuJWggQA3AixBwJaggQAgAUE0aiABQShqIAMgAkEBIAFBwABqEJCAgIAAIAFBADQCrJOggQBBACgCmJOggQAiBEEMdkHwH3GtfjcDICABIARBBHZB8B9xrUEANAKok6CBAH43AxggASAEQQR0QfAfca1BADQCpJOggQB+NwMQIAFBEGogAyACEI6AgIAADBILIAFBAC4BhJOggQA2AgwgAUEAKAKAk6CBACIEQRB1NgIIIAEgBME2AgQgAUEEakEBIAMgAhCRgICAAAwRCyABQQAuAYSToIEANgIMIAFBACgCgJOggQAiBEEQdTYCCCABIATBNgIEIAFBBGpBASADIAIQkYCAgAAgAUEALgGMk6CBADYCDCABQQAoAoiToIEA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IgY+AuyToIEAIAUgBsQiBlUNBkL//wEhBSAGQv//AVUNBgwHC0GAgAQhAwJAAkBBAC8BxJOggQBBAC8ByJOggQBqQQAvAcyToIEAaq1BADIB9JWggQB+IgVC/////wdVDQBBgIAQIQJBgIACIQMgBUL/////d1UNAQtBACADNgLQioCAACADQYCAEHIhAgtBACAFPgLgk6CBAAJAIAVCDIciBUJ/VQ0AQQAgAjYC0IqAgABBAEEANgKck6CBAAwKCwJAIAVCgIAEVA0AQQAgAjYC0IqAgABBAEH//wM2ApyToIEADAoLQQAgBT4CnJOggQAMCQtBgIAEIQMCQAJAQQAvAcSToIEAQQAvAcCToIEAakEALwHIk6CBAGpBAC8BzJOggQBqrUEAMgH4laCBAH4iBUL/////B1UNAEGAgBAhAkGAgAIhAyAFQv////93VQ0BC0EAIAM2AtCKgIAAIANBgIAQciECC0EAIAU+AuCToIEAAkAgBUIMhyIFQn9VDQBBACACNgLQioCAAEEAQQA2ApyToIEADAkLAkAgBUKAgARUDQBBACACNgLQioCAAEEAQf//AzYCnJOggQAMCQtBACAFPgKck6CBAAwIC0IAQoCAfiACGyEFQQAyAaCToIEAIgdBADQCpJOggQB+IQZBACgCrJOggQAhAkEAKAKok6CBACEEAkACQAJAIANFDQBBgICAgAQhAAJAAkAgBkL///////8BVQ0AQQAhA0GAgIDAACEAIAZC////////fVUNAQtBACAANgLQioCAACAAIQMLQQAgBkIMiKciADYC5JOggQAgBSEIIAUgBkIUhkIghyIGVQ0BQv//ASEIIAZCgIACWQ0BIAYhCAwCC0GAgICABCEAAkACQCAGQv///////wFVDQBBACEDQYCAgMAAIQAgBkL///////99VQ0BC0EAIAA2AtCKgIAAIAAhAwtBACAGpyIANgLkk6CBACAFIQgCQAJAIAUgBsQiBlUNAEL//wEhCCAGQoCAAlkNACAGIQgMAQtBACADQYCAgAhyIgM2AtCKgIAAC0EAIAg+AqSToIEAQYCAgIACIQ4CQAJAIAcgBKx+IgZC////////AVUNAEGAgIAgIQ4gBkL///////99VQ0BC0EAIA4gA3IiAzYC0IqAgAALQQAgBqciDjYC6JOggQAgBSEIAkACQCAFIAbEIgZVDQBC//8BIQggBkKAgAJZDQAgBiEIDAELQQAgA0GAgIAEciIDNgLQioCAAAtBACAIPgKok6CBAEGAgICAASEEAkACQCAHIAKsfiIGQv///////wFVDQBBgICAECEEIAZC////////fVUNAQtBACAEIANyIgM2AtCKgIAAC0EAIAanIgI2AuyToIEAIAUgBsQiBlUNA0L//wEhBSAGQoCAAlMNBAwDC0EAIANBgICACHIiAzYC0IqAgAALQQAgCD4CpJOggQBBgICAgAIhDgJAAkAgByAErH4iBkL///////8BVQ0AQYCAgCAhDiAGQv///////31VDQELQQAgDiADciIDNgLQioCAAAtBACAGQgyIpyIONgLok6CBACAFIQgCQAJAIAUgBkIUhkIghyIGVQ0AQv//ASEIIAZCgIACWQ0AIAYhCAwBC0EAIANBgICABHIiAzYC0IqAgAALQQAgCD4CqJOggQBBgICAgAEhBAJAAkAgByACrH4iBkL///////8BVQ0AQYCAgBAhBCAGQv///////31VDQELQQAgBCADciIDNgLQioCAAAtBACAGQgyIpyICNgLsk6CBACAFIAZCFIZCIIciBlUNAUL//wEhBSAGQv//AVUNAQwCC0IAQoCAfiACGyEFQQA0AuSToIEAIQdBADIBoJOggQAhBkEAKAKsk6CBACECQQAoAqiToIEAIQRBACgCpJOggQAhAAJAAkACQAJAAkAgA0UNAEGAgICABCEOAkACQCAGIACsfiAHQgyGfCIHQv///////wFVDQBBACEDQYCAgMAAIQ4gB0L///////99VQ0BC0EAIA42AtCKgIAAIA4hAwtBACAHQgyIpyIANgLkk6CBACAFIQggBSAHQhSGQiCHIgdVDQFC//8BIQggB0KAgAJZDQEgByEIDAILQYCAgIAEIQ4CQAJAIAYgAKx+IAd8IgdC////////AVUNAEEAIQNBgICAwAAhDiAHQv///////31VDQELQQAgDjYC0IqAgAAgDiEDC0EAIAenIgA2AuSToIEAIAUhCAJAAkAgBSAHxCIHVQ0AQv//ASEIIAdCgIACWQ0AIAchCAwBC0EAIANBgICACHIiAzYC0IqAgAALQQAgCD4CpJOggQBBgICAgAIhDgJAAkAgBiAErH5BADQC6JOggQB8IgdC////////AVUNAEGAgIAgIQ4gB0L///////99VQ0BC0EAIA4gA3IiAzYC0IqAgAALQQAgB6ciDjYC6JOggQAgBSEIAkACQCAFIAfEIgdVDQBC//8BIQggB0KAgAJZDQAgByEIDAELQQAgA0GAgIAEciIDNgLQioCAAAtBACAIPgKok6CBAEGAgICAASEEAkACQCAGIAKsfkEANALsk6CBAHwiBkL///////8BVQ0AQYCAgBAhBCAGQv///////31VDQELQQAgBCADciIDNgLQioCAAAtBACAGpyICNgLsk6CBACAFIAbEIgZVDQJC//8BIQUgBkKAgAJTDQMMAgtBACADQYCAgAhyIgM2AtCKgIAAC0EAIAg+AqSToIEAQYCAgIACIQ4CQAJAQQA0AuiToIEAQgyGIAYgBKx+fCIHQv///////wFVDQBBgICAICEOIAdC////////fVUNAQtBACAOIANyIgM2AtCKgIAAC0EAIAdCDIinIg42AuiToIEAIAUhCAJAAkAgBSAHQhSGQiCHIgdVDQBC//8BIQggB0KAgAJZDQAgByEIDAELQQAgA0GAgIAEciIDNgLQioCAAAtBACAIPgKok6CBAEGAgICAASEEAkACQEEANALsk6CBAEIMhiAGIAKsfnwiBkL///////8BVQ0AQYCAgBAhBCAGQv///////31VDQELQQAgBCADciIDNgLQioCAAAtBACAGQgyIpyICNgLsk6CBACAFIAZCFIZCIIciBlUNAEL//wEhBSAGQv//AVcNAQtBACADQYCAgAJyIgM2AtCKgIAAIAUhBgtBACAGPgKsk6CBAEEAIQQCQAJAIABBBHUiAEEASA0AQf8BIQQgAEGAAk8NACAAIQQMAQtBACADQYCAgAFyIgM2AtCKgIAAC0EAIQACQAJAIA5BBHUiDkEASA0AQf8BIQAgDkGAAk8NACAOIQAMAQtBACADQYCAwAByIgM2AtCKgIAAC0EAIQ4CQAJAIAJBBHUiAkEASA0AQf8BIQ4gAkGAAkkNAQtBACADQYCAIHI2AtCKgIAAIA4hAgtBAEEAKQLUk6CBADcD0JOggQBBACAAQQh0IARqIAJBEHRqQQAtAJuToIEAQRh0ajYC2JOggQAMBgtBACADQYCAgAJyIgM2AtCKgIAAIAUhBgtBACAGPgKsk6CBAEEAIQQCQAJAIABBBHUi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AyAAIABBgICAgHxxQYCAgIB4RhsiA0H///8DSw0AIANB////AHEhAwJAAkACQCABQX5qDgMBAgACCyADQYCLgIAAaigCACEDDAMLIANBgIuAgABqLwEAIQMMAgsgA0GAi4CAAGotAAAhAwwBCwJAIANBgICAgn5qIgVB//8fSw0AAkACQAJAIAFBfmoOAwECAAILIAVBgIuAgQBqKAIAIQMMAwsgBUGAi4CBAGovAQAhAwwCCyAFQYCLgIEAai0AACEDDAELAkAgA0GAgICEfmoiA0H/B0sNAAJAAkACQCABQX5qDgMBAgACCyADQYCLoIEAaigCACEDDAMLIANBgIuggQBqLwEAIQMMAgsgA0GAi6CBAGotAAAhAwwBCyAAIAEQgICAgAAhAwsgAiADNgIAQQELCgAgABCGgICAAAt2AAJAIAANACABEIeAgIAADwsgAUEgaiEAAkACQCABQR9LDQBBASABdEGQoMDgBnENASABQR9HDQBBACgC0IqAgAAiAUGAwJ/8B3FBAEdBH3QgAXIPCyAAQQJ0QYCUoIEAaigCAA8LIABBAnRBgJSggQBqLgEACx4AAkAgAA0AIAEgAhCIgICAAA8LIAEgAhCJgICAAAv2CQYBfgJ/A34BfwF+AX9CIEIUIAEbIQNBACgC0IqAgAAhBEGAgICABCEFAkACQEEANALUlaCBAEIMhiAAKQMAIgZ9IgdC////////AVUNAEGAgIDAACEFIAdC////////fVUNAQtBACAEIAVyIgQ2AtCKgIAAC0EALgGgk6CBACEFQoCAfiEIAkACQCAHQhSGIAOHxCIHQoCAflMNAEL//wEhCCAHQoCAAlkNACAHIQgMAQtBACAEQYCAgAhyIgQ2AtCKgIAAC0IAQoCAfiACGyEHQYCAgIAEIQICQAJAIAYgBSAIp2ysfCIIQv///////wFVDQBBgICAwAAhAiAIQv///////31VDQELQQAgBCACciIENgLQioCAAAtBACAIQhSGQhSHIghCDIggCCABGyIGpyIJNgLkk6CBACAHIQgCQAJAIAcgBsQiBlUNAEL//wEhCCAGQoCAAlkNACAGIQgMAQtBACAEQYCAgAhyIgQ2AtCKgIAAC0EAIAg+AqSToIEAQYCAgIACIQICQAJAQQA0AtiVoIEAQgyGIAApAwgiCn0iBkL///////8BVQ0AQYCAgCAhAiAGQv///////31VDQELQQAgBCACciIENgLQioCAAAtCgIB+IQgCQAJAIAZCFIYgA4fEIgZCgIB+Uw0AQv//ASEIIAZCgIACWQ0AIAYhCAwBC0EAIARBgICABHIiBDYC0IqAgAALQYCAgIACIQICQAJAIAogBSAIp2ysfCIIQv///////wFVDQBBgICAICECIAhC////////fVUNAQtBACAEIAJyIgQ2AtCKgIAAC0EAIAhCFIZCFIciCEIMiCAIIAEbIganIgs2AuiToIEAIAchCAJAAkAgByAGxCIGVQ0AQv//ASEIIAZCgIACWQ0AIAYhCAwBC0EAIARBgICABHIiBDYC0IqAgAALQQAgCD4CqJOggQBBgICAgAEhAgJAAkBBADQC3JWggQBCDIYgACkDECIKfSIGQv///////wFVDQBBgICAECECIAZC////////fVUNAQtBACAEIAJyIgQ2AtCKgIAAC0KAgH4hCAJAAkAgBkIUhiADh8QiA0KAgH5TDQBC//8BIQggA0KAgAJZDQAgAyEIDAELQQAgBEGAgIACciIENgLQioCAAAtBgICAgAEhAAJAAkAgCiAFIAinbKx8IgNC////////AVUNAEGAgIAQIQAgA0L///////99VQ0BC0EAIAQgAHIiBDYC0IqAgAALQQAgA0IUhkIUhyIDQgyIIAMgARsiA6ciATYC7JOggQACQAJAIAcgA8QiA1UNAEL//wEhByADQoCAAlkNACADIQcMAQtBACAEQYCAgAJyIgQ2AtCKgIAAC0EAIAc+AqyToIEAQQAhAAJAAkAgCUEEdSIFQQBIDQBB/wEhACAFQYACTw0AIAUhAAwBC0EAIARBgICAAXIiBDYC0IqAgAALQQAhBQJAAkAgC0EEdSICQQBIDQBB/wEhBSACQYACTw0AIAIhBQwBC0EAIARBgIDAAHIiBDYC0IqAgAALQQAhAgJAAkAgAUEEdSIBQQBIDQBB/wEhAiABQYACSQ0BC0EAIARBgIAgcjYC0IqAgAAgAiEBC0EAQQApAtSToIEANwPQk6CBAEEAQQAtAJuToIEAQRh0IAFBEHQgBUEIdCAAampqNgLYk6CBAAvrCQQCfwN+AX8BfiOAgICAAEEwayIEJICAgIAAIARBACgClJWggQA2AhggBEEAKQOYlaCBADcCHAJAAkACQAJAIAAOAgABAgsgBEEAKAKAk6CBACIAwTYCJEGEk6CBACEFDAILIARBACgCiJOggQAiAME2AiRBjJOggQAhBQwBCyAEQQAoApCToIEAIgDBNgIkQZSToIEAIQULIAQgAEEQdTYCKCAEIAUuAQA2AixBgJaggQAgBEEkaiAEQRhqIAIgA0EAIAQQkICAgABCAEKAgH4gAxsiBiEHAkACQCAGQQAoAuSToIEAIgOsVQ0AQv//ASEHIANBgIACSA0BC0EAQQAoAtCKgIAAQYCAgAhyNgLQioCAACAHpyEDC0EAIAM2AqSToIEAIAYhBwJAAkAgBkEAKALok6CBACIArFUNAEL//wEhByAAQYCAAkgNAQtBAEEAKALQioCAAEGAgIAEcjYC0IqAgAAgB6chAAtBACAANgKok6CBAAJAIAQpAxBCDIciB0KAgH58Qv//e1YNAEEAQQAoAtCKgIAAQYCAgAJyNgLQioCAAAtBACAGQQA0AuyToIEAIghC//8BIAhC//8BUxsgBiAIVRs+AqyToIEAQgAhBgJAAkAgB0IAUw0AQv//AyEGIAdCgIAEVA0BC0EAQQAoAtCKgIAAQYCAEHI2AtCKgIAAIAYhBwtBACkCxJOggQAhBkEAQQAoAsyToIEANgLIk6CBAEEAIAY3A8CToIEAQQAgB6ciAjYCzJOggQACQAJAIAJBAXRBAC8B6JWggQAiBUsNAEEAQQAoAtCKgIAAQYCACHI2AtCKgIAAQv//ByEHDAELIAIgAmdBcGoiCXQiAkHAgH5qQQd1QQJ0QfCWoIEAaigCAEGBAmqsIgZCgICAgIiAgAEgBiACrX5CGIZ9QiCHfkIYhkKAgICACHxCIIcgBa0gCa2GfkKAgAJ8QhCHIgZC//8HIAZC//8HUxshBwtBgIAEIQICQAJAIAcgA6x+QQA0AuCVoIEAfCIIQv////8HVQ0AQYCAAiECIAhC/////3dVDQELQQBBACgC0IqAgAAgAnI2AtCKgIAAC0GAgAQhAwJAAkAgByAArH5BADQC5JWggQB8IgZC/////wdVDQBBgIACIQMgBkL/////d1UNAQtBAEEAKALQioCAACADcjYC0IqAgAALQQAgBj4C4JOggQAgBkIQhyEGQoB4IQoCQAJAIAhCEIciCEKAeFMNAEL/ByEKIAhCgAhTDQELQQBBACgC0IqAgABBgIABcjYC0IqAgAAgCiEIC0KAeCEKAkACQCAGQoB4Uw0AQv8HIQogBkKACFMNAQtBAEEAKALQioCAAEGAwAByNgLQioCAACAKIQYLQQBBACkCtJOggQA3A7CToIEAQQAgBqdBEHQgCKdB//8DcXI2AriToIEAAkAgAUUNAEGAgAQhAwJAAkAgB0EAMgHslaCBAH5BADQC8JWggQB8IgZC/////wdVDQBBgIACIQMgBkL/////d1UNAQtBAEEAKALQioCAACADcjYC0IqAgAALQQAgBj4C4JOggQBBACAGQgyHIgZCgCAgBkKAIFMbIgdCACAHQgBVGz4CoJOggQAgBkKBIFQNAEEAQQAoAtCKgIAAQYAgcjYC0IqAgAALIARBMGokgICAgAAL2QkDAX4BfwJ+QgAhBwJAIAJFDQAgAjQCAEIMhiEHC0GAgICABCEIAkACQCABNAIAIAAyAQB+IAd8IgdC////////AVUNAEGAgIDAACEIIAdC////////fVUNAQtBAEEAKALQioCAACAIcjYC0IqAgAALQYCAgIAEIQgCQAJAIAE0AgQgAEECajIBAH4gB0IUhkIUh3wiB0L///////8BVQ0AQYCAgMAAIQggB0L///////99VQ0BC0EAQQAoAtCKgIAAIAhyNgLQioCAAAtBgICAgAQhCAJAAkAgATQCCCAAQQRqMgEAfiAHQhSGQhSHfCIJQv///////wFVDQBBgICAwAAhCCAJQv///////31VDQELQQBBACgC0IqAgAAgCHI2AtCKgIAAC0IAQoCAfiAEGyEHIAYgCUIUhkIUhzcDAEEAIAlCDIggCSADGyIJpyIINgLkk6CBAAJAIAVFDQAgByEKAkACQCAHIAnEIglVDQBC//8BIQogCEGAgAJIDQELQQBBACgC0IqAgABBgICACHI2AtCKgIAAIAohCQtBACAJPgKkk6CBAAsCQAJAIAINAEIAIQkMAQsgAjQCBEIMhiEJC0GAgICAAiEIAkACQCABNAIAIAAyAQZ+IAl8IglC////////AVUNAEGAgIAgIQggCUL///////99VQ0BC0EAQQAoAtCKgIAAIAhyNgLQioCAAAtBgICAgAIhCAJAAkAgATQCBCAAQQhqMgEAfiAJQhSGQhSHfCIJQv///////wFVDQBBgICAICEIIAlC////////fVUNAQtBAEEAKALQioCAACAIcjYC0IqAgAALQYCAgIACIQgCQAJAIAE0AgggAEEKajIBAH4gCUIUhkIUh3wiCUL///////8BVQ0AQYCAgCAhCCAJQv///////31VDQELQQBBACgC0IqAgAAgCHI2AtCKgIAACyAGIAlCFIZCFIc3AwhBACAJQgyIIAkgAxsiCaciCDYC6JOggQACQCAFRQ0AIAchCgJAAkAgByAJxCIJVQ0AQv//ASEKIAhBgIACSA0BC0EAQQAoAtCKgIAAQYCAgARyNgLQioCAACAKIQkLQQAgCT4CqJOggQALAkACQCACDQBCACEJDAELIAI0AghCDIYhCQtBgICAgAEhAgJAAkAgATQCACAAMgEMfiAJfCIJQv///////wFVDQBBgICAECECIAlC////////fVUNAQtBAEEAKALQioCAACACcjYC0IqAgAALQYCAgIABIQICQAJAIAE0AgQgAEEOajIBAH4gCUIUhkIUh3wiCUL///////8BVQ0AQYCAgBAhAiAJQv///////31VDQELQQBBACgC0IqAgAAgAnI2AtCKgIAAC0GAgICAASECAkACQCABNAIIIABBEGoyAQB+IAlCFIZCFId8IglC////////AVUNAEGAgIAQIQIgCUL///////99VQ0BC0EAQQAoAtCKgIAAIAJyNgLQioCAAAsgBiAJQhSGQhSHNwMQQQAgCUIMiCAJIAMbIgmnIgE2AuyToIEAAkAgBUUNAAJAAkAgByAJxCIJVQ0AQv//ASEHIAFBgIACSA0BC0EAQQAoAtCKgIAAQYCAgAJyNgLQioCAACAHIQkLQQAgCT4CrJOggQALC/YKBAJ/An4DfwF+I4CAgIAAQdAAayIEJICAgIAAQQAhBUGglqCBACAAQQAgAiADQQEgBEEwahCQgICAACAEQQAoAqSToIEANgIkIARBACkDqJOggQA3AiggBEEAKAK0laCBADYCGCAEQQApA7iVoIEANwIcQcCWoIEAIARBJGogBEEYaiACIANBASAEQTBqEJCAgIAAAkACQAJAAkACQAJAIAEOAgABAgtBACgC0IqAgAAhAwJAAkBBACgC5JOggQBBBHUiAkEASA0AQf8BIQUgAkGAAk8NACACIQUMAQtBACADQYCAgAFyIgM2AtCKgIAAC0EAIQACQAJAQQAoAuiToIEAQQR1IgJBAEgNAEH/ASEAIAJBgAJPDQAgAiEADAELQQAgA0GAgMAAciIDNgLQioCAAAtBACEBAkACQEEAKALsk6CBAEEEdSICQQBIDQBB/wEhASACQYACSQ0BC0EAIANBgIAgcjYC0IqAgAAgASECC0EAQQApAtSToIEANwPQk6CBAEEAQQAtAJuToIEAQRh0IAJBEHQgAEEIdCAFampqNgLYk6CBAAwEC0IAQoCAfiADGyEGQQAoApiToIEAIgBBEHZB/wFxIQEgAEEIdkH/AXEhBSAAQf8Bca0hB0EAKALQioCAACEDQQAoAqyToIEAIQhBACgCqJOggQAhCUEAKAKkk6CBACEKAkAgAg0AQQAgCq0gB34iC6dBBHQiAjYC5JOggQAgBiEHAkACQCAGIAtCJIZCIIciC1UNAEL//wEhByALQoCAAlkNACALIQcMAQtBACADQYCAgAhyIgM2AtCKgIAAC0EAIAc+AqSToIEAQQAgCa0gBa1+IgunQQR0Igk2AuiToIEAIAYhBwJAAkAgBiALQiSGQiCHIgtVDQBC//8BIQcgC0KAgAJZDQAgCyEHDAELQQAgA0GAgIAEciIDNgLQioCAAAtBACAHPgKok6CBAEEAIAitIAGtfiIHp0EEdCIKNgLsk6CBACAGIAdCJIZCIIciB1UNAkL//wEhBiAHQoCAAlMNAwwCC0EAIAqsIAd+QgiIIgunIgI2AuSToIEAIAYhBwJAAkAgBiALxCILVQ0AQv//ASEHIAtCgIACWQ0AIAshBwwBC0EAIANBgICACHIiAzYC0IqAgAALQQAgBz4CpJOggQBBACAJrCAFrX5CCIgiC6ciCTYC6JOggQAgBiEHAkACQCAGIAvEIgtVDQBC//8BIQcgC0KAgAJZDQAgCyEHDAELQQAgA0GAgIAEciIDNgLQioCAAAtBACAHPgKok6CBAEEAIAisIAGtfkIIiCIHpyIKNgLsk6CBACAGIAfEIgdVDQFC//8BIQYgB0L//wFVDQEMAgsgBEEAKAKYk6CBACIAQQx2QfAfca1BADQCrJOggQB+NwMQIAQgAEEEdkHwH3GtQQA0AqiToIEAfjcDCCAEIABBBHRB8B9xrUEANAKkk6CBAH43AwAgBCACIAMQjoCAgAAMAgtBACADQYCAgAJyIgM2AtCKgIAAIAYhBwtBACAHPgKsk6CBAEEAIQECQAJAIAJBBHUiAkEASA0AQf8BIQEgAkGAAk8NACACIQEMAQtBACADQYCAgAFyIgM2AtCKgIAAC0EAIQUCQAJAIAlBBHUiAkEASA0AQf8BIQUgAkGAAk8NACACIQUMAQtBACADQYCAwAByIgM2AtCKgIAAC0EAIQgCQAJAIApBBHUiAkEASA0AQf8BIQggAkGAAkkNAQtBACADQYCAIHI2AtCKgIAAIAghAgtBAEEAKQLUk6CBADcD0JOggQBBACAAQYCAgHhxIAJBEHQgBUEIdCABampqNgLYk6CBAAsgBEHQAGokgICAgAALCycBAEGACAsgBgwYBgUJChk3EREmBg0ZBQwYAAAACygAIAsoAEALKAA=';

return { WASM_B64 };
})();
const __src_wasmcpu = (() => {
// ============================================================================
//  CPU em WebAssembly (wasm/cpu.c): liga o núcleo compilado ao PSX.
//  RAM, BIOS e scratchpad passam a viver na memória linear do wasm (o JS enxerga como os mesmos Uint8Array de sempre);
//  os registradores da CPU também (cpu.r, cpu.cop0 e as propriedades pc/nextPc/cycles... viram janelas para essa memória).
//  Acessos a I/O e o GTE voltam ao JS por imports. Sem JIT: o núcleo é um interpretador compilado (sem aquecimento).
// ============================================================================
const { WASM_B64 } = __src_wasmbin;
let compiled = null;
function module_() {
  if (!compiled) {
    const bin = atob(WASM_B64), u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    compiled = new WebAssembly.Module(u8);
  }
  return compiled;
}

function wasmAvailable() { return typeof WebAssembly === 'object' && typeof WebAssembly.Module === 'function'; }

/** troca a CPU do `psx` pelo núcleo wasm. Pode ser chamado com a máquina em qualquer estado (copia o que já existe). */
function enableWasm(psx) {
  if (psx.wasm) return psx.wasm;
  const cpu = psx.cpu, bus = psx.bus, gte = cpu.gte;
  const memory = new WebAssembly.Memory({ initial: 64, maximum: 64 });
  const env = {
    memory,
    bread: (a, s) => { const v = bus.read(a >>> 0, s); S[7] = (bus.istat & bus.imask) !== 0 ? 1 : 0; return v | 0; },
    bwrite: (a, s, v) => { bus.write(a >>> 0, s, v >>> 0); S[7] = (bus.istat & bus.imask) !== 0 ? 1 : 0; },
  };
  const inst = new WebAssembly.Instance(module_(), { env });
  const x = inst.exports, buf = memory.buffer, P = i => x.ptr(i);
  const R = new Uint32Array(buf, P(0), 32), C0 = new Uint32Array(buf, P(1), 32), S = new Uint32Array(buf, P(2), 16), D = new Float64Array(buf, P(3), 4);
  const RAM = new Uint8Array(buf, P(4), 2 * 1024 * 1024), BIOS = new Uint8Array(buf, P(5), 512 * 1024), SCR = new Uint8Array(buf, P(6), 1024);

  // GTE: registradores na memória do wasm (o GTE em C substitui o de JS)
  const gd = new Int32Array(buf, P(7), 32), gc = new Int32Array(buf, P(8), 64), grt = new Int16Array(buf, P(9), 9), gll = new Int16Array(buf, P(10), 9), glc = new Int16Array(buf, P(11), 9);
  gd.set(gte.d); gc.set(gte.c); grt.set(gte.rt); gll.set(gte.ll); glc.set(gte.lc); const gflag = gte.flag;
  gte.d = gd; gte.c = gc; gte.rt = grt; gte.ll = gll; gte.lc = glc;
  Object.defineProperty(gte, 'flag', { get: () => S[12], set: v => { S[12] = v >>> 0; }, enumerable: true, configurable: true }); gte.flag = gflag;
  // copia o estado atual para a memória do wasm
  R.set(cpu.r); C0.set(cpu.cop0); RAM.set(bus.ram); BIOS.set(bus.bios); SCR.set(bus.scratch);
  const cur = { hi: cpu.hi, lo: cpu.lo, pc: cpu.pc, nextPc: cpu.nextPc, isBranch: cpu.isBranch, pendReg: cpu.pendReg, pendVal: cpu.pendVal, cycles: cpu.cycles, instrCount: cpu.instrCount, nextTick: psx.nextTick };
  cpu.r = R; cpu.cop0 = C0;
  bus.ram = RAM; bus.ramView = new DataView(buf, P(4), RAM.length);
  bus.bios = BIOS; bus.biosView = new DataView(buf, P(5), BIOS.length);
  bus.scratch = SCR; bus.scratchView = new DataView(buf, P(6), SCR.length);

  const u32 = (o, name, i) => Object.defineProperty(o, name, { get: () => S[i], set: v => { S[i] = v; }, enumerable: true, configurable: true });
  const bool = (o, name, i) => Object.defineProperty(o, name, { get: () => S[i] !== 0, set: v => { S[i] = v ? 1 : 0; }, enumerable: true, configurable: true });
  const f64 = (o, name, i) => Object.defineProperty(o, name, { get: () => D[i], set: v => { D[i] = v; }, enumerable: true, configurable: true });
  u32(cpu, 'hi', 0); u32(cpu, 'lo', 1); u32(cpu, 'pc', 2); u32(cpu, 'nextPc', 3); bool(cpu, 'isBranch', 4); u32(cpu, 'pendReg', 5); u32(cpu, 'pendVal', 6);
  f64(cpu, 'cycles', 0); f64(cpu, 'instrCount', 1); f64(psx, 'nextTick', 2);
  cpu.hi = cur.hi; cpu.lo = cur.lo; cpu.pc = cur.pc; cpu.nextPc = cur.nextPc; cpu.isBranch = cur.isBranch; cpu.pendReg = cur.pendReg; cpu.pendVal = cur.pendVal;
  cpu.cycles = cur.cycles; cpu.instrCount = cur.instrCount; psx.nextTick = cur.nextTick;
  S[8] = psx.hookTTY ? 1 : 0;

  psx.useJit = false; psx.jit.flush();
  const w = psx.wasm = {
    memory, exports: x, S,
    /** roda até o próximo tick; devolve 1 se parou no vetor A0/B0 (TTY) */
    run() { S[7] = (bus.istat & bus.imask) !== 0 ? 1 : 0; S[8] = psx.hookTTY ? 1 : 0; return x.run(); },
    skipHook() { S[9] = 1; },
  };
  return w;
}

return { wasmAvailable, enableWasm };
})();
const __src_disasm = (() => {
// Disassembler MIPS I (R3000A) - usado para trace/debug
const { REG_NAMES } = __src_cpu;
const R = REG_NAMES.map(n => '$' + n);
const h = (v, n = 8) => '0x' + (v >>> 0).toString(16).padStart(n, '0');

function disasm(w, pc) {
  if (w === 0) return 'nop';
  const op = w >>> 26, rs = (w >>> 21) & 31, rt = (w >>> 16) & 31, rd = (w >>> 11) & 31;
  const sh = (w >>> 6) & 31, imm = w & 0xFFFF, simm = (w << 16) >> 16;
  const mem = n => `${n} ${R[rt]}, ${simm}(${R[rs]})`;
  const br = n => `${n} ${R[rs]}, ${R[rt]}, ${h(pc + 4 + (simm << 2))}`;
  switch (op) {
    case 0x00: {
      const f = w & 0x3F;
      const sh3 = { 0x00: 'sll', 0x02: 'srl', 0x03: 'sra' };
      const shv = { 0x04: 'sllv', 0x06: 'srlv', 0x07: 'srav' };
      const alu = { 0x20: 'add', 0x21: 'addu', 0x22: 'sub', 0x23: 'subu', 0x24: 'and', 0x25: 'or', 0x26: 'xor', 0x27: 'nor', 0x2A: 'slt', 0x2B: 'sltu' };
      if (sh3[f]) return `${sh3[f]} ${R[rd]}, ${R[rt]}, ${sh}`;
      if (shv[f]) return `${shv[f]} ${R[rd]}, ${R[rt]}, ${R[rs]}`;
      if (alu[f]) return `${alu[f]} ${R[rd]}, ${R[rs]}, ${R[rt]}`;
      switch (f) {
        case 0x08: return `jr ${R[rs]}`;
        case 0x09: return `jalr ${R[rd]}, ${R[rs]}`;
        case 0x0C: return 'syscall';
        case 0x0D: return 'break';
        case 0x10: return `mfhi ${R[rd]}`;
        case 0x11: return `mthi ${R[rs]}`;
        case 0x12: return `mflo ${R[rd]}`;
        case 0x13: return `mtlo ${R[rs]}`;
        case 0x18: return `mult ${R[rs]}, ${R[rt]}`;
        case 0x19: return `multu ${R[rs]}, ${R[rt]}`;
        case 0x1A: return `div ${R[rs]}, ${R[rt]}`;
        case 0x1B: return `divu ${R[rs]}, ${R[rt]}`;
      }
      return `.word ${h(w)}`;
    }
    case 0x01: {
      const n = ['bltz', 'bgez', 'bltzal', 'bgezal'][((rt >> 3) & 2) | (rt & 1)];
      return `${n} ${R[rs]}, ${h(pc + 4 + (simm << 2))}`;
    }
    case 0x02: return `j ${h(((pc + 4) & 0xF0000000) | ((w & 0x3FFFFFF) << 2))}`;
    case 0x03: return `jal ${h(((pc + 4) & 0xF0000000) | ((w & 0x3FFFFFF) << 2))}`;
    case 0x04: return br('beq');
    case 0x05: return br('bne');
    case 0x06: return `blez ${R[rs]}, ${h(pc + 4 + (simm << 2))}`;
    case 0x07: return `bgtz ${R[rs]}, ${h(pc + 4 + (simm << 2))}`;
    case 0x08: return `addi ${R[rt]}, ${R[rs]}, ${simm}`;
    case 0x09: return `addiu ${R[rt]}, ${R[rs]}, ${simm}`;
    case 0x0A: return `slti ${R[rt]}, ${R[rs]}, ${simm}`;
    case 0x0B: return `sltiu ${R[rt]}, ${R[rs]}, ${simm}`;
    case 0x0C: return `andi ${R[rt]}, ${R[rs]}, ${h(imm, 4)}`;
    case 0x0D: return `ori ${R[rt]}, ${R[rs]}, ${h(imm, 4)}`;
    case 0x0E: return `xori ${R[rt]}, ${R[rs]}, ${h(imm, 4)}`;
    case 0x0F: return `lui ${R[rt]}, ${h(imm, 4)}`;
    case 0x10:
      if (rs === 0) return `mfc0 ${R[rt]}, cop0r${rd}`;
      if (rs === 4) return `mtc0 ${R[rt]}, cop0r${rd}`;
      if (w === 0x42000010) return 'rfe';
      return `cop0 ${h(w & 0x1FFFFFF)}`;
    case 0x12:
      if (w & 0x02000000) return `cop2 ${h(w & 0x1FFFFFF, 7)}`;
      return `${{ 0: 'mfc2', 2: 'cfc2', 4: 'mtc2', 6: 'ctc2' }[rs] || 'cop2?'} ${R[rt]}, cop2r${rd}`;
    case 0x20: return mem('lb');
    case 0x21: return mem('lh');
    case 0x22: return mem('lwl');
    case 0x23: return mem('lw');
    case 0x24: return mem('lbu');
    case 0x25: return mem('lhu');
    case 0x26: return mem('lwr');
    case 0x28: return mem('sb');
    case 0x29: return mem('sh');
    case 0x2A: return mem('swl');
    case 0x2B: return mem('sw');
    case 0x2E: return mem('swr');
    case 0x32: return `lwc2 cop2r${rt}, ${simm}(${R[rs]})`;
    case 0x3A: return `swc2 cop2r${rt}, ${simm}(${R[rs]})`;
  }
  return `.word ${h(w)}`;
}

return { disasm };
})();
const __src_bus = (() => {
// ============================================================================
//  Bus / Memory map do PS1
// ============================================================================
//  Endereço virtual (KUSEG/KSEG0/KSEG1) -> físico removendo os 3 bits altos:
//    KUSEG 0x00000000-0x7FFFFFFF  (cacheado, máscara 0xFFFFFFFF)
//    KSEG0 0x80000000-0x9FFFFFFF  (cacheado, máscara 0x7FFFFFFF)
//    KSEG1 0xA0000000-0xBFFFFFFF  (NÃO cacheado, máscara 0x1FFFFFFF)
//    KSEG2 0xC0000000-0xFFFFFFFF  (só 0xFFFE0130 = Cache Control)
//
//  Mapa físico:
//    0x00000000-0x007FFFFF  RAM 2MB (espelhada 4x até 8MB)
//    0x1F000000-0x1F7FFFFF  Expansion 1 (cartucho / PIO) - sem nada = 0xFF
//    0x1F800000-0x1F8003FF  Scratchpad (D-Cache usado como RAM, 1KB)
//    0x1F801000-0x1F801FFF  I/O (memctrl, DMA, timers, CDROM, GPU, MDEC, SPU)
//    0x1F802000-0x1F803FFF  Expansion 2 (POST/DUART)
//    0x1FC00000-0x1FC7FFFF  BIOS ROM 512KB
// ============================================================================

const REGION_MASK = new Uint32Array([
  0xFFFFFFFF, 0xFFFFFFFF, 0xFFFFFFFF, 0xFFFFFFFF, // KUSEG
  0x7FFFFFFF,                                     // KSEG0
  0x1FFFFFFF,                                     // KSEG1
  0xFFFFFFFF, 0xFFFFFFFF,                         // KSEG2
]);
const SIZE_MASK = [0, 0xFF, 0xFFFF, 0, 0xFFFFFFFF];

const RAM_SIZE = 2 * 1024 * 1024;
const BIOS_SIZE = 512 * 1024;

class Bus {
  constructor() {
    this.pollOn = false; this.ioSeq = 0; this.psx = null; this.poll = { p: -1, v: -1, t: 0, d1: -1, d2: -2, n: 0, seq: 0, skipped: 0, jumps: 0 };
    this.ram = new Uint8Array(RAM_SIZE);
    this.ramView = new DataView(this.ram.buffer);
    this.scratch = new Uint8Array(1024);
    this.scratchView = new DataView(this.scratch.buffer);
    this.bios = new Uint8Array(BIOS_SIZE).fill(0xFF);
    this.biosView = new DataView(this.bios.buffer);
    this.io = new Uint8Array(0x2000);          // backing store dos registradores I/O ainda não emulados
    this.ioView = new DataView(this.io.buffer);

    this.codeFlags = new Uint8Array(RAM_SIZE >> 6);   // linhas de 64 B da RAM que contêm código compilado (JIT)
    this.onCodeWrite = null;
    this.istat = 0;                            // 0x1F801070 I_STAT
    this.imask = 0;                            // 0x1F801074 I_MASK
    this.cacheCtrl = 0;                        // 0xFFFE0130
    this.gpuToggle = 0;

    this.logIo = false;                        // contabiliza acessos a I/O (útil p/ mapear o que a BIOS usa)
    this.ioStats = new Map();
    this.unmapped = new Map();
    this.onPost = null;                        // callback(code) escrita em 0x1F802041
    this.gpu = null;                           // GPU  (0x1F801810 / 0x1F801814)
    this.spu = null;                           // SPU  (0x1F801C00-0x1F801FFF)
    this.dma = null; this.timers = null; this.sio = null; this.cdrom = null; this.mdec = null;   // dispositivos (ligados pelo PSX)
  }

  loadBios(data) {
    if (data.length !== BIOS_SIZE) throw new Error(`BIOS deve ter ${BIOS_SIZE} bytes, recebeu ${data.length}`);
    this.bios.set(data);
  }

  // ---- IRQ (I_STAT / I_MASK) ----
  irqPending() { return (this.istat & this.imask) !== 0; }
  raiseIrq(n) { this.istat |= (1 << n); }

  // ---- Leitura ----
  read32(addr) { return this.read(addr, 4); }
  read16(addr) { return this.read(addr, 2); }
  read8(addr)  { return this.read(addr, 1); }

  read(addr, size) {
    const p = (addr & REGION_MASK[addr >>> 29]) >>> 0;
    if (p < 0x00800000) {
      const o = p & 0x1FFFFF;
      return size === 4 ? this.ramView.getUint32(o, true)
           : size === 2 ? this.ramView.getUint16(o, true) : this.ram[o];
    }
    if (p >= 0x1FC00000 && p < 0x1FC80000) {
      const o = p - 0x1FC00000;
      return size === 4 ? this.biosView.getUint32(o, true)
           : size === 2 ? this.biosView.getUint16(o, true) : this.bios[o];
    }
    if (p >= 0x1F800000 && p < 0x1F800400) {
      const o = p - 0x1F800000;
      return size === 4 ? this.scratchView.getUint32(o, true)
           : size === 2 ? this.scratchView.getUint16(o, true) : this.scratch[o];
    }
    if (p >= 0x1F801000 && p < 0x1F802000) return this.ioRead(p, size);
    if (p >= 0x1F000000 && p < 0x1F800000) return SIZE_MASK[size];   // Expansion 1 vazio
    if (p >= 0x1F802000 && p < 0x1F804000) return 0;                 // Expansion 2
    if (p === 0xFFFE0130) return this.cacheCtrl;
    this.noteUnmapped('R', p, size);
    return SIZE_MASK[size];
  }

  // ---- Escrita ----
  write32(addr, v) { this.write(addr, 4, v); }
  write16(addr, v) { this.write(addr, 2, v); }
  write8(addr, v)  { this.write(addr, 1, v); }

  write(addr, size, v) {
    const p = (addr & REGION_MASK[addr >>> 29]) >>> 0;
    if (p < 0x00800000) {
      const o = p & 0x1FFFFF;
      if (size === 4) this.ramView.setUint32(o, v >>> 0, true);
      else if (size === 2) this.ramView.setUint16(o, v & 0xFFFF, true);
      else this.ram[o] = v;
      if (this.codeFlags[o >>> 6]) this.onCodeWrite(o);
      return;
    }
    if (p >= 0x1F800000 && p < 0x1F800400) {
      const o = p - 0x1F800000;
      if (size === 4) this.scratchView.setUint32(o, v >>> 0, true);
      else if (size === 2) this.scratchView.setUint16(o, v & 0xFFFF, true);
      else this.scratch[o] = v;
      return;
    }
    if (p >= 0x1F801000 && p < 0x1F802000) return this.ioWrite(p, size, v);
    if (p >= 0x1F802000 && p < 0x1F804000) {
      if (p === 0x1F802041 && this.onPost) this.onPost(v & 0xFF);
      return;
    }
    if (p >= 0x1FC00000 && p < 0x1FC80000) return;                   // ROM: ignora
    if (p >= 0x1F000000 && p < 0x1F800000) return;                   // Expansion 1
    if (p === 0xFFFE0130) { this.cacheCtrl = v >>> 0; return; }
    this.noteUnmapped('W', p, size);
  }

  // ---- I/O ----
  /** leitura de I/O. Com pollOn (psx.pollSkip = true) reconhece laços de espera ("lê o mesmo registrador, mesmo valor, período constante")
   *  e avança o relógio até o próximo instante em que o valor pode mudar (fim da linha de vídeo, evento agendado, fim do "ocupado" da GPU). */
  ioRead(p, size) {
    if (!this.pollOn) return this.ioRead0(p, size);
    const q = p & ~3;
    if (!(q === 0x1F801814 || q === 0x1F801070 || (p >= 0x1F801100 && p < 0x1F801130 && (p & 0xF) === 0) || (p >= 0x1F801080 && p < 0x1F801100 && (p & 0xF) === 8))) { this.ioSeq = (this.ioSeq + 1) | 0; return this.ioRead0(p, size); }
    let v = this.ioRead0(p, size);
    const ps = this.poll, psx = this.psx, now = psx.cpu.cycles, d = now - ps.t;
    if (p === ps.p && v === ps.v && this.ioSeq === ps.seq && d === ps.d2) ps.n++; else ps.n = 0;
    ps.d2 = ps.d1; ps.d1 = d; ps.t = now; ps.p = p; ps.v = v; ps.seq = this.ioSeq;
    if (ps.n >= 8) {
      ps.n = 0;
      if (!(this.istat & this.imask)) {
        let end = psx.lastTick + (psx.gpu.pal ? 2157.2 : 2146.3) - psx.lineAcc; const ev = psx.sched.next; if (ev < end) end = ev;
        const bu = psx.gpu.busyUntil; if (bu > now && bu < end) end = bu;
        if (end - now > 4 * (d > 0 ? d : 1)) { psx.cpu.cycles = Math.ceil(end); ps.skipped += end - now; ps.jumps++; v = this.ioRead0(p, size); ps.v = v; ps.t = psx.cpu.cycles; }
      }
    }
    return v;
  }
  ioRead0(p, size) {
    if (this.logIo) this.countIo('R', p, size);
    const off = p - 0x1F801000;
    if (p >= 0x1F801810 && p < 0x1F801818 && this.gpu) { if ((p & ~3) === 0x1F801810) return this.gpu.readData() >>> ((p & 3) * 8); return this.gpu.readStatus() >>> ((p & 3) * 8); }   // GPU primeiro (é o registrador mais lido)
    if (this.spu && p >= 0x1F801C00) return this.spu.read(p, size);
    if (this.cdrom && p >= 0x1F801800 && p < 0x1F801804) return this.cdrom.read(p, size);
    if (this.mdec && (p & ~3) >= 0x1F801820 && (p & ~3) <= 0x1F801824) return this.mdec.read(p & ~3);
    if (p >= 0x1F801820 && p < 0x1F801828) return (p & ~3) === 0x1F801824 ? 0x80040000 >>> ((p & 3) * 8) : 0;   // sem MDEC: status "FIFOs vazios"
    if (this.dma && p >= 0x1F801080 && p < 0x1F801100) return this.dma.read(p, size);
    if (this.timers && p >= 0x1F801100 && p < 0x1F801130) return this.timers.read(p, size);
    if (this.sio && p >= 0x1F801040 && p < 0x1F801050) return this.sio.read(p, size);
    // SPUSTAT (0x1F801DAE) espelha os 6 bits baixos do SPUCNT (0x1F801DAA) - fallback sem SPU
    if (p === 0x1F801DAE && size === 2) return this.ioView.getUint16(0xDAA, true) & 0x3F;

    const base = (p & ~3) >>> 0, shift = (p & 3) * 8;
    let v = null;
    switch (base) {
      case 0x1F801070: v = this.istat; break;
      case 0x1F801074: v = this.imask; break;
      case 0x1F801814:                                   // GPUSTAT (fallback sem GPU): pronto
        v = 0x1C000000; break;
    }
    if (v !== null) return ((v >>> shift) & SIZE_MASK[size]) >>> 0;

    return size === 4 ? this.ioView.getUint32(off, true)
         : size === 2 ? this.ioView.getUint16(off, true) : this.io[off];
  }

  ioWrite(p, size, v) {
    if (this.logIo) this.countIo('W', p, size);
    const off = p - 0x1F801000;
    if (this.spu && p >= 0x1F801C00) return this.spu.write(p, size, v);
    if (this.cdrom && p >= 0x1F801800 && p < 0x1F801804) return this.cdrom.write(p, size, v);
    if (this.dma && p >= 0x1F801080 && p < 0x1F801100) return this.dma.write(p, size, v);
    if (this.timers && p >= 0x1F801100 && p < 0x1F801130) return this.timers.write(p, size, v);
    if (this.sio && p >= 0x1F801040 && p < 0x1F801050) return this.sio.write(p, size, v);
    if (this.mdec && (p & ~3) >= 0x1F801820 && (p & ~3) <= 0x1F801824) return this.mdec.write(p & ~3, v);
    if (this.gpu && (p & ~3) === 0x1F801810) return this.gpu.writeGP0(v);
    if (this.gpu && (p & ~3) === 0x1F801814) return this.gpu.writeGP1(v);
    const base = (p & ~3) >>> 0, shift = (p & 3) * 8;
    const m = (SIZE_MASK[size] << shift);
    if (base === 0x1F801070) {                           // I_STAT: escrever 0 reconhece (limpa) o bit
      this.istat = (this.istat & (~m | (v << shift))) & 0x7FF; return;
    }
    if (base === 0x1F801074) {                           // I_MASK
      this.imask = ((this.imask & ~m) | ((v << shift) & m)) & 0x7FF; return;
    }
    if (size === 4) this.ioView.setUint32(off, v >>> 0, true);
    else if (size === 2) this.ioView.setUint16(off, v & 0xFFFF, true);
    else this.io[off] = v;
  }

  countIo(rw, p, size) {
    const k = `${rw}${size} ${p.toString(16).toUpperCase().padStart(8, '0')}`;
    this.ioStats.set(k, (this.ioStats.get(k) || 0) + 1);
  }
  noteUnmapped(rw, p, size) {
    const k = `${rw}${size} ${p.toString(16).toUpperCase().padStart(8, '0')}`;
    this.unmapped.set(k, (this.unmapped.get(k) || 0) + 1);
  }
}

return { RAM_SIZE, BIOS_SIZE, Bus };
})();
const __src_gpu = (() => {
// ============================================================================
//  GPU do PS1 - rasterizador por software
// ============================================================================
//  Portas:  0x1F801810 GP0 (desenho/VRAM) / GPUREAD      0x1F801814 GP1 (controle) / GPUSTAT
//  VRAM:    1024x512 pixels de 16 bits (RGB555 + bit de máscara)
//
//  Implementado: fill, polígonos (flat/gouraud/texturizados 4/8/15 bits, semi-transparência
//  4 modos, dither, máscara), retângulos, linhas/polilinhas, cópias de VRAM (CPU<->VRAM,
//  VRAM->VRAM), janela de textura, area/offset de desenho, saída 15/24 bits.
//  Simplificações: sem timing real de GPU, interpolação em ponto flutuante (não bit-exata).
// ============================================================================

const PH_CMD = 0, PH_VRAM_WRITE = 1, PH_POLYLINE = 2;
const LINE_EX = 1 / 4194304, LINE_EY = 0;                  // viés de arredondamento de x (medido no console real)
const DITHER = [-4, 0, -3, 1, 2, -2, 3, -1, -3, 1, -4, 0, 3, -1, 2, -2];
const sx11 = v => (v << 21) >> 21;                       // sinal 11 bits


// ---- scanline especializada (gerada por combinação de modos): mesma aritmética do plotNB/texel, sem ramos por pixel ----
const QT = new Uint8Array(1024); for (let i = 0; i < 1024; i++) { const v = i - 8; QT[i] = (v < 0 ? 0 : v > 255 ? 255 : v) >> 3; }   // clamp8(v) >> 3, índice v+8
const DITHER_T = new Int8Array(DITHER);
const SPANS = new Map();
function spanFor(tex, td, gour, raw, semi, dd, chk, win) {
  const key = (tex ? td : 'n') + (gour ? 'G' : 'f') + (raw ? 'R' : 'm') + (semi ? 'S' : 'o') + (dd ? 'D' : 'n') + (chk ? 'C' : '-') + (win ? 'W' : '-');
  let f = SPANS.get(key); if (f) return f;
  let c = 'const rowI = y * 1024, dRow = (y & 3) << 2;\nfor (let x = xl; x < xr; x++) {\n';
  c += gour ? 'let r = ((cr | 0) >> 12) & 255, g = ((cg | 0) >> 12) & 255, bl = ((cb | 0) >> 12) & 255; cr += rGx; cg += gGx; cb += bGx;\n' : 'let r = fr, g = fg, bl = fb;\n';
  if (tex) {
    c += win ? 'const u = (((cu | 0) >> 12) & 255 & uAnd) | uOr, v = (((cv | 0) >> 12) & 255 & vAnd) | vOr;\n' : 'const u = ((cu | 0) >> 12) & 255, v = ((cv | 0) >> 12) & 255;\n';
    c += 'cu += uGx; cv += vGx;\nconst row = ((tY + v) & 0x1FF) << 10;\n';
    if (td === 0) c += 'const texel = clut[(vram[row + ((tBase + (u >> 2)) & 0x3FF)] >> ((u & 3) << 2)) & 15];\n';
    else if (td === 1) c += 'const texel = clut[(vram[row + ((tBase + (u >> 1)) & 0x3FF)] >> ((u & 1) << 3)) & 255];\n';
    else c += 'const texel = vram[row + ((tBase + u) & 0x3FF)];\n';
    c += 'if (texel === 0) continue;\n';
    if (semi) c += 'const sm = (texel & 0x8000) !== 0;\n';
    c += 'const tr = texel & 31, tg = (texel >> 5) & 31, tb = (texel >> 10) & 31;\n';
    c += raw ? 'r = tr << 3; g = tg << 3; bl = tb << 3;\n' : 'r = (tr * r) >> 4; g = (tg * g) >> 4; bl = (tb * bl) >> 4;\n';
  }
  c += 'const idx = rowI + x;\n';
  if (chk || semi) c += 'const back = vram[idx];\n';
  if (chk) c += 'if (back & 0x8000) continue;\n';
  if (dd) c += 'const d = DITHER[dRow | (x & 3)]; r += d; g += d; bl += d;\n';
  c += 'r = QT[r + 8]; g = QT[g + 8]; bl = QT[bl + 8];\n';
  if (semi) {
    const blend = 'const br = back & 31, bg = (back >> 5) & 31, bb = (back >> 10) & 31;\n' +
      'switch (smode) {\ncase 0: r = (br + r) >> 1; g = (bg + g) >> 1; bl = (bb + bl) >> 1; break;\n' +
      'case 1: r = br + r > 31 ? 31 : br + r; g = bg + g > 31 ? 31 : bg + g; bl = bb + bl > 31 ? 31 : bb + bl; break;\n' +
      'case 2: r = br - r < 0 ? 0 : br - r; g = bg - g < 0 ? 0 : bg - g; bl = bb - bl < 0 ? 0 : bb - bl; break;\n' +
      'default: r = Math.min(31, br + (r >> 2)); g = Math.min(31, bg + (g >> 2)); bl = Math.min(31, bb + (bl >> 2));\n}\n';
    c += tex ? 'if (sm) {\n' + blend + '}\n' : '{\n' + blend + '}\n';
  }
  c += 'vram[idx] = r | (g << 5) | (bl << 10) | setM;\n}';
  f = new Function('vram', 'clut', 'QT', 'DITHER', 'y', 'xl', 'xr', 'cr', 'cg', 'cb', 'cu', 'cv', 'rGx', 'gGx', 'bGx', 'uGx', 'vGx', 'fr', 'fg', 'fb', 'tBase', 'tY', 'uAnd', 'uOr', 'vAnd', 'vOr', 'smode', 'setM', c);
  SPANS.set(key, f); return f;
}

class GPU {
  constructor() {
    this.vram = new Uint16Array(1024 * 512);
    this.pal = false;
    this.onIrq = null;
    this.hw = null;                                          // renderizador WebGL (glgpu.js); null = software
    this.remote = null;                                      // GpuStream: o desenho acontece num worker (esta instância só analisa os comandos e mantém o estado/temporização)
    this.line = 0; this.vblank = false; this.field = 0;      // temporização (atualizada pelo PSX)
    this.reset();
  }

  reset() {
    this.phase = PH_CMD; this.buf = []; this.need = 1;
    // ---- estado de desenho (GP0 E1..E6) ----
    this.texX = 0; this.texY = 0; this.semiMode = 0; this.texDepth = 0; this.dither = false;
    this.drawToDisplay = false; this.texDisable = false; this.texDisAllow = false; this.busyUntil = 0; this.skipDraw = false; this.flipX = false; this.flipY = false;
    this.twMaskX = 0; this.twMaskY = 0; this.twOffX = 0; this.twOffY = 0;
    this.daX1 = 0; this.daY1 = 0; this.daX2 = 0; this.daY2 = 0;
    this.offX = 0; this.offY = 0;
    this.setMask = false; this.checkMask = false;
    this.clutValid = false; this.clutX = 0; this.clutY = 0; this.clutCount = 0; this.clut ??= new Uint16Array(256);   // cache de CLUT
    // ---- display (GP1) ----
    this.dispOn = false; this.dmaDir = 0; this.startX = 0; this.startY = 0;
    this.hx1 = 0x200; this.hx2 = 0xC00; this.vy1 = 0x10; this.vy2 = 0x100;
    this.hres1 = 0; this.hres2 = 0; this.vres = 0; this.rgb24 = false; this.interlace = false; this.reverse = false; this.deint = 1; this.snapPar = 0;
    this.irq1 = false;
    this.gpuRead = 0; this.infoSel = 0;
    // ---- transferências ----
    this.vw = null; this.vr = null;
    this.toggle = 0; this.line = 0; this.vblank = false; this.field = 0;
    this.frameCount = 0; this.snap = null; this.snapKey = '';
  }

  // ===================== Registradores =====================
  readStatus() {
    let s = (this.texX & 15) | ((this.texY & 1) << 4) | (this.semiMode << 5) | (this.texDepth << 7) |
            ((this.dither ? 1 : 0) << 9) | ((this.drawToDisplay ? 1 : 0) << 10) | ((this.setMask ? 1 : 0) << 11) |
            ((this.checkMask ? 1 : 0) << 12) | (1 << 13) | ((this.reverse ? 1 : 0) << 14) | ((this.texDisable ? 1 : 0) << 15) |
            (this.hres2 << 16) | (this.hres1 << 17) | (this.vres << 19) | ((this.pal ? 1 : 0) << 20) |
            ((this.rgb24 ? 1 : 0) << 21) | ((this.interlace ? 1 : 0) << 22) | ((this.dispOn ? 0 : 1) << 23) |
            ((this.irq1 ? 1 : 0) << 24);
    const busy = !!this.clock && this.clock() < this.busyUntil;                 // GPU ainda desenhando o último comando
    const readyCmd = this.phase === PH_CMD && !this.vr && !busy;
    s |= (readyCmd ? 1 << 26 : 0) | (this.vr ? 1 << 27 : 0) | ((this.dmaDir === 0 || !busy ? 1 : 0) << 28) | (this.dmaDir << 29);
    // bit 25 = DMA data request, depende da direção
    const req = this.dmaDir === 0 ? 0 : this.dmaDir === 1 ? 1 : this.dmaDir === 2 ? (readyCmd ? 1 : 0) : (this.vr ? 1 : 0);
    s |= req << 25;
    // bit 31: campo par/ímpar - alterna (aproximação até existir timing de scanline)
    const odd = (this.interlace && this.vres) ? this.field : (this.vblank ? 0 : (this.line & 1));
    s |= (odd << 31);
    return s >>> 0;
  }

  readData() {                                    // GPUREAD
    if (this.vr) return this.vramReadWord();
    return this.gpuRead >>> 0;
  }

  // ===================== GP1 =====================
  writeGP1(w) {
    if (this.remote) this.remote.push(1, w >>> 0);
    const cmd = w >>> 24, p = w & 0xFFFFFF;
    switch (cmd) {
      case 0x00: this.reset(); break;
      case 0x01: this.phase = PH_CMD; this.buf = []; this.vw = null; this.vr = null; break;
      case 0x02: this.irq1 = false; break;
      case 0x03: this.dispOn = !(p & 1); break;
      case 0x04: this.dmaDir = p & 3; break;
      case 0x05: this.startX = p & 0x3FE; this.startY = (p >> 10) & 0x1FF; break;
      case 0x06: this.hx1 = p & 0xFFF; this.hx2 = (p >> 12) & 0xFFF; break;
      case 0x07: this.vy1 = p & 0x3FF; this.vy2 = (p >> 10) & 0x3FF; break;
      case 0x08:
        this.hres1 = p & 3; this.vres = (p >> 2) & 1; this.pal = !!((p >> 3) & 1);
        this.rgb24 = !!((p >> 4) & 1); this.interlace = !!((p >> 5) & 1); this.hres2 = (p >> 6) & 1; this.reverse = !!((p >> 7) & 1);
        break;
      case 0x09: this.texDisAllow = !!(p & 1); break;   // permite o bit "texture disable" (E1.11)
      default:
        if (cmd >= 0x10 && cmd <= 0x1F) {           // GET GPU INFO
          switch (p & 7) {
            case 2: this.gpuRead = this.twMaskX | (this.twMaskY << 5) | (this.twOffX << 10) | (this.twOffY << 15); break;
            case 3: this.gpuRead = this.daX1 | (this.daY1 << 10); break;
            case 4: this.gpuRead = this.daX2 | (this.daY2 << 10); break;
            case 5: this.gpuRead = (this.offX & 0x7FF) | ((this.offY & 0x7FF) << 11); break;
            case 7: this.gpuRead = 2; break;        // tipo de GPU
            default: break;
          }
        }
    }
  }

  // ===================== GP0 =====================
  writeGP0(w) {
    w >>>= 0;
    const R = this.remote; if (R) { if (R.n >= R.q.length) R.flush(); R.q[R.n++] = 0; R.q[R.n++] = w; }
    if (this.phase === PH_VRAM_WRITE) { this.vramWriteWord(w); return; }
    if (this.phase === PH_POLYLINE) { this.polylineWord(w); return; }
    if (this.buf.length === 0) this.need = this.wordsFor(w >>> 24);
    this.buf.push(w);
    if (this.buf.length >= this.need) {
      const b = this.buf; this.buf = [];
      this.exec(b);
    }
  }
  /** Para DMA (canal 2): bloco de palavras em RAM */
  dmaWrite(words) { for (let i = 0; i < words.length; i++) this.writeGP0(words[i]); }
  dmaRead(n) { const o = new Uint32Array(n); for (let i = 0; i < n; i++) o[i] = this.readData(); return o; }

  wordsFor(c) {
    if (c === 0x02) return 3;
    if (c >= 0x20 && c <= 0x3F) { const v = (c & 8) ? 4 : 3; return 1 + v + ((c & 4) ? v : 0) + ((c & 0x10) ? v - 1 : 0); }
    if (c >= 0x40 && c <= 0x5F) return (c & 0x10) ? 4 : 3;           // polilinha trata o resto
    if (c >= 0x60 && c <= 0x7F) return 2 + ((c & 4) ? 1 : 0) + (((c >> 3) & 3) === 0 ? 1 : 0);
    if (c >= 0x80 && c <= 0x9F) return 4;
    if (c >= 0xA0 && c <= 0xDF) return 3;
    return 1;
  }

  exec(b) {
    const c = b[0] >>> 24;
    if (this.clock) this.chargeBusy(c, b);
    if (c === 0x02) return this.fillRect(b);
    if (c >= 0x20 && c <= 0x3F) return this.polygon(b, c);
    if (c >= 0x40 && c <= 0x5F) return this.lineCmd(b, c);
    if (c >= 0x60 && c <= 0x7F) return this.rect(b, c);
    if (c >= 0x80 && c <= 0x9F) return this.vramCopy(b);
    if (c >= 0xA0 && c <= 0xBF) return this.beginVramWrite(b);
    if (c >= 0xC0 && c <= 0xDF) return this.beginVramRead(b);
    switch (c) {
      case 0x01: this.clutValid = false; break;                  // limpa o cache de CLUT
      case 0x1F: this.irq1 = true; this.onIrq?.(); break;
      case 0xE1: {
        this.texX = b[0] & 15; this.texY = (b[0] >> 4) & 1; this.semiMode = (b[0] >> 5) & 3; this.texDepth = (b[0] >> 7) & 3;      // 3 é reservado: lido de volta como 3, tratado como 15 bits
        this.dither = !!((b[0] >> 9) & 1); this.drawToDisplay = !!((b[0] >> 10) & 1); this.texDisable = this.texDisAllow && !!((b[0] >> 11) & 1);
        this.flipX = !!((b[0] >> 12) & 1); this.flipY = !!((b[0] >> 13) & 1); break;
      }
      case 0xE2: this.twMaskX = b[0] & 31; this.twMaskY = (b[0] >> 5) & 31; this.twOffX = (b[0] >> 10) & 31; this.twOffY = (b[0] >> 15) & 31; break;
      case 0xE3: this.daX1 = b[0] & 0x3FF; this.daY1 = (b[0] >> 10) & 0x3FF; break;
      case 0xE4: this.daX2 = b[0] & 0x3FF; this.daY2 = (b[0] >> 10) & 0x3FF; break;
      case 0xE5: this.offX = sx11(b[0] & 0x7FF); this.offY = sx11((b[0] >> 11) & 0x7FF); break;
      case 0xE6: this.setMask = !!(b[0] & 1); this.checkMask = !!(b[0] & 2); break;
      default: break;                                // NOP / clear cache / etc.
    }
  }

  // ===================== Tempo de desenho (GPUSTAT: pronto p/ comando / DMA) =====================
  /** estima quantos ciclos de CPU o comando mantém a GPU ocupada e soma em busyUntil */
  chargeBusy(c, b) {
    let cyc = 0;
    const semi = !!(c & 2), tex = !!(c & 4);
    // fatores calibrados com ps1-tests/gpu/bandwidth (PS1 real): ciclos de CPU por pixel
    if (c === 0x02) cyc = (((b[2] & 0x3FF) + 15) & ~15) * ((b[2] >>> 16) & 0x1FF) * 0.085 + 30;
    else if (c >= 0x20 && c <= 0x3F) {
      const n = (c & 8) ? 4 : 3, gour = !!(c & 0x10), tx = !!(c & 4);
      let p = 1, x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
      for (let i = 0; i < n; i++) {
        if (i > 0 && gour) p++;
        const v = b[p++], x = ((v << 21) >> 21) + this.offX, y = ((v << 5) >> 21) + this.offY; if (tx) p++;
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
      x0 = Math.max(x0, this.daX1); y0 = Math.max(y0, this.daY1); x1 = Math.min(x1, this.daX2); y1 = Math.min(y1, this.daY2);   // só conta a parte visível
      const area = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
      cyc = area * (n === 4 ? 0.54 : 0.27) * (semi ? 1.5 : 1) * (tx ? 5.2 : 1) + 60;
    } else if (c >= 0x40 && c <= 0x5F) {
      const a = b[1], d = b[(c & 0x10) ? 3 : 2], dx = Math.abs(((a << 21) >> 21) - ((d << 21) >> 21)), dy = Math.abs(((a << 5) >> 21) - ((d << 5) >> 21));
      cyc = Math.max(dx, dy) * 1.2 + 40;
    } else if (c >= 0x60 && c <= 0x7F) {
      const sz = (c >> 3) & 3, w = sz === 0 ? b[b.length - 1] & 0x3FF : sz === 1 ? 1 : sz === 2 ? 8 : 16, h = sz === 0 ? (b[b.length - 1] >>> 16) & 0x1FF : sz === 1 ? 1 : sz === 2 ? 8 : 16;
      cyc = w * h * (tex ? 1.06 : semi ? 0.8 : 0.53) + 30;
    } else if (c >= 0x80 && c <= 0x9F) cyc = (((b[3] - 1) & 0x3FF) + 1) * ((((b[3] >>> 16) - 1) & 0x1FF) + 1) * 1.33 + 40;
    if (cyc > 0 && this.rowMask >= 0 && c !== 0x80 && !(c >= 0x80 && c <= 0x9F)) cyc *= 0.5;   // 480i: só metade das linhas é desenhada
    if (cyc > 0) { const now = this.clock(); this.busyUntil = Math.max(now, this.busyUntil) + cyc; }
  }

  // ===================== Transferências VRAM =====================
  fillRect(b) {
    const col = rgb24to15(b[0]);
    const x0 = b[1] & 0x3F0, y0 = (b[1] >>> 16) & 0x1FF;
    const w = ((b[2] & 0x3FF) + 0xF) & ~0xF, h = (b[2] >>> 16) & 0x1FF;
    if (this.remote) return;
    if (this.hw) return this.hw.fill(x0, y0, w, h, b[0]);
    const mk = this.rowMask;
    for (let y = 0; y < h; y++) {
      if (mk >= 0 && ((y0 + y) & 1) === mk) continue;
      const row = ((y0 + y) & 0x1FF) * 1024;
      for (let x = 0; x < w; x++) this.vram[row + ((x0 + x) & 0x3FF)] = col;
    }
  }

  beginVramWrite(b) {
    const x = b[1] & 0x3FF, y = (b[1] >>> 16) & 0x1FF;
    const w = ((b[2] - 1) & 0x3FF) + 1, h = (((b[2] >>> 16) - 1) & 0x1FF) + 1;
    if (this.hw && this.checkMask) this.hw.rects(x, y, w, h, (rx, ry, rw, rh) => this.hw.syncNative(rx, ry, rw, rh));
    this.vw = { x, y, w, h, i: 0, total: w * h };
    this.phase = PH_VRAM_WRITE;
  }
  vramWriteWord(word) {
    const t = this.vw;
    if (this.remote) { t.i += 2; if (t.i >= t.total) { this.phase = PH_CMD; this.vw = null; } return; }
    for (let k = 0; k < 2 && t.i < t.total; k++, t.i++) {
      const px = (word >>> (16 * k)) & 0xFFFF;
      const xx = (t.x + (t.i % t.w)) & 0x3FF, yy = (t.y + ((t.i / t.w) | 0)) & 0x1FF;
      const idx = yy * 1024 + xx;
      if (this.checkMask && (this.vram[idx] & 0x8000)) continue;
      this.vram[idx] = px | (this.setMask ? 0x8000 : 0);
    }
    if (t.i >= t.total) { this.phase = PH_CMD; this.vw = null; if (this.hw) this.hw.uploaded(t.x, t.y, t.w, t.h); }
  }

  beginVramRead(b) {
    const x = b[1] & 0x3FF, y = (b[1] >>> 16) & 0x1FF;
    const w = ((b[2] - 1) & 0x3FF) + 1, h = (((b[2] >>> 16) - 1) & 0x1FF) + 1;
    if (this.remote) this.remote.onRead?.();                   // o jogo lê a VRAM de volta: o worker volta para esta thread (a leitura atual sai defasada)
    if (this.hw) this.hw.rects(x, y, w, h, (rx, ry, rw, rh) => this.hw.syncNative(rx, ry, rw, rh));
    this.vr = { x, y, w, h, i: 0, total: w * h };
  }
  vramReadWord() {
    const t = this.vr; let out = 0;
    for (let k = 0; k < 2; k++) {
      let px = 0;
      if (t.i < t.total) { px = this.vram[((t.y + ((t.i / t.w) | 0)) & 0x1FF) * 1024 + ((t.x + (t.i % t.w)) & 0x3FF)]; t.i++; }
      out |= px << (16 * k);
    }
    if (t.i >= t.total) this.vr = null;
    return out >>> 0;
  }

  vramCopy(b) {
    const sx = b[1] & 0x3FF, sy = (b[1] >>> 16) & 0x1FF, dx = b[2] & 0x3FF, dy = (b[2] >>> 16) & 0x1FF;
    const w = ((b[3] - 1) & 0x3FF) + 1, h = (((b[3] >>> 16) - 1) & 0x1FF) + 1;
    if (this.remote) return;
    if (this.hw && this.hw.copy(sx, sy, dx, dy, w, h)) return;
    const CH = 16, buf = new Uint16Array(CH);          // o hardware lê/escreve em rajadas de 16 pixels (medido)
    for (let y = 0; y < h; y++) for (let x0 = 0; x0 < w; x0 += CH) {
      const n = Math.min(CH, w - x0);
      for (let k = 0; k < n; k++) buf[k] = this.vram[((sy + y) & 0x1FF) * 1024 + ((sx + x0 + k) & 0x3FF)];
      for (let k = 0; k < n; k++) {
        const di = ((dy + y) & 0x1FF) * 1024 + ((dx + x0 + k) & 0x3FF);
        if (this.checkMask && (this.vram[di] & 0x8000)) continue;
        this.vram[di] = buf[k] | (this.setMask ? 0x8000 : 0);
      }
    }
    if (this.hw) this.hw.uploaded(dx, dy, w, h);
  }

  // ===================== Pixel =====================
  /** Escreve um pixel já com offset aplicado. r,g,b: 0..255. */
  plot(x, y, r, g, b, semi, dith) {
    if (x < this.daX1 || x > this.daX2 || y < this.daY1 || y > this.daY2 || x < 0 || x > 1023 || y < 0 || y > 511) return;
    this.plotNB(x, y, r, g, b, semi, dith);
  }
  /** plot sem checagem de limites (o chamador já recortou para a área de desenho e para a VRAM) */
  plotNB(x, y, r, g, b, semi, dith) {
    const idx = y * 1024 + x, back = this.vram[idx];
    if (this.checkMask && (back & 0x8000)) return;
    if (dith) { const d = DITHER[((y & 3) << 2) | (x & 3)]; r += d; g += d; b += d; }
    r = clamp8(r) >> 3; g = clamp8(g) >> 3; b = clamp8(b) >> 3;
    if (semi) {
      const br = back & 31, bg = (back >> 5) & 31, bb = (back >> 10) & 31;
      switch (this.semiMode) {
        case 0: r = (br + r) >> 1; g = (bg + g) >> 1; b = (bb + b) >> 1; break;
        case 1: r = Math.min(31, br + r); g = Math.min(31, bg + g); b = Math.min(31, bb + b); break;
        case 2: r = Math.max(0, br - r); g = Math.max(0, bg - g); b = Math.max(0, bb - b); break;
        default: r = Math.min(31, br + (r >> 2)); g = Math.min(31, bg + (g >> 2)); b = Math.min(31, bb + (b >> 2));
      }
    }
    this.vram[idx] = r | (g << 5) | (b << 10) | (this.setMask ? 0x8000 : 0);
  }

  /** Cache de CLUT da GPU: carregado só ao desenhar com textura 4/8 bits; chave = posição; 4 bits carrega 16 entradas, 8 bits 256. */
  clutPrep(cx, cy) {
    if (this.texDepth > 1) return;
    const need = this.texDepth === 0 ? 16 : 256;
    if (this.clutValid && this.clutX === cx && this.clutY === cy && this.clutCount >= need) return;
    for (let i = 0; i < need; i++) this.clut[i] = this.vram[cy * 1024 + ((cx * 16 + i) & 0x3FF)];
    this.clutValid = true; this.clutX = cx; this.clutY = cy; this.clutCount = need;
  }

  /** Busca um texel (devolve a palavra de 16 bits; 0 = transparente). */
  texel(u, v, clutX, clutY) {
    u &= 255; v &= 255;
    u = (u & ~(this.twMaskX << 3)) | ((this.twOffX & this.twMaskX) << 3);
    v = (v & ~(this.twMaskY << 3)) | ((this.twOffY & this.twMaskY) << 3);
    const base = this.texX * 64, row = ((this.texY * 256 + v) & 0x1FF) * 1024;
    if (this.texDepth === 0) {
      const w = this.vram[row + ((base + (u >> 2)) & 0x3FF)];
      return this.clut[(w >> ((u & 3) * 4)) & 15];
    }
    if (this.texDepth === 1) {
      const w = this.vram[row + ((base + (u >> 1)) & 0x3FF)];
      return this.clut[(w >> ((u & 1) * 8)) & 255];
    }
    return this.vram[row + ((base + u) & 0x3FF)];
  }

  /** Aplica o texel + cor do vértice e plota. */
  shadeTexel(x, y, t, r, g, b, raw, semi, gour, clutX, clutY, u, v, noClip, dith) {
    const texel = this.texel(u, v, clutX, clutY);
    if (texel === 0) return;
    const tr = texel & 31, tg = (texel >> 5) & 31, tb = (texel >> 10) & 31;
    const s = semi && (texel & 0x8000);
    if (noClip) {
      if (raw) this.plotNB(x, y, tr << 3, tg << 3, tb << 3, s, false);
      else this.plotNB(x, y, (tr * r) >> 4, (tg * g) >> 4, (tb * b) >> 4, s, dith);
    } else if (raw) this.plot(x, y, tr << 3, tg << 3, tb << 3, s, false);
    else this.plot(x, y, (tr * r) >> 4, (tg * g) >> 4, (tb * b) >> 4, s, dith);
  }

  // ===================== Polígonos =====================
  polygon(b, c) {
    const quad = !!(c & 8), tex = !!(c & 4), gour = !!(c & 0x10), semi = !!(c & 2), raw = !!(c & 1);
    const n = quad ? 4 : 3, V = []; let i = 1;
    let clutX = 0, clutY = 0;
    for (let k = 0; k < n; k++) {
      const col = (gour && k > 0) ? b[i++] : b[0];
      const pos = b[i++];
      let u = 0, v = 0;
      if (tex) {
        const t = b[i++]; u = t & 255; v = (t >> 8) & 255;
        if (k === 0) { clutX = (t >>> 16) & 63; clutY = (t >>> 22) & 511; }
        if (k === 1) {                                   // texpage atualiza o estado do GPU
          const tp = t >>> 16;
          this.texX = tp & 15; this.texY = (tp >> 4) & 1; this.semiMode = (tp >> 5) & 3; this.texDepth = (tp >> 7) & 3;
          this.texDisable = this.texDisAllow && !!((tp >> 11) & 1);
        }
      }
      V.push({ x: sx11(pos & 0x7FF) + this.offX, y: sx11((pos >>> 16) & 0x7FF) + this.offY,
               r: col & 255, g: (col >> 8) & 255, b: (col >> 16) & 255, u, v });
    }
    const o = { tex, gour, semi, raw, clutX, clutY };
    if (this.skipDraw || this.remote) return;                   // quadro descartado (frameskip): mantém o estado, não desenha
    if (this.hw) return this.hw.polygon(V, quad, o);
    if (tex) this.clutPrep(clutX, clutY);
    this.triangle(V[0], V[1], V[2], o);
    if (quad) this.triangle(V[1], V[2], V[3], o);
  }

  /**
   * Triângulo estilo hardware: arestas exatas (regra de cobertura do PS1: linhas [yTopo, yBase), colunas [ceil(xE), ceil(xD)))
   * e atributos (cor, u, v) interpolados em ponto fixo com gradientes truncados a 12 bits fracionários, a partir do
   * primeiro vértice do comando (medido contra o console real; aritmética de 32 bits que "dá a volta").
   */
  triangle(a, b, c, o) {
    let A = a, B = b, C = c, t;
    if (C.y < B.y) { t = B; B = C; C = t; }
    if (B.y < A.y) { t = A; A = B; B = t; }
    if (C.y < B.y) { t = B; B = C; C = t; }
    if (C.y === A.y) return;
    const D = (B.x - A.x) * (C.y - A.y) - (C.x - A.x) * (B.y - A.y);
    if (D === 0) return;
    const minX = Math.min(A.x, B.x, C.x), maxX = Math.max(A.x, B.x, C.x);
    if (maxX - minX > 1023 || C.y - A.y > 511) return;          // limite do hardware
    const yS = Math.max(A.y, this.daY1, 0), yE = Math.min(C.y - 1, this.daY2, 511);
    if (yS > yE) return;
    const xMin = Math.max(this.daX1, 0), xMax = Math.min(this.daX2, 1023);
    const shortRight = D > 0;
    const dxL = C.x - A.x, dyL = C.y - A.y;
    const ceilDiv = (n, d) => Math.ceil(n / d);                  // d > 0; n/d exato o bastante (|n| < 2^31, d < 2^11)
    // gradientes (12 bits fracionários, truncados para zero)
    const tex = o.tex, gour = o.gour, raw = o.raw, semi = o.semi, clutX = o.clutX, clutY = o.clutY;
    const grad = (ca, cb, cc) => {
      const nx = (cb - ca) * (C.y - A.y) - (cc - ca) * (B.y - A.y);
      const ny = (cc - ca) * (B.x - A.x) - (cb - ca) * (C.x - A.x);
      return [Math.trunc(nx * 4096 / D), Math.trunc(ny * 4096 / D)];
    };
    let rGx = 0, rGy = 0, gGx = 0, gGy = 0, bGx = 0, bGy = 0, uGx = 0, uGy = 0, vGx = 0, vGy = 0;
    if (gour) { [rGx, rGy] = grad(A.r, B.r, C.r); [gGx, gGy] = grad(A.g, B.g, C.g); [bGx, bGy] = grad(A.b, B.b, C.b); }
    if (tex) { [uGx, uGy] = grad(A.u, B.u, C.u); [vGx, vGy] = grad(A.v, B.v, C.v); }
    const P = a;                                                 // o hardware parte do 1o vértice do comando
    const r0 = (P.r << 12) + 2048, g0 = (P.g << 12) + 2048, b0 = (P.b << 12) + 2048, u0 = (P.u << 12) + 2048, v0 = (P.v << 12) + 2048;
    const dith = this.dither && (gour || (tex && !raw));
    const vram = this.vram, chk = this.checkMask, setM = this.setMask ? 0x8000 : 0, smode = this.semiMode, dthrOn = !!this.dither;
    const clut = this.clut, td = this.texDepth, tBase = this.texX * 64, tY = this.texY * 256;
    const mx = this.twMaskX, my = this.twMaskY, uAnd = ~(mx << 3), uOr = (this.twOffX & mx) << 3, vAnd = ~(my << 3), vOr = (this.twOffY & my) << 3;
    const ddOn = tex ? (!raw && dthrOn) : dith;
    const span = spanFor(tex, tex ? td : 0, gour, raw && tex, semi && true, ddOn, chk, tex && (mx | my) !== 0);
    const mk = this.rowMask;                                     // 480i: o hardware não desenha as linhas do campo exibido
    for (let y = yS; y <= yE; y++) {
      if (mk >= 0 && (y & 1) === mk) continue;
      const nL = A.x * dyL + (y - A.y) * dxL;                      // aresta longa: x = nL / dyL
      let xl, xr;
      const lx = ceilDiv(nL, dyL);
      let sx;
      if (y < B.y) sx = ceilDiv(A.x * (B.y - A.y) + (y - A.y) * (B.x - A.x), B.y - A.y);
      else sx = ceilDiv(B.x * (C.y - B.y) + (y - B.y) * (C.x - B.x), C.y - B.y);
      if (shortRight) { xl = lx; xr = sx; } else { xl = sx; xr = lx; }
      if (xl < xMin) xl = xMin;
      if (xr > xMax + 1) xr = xMax + 1;
      if (xl >= xr) continue;
      const dy = y - P.y, dx = xl - P.x;
      let cr = r0 + rGy * dy + rGx * dx, cg = g0 + gGy * dy + gGx * dx, cb = b0 + bGy * dy + bGx * dx;
      let cu = u0 + uGy * dy + uGx * dx, cv = v0 + vGy * dy + vGx * dx;
      span(vram, clut, QT, DITHER_T, y, xl, xr, cr, cg, cb, cu, cv, rGx, gGx, bGx, uGx, vGx, A.r, A.g, A.b, tBase, tY, uAnd, uOr, vAnd, vOr, smode, setM);
    }
  }

  // ===================== Retângulos =====================
  rect(b, c) {
    const tex = !!(c & 4), semi = !!(c & 2), raw = !!(c & 1), sz = (c >> 3) & 3;
    let i = 1;
    const col = b[0], r = col & 255, g = (col >> 8) & 255, bl = (col >> 16) & 255;
    const pos = b[i++];
    let u0 = 0, v0 = 0, clutX = 0, clutY = 0;
    if (tex) { const t = b[i++]; u0 = t & 255; v0 = (t >> 8) & 255; clutX = (t >>> 16) & 63; clutY = (t >>> 22) & 511; }
    let w, h;
    if (sz === 0) { const s = b[i++]; w = s & 0x3FF; h = (s >>> 16) & 0x1FF; }
    else if (sz === 1) { w = 1; h = 1; } else if (sz === 2) { w = 8; h = 8; } else { w = 16; h = 16; }
    const x0 = sx11(pos & 0x7FF) + this.offX, y0 = sx11((pos >>> 16) & 0x7FF) + this.offY;
    if (this.skipDraw || this.remote) return;
    if (this.hw) return this.hw.rect(x0, y0, w, h, { tex, semi, raw, r, g, b: bl, u0, v0, clutX, clutY, flipX: this.flipX, flipY: this.flipY });
    if (tex) this.clutPrep(clutX, clutY);
    const mk = this.rowMask;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const px = x0 + x, py = y0 + y;
      if (mk >= 0 && (py & 1) === mk) continue;
      if (px < this.daX1 || px > this.daX2 || py < this.daY1 || py > this.daY2) continue;
      if (tex) {
        const u = this.flipX ? u0 + 1 - x : u0 + x, v = this.flipY ? v0 - y : v0 + y;   // flip X: o hardware começa em u0+1 (medido)
        this.shadeTexel(px, py, true, r, g, bl, raw, semi, false, clutX, clutY, u, v, false, false);
      } else this.plot(px, py, r, g, bl, semi, false);
    }
  }

  // ===================== Linhas =====================
  lineCmd(b, c) {
    const gour = !!(c & 0x10), poly = !!(c & 8);
    this.line = { semi: !!(c & 2), gour, pts: [], cols: [] };
    const L = this.line;
    L.pts.push(b[1]); L.cols.push(b[0] & 0xFFFFFF);
    if (gour) { L.cols.push(b[2] & 0xFFFFFF); L.pts.push(b[3]); } else { L.cols.push(b[0] & 0xFFFFFF); L.pts.push(b[2]); }
    if (!poly) { this.drawSeg(L, 0); this.line = null; return; }
    this.drawSeg(L, 0); this.phase = PH_POLYLINE; this.polyExpectColor = gour;
  }
  polylineWord(w) {
    const L = this.line;
    if ((w & 0xF000F000) === 0x50005000) { this.phase = PH_CMD; this.line = null; return; }
    if (L.gour && this.polyExpectColor) { this.polyColor = w & 0xFFFFFF; this.polyExpectColor = false; return; }
    L.pts.push(w); L.cols.push(L.gour ? this.polyColor : L.cols[0]);
    this.drawSeg(L, L.pts.length - 2);
    if (L.gour) this.polyExpectColor = true;
  }
  drawSeg(L, i) {
    const p0 = L.pts[i], p1 = L.pts[i + 1], c0 = L.cols[i], c1 = L.cols[i + 1];
    const x0 = sx11(p0 & 0x7FF) + this.offX, y0 = sx11((p0 >>> 16) & 0x7FF) + this.offY;
    const x1 = sx11(p1 & 0x7FF) + this.offX, y1 = sx11((p1 >>> 16) & 0x7FF) + this.offY;
    if (this.skipDraw || this.remote) return;
    if (this.hw) return this.hw.line(x0, y0, x1, y1, c0, c1, L.semi, L.gour);
    // Algoritmo do hardware: passo em ponto fixo 32.32 (arredondado "para longe do zero"), pixel = floor(pos + 0.5 - eps)
    let ax = x0, ay = y0, bx = x1, by = y1, ca = c0, cb = c1;
    const adx = Math.abs(x1 - x0), ady = Math.abs(y1 - y0), k = Math.max(adx, ady);
    if (adx >= 1024 || ady >= 512) return;
    if (ax >= bx && k) { ax = x1; ay = y1; bx = x0; by = y0; ca = c1; cb = c0; }
    const div = d => { if (k === 0) return 0; const n = d * 4294967296, q = n / k; return (q < 0 ? Math.floor(q) : Math.ceil(q)) / 4294967296; };
    const sx = div(bx - ax), sy = div(by - ay);
    const EX = LINE_EX, EY = LINE_EY;
    let px = ax + 0.5 - EX, py = ay + 0.5 - EY;
    const gour = L.gour, dither = this.dither;                 // linhas flat também recebem dithering (medido)
    const r0 = ca & 255, g0 = (ca >> 8) & 255, b0 = (ca >> 16) & 255;
    const tr = (cb & 255) - r0, tg = ((cb >> 8) & 255) - g0, tb = ((cb >> 16) & 255) - b0;
    const kk = k || 1, mk = this.rowMask;
    const dr = Math.trunc((tr * 4096) / kk), dg = Math.trunc((tg * 4096) / kk), db = Math.trunc((tb * 4096) / kk);
    for (let i = 0; i <= k; i++, px += sx, py += sy) {
      const x = Math.floor(px), y = Math.floor(py);
      if (mk >= 0 && (y & 1) === mk) continue;
      let r = r0, g = g0, bl = b0;
      if (gour) { r = ((r0 << 12) + 2048 + dr * i) >> 12; g = ((g0 << 12) + 2048 + dg * i) >> 12; bl = ((b0 << 12) + 2048 + db * i) >> 12; }
      this.plot(x, y, r, g, bl, L.semi, dither);
    }
  }

  // ===================== Saída de vídeo =====================
  /** paridade das linhas que NÃO podem ser desenhadas (campo exibido) em 480i com 'desenhar na área de display' proibido; -1 = sem restrição */
  get rowMask() { return (this.interlace && this.vres && !this.drawToDisplay) ? this.field : -1; }

  /** Chamado a cada fim de quadro: guarda as linhas do campo exibido (completas) para tecer com o campo anterior na saída. */
  toggleField() { this.field ^= 1; if (this.remote) this.remote.push(6, this.field); }
  captureField() {
    if (this.remote) { this.remote.push(2, 0); return; }
    if (this.hw) return this.hw.captureField(this);
    this.captureFieldSW();
  }
  captureFieldSW() {
    if (!(this.interlace && this.vres) || !this.dispOn) { this.snapKey = ''; return; }
    const w = this.width, h = this.height, wv = this.rgb24 ? Math.ceil(w * 1.5) + 2 : w + 2;
    const key = this.startX + ',' + this.startY + ',' + w + ',' + h + ',' + (this.rgb24 ? 1 : 0);
    if (!this.snap) { this.snap = new Uint16Array(1024 * 512); this.mot = new Uint8Array(1024 * 512); }
    const vr = this.vram, sn = this.snap, mot = this.mot, par = this.field; this.snapPar = par;
    const full = key !== this.snapKey; this.snapKey = key;
    for (let y = 0; y < h; y++) {
      const ry = (this.startY + y) & 0x1FF;
      if (!full && (ry & 1) !== par) continue;
      const row = ry * 1024;
      for (let x = 0; x < wv; x++) {
        const i = row + ((this.startX + x) & 0x3FF), n = vr[i], o = sn[i];
        // movimento = este pixel mudou em relação ao MESMO campo de 2 quadros atrás (o campo velho é do instante t-1: usado no desentrelaçamento adaptativo)
        mot[i] = full || ((((n & 31) - (o & 31)) + 1) >>> 0) > 2 || (((((n >> 5) & 31) - ((o >> 5) & 31)) + 1) >>> 0) > 2 || (((((n >> 10) & 31) - ((o >> 10) & 31)) + 1) >>> 0) > 2 ? 1 : 0;
        sn[i] = n;
      }
    }
  }

  get dotDiv() { return this.hres2 ? 7 : [10, 8, 5, 4][this.hres1]; }   // divisor do dot clock
  get width() { return this.hres2 ? 368 : [256, 320, 512, 640][this.hres1]; }
  get height() {
    const lines = Math.max(0, this.vy2 - this.vy1);
    const h = (lines > 0 && lines <= 288) ? lines * (this.vres ? 2 : 1) : (this.vres ? 480 : 240);
    return Math.min(h, 576);
  }

  /** Converte a área de display da VRAM para RGBA (Uint8ClampedArray width*height*4). */
  renderRGBA(out) {
    const w = this.width, h = this.height;
    out = out ?? new Uint8ClampedArray(w * h * 4);
    if (!this.dispOn) { out.fill(0); for (let i = 3; i < out.length; i += 4) out[i] = 255; return { data: out, width: w, height: h }; }
    const vram = (this.snap && this.snapKey && this.interlace && this.vres) ? this.snap : this.vram;   // 480i: dois últimos campos completos
    const dmode = (vram === this.snap && !this.rgb24) ? this.deint : 0, spar = this.snapPar;
    for (let y = 0; y < h; y++) {
      const ry = (this.startY + y) & 0x1FF, row = ry * 1024;
      // 480i: as linhas do campo ANTIGO podem estar "fantasmas" onde algo se mexeu -> adaptativo troca pela média das vizinhas do campo atual
      const di = dmode !== 0 && (ry & 1) !== spar;
      const rA = di && y > 0 ? ((ry - 1) & 0x1FF) * 1024 : -1, rB = di && y < h - 1 ? ((ry + 1) & 0x1FF) * 1024 : -1;
      for (let x = 0; x < w; x++) {
        let r, g, b;
        if (this.rgb24) {
          const bx = ((this.startX * 2 + x * 3) >> 0);             // posição em bytes
          const wi = row + ((bx >> 1) & 0x3FF), lo = vram[wi], hi = vram[(wi & ~1023) + (((bx >> 1) + 1) & 0x3FF)];
          const bytes = (bx & 1) ? [lo >> 8, hi & 255, hi >> 8] : [lo & 255, lo >> 8, hi & 255];
          r = bytes[0]; g = bytes[1]; b = bytes[2];
        } else {
          const p = vram[row + ((this.startX + x) & 0x3FF)];
          r = (p & 31) << 3; g = ((p >> 5) & 31) << 3; b = ((p >> 10) & 31) << 3;
          r |= r >> 5; g |= g >> 5; b |= b >> 5;
          if (di && (rA >= 0 || rB >= 0)) {
            const xi = (this.startX + x) & 0x3FF, pa = vram[(rA >= 0 ? rA : rB) + xi], pb = vram[(rB >= 0 ? rB : rA) + xi];
            if (dmode === 1 && !(this.mot[(rA >= 0 ? rA : rB) + xi] | this.mot[(rB >= 0 ? rB : rA) + xi])) { /* sem movimento perto: mantém a linha do campo antigo (tecer) */ } else {
            let ar = (((pa & 31) + (pb & 31)) << 2) , ag = ((((pa >> 5) & 31) + ((pb >> 5) & 31)) << 2), ab = ((((pa >> 10) & 31) + ((pb >> 10) & 31)) << 2);
            ar |= ar >> 5; ag |= ag >> 5; ab |= ab >> 5;
            r = ar; g = ag; b = ab; }
          }
        }
        const o = (y * w + x) * 4; out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = 255;
      }
    }
    this.frameCount++;
    return { data: out, width: w, height: h };
  }
}

const DEINT_THR = 40;
function rgb24to15(c) { return (((c & 255) >> 3) | ((((c >> 8) & 255) >> 3) << 5) | ((((c >> 16) & 255) >> 3) << 10)); }
function clamp8(v) { return v < 0 ? 0 : v > 255 ? 255 : v; }

/** Fluxo de comandos para o rasterizador em worker: pares [tipo, valor] (0=GP0, 1=GP1, 2=captura do campo, 3=apresentar, 6=campo atual). */
class GpuStream {
  constructor(post) { this.post = post; this.q = new Uint32Array(1 << 16); this.n = 0; this.inflight = 0; this.onRead = null; }
  push(t, v) { if (this.n >= this.q.length) this.flush(); this.q[this.n++] = t; this.q[this.n++] = v; }
  flush() {
    if (!this.n) return;
    const o = this.q.slice(0, this.n); this.n = 0;
    this.post({ t: 'cmds', q: o }, [o.buffer]);
  }
}

return { GPU, DEINT_THR, GpuStream };
})();
const __src_gauss = (() => {
// Tabela de interpolação Gaussiana da SPU do PS1 (512 entradas, Int16).
// Dados de hardware (os mesmos de psx-spx / emuladores): g[i], i = 0..511.
// Verificação embutida no teste: para todo i, g[0xFF-i]+g[0x1FF-i]+g[0x100+i]+g[i] está em 32639..32641.
const GAUSS = new Int16Array([
  -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
  0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 3, 3,
  3, 4, 4, 5, 5, 6, 7, 7, 8, 9, 9, 10, 11, 12, 13, 14,
  15, 16, 17, 18, 19, 21, 22, 24, 25, 27, 28, 30, 32, 33, 35, 37,
  39, 41, 44, 46, 48, 51, 53, 56, 58, 61, 64, 67, 70, 73, 77, 80,
  84, 87, 91, 95, 99, 103, 107, 111, 116, 120, 125, 130, 135, 140, 145, 150,
  156, 161, 167, 173, 179, 186, 192, 199, 205, 212, 219, 227, 234, 242, 250, 257,
  266, 274, 283, 291, 300, 309, 319, 328, 338, 348, 358, 369, 379, 390, 401, 412,
  424, 436, 448, 460, 473, 485, 498, 512, 525, 539, 553, 567, 582, 597, 612, 627,
  643, 659, 675, 692, 708, 726, 743, 761, 779, 797, 816, 835, 854, 874, 894, 914,
  935, 956, 977, 999, 1020, 1043, 1066, 1089, 1112, 1136, 1160, 1184, 1209, 1234, 1260, 1286,
  1312, 1339, 1366, 1394, 1422, 1450, 1479, 1508, 1537, 1567, 1598, 1628, 1660, 1691, 1723, 1756,
  1789, 1822, 1856, 1890, 1924, 1959, 1995, 2031, 2067, 2104, 2141, 2179, 2217, 2256, 2295, 2334,
  2374, 2415, 2456, 2497, 2539, 2582, 2624, 2668, 2712, 2756, 2801, 2846, 2892, 2938, 2985, 3032,
  3079, 3128, 3176, 3225, 3275, 3325, 3376, 3427, 3479, 3531, 3584, 3637, 3691, 3745, 3799, 3855,
  3910, 3967, 4023, 4081, 4138, 4197, 4255, 4315, 4374, 4435, 4495, 4557, 4619, 4681, 4744, 4807,
  4871, 4935, 5000, 5065, 5131, 5197, 5264, 5332, 5399, 5468, 5536, 5606, 5676, 5746, 5817, 5888,
  5959, 6032, 6104, 6177, 6251, 6325, 6400, 6475, 6550, 6626, 6702, 6779, 6856, 6934, 7012, 7091,
  7170, 7249, 7329, 7409, 7490, 7571, 7653, 7735, 7817, 7900, 7983, 8066, 8150, 8234, 8319, 8404,
  8489, 8575, 8661, 8748, 8834, 8922, 9009, 9097, 9185, 9273, 9362, 9451, 9541, 9630, 9720, 9811,
  9901, 9992, 10083, 10174, 10266, 10358, 10450, 10542, 10635, 10727, 10820, 10913, 11007, 11100, 11194, 11288,
  11382, 11476, 11571, 11665, 11760, 11855, 11950, 12045, 12140, 12236, 12331, 12427, 12522, 12618, 12714, 12809,
  12905, 13001, 13097, 13193, 13289, 13385, 13481, 13577, 13673, 13769, 13865, 13961, 14056, 14152, 14248, 14343,
  14439, 14534, 14630, 14725, 14820, 14915, 15010, 15104, 15199, 15293, 15387, 15481, 15575, 15669, 15762, 15855,
  15948, 16041, 16133, 16226, 16317, 16409, 16500, 16592, 16682, 16773, 16863, 16953, 17042, 17131, 17220, 17308,
  17396, 17484, 17571, 17658, 17744, 17830, 17916, 18001, 18086, 18170, 18254, 18337, 18420, 18502, 18584, 18665,
  18746, 18826, 18905, 18985, 19063, 19141, 19219, 19295, 19372, 19447, 19522, 19597, 19671, 19744, 19816, 19888,
  19959, 20030, 20100, 20169, 20238, 20306, 20373, 20439, 20505, 20570, 20634, 20698, 20760, 20822, 20884, 20944,
  21004, 21063, 21121, 21178, 21235, 21290, 21345, 21399, 21452, 21505, 21556, 21607, 21657, 21706, 21754, 21801,
  21848, 21893, 21938, 21982, 22025, 22066, 22107, 22148, 22187, 22225, 22262, 22299, 22334, 22369, 22402, 22435,
  22467, 22498, 22527, 22556, 22584, 22611, 22637, 22662, 22686, 22709, 22731, 22752, 22772, 22791, 22809, 22826,
  22842, 22857, 22872, 22885, 22897, 22908, 22918, 22927, 22935, 22942, 22948, 22953, 22957, 22960, 22962, 22963
]);

return { GAUSS };
})();
const __src_spu = (() => {
// ============================================================================
//  SPU do PS1 - 24 vozes ADPCM, ADSR, modulação de pitch, ruído, reverb
// ============================================================================
//  Registradores: 0x1F801C00-0x1F801FFF (16 bits)
//    voz n (0..23): 0x1C00 + n*0x10
//      +0 volL  +2 volR  +4 pitch(0x1000=44100Hz)  +6 start(>>3)
//      +8 ADSR1 +A ADSR2 +C ADSR atual  +E repeat(>>3)
//    0x1D80 mainL, 0x1D82 mainR, 0x1D84 revL, 0x1D86 revR
//    0x1D88/8A KON, 0x1D8C/8E KOFF, 0x1D90/92 PMON, 0x1D94/96 NON, 0x1D98/9A EON
//    0x1D9C/9E ENDX, 0x1DA2 reverb base, 0x1DA4 IRQ addr, 0x1DA6 xfer addr, 0x1DA8 FIFO,
//    0x1DAA SPUCNT, 0x1DAC xfer ctrl, 0x1DAE SPUSTAT, 0x1DB0 CD vol, 0x1DC0.. regs de reverb
//  Amostragem de saída: 44100 Hz estéreo. Interpolação: Gaussiana de 4 taps (tabela de 512 entradas).
//  Volumes: modo fixo e SWEEP (linear/exponencial, crescente/decrescente, fase +/-) em cada volume de voz e no principal.
//  Ruído: LFSR de 16 bits com timer (shift/step do SPUCNT). Reverb: motor a 22,05 kHz com FIR de 39 taps
//  na entrada (decimação) e na saída (interpolação), escrita no buffer só com SPUCNT.7 ligado.
// ============================================================================
const { GAUSS } = __src_gauss;
const SPU_RAM_SIZE = 512 * 1024;
const POS = [0, 60, 115, 98, 122], NEG = [0, 0, -52, -55, -60];
const sat16 = v => v > 32767 ? 32767 : v < -32768 ? -32768 : v;
const s16 = v => (v << 16) >> 16;

const R = { MAINL: 0x1D80, MAINR: 0x1D82, REVL: 0x1D84, REVR: 0x1D86, KONL: 0x1D88, KONH: 0x1D8A, KOFFL: 0x1D8C, KOFFH: 0x1D8E,
  PMONL: 0x1D90, PMONH: 0x1D92, NONL: 0x1D94, NONH: 0x1D96, EONL: 0x1D98, EONH: 0x1D9A, ENDXL: 0x1D9C, ENDXH: 0x1D9E,
  REVBASE: 0x1DA2, IRQADDR: 0x1DA4, XFERADDR: 0x1DA6, FIFO: 0x1DA8, CNT: 0x1DAA, XFERCTL: 0x1DAC, STAT: 0x1DAE, CDVOL: 0x1DB0, REVREGS: 0x1DC0 };

// FIR de reamostragem do reverb (39 taps; soma = 0x7FFE ~ ganho 1,0 em >>15)
const REV_FIR = new Int32Array([-1, 0, 2, 0, -10, 0, 35, 0, -103, 0, 266, 0, -616, 0, 1332, 0, -2960, 0, 10246, 0x4000,
  10246, 0, -2960, 0, 1332, 0, -616, 0, 266, 0, -103, 0, 35, 0, -10, 0, 2, 0, -1]);
const FIR_K = [], FIR_C = []; for (let k = 0; k < 39; k++) if (REV_FIR[k]) { FIR_K.push(k); FIR_C.push(REV_FIR[k]); }   // só os coeficientes não nulos
const FIR_N = FIR_K.length;

const ATTACK = 0, DECAY = 1, SUSTAIN = 2, RELEASE = 3, OFF = 4;

class Voice {
  constructor() { this.reset(); }
  reset() {
    this.addr = 0; this.counter = 0; this.phase = OFF; this.level = 0; this.envCnt = 0;
    this.samples = new Int16Array(28); this.idx = 28; this.old1 = 0; this.old2 = 0; this.prev = 0; this.cur = 0;
    this.repeat = 0; this.loopEnd = false; this.last = 0; this.h1 = 0; this.h2 = 0; this.h3 = 0;
  }
}

class SPU {
  constructor() {
    this.ram = new Uint8Array(SPU_RAM_SIZE);
    this.ramView = new DataView(this.ram.buffer);
    this.regs = new Uint16Array(0x200);            // 0x1F801C00 + i*2
    this.voices = Array.from({ length: 24 }, () => new Voice());
    this.xferAddr = 0; this.endx = 0; this.irqFlag = false; this.onIrq = null;
    this.revPos = 0; this.revToggle = 0; this.revOutL = 0; this.revOutR = 0;
    this.noise = 1; this.noiseTimer = 0;
    // volumes: 0..47 = voz n (L = 2n, R = 2n+1), 48/49 = principal L/R. level é o valor atual (com sinal).
    this.sw = Array.from({ length: 50 }, () => ({ reg: 0, level: 0, cnt: 0 }));
    this.revHL = new Int32Array(64); this.revHR = new Int32Array(64); this.revUL = new Int32Array(64); this.revUR = new Int32Array(64); this.revHead = 0;
    this.cdBufL = new Int16Array(65536); this.cdBufR = new Int16Array(65536); this.cdHead = 0; this.cdTail = 0;   // áudio do CD (XA/CDDA)
    this.sampleCount = 0;
  }

  // ---------------- acesso aos registradores ----------------
  reg(addr) { return this.regs[(addr - 0x1C00) >> 1]; }
  setReg(addr, v) { this.regs[(addr - 0x1C00) >> 1] = v; }

  read(addr, size) {
    addr &= 0xFFFF;                                  // 0x1F801C00 -> 0x1C00
    if (size === 4) return (this.read16(addr) | (this.read16(addr + 2) << 16)) >>> 0;
    if (size === 1) return (this.read16(addr & ~1) >> ((addr & 1) * 8)) & 0xFF;
    return this.read16(addr);
  }
  write(addr, size, v) {
    addr &= 0xFFFF;
    if (size === 4) { this.write16(addr, v & 0xFFFF); this.write16(addr + 2, v >>> 16); return; }
    if (size === 1) {                                         // byte: read-modify-write
      const a = addr & ~1, sh = (addr & 1) * 8, cur = this.reg(a);
      this.write16(a, (cur & ~(0xFF << sh)) | ((v & 0xFF) << sh)); return;
    }
    this.write16(addr, v & 0xFFFF);
  }

  read16(a) {
    switch (a) {
      case R.ENDXL: return this.endx & 0xFFFF;
      case R.ENDXH: return (this.endx >>> 16) & 0xFF;
      case R.XFERADDR: return this.xferAddr >> 3;
      case R.STAT: return (this.reg(R.CNT) & 0x3F) | (this.irqFlag ? 0x40 : 0);
      case 0x1DB8: case 0x1DBA: return 0;
    }
    if (a >= 0x1E00 && a < 0x1E64) return this.sw[(a - 0x1E00) >> 1].level & 0xFFFF;     // volume atual (voz e principal)
    if (a < 0x1D80) {                                          // voz: ADSR atual (+0xC) = nível
      const n = (a - 0x1C00) >> 4;
      if ((a & 15) === 0xC) return this.voices[n].level & 0x7FFF;
    }
    return this.reg(a);
  }

  /** escrita num registrador de volume (voz ou principal): fixo ou sweep */
  setVolReg(idx, v) {
    const s = this.sw[idx]; s.reg = v; s.cnt = 0;
    if (!(v & 0x8000)) s.level = s16((v & 0x7FFF) << 1);                // fixo: -0x8000..+0x7FFE
  }
  sweepTick(s) {
    const v = s.reg; if (!(v & 0x8000)) return;
    const exp = (v >> 14) & 1, dec = (v >> 13) & 1, shift = (v >> 2) & 31, stp = v & 3;
    let step = dec ? -8 + stp : 7 - stp, cycles = 1 << Math.max(0, shift - 11), m = Math.abs(s.level);
    step <<= Math.max(0, 11 - shift);
    if (exp && !dec && m > 0x6000) cycles *= 4;
    if (exp && dec) step = (step * m) >> 15;
    if (++s.cnt >= cycles) { s.cnt = 0; m = m + step; m = m < 0 ? 0 : m > 0x7FFF ? 0x7FFF : m; }
    s.level = (v & 0x1000) ? -m : m;                                     // fase negativa
  }

  write16(a, v) {
    this.setReg(a, v);
    if (a < 0x1D80) { const k = a & 15; if (k < 4) this.setVolReg(((a - 0x1C00) >> 4) * 2 + (k >> 1), v); }
    else if (a === R.MAINL) this.setVolReg(48, v); else if (a === R.MAINR) this.setVolReg(49, v);
    switch (a) {
      case R.KONL: for (let i = 0; i < 16; i++) if (v & (1 << i)) this.keyOn(i); break;
      case R.KONH: for (let i = 0; i < 8; i++) if (v & (1 << i)) this.keyOn(16 + i); break;
      case R.KOFFL: for (let i = 0; i < 16; i++) if (v & (1 << i)) this.keyOff(i); break;
      case R.KOFFH: for (let i = 0; i < 8; i++) if (v & (1 << i)) this.keyOff(16 + i); break;
      case R.XFERADDR: this.xferAddr = (v << 3) & (SPU_RAM_SIZE - 1); break;
      case R.FIFO: this.ramWrite16(v); break;
      case R.CNT: if (!(v & 0x40)) this.irqFlag = false; break;         // desabilitar IRQ limpa o flag
      case R.REVBASE: this.revPos = (v << 3) & (SPU_RAM_SIZE - 1); break;
    }
  }

  // ---------------- RAM do SPU / transferências ----------------
  ramWrite16(v) { this.ramView.setUint16(this.xferAddr, v & 0xFFFF, true); this.checkIrq(this.xferAddr); this.xferAddr = (this.xferAddr + 2) & (SPU_RAM_SIZE - 1); }
  ramRead16() { const v = this.ramView.getUint16(this.xferAddr, true); this.xferAddr = (this.xferAddr + 2) & (SPU_RAM_SIZE - 1); return v; }
  dmaWrite(words) { for (const w of words) { this.ramWrite16(w & 0xFFFF); this.ramWrite16(w >>> 16); } }     // DMA canal 4
  dmaRead(n) { const o = new Uint32Array(n); for (let i = 0; i < n; i++) o[i] = this.ramRead16() | (this.ramRead16() << 16); return o; }
  checkIrq(addr) {
    if ((this.reg(R.CNT) & 0x40) && (addr >> 3) === (this.reg(R.IRQADDR) & 0xFFFF)) this.raiseIrq();
  }
  raiseIrq() { if (!this.irqFlag) { this.irqFlag = true; this.onIrq?.(); } }

  // ---------------- voz ----------------
  keyOn(n) {
    const v = this.voices[n], base = 0x1C00 + n * 16;
    v.addr = (this.reg(base + 6) << 3) & (SPU_RAM_SIZE - 1);
    v.repeat = v.addr; v.counter = 0; v.idx = 28; v.old1 = 0; v.old2 = 0; v.prev = 0; v.cur = 0;
    v.level = 0; v.envCnt = 0; v.h1 = v.h2 = v.h3 = 0; v.phase = ATTACK; this.endx &= ~(1 << n);
    this.decodeBlock(v);
    v.idx = 0; v.cur = v.samples[0];
  }
  keyOff(n) { const v = this.voices[n]; if (v.phase !== OFF) { v.phase = RELEASE; v.envCnt = 0; } }

  /** Decodifica 1 bloco ADPCM de 16 bytes (28 amostras) */
  decodeBlock(v) {
    if (this.reg(R.CNT) & 0x40) {                               // IRQ se o endereço cair em qualquer ponto do bloco lido
      const ia = (this.reg(R.IRQADDR) << 3) & (SPU_RAM_SIZE - 1);
      if (ia >= v.addr && ia < v.addr + 16) this.raiseIrq();
    }
    const o = v.addr, head = this.ram[o], flags = this.ram[o + 1];
    const shift = head & 15, filter = Math.min((head >> 4) & 7, 4);
    if (flags & 4) v.repeat = v.addr;                          // loop start
    let o1 = v.old1, o2 = v.old2;
    for (let i = 0; i < 28; i++) {
      const byte = this.ram[o + 2 + (i >> 1)];
      let nib = (i & 1) ? byte >> 4 : byte & 15;
      let s = s16(nib << 12) >> (shift > 12 ? 9 : shift);
      s += (o1 * POS[filter] + o2 * NEG[filter] + 32) >> 6;
      s = sat16(s); o2 = o1; o1 = s; v.samples[i] = s;
    }
    v.old1 = o1; v.old2 = o2; v.flags = flags;
  }

  /** Avança o envelope ADSR 1 amostra */
  envelope(v, n) {
    const base = 0x1C00 + n * 16, a1 = this.reg(base + 8), a2 = this.reg(base + 10);
    let mode, dec, shift, step;
    switch (v.phase) {
      case ATTACK: mode = a1 >> 15; dec = false; shift = (a1 >> 10) & 31; step = 7 - ((a1 >> 8) & 3); break;
      case DECAY: mode = 1; dec = true; shift = (a1 >> 4) & 15; step = -8; break;
      case SUSTAIN: mode = a2 >> 15; dec = !!((a2 >> 14) & 1); shift = (a2 >> 8) & 31; step = dec ? -8 + ((a2 >> 6) & 3) : 7 - ((a2 >> 6) & 3); break;
      case RELEASE: mode = (a2 >> 5) & 1; dec = true; shift = a2 & 31; step = -8; break;
      default: return;
    }
    let cycles = 1 << Math.max(0, shift - 11);
    step <<= Math.max(0, 11 - shift);
    if (mode && !dec && v.level > 0x6000) cycles *= 4;           // ataque exponencial desacelera
    if (mode && dec) step = (step * v.level) >> 15;               // decaimento exponencial
    if (++v.envCnt >= cycles) {
      v.envCnt = 0;
      v.level = Math.max(0, Math.min(0x7FFF, v.level + step));
    }
    // transições de fase
    if (v.phase === ATTACK && v.level >= 0x7FFF) { v.phase = DECAY; v.envCnt = 0; }
    else if (v.phase === DECAY && v.level <= (((a1 & 15) + 1) << 11)) { v.phase = SUSTAIN; v.envCnt = 0; }
    else if (v.phase === RELEASE && v.level <= 0) { v.phase = OFF; }
  }

  // ---------------- gera 1 amostra estéreo (44.1kHz) ----------------
  tick() {
    let mixL = 0, mixR = 0, revInL = 0, revInR = 0;
    const cnt = this.reg(R.CNT), sw = this.sw;
    const eon = this.reg(R.EONL) | (this.reg(R.EONH) << 16), pmon = this.reg(R.PMONL) | (this.reg(R.PMONH) << 16),
          non = this.reg(R.NONL) | (this.reg(R.NONH) << 16);

    // ruído: timer decrementa (4 + step) por amostra; no estouro recarrega (0x20000 >> shift) e avança o LFSR
    this.noiseTimer -= 4 + ((cnt >> 8) & 3);
    if (this.noiseTimer < 0) {
      this.noiseTimer += 0x20000 >> ((cnt >> 10) & 15); if (this.noiseTimer < 0) this.noiseTimer = 0;
      const nz = this.noise;
      this.noise = ((nz << 1) | (((nz >> 15) ^ (nz >> 12) ^ (nz >> 11) ^ (nz >> 10) ^ 1) & 1)) & 0xFFFF;
    }
    for (let i = 0; i < 50; i++) if (sw[i].reg & 0x8000) this.sweepTick(sw[i]);    // sweeps de volume

    for (let n = 0; n < 24; n++) {
      const v = this.voices[n];
      if (v.phase === OFF) continue;
      const base = 0x1C00 + n * 16;
      // amostra atual: Gauss de 4 taps sobre as 4 últimas amostras decodificadas (ou ruído)
      let smp;
      if (non & (1 << n)) smp = s16(this.noise);
      else {
        const i = (v.counter >> 4) & 0xFF;
        smp = (GAUSS[0xFF - i] * v.h3 + GAUSS[0x1FF - i] * v.h2 + GAUSS[0x100 + i] * v.h1 + GAUSS[i] * v.cur) >> 15;
        smp = sat16(smp);
      }
      this.envelope(v, n);
      smp = (smp * v.level) >> 15;
      v.last = smp;
      const l = (smp * sw[n * 2].level) >> 15, r = (smp * sw[n * 2 + 1].level) >> 15;
      mixL += l; mixR += r;
      if (eon & (1 << n)) { revInL += l; revInR += r; }

      // avanço do pitch
      let step = this.reg(base + 4) & 0x3FFF;
      if ((pmon & (1 << n)) && n > 0) step = (step * (this.voices[n - 1].last + 0x8000)) >> 15;
      v.counter += Math.min(step, 0x3FFF);
      while (v.counter >= 0x1000) {
        v.counter -= 0x1000; v.idx++;
        if (v.idx >= 28) {
          const f = v.flags;
          if (f & 1) {                                              // loop end
            this.endx |= (1 << n);
            if (f & 2) v.addr = v.repeat; else { v.phase = OFF; v.level = 0; break; }   // repeat ou silêncio
          } else v.addr = (v.addr + 16) & (SPU_RAM_SIZE - 1);
          this.decodeBlock(v); v.idx = 0;
        }
        v.h3 = v.h2; v.h2 = v.h1; v.h1 = v.cur; v.cur = v.samples[v.idx];
      }
    }

    // CD audio (entra no mix principal; SPUCNT.2 também o envia ao reverb)
    if (this.cdHead !== this.cdTail) {
      const l = this.cdBufL[this.cdHead], r = this.cdBufR[this.cdHead]; this.cdHead = (this.cdHead + 1) & 0xFFFF;
      if (cnt & 1) {
        const cl = (l * this.volume(this.reg(R.CDVOL))) >> 15, cr = (r * this.volume(this.reg(R.CDVOL + 2))) >> 15;
        mixL += cl; mixR += cr;
        if (cnt & 4) { revInL += cl; revInR += cr; }
      }
    }

    // reverb: entra a 44,1 kHz, o motor roda a 22,05 kHz (FIR de 39 taps para decimar/interpolar)
    const hd = this.revHead = (this.revHead + 1) & 63;
    this.revHL[hd] = sat16(revInL); this.revHR[hd] = sat16(revInR);
    this.revToggle ^= 1;
    let newL = 0, newR = 0;
    if (this.revToggle) {
      let aL = 0, aR = 0;
      if (cnt & 0x80) for (let q = 0; q < FIR_N; q++) { const c = FIR_C[q], j = (hd - FIR_K[q]) & 63; aL += c * this.revHL[j]; aR += c * this.revHR[j]; }
      if (cnt & 0x80) this.reverbStep(sat16(aL >> 15), sat16(aR >> 15)); else { this.revOutL = this.revOutR = 0; this.revAdvance(); }
      newL = this.revOutL; newR = this.revOutR;
    }
    this.revUL[hd] = newL; this.revUR[hd] = newR;                    // saída do reverb: zero-stuffing + FIR (ganho 2)
    if (cnt & 0x80) {
      let uL = 0, uR = 0;
      for (let q = 0; q < FIR_N; q++) { const c = FIR_C[q], j = (hd - FIR_K[q]) & 63; uL += c * this.revUL[j]; uR += c * this.revUR[j]; }
      mixL += sat16(uL >> 14); mixR += sat16(uR >> 14);
    }

    if (!(cnt & 0x8000)) return [0, 0];                              // SPU desabilitado (mudo)
    const mL = (mixL * sw[48].level) >> 15, mR = (mixR * sw[49].level) >> 15;
    this.sampleCount++;
    return [sat16(cnt & 0x4000 ? mL : 0), sat16(cnt & 0x4000 ? mR : 0)];   // bit 14: 0 = mudo
  }

  volume(v) {                                                        // modo fixo (bit15=0). Sweep: TODO
    return s16((v & 0x7FFF) << 1) ;
  }

  // ---------------- reverb ----------------
  // Endereço do reverb = base + ((posição_atual - base + reg*8 + extra) mod tamanho). Roda a 22.05kHz.
  reverbStep(inL, inR) {
    const rg = i => this.reg(R.REVREGS + i * 2), g = i => s16(rg(i));
    const base = (this.reg(R.REVBASE) << 3) & (SPU_RAM_SIZE - 1), size = SPU_RAM_SIZE - base;
    if (size <= 0) return;
    const ad = (reg, extra = 0) => base + ((((this.revPos - base) + (reg << 3) + extra) % size) + size) % size & ~1;
    const wrEn = !!(this.reg(R.CNT) & 0x80);
    const rd = (reg, extra = 0) => { const a = ad(reg, extra); this.checkIrq(a); return this.ramView.getInt16(a, true); };
    const wr = (reg, v) => { const a = ad(reg); this.checkIrq(a); if (wrEn) this.ramView.setInt16(a, sat16(v), true); };
    const dAPF1 = rg(0), dAPF2 = rg(1), vIIR = g(2), vCOMB1 = g(3), vCOMB2 = g(4), vCOMB3 = g(5), vCOMB4 = g(6), vWALL = g(7), vAPF1 = g(8), vAPF2 = g(9);
    const mLSAME = rg(10), mRSAME = rg(11), mLCOMB1 = rg(12), mRCOMB1 = rg(13), mLCOMB2 = rg(14), mRCOMB2 = rg(15), dLSAME = rg(16), dRSAME = rg(17),
          mLDIFF = rg(18), mRDIFF = rg(19), mLCOMB3 = rg(20), mRCOMB3 = rg(21), mLCOMB4 = rg(22), mRCOMB4 = rg(23), dLDIFF = rg(24), dRDIFF = rg(25),
          mLAPF1 = rg(26), mRAPF1 = rg(27), mLAPF2 = rg(28), mRAPF2 = rg(29), vLIN = g(30), vRIN = g(31);
    const Lin = (sat16(inL) * vLIN) >> 15, Rin = (sat16(inR) * vRIN) >> 15;
    const iir = (x, prev, d) => ((((x + ((d * vWALL) >> 15) - prev) * vIIR) >> 15) + prev);
    // reflexão (mesmo lado e lado oposto) - "prev" é a amostra 2 bytes antes
    wr(mLSAME, iir(Lin, rd(mLSAME, -2), rd(dLSAME)));
    wr(mRSAME, iir(Rin, rd(mRSAME, -2), rd(dRSAME)));
    wr(mLDIFF, iir(Lin, rd(mLDIFF, -2), rd(dRDIFF)));
    wr(mRDIFF, iir(Rin, rd(mRDIFF, -2), rd(dLDIFF)));
    // eco inicial (4 combs)
    let L = (rd(mLCOMB1) * vCOMB1 + rd(mLCOMB2) * vCOMB2 + rd(mLCOMB3) * vCOMB3 + rd(mLCOMB4) * vCOMB4) >> 15;
    let Rr = (rd(mRCOMB1) * vCOMB1 + rd(mRCOMB2) * vCOMB2 + rd(mRCOMB3) * vCOMB3 + rd(mRCOMB4) * vCOMB4) >> 15;
    // all-pass 1 e 2
    const apf = (x, m, d, v) => { const t = rd(m - d); const y = x - ((t * v) >> 15); wr(m, y); return ((y * v) >> 15) + t; };
    L = apf(L, mLAPF1, dAPF1, vAPF1); Rr = apf(Rr, mRAPF1, dAPF1, vAPF1);
    L = apf(L, mLAPF2, dAPF2, vAPF2); Rr = apf(Rr, mRAPF2, dAPF2, vAPF2);
    this.revOutL = (sat16(L) * s16(this.reg(R.REVL))) >> 15;
    this.revOutR = (sat16(Rr) * s16(this.reg(R.REVR))) >> 15;
    this.revAdvance(base);
  }
  revAdvance(base = (this.reg(R.REVBASE) << 3) & (SPU_RAM_SIZE - 1)) { this.revPos += 2; if (this.revPos >= SPU_RAM_SIZE) this.revPos = base; }

  /** Gera `frames` amostras estéreo intercaladas (Int16Array L,R,L,R...) */
  render(frames, out) {
    out = out ?? new Int16Array(frames * 2);
    for (let i = 0; i < frames; i++) { const [l, r] = this.tick(); out[2 * i] = l; out[2 * i + 1] = r; }
    return out;
  }

  /** Entrada de áudio do CD (amostras estéreo já em 44.1kHz) */
  pushCd(l, r) {
    const n = (this.cdTail + 1) & 0xFFFF; if (n === this.cdHead) return;      // cheio
    this.cdBufL[this.cdTail] = sat16(l | 0); this.cdBufR[this.cdTail] = sat16(r | 0); this.cdTail = n;
  }
}

return { SPU_RAM_SIZE, REV_FIR, SPU };
})();
const __src_disc = (() => {
// ============================================================================
//  Imagem de disco (.bin crua 2352 bytes/setor, ou .iso 2048) + ISO9660 + PS-X EXE
// ============================================================================
//  Layout de um setor CD-ROM XA "MODE 2" (2352 bytes):
//    0x000  12  sync (00 FF*10 00)
//    0x00C   4  header: MM SS FF (BCD) + modo (2)
//    0x010   8  subheader: file, channel, submode, coding (x2)
//    0x018 2048 dados (Form 1)   [Form 2 = 2324 bytes, usado em XA-ADPCM/vídeo]
//    ...        EDC/ECC
//  LBA 0 == tempo absoluto 00:02:00 (pregap de 150 setores).
// ============================================================================

const SECTOR_RAW = 2352;
const SECTOR_USER = 2048;
const SYNC = [0x00, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0x00];

const bcd = v => ((v / 10 | 0) << 4) | (v % 10);
const unbcd = v => (v >> 4) * 10 + (v & 15);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

const lbaToMsf = lba => { lba += 150; return { m: bcd(lba / 4500 | 0), s: bcd((lba / 75 | 0) % 60), f: bcd(lba % 75) }; };
const msfToLba = (m, s, f) => (unbcd(m) * 60 + unbcd(s)) * 75 + unbcd(f) - 150;

class PsxExe {
  constructor(bytes) {
    const magic = String.fromCharCode(...bytes.subarray(0, 8));
    if (magic !== 'PS-X EXE') throw new Error('Não é um PS-X EXE');
    this.pc = u32(bytes, 0x10);
    this.gp = u32(bytes, 0x14);
    this.textAddr = u32(bytes, 0x18);
    this.textSize = u32(bytes, 0x1C);
    this.sp = u32(bytes, 0x30) ? (u32(bytes, 0x30) + u32(bytes, 0x34)) >>> 0 : 0;
    this.region = String.fromCharCode(...bytes.subarray(0x4C, 0x80)).split('\0')[0];
    this.data = bytes.slice(0x800, 0x800 + this.textSize);
  }
}

const cueTime = t => { const m = /^(\d+):(\d+):(\d+)$/.exec(t); if (!m) throw new Error('Tempo inválido no CUE: ' + t); return (+m[1] * 60 + +m[2]) * 75 + +m[3]; };

/**
 * Fonte de bytes PREGUIÇOSA sobre um Blob/File: lê do arquivo só o que o emulador pede (blocos de 256 KB em cache LRU), em vez de
 * carregar o disco inteiro na memória (um .bin de 700 MB estourava a memória da aba no celular). Só funciona dentro de um Web Worker
 * (usa FileReaderSync). Mesma interface que o DiscImage usa de um Uint8Array: `length` e `subarray(a, b)`.
 */
class BlobSource {
  constructor(blob, reader = null, chunk = 262144, keep = 12) {
    this.blob = blob; this.length = blob.size; this.CH = chunk; this.keep = keep; this.lru = new Map();
    const frs = reader ? null : new FileReaderSync();
    this.read = reader || ((a, b) => new Uint8Array(frs.readAsArrayBuffer(blob.slice(a, b))));
  }
  chunk(i) {
    let c = this.lru.get(i);
    if (c) { this.lru.delete(i); this.lru.set(i, c); return c; }
    c = this.read(i * this.CH, Math.min(this.length, (i + 1) * this.CH));
    this.lru.set(i, c); if (this.lru.size > this.keep) this.lru.delete(this.lru.keys().next().value);
    return c;
  }
  subarray(a, b = this.length) {
    a = Math.max(0, a); b = Math.min(this.length, b); if (b <= a) return new Uint8Array(0);
    const ca = Math.floor(a / this.CH), cb = Math.floor((b - 1) / this.CH);
    if (ca === cb) return this.chunk(ca).subarray(a - ca * this.CH, b - ca * this.CH);
    const out = new Uint8Array(b - a);                                       // setor que cruza dois blocos: monta uma cópia
    for (let i = ca; i <= cb; i++) { const base = i * this.CH, c = this.chunk(i), lo = Math.max(a, base), hi = Math.min(b, base + c.length); out.set(c.subarray(lo - base, hi - base), lo - a); }
    return out;
  }
}

class DiscImage {
  /**
   * `bytes` = imagem de UMA trilha de dados (.bin 2352 cru ou .iso 2048).
   * `layout` (usado por fromCue) = { files:[{bytes,sectorSize,lba0,count}], tracks:[{n,type,start}] }.
   */
  constructor(bytes, layout = null) {
    if (layout) { this.files = layout.files; this.tracks = layout.tracks; }
    else {
      const head = bytes.subarray(0, 12), raw = bytes.length % SECTOR_RAW === 0 && SYNC.every((v, i) => head[i] === v), ss = raw ? SECTOR_RAW : SECTOR_USER;
      this.files = [{ bytes, sectorSize: ss, lba0: 0, count: Math.floor(bytes.length / ss) }];
      this.tracks = [{ n: 1, type: 'data', start: 0 }];
    }
    const f0 = this.files[0], last = this.files[this.files.length - 1];
    this.bytes = f0.bytes;
    this.sectorSize = f0.sectorSize;
    this.raw = f0.sectorSize === SECTOR_RAW;
    this.sectorCount = last.lba0 + last.count;
    this.tracks.forEach((t, i) => { const nx = this.tracks[i + 1]; t.end = nx ? (nx.pre ?? nx.start) : this.sectorCount; });
    this.silence = new Uint8Array(SECTOR_RAW);                            // PREGAP virtual (sem dados no arquivo)
    this.userOffset = this.raw ? (f0.bytes.subarray(15, 16)[0] === 2 ? 24 : 16) : 0;      // MODE2 -> 24, MODE1 -> 16
    this.pvd = this.readUser(16);
    if (!this.pvd || String.fromCharCode(...this.pvd.subarray(1, 6)) !== 'CD001') throw new Error('Volume ISO9660 não encontrado no LBA 16');
    this.volumeId = text(this.pvd, 40, 32);
    this.systemId = text(this.pvd, 8, 32);
    this.rootLba = u32(this.pvd, 158);
    this.rootLen = u32(this.pvd, 166);
    this.cache = new Map();
  }

  /**
   * Monta um disco a partir de um .cue. `files` = { 'nome.bin': Uint8Array, ... } (ou Map).
   * Suporta várias trilhas por arquivo ou um arquivo por trilha, MODE1/2048, MODE1/2352,
   * MODE2/2352 e AUDIO (PCM 16-bit estéreo 44.1 kHz), INDEX 00/01 e PREGAP.
   */
  static fromCue(cueText, files) {
    const map = files instanceof Map ? files : new Map(Object.entries(files));
    const find = name => {
      if (map.has(name)) return map.get(name);
      const base = name.split(/[\\/]/).pop().toLowerCase();
      for (const [k, v] of map) if (k.split(/[\\/]/).pop().toLowerCase() === base) return v;
      throw new Error('Arquivo do CUE não fornecido: ' + name);
    };
    const fl = [], tracks = []; let cur = null, curTrack = null, running = 0;
    const closeFile = () => { if (cur) { cur.count = Math.floor(cur.bytes.length / cur.sectorSize); running = cur.lba0 + cur.count; } };
    for (const raw of cueText.split(/\r?\n/)) {
      const line = raw.trim(); let m;
      if ((m = /^FILE\s+(?:"([^"]+)"|(\S+))\s+(\S+)/i.exec(line))) {
        closeFile();
        cur = { bytes: find(m[1] ?? m[2]), sectorSize: 0, lba0: running, count: 0, first: true };
        fl.push(cur);
      } else if ((m = /^TRACK\s+(\d+)\s+(\S+)/i.exec(line))) {
        if (!cur) throw new Error('TRACK antes de FILE no CUE');
        const mode = m[2].toUpperCase(), audio = mode === 'AUDIO';
        const ss = mode === 'MODE1/2048' ? SECTOR_USER : mode === 'MODE2/2336' ? 2336 : SECTOR_RAW;
        if (!cur.sectorSize) cur.sectorSize = ss;
        curTrack = { n: +m[1], type: audio ? 'audio' : 'data', start: 0, file: cur, firstInFile: cur.first };
        cur.first = false; tracks.push(curTrack);
      } else if ((m = /^PREGAP\s+(\S+)/i.exec(line)) && curTrack) {
        if (curTrack.firstInFile) { const g = cueTime(m[1]); cur.lba0 += g; }          // silêncio antes do arquivo
      } else if ((m = /^INDEX\s+(\d+)\s+(\S+)/i.exec(line)) && curTrack) {
        if (+m[1] === 1) curTrack.start = cur.lba0 + cueTime(m[2]);
        else if (+m[1] === 0) curTrack.pre = cur.lba0 + cueTime(m[2]);                  // início do pregap (INDEX 00)
      }
    }
    closeFile();
    if (!tracks.length) throw new Error('CUE sem trilhas');
    tracks.forEach(t => delete t.file);
    tracks[0].start = 0;                                                                // LBA 0 = início da trilha 1
    return new DiscImage(null, { files: fl.map(({ bytes, sectorSize, lba0, count }) => ({ bytes, sectorSize, lba0, count })), tracks: tracks.map(({ n, type, start, pre }) => (pre !== undefined && pre < start ? { n, type, start, pre } : { n, type, start })) });
  }

  trackAt(lba) {
    for (let i = this.tracks.length - 1; i >= 0; i--) if (lba >= (this.tracks[i].pre ?? this.tracks[i].start)) return this.tracks[i];
    return this.tracks[0];
  }

  /** Setor inteiro (2352 bytes se raw; 2048 se .iso) */
  readSector(lba) {
    if (lba < 0 || lba >= this.sectorCount) return null;
    for (const f of this.files) {
      if (lba >= f.lba0 && lba < f.lba0 + f.count) return f.bytes.subarray((lba - f.lba0) * f.sectorSize, (lba - f.lba0 + 1) * f.sectorSize);
    }
    return this.silence;
  }
  /** 2048 bytes de dados (Form 1) */
  readUser(lba) {
    const s = this.readSector(lba);
    return s && s.subarray(this.userOffset, this.userOffset + SECTOR_USER);
  }
  /** Cabeçalho/subheader XA: o controlador de CD-ROM usa isso (filtros XA, tipo de setor) */
  sectorInfo(lba) {
    const s = this.readSector(lba);
    if (!s || !this.raw || s.length !== SECTOR_RAW || this.trackAt(lba).type === 'audio') return null;
    const sm = s[18];
    return { mode: s[15], file: s[16], channel: s[17], submode: sm, coding: s[19],
             form2: !!(sm & 0x20), audio: !!(sm & 0x04), video: !!(sm & 0x02), data: !!(sm & 0x08), rt: !!(sm & 0x40), eof: !!(sm & 0x80) };
  }

  // ---------------- ISO9660 ----------------
  readDir(lba, len) {
    const out = [];
    for (let blk = 0; blk < Math.ceil(len / 2048); blk++) {
      const d = this.readUser(lba + blk); let o = 0;
      while (o < 2048 && d[o]) {
        const l = d[o], nl = d[o + 32];
        const name = text(d, o + 33, nl);
        if (name !== '\0' && name !== '\x01')
          out.push({ name, lba: u32(d, o + 2), size: u32(d, o + 10), dir: !!(d[o + 25] & 2) });
        o += l;
      }
    }
    return out;
  }
  listRoot() { return this.cache.get('root') ?? (this.cache.set('root', this.readDir(this.rootLba, this.rootLen)), this.cache.get('root')); }

  /** Procura "DIR\ARQ.EXT" ignorando o ";1" e maiúsc./minúsc. */
  findFile(path) {
    const parts = path.replace(/^cdrom:/i, '').split(/[\\/]/).filter(Boolean);
    let list = this.listRoot(), ent = null;
    for (const p of parts) {
      const want = p.toUpperCase().replace(/;\d+$/, '');
      ent = list.find(e => e.name.toUpperCase().replace(/;\d+$/, '') === want);
      if (!ent) return null;
      if (ent.dir) list = this.readDir(ent.lba, ent.size);
    }
    return ent;
  }
  readFile(path) {
    const e = this.findFile(path); if (!e) return null;
    const out = new Uint8Array(e.size);
    for (let i = 0; i * 2048 < e.size; i++) out.set(this.readUser(e.lba + i).subarray(0, Math.min(2048, e.size - i * 2048)), i * 2048);
    return out;
  }

  systemCnf() {
    const f = this.readFile('SYSTEM.CNF'); if (!f) return null;
    const cnf = {};
    for (const line of String.fromCharCode(...f).split(/\r?\n/)) {
      const m = line.match(/^\s*(\w+)\s*=\s*(.*?)\s*$/); if (m) cnf[m[1].toUpperCase()] = m[2];
    }
    return cnf;
  }

  /** Região lida da área de licença (setores 4..): SCEI (JP), SCEA (US), SCEE (EU) */
  region() {
    let t = '';
    for (let i = 0; i < 12; i++) t += String.fromCharCode(...this.readUser(i));
    const c = t.replace(/[^A-Za-z]/g, '');
    if (/Entertainment(Euro)*pe/.test(c) || /Europe/.test(c)) return 'SCEE';
    if (/America|Amer/.test(c)) return 'SCEA';
    if (/LicensedbySonyComputerEntertainmentInc/.test(c)) return 'SCEI';
    return 'desconhecida';
  }

  /** Executável de boot (BOOT= do SYSTEM.CNF; fallback PSX.EXE) */
  loadBootExe() {
    const cnf = this.systemCnf();
    const path = cnf?.BOOT?.replace(/^cdrom:\\?/i, '') ?? 'PSX.EXE';
    const bytes = this.readFile(path);
    if (!bytes) throw new Error('Executável de boot não encontrado: ' + path);
    const exe = new PsxExe(bytes);
    exe.path = path; exe.cnf = cnf ?? {};
    exe.stack = cnf?.STACK ? parseInt(cnf.STACK, 16) >>> 0 : 0x801FFF00;
    return exe;
  }

  info() {
    const cnf = this.systemCnf();
    const secs = this.sectorCount, sec = secs / 75 | 0;
    return { formato: this.raw ? 'BIN cru 2352 (MODE2/XA)' : 'ISO 2048', setores: secs, trilhas: this.tracks.length, audio: this.tracks.filter(t => t.type === 'audio').length,
             duracao: `${sec / 60 | 0}:${String(sec % 60).padStart(2, '0')}`, volume: this.volumeId.trim(),
             regiao: this.region(), boot: cnf?.BOOT, stack: cnf?.STACK };
  }
}

const text = (b, o, n) => String.fromCharCode(...b.subarray(o, o + n));

return { SECTOR_RAW, SECTOR_USER, lbaToMsf, msfToLba, PsxExe, BlobSource, DiscImage };
})();
const __src_scheduler = (() => {
// Agendador de eventos em ciclos de CPU (usado por CD-ROM, SIO0, DMA...)
// Dois tipos de evento:
//   add(time, fn)                      closure (não entra em save states; só para testes/uso interno)
//   call(time, obj, método, args)      descritor serializável: chama reg[obj][método](...args)
class Scheduler {
  constructor() { this.q = []; this.reg = {}; this.onEarly = null; }
  /** registra os objetos que podem receber eventos descritores (cdrom, dma, sio...) */
  register(name, obj) { this.reg[name] = obj; }
  _ins(e) { if (this.onEarly) this.onEarly(e.time); let i = this.q.length; while (i > 0 && this.q[i - 1].time > e.time) i--; this.q.splice(i, 0, e); return e; }
  /** agenda fn para o instante absoluto `time` (em ciclos) */
  add(time, fn) { return this._ins({ time, fn }); }
  call(time, o, m, a = []) { return this._ins({ time, o, m, a }); }
  cancel(e) { const i = this.q.indexOf(e); if (i >= 0) this.q.splice(i, 1); }
  run(now) {
    while (this.q.length && this.q[0].time <= now) {
      const e = this.q.shift();
      if (e.fn) e.fn(); else this.reg[e.o][e.m](...e.a);
    }
  }
  clear() { this.q.length = 0; }
  get next() { return this.q.length ? this.q[0].time : Infinity; }
  /** lista serializável (falha se houver closures) */
  snapshot() {
    return this.q.map(e => { if (e.fn) throw new Error('evento com closure não pode entrar no save state'); return { time: e.time, o: e.o, m: e.m, a: e.a }; });
  }
  restore(list) { this.q = list.map(e => ({ time: e.time, o: e.o, m: e.m, a: e.a })); }
  find(o, m) { return this.q.find(e => e.o === o && e.m === m) || null; }
}

return { Scheduler };
})();
const __src_timers = (() => {
// ============================================================================
//  Root counters (timers) 0x1F801100-0x1F80112F
//   +0 contador  +4 modo  +8 alvo
//   modo: b0 sync, b1-2 sync mode, b3 reset no alvo, b4 IRQ no alvo, b5 IRQ em 0xFFFF,
//         b6 IRQ repetido, b7 toggle, b8-9 clock, b10 IRQ flag (1=sem IRQ), b11 atingiu alvo, b12 atingiu FFFF
//   Timer0: sysclk | dotclock    Timer1: sysclk | hblank    Timer2: sysclk | sysclk/8
//  Modos de sincronização (mode bit0=1; bits 1-2):
//    Timer0 (hblank) / Timer1 (vblank):  0 = pausa durante o blank   1 = zera o contador ao entrar no blank
//        2 = zera ao entrar no blank e só conta DENTRO dele          3 = pausa até o 1º blank, depois roda livre
//    Timer2: 0 e 3 = parado   1 e 2 = livre.
//  O PSX informa o estado (hblank, vblank) por tick() via setBlank(); as bordas aplicam reset/liberação.
// ============================================================================
class Timers {
  constructor(sys) {
    this.sys = sys; this.dotDiv = 10; this.hb = false; this.vb = false;
    this.t = [0, 1, 2].map(() => ({ counter: 0, mode: 0x400, target: 0, irqDone: false, frac: 0, free: false }));
  }
  reset() { for (const t of this.t) { t.counter = 0; t.mode = 0x400; t.target = 0; t.irqDone = false; t.frac = 0; t.free = false; } this.hb = false; this.vb = false; }

  read(addr, size) {
    const n = (addr >> 4) & 3, r = addr & 0xC; if (n > 2) return 0;
    this.sys.syncTimers?.(); const t = this.t[n]; let v = 0;
    if (r === 0) v = t.counter; else if (r === 4) { v = t.mode; t.mode &= ~0x1800; } else if (r === 8) v = t.target;
    if (addr & 2) return 0;
    return size === 1 ? v & 0xFF : v >>> 0;
  }
  write(addr, size, v) {
    const n = (addr >> 4) & 3, r = addr & 0xC; if (n > 2 || (addr & 2)) return;
    this.sys.syncTimers?.(); const t = this.t[n];
    if (r === 0) t.counter = v & 0xFFFF;
    else if (r === 4) { t.mode = (v & 0x3FF) | 0x400; t.counter = 0; t.irqDone = false; t.frac = 0; t.free = false; }
    else if (r === 8) t.target = v & 0xFFFF;
    this.sys.retime?.();
  }

  /** estado do blank horizontal/vertical no início do tick; as bordas aplicam os modos de sync */
  setBlank(hb, vb) {
    if (hb !== this.hb) { this.hb = hb; this.edge(0, hb); }
    if (vb !== this.vb) { this.vb = vb; this.edge(1, vb); }
  }
  edge(n, on) {
    const t = this.t[n]; if (!(t.mode & 1) || !on) return;
    const sm = (t.mode >> 1) & 3;
    if (sm === 1 || sm === 2) t.counter = 0; else if (sm === 3) t.free = true;
  }
  /** o contador n pode contar agora? (timers 0/1 conforme o blank; timer 2 conforme o modo) */
  gate(n) {
    const t = this.t[n]; if (!(t.mode & 1)) return true;
    const sm = (t.mode >> 1) & 3;
    if (n === 2) return sm === 1 || sm === 2;
    const blank = n === 0 ? this.hb : this.vb;
    return sm === 0 ? !blank : sm === 1 ? true : sm === 2 ? blank : t.free;
  }

  /** avança `dt` ciclos de CPU */
  advance(dt) {
    for (let n = 0; n < 3; n++) {
      const t = this.t[n], src = (t.mode >> 8) & 3; let ticks = 0;
      if (n === 0) { if (src & 1) { t.frac += dt * 11 / (7 * this.dotDiv); ticks = t.frac | 0; t.frac -= ticks; } else ticks = dt; }
      else if (n === 1) { if (src & 1) continue; ticks = dt; }                 // hblank: via hblank()
      else if (src & 2) { t.frac += dt / 8; ticks = t.frac | 0; t.frac -= ticks; } else ticks = dt;
      if (ticks && this.gate(n)) this.add(n, t, ticks);
    }
  }
  /** ciclos de CPU (>= 1) até o próximo evento de IRQ de algum contador (alvo/0xFFFF); Infinity se nada pode disparar. Usado para limitar o tick adaptativo. */
  nextEvent() {
    let best = Infinity;
    for (let n = 0; n < 3; n++) {
      const t = this.t[n], m = t.mode; if (!(m & 0x30)) continue;                        // sem IRQ no alvo nem em 0xFFFF
      const src = (m >> 8) & 3; let rate;
      if (n === 0) rate = (src & 1) ? 11 / (7 * this.dotDiv) : 1; else if (n === 1) { if (src & 1) continue; rate = 1; } else rate = (src & 2) ? 1 / 8 : 1;
      if (!this.gate(n)) continue;
      const v = t.counter; let need = 0x10000 - v;                                       // 0xFFFF -> 0 (IRQ do estouro)
      if (!(m & 0x20)) need = Infinity;
      if (m & 0x10) { const a = v < t.target ? t.target - v : (0x10000 - v) + t.target; if (a < need) need = a; }
      const cyc = Math.floor((need - t.frac) / rate);
      if (cyc < best) best = cyc;
    }
    return best < 1 ? 1 : best;
  }
  hblank() { const t = this.t[1]; if (((t.mode >> 8) & 1) && this.gate(1)) this.add(1, t, 1); }

  add(n, t, count) {
    const reset = !!(t.mode & 8); let v = t.counter, left = count;
    while (left > 0) {
      const limit = (reset && v <= t.target) ? t.target : 0xFFFF, room = limit - v;
      if (left <= room) { this.hit(n, t, v, v + left); v += left; left = 0; }
      else {
        this.hit(n, t, v, limit); left -= room + 1; v = 0;
        if (limit === 0xFFFF) { t.mode |= 0x1000; if (t.mode & 0x20) this.irq(n, t); }
      }
    }
    t.counter = v;
  }
  hit(n, t, a, b) { if (a < t.target && t.target <= b) { t.mode |= 0x800; if (t.mode & 0x10) this.irq(n, t); } }
  irq(n, t) {
    if (!(t.mode & 0x40) && t.irqDone) return;
    t.irqDone = true;
    if (t.mode & 0x80) { t.mode ^= 0x400; if (!(t.mode & 0x400)) this.sys.irq(4 + n); }   // toggle
    else this.sys.irq(4 + n);                                                           // pulso
  }
}

return { Timers };
})();
const __src_dma = (() => {
// ============================================================================
//  Controlador de DMA  0x1F801080-0x1F8010F7
//   canal n: +0 MADR, +4 BCR, +8 CHCR    0xF0 DPCR    0xF4 DICR
//   0 MDEC-in 1 MDEC-out 2 GPU 3 CD-ROM 4 SPU 5 PIO 6 OTC
//  A transferência é feita na hora; só a conclusão/IRQ é agendada (1 ciclo/palavra).
// ============================================================================
class DMA {
  constructor(sys) {
    this.sys = sys; this.dev = {};                    // gpu, spu, cdrom, mdec (preenchido pelo PSX)
    this.madr = new Uint32Array(7); this.bcr = new Uint32Array(7); this.chcr = new Uint32Array(7);
    this.reset();
  }
  reset() { this.madr.fill(0); this.bcr.fill(0); this.chcr.fill(0); this.dpcr = 0x07654321; this.dicr = 0; this.prevIrq = false; this.deferred = null; }

  read(addr, size) {
    const sh = (addr & 3) * 8, a = addr & ~3; let v = 0;
    if (a === 0x1F8010F0) v = this.dpcr; else if (a === 0x1F8010F4) v = this.dicr;
    else {
      const ch = (a - 0x1F801080) >> 4;
      if (ch >= 0 && ch < 7) { const r = a & 0xC; v = r === 0 ? this.madr[ch] : r === 4 ? this.bcr[ch] : r === 8 ? this.chcr[ch] : 0; }
    }
    return size === 4 ? v >>> 0 : ((v >>> sh) & (size === 2 ? 0xFFFF : 0xFF)) >>> 0;
  }

  write(addr, size, v) {
    if (size !== 4) {                                   // sub-palavra: read-modify-write
      const a = addr & ~3, sh = (addr & 3) * 8, m = (size === 2 ? 0xFFFF : 0xFF) << sh;
      // no DICR os bits 24-30 são "escreva 1 para limpar": os bytes NÃO escritos devem valer 0 nas flags
      // (senão a flag atual seria remendada no valor e apagada por engano)
      const cur = a === 0x1F8010F4 ? (this.read(a, 4) & 0x80FFFFFF) : this.read(a, 4);
      v = ((cur & ~m) | ((v << sh) & m)) >>> 0; addr = a;
    }
    if (addr === 0x1F8010F0) { this.dpcr = v >>> 0; return; }
    if (addr === 0x1F8010F4) {
      const keep = this.dicr & 0x7F000000 & ~(v & 0x7F000000);
      this.dicr = ((v & 0x00FF803F) | keep) >>> 0; this.updateIrq(); return;
    }
    const ch = (addr - 0x1F801080) >> 4; if (ch < 0 || ch > 6) return;
    const r = addr & 0xC;
    if (r === 0) this.madr[ch] = v & 0xFFFFFF;
    else if (r === 4) this.bcr[ch] = v;
    else if (r === 8) {
      this.chcr[ch] = ch === 6 ? ((v & 0x51000000) | 2) >>> 0 : v >>> 0;
      this.maybeStart(ch);
    }
  }

  maybeStart(ch) {
    const c = this.chcr[ch];
    if (!(c & 0x01000000)) return;                                   // start/busy
    if (!(this.dpcr & (8 << (ch * 4)))) return;                      // canal desabilitado no DPCR
    const sync = (c >> 9) & 3;
    // modo 0: só o OTC (sem linha DREQ) e o PIO precisam do bit de trigger; GPU/CD/SPU/MDEC iniciam sozinhos (medido em hardware)
    if (sync === 0 && !(c & 0x10000000) && (ch === 6 || ch === 5)) return;
    const words = this.run(ch);
    if (words < 0) return;                                           // adiado (aguardando dados do MDEC)
    this.sys.sched.call(this.sys.now() + this.duration(ch, words, c), 'dma', 'finish', [ch]);
  }

  /** duração (ciclos de CPU) de uma transferência. Ajustado às medições do ps1-tests/dma/chopping:
   *  1 ciclo/palavra (CD 24, SPU 12), +~10 por bloco no sync 1, e chopping = janela de DMA + pausa da CPU a cada fatia */
  duration(ch, words, c) {
    const per = ch === 3 ? 24 : ch === 4 ? 12 : 1, sync = (c >> 9) & 3; let cyc = words * per + (ch === 2 ? 150 : 16);
    if (c & 0x100) {                                                 // chopping
      const win = 1 << ((c >> 16) & 7), cpu = Math.min(1 << ((c >> 20) & 7), 32 * win);
      cyc += Math.ceil(words / win) * (6 + cpu);
    } else if (sync === 1) cyc += (((this.bcr[ch] >>> 16) || 0x10000)) * 10;
    return Math.max(8, Math.round(cyc));
  }

  finish(ch) {
    this.chcr[ch] &= ~0x11000000;
    if ((this.dicr >> (16 + ch)) & 1) {
      this.dicr |= (1 << (24 + ch));
      this.updateIrq();
      // cada conclusão de um canal habilitado reafirma a IRQ3 (não só na subida do bit 31):
      // evita que uma flag não reconhecida silencie todas as próximas interrupções de DMA
      if ((this.dicr >>> 31) & 1) this.sys.irq(3);
    } else this.updateIrq();
  }
  updateIrq() {
    const flags = (this.dicr >> 24) & 0x7F, en = (this.dicr >> 16) & 0x7F, master = (this.dicr >> 23) & 1, force = (this.dicr >> 15) & 1;
    const m = !!(force || (master && (flags & en)));
    this.dicr = ((this.dicr & 0x7FFFFFFF) | (m ? 0x80000000 : 0)) >>> 0;
    if (m && !this.prevIrq) this.sys.irq(3);
    this.prevIrq = m;
  }

  /** o MDEC produziu dados: atende um DMA1 que estava esperando */
  mdecOutReady() {
    const m = this.dev.mdec, p = m && m.pendingOut; if (!p || m.outWords() < p.words) return;
    m.pendingOut = null; const rv = this.sys.bus.ramView, b = m.dmaRead(p.words); let a = p.addr;
    const bus = this.sys.bus; for (let i = 0; i < p.words; i++) { const o = a & 0x1FFFFC; rv.setUint32(o, b[i], true); if (bus.codeFlags[o >>> 6]) bus.onCodeWrite(o); a += p.step; }
    this.madr[1] = a & 0xFFFFFF;
    this.sys.sched.call(this.sys.now() + Math.max(8, p.words), 'dma', 'finish', [1]);
  }

  /** executa a transferência; devolve o nº de palavras */
  run(ch) {
    const bus = this.sys.bus, rv = bus.ramView, c = this.chcr[ch];
    const dir = c & 1, step = (c & 2) ? -4 : 4, sync = (c >> 9) & 3;
    let addr = this.madr[ch] & 0x1FFFFC, bcr = this.bcr[ch];
    const words = sync === 1 ? ((bcr & 0xFFFF) * (bcr >>> 16)) || 0x10000 : ((bcr & 0xFFFF) || 0x10000);
    const rd = a => rv.getUint32(a & 0x1FFFFC, true), wr = (a, v) => { const o = a & 0x1FFFFC; rv.setUint32(o, v >>> 0, true); if (bus.codeFlags[o >>> 6]) bus.onCodeWrite(o); };
    const d = this.dev;

    switch (ch) {
      case 6: {                                                      // OTC: lista encadeada reversa
        for (let i = 0; i < words; i++) { wr(addr, i === words - 1 ? 0x00FFFFFF : (addr - 4) & 0x1FFFFF); addr = (addr - 4) & 0x1FFFFC; }
        this.madr[6] = addr; return words;
      }
      case 2:                                                        // GPU
        if (sync === 2) {                                            // linked list
          let n = 0, a = addr;
          for (let g = 0; g < 0x100000; g++) {
            const hdr = rd(a), cnt = hdr >>> 24;
            for (let i = 1; i <= cnt; i++) d.gpu.writeGP0(rd(a + 4 * i));
            n += cnt + 1; if (hdr & 0x800000) break; a = hdr & 0x1FFFFC;
          }
          this.madr[2] = a; return n;
        }
        if (dir) { for (let i = 0; i < words; i++) { d.gpu.writeGP0(rd(addr)); addr += step; } }
        else { for (let i = 0; i < words; i++) { wr(addr, d.gpu.readData()); addr += step; } }
        this.madr[2] = addr & 0xFFFFFF; return words;
      case 4: {                                                      // SPU
        if (dir) { const b = new Uint32Array(words); for (let i = 0; i < words; i++) { b[i] = rd(addr); addr += step; } d.spu.dmaWrite(b); }
        else { const b = d.spu.dmaRead(words); for (let i = 0; i < words; i++) { wr(addr, b[i]); addr += step; } }
        this.madr[4] = addr & 0xFFFFFF; return words;
      }
      case 3: {                                                      // CD-ROM -> RAM
        const b = d.cdrom.dmaRead(words); for (let i = 0; i < words; i++) { wr(addr, b[i]); addr += step; }
        this.madr[3] = addr & 0xFFFFFF; return words;
      }
      case 0: {                                                      // MDEC in (RAM -> MDEC)
        if (d.mdec) { const b = new Uint32Array(words); for (let i = 0; i < words; i++) { b[i] = rd(addr); addr += step; } d.mdec.dmaWrite(b); }
        return words;
      }
      case 1: {                                                      // MDEC out (MDEC -> RAM)
        const m = d.mdec;
        if (m && m.outWords() < words) { m.pendingOut = { addr, step, words }; return -1; }          // espera o decodificador
        const b = m ? m.dmaRead(words) : new Uint32Array(words);
        for (let i = 0; i < words; i++) { wr(addr, b[i]); addr += step; }
        this.madr[1] = addr & 0xFFFFFF; return words;
      }
      default: return words;                                         // PIO: ignorado
    }
  }
}

return { DMA };
})();
const __src_mdec = (() => {
// ============================================================================
//  MDEC - decodificador de macroblocos (vídeo STR / imagens) 0x1F801820 / 0x1F801824
//   0x1F801820 W: comando/parâmetros   R: dados decodificados
//   0x1F801824 W: controle (b31 reset, b30 DMA0 on, b29 DMA1 on)   R: status
//  Comandos (bits 31-29 da palavra de comando):
//   1 = decodificar macroblocos (b28-27 profundidade: 0=4bit 1=8bit 2=24bit 3=15bit, b26 signed, b25 bit15, b15-0 = nº de palavras)
//   2 = tabelas de quantização (b0: 0 = só luma 64B, 1 = luma + croma 128B)
//   3 = tabela de escala do IDCT (64 halfwords)
//  Entrada: halfwords RLE: [qscale(6) | DC(10)] depois [run(6) | valor(10)] ... até 0xFE00 (fim de bloco)
//  Saída: macroblocos 16x16 (cores) na ordem do fluxo; cada um é decodificado de blocos Cr,Cb,Y1,Y2,Y3,Y4.
//  A decodificação é imediata (sem temporização); a conclusão do DMA é agendada pelo controlador de DMA.
// ============================================================================
const ZIGZAG = [0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28,
                35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63];
const IDLE = 0, DECODE = 1, QUANT = 2, SCALE = 3;
const sx10 = v => (v << 22) >> 22;
const clamp = (v, lo, hi) => v < lo ? lo : v > hi ? hi : v;

/** tabela de cossenos padrão: T[k*8+n] = a_k * cos((2n+1)kπ/16) * 32768  (a_0 = 1/√2) */
function defaultScaleTable() {
  const t = new Int16Array(64);
  for (let k = 0; k < 8; k++) for (let n = 0; n < 8; n++) t[k * 8 + n] = Math.trunc((k === 0 ? Math.SQRT1_2 : 1) * Math.cos((2 * n + 1) * k * Math.PI / 16) * 32768);
  return t;
}

class MDEC {
  constructor() {
    this.out = new Uint8Array(1 << 22); this.onOutput = null; this.pendingOut = null;
    this.qtY = new Uint8Array(64).fill(2); this.qtC = new Uint8Array(64).fill(2); this.scale = defaultScaleTable();
    this.reset();
  }

  reset() {
    this.state = IDLE; this.remaining = 0; this.depth = 0; this.signed = 0; this.bit15 = 0;
    this.hw = []; this.hwPos = 0; this.blocks = [0, 1, 2, 3, 4, 5].map(() => new Int32Array(64)); this.blk = 0;
    this.head = 0; this.tail = 0; this.dmaInEn = false; this.dmaOutEn = false; this.qbuf = []; this.sbuf = []; this.colorQ = false;
    this.coef = new Int32Array(64); this.tmp = new Int32Array(64); this.pendingOut = null; this.blocksDone = 0;
  }

  outWords() { return (this.tail - this.head) >> 2; }

  // ---------------- registradores ----------------
  read(addr) {
    if ((addr & 4) === 0) return this.dmaRead(1)[0];
    let s = 0;
    if (this.outWords() === 0) s |= 0x80000000;
    if (this.state !== IDLE) s |= 0x20000000;                       // comando em andamento (busy)
    if (this.dmaInEn) s |= 0x10000000;
    if (this.dmaOutEn && this.outWords() > 0) s |= 0x08000000;
    s |= (this.depth << 25) | (this.signed << 24) | (this.bit15 << 23) | ((this.blk < 6 ? (this.blk + 4) % 6 : 0) << 16);
    s |= this.state === IDLE ? 0 : ((this.remaining - 1) & 0xFFFF);
    return s >>> 0;
  }
  write(addr, v) {
    if ((addr & 4) === 0) { this.writeWord(v >>> 0); return; }
    if (v & 0x80000000) { const o = this.out; const e1 = this.onOutput; this.reset(); this.out = o; this.onOutput = e1; }
    this.dmaInEn = !!(v & 0x40000000); this.dmaOutEn = !!(v & 0x20000000);
  }

  // palavra de comando ou de parâmetro (via CPU ou DMA0)
  writeWord(w) {
    if (this.state === IDLE) {
      const cmd = w >>> 29;
      if (cmd === 1) {
        this.depth = (w >>> 27) & 3; this.signed = (w >>> 26) & 1; this.bit15 = (w >>> 25) & 1; this.remaining = w & 0xFFFF;
        this.state = this.remaining ? DECODE : IDLE; this.blk = 0; this.hw = []; this.hwPos = 0;
      } else if (cmd === 2) { this.colorQ = !!(w & 1); this.remaining = this.colorQ ? 32 : 16; this.qbuf = []; this.state = QUANT; }
      else if (cmd === 3) { this.remaining = 32; this.sbuf = []; this.state = SCALE; }
      return;
    }
    if (this.state === QUANT) {
      this.qbuf.push(w & 255, (w >>> 8) & 255, (w >>> 16) & 255, w >>> 24);
      if (--this.remaining === 0) {
        this.qtY.set(this.qbuf.slice(0, 64));
        if (this.colorQ) this.qtC.set(this.qbuf.slice(64, 128)); else this.qtC.set(this.qtY);
        this.state = IDLE;
      }
    } else if (this.state === SCALE) {
      this.sbuf.push(((w & 0xFFFF) << 16) >> 16, (w >> 16));
      if (--this.remaining === 0) { this.scale.set(this.sbuf); this.state = IDLE; }
    } else {                                                          // DECODE
      this.hw.push(w & 0xFFFF, w >>> 16);
      if (this.hw.length > 8192) { this.hw = this.hw.slice(this.hwPos); this.hwPos = 0; }   // evita crescer sem limite
      this.decodeAvailable();
      if (--this.remaining === 0) {
        this.state = IDLE; this.hw = []; this.hwPos = 0;
        if (this.outWords() > 0) this.onOutput?.();
      }
    }
  }

  dmaWrite(words) { for (let i = 0; i < words.length; i++) this.writeWord(words[i]); }
  /** retira n palavras da saída (as que faltarem vêm como zero) */
  dmaRead(n) {
    const o = new Uint32Array(n); let p = this.head;
    for (let i = 0; i < n && p + 4 <= this.tail; i++, p += 4) o[i] = (this.out[p] | (this.out[p + 1] << 8) | (this.out[p + 2] << 16) | (this.out[p + 3] << 24)) >>> 0;
    this.head = Math.min(this.tail, p); if (this.head === this.tail) this.head = this.tail = 0;
    return o;
  }

  // ---------------- decodificação ----------------
  /** decodifica todos os blocos completos disponíveis na fila de halfwords */
  decodeAvailable() {
    const color = this.depth >= 2;
    for (;;) {
      const res = this.decodeBlock(color ? (this.blk < 2 ? this.qtC : this.qtY) : this.qtY, this.blocks[color ? this.blk : 0]);
      if (!res) return;
      if (!color) { this.emitMono(this.blocks[0]); continue; }
      if (++this.blk === 6) { this.blk = 0; this.emitColor(); }
    }
  }

  /** lê 1 bloco (DC + ACs até EOB). Devolve false se faltarem halfwords (nada é consumido). */
  decodeBlock(qt, dst) {
    const hw = this.hw; let p = this.hwPos;
    while (p < hw.length && hw[p] === 0xFE00) p++;                   // preenchimento antes do bloco
    if (p >= hw.length) { this.hwPos = p; return false; }
    const first = hw[p++], qscale = first >>> 10, coef = this.coef; coef.fill(0);
    coef[0] = clamp(qscale === 0 ? sx10(first & 0x3FF) * 2 : sx10(first & 0x3FF) * qt[0], -1024, 1023);
    let k = 0, done = false;
    while (p < hw.length) {
      const h = hw[p++];
      if (h === 0xFE00) { done = true; break; }
      k += (h >>> 10) + 1;
      if (k > 63) { done = true; break; }
      { const n = sx10(h & 0x3FF), q = qscale === 0 ? n * 2 : (n * qt[k] * qscale + 4) >> 3; coef[ZIGZAG[k]] = q < -1024 ? -1024 : q > 1023 ? 1023 : q; }
      if (k === 63) { done = true; break; }
    }
    if (!done) return false;                                         // bloco incompleto: espera mais dados
    this.hwPos = p; this.idct(coef, dst); this.blocksDone++; return true;
  }

  /** IDCT 2D inteira (2 passadas), resultado saturado em -128..127 */
  idct(src, dst) {
    const T = this.scale, tmp = this.tmp, nzz = this.nzz || (this.nzz = new Int32Array(8)), nzv = this.nzv || (this.nzv = new Int32Array(8));
    for (let pass = 0; pass < 2; pass++) {
      const s = pass === 0 ? src : tmp, d = pass === 0 ? tmp : dst;
      for (let y = 0; y < 8; y++) {
        let n = 0;                                                    // só os coeficientes não nulos da coluna entram na soma (resultado idêntico, bem menos multiplicações)
        for (let z = 0; z < 8; z++) { const v = s[y + z * 8]; if (v !== 0) { nzz[n] = z * 8; nzv[n++] = v; } }
        if (n === 0) { for (let x = 0; x < 8; x++) d[x + y * 8] = 0; continue; }
        for (let x = 0; x < 8; x++) {
          let sum = 0;
          for (let i = 0; i < n; i++) sum += nzv[i] * T[x + nzz[i]];
          d[x + y * 8] = pass === 0 ? sum >> 13 : Math.floor((sum + 0x4000) / 32768);   // medido contra o console real (ps1-tests/mdec/frame)
        }
      }
    }
    for (let i = 0; i < 64; i++) { const v = (dst[i] + 8) >> 4; dst[i] = v < -128 ? -128 : v > 127 ? 127 : v; }
  }

  put(b) { if (this.tail < this.out.length) this.out[this.tail++] = b; }

  emitMono(blk) {
    const off = this.signed ? 0 : 128;
    if (this.depth === 1) for (let i = 0; i < 64; i++) this.put((blk[i] + off) & 255);              // 8 bits
    else for (let i = 0; i < 64; i += 2) this.put((((blk[i] + off) & 255) >> 4) | ((((blk[i + 1] + off) & 255) >> 4) << 4));   // 4 bits
  }

  emitColor() {
    const [cr, cb, y1, y2, y3, y4] = this.blocks, off = this.signed ? 0 : 128, b15 = this.bit15 << 15, ys = [y1, y2, y3, y4];
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
      const Y = ys[((y >> 3) << 1) | (x >> 3)][((y & 7) << 3) | (x & 7)], ci = ((y >> 1) << 3) | (x >> 1), Cr = cr[ci], Cb = cb[ci];
      const r = clamp(Y + ((359 * Cr + 128) >> 8), -128, 127), g = clamp(Y - ((88 * Cb + 183 * Cr + 128) >> 8), -128, 127), b = clamp(Y + ((454 * Cb + 128) >> 8), -128, 127);
      if (this.depth === 2) { this.put((r + off) & 255); this.put((g + off) & 255); this.put((b + off) & 255); }          // 24 bits
      else {                                                                                                          // 15 bits
        const q = v => Math.min(((v + off) & 255) + 4 >> 3, 31);   // 15 bits: arredonda (confirmado no console real)
        const px = q(r) | (q(g) << 5) | (q(b) << 10) | b15;
        this.put(px & 255); this.put(px >> 8);
      }
    }
  }
}

return { defaultScaleTable, MDEC };
})();
const __src_memcard = (() => {
// ============================================================================
//  Memory Card (128 KB = 1024 setores de 128 bytes = 16 blocos de 8 KB)
//   bloco 0 = diretório: frame 0 "MC" | frames 1..15 = entradas dos 15 blocos de dados |
//                        frames 16..35 = lista de setores ruins | 63 = cópia do frame 0
//  Formatos de arquivo aceitos: cru 128KB (.mcr/.mcd/.mc/.bin), VGS (+64 bytes "VgsM"),
//  DexDrive (+3904 bytes "123-456-STD"). Exporta sempre em formato cru (compatível com ePSXe/DuckStation).
// ============================================================================
const CARD_SIZE = 131072, SECTOR = 128, SECTORS = 1024;

const xor127 = (b, o) => { let x = 0; for (let i = 0; i < 127; i++) x ^= b[o + i]; return x; };

class MemoryCard {
  constructor(bytes) {
    this.data = new Uint8Array(CARD_SIZE);
    this.flag = 0x08;                        // bit3 = "diretório ainda não lido" (cartão recém-inserido)
    this.dirty = false;                      // houve gravação desde o último export
    this.onWrite = null;                     // callback(sector) a cada setor gravado
    this.format();
    if (bytes) this.load(bytes);
  }

  /** Cartão em branco, formatado como o hardware/BIOS faz */
  format() {
    const d = this.data; d.fill(0);
    d[0] = 0x4D; d[1] = 0x43; d[127] = xor127(d, 0);                       // frame 0: "MC"
    for (let i = 1; i <= 15; i++) {                                         // entradas livres
      const o = i * SECTOR; d[o] = 0xA0; d[o + 8] = 0xFF; d[o + 9] = 0xFF; d[o + 127] = xor127(d, o);
    }
    for (let i = 16; i <= 35; i++) {                                        // lista de setores ruins (vazia)
      const o = i * SECTOR; d.fill(0xFF, o, o + 4); d[o + 8] = 0xFF; d[o + 9] = 0xFF; d[o + 127] = xor127(d, o);
    }
    d.copyWithin(63 * SECTOR, 0, SECTOR);                                   // frame 63 = cópia do 0
    this.flag = 0x08; this.dirty = true;
  }

  /** Carrega um arquivo de cartão (detecta o formato). Lança erro se inválido. */
  load(bytes) {
    let off = 0;
    const tag = String.fromCharCode(...bytes.subarray(0, 4));
    if (bytes.length === CARD_SIZE + 64 && tag === 'VgsM') off = 64;
    else if (bytes.length === CARD_SIZE + 3904 && String.fromCharCode(...bytes.subarray(0, 11)) === '123-456-STD') off = 3904;
    else if (bytes.length !== CARD_SIZE) throw new Error(`tamanho de cartão inválido: ${bytes.length} bytes (esperado ${CARD_SIZE})`);
    if (bytes[off] !== 0x4D || bytes[off + 1] !== 0x43) throw new Error('cartão sem assinatura "MC" (não formatado?)');
    this.data.set(bytes.subarray(off, off + CARD_SIZE));
    this.flag = 0x08; this.dirty = false;
    return this;
  }

  /** Bytes crus para salvar em disco */
  export() { this.dirty = false; return this.data.slice(); }

  // ---- acesso por setor (usado pelo protocolo) ----
  readSector(n) { return this.data.subarray(n * SECTOR, (n + 1) * SECTOR); }
  writeSector(n, buf) {
    this.data.set(buf.subarray(0, SECTOR), n * SECTOR);
    this.flag &= ~0x08; this.dirty = true; this.onWrite?.(n);
  }

  /** Lista os saves do diretório (para a interface/depuração) */
  listSaves() {
    const d = this.data, out = [];
    const dec = (b) => { try { return new TextDecoder('shift_jis').decode(b).replace(/\0.*$/s, '').trim(); } catch { return ''; } };
    for (let i = 1; i <= 15; i++) {
      const o = i * SECTOR, st = d[o];
      if (st !== 0x51) continue;                                           // 0x51 = primeiro bloco de um save
      const size = (d[o + 4] | (d[o + 5] << 8) | (d[o + 6] << 16)) >>> 0;
      const code = String.fromCharCode(...d.subarray(o + 10, o + 31)).replace(/\0.*$/s, '');
      const blk = i * 8192, hdr = d.subarray(blk, blk + 128);
      out.push({ slot: i, code, blocks: Math.max(1, size / 8192 | 0), title: hdr[0] === 0x53 && hdr[1] === 0x43 ? dec(hdr.subarray(4, 68)) : '',
                 ok: xor127(d, o) === d[o + 127] });
    }
    return out;
  }
  freeBlocks() { let n = 0; for (let i = 1; i <= 15; i++) if (this.data[i * SECTOR] === 0xA0 || this.data[i * SECTOR] === 0xA1 ||
                                                              this.data[i * SECTOR] === 0xA2 || this.data[i * SECTOR] === 0xA3) n++; return n; }
}

return { CARD_SIZE, MemoryCard };
})();
const __src_sio = (() => {
// ============================================================================
//  SIO0 (porta de controles / memory cards)  0x1F801040-0x1F80104F
//   +0 DATA  +4 STAT  +8 MODE  +A CTRL  +E BAUD
//  Emula: controle digital (ID 0x41) na porta 1; porta 2 e memory cards desconectados.
// ============================================================================
const BUTTONS = { select: 0, l3: 1, r3: 2, start: 3, up: 4, right: 5, down: 6, left: 7,
                         l2: 8, r2: 9, l1: 10, r1: 11, triangle: 12, circle: 13, cross: 14, square: 15 };

//  Controles: 'digital' (ID 0x41) ou 'dualshock' (começa digital; o jogo entra em modo de configuração (0x43),
//  liga o modo analógico (0x44) e passa a receber ID 0x73 com os 4 eixos; vibração via mapeamento 0x4D).
const STICKS = { rx: 0, ry: 1, lx: 2, ly: 3 };

class SIO {
  constructor(sys) {
    this.sys = sys; this.padConnected = [true, false]; this.cards = [null, null]; this.buttons = [0xFFFF, 0xFFFF];
    this.padType = ['digital', 'digital'];                                  // configuração (não faz parte do save state)
    this.sticks = [[0x80, 0x80, 0x80, 0x80], [0x80, 0x80, 0x80, 0x80]];     // rx, ry, lx, ly (0..255, centro 0x80)
    this.onRumble = null;                                                   // (porta, pequeno 0/1, grande 0..255)
    this.reset();
  }
  newPad() { return { analog: false, lock: false, config: false, map: [0x00, 0x01, 0xFF, 0xFF, 0xFF, 0xFF], small: 0, large: 0, cmd: 0, n: 0, pend: null }; }
  /** troca o tipo do controle da porta: 'digital' | 'dualshock' */
  setPadType(port, type) { this.padType[port] = type; this.pads[port] = this.newPad(); }
  /** eixo analógico 0..255 (0x80 = centro): 'lx' | 'ly' | 'rx' | 'ry' */
  setStick(name, value, port = 0) { this.sticks[port][STICKS[name]] = Math.max(0, Math.min(255, Math.round(value))); }
  /** botão ANALOG do controle: liga/desliga o modo (se o jogo não o travou) */
  toggleAnalog(port = 0) { const p = this.pads[port]; if (this.padType[port] === 'dualshock' && !p.lock) p.analog = !p.analog; return p.analog; }
  reset() {
    this.pads = [this.newPad(), this.newPad()];
    this.stat = 0x5; this.mode = 0; this.ctrl = 0; this.baud = 0; this.rx = 0xFF; this.rxValid = false;
    this.state = 0; this.dev = null; this.busyEvt = null; this.mc = null;
  }
  /** pressiona/solta um botão (bits em nível baixo = pressionado) */
  setButton(name, pressed, port = 0) {
    const b = 1 << BUTTONS[name]; this.buttons[port] = pressed ? (this.buttons[port] & ~b) : (this.buttons[port] | b);
  }

  read(addr, size) {
    switch (addr & 0xF) {
      case 0: { const v = this.rx; this.rxValid = false; this.stat &= ~2; return v; }
      case 4: return this.stat >>> 0;
      case 8: return this.mode;
      case 0xA: return this.ctrl;
      case 0xE: return this.baud;
    }
    return 0;
  }
  write(addr, size, v) {
    switch (addr & 0xF) {
      case 0: this.tx(v & 0xFF); break;
      case 8: this.mode = v & 0xFFFF; break;
      case 0xA: {
        this.ctrl = v & 0xFFFF;
        if (v & 0x10) this.stat &= ~0x200;                           // ACK: limpa flag de IRQ
        if (v & 0x40) { const c = this.ctrl; this.reset(); this.ctrl = 0; }   // reset
        if (!(v & 2)) { this.state = 0; this.dev = null; this.mc = null; }   // /JOY desmarcado: fim da transação
        break;
      }
      case 0xE: this.baud = v & 0xFFFF; break;
    }
  }

  tx(byte) {
    if (!(this.ctrl & 1)) return;                                    // TXEN desligado
    this.stat &= ~0x5;                                               // TX ocupado
    const factor = [1, 1, 16, 64][this.mode & 3], cyc = Math.max(8 * (this.baud || 0x88) * factor, 200);
    this.sys.sched.call(this.sys.now() + cyc, 'sio', 'txDone', [byte]);
  }
  txDone(byte) {
    const [resp, ack] = this.exchange(byte);
    this.rx = resp; this.rxValid = true; this.stat |= 0x2 | 0x5;
    if (ack) { this.stat |= 0x80; this.sys.sched.call(this.sys.now() + 100, 'sio', 'ackIrq', []); }   // DSR
  }
  ackIrq() {
    this.stat |= 0x200; if (this.ctrl & 0x1000) this.sys.irq(7);
    this.sys.sched.call(this.sys.now() + 60, 'sio', 'dsrOff', []);
  }
  dsrOff() { this.stat &= ~0x80; }

  /** protocolo: devolve [byte de resposta, ack?] */
  exchange(b) {
    const port = (this.ctrl >> 13) & 1;
    if (this.state === 0) {                                          // 1º byte = endereço do dispositivo
      if (b === 0x01 && this.padConnected[port]) { this.dev = 'pad'; this.state = 1; return [0xFF, true]; }
      if (b === 0x81 && this.cards[port]) { this.dev = 'mc'; this.state = 1; this.mc = { k: 1, cmd: 0, msb: 0, lsb: 0, sector: 0, buf: new Uint8Array(128), chk: 0, bad: false }; return [0xFF, true]; }
      this.dev = null; this.state = -1; return [0xFF, false];        // porta vazia / memory card ausente: sem ACK
    }
    if (this.dev === 'pad') return this.exchangePad(b, port);
    if (this.dev === 'mc') return this.exchangeMC(b, this.cards[port]);
    return [0xFF, false];
  }

  /** controle: byte 1 = comando, 2 = 0x5A, depois dados. Devolve [byte, ack] */
  exchangePad(b, port) {
    const pad = this.pads[port], btn = this.buttons[port], s = this.state++;
    const dual = this.padType[port] === 'dualshock';
    if (s === 1) {
      pad.cmd = dual ? b : 0x42; pad.n = 0; pad.pend = null;
      const id = !dual ? 0x41 : pad.config ? 0xF3 : pad.analog ? 0x73 : 0x41;
      pad.len = (id & 0xF) * 2; return [id, true];
    }
    if (s === 2) return [0x5A, true];
    const i = s - 3, last = i === pad.len - 1;
    if (i >= pad.len) return [0xFF, false];
    const sticks = this.sticks[port], withSticks = pad.analog || pad.config;
    let out = 0;
    switch (pad.cmd) {
      case 0x42: case 0x43: {
        out = i === 0 ? btn & 0xFF : i === 1 ? btn >> 8 : (withSticks ? sticks[i - 2] : 0xFF);
        if (pad.cmd === 0x42) {                                       // vibração: mapa 4D define que byte aciona qual motor
          if (pad.map[i] === 0) pad.small = b & 1; else if (pad.map[i] === 1) pad.large = b;
        } else if (i === 0) pad.pend = b === 1;                       // 0x43: 1 entra / 0 sai do modo de configuração
        break;
      }
      case 0x44: out = 0; if (i === 0) pad.pend = b === 1; else if (i === 1) pad.lock = b === 3; break;
      case 0x45: out = [0x01, 0x02, pad.analog ? 1 : 0, 0x02, 0x01, 0x00][i]; break;
      case 0x46: out = (b === 1 ? [0x00, 0x01, 0x01, 0x01, 0x14, 0x00] : [0x00, 0x01, 0x02, 0x00, 0x0A, 0x00])[i]; if (i === 0) pad.sel = b; break;
      case 0x47: out = [0x00, 0x00, 0x02, 0x00, 0x01, 0x00][i]; break;
      case 0x4C: out = [0x00, 0x00, 0x00, 0x04, 0x00, 0x00][i]; break;
      case 0x4D: out = pad.map[i]; if (!pad.pend) pad.pend = []; pad.pend[i] = b; break;
      default: out = 0;
    }
    if (pad.cmd === 0x46 && i > 0) out = ((pad.sel === 1) ? [0x00, 0x01, 0x01, 0x01, 0x14, 0x00] : [0x00, 0x01, 0x02, 0x00, 0x0A, 0x00])[i];
    if (last) this.padEnd(port, pad);
    return [out, !last];
  }
  /** fim da transação: efetiva mudanças de modo/mapa e avisa a vibração */
  padEnd(port, pad) {
    if (pad.cmd === 0x43 && typeof pad.pend === 'boolean') pad.config = pad.pend;
    else if (pad.cmd === 0x44 && typeof pad.pend === 'boolean') pad.analog = pad.pend;
    else if (pad.cmd === 0x4D && Array.isArray(pad.pend)) pad.map = [0, 1, 2, 3, 4, 5].map(k => pad.pend[k] ?? 0xFF);
    pad.pend = null;
    const key = pad.small | (pad.large << 1);
    if (key !== pad.sent) { pad.sent = key; this.onRumble?.(port, pad.small, pad.large); }
  }

  /**
   * Protocolo do Memory Card (byte 0 = 0x81 já tratado). k = índice do byte na transação.
   *  Leitura 'R'(52): FLAG 5A 5D 00 MSB 5C 5D MSB LSB [128 dados] CHK 47
   *  Escrita 'W'(57): FLAG 5A 5D 00 MSB [eco...] CHK 5C 5D END(47 ok | 4E checksum | FF setor ruim)
   *  GetID   'S'(53): FLAG 5A 5D 5C 5D 04 00 00 80
   * Todos os bytes têm ACK, exceto o último da transação.
   */
  exchangeMC(b, card) {
    const m = this.mc, k = m.k++, A = true, END = false;
    if (k === 1) {
      m.cmd = b;
      if (b === 0x52 || b === 0x57 || b === 0x53) return [card.flag, A];
      this.dev = null; this.state = -1; return [0xFF, END];            // comando desconhecido
    }
    if (m.cmd === 0x53) {                                              // GetID
      const r = { 2: 0x5A, 3: 0x5D, 4: 0x5C, 5: 0x5D, 6: 0x04, 7: 0x00, 8: 0x00, 9: 0x80 }[k];
      return r === undefined ? [0xFF, END] : [r, k < 9];
    }
    if (k === 2) return [0x5A, A];
    if (k === 3) return [0x5D, A];
    if (k === 4) { m.msb = b; return [0x00, A]; }
    if (k === 5) { m.lsb = b; m.sector = (m.msb << 8) | m.lsb; m.bad = m.sector >= 1024; return [m.msb, A]; }

    if (m.cmd === 0x52) {                                              // ---- leitura ----
      if (k === 6) return [0x5C, A];
      if (k === 7) return [0x5D, A];
      if (k === 8) return [m.bad ? 0xFF : m.msb, A];
      if (k === 9) return [m.bad ? 0xFF : m.lsb, !m.bad];             // setor inválido: encerra sem dados
      if (m.bad) return [0xFF, END];
      if (k === 10) { m.buf.set(card.readSector(m.sector)); m.chk = m.msb ^ m.lsb; }
      if (k >= 10 && k < 138) { const v = m.buf[k - 10]; m.chk ^= v; return [v, A]; }
      if (k === 138) return [m.chk, A];
      if (k === 139) return [0x47, END];
      return [0xFF, END];
    }
    // ---- escrita ----
    if (k >= 6 && k < 134) { const i = k - 6; m.buf[i] = b; return [i === 0 ? m.lsb : m.buf[i - 1], A]; }
    if (k === 134) { m.chk = b; return [m.buf[127], A]; }
    if (k === 135) return [0x5C, A];
    if (k === 136) return [0x5D, A];
    if (k === 137) {
      let want = m.msb ^ m.lsb; for (let i = 0; i < 128; i++) want ^= m.buf[i];
      let end = 0x47;
      if (m.bad) end = 0xFF; else if (want !== m.chk) end = 0x4E; else card.writeSector(m.sector, m.buf);
      return [end, END];
    }
    return [0xFF, END];
  }
}

return { BUTTONS, STICKS, SIO };
})();
const __src_cdrom = (() => {
// ============================================================================
//  Controlador de CD-ROM  0x1F801800-0x1F801803  (4 registradores com "index" 0..3)
//   0x1800 R: status   W: index
//   0x1801 R: resposta W: comando(idx0)
//   0x1802 R: dados    W: parâmetro(idx0) / enable de INT(idx1)
//   0x1803 R: enable(idx0,2) / flags(idx1,3)   W: request(idx0) / ack(idx1)
//  INT1 dado pronto | INT2 completo | INT3 ack | INT4 fim de dados | INT5 erro  -> IRQ2
//  Inclui decodificação XA-ADPCM (4 bits) enviada ao mixer do SPU.
// ============================================================================
const { lbaToMsf, msfToLba } = __src_disc;
const bcd = v => ((v / 10 | 0) << 4) | (v % 10);
const CMD_DELAY = 25000;                    // ciclos até a 1ª resposta
// medidos no console real (ps1-tests/cdrom/timing; média de 'Remaining Sectors' em ciclos) — ~0,7% mais rápido que 33868800/75
const SECTOR_1X = 448342, SECTOR_2X = 223825;
const XA_POS = [0, 60, 115, 98], XA_NEG = [0, 0, -52, -55];
const sat16 = v => v > 32767 ? 32767 : v < -32768 ? -32768 : v;

class CDROM {
  constructor(sys) { this.sys = sys; this.disc = null; this.spu = null; this.regionOverride = 'SCEA'; this.log = null; this.reset(); }

  reset() {
    this.index = 0; this.param = []; this.resp = []; this.intEnable = 0; this.intFlag = 0; this.queue = [];
    this.mode = 0; this.busy = false; this.reading = false; this.seeking = false; this.playing = false;
    this.pos = 0; this.seekLba = 0; this.hasSetloc = false; this.filterFile = 0; this.filterChan = 0;
    this.data = null; this.dpos = 0; this.sector = null; this.readEvt = null; this.lastHdr = new Uint8Array(8);
    this.xaOld = [[0, 0], [0, 0]]; this.xaPhase = 0; this.motor = !!this.disc; this.sectorsRead = 0;
    this.muted = false; this.lid = false; this.shellFlag = false; this.playCount = 0; this.reportAlt = 0; this.peak = 0;
  }
  setDisc(d) { this.disc = d; this.motor = !!d; }

  // ---------------- tampa / troca de disco ----------------
  /** abre a tampa: para tudo; Getstat passa a mostrar "shell open" (bit 4) */
  openLid() { this.stopRead(); this.lid = true; this.motor = false; }
  /** fecha a tampa com outro disco (ou nenhum); o 1º Getstat depois reporta o bit 4 uma vez, como o hardware */
  closeLid(disc) { this.disc = disc || null; this.lid = false; this.shellFlag = true; this.motor = !!disc; this.hasSetloc = false; this.pos = 0; }

  // ---------------- trilhas / TOC ----------------
  tocTracks() { return (this.disc && this.disc.tracks) || [{ n: 1, type: 'data', start: 0 }]; }
  trackAt(lba) { const t = this.tocTracks(); for (let i = t.length - 1; i >= 0; i--) if (lba >= (t[i].pre ?? t[i].start)) return t[i]; return t[0]; }
  total() { return this.disc ? this.disc.sectorCount : 0; }

  stat() {
    let s = 0;
    if (!this.disc || this.lid || this.shellFlag) s |= 0x10; if (this.disc && this.motor) s |= 0x02;
    if (this.reading) s |= 0x20; if (this.seeking) s |= 0x40; if (this.playing) s |= 0x80;
    return s;
  }

  // ---------------- registradores ----------------
  read(addr, size) {
    switch (addr & 3) {
      case 0: return this.index | ((this.data && this.dpos < this.data.length) ? 0x40 : 0) | (this.param.length === 0 ? 0x08 : 0) |
                     (this.param.length < 16 ? 0x10 : 0) | (this.resp.length ? 0x20 : 0) | (this.busy ? 0x80 : 0);
      case 1: return this.resp.length ? this.resp.shift() : 0;
      case 2: { let v = 0; for (let i = 0; i < size; i++) v |= this.readData() << (8 * i); return v >>> 0; }
      case 3: return ((this.index & 1) ? this.intFlag : this.intEnable) | 0xE0;
    }
  }
  write(addr, size, v) {
    v &= 0xFF;
    switch (addr & 3) {
      case 0: this.index = v & 3; return;
      case 1: if (this.index === 0) this.command(v); return;
      case 2:
        if (this.index === 0) { if (this.param.length < 16) this.param.push(v); }
        else if (this.index === 1) { this.intEnable = v & 0x1F; if (this.intFlag & this.intEnable) this.sys.irq(2); }
        return;
      case 3:
        if (this.index === 0) { if (v & 0x80) { if (this.sector && !(this.data && this.dpos < this.data.length)) { this.data = this.sector; this.dpos = 0; } } else this.data = null; }
        else if (this.index === 1) this.ack(v);
        return;
    }
  }

  readData() {
    if (!this.data || this.dpos >= this.data.length) return 0;
    const b = this.data[this.dpos++]; if (this.dpos >= this.data.length) this.data = null; return b;
  }
  dmaRead(words) {
    const o = new Uint32Array(words);
    for (let i = 0; i < words; i++) o[i] = (this.readData() | (this.readData() << 8) | (this.readData() << 16) | (this.readData() << 24)) >>> 0;
    return o;
  }

  // ---------------- interrupções ----------------
  respond(type, resp, delay, clearBusy) {
    this.sys.sched.call(this.sys.now() + delay, 'cdrom', 'fire', [type, resp, !!clearBusy]);
  }
  /** resposta atrasada: `resp` é um vetor de bytes fixo ou uma especificação ['S', ...extras] / ['GS'] / ['PARAM'] / ['LOCL'] / ['MON'] / ['MOFF'] / ['SEEK'] resolvida na entrega */
  fire(type, resp, clearBusy) { if (clearBusy) this.busy = false; this.deliver(type, this.mkResp(resp)); }
  mkResp(r) {
    if (typeof r[0] === 'number' || r.length === 0) return r;
    switch (r[0]) {
      case 'S': return [this.stat(), ...r.slice(1)];
      case 'GS': { const st = this.stat(); this.shellFlag = false; return [st]; }
      case 'PARAM': return [this.stat(), this.mode, 0, this.filterFile, this.filterChan];
      case 'LOCL': return [...this.lastHdr];
      case 'MON': this.motor = !!this.disc; return [this.stat()];
      case 'MOFF': this.motor = false; return [this.stat()];
      case 'SEEK': if (this.hasSetloc) { this.pos = this.seekLba; this.hasSetloc = false; } return [this.stat()];
    }
    throw new Error('resposta CD desconhecida ' + r[0]);
  }
  deliver(type, resp) {
    if (this.intFlag !== 0) { this.queue.push({ type, resp }); return; }
    this.intFlag = type; this.resp = resp.slice();
    this.log?.(`INT${type} [${resp.map(b => b.toString(16)).join(' ')}]`);
    if (this.intEnable & type) this.sys.irq(2);
  }
  ack(v) {
    this.intFlag &= ~(v & 0x1F);
    if (v & 0x40) this.param.length = 0;
    if (this.intFlag === 0 && this.queue.length) {
      const q = this.queue.shift(); this.sys.sched.call(this.sys.now() + 500, 'cdrom', 'deliver', [q.type, q.resp]);
    }
  }

  // ---------------- comandos ----------------
  command(c) {
    const p = this.param; this.param = []; this.busy = true; this.resp = [];
    this.log?.(`CMD ${c.toString(16)} (${p.map(b => b.toString(16)).join(' ')})`);
    const first = (resp, d = CMD_DELAY) => this.respond(3, resp, d, true);
    const second = (resp, d) => this.respond(2, resp, d, false);
    const err = (code, d = CMD_DELAY) => this.respond(5, [this.stat() | 1, code], d, true);

    switch (c) {
      case 0x01: first(['GS']); break;   // Getstat
      case 0x02:                                                                       // Setloc
        if (p.length < 3) return err(0x20);
        this.seekLba = msfToLba(p[0], p[1], p[2]); this.hasSetloc = true; first(['S']); break;
      case 0x06: case 0x1B: {                                                          // ReadN / ReadS
        if (!this.disc) return err(0x80);
        this.stopRead(); this.reading = true; this.seeking = false;
        let delay = 0;
        if (this.hasSetloc) { this.pos = this.seekLba; this.hasSetloc = false; delay = (this.mode & 0x80) ? 667000 : 362000; }   // 1º setor medido no console: ~784k (1x) / ~865k (2x)
        first(['S']);
        this.readEvt = this.sys.sched.call(this.sys.now() + delay + this.interval(), 'cdrom', 'readSector');
        break;
      }
      case 0x07: first(['S']); second(['MON'], 100000); break;   // MotorOn
      case 0x08: { first(['S']); this.stopRead(); second(['MOFF'], 200000); break; }  // Stop
      case 0x09: { const s = this.stat(), was = this.reading || this.playing; this.stopRead(); first([s]); second(['S'], was ? ((this.mode & 0x80) ? 1062000 : 1038000) : 150000); break; }  // Pause (lendo: ~1,0M ciclos no console)
      case 0x0A: {                                                                      // Init
        this.stopRead(); this.mode = 0; this.hasSetloc = false;
        first(['S']); second(['MON'], 502000); break;                                 // Init completo: ~476k em média no console
      }
      case 0x0B: this.muted = true; first(['S']); break;                  // Mute
      case 0x0C: this.muted = false; first(['S']); break;                 // Demute
      case 0x0D: this.filterFile = p[0] | 0; this.filterChan = p[1] | 0; first(['S']); break;   // Setfilter
      case 0x0E: this.mode = p[0] | 0; first(['S']); break;               // Setmode
      case 0x0F: first(['PARAM']); break;           // Getparam
      case 0x10: first(['LOCL']); break;                                 // GetlocL
      case 0x11: {                                                                      // GetlocP
        const lba = Math.max(0, this.pos - (this.playing ? 0 : 1)), t = this.trackAt(lba), a = lbaToMsf(lba);
        const idx = lba >= t.start ? 1 : 0, rel = idx ? lba - t.start : t.start - lba;
        first([bcd(t.n), idx, bcd(rel / 4500 | 0), bcd((rel / 75 | 0) % 60), bcd(rel % 75), a.m, a.s, a.f]); break;
      }
      case 0x13: { const tr = this.tocTracks(); first(['S', bcd(tr[0].n), bcd(tr[tr.length - 1].n)]); break; }   // GetTN
      case 0x14: {                                                                      // GetTD
        const t = (p[0] >> 4) * 10 + (p[0] & 15), tr = this.tocTracks();
        if (t === 0) { const m = lbaToMsf(this.total()); first(['S', m.m, m.s]); }
        else { const e = tr.find(x => x.n === t); if (e) { const m = lbaToMsf(e.start); first(['S', m.m, m.s]); } else err(0x10); }
        break;
      }
      case 0x15: case 0x16: {                                                           // SeekL / SeekP
        first(['S']); second(['SEEK'], 100000); break;
      }
      case 0x19:                                                                        // Test
        if (p[0] === 0x20) first([0x94, 0x09, 0x19, 0xC0]); else first(['S']); break;
      case 0x1A:                                                                        // GetID
        first(['S']);
        if (!this.disc) this.respond(5, [0x08, 0x40, 0, 0, 0, 0, 0, 0], 50000, false);
        else {
          const reg = this.regionOverride || this.disc.region(), L = reg.charCodeAt(3) || 0x41;
          this.respond(2, ['S', 0x00, 0x20, 0x00, 0x53, 0x43, 0x45, L], 50000, false);
        }
        break;
      case 0x12: case 0x1E: case 0x1C: first(['S']); second(['S'], 400000); break;   // SetSession / ReadTOC / Reset
      case 0x03: {                                                                      // Play (CD-DA)
        if (!this.disc) return err(0x80);
        this.stopRead();
        const t = p.length && p[0] ? this.tocTracks().find(x => x.n === ((p[0] >> 4) * 10 + (p[0] & 15))) : null;
        let delay = 0;
        if (t) { this.pos = t.start; this.hasSetloc = false; delay = 100000; }
        else if (this.hasSetloc) { this.pos = this.seekLba; this.hasSetloc = false; delay = 100000; }
        this.playing = true; this.playCount = 0; this.reportAlt = 0;
        first(['S']);
        this.readEvt = this.sys.sched.call(this.sys.now() + delay + this.interval(), 'cdrom', 'playSector');
        break;
      }
      case 0x04: case 0x05: first(['S']); break;                          // Forward/Backward (busca rápida: ignorada)
      default: err(0x40);                                                               // comando inválido
    }
  }

  interval() { return (this.mode & 0x80) ? SECTOR_2X : SECTOR_1X; }
  stopRead() { this.reading = false; this.seeking = false; this.playing = false; if (this.readEvt) { this.sys.sched.cancel(this.readEvt); this.readEvt = null; } }

  readSector() {
    this.readEvt = null; if (!this.reading || !this.disc) return;
    // hardware: não avança p/ o próximo setor enquanto houver interrupção pendente (evita sobrescrever o buffer)
    if (this.intFlag !== 0 || this.queue.length) { this.readEvt = this.sys.sched.call(this.sys.now() + 1500, 'cdrom', 'readSector'); return; }
    const lba = this.pos, sec = this.disc.readSector(lba);
    if (!sec) { this.reading = false; this.deliver(4, [this.stat()]); return; }
    const raw = this.disc.raw, info = raw ? this.disc.sectorInfo(lba) : null;
    this.lastHdr = raw ? sec.slice(12, 20) : Uint8Array.from([...Object.values(lbaToMsf(lba)), 1, 0, 0, 0, 0]);
    this.sectorsRead++;
    if (info && (this.mode & 0x40) && info.audio && info.form2) {                     // XA-ADPCM: toca em vez de entregar
      if (!(this.mode & 0x08) || (info.file === this.filterFile && info.channel === this.filterChan)) this.decodeXA(sec, info.coding);
    } else {
      this.sector = raw ? ((this.mode & 0x20) ? sec.slice(12, 12 + 0x924) : sec.slice(24, 24 + 0x800)) : sec.slice(0);
      this.deliver(1, [this.stat()]);
    }
    this.pos++;
    this.readEvt = this.sys.sched.call(this.sys.now() + this.interval(), 'cdrom', 'readSector');
  }

  // ---------------- CD-DA ----------------
  playSector() {
    this.readEvt = null; if (!this.playing || !this.disc) return;
    const lba = this.pos;
    if (lba >= this.total()) { this.playing = false; this.deliver(4, [this.stat()]); return; }
    const t = this.trackAt(lba), sec = this.disc.readSector(lba);
    let pk = 0;
    if (t.type === 'audio' && sec && sec.length >= 2352) {
      for (let i = 0; i < 588; i++) {
        const o = i * 4, l = (sec[o] | (sec[o + 1] << 8)) << 16 >> 16, r = (sec[o + 2] | (sec[o + 3] << 8)) << 16 >> 16;
        if (!this.muted && this.spu) this.spu.pushCd(l, r);
        const a = l < 0 ? -l : l, b = r < 0 ? -r : r; if (a > pk) pk = a; if (b > pk) pk = b;
      }
    }
    // relatório (mode bit 2): a cada 10 setores alterna tempo relativo/absoluto
    if ((this.mode & 0x04) && (this.playCount++ % 10) === 0 && this.intFlag === 0 && !this.queue.length) {
      const a = lbaToMsf(lba), idx = lba >= t.start ? 1 : 0, rel = idx ? lba - t.start : t.start - lba;
      this.reportAlt ^= 1;
      const mm = this.reportAlt ? bcd(rel / 4500 | 0) : a.m, ss = this.reportAlt ? (bcd((rel / 75 | 0) % 60) | 0x80) : a.s, ff = this.reportAlt ? bcd(rel % 75) : a.f;
      this.deliver(1, [this.stat(), bcd(t.n), idx, mm, ss, ff, pk & 0xFF, pk >> 8]);
    }
    this.pos++;
    if (((this.mode & 0x02) && this.pos >= t.end) || this.pos >= this.total()) {       // AutoPause / fim do disco
      this.playing = false; this.deliver(4, [this.stat()]); return;
    }
    this.readEvt = this.sys.sched.call(this.sys.now() + this.interval(), 'cdrom', 'playSector');
  }

  // ---------------- XA-ADPCM ----------------
  decodeXA(sec, coding) {
    if (!this.spu || (coding & 0x10)) return;                                          // 8 bits: TODO
    const stereo = !!(coding & 1), ratio = ((coding & 4) ? 18900 : 37800) / 44100;
    const L = [], R = [];
    for (let g = 0; g < 18; g++) {
      const base = 24 + g * 128, units = [];
      for (let i = 0; i < 8; i++) {
        const hdr = sec[base + (i < 4 ? i : i + 4)], range = hdr & 15, filt = (hdr >> 4) & 3, shift = range > 12 ? 9 : range;
        const old = this.xaOld[stereo ? (i & 1) : 0], out = new Int16Array(28);
        for (let w = 0; w < 28; w++) {
          const byte = sec[base + 16 + w * 4 + (i >> 1)], nib = (i & 1) ? byte >> 4 : byte & 15;
          let s = (((nib << 12) << 16) >> 16) >> shift;
          s = sat16(s + ((old[0] * XA_POS[filt] + old[1] * XA_NEG[filt] + 32) >> 6));
          old[1] = old[0]; old[0] = s; out[w] = s;
        }
        units.push(out);
      }
      if (stereo) for (let q = 0; q < 4; q++) for (let k = 0; k < 28; k++) { L.push(units[2 * q][k]); R.push(units[2 * q + 1][k]); }
      else for (let i = 0; i < 8; i++) for (let k = 0; k < 28; k++) { L.push(units[i][k]); R.push(units[i][k]); }
    }
    const n = L.length; let t = this.xaPhase;                                           // reamostra p/ 44.1kHz (linear)
    while (t < n - 1) {
      const i = t | 0, f = t - i;
      if (!this.muted) this.spu.pushCd((L[i] + (L[i + 1] - L[i]) * f) | 0, (R[i] + (R[i + 1] - R[i]) * f) | 0);
      t += ratio;
    }
    this.xaPhase = t - (n - 1);
  }
}

return { CDROM };
})();
const __src_state = (() => {
// ============================================================================
//  Save states: serialização genérica do estado do PSX
//   Container: "PS1S" | versão u32 | tamanho do cabeçalho u32 | cabeçalho JSON | blobs binários
//   Os arrays tipados (RAM, VRAM, RAM do SPU...) vão no blob sem os zeros finais; o resto, em JSON.
//   Não entram: disco, BIOS, entradas (botões), memory cards (têm persistência própria), caches do JIT
//   e do renderizador (reconstruídos ao restaurar), áudio já gerado.
// ============================================================================
const STATE_VERSION = 1;
const MAGIC = 0x53315350;                                  // "PS1S" (little endian)
const TYPES = { Int8Array, Uint8Array, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array };

// propriedades que nunca são salvas (referências cruzadas, callbacks, configuração, entradas)
const SKIP = new Set(['sys', 'bus', 'dev', 'disc', 'spu', 'gpu', 'dma', 'timers', 'sio', 'cdrom', 'mdec', 'hw', 'log', 'logIo', 'ioStats', 'unmapped',
  'cards', 'buttons', 'padConnected', 'padType', 'sticks', 'onRumble', 'clock', 'regionOverride', 'bios', 'biosView', 'codeFlags', 'jit', 'deint']);
const COMPONENTS = ['cpu', 'bus', 'gpu', 'spu', 'dma', 'timers', 'sio', 'cdrom', 'mdec'];
const PSX_FIELDS = ['audioLen', 'lastTick', 'timerAt', 'nextTick', 'lineAcc', 'line', 'audioAcc', 'frameDone', 'frames', 'useJit'];

class Writer { constructor() { this.bufs = []; this.size = 0; }
  add(u8) { let n = u8.length; while (n > 0 && u8[n - 1] === 0) n--; const off = this.size; this.bufs.push(u8.subarray(0, n)); this.size += n; return [off, n]; } }

function enc(v, w, depth = 0) {
  if (depth > 12) throw new Error('estrutura profunda demais no save state');
  if (v === null || typeof v === 'boolean' || typeof v === 'string') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : { $n: String(v) };
  if (v === undefined) return { $u: 1 };
  if (typeof v === 'function' || v instanceof Map || v instanceof DataView) return undefined;
  if (ArrayBuffer.isView(v)) {
    const name = v.constructor.name; if (!TYPES[name]) throw new Error('tipo não suportado: ' + name);
    const [off, n] = w.add(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
    return { $a: name, len: v.length, off, n };
  }
  if (Array.isArray(v)) return v.map(x => { const e = enc(x, w, depth + 1); return e === undefined ? null : e; });
  const o = {};
  for (const k of Object.keys(v)) { if (SKIP.has(k)) continue; const e = enc(v[k], w, depth + 1); if (e !== undefined) o[k] = e; }
  return o;
}
const isTyped = d => d && typeof d === 'object' && d.$a !== undefined;
function dec(d, blob) {
  if (d === null || typeof d !== 'object') return d;
  if (d.$n !== undefined) return Number(d.$n);
  if (d.$u) return undefined;
  if (isTyped(d)) { const T = TYPES[d.$a], a = new T(d.len); new Uint8Array(a.buffer).set(blob.subarray(d.off, d.off + d.n)); return a; }
  if (Array.isArray(d)) return d.map(x => dec(x, blob));
  const o = {}; for (const k of Object.keys(d)) o[k] = dec(d[k], blob); return o;
}
/** grava `d` em `target[key]` preservando arrays tipados, instâncias (Voice, GTE...) e protótipos */
function put(target, key, d, blob) {
  const cur = target[key];
  if (isTyped(d) && ArrayBuffer.isView(cur) && cur.constructor.name === d.$a && cur.length === d.len) {
    const u = new Uint8Array(cur.buffer, cur.byteOffset, cur.byteLength); u.fill(0); u.set(blob.subarray(d.off, d.off + d.n)); return;
  }
  if (Array.isArray(d) && Array.isArray(cur) && cur.length === d.length && d.every(x => x && typeof x === 'object' && !Array.isArray(x) && !isTyped(x) && x.$n === undefined && !x.$u)) {
    d.forEach((x, i) => apply(cur[i], x, blob)); return;
  }
  if (d && typeof d === 'object' && !Array.isArray(d) && !isTyped(d) && d.$n === undefined && !d.$u && cur && typeof cur === 'object' && !Array.isArray(cur) && !ArrayBuffer.isView(cur)) {
    apply(cur, d, blob); return;
  }
  target[key] = dec(d, blob);
}
function apply(target, data, blob) { for (const k of Object.keys(data)) { if (!SKIP.has(k)) put(target, k, data[k], blob); } }

/** Snapshot de um PSX → Uint8Array */
function saveState(psx, meta = {}) {
  const w = new Writer(), st = {};
  for (const c of COMPONENTS) st[c] = enc(c === 'bus' ? pick(psx.bus, ['ram', 'scratch', 'io', 'istat', 'imask', 'cacheCtrl', 'gpuToggle']) : psx[c], w);
  st.psx = enc(pick(psx, PSX_FIELDS), w);
  st.sched = psx.sched.snapshot();
  const head = new TextEncoder().encode(JSON.stringify({ version: STATE_VERSION, meta: { ...meta, savedAt: Date.now(), frames: psx.frames, cycles: psx.cpu.cycles }, st }));
  const out = new Uint8Array(12 + head.length + w.size), dv = new DataView(out.buffer);
  dv.setUint32(0, MAGIC, true); dv.setUint32(4, STATE_VERSION, true); dv.setUint32(8, head.length, true);
  out.set(head, 12); let o = 12 + head.length; for (const b of w.bufs) { out.set(b, o); o += b.length; }
  return out;
}
function pick(o, keys) { const r = {}; for (const k of keys) r[k] = o[k]; return r; }

/** lê só o cabeçalho (meta) sem restaurar */
function readStateMeta(bytes) { return parse(bytes).head.meta; }
function parse(bytes) {
  if (bytes.length < 12) throw new Error('arquivo de save state inválido');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(0, true) !== MAGIC) throw new Error('não é um save state do ps1emu');
  const ver = dv.getUint32(4, true); if (ver !== STATE_VERSION) throw new Error(`versão de save state incompatível (${ver}, esperada ${STATE_VERSION})`);
  const hl = dv.getUint32(8, true);
  if (12 + hl > bytes.length) throw new Error('save state truncado');
  return { head: JSON.parse(new TextDecoder().decode(bytes.subarray(12, 12 + hl))), blob: bytes.subarray(12 + hl) };
}

/** Restaura um snapshot no PSX (o mesmo disco/BIOS devem estar carregados). Devolve o meta. */
function loadState(psx, bytes) {
  const { head, blob } = parse(bytes), st = head.st;
  for (const c of COMPONENTS) apply(psx[c], st[c], blob);
  apply(psx, st.psx, blob);
  if (!Number.isFinite(psx.timerAt)) psx.timerAt = psx.lastTick;           // estados antigos não tinham timerAt
  psx.sched.restore(st.sched);
  const cd = psx.cdrom;
  cd.readEvt = psx.sched.find('cdrom', 'readSector') || psx.sched.find('cdrom', 'playSector');
  if (cd.data && cd.data.length === 0) cd.data = null;
  psx.jit.flush(); psx.bus.codeFlags.fill(0);
  psx.audioLen = 0;
  if (psx.gpu.hw) psx.gpu.hw.attach(psx.gpu);               // renderizador GL: reenvia a VRAM restaurada
  return head.meta;
}

// ---- compressão (CompressionStream: navegadores modernos e Node ≥ 18) ----
async function pipe(u8, stream) { return new Uint8Array(await new Response(new Blob([u8]).stream().pipeThrough(stream)).arrayBuffer()); }
const gzip = u8 => pipe(u8, new CompressionStream('gzip'));
const gunzip = u8 => pipe(u8, new DecompressionStream('gzip'));
const isGzip = u8 => u8.length > 2 && u8[0] === 0x1F && u8[1] === 0x8B;

return { STATE_VERSION, saveState, readStateMeta, loadState, gzip, gunzip, isGzip };
})();
const __src_psx = (() => {
// ============================================================================
//  Máquina PS1: Bus + CPU + GPU + SPU + DMA + Timers + SIO0 (controle/memory card) + CD-ROM + MDEC
//  Relógio central = cpu.cycles (1 ciclo por instrução). A cada 32 ciclos roda tick():
//  timers, scanlines/VBLANK, eventos agendados (CD-ROM, SIO, DMA) e geração de áudio.
// ============================================================================
const { Bus } = __src_bus;
const { CPU } = __src_cpu;
const { JIT } = __src_jit;
const { enableWasm, wasmAvailable } = __src_wasmcpu;
const { GPU } = __src_gpu;
const { SPU } = __src_spu;
const { DiscImage } = __src_disc;
const { Scheduler } = __src_scheduler;
const { Timers } = __src_timers;
const { DMA } = __src_dma;
const { SIO } = __src_sio;
const { CDROM } = __src_cdrom;
const { MemoryCard } = __src_memcard;
const { MDEC } = __src_mdec;
const { saveState, loadState } = __src_state;
const TICK = 32, TICK_MAX = +(globalThis.PS1_TICKMAX || (typeof process !== "undefined" && process.env && process.env.PS1_TICKMAX)) || 2000, SPU_PERIOD = 768;   // tick adaptativo: curto só quando algo está para acontecer (evento, borda de linha)
           // 33.8688MHz / 44100Hz = 768
const REGIONS = { A: 'SCEA', E: 'SCEE', J: 'SCEI' };

class PSX {
  constructor() {
    this.bus = new Bus();
    this.cpu = new CPU(this.bus);
    this.jit = new JIT(this.cpu, this.bus); this.jit.H.ps = this; this.useJit = true;      // recompilador dinâmico (desligue com psx.useJit = false)
    this.gpu = new GPU();
    this.spu = new SPU();
    this.sched = new Scheduler();
    this.sys = { bus: this.bus, sched: this.sched, now: () => this.cpu.cycles, irq: n => this.bus.raiseIrq(n), syncTimers: () => this.syncTimers(), retime: () => this.retime() };
    this.sched.onEarly = t => { if (t < this.nextTick) this.nextTick = t; };
    this.timers = new Timers(this.sys);
    this.dma = new DMA(this.sys);
    this.sio = new SIO(this.sys);
    this.cdrom = new CDROM(this.sys);
    this.mdec = new MDEC();
    this.dma.dev = { gpu: this.gpu, spu: this.spu, cdrom: this.cdrom, mdec: this.mdec };
    this.mdec.onOutput = () => this.dma.mdecOutReady();
    this.cdrom.spu = this.spu; this.gpu.clock = () => this.cpu.cycles; this.bus.psx = this;
    for (const [k, o] of [['cdrom', this.cdrom], ['dma', this.dma], ['sio', this.sio]]) this.sched.register(k, o);
    Object.assign(this.bus, { gpu: this.gpu, spu: this.spu, dma: this.dma, timers: this.timers, sio: this.sio, cdrom: this.cdrom, mdec: this.mdec });
    this.spu.onIrq = () => this.bus.raiseIrq(9);
    this.gpu.onIrq = () => this.bus.raiseIrq(1);

    this.disc = null;
    this.onTTY = null; this.onTrace = null; this.hookTTY = true; this.postCodes = [];
    this.bus.onPost = c => this.postCodes.push(c);
    this.audio = new Int16Array(16384 * 2); this.audioLen = 0;
    this.resetTiming();
    if ((globalThis.PS1_WASM || (typeof process !== "undefined" && process.env && process.env.PS1_WASM)) && wasmAvailable()) this.enableWasm();
  }

  /** troca a CPU pelo núcleo WebAssembly (wasm/cpu.c); true se ativou */
  enableWasm() { try { enableWasm(this); return true; } catch (e) { return false; } }

  resetTiming() {
    this.lastTick = this.timerAt = this.cpu.cycles; this.nextTick = this.cpu.cycles + TICK;
    this.lineAcc = 0; this.line = 0; this.audioAcc = 0; this.frameDone = false; this.frames = 0;
  }

  loadBios(bytes) {
    this.bus.loadBios(bytes);
    const info = this.biosInfo();
    this.cdrom.regionOverride = REGIONS[info.trim().slice(-1)] || 'SCEA';   // GetID devolve a região da BIOS (pula a trava regional)
    return info;
  }
  // versão da BIOS: texto em 0x7FF32
  biosInfo() {
    const b = this.bus.bios; let s = '';
    for (let i = 0x7FF32; i < 0x7FF60 && b[i]; i++) s += String.fromCharCode(b[i]);
    return s;
  }
  /** Insere um cartão (bytes de .mcr/.mcd/VGS/DexDrive) no slot 0 ou 1; sem bytes, cria um cartão em branco. */
  loadMemoryCard(slot, bytes) {
    const card = new MemoryCard(bytes); this.sio.cards[slot] = card;
    return { slot, saves: card.listSaves(), livres: card.freeBlocks() };
  }
  ejectMemoryCard(slot) { this.sio.cards[slot] = null; }

  loadDisc(bytes) { this.disc = new DiscImage(bytes); this.cdrom.setDisc(this.disc); return this.disc.info(); }

  /** carrega .cue + arquivos de trilha ({ 'nome.bin': Uint8Array, ... }) */
  loadCue(cueText, files) { this.disc = DiscImage.fromCue(cueText, files); this.cdrom.setDisc(this.disc); return this.disc.info(); }
  /** troca de disco em execução: abre a tampa; fechar com closeDiscLid(disc) */
  openDiscLid() { this.cdrom.openLid(); }
  closeDiscLid(disc) { this.disc = disc; this.cdrom.closeLid(disc); }

  reset() {
    this.cpu.reset(); this.gpu.reset(); this.timers.reset(); this.dma.reset(); this.sio.reset(); this.cdrom.reset(); this.mdec.reset();
    this.cdrom.setDisc(this.disc); this.jit.flush(); this.sched.clear(); this.bus.istat = 0; this.bus.imask = 0;
    this.postCodes.length = 0; this.audioLen = 0; this.resetTiming();
  }

  // ---------------- save states ----------------
  /** estado completo (Uint8Array); chamar entre quadros/instruções, nunca dentro de um bloco do JIT */
  saveState(meta = {}) { return saveState(this, { disc: this.disc ? this.disc.info().volume || '' : '', ...meta }); }
  loadState(bytes) { return loadState(this, bytes); }

  // ---------------- TTY da BIOS (A0/B0: putchar/puts) ----------------
  tty() {
    const cpu = this.cpu, r = cpu.r, pc = cpu.pc & 0x1FFFFFFF;
    if (pc !== 0xA0 && pc !== 0xB0) return;
    const fn = r[9];
    if ((pc === 0xA0 && fn === 0x3C) || (pc === 0xB0 && fn === 0x3D)) this.onTTY?.(String.fromCharCode(r[4] & 0xFF));
    else if ((pc === 0xA0 && fn === 0x3E) || (pc === 0xB0 && fn === 0x3F)) {
      let a = r[4], s = '';
      for (let i = 0; i < 1024; i++) { const c = this.bus.read8(a++); if (!c) break; s += String.fromCharCode(c); }
      this.onTTY?.(s);
    }
  }

  /** liga/desliga o atalho para laços de espera (leitura repetida de status/contador); desligado por padrão */
  get pollSkip() { return this.bus.pollOn; }
  set pollSkip(v) { this.bus.pollOn = !!v; }

  // ---------------- tempo ----------------
  tick() {
    const now = this.cpu.cycles, dt = now - this.lastTick; this.lastTick = now;
    const gpu = this.gpu;
    this.timers.dotDiv = gpu.dotDiv;
    {   // blank horizontal/vertical (início do tick): fora da faixa ativa [hx1, hx2] da linha = hblank; linhas >= vb = vblank
      const k = (gpu.pal ? 2157.2 / 3406 : 2146.3 / 3413), x = this.lineAcc;
      this.timers.setBlank(x < gpu.hx1 * k || x >= gpu.hx2 * k, this.line >= (gpu.pal ? 256 : 240));
    }
    this.timers.advance(now - this.timerAt); this.timerAt = now;

    // linhas de vídeo: NTSC 263 x ~2146 ciclos, PAL 314 x ~2157
    const lc = gpu.pal ? 2157.2 : 2146.3, lines = gpu.pal ? 314 : 263, vb = gpu.pal ? 256 : 240;
    this.lineAcc += dt;
    while (this.lineAcc >= lc) {
      this.lineAcc -= lc; this.line++; gpu.line = this.line; this.timers.hblank();
      if (this.line === vb) { gpu.vblank = true; gpu.toggleField(); this.bus.raiseIrq(0); }   // o campo entrelaçado muda no início do vblank (os desenhos do jogo depois do IRQ vão todos para o mesmo campo)          // IRQ0 = VBLANK
      if (this.line >= lines) { this.line = 0; gpu.line = 0; gpu.vblank = false; gpu.captureField(); this.frameDone = true; this.frames++; }
    }

    this.sched.run(now);

    this.audioAcc += dt;                                                           // 1 amostra a cada 768 ciclos
    while (this.audioAcc >= SPU_PERIOD) {
      this.audioAcc -= SPU_PERIOD; const [l, r] = this.spu.tick();
      if (this.audioLen < 16384) { this.audio[this.audioLen * 2] = l; this.audio[this.audioLen * 2 + 1] = r; this.audioLen++; }
    }
    // próximo tick: no máximo TICK_MAX ciclos, antes se houver evento agendado ou fim de linha de vídeo
    let nt = now + TICK_MAX; const ev = this.sched.next; if (ev < nt) nt = ev;
    const ln = now + (lc - this.lineAcc); if (ln < nt) nt = ln;
    if (TICK_MAX > 128) {                                                          // tick longo: limita pelas bordas de hblank dentro da linha e pelo próximo IRQ de timer
      const k = gpu.pal ? 2157.2 / 3406 : 2146.3 / 3413, x = this.lineAcc, e1 = gpu.hx1 * k, e2 = gpu.hx2 * k;
      if (e1 > x && now + (e1 - x) < nt) nt = now + (e1 - x); if (e2 > x && now + (e2 - x) < nt) nt = now + (e2 - x);
      const te = now + this.timers.nextEvent(); if (te < nt) nt = te;
    }
    this.nextTick = nt > now ? nt : now + 1;
  }
  /** um registrador de timer mudou: o próximo tick pode ter que vir antes */
  retime() { if (TICK_MAX > 128) { const te = this.cpu.cycles + this.timers.nextEvent(); if (te < this.nextTick) this.nextTick = te; } }
  /** contadores exatos numa leitura/escrita de registrador (sem rodar eventos) */
  syncTimers() { const now = this.cpu.cycles; if (now > this.timerAt) { this.timers.advance(now - this.timerAt); this.timerAt = now; } }
  takeAudio() { const o = this.audio.slice(0, this.audioLen * 2); this.audioLen = 0; return o; }

  step() {
    if (this.wasm && !this.onTrace) {                   // 1 passo = 1 instrução no núcleo wasm
      if (this.hookTTY) this.tty();
      const w = this.wasm, nt = this.nextTick; w.S[9] = 1; this.nextTick = this.cpu.cycles + 1; w.run(); this.nextTick = nt; w.S[9] = 0;
      if (this.cpu.cycles >= nt) this.tick();
      return;
    }
    if (this.useJit && !this.onTrace) {                 // 1 "passo" = 1 bloco recompilado
      if (this.hookTTY) this.tty();
      this.jit.exec();
      if (this.cpu.cycles >= this.nextTick) this.tick();
      return;
    }
    if (this.onTrace) this.onTrace(this.cpu.pc, this.bus.read32(this.cpu.pc));
    if (this.hookTTY) this.tty();
    this.cpu.step();
    if (this.cpu.cycles >= this.nextTick) this.tick();
  }
  run(n) { for (let i = 0; i < n; i++) this.step(); }
  /** roda pelo menos n instruções (conta instruções, não passos) */
  runInstr(n) { const end = this.cpu.instrCount + n; while (this.cpu.instrCount < end) this.step(); }

  /** Roda até o fim do quadro de vídeo atual; devolve o áudio (Int16 estéreo) gerado nesse tempo. */
  runFrame() {
    this.frameDone = false;
    if (this.wasm && !this.onTrace) {                    // CPU em WebAssembly: roda até o tick; A0/B0 voltam ao JS (TTY da BIOS)
      const w = this.wasm;
      while (!this.frameDone) { if (w.run() === 1) { this.tty(); w.skipHook(); } else this.tick(); }
    } else if (this.useJit && !this.onTrace) { while (!this.frameDone) { this.jit.runBlocks(this); this.tick(); } }
    else for (let g = 0; !this.frameDone && g < 4_000_000; g++) this.step();
    return this.takeAudio();
  }

  // ---------------- boot ----------------
  /**
   * Sideload: roda a BIOS SEM disco até o shell (0x80030000) e depois carrega o EXE do disco.
   * Alternativa ao boot normal (a região já é "spoofada", então o boot normal costuma funcionar).
   */
  bootToShell(maxSteps = 80_000_000) {
    const disc = this.disc; this.cdrom.setDisc(null);
    let ok = false;
    for (let i = 0; i < maxSteps; i++) { if ((this.cpu.pc & 0x1FFFFFFF) === 0x30000) { ok = true; break; } this.step(); }
    this.cdrom.setDisc(disc);
    return ok;
  }
  sideload(exe) {
    const cpu = this.cpu;
    this.bus.ram.set(exe.data, exe.textAddr & 0x1FFFFF); this.jit.flush();
    const sp = exe.sp || exe.stack || 0x801FFF00;
    cpu.r[28] = exe.gp; cpu.r[29] = sp; cpu.r[30] = sp;
    cpu.pc = exe.pc; cpu.nextPc = (exe.pc + 4) >>> 0; cpu.isBranch = false;
    cpu.cop0[12] = 0x40000401;      // CU2 on, IM2 on, IEc on, modo kernel, BEV=0
  }
  bootDiscExe() {
    if (!this.disc) throw new Error('nenhum disco carregado');
    const exe = this.disc.loadBootExe(); this.sideload(exe); return exe;
  }
}

return { PSX };
})();
const __src_input = (() => {
// ============================================================================
//  Entrada: teclado + Gamepad API -> controles do PSX (digital ou DualShock), remapeamento e vibração.
//  Sem dependência do DOM: recebe eventos/listas de gamepads (testável em Node).
// ============================================================================
const { BUTTONS } = __src_sio;
const DEFAULT_KEYS = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', KeyZ: 'cross', KeyX: 'circle', KeyA: 'square',
  KeyS: 'triangle', KeyQ: 'l1', KeyW: 'r1', KeyE: 'l2', KeyR: 'r2', KeyD: 'l3', KeyC: 'r3', Enter: 'start', ShiftRight: 'select', Backspace: 'select' };
/** layout "standard" do Gamepad API (índice do botão -> botão do PSX) */
const DEFAULT_PAD = { 0: 'cross', 1: 'circle', 2: 'square', 3: 'triangle', 4: 'l1', 5: 'r1', 6: 'l2', 7: 'r2', 8: 'select', 9: 'start', 10: 'l3', 11: 'r3',
  12: 'up', 13: 'down', 14: 'left', 15: 'right' };
const DEFAULT_HOTKEYS = { KeyP: 'pause', F5: 'save', F7: 'load', F11: 'fullscreen', F9: 'analog', KeyT: 'turbo' };
const ACTIONS = ['pause', 'save', 'load', 'fullscreen', 'analog', 'turbo'];
const ANALOG_BTN = 16;                                           // botão "home/guide" alterna o modo analógico

class InputManager {
  constructor(psx) {
    this.psx = psx; this.keys = { ...DEFAULT_KEYS }; this.padMap = { ...DEFAULT_PAD }; this.hotkeys = { ...DEFAULT_HOTKEYS };
    this.deadzone = 0.2; this.rumbleOn = true; this.onHotkey = null; this.getPads = null;   // getPads: () => lista de gamepads
    this.kb = new Set(); this.virt = new Set(); this.gp = [new Set(), new Set()]; this.stickDpad = [new Set(), new Set()];
    this.assigned = [-1, -1]; this.prevHome = [false, false]; this.lastRumble = [null, null];
    psx.sio.onRumble = (port, small, large) => this.rumble(port, small, large);
  }

  // ---- teclado ----
  /** evento de teclado (code = KeyboardEvent.code); acompanha as teclas físicas para suportar 2 teclas no mesmo botão. true = tecla consumida */
  keyEvent(code, down) {
    const act = this.hotkeys[code]; if (act) { if (down && this.onHotkey) this.onHotkey(act); return true; }
    const b = this.keys[code]; if (!b) return false;
    this.held ??= new Set(); if (down) this.held.add(code); else this.held.delete(code);
    this.kb = new Set([...this.held].map(c => this.keys[c]).filter(Boolean)); this.apply(0); return true;
  }
  /** controle virtual (toque): conjunto de botões pressionados na porta 1 */
  setVirtual(names) { this.virt = new Set(names); this.apply(0); }
  /** analógico virtual: x,y em -1..1 (y positivo = para baixo); side = 'l' | 'r' */
  setVirtualStick(side, x, y) { const s = this.psx.sio; s.setStick(side + 'x', 0x80 + x * 127, 0); s.setStick(side + 'y', 0x80 + y * 127, 0); }
  releaseAll() { this.held = new Set(); this.kb = new Set(); this.virt = new Set(); this.gp = [new Set(), new Set()]; this.stickDpad = [new Set(), new Set()]; this.apply(0); this.apply(1); }

  // ---- remapeamento ----
  bindKey(button, code) {
    if (!(button in BUTTONS)) throw new Error('botão desconhecido ' + button);
    delete this.hotkeys[code]; this.keys[code] = button;
  }
  unbindKey(code) { delete this.keys[code]; }
  bindHotkey(action, code) { if (!ACTIONS.includes(action)) throw new Error('ação desconhecida'); for (const c of Object.keys(this.hotkeys)) if (this.hotkeys[c] === action) delete this.hotkeys[c]; delete this.keys[code]; this.hotkeys[code] = action; }
  bindPad(button, index) { for (const i of Object.keys(this.padMap)) if (this.padMap[i] === button) delete this.padMap[i]; this.padMap[index] = button; }
  resetBindings() { this.keys = { ...DEFAULT_KEYS }; this.padMap = { ...DEFAULT_PAD }; this.hotkeys = { ...DEFAULT_HOTKEYS }; }
  exportConfig() { return JSON.stringify({ keys: this.keys, pad: this.padMap, hotkeys: this.hotkeys, deadzone: this.deadzone, rumble: this.rumbleOn }); }
  importConfig(text) {
    const c = JSON.parse(text), ok = o => o && typeof o === 'object';
    if (ok(c.keys)) this.keys = Object.fromEntries(Object.entries(c.keys).filter(([, b]) => b in BUTTONS));
    if (ok(c.pad)) this.padMap = Object.fromEntries(Object.entries(c.pad).filter(([, b]) => b in BUTTONS));
    if (ok(c.hotkeys)) this.hotkeys = Object.fromEntries(Object.entries(c.hotkeys).filter(([, a]) => ACTIONS.includes(a)));
    if (typeof c.deadzone === 'number') this.deadzone = Math.max(0, Math.min(0.9, c.deadzone));
    if (typeof c.rumble === 'boolean') this.rumbleOn = c.rumble;
  }

  // ---- gamepads (chamar 1x por quadro) ----
  poll() {
    const list = (this.getPads ? this.getPads() : []) || [];
    const pads = [...list].filter(g => g && g.connected);
    // associa o 1º gamepad à porta 1 e o 2º à porta 2 (mantém a ordem de conexão)
    this.assigned = [0, 1].map(p => pads[p] ? pads[p].index : -1);
    for (let port = 0; port < 2; port++) {
      const g = pads[port]; const sio = this.psx.sio;
      if (!g) { if (this.gp[port].size || this.stickDpad[port].size) { this.gp[port].clear(); this.stickDpad[port].clear(); this.apply(port); this.centerSticks(port); } continue; }
      if (port === 1) sio.padConnected[1] = true;
      const pressed = new Set();
      for (const [i, name] of Object.entries(this.padMap)) { const b = g.buttons[i]; if (b && (b.pressed || b.value > 0.5)) pressed.add(name); }
      const ax = k => { const v = g.axes[k] || 0; return Math.abs(v) < this.deadzone ? 0 : v; }, lx = ax(0), ly = ax(1), rx = ax(2), ry = ax(3);
      const dual = sio.padType[port] === 'dualshock', ds = new Set();
      if (dual) {
        const to8 = v => 0x80 + Math.round(v * 127.5);
        sio.setStick('lx', to8(lx), port); sio.setStick('ly', to8(ly), port); sio.setStick('rx', to8(rx), port); sio.setStick('ry', to8(ry), port);
      } else {                                                         // controle digital: o analógico esquerdo vira direcional
        if (lx < -0.5) ds.add('left'); if (lx > 0.5) ds.add('right'); if (ly < -0.5) ds.add('up'); if (ly > 0.5) ds.add('down');
      }
      this.gp[port] = pressed; this.stickDpad[port] = ds;
      const home = !!(g.buttons[ANALOG_BTN] && g.buttons[ANALOG_BTN].pressed);
      if (home && !this.prevHome[port]) sio.toggleAnalog(port);
      this.prevHome[port] = home;
      this.apply(port);
    }
  }
  centerSticks(port) { for (const k of ['lx', 'ly', 'rx', 'ry']) this.psx.sio.setStick(k, 0x80, port); }
  /** combina todas as fontes (teclado só na porta 1) e escreve no SIO */
  apply(port) {
    const sio = this.psx.sio, want = new Set([...this.gp[port], ...this.stickDpad[port], ...(port === 0 ? this.kb : []), ...(port === 0 ? this.virt : [])]);
    for (const name of Object.keys(BUTTONS)) sio.setButton(name, want.has(name), port);
  }

  // ---- vibração ----
  rumble(port, small, large) {
    this.lastRumble[port] = [small, large];
    if (!this.rumbleOn || !this.getPads) return;
    const g = [...(this.getPads() || [])].filter(x => x && x.connected)[port], act = g && g.vibrationActuator;
    if (!act) return;
    try {
      if (!small && !large) { act.reset?.(); return; }
      act.playEffect?.('dual-rumble', { startDelay: 0, duration: 1000, weakMagnitude: small ? 1 : 0, strongMagnitude: large / 255 });
    } catch { /* navegador sem suporte: ignora */ }
  }
}

return { DEFAULT_KEYS, DEFAULT_PAD, DEFAULT_HOTKEYS, ACTIONS, InputManager };
})();
const __src_debug = (() => {
// ============================================================================
//  Depurador / tracer: registradores, desmontagem, passo a passo, breakpoints, trace e relatório de falha.
//  Breakpoints e trace usam o interpretador (JIT desligado enquanto estiverem ativos): ficam mais lentos.
// ============================================================================
const { disasm } = __src_disasm;
const hex = (v, n = 8) => (v >>> 0).toString(16).padStart(n, '0');
const RN = ['zr', 'at', 'v0', 'v1', 'a0', 'a1', 'a2', 'a3', 't0', 't1', 't2', 't3', 't4', 't5', 't6', 't7',
            's0', 's1', 's2', 's3', 's4', 's5', 's6', 's7', 't8', 't9', 'k0', 'k1', 'gp', 'sp', 'fp', 'ra'];

// só lê memória sem efeito colateral (RAM, scratchpad, BIOS); registradores de I/O não são tocados
const safe = a => { const p = a & 0x1FFFFFFF; return p < 0x800000 || (p >= 0x1FC00000 && p < 0x1FC80000) || (p >= 0x1F800000 && p < 0x1F800400); };

class Debugger {
  rd32(a) { return safe(a) ? this.psx.bus.read32(a & ~3) : 0; }
  rd8(a) { return safe(a) ? this.psx.bus.read8(a) : 0; }
  constructor(psx) { this.psx = psx; this.breaks = new Set(); this.ring = null; this.ringPos = 0; this.ringN = 0; }

  /** registradores em texto (4 por linha) */
  regs() {
    const c = this.psx.cpu; let s = `pc=${hex(c.pc)}  hi=${hex(c.hi)}  lo=${hex(c.lo)}  ciclos=${c.cycles}  SR=${hex(c.cop0[12])}  CAUSE=${hex(c.cop0[13])}  EPC=${hex(c.cop0[14])}\n`;
    for (let i = 0; i < 32; i += 4) s += [0, 1, 2, 3].map(k => `${RN[i + k].padEnd(2)}=${hex(c.r[i + k])}`).join('  ') + '\n';
    return s;
  }
  /** `before`/`after` instruções ao redor de `pc` (marca a atual com ">") */
  listing(pc = this.psx.cpu.pc, before = 4, after = 8) {
    const out = [], cur = this.psx.cpu.pc;
    for (let i = -before; i <= after; i++) {
      const a = (pc + i * 4) >>> 0; let w = 0, txt;
      try { w = this.rd32(a); txt = disasm(w, a); } catch { txt = '??'; }
      out.push(`${a === cur ? '>' : ' '} ${hex(a)}: ${hex(w)}  ${txt}`);
    }
    return out.join('\n');
  }
  /** dump hexadecimal de `len` bytes */
  dump(addr, len = 64) {
    let s = '';
    for (let o = 0; o < len; o += 16) {
      const bytes = []; for (let i = 0; i < 16 && o + i < len; i++) { bytes.push(this.rd8((addr + o + i) >>> 0)); }
      s += `${hex(addr + o)}: ${bytes.map(b => hex(b, 2)).join(' ').padEnd(47)}  ${bytes.map(b => b >= 32 && b < 127 ? String.fromCharCode(b) : '.').join('')}\n`;
    }
    return s;
  }

  // ---- trace (anel com os últimos N PCs) ----
  startTrace(n = 256) { this.ring = new Uint32Array(n); this.ringPos = 0; this.ringN = 0; this.hook(); }
  stopTrace() { this.ring = null; this.hook(); }
  hook() {
    const need = this.ring || this.breaks.size;
    this.psx.onTrace = need ? (pc => { if (this.ring) { this.ring[this.ringPos] = pc; this.ringPos = (this.ringPos + 1) % this.ring.length; if (this.ringN < this.ring.length) this.ringN++; } }) : null;
  }
  /** últimas instruções executadas, da mais antiga para a mais recente */
  traceText() {
    if (!this.ring) return '(trace desligado)';
    const n = this.ringN, out = [];
    for (let i = 0; i < n; i++) {
      const a = this.ring[(this.ringPos - n + i + this.ring.length * 2) % this.ring.length]; let w = 0, t;
      try { w = this.rd32(a); t = disasm(w, a); } catch { t = '??'; }
      out.push(`${hex(a)}: ${hex(w)}  ${t}`);
    }
    return out.join('\n');
  }

  // ---- execução controlada ----
  addBreak(pc) { this.breaks.add(pc >>> 0); this.hook(); }
  delBreak(pc) { this.breaks.delete(pc >>> 0); this.hook(); }
  /** executa exatamente 1 instrução no interpretador */
  stepInstr() {
    const p = this.psx, prev = p.onTrace; if (!prev) p.onTrace = () => { };
    const n = p.cpu.instrCount; try { for (let g = 0; p.cpu.instrCount === n && g < 8; g++) p.step(); } finally { if (!prev) p.onTrace = null; }
  }
  /** roda até um breakpoint (ou `max` instruções). Devolve o PC do breakpoint atingido ou null */
  run(max = 5_000_000) {
    const p = this.psx, c = p.cpu; this.hook(); if (!p.onTrace) p.onTrace = () => { };
    const end = c.instrCount + max; let hit = null;
    try {
      while (c.instrCount < end) {
        p.step(); if (this.breaks.has(c.pc >>> 0)) { hit = c.pc >>> 0; break; }
      }
    } finally { this.hook(); }
    return hit;
  }

  /** texto para diagnóstico quando algo dá errado (exceção do emulador, travamento...) */
  report(err) {
    const p = this.psx, cd = p.cdrom;
    return [`== Relatório do ps1emu ==`, err ? `Erro: ${err.stack || err.message || err}` : 'Sem erro (snapshot manual)',
      `quadros=${p.frames} ciclos=${p.cpu.cycles} jit=${p.useJit}`, `IRQ: istat=${hex(p.bus.istat)} imask=${hex(p.bus.imask)}`,
      `CD: lendo=${cd.reading} tocando=${cd.playing} pos=${cd.pos} intFlag=${cd.intFlag} modo=${hex(cd.mode, 2)}`,
      `GPU: ${p.gpu.width}x${p.gpu.height} display=${p.gpu.dispOn} dma=${p.gpu.dmaDir}`,
      '', this.regs(), this.listing(p.cpu.pc, 6, 6), '', this.ring ? 'Últimas instruções:\n' + this.traceText() : ''].join('\n');
  }
}

return { Debugger };
})();
const __src_glgpu = (() => {
// ============================================================================
//  Renderizador WebGL2 da GPU do PS1 com resolução interna escalável (1x..8x)
// ============================================================================
//  Modelo de dados:
//   H  = VRAM em alta resolução (textura RGBA8 de 1024*S x 512*S, + stencil). É a fonte da verdade:
//        rgb = cor RGB555 expandida, alpha = bit de máscara (bit 15), stencil = espelho do bit de máscara.
//   N  = VRAM nativa (gpu.vram, Uint16Array 1024x512) + textura R16UI usada para buscar texels
//        4/8/15 bits e CLUTs nos shaders. É um CACHE de H: só é atualizada quando a CPU escreve na VRAM
//        (uploads) ou quando algo precisa ler uma região que a GPU desenhou ("tiles sujos" de 16x16).
//  Com o renderizador ativo o rasterizador por software NÃO roda (gpu.hw != null).
//
//  Fidelidade: coordenadas de vértice somam +0.5 pixel (o PS1 amostra em inteiros), texels via
//  texelFetch (nearest), dither por pixel nativo, semi-transparência com os 4 modos (blend de hardware;
//  texels semi/opacos em 2 passes), máscara (set/check) via stencil, janela de textura, área de desenho
//  por scissor, cópias VRAM->VRAM na GPU, leitura de VRAM por readPixels + reamostragem.
// ============================================================================

const VW = 1024, VH = 512, TILE = 16, TX = VW / TILE, TY = VH / TILE;
const STRIDE_W = 19;                                   // palavras por vértice (7 floats + 12 ints)
const MAX_VERTS = 6 * 8192;

const VS_PRIM = `#version 300 es
layout(location=0) in vec2 a_pos; layout(location=1) in vec3 a_col; layout(location=2) in vec2 a_uv;
layout(location=3) in ivec4 a_tex; layout(location=4) in ivec4 a_flg; layout(location=5) in ivec4 a_tw;
out vec3 v_col; out vec2 v_uv; flat out ivec4 v_tex; flat out ivec4 v_flg; flat out ivec4 v_tw;
void main(){
  gl_Position = vec4(a_pos.x/512.0-1.0, a_pos.y/256.0-1.0, 0.0, 1.0);
  v_col=a_col; v_uv=a_uv; v_tex=a_tex; v_flg=a_flg; v_tw=a_tw;
}`;

const FS_PRIM = `#version 300 es
precision highp float; precision highp int; precision highp usampler2D;
uniform usampler2D u_vram; uniform float u_scale; uniform int u_pass; uniform int u_setMask; uniform int u_rowMask;
in vec3 v_col; in vec2 v_uv; flat in ivec4 v_tex; flat in ivec4 v_flg; flat in ivec4 v_tw;
out vec4 o_color;
const int DITHER[16] = int[16](-4,0,-3,1, 2,-2,3,-1, -3,1,-4,0, 3,-1,2,-2);
int vramAt(ivec2 p){ return int(texelFetch(u_vram, ivec2(p.x & 1023, p.y & 511), 0).r); }
void main(){
  if (u_rowMask >= 0 && (int(floor(gl_FragCoord.y / u_scale)) & 1) == u_rowMask) discard;   // 480i: não desenha as linhas do campo exibido
  ivec3 c = ivec3(floor(v_col + 0.002));
  bool textured = v_flg.x < 3;
  bool semiTexel = false;
  if (textured) {
    ivec2 uv = ivec2(floor(v_uv + vec2(0.0002)));
    int u = uv.x & 255, v = uv.y & 255;
    u = (u & ~(v_tw.x << 3)) | ((v_tw.z & v_tw.x) << 3);
    v = (v & ~(v_tw.y << 3)) | ((v_tw.w & v_tw.y) << 3);
    int depth = v_flg.x, texel;
    if (depth == 0) {
      int w = vramAt(ivec2(v_tex.x + (u >> 2), v_tex.y + v));
      texel = vramAt(ivec2(v_tex.z + ((w >> ((u & 3) * 4)) & 15), v_tex.w));
    } else if (depth == 1) {
      int w = vramAt(ivec2(v_tex.x + (u >> 1), v_tex.y + v));
      texel = vramAt(ivec2(v_tex.z + ((w >> ((u & 1) * 8)) & 255), v_tex.w));
    } else {
      texel = vramAt(ivec2(v_tex.x + u, v_tex.y + v));
    }
    if (texel == 0) discard;
    semiTexel = (texel & 0x8000) != 0;
    ivec3 t = ivec3(texel & 31, (texel >> 5) & 31, (texel >> 10) & 31);
    if (v_flg.y != 0) c = t * 8; else c = (t * c) >> 4;
  }
  if (u_pass == 1) { if (!textured || semiTexel) discard; }
  else if (u_pass == 2) { if (textured && !semiTexel) discard; }
  if (v_flg.z != 0) {
    ivec2 np = ivec2(floor(gl_FragCoord.xy / u_scale));
    c += DITHER[((np.y & 3) << 2) | (np.x & 3)];
  }
  c = clamp(c, 0, 255) >> 3;
  o_color = vec4(vec3(c) / 31.0, float(u_setMask));
}`;

const VS_QUAD = `#version 300 es
layout(location=0) in vec2 a_pos; layout(location=1) in vec2 a_uv; out vec2 v_uv;
uniform int u_ndc;   // 1: a_pos já está em NDC (apresentação); 0: coordenadas nativas da VRAM
void main(){
  gl_Position = (u_ndc == 1) ? vec4(a_pos, 0.0, 1.0) : vec4(a_pos.x/512.0-1.0, a_pos.y/256.0-1.0, 0.0, 1.0);
  v_uv = a_uv;
}`;

const FS_BLIT_NATIVE = `#version 300 es
precision highp float; precision highp int; precision highp usampler2D;
uniform usampler2D u_src; uniform float u_scale; uniform int u_pass;
out vec4 o_color;
void main(){
  ivec2 p = ivec2(floor(gl_FragCoord.xy / u_scale)) & ivec2(1023, 511);
  uint w = texelFetch(u_src, p, 0).r;
  int bit = int((w >> 15u) & 1u);
  if (bit != u_pass) discard;
  o_color = vec4(vec3(ivec3(int(w & 31u), int((w >> 5u) & 31u), int((w >> 10u) & 31u))) / 31.0, float(bit));
}`;

const FS_BLIT_RGBA = `#version 300 es
precision highp float; precision highp int;
uniform sampler2D u_src; uniform ivec2 u_delta; uniform int u_pass; uniform int u_setMask;
out vec4 o_color;
void main(){
  vec4 t = texelFetch(u_src, ivec2(gl_FragCoord.xy) + u_delta, 0);
  int bit = (t.a > 0.5 || u_setMask != 0) ? 1 : 0;
  if (bit != u_pass) discard;
  o_color = vec4(t.rgb, float(bit));
}`;

const FS_PRESENT = `#version 300 es
precision highp float;
uniform sampler2D u_tex; in vec2 v_uv; out vec4 o_color;
void main(){ o_color = vec4(texture(u_tex, v_uv).rgb, 1.0); }`;

const FS_FILL = `#version 300 es
precision highp float;
uniform vec4 u_col; uniform float u_scale; uniform int u_row; out vec4 o_color;
void main(){ if ((int(floor(gl_FragCoord.y / u_scale)) & 1) == u_row) discard; o_color = u_col; }`;

const FS_FIELD = `#version 300 es
precision highp float;
uniform sampler2D u_src; uniform sampler2D u_prev; uniform float u_scale; uniform int u_par; uniform float u_mt; out vec4 o_color;
void main(){
  if ((int(floor(gl_FragCoord.y / u_scale)) & 1) != u_par) discard;
  ivec2 p = ivec2(gl_FragCoord.xy); vec3 n = texelFetch(u_src, p, 0).rgb, o = texelFetch(u_prev, p, 0).rgb; vec3 d = abs(n - o);
  o_color = vec4(n, max(d.r, max(d.g, d.b)) > u_mt ? 1.0 : 0.0);          // alfa = movimento em relação ao mesmo campo de 2 quadros atrás
}`;

// apresentação em 480i com desentrelaçamento: linhas do campo antigo viram a média das vizinhas (campo atual) onde houver movimento (adaptativo) ou sempre (modo 2)
const FS_DEINT = `#version 300 es
precision highp float;
uniform sampler2D u_tex; uniform int u_par; uniform int u_mode; uniform float u_thr; uniform float u_dv; in vec2 v_uv; out vec4 o_color;
void main(){
  vec3 c = texture(u_tex, v_uv).rgb;
  int line = int(floor(v_uv.y * 512.0));
  if ((line & 1) != u_par) {
    vec4 A = texture(u_tex, v_uv - vec2(0.0, u_dv)), B = texture(u_tex, v_uv + vec2(0.0, u_dv)); vec3 m = (A.rgb + B.rgb) * 0.5;
    if (u_mode == 2 || max(A.a, B.a) > 0.5) c = m;                          // adaptativo: só onde o campo atual mudou em relação ao de 2 quadros atrás
  }
  o_color = vec4(c, 1.0);
}`;

const DEINT_THR = 40;                                                     // diferença (0-255) acima da qual a linha do campo antigo é considerada "em movimento"
const Q5 = new Uint8Array(256); for (let i = 0; i < 256; i++) Q5[i] = Math.round(i * 31 / 255);

class GLRenderer {
  /**
   * @param canvas  <canvas> (será usado com contexto webgl2)
   * @param scale   fator de resolução interna (1..8)
   * @param opts    { smooth: true -> filtro linear quando a saída é reduzida }
   */
  constructor(canvas, scale = 2, opts = {}) {
    const gl = this.gl = canvas.getContext('webgl2', { antialias: false, alpha: false, depth: false, stencil: false, preserveDrawingBuffer: !!opts.preserve, powerPreference: 'high-performance' });
    if (!gl) throw new Error('WebGL2 indisponível neste navegador');
    this.canvas = canvas; this.opts = opts; this.gpu = null;
    const maxTex = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE), gl.getParameter(gl.MAX_RENDERBUFFER_SIZE));
    let S = Math.max(1, Math.floor(scale)); while (S > 1 && VW * S > maxTex) S--;
    this.scale = S; this.W = VW * S; this.H = VH * S;

    this.initGL();
    this.f32 = new Float32Array(MAX_VERTS * STRIDE_W); this.i32 = new Int32Array(this.f32.buffer);
    this.n = 0; this.pc = new Int32Array(12);
    this.batchKey = ''; this.batchKind = 0; this.batchSemi = 0;
    this.pb = [1e9, 1e9, -1, -1];                              // bbox pendente (nativo) do lote ainda não desenhado
    this.dirty = new Uint8Array(TX * TY);                      // tiles em que H é mais novo que N
    this.rb = null; this.rgba = null;
    this.outW = 0; this.outH = 0; this.dispKey = ''; this.texDisp = null; this.fboDisp = null;
  }

  // ------------------------------------------------------------------ GL setup
  compile(vs, fs, bind) {
    const gl = this.gl, mk = (t, s) => { const sh = gl.createShader(t); gl.shaderSource(sh, s); gl.compileShader(sh); if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error('shader: ' + gl.getShaderInfoLog(sh)); return sh; };
    const p = gl.createProgram(); gl.attachShader(p, mk(gl.VERTEX_SHADER, vs)); gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p); if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('link: ' + gl.getProgramInfoLog(p));
    const u = {}; const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) { const info = gl.getActiveUniform(p, i); u[info.name] = gl.getUniformLocation(p, info.name); }
    return { p, u };
  }

  initGL() {
    const gl = this.gl, S = this.scale;
    gl.getExtension('EXT_color_buffer_float');
    this.prim = this.compile(VS_PRIM, FS_PRIM);
    this.blitN = this.compile(VS_QUAD, FS_BLIT_NATIVE);
    this.blitC = this.compile(VS_QUAD, FS_BLIT_RGBA);
    this.pres = this.compile(VS_QUAD, FS_PRESENT);
    this.fillP = this.compile(VS_QUAD, FS_FILL);
    this.fieldP = this.compile(VS_QUAD, FS_FIELD);
    this.deintP = this.compile(VS_QUAD, FS_DEINT);

    // H: textura + stencil
    this.texH = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, this.texH);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, this.W, this.H);
    this.setFilter(this.texH, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    this.rbDS = gl.createRenderbuffer(); gl.bindRenderbuffer(gl.RENDERBUFFER, this.rbDS);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH24_STENCIL8, this.W, this.H);
    this.fboH = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboH);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.texH, 0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_STENCIL_ATTACHMENT, gl.RENDERBUFFER, this.rbDS);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('FBO incompleto (memória de vídeo insuficiente para ' + S + 'x?)');
    gl.disable(gl.SCISSOR_TEST); gl.clearColor(0, 0, 0, 0); gl.clearStencil(0); gl.stencilMask(0xFF); gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);

    // N: textura R16UI
    this.texN = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, this.texN);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R16UI, VW, VH);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    this.texScratch = null;                                      // alocada na 1ª cópia VRAM->VRAM
    this.texVid = gl.createTexture();                            // imagem de display em 24 bits

    // VBO/VAO dos primitivos
    this.vbo = gl.createBuffer(); this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao); gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, MAX_VERTS * STRIDE_W * 4, gl.STREAM_DRAW);
    const B = STRIDE_W * 4;
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, B, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, B, 8);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 2, gl.FLOAT, false, B, 20);
    gl.enableVertexAttribArray(3); gl.vertexAttribIPointer(3, 4, gl.INT, B, 28);
    gl.enableVertexAttribArray(4); gl.vertexAttribIPointer(4, 4, gl.INT, B, 44);
    gl.enableVertexAttribArray(5); gl.vertexAttribIPointer(5, 4, gl.INT, B, 60);

    // quad (blits/apresentação): 6 vértices x (x,y,u,v)
    this.qbo = gl.createBuffer(); this.qvao = gl.createVertexArray();
    gl.bindVertexArray(this.qvao); gl.bindBuffer(gl.ARRAY_BUFFER, this.qbo);
    gl.bufferData(gl.ARRAY_BUFFER, 6 * 4 * 4, gl.STREAM_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 16, 8);
    this.qdata = new Float32Array(24);
    gl.bindVertexArray(null);
  }

  setFilter(tex, f) {
    const gl = this.gl; gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, f); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, f);
  }

  // ------------------------------------------------------------------ ciclo de vida
  /** liga o renderizador à GPU: envia a VRAM nativa atual para H e N */
  attach(gpu) {
    this.gpu = gpu; gpu.hw = this;
    this.dirty.fill(0); this.n = 0; this.pb = [1e9, 1e9, -1, -1];
    const cm = gpu.checkMask; gpu.checkMask = false;
    this.uploadNativeTex(0, 0, VW, VH);
    this.blitNativeToH(0, 0, VW, VH);
    gpu.checkMask = cm;
  }
  /** desliga: traz tudo de H para a VRAM nativa e devolve o controle ao software */
  detach() {
    if (!this.gpu) return;
    this.flush(); this.syncNative(0, 0, VW, VH, true);
    this.gpu.hw = null; this.gpu = null;
  }

  // ------------------------------------------------------------------ helpers de região
  /** divide um retângulo (com wrap em 1024x512) em pedaços que não cruzam as bordas */
  rects(x, y, w, h, fn) {
    x &= 1023; y &= 511; w = Math.min(w, VW); h = Math.min(h, VH);
    const w1 = Math.min(w, VW - x), h1 = Math.min(h, VH - y);
    fn(x, y, w1, h1);
    if (w > w1) fn(0, y, w - w1, h1);
    if (h > h1) { fn(x, 0, w1, h - h1); if (w > w1) fn(0, 0, w - w1, h - h1); }
  }
  markDirty(x0, y0, x1, y1) {                                   // inclusivo, nativo
    x0 = Math.max(0, x0); y0 = Math.max(0, y0); x1 = Math.min(VW - 1, x1); y1 = Math.min(VH - 1, y1);
    if (x1 < x0 || y1 < y0) return;
    for (let ty = y0 >> 4; ty <= y1 >> 4; ty++) for (let tx = x0 >> 4; tx <= x1 >> 4; tx++) this.dirty[ty * TX + tx] = 1;
  }
  isDirty(x, y, w, h) {
    for (let ty = y >> 4; ty <= (y + h - 1) >> 4; ty++) for (let tx = x >> 4; tx <= (x + w - 1) >> 4; tx++) if (this.dirty[ty * TX + tx]) return true;
    return false;
  }
  pendingHits(x, y, w, h) {
    const p = this.pb; return p[2] >= 0 && !(x > p[2] || x + w - 1 < p[0] || y > p[3] || y + h - 1 < p[1]);
  }

  // ------------------------------------------------------------------ N <-> H
  uploadNativeTex(x, y, w, h) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.texN);
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, VW); gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, x); gl.pixelStorei(gl.UNPACK_SKIP_ROWS, y);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, w, h, gl.RED_INTEGER, gl.UNSIGNED_SHORT, this.gpu.vram);
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0); gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0); gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
  }

  applyMask(writeBit, check) {
    const gl = this.gl; gl.enable(gl.STENCIL_TEST); gl.stencilMask(0xFF);
    if (check) { gl.stencilFunc(gl.EQUAL, 0, 0xFF); gl.stencilOp(gl.KEEP, gl.KEEP, writeBit ? gl.INVERT : gl.KEEP); }
    else { gl.stencilFunc(gl.ALWAYS, writeBit, 0xFF); gl.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE); }
  }

  drawQuad(x, y, w, h, u0 = 0, v0 = 0, u1 = 0, v1 = 0, ndc = false) {
    const gl = this.gl, q = this.qdata;
    const X0 = x, Y0 = y, X1 = x + w, Y1 = y + h;
    q.set([X0, Y0, u0, v0, X1, Y0, u1, v0, X0, Y1, u0, v1, X1, Y0, u1, v0, X1, Y1, u1, v1, X0, Y1, u0, v1]);
    gl.bindVertexArray(this.qvao); gl.bindBuffer(gl.ARRAY_BUFFER, this.qbo); gl.bufferSubData(gl.ARRAY_BUFFER, 0, q);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  /** copia a região da VRAM nativa (N) para H (2 passes por bit de máscara) */
  blitNativeToH(x0, y0, w0, h0) {
    const gl = this.gl, S = this.scale, g = this.gpu;
    this.rects(x0, y0, w0, h0, (x, y, w, h) => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboH); gl.viewport(0, 0, this.W, this.H);
      gl.disable(gl.BLEND); gl.enable(gl.SCISSOR_TEST); gl.scissor(x * S, y * S, w * S, h * S); gl.colorMask(true, true, true, true);
      gl.useProgram(this.blitN.p); gl.uniform1f(this.blitN.u.u_scale, S); gl.uniform1i(this.blitN.u.u_ndc, 0); gl.uniform1i(this.blitN.u.u_src, 0);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.texN);
      for (let pass = 0; pass < 2; pass++) {
        this.applyMask(pass, g.checkMask); gl.uniform1i(this.blitN.u.u_pass, pass);
        this.drawQuad(x, y, w, h);
      }
      if (!g.checkMask) for (let ty = y >> 4; ty <= (y + h - 1) >> 4; ty++) for (let tx = x >> 4; tx <= (x + w - 1) >> 4; tx++) {
        if (tx * TILE >= x && ty * TILE >= y && (tx + 1) * TILE <= x + w && (ty + 1) * TILE <= y + h) this.dirty[ty * TX + tx] = 0;
      }
    });
  }

  /** traz de H para a VRAM nativa os tiles sujos que tocam a região; atualiza também a textura N */
  syncNative(x0, y0, w0, h0, all = false) {
    this.flush();
    const gl = this.gl, S = this.scale, g = this.gpu;
    this.rects(x0, y0, w0, h0, (x, y, w, h) => {
      let bx0 = 1e9, by0 = 1e9, bx1 = -1, by1 = -1;
      for (let ty = y >> 4; ty <= (y + h - 1) >> 4; ty++) for (let tx = x >> 4; tx <= (x + w - 1) >> 4; tx++) {
        if (!all && !this.dirty[ty * TX + tx]) continue;
        if (tx * TILE < bx0) bx0 = tx * TILE; if (ty * TILE < by0) by0 = ty * TILE;
        if ((tx + 1) * TILE - 1 > bx1) bx1 = (tx + 1) * TILE - 1; if ((ty + 1) * TILE - 1 > by1) by1 = (ty + 1) * TILE - 1;
      }
      if (bx1 < 0) return;
      const bw = bx1 - bx0 + 1, bh = by1 - by0 + 1, pw = bw * S, ph = bh * S;
      if (!this.rb || this.rb.length < pw * ph * 4) this.rb = new Uint8Array(pw * ph * 4);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.fboH);
      gl.readPixels(bx0 * S, by0 * S, pw, ph, gl.RGBA, gl.UNSIGNED_BYTE, this.rb);
      const rb = this.rb, c = S >> 1, vram = g.vram;
      for (let ny = 0; ny < bh; ny++) {
        let o = ((ny * S + c) * pw + c) * 4, di = (by0 + ny) * VW + bx0;
        for (let nx = 0; nx < bw; nx++, o += S * 4, di++) {
          vram[di] = Q5[rb[o]] | (Q5[rb[o + 1]] << 5) | (Q5[rb[o + 2]] << 10) | (rb[o + 3] > 127 ? 0x8000 : 0);
        }
      }
      for (let ty = by0 >> 4; ty <= by1 >> 4; ty++) for (let tx = bx0 >> 4; tx <= bx1 >> 4; tx++) this.dirty[ty * TX + tx] = 0;
      this.uploadNativeTex(bx0, by0, bw, bh);
    });
  }

  /** a CPU escreveu na VRAM nativa (upload / cópia por software): reflete em H e N */
  uploaded(x, y, w, h) {
    this.flush();
    this.rects(x, y, w, h, (rx, ry, rw, rh) => { this.uploadNativeTex(rx, ry, rw, rh); this.blitNativeToH(rx, ry, rw, rh); });
  }

  // ------------------------------------------------------------------ comandos de VRAM
  fill(x0, y0, w, h, col) {
    this.flush();
    const gl = this.gl, S = this.scale, mk = this.gpu.rowMask;
    if (mk >= 0) return this.fillMasked(x0, y0, w, h, col, mk);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboH); gl.viewport(0, 0, this.W, this.H);
    gl.disable(gl.BLEND); gl.enable(gl.SCISSOR_TEST); gl.colorMask(true, true, true, true); gl.stencilMask(0xFF);
    gl.clearColor(((col & 255) >> 3) / 31, (((col >> 8) & 255) >> 3) / 31, (((col >> 16) & 255) >> 3) / 31, 0); gl.clearStencil(0);
    this.rects(x0, y0, w, h, (x, y, rw, rh) => {
      gl.scissor(x * S, y * S, rw * S, rh * S); gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
      this.markDirty(x, y, x + rw - 1, y + rh - 1);
    });
  }

  /** fill em 480i: só as linhas do campo que não está sendo exibido (via shader; o stencil é zerado junto) */
  fillMasked(x0, y0, w, h, col, mk) {
    const gl = this.gl, S = this.scale;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboH); gl.viewport(0, 0, this.W, this.H);
    gl.disable(gl.BLEND); gl.enable(gl.SCISSOR_TEST); gl.colorMask(true, true, true, true);
    gl.enable(gl.STENCIL_TEST); gl.stencilMask(0xFF); gl.stencilFunc(gl.ALWAYS, 0, 0xFF); gl.stencilOp(gl.REPLACE, gl.REPLACE, gl.REPLACE);
    gl.useProgram(this.fillP.p); gl.uniform1i(this.fillP.u.u_ndc, 0);
    gl.uniform4f(this.fillP.u.u_col, ((col & 255) >> 3) / 31, (((col >> 8) & 255) >> 3) / 31, (((col >> 16) & 255) >> 3) / 31, 0);
    gl.uniform1f(this.fillP.u.u_scale, S); gl.uniform1i(this.fillP.u.u_row, mk);
    this.rects(x0, y0, w, h, (x, y, rw, rh) => {
      gl.scissor(x * S, y * S, rw * S, rh * S);
      this.drawQuad(x, y, rw, rh);
      this.markDirty(x, y, x + rw - 1, y + rh - 1);
    });
    gl.bindVertexArray(null);
  }

  /** fim de quadro em 480i: guarda as linhas do campo exibido (completas) numa textura de display; a saída tece com o campo anterior */
  captureField(g) {
    this.flush();
    if (!(g.interlace && g.vres) || !g.dispOn) { this.dispKey = ''; g.snapKey = ''; return; }
    const gl = this.gl, S = this.scale, w = g.width, h = g.height;
    if (g.rgb24) { this.dispKey = ''; this.rects(g.startX, g.startY, Math.ceil(w * 1.5) + 2, h, (x, y, rw, rh) => this.syncNative(x, y, rw, rh)); g.captureFieldSW(); return; }
    g.snapKey = ''; this.lastPar = g.field;
    if (!this.texDisp) {
      this.texDisp = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, this.texDisp);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, this.W, this.H);
      this.setFilter(this.texDisp, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
      this.fboDisp = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboDisp);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.texDisp, 0);
    }
    if (!this.texPrev) {                                          // cópia do campo anterior (para detectar movimento)
      this.texPrev = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, this.texPrev);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, this.W, this.H); this.setFilter(this.texPrev, gl.NEAREST);
      this.fboPrev = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboPrev);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.texPrev, 0);
    }
    const key = g.startX + ',' + g.startY + ',' + w + ',' + h, full = key !== this.dispKey; this.dispKey = key;
    if (full) {                                                  // 1º quadro (ou mudança de modo): copia a área toda
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.fboH); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.fboDisp);
      this.rects(g.startX, g.startY, w, h, (x, y, rw, rh) => gl.blitFramebuffer(x * S, y * S, (x + rw) * S, (y + rh) * S, x * S, y * S, (x + rw) * S, (y + rh) * S, gl.COLOR_BUFFER_BIT, gl.NEAREST));
    }
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.fboDisp); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.fboPrev);      // texDisp (campos t-1 e t-2) -> texPrev
    gl.disable(gl.SCISSOR_TEST);
    this.rects(g.startX, g.startY, w, h, (x, y, rw, rh) => gl.blitFramebuffer(x * S, y * S, (x + rw) * S, (y + rh) * S, x * S, y * S, (x + rw) * S, (y + rh) * S, gl.COLOR_BUFFER_BIT, gl.NEAREST));
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboDisp); gl.viewport(0, 0, this.W, this.H);
    gl.disable(gl.BLEND); gl.disable(gl.STENCIL_TEST); gl.enable(gl.SCISSOR_TEST); gl.colorMask(true, true, true, true);
    gl.useProgram(this.fieldP.p); gl.uniform1i(this.fieldP.u.u_ndc, 0); gl.uniform1i(this.fieldP.u.u_src, 0);
    gl.uniform1f(this.fieldP.u.u_scale, S); gl.uniform1i(this.fieldP.u.u_par, g.field); gl.uniform1i(this.fieldP.u.u_prev, 5); gl.uniform1f(this.fieldP.u.u_mt, 12 / 255);
    gl.activeTexture(gl.TEXTURE5); gl.bindTexture(gl.TEXTURE_2D, this.texPrev);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.texH);
    this.rects(g.startX, g.startY, w, h, (x, y, rw, rh) => { gl.scissor(x * S, y * S, rw * S, rh * S); this.drawQuad(x, y, rw, rh); });
    gl.bindVertexArray(null);
  }

  /** VRAM->VRAM dentro da GPU. Devolve false se o chamador deve fazer por software (após sincronizar). */
  copy(sx, sy, dx, dy, w, h) {
    const g = this.gpu;
    if (sx + w > VW || dx + w > VW || sy + h > VH || dy + h > VH) {          // com wrap: caminho por software
      this.rects(sx, sy, w, h, (x, y, rw, rh) => this.syncNative(x, y, rw, rh));
      if (g.checkMask) this.rects(dx, dy, w, h, (x, y, rw, rh) => this.syncNative(x, y, rw, rh));
      return false;
    }
    this.flush();
    const gl = this.gl, S = this.scale;
    if (!this.texScratch) {
      this.texScratch = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, this.texScratch);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, this.W, this.H); this.setFilter(this.texScratch, gl.NEAREST);
    }
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.fboH);
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, this.texScratch);
    gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, sx * S, sy * S, sx * S, sy * S, w * S, h * S);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboH); gl.viewport(0, 0, this.W, this.H);
    gl.disable(gl.BLEND); gl.enable(gl.SCISSOR_TEST); gl.scissor(dx * S, dy * S, w * S, h * S); gl.colorMask(true, true, true, true);
    gl.useProgram(this.blitC.p); gl.uniform1i(this.blitC.u.u_ndc, 0); gl.uniform1i(this.blitC.u.u_src, 2);
    gl.uniform2i(this.blitC.u.u_delta, (sx - dx) * S, (sy - dy) * S); gl.uniform1i(this.blitC.u.u_setMask, g.setMask ? 1 : 0);
    for (let pass = 0; pass < 2; pass++) { this.applyMask(pass, g.checkMask); gl.uniform1i(this.blitC.u.u_pass, pass); this.drawQuad(dx, dy, w, h); }
    gl.activeTexture(gl.TEXTURE0);
    this.markDirty(dx, dy, dx + w - 1, dy + h - 1);
    return true;
  }

  // ------------------------------------------------------------------ primitivos
  pv(x, y, r, g, b, u, v) {
    const f = this.f32, i = this.i32, pc = this.pc; let o = this.n * STRIDE_W;
    f[o] = x; f[o + 1] = y; f[o + 2] = r; f[o + 3] = g; f[o + 4] = b; f[o + 5] = u; f[o + 6] = v;
    for (let k = 0; k < 12; k++) i[o + 7 + k] = pc[k];
    this.n++;
  }

  /** prepara as constantes por primitivo + garante texturas atualizadas + gerencia o lote */
  begin(textured, semi, raw, dith, clutX, clutY, bx0, by0, bx1, by1, nverts) {
    const g = this.gpu, pc = this.pc;
    const depth = textured ? g.texDepth : 3;
    if (textured) {
      const pw = depth === 0 ? 64 : depth === 1 ? 128 : 256, px = g.texX * 64, py = g.texY * 256;
      const need = (x, y, w, h) => this.rects(x, y, w, h, (rx, ry, rw, rh) => {
        if (this.pendingHits(rx, ry, rw, rh)) this.flush();
        if (this.isDirty(rx, ry, rw, rh)) this.syncNative(rx, ry, rw, rh);
      });
      need(px, py, pw, 256);
      if (depth === 0) need(clutX * 16, clutY, 16, 1); else if (depth === 1) need(clutX * 16, clutY, 256, 1);
      pc[0] = px; pc[1] = py; pc[2] = clutX * 16; pc[3] = clutY;
    } else { pc[0] = pc[1] = pc[2] = pc[3] = 0; }
    pc[4] = depth; pc[5] = raw ? 1 : 0; pc[6] = dith ? 1 : 0; pc[7] = 0;
    pc[8] = g.twMaskX; pc[9] = g.twMaskY; pc[10] = g.twOffX; pc[11] = g.twOffY;

    const kind = !semi ? 0 : (textured ? 2 : 1);
    const mk = g.rowMask, key = `${g.daX1},${g.daY1},${g.daX2},${g.daY2},${g.setMask ? 1 : 0},${g.checkMask ? 1 : 0},${kind},${semi ? g.semiMode : -1},${mk}`;
    if (this.n > 0 && (key !== this.batchKey || this.n + nverts > MAX_VERTS)) this.flush();
    this.batchKey = key; this.batchKind = kind; this.batchSemi = g.semiMode;
    this.bs = { x1: g.daX1, y1: g.daY1, x2: g.daX2, y2: g.daY2, set: g.setMask ? 1 : 0, check: g.checkMask, mk };     // estado do lote (a GPU pode mudar antes do flush)
    // bbox pendente (para dirty tiles e hazard de textura)
    const p = this.pb;
    p[0] = Math.min(p[0], Math.max(bx0, g.daX1, 0)); p[1] = Math.min(p[1], Math.max(by0, g.daY1, 0));
    p[2] = Math.max(p[2], Math.min(bx1, g.daX2, VW - 1)); p[3] = Math.max(p[3], Math.min(by1, g.daY2, VH - 1));
    return kind;
  }
  end(kind) { if (kind === 2) this.flush(); }

  polygon(V, quad, o) {
    this.tri(V[0], V[1], V[2], o);
    if (quad) this.tri(V[1], V[2], V[3], o);
  }

  tri(a, b, c, o) {
    const g = this.gpu, S = this.scale;
    const area = (b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y);
    if (area === 0) return;
    const minX = Math.min(a.x, b.x, c.x), maxX = Math.max(a.x, b.x, c.x), minY = Math.min(a.y, b.y, c.y), maxY = Math.max(a.y, b.y, c.y);
    if (maxX - minX > 1023 || maxY - minY > 511) return;
    if (maxX < g.daX1 || minX > g.daX2 || maxY < g.daY1 || minY > g.daY2) return;
    const dith = o.tex ? (!o.raw && g.dither) : (g.dither && o.gour);
    const kind = this.begin(o.tex, o.semi, o.raw, dith, o.clutX, o.clutY, minX, minY, maxX, maxY, 3);
    const s = 0.5 / S, vs = o.gour ? [a, b, c] : [a, a, a];
    const P = [a, b, c];
    // O hardware interpola com gradientes truncados a 12 bits fracionários a partir do 1º vértice (+0,5 de arredondamento).
    // Reproduz o mesmo plano ajustando o valor de cada vértice: a interpolação linear da GPU do PC dá exatamente esses valores.
    const trunc = Math.trunc, bx = b.x - a.x, by = b.y - a.y, cx = c.x - a.x, cy = c.y - a.y;
    const plane = (va, vb, vc) => {
      const nx = (vb - va) * cy - (vc - va) * by, ny = (vc - va) * bx - (vb - va) * cx;
      const gx = trunc(nx * 4096 / area) / 4096, gy = trunc(ny * 4096 / area) / 4096;
      return [va + 0.5, va + 0.5 + gx * bx + gy * by, va + 0.5 + gx * cx + gy * cy];
    };
    const U = o.tex ? plane(a.u, b.u, c.u) : [0, 0, 0], V = o.tex ? plane(a.v, b.v, c.v) : [0, 0, 0];
    const R = o.gour ? plane(a.r, b.r, c.r) : null, G = o.gour ? plane(a.g, b.g, c.g) : null, B = o.gour ? plane(a.b, b.b, c.b) : null;
    for (let k = 0; k < 3; k++) this.pv(P[k].x + s, P[k].y + s, R ? R[k] : a.r, G ? G[k] : a.g, B ? B[k] : a.b, U[k], V[k]);
    this.end(kind);
  }

  rect(x0, y0, w, h, o) {
    const g = this.gpu;
    if (w <= 0 || h <= 0) return;
    if (x0 > g.daX2 || y0 > g.daY2 || x0 + w - 1 < g.daX1 || y0 + h - 1 < g.daY1) return;
    const kind = this.begin(o.tex, o.semi, o.raw, false, o.clutX, o.clutY, x0, y0, x0 + w - 1, y0 + h - 1, 6);
    let ul = o.u0, ur = o.u0 + w, vt = o.v0, vb = o.v0 + h;
    if (o.flipX) { ul = o.u0 + 1.5; ur = ul - w; }          // pixel x amostra u0+1-x (centro do pixel = x+0,5)
    if (o.flipY) { vt = o.v0 + 0.5; vb = vt - h; }          // flip Y: v0-y
    const x1 = x0 + w, y1 = y0 + h, r = o.r, gg = o.g, b = o.b;
    this.pv(x0, y0, r, gg, b, ul, vt); this.pv(x1, y0, r, gg, b, ur, vt); this.pv(x0, y1, r, gg, b, ul, vb);
    this.pv(x1, y0, r, gg, b, ur, vt); this.pv(x1, y1, r, gg, b, ur, vb); this.pv(x0, y1, r, gg, b, ul, vb);
    this.end(kind);
  }

  /** linha: reproduz exatamente os pixels do rasterizador por software (DDA), 1 quad de 1 pixel nativo cada */
  line(x0, y0, x1, y1, c0, c1, semi, gour) {
    const g = this.gpu;
    const dith = g.dither;                                            // linhas flat também recebem dithering (medido)
    const minX = Math.min(x0, x1), maxX = Math.max(x0, x1), minY = Math.min(y0, y1), maxY = Math.max(y0, y1);
    if (maxX < g.daX1 || minX > g.daX2 || maxY < g.daY1 || minY > g.daY2) return;
    const adx = Math.abs(x1 - x0), ady = Math.abs(y1 - y0), k = Math.max(adx, ady);
    if (adx >= 1024 || ady >= 512) return;                            // fora do limite do hardware
    const kind = this.begin(false, semi, false, dith, 0, 0, minX, minY, maxX, maxY, (k + 1) * 6);
    // mesmo algoritmo do rasterizador por software (passo 32.32 arredondado para longe do zero, pixel = floor(pos + 0,5 - eps))
    let ax = x0, ay = y0, bx = x1, by = y1, ca = c0, cb = c1;
    if (ax >= bx && k) { ax = x1; ay = y1; bx = x0; by = y0; ca = c1; cb = c0; }
    const div = d => { if (k === 0) return 0; const q = d * 4294967296 / k; return (q < 0 ? Math.floor(q) : Math.ceil(q)) / 4294967296; };
    const sx = div(bx - ax), sy = div(by - ay);
    let px = ax + 0.5 - 1 / 4194304, py = ay + 0.5;
    const r0 = ca & 255, g0 = (ca >> 8) & 255, b0 = (ca >> 16) & 255;
    const kk = k || 1, dr = Math.trunc((((cb & 255) - r0) * 4096) / kk), dg = Math.trunc(((((cb >> 8) & 255) - g0) * 4096) / kk), db = Math.trunc(((((cb >> 16) & 255) - b0) * 4096) / kk);
    for (let i = 0; i <= k; i++, px += sx, py += sy) {
      const x = Math.floor(px), y = Math.floor(py);
      let r = r0, gg = g0, b = b0;
      if (gour) { r = ((r0 << 12) + 2048 + dr * i) >> 12; gg = ((g0 << 12) + 2048 + dg * i) >> 12; b = ((b0 << 12) + 2048 + db * i) >> 12; }
      this.pv(x, y, r, gg, b, 0, 0); this.pv(x + 1, y, r, gg, b, 0, 0); this.pv(x, y + 1, r, gg, b, 0, 0);
      this.pv(x + 1, y, r, gg, b, 0, 0); this.pv(x + 1, y + 1, r, gg, b, 0, 0); this.pv(x, y + 1, r, gg, b, 0, 0);
    }
    this.end(kind);
  }

  // ------------------------------------------------------------------ desenho do lote
  setBlend(mode) {
    const gl = this.gl; gl.enable(gl.BLEND);
    switch (mode) {
      case 0: gl.blendColor(0, 0, 0, 0.5); gl.blendEquationSeparate(gl.FUNC_ADD, gl.FUNC_ADD); gl.blendFuncSeparate(gl.CONSTANT_ALPHA, gl.CONSTANT_ALPHA, gl.ONE, gl.ZERO); break;
      case 1: gl.blendEquationSeparate(gl.FUNC_ADD, gl.FUNC_ADD); gl.blendFuncSeparate(gl.ONE, gl.ONE, gl.ONE, gl.ZERO); break;
      case 2: gl.blendEquationSeparate(gl.FUNC_REVERSE_SUBTRACT, gl.FUNC_ADD); gl.blendFuncSeparate(gl.ONE, gl.ONE, gl.ONE, gl.ZERO); break;
      default: gl.blendColor(0, 0, 0, 0.25); gl.blendEquationSeparate(gl.FUNC_ADD, gl.FUNC_ADD); gl.blendFuncSeparate(gl.CONSTANT_ALPHA, gl.ONE, gl.ONE, gl.ZERO);
    }
  }

  flush() {
    if (!this.n || !this.gpu) { this.n = 0; return; }
    const gl = this.gl, g = this.gpu, S = this.scale, n = this.n;
    const p = this.pb;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboH); gl.viewport(0, 0, this.W, this.H);
    gl.enable(gl.SCISSOR_TEST);
    const bs = this.bs, x1 = Math.min(bs.x2, VW - 1), y1 = Math.min(bs.y2, VH - 1);
    gl.scissor(bs.x1 * S, bs.y1 * S, Math.max(0, x1 - bs.x1 + 1) * S, Math.max(0, y1 - bs.y1 + 1) * S);
    gl.colorMask(true, true, true, true);
    this.applyMask(bs.set, bs.check);
    gl.useProgram(this.prim.p);
    gl.uniform1f(this.prim.u.u_scale, S); gl.uniform1i(this.prim.u.u_setMask, bs.set); gl.uniform1i(this.prim.u.u_rowMask, bs.mk); gl.uniform1i(this.prim.u.u_vram, 0);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.texN);
    gl.bindVertexArray(this.vao); gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.f32, 0, n * STRIDE_W);
    const kind = this.batchKind;
    if (kind === 0) { gl.disable(gl.BLEND); gl.uniform1i(this.prim.u.u_pass, 0); gl.drawArrays(gl.TRIANGLES, 0, n); }
    else if (kind === 1) { this.setBlend(this.batchSemi); gl.uniform1i(this.prim.u.u_pass, 0); gl.drawArrays(gl.TRIANGLES, 0, n); gl.disable(gl.BLEND); }
    else {
      gl.disable(gl.BLEND); gl.uniform1i(this.prim.u.u_pass, 1); gl.drawArrays(gl.TRIANGLES, 0, n);
      this.setBlend(this.batchSemi); gl.uniform1i(this.prim.u.u_pass, 2); gl.drawArrays(gl.TRIANGLES, 0, n); gl.disable(gl.BLEND);
    }
    gl.bindVertexArray(null);
    if (p[2] >= 0) this.markDirty(p[0], p[1], p[2], p[3]);
    this.pb = [1e9, 1e9, -1, -1]; this.n = 0;
  }

  // ------------------------------------------------------------------ saída
  /** desenha a área de display no canvas */
  present(gpu) {
    this.flush();
    const gl = this.gl, S = this.scale, w = gpu.width, h = gpu.height;
    const outS = Math.max(1, Math.min(S, Math.floor(3840 / w)));
    const cw = w * outS, ch = h * outS;
    if (this.canvas.width !== cw || this.canvas.height !== ch) { this.canvas.width = cw; this.canvas.height = ch; }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, cw, ch);
    gl.disable(gl.SCISSOR_TEST); gl.disable(gl.BLEND); gl.disable(gl.STENCIL_TEST); gl.colorMask(true, true, true, true);
    if (!gpu.dispOn) { gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT); return; }
    gl.useProgram(this.pres.p); gl.uniform1i(this.pres.u.u_ndc, 1); gl.uniform1i(this.pres.u.u_tex, 1);
    gl.activeTexture(gl.TEXTURE1);
    if (gpu.rgb24) {
      const vw = Math.ceil(w * 1.5) + 1;
      this.rects(gpu.startX, gpu.startY, vw, h, (x, y, rw, rh) => this.syncNative(x, y, rw, rh));
      if (!this.rgba || this.rgba.length !== w * h * 4) this.rgba = new Uint8ClampedArray(w * h * 4);
      gpu.renderRGBA(this.rgba);
      gl.bindTexture(gl.TEXTURE_2D, this.texVid);
      if (this.vidW !== w || this.vidH !== h) { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null); this.vidW = w; this.vidH = h; }   // aloca 1x; depois só atualiza (menos custo no driver)
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, this.rgba);
      this.setFilter(this.texVid, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.drawQuad(-1, 1, 2, -2, 0, 0, 1, 1, true);
    } else {
      const dt = (g2 => g2.interlace && g2.vres && this.dispKey)(gpu) ? this.texDisp : this.texH;      // 480i: dois últimos campos completos
      gl.bindTexture(gl.TEXTURE_2D, dt);
      this.setFilter(dt, (outS === S || !this.opts.smooth) ? gl.NEAREST : gl.LINEAR);
      if (dt === this.texDisp && gpu.deint) {                                            // 480i: desentrelaça na apresentação
        const dp = this.deintP; gl.useProgram(dp.p); gl.uniform1i(dp.u.u_ndc, 1); gl.uniform1i(dp.u.u_tex, 1);
        gl.uniform1i(dp.u.u_par, this.lastPar | 0); gl.uniform1i(dp.u.u_mode, gpu.deint); gl.uniform1f(dp.u.u_thr, DEINT_THR / 255); gl.uniform1f(dp.u.u_dv, 1 / 512);
      }
      const u0 = gpu.startX / VW, v0 = gpu.startY / VH, u1 = (gpu.startX + w) / VW, v1 = (gpu.startY + h) / VH;
      this.drawQuad(-1, 1, 2, -2, u0, v0, u1, v1, true);
    }
    gl.activeTexture(gl.TEXTURE0);
    gpu.frameCount++;
  }

  /** lê a área de display em RGBA8 (linhas de cima para baixo) na resolução interna - para testes/capturas */
  readDisplay(gpu) {
    this.flush();
    const gl = this.gl, S = this.scale, w = gpu.width, h = gpu.height;
    if (gpu.rgb24 || !gpu.dispOn) { this.syncNative(0, 0, VW, VH); const r = gpu.renderRGBA(); return { data: r.data, width: r.width, height: r.height, scale: 1 }; }
    const out = new Uint8ClampedArray(w * S * h * S * 4), tmp = new Uint8Array(w * S * h * S * 4);
    // lê em até 4 pedaços (wrap)
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.fboH);
    this.rects(gpu.startX, gpu.startY, w, h, (x, y, rw, rh) => {
      const buf = new Uint8Array(rw * S * rh * S * 4);
      gl.readPixels(x * S, y * S, rw * S, rh * S, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      const ox = ((x - gpu.startX) & 1023) * S, oy = ((y - gpu.startY) & 511) * S;
      for (let r = 0; r < rh * S; r++) tmp.set(buf.subarray(r * rw * S * 4, (r + 1) * rw * S * 4), ((oy + r) * w * S + ox) * 4);
    });
    for (let i = 0; i < tmp.length; i += 4) {
      const r5 = Q5[tmp[i]], g5 = Q5[tmp[i + 1]], b5 = Q5[tmp[i + 2]];
      let r = r5 << 3, gg = g5 << 3, b = b5 << 3; r |= r >> 5; gg |= gg >> 5; b |= b >> 5;
      out[i] = r; out[i + 1] = gg; out[i + 2] = b; out[i + 3] = 255;
    }
    return { data: out, width: w * S, height: h * S, scale: S };
  }
}

return { GLRenderer };
})();
const __web_video_out = (() => {
const { GLRenderer } = __src_glgpu;
// Saída de vídeo: apresenta a área de display da VRAM num <canvas>
class VideoOut {
  constructor(canvas) { this.canvas = canvas; this.ctx = canvas.getContext('2d'); this.img = null; }
  present(gpu) {
    const w = gpu.width, h = gpu.height;
    if (!this.img || this.img.width !== w || this.img.height !== h) {
      this.canvas.width = w; this.canvas.height = h; this.img = this.ctx.createImageData(w, h);
    }
    gpu.renderRGBA(this.img.data);
    this.ctx.putImageData(this.img, 0, 0);
  }
}

/** Apresentação via WebGL2 com resolução interna escalável (usa GLRenderer; a GPU deixa de rasterizar por software) */
class GLVideoOut {
  constructor(canvas, scale, psx, opts = {}) {
    this.psx = psx; this.r = new GLRenderer(canvas, scale, opts); this.scale = this.r.scale;
    this.r.attach(psx.gpu);
  }
  present(gpu) { this.r.present(gpu); }
  dispose() { this.r.detach(); }
}

return { VideoOut, GLVideoOut };
})();
const __web_audio_out = (() => {
// Saída de áudio: reprodução em taxa FIXA (44,1 kHz, sem reamostragem nem controle de velocidade), então o tom nunca muda.
// Fila de blocos com pré-buffer curto: se o emulador atrasa, há silêncio até a fila reabastecer (sem alterar o tom);
// se ele "recupera" em rajada, o excesso acima do limite de latência é descartado.
class PCMPull {
  constructor() { this.q = []; this.cur = null; this.pos = 0; this.fill = 0; this.primeAt = 1764; this.maxFill = 8820; this.primed = false; this.under = 0; this.drops = 0; this.lastL = 0; this.lastR = 0; this.fadeIn = 0; this.fo = 64; this.fl = 0; this.fr = 0; }
  push(b) {
    this.q.push(b); this.fill += b.length >> 1;
    while (this.fill > this.maxFill && this.q.length > 1) { const d = this.q.shift(); this.fill -= d.length >> 1; this.drops++; }   // latência limitada (~200 ms)
  }
  /** preenche de `from` até o fim com silêncio, terminando a descida suave (64 amostras) que pode atravessar blocos */
  silence(L, R, from) {
    const n = L.length;
    for (let j = from; j < n; j++) {
      if (this.fo < 64) { const k = 1 - (this.fo + 1) / 64; L[j] = this.fl * k; R[j] = this.fr * k; this.fo++; } else { L[j] = R[j] = 0; }
    }
    this.lastL = this.lastR = 0;
  }
  pull(L, R) {
    const n = L.length;
    if (!this.primed) {
      if (this.fill >= this.primeAt) { this.primed = true; this.fadeIn = this.under > 0 ? 64 : 0; }
      else { this.silence(L, R, 0); return; }
    }
    for (let i = 0; i < n; i++) {
      if (!this.cur || this.pos >= this.cur.length) {
        this.cur = this.q.shift() || null; this.pos = 0;
        if (!this.cur) {                                                                              // esvaziou: some suavemente (sem estalo) e espera reabastecer
          this.primed = false; this.under++; this.fl = this.lastL; this.fr = this.lastR; this.fo = 0;
          this.silence(L, R, i); return;
        }
      }
      let l = this.cur[this.pos++] / 32768, r = this.cur[this.pos++] / 32768; this.fill--;
      if (this.fadeIn > 0) { const g = 1 - this.fadeIn / 64; l *= g; r *= g; this.fadeIn--; }          // entrada suave após esvaziar
      L[i] = this.lastL = l; R[i] = this.lastR = r;
    }
  }
}

const WORKLET = `${PCMPull.toString()}
class PS1Out extends AudioWorkletProcessor {
  constructor() {
    super(); this.p = new PCMPull(); this.p.maxFill = 13230; this.ext = null; this.n = 0;      // teto de 300 ms: a meta adaptativa chega a 160 ms e uma rajada de 3 quadros soma ~50 ms
    // canal direto emulador(Worker) -> áudio: o áudio não passa pela thread principal (UI/GC não causam falhas) e volta o nível do buffer
    this.port.onmessage = e => { const d = e.data; if (d && d.ch) { this.ext = d.ch; this.ext.onmessage = ev => this.p.push(ev.data); } else this.p.push(d); };
  }
  process(_, outs) {
    const o = outs[0], n = o[0].length; this.p.pull(o[0], o[1]); this.n += n;
    if (this.ext && this.n >= 2205) { this.n = 0; this.ext.postMessage({ ms: this.p.fill / 44.1, under: this.p.under, drops: this.p.drops }); }
    return true;
  }
}
registerProcessor('ps1-out', PS1Out);`;

class AudioOut {
  async start() {                                  // precisa de um gesto do usuário (clique)
    this.ctx = new AudioContext({ sampleRate: 44100 });
    this.pull = new PCMPull(); this.pull.maxFill = 13230;
    try {
      if (!this.ctx.audioWorklet) throw new Error('sem AudioWorklet');
      try { await this.ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }))); }
      catch { await this.ctx.audioWorklet.addModule('data:text/javascript,' + encodeURIComponent(WORKLET)); }      // file://: o Chrome recusa módulo por blob:, mas aceita data: (antes caía no ScriptProcessor, que roda na thread principal)
      this.node = new AudioWorkletNode(this.ctx, 'ps1-out', { outputChannelCount: [2] });
      this.node.connect(this.ctx.destination);
      this.mode = 'worklet';
    } catch (e) {                                  // fallback (ex.: file:// bloqueando o worklet)
      const sp = this.ctx.createScriptProcessor(2048, 0, 2);
      sp.onaudioprocess = ev => this.pull.pull(ev.outputBuffer.getChannelData(0), ev.outputBuffer.getChannelData(1));
      sp.connect(this.ctx.destination); this.node = sp; this.mode = 'scriptprocessor';
    }
    await this.ctx.resume();
  }
  /** cria o canal direto Worker -> AudioWorklet; devolve a porta para o Worker (ou null se não há worklet) */
  channel() {
    if (this.mode !== 'worklet') return null;
    const ch = new MessageChannel(); this.node.port.postMessage({ ch: ch.port1 }, [ch.port1]); return ch.port2;
  }
  push(int16) {                                    // int16 = L,R,L,R...
    if (this.mode === 'worklet') this.node.port.postMessage(int16);
    else this.pull.push(int16);
  }
}

return { PCMPull, AudioOut };
})();
const __web_remote = (() => {
// Lado da página do modo Worker: fala com web/worker.js. Expõe `sio` compatível com o InputManager (repassa botões/analógicos).
class SioProxy {
  constructor(owner) {
    this.o = owner; this.padType = ['digital', 'digital']; this.onRumble = null; this.cards = [null, null]; this.cache = new Map();
    const self = this;
    this.padConnected = new Proxy([true, false], { set(t, k, v) { if (t[k] !== v) { t[k] = v; self.o.call_('padConnected', [+k, v]); } return true; } });
  }
  setButton(name, pressed, port = 0) { const k = 'b' + port + name; if (this.cache.get(k) === pressed) return; this.cache.set(k, pressed); this.o.call_('setButton', [name, pressed, port]); }
  setStick(name, value, port = 0) { const k = 's' + port + name, v = Math.max(0, Math.min(255, Math.round(value))); if (this.cache.get(k) === v) return; this.cache.set(k, v); this.o.call_('setStick', [name, v, port]); }
  setPadType(port, type) { this.padType[port] = type; this.cache.clear(); this.o.call_('setPadType', [port, type]); }
  toggleAnalog(port = 0) { this.o.post({ t: 'analog', port }); return null; }
}

class RemoteMachine {
  /** src = texto do worker (bundle + worker.js), gerado por build.js em PS1_WORKER_SRC */
  constructor(src) {
    this.url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
    this.w = new Worker(this.url); this.pending = new Map(); this.nid = 0; this.calls = []; this.on = {};
    this.game = 'sem-disco'; this.cardInfo = ['', '']; this.haveCard = [false, false]; this.hasDisc = false;
    this.sio = new SioProxy(this);
    this.w.onmessage = e => { const m = e.data; if (m.t === 'res') { const p = this.pending.get(m.id); this.pending.delete(m.id); if (p) m.ok ? p.res(m.value) : p.rej(new Error(m.err)); } else this.on[m.t]?.(m); };
    this.w.onerror = e => this.on.crash?.({ msg: e.message || 'erro no Worker', report: `${e.message} (${e.filename || ''}:${e.lineno || ''})` });
  }
  post(m, tr) { this.w.postMessage(m, tr || []); }
  call_(f, a) { this.calls.push([f, a]); }
  flush() { if (this.calls.length) { this.post({ t: 'sio', calls: this.calls }); this.calls = []; } }
  req(op, data = {}, tr) { return new Promise((res, rej) => { const id = ++this.nid; this.pending.set(id, { res, rej }); this.post({ t: 'req', id, op, ...data }, tr); }); }
  terminate() { this.w.terminate(); URL.revokeObjectURL(this.url); }
}

return { RemoteMachine };
})();
global.PS1 = Object.assign({}, __src_gte, __src_cpu, __src_jit, __src_wasmbin, __src_wasmcpu, __src_disasm, __src_bus, __src_gpu, __src_gauss, __src_spu, __src_disc, __src_scheduler, __src_timers, __src_dma, __src_mdec, __src_memcard, __src_sio, __src_cdrom, __src_state, __src_psx, __src_input, __src_debug, __src_glgpu, __web_video_out, __web_audio_out, __web_remote);
})(typeof window !== 'undefined' ? window : globalThis);

var PS1_WORKER_SRC = "/* PS1 Emu - bundle gerado por build.js (não edite) */\n(function (global) {\n\"use strict\";\nconst __src_gte = (() => {\n// ============================================================================\n//  GTE (COP2) - Geometry Transformation Engine\n//  Registradores: 32 de dados (cop2r0-31) e 32 de controle (cop2r32-63), acessados por\n//  MFC2/MTC2/CFC2/CTC2/LWC2/SWC2 (a CPU passa 0..31; os de controle são somados a 32 aqui)\n//  e por comandos \"cop2 imm25\".\n//\n//  Aritmética: MAC1-3 acumulam em 44 bits com sinal (detecção de overflow a cada soma),\n//  MAC0 em 32 bits. Os valores cabem em doubles (< 2^53), então usamos Number puro (sem BigInt).\n//  Flags (reg 63): bits 30-25 overflow MAC1-3 (+/-), 24-22 IR1-3 saturado, 21-19 FIFO de cor,\n//  18 SZ3/OTZ, 17 divisão, 16/15 MAC0 (+/-), 14/13 SX2/SY2, 12 IR0; bit 31 = erro (OU de 30-23 e 18-13).\n//\n//  Comando (25 bits): b5-0 opcode, b10 lm, b14-13 MVMVA translation, b16-15 MVMVA vetor,\n//  b18-17 MVMVA matriz, b19 sf (1 = resultado >> 12).\n//  Não emulado: ciclos reais de cada comando (a CPU não \"trava\" lendo registrador ocupado).\n// ============================================================================\nconst M44 = 17592186044416, H44 = 8796093022208;                 // 2^44, 2^43\nconst wrap44 = v => (v >= H44 || v < -H44) ? ((((v + H44) % M44) + M44) % M44) - H44 : v;\nconst trunc32 = v => (v >= -2147483648 && v <= 2147483647) ? v : ((((v % 4294967296) + 4294967296) % 4294967296) | 0);\nconst s16 = v => (v << 16) >> 16;\nconst clampv = (v, lo, hi) => v < lo ? lo : v > hi ? hi : v;\nconst sar = (v, sf) => sf ? Math.floor(v / 4096) : v;            // sf = 0 ou 1  (>> 12)\n\n// tabela da divisão Newton-Raphson (UNR): max(0, ((0x40000/(i+0x100)+1)/2) - 0x101)\nconst UNR = new Int32Array(257);\nfor (let i = 0; i <= 256; i++) UNR[i] = Math.max(0, ((((0x40000 / (i + 0x100)) | 0) + 1) >> 1) - 0x101);\n\nclass GTE {\n  constructor() {\n    this.d = new Int32Array(32); this.c = new Int32Array(64);     // c indexado por nº do registrador (32..63)\n    this.rt = new Int16Array(9); this.ll = new Int16Array(9); this.lc = new Int16Array(9);\n    this.flag = 0; this.commandCount = 0; this.lastCommand = 0;\n  }\n  reset() { this.d.fill(0); this.c.fill(0); this.rt.fill(0); this.ll.fill(0); this.lc.fill(0); this.flag = 0; }\n\n  // ---------------------------------------------------------------- registradores\n  readData(i) {\n    const d = this.d;\n    switch (i) {\n      case 1: case 3: case 5: case 8: case 9: case 10: case 11: return s16(d[i]);       // VZn, IR0-3\n      case 7: case 16: case 17: case 18: case 19: return d[i] & 0xFFFF;                 // OTZ, SZ0-3\n      case 15: return d[14];                                                            // SXYP lê SXY2\n      case 28: case 29: return this.orgb();\n      case 31: return this.lzcr();\n      default: return d[i];\n    }\n  }\n  writeData(i, v) {\n    const d = this.d; v |= 0;\n    switch (i) {\n      case 1: case 3: case 5: case 8: case 9: case 10: case 11: d[i] = s16(v); return;\n      case 7: case 16: case 17: case 18: case 19: d[i] = v & 0xFFFF; return;\n      case 15: d[12] = d[13]; d[13] = d[14]; d[14] = v; return;                         // SXYP: empurra a FIFO\n      case 28: d[28] = v; d[9] = (v & 0x1F) * 0x80; d[10] = ((v >> 5) & 0x1F) * 0x80; d[11] = ((v >> 10) & 0x1F) * 0x80; return;\n      case 29: case 31: return;                                                         // somente leitura\n      default: d[i] = v;\n    }\n  }\n  orgb() { const d = this.d, f = x => clampv(s16(x) >> 7, 0, 0x1F); return f(d[9]) | (f(d[10]) << 5) | (f(d[11]) << 10); }\n  lzcr() { const v = this.d[30]; return v >= 0 ? Math.clz32(v) : Math.clz32(~v); }      // bits iguais ao sinal (v=0 -> 32)\n\n  /** CFC2: n = 0..31 (cop2r32..63) */\n  readCtrl(n) {\n    const i = n + 32, c = this.c;\n    switch (i) {\n      case 36: case 44: case 52: case 59: case 61: case 62: case 58: return s16(c[i]);  // RT33/L33/LB3, DQA, ZSF, H (H lê com sinal: bug do hw)\n      case 63: return (this.flag | ((this.flag & 0x7F87E000) ? 0x80000000 : 0)) | 0;\n      default: return c[i];\n    }\n  }\n  /** CTC2 */\n  writeCtrl(n, v) {\n    const i = n + 32; v |= 0; const c = this.c;\n    if (i === 63) { this.flag = v & 0x7FFFF000; return; }\n    c[i] = i === 58 ? (v & 0xFFFF) : v;                                                  // H é unsigned 16 em uso\n    if (i <= 36) this.unpack(this.rt, 32);\n    else if (i >= 40 && i <= 44) this.unpack(this.ll, 40);\n    else if (i >= 48 && i <= 52) this.unpack(this.lc, 48);\n  }\n  unpack(m, base) { const c = this.c; for (let e = 0; e < 9; e++) { const w = c[base + (e >> 1)]; m[e] = (e & 1) ? (w >> 16) : s16(w); } }\n\n  // ---------------------------------------------------------------- utilitários de cálculo\n  chk(i, v) {                                                                            // MAC1-3: flags de overflow 44 bits\n    if (v >= H44) this.flag |= 1 << (31 - i); else if (v < -H44) this.flag |= 1 << (28 - i);\n    return wrap44(v);\n  }\n  chk0(v) { if (v > 2147483647) this.flag |= 1 << 16; else if (v < -2147483648) this.flag |= 1 << 15; return v; }\n  setMac(i, v, sf) { const m = trunc32(sar(v, sf)); this.d[24 + i] = m; return m; }\n  setIr(i, v, lm) {\n    const lo = lm ? 0 : -0x8000; let r = v;\n    if (v < lo) { r = lo; this.flag |= 1 << (25 - i); } else if (v > 0x7FFF) { r = 0x7FFF; this.flag |= 1 << (25 - i); }\n    this.d[8 + i] = r;\n  }\n  setMacIr(i, v, sf, lm) { this.setIr(i, this.setMac(i, v, sf), lm); }\n  pushSZ(v) {\n    const d = this.d; let r = v;\n    if (v < 0) { r = 0; this.flag |= 1 << 18; } else if (v > 0xFFFF) { r = 0xFFFF; this.flag |= 1 << 18; }\n    d[16] = d[17]; d[17] = d[18]; d[18] = d[19]; d[19] = r;\n  }\n  pushSXY(x, y) {\n    const d = this.d;\n    if (x < -0x400) { x = -0x400; this.flag |= 1 << 14; } else if (x > 0x3FF) { x = 0x3FF; this.flag |= 1 << 14; }\n    if (y < -0x400) { y = -0x400; this.flag |= 1 << 13; } else if (y > 0x3FF) { y = 0x3FF; this.flag |= 1 << 13; }\n    d[12] = d[13]; d[13] = d[14]; d[14] = (y << 16) | (x & 0xFFFF);\n  }\n  pushColor() {                                                                          // FIFO de cor a partir de MAC1-3 >> 4\n    const d = this.d; let cc = 0;\n    for (let i = 0; i < 3; i++) {\n      let v = d[25 + i] >> 4;\n      if (v < 0) { v = 0; this.flag |= 1 << (21 - i); } else if (v > 255) { v = 255; this.flag |= 1 << (21 - i); }\n      cc |= v << (8 * i);\n    }\n    d[20] = d[21]; d[21] = d[22]; d[22] = (cc | (d[6] & 0xFF000000)) | 0;\n  }\n  vec(n) { const d = this.d; return n === 0 ? [s16(d[0]), d[0] >> 16, s16(d[1])] : n === 1 ? [s16(d[2]), d[2] >> 16, s16(d[3])] : [s16(d[4]), d[4] >> 16, s16(d[5])]; }\n  ir() { const d = this.d; return [d[9], d[10], d[11]]; }\n  rgb() { const w = this.d[6]; return [w & 255, (w >> 8) & 255, (w >> 16) & 255]; }\n\n  /** MACi = (tr*0x1000 + M*v) >> sf ; IRi = lim(MACi). Devolve os 3 valores de 44 bits (antes do shift). */\n  mulMat(M, v, tr, sf, lm, setIr = true) {\n    const out = [0, 0, 0];\n    for (let r = 0; r < 3; r++) {\n      let t = tr ? tr[r] * 4096 : 0;\n      t = this.chk(r + 1, t + M[r * 3] * v[0]); t = this.chk(r + 1, t + M[r * 3 + 1] * v[1]); t = this.chk(r + 1, t + M[r * 3 + 2] * v[2]);\n      out[r] = t; this.setMac(r + 1, t, sf);\n      if (setIr) this.setIr(r + 1, this.d[25 + r], lm);\n    }\n    return out;\n  }\n\n  /** divisão UNR: ~ (H * 0x20000 / SZ3 + 1) / 2, saturada em 0x1FFFF */\n  divide(h, sz3) {\n    if (h >= sz3 * 2) { this.flag |= 1 << 17; return 0x1FFFF; }\n    const z = Math.clz32(sz3) - 16, n = h * Math.pow(2, z); let d = (sz3 << z) >>> 0;   // sz3 tratado como 16 bits\n    const u = UNR[(d - 0x7FC0) >> 7] + 0x101;\n    d = (0x2000080 - d * u) >> 8; d = (0x80 + d * u) >> 8;\n    return Math.min(0x1FFFF, Math.floor((n * d + 0x8000) / 65536));\n  }\n\n  // ---------------------------------------------------------------- comandos\n  command(cmd) {\n    this.commandCount++; this.lastCommand = cmd; this.flag = 0;\n    const sf = (cmd >> 19) & 1, lm = (cmd >> 10) & 1, c = this.c;\n    switch (cmd & 0x3F) {\n      case 0x01: this.rtp(0, true, sf, lm); break;                                       // RTPS\n      case 0x30: this.rtp(0, false, sf, lm); this.rtp(1, false, sf, lm); this.rtp(2, true, sf, lm); break;   // RTPT\n      case 0x06: this.nclip(); break;                                                    // NCLIP\n      case 0x0C: this.op(sf, lm); break;                                                 // OP\n      case 0x10: this.dpcs(this.rgb(), sf, lm); break;                                   // DPCS\n      case 0x2A: for (let i = 0; i < 3; i++) { const w = this.d[20]; this.dpcs([w & 255, (w >> 8) & 255, (w >> 16) & 255], sf, lm); } break;   // DPCT\n      case 0x11: this.intpl(sf, lm); break;                                              // INTPL\n      case 0x12: this.mvmva(cmd, sf, lm); break;                                         // MVMVA\n      case 0x13: this.nc(this.vec(0), 2, sf, lm); break;                                 // NCDS\n      case 0x16: for (let i = 0; i < 3; i++) this.nc(this.vec(i), 2, sf, lm); break;     // NCDT\n      case 0x1B: this.nc(this.vec(0), 1, sf, lm); break;                                 // NCCS\n      case 0x3F: for (let i = 0; i < 3; i++) this.nc(this.vec(i), 1, sf, lm); break;     // NCCT\n      case 0x1E: this.nc(this.vec(0), 0, sf, lm); break;                                 // NCS\n      case 0x20: for (let i = 0; i < 3; i++) this.nc(this.vec(i), 0, sf, lm); break;     // NCT\n      case 0x14: this.cdp(sf, lm); break;                                                // CDP\n      case 0x1C: this.cc(sf, lm); break;                                                 // CC\n      case 0x29: this.dcpl(sf, lm); break;                                               // DCPL\n      case 0x28: this.sqr(sf, lm); break;                                                // SQR\n      case 0x2D: this.avsz(s16(c[61]), 3); break;                                        // AVSZ3\n      case 0x2E: this.avsz(s16(c[62]), 4); break;                                        // AVSZ4\n      case 0x3D: this.gpf(sf, lm); break;                                                // GPF\n      case 0x3E: this.gpl(sf, lm); break;                                                // GPL\n      default: break;                                                                    // opcode inválido: sem efeito\n    }\n  }\n\n  /** transformação de perspectiva de um vértice (RTPS/RTPT) */\n  rtp(vi, last, sf, lm) {\n    const d = this.d, c = this.c, v = this.vec(vi), tr = [c[37], c[38], c[39]];\n    const t = this.mulMat(this.rt, v, tr, sf, lm, false);\n    this.setIr(1, d[25], lm); this.setIr(2, d[26], lm);\n    // IR3: valor saturado normalmente, mas a flag vem de (soma >> 12) (comportamento do hardware)\n    const z12 = Math.floor(t[2] / 4096);\n    if (z12 < -0x8000 || z12 > 0x7FFF) this.flag |= 1 << 22;\n    d[11] = clampv(d[27], lm ? 0 : -0x8000, 0x7FFF);\n    this.pushSZ(z12);\n    const n = this.divide(c[58] & 0xFFFF, d[19] & 0xFFFF);\n    const m0x = this.chk0(n * s16(d[9]) + c[56]), m0y = this.chk0(n * s16(d[10]) + c[57]);\n    d[24] = trunc32(m0y);\n    this.pushSXY(Math.floor(m0x / 65536), Math.floor(m0y / 65536));     // sem truncar em 32 bits: o hardware satura o valor completo\n    if (last) {\n      const m = this.chk0(n * s16(c[59]) + c[60]); d[24] = trunc32(m);\n      const ir0 = Math.floor(m / 4096);\n      d[8] = clampv(ir0, 0, 0x1000); if (ir0 < 0 || ir0 > 0x1000) this.flag |= 1 << 12;\n    }\n  }\n\n  nclip() {\n    const d = this.d, x0 = s16(d[12]), y0 = d[12] >> 16, x1 = s16(d[13]), y1 = d[13] >> 16, x2 = s16(d[14]), y2 = d[14] >> 16;\n    d[24] = trunc32(this.chk0(x0 * y1 + x1 * y2 + x2 * y0 - x0 * y2 - x1 * y0 - x2 * y1));\n  }\n\n  op(sf, lm) {                                                                           // produto vetorial com a diagonal de RT\n    const r = this.rt, ir = this.ir(), d1 = r[0], d2 = r[4], d3 = r[8];\n    this.setMacIr(1, this.chk(1, ir[2] * d2 - ir[1] * d3), sf, lm);\n    this.setMacIr(2, this.chk(2, ir[0] * d3 - ir[2] * d1), sf, lm);\n    this.setMacIr(3, this.chk(3, ir[1] * d1 - ir[0] * d2), sf, lm);\n  }\n\n  /** interpolação em direção à cor de distância (FC): usada por DPCS/INTPL/NCDS/CDP/DCPL */\n  interp(mac, sf, lm) {\n    const c = this.c, d = this.d, fc = [c[53], c[54], c[55]], ir0 = s16(d[8]);\n    for (let i = 0; i < 3; i++) {\n      const diff = this.chk(i + 1, fc[i] * 4096 - mac[i]);\n      this.setIr(i + 1, trunc32(sar(diff, sf)), false);\n      const v = this.chk(i + 1, s16(d[9 + i]) * ir0 + mac[i]);\n      this.setMacIr(i + 1, v, sf, lm);\n    }\n    this.pushColor();\n  }\n  dpcs(rgb, sf, lm) { this.interp([rgb[0] * 65536, rgb[1] * 65536, rgb[2] * 65536], sf, lm); }\n  intpl(sf, lm) { const ir = this.ir(); this.interp([ir[0] * 4096, ir[1] * 4096, ir[2] * 4096], sf, lm); }\n\n  /** normal color: matriz de luz e depois matriz de cor; mode 0=NCS 1=NCCS 2=NCDS */\n  nc(v, mode, sf, lm) {\n    this.mulMat(this.ll, v, null, sf, lm);\n    this.mulMat(this.lc, this.ir(), [this.c[45], this.c[46], this.c[47]], sf, lm);\n    if (mode === 0) { this.pushColor(); return; }\n    const rgb = this.rgb(), ir = this.ir();\n    if (mode === 1) { for (let i = 0; i < 3; i++) this.setMacIr(i + 1, this.chk(i + 1, rgb[i] * ir[i] * 16), sf, lm); this.pushColor(); return; }\n    this.interp([0, 1, 2].map(i => this.chk(i + 1, rgb[i] * ir[i] * 16)), sf, lm);\n  }\n  cdp(sf, lm) {\n    this.mulMat(this.lc, this.ir(), [this.c[45], this.c[46], this.c[47]], sf, lm);\n    const rgb = this.rgb(), ir = this.ir();\n    this.interp([0, 1, 2].map(i => this.chk(i + 1, rgb[i] * ir[i] * 16)), sf, lm);\n  }\n  cc(sf, lm) {\n    this.mulMat(this.lc, this.ir(), [this.c[45], this.c[46], this.c[47]], sf, lm);\n    const rgb = this.rgb(), ir = this.ir();\n    for (let i = 0; i < 3; i++) this.setMacIr(i + 1, this.chk(i + 1, rgb[i] * ir[i] * 16), sf, lm);\n    this.pushColor();\n  }\n  dcpl(sf, lm) {\n    const rgb = this.rgb(), ir = this.ir();\n    this.interp([0, 1, 2].map(i => this.chk(i + 1, rgb[i] * ir[i] * 16)), sf, lm);\n  }\n  sqr(sf, lm) { const ir = this.ir(); for (let i = 0; i < 3; i++) this.setMacIr(i + 1, ir[i] * ir[i], sf, lm); }\n  gpf(sf, lm) { const ir = this.ir(), ir0 = s16(this.d[8]); for (let i = 0; i < 3; i++) this.setMacIr(i + 1, this.chk(i + 1, ir[i] * ir0), sf, lm); this.pushColor(); }\n  gpl(sf, lm) {\n    const ir = this.ir(), ir0 = s16(this.d[8]);\n    for (let i = 0; i < 3; i++) this.setMacIr(i + 1, this.chk(i + 1, (sf ? this.d[25 + i] * 4096 : this.d[25 + i]) + ir[i] * ir0), sf, lm);\n    this.pushColor();\n  }\n  avsz(zsf, n) {\n    const d = this.d, z = i => d[i] & 0xFFFF;\n    const sum = n === 3 ? z(17) + z(18) + z(19) : z(16) + z(17) + z(18) + z(19);\n    const m = this.chk0(zsf * sum); d[24] = trunc32(m);\n    const o = Math.floor(m / 4096);                                                       // MAC0 sem truncar (hardware)\n    if (o < 0) { d[7] = 0; this.flag |= 1 << 18; } else if (o > 0xFFFF) { d[7] = 0xFFFF; this.flag |= 1 << 18; } else d[7] = o;\n  }\n\n  mvmva(cmd, sf, lm) {\n    const mx = (cmd >> 17) & 3, vx = (cmd >> 15) & 3, tx = (cmd >> 13) & 3, c = this.c, d = this.d;\n    const M = mx === 0 ? this.rt : mx === 1 ? this.ll : mx === 2 ? this.lc\n      : Int16Array.from([-((d[6] & 255) << 4), (d[6] & 255) << 4, s16(d[8]), this.rt[2], this.rt[2], this.rt[2], this.rt[4], this.rt[4], this.rt[4]]);   // matriz \"lixo\"\n    const v = vx === 3 ? this.ir() : this.vec(vx);\n    if (tx === 2) {                                                                      // translation FC: bug do hardware\n      for (let r = 0; r < 3; r++) {\n        const part = this.chk(r + 1, c[53 + r] * 4096 + M[r * 3] * v[0]);                  // só levanta flags; resultado descartado\n        const pv = sar(part, sf), lo = lm ? 0 : -0x8000;                                  // ...inclusive a de saturação de IR da soma parcial\n        if (pv < lo || pv > 0x7FFF) this.flag |= 1 << (24 - r);\n        const t = this.chk(r + 1, M[r * 3 + 1] * v[1] + M[r * 3 + 2] * v[2]);\n        this.setMac(r + 1, t, sf); this.setIr(r + 1, d[25 + r], lm);\n      }\n      return;\n    }\n    const tr = tx === 0 ? [c[37], c[38], c[39]] : tx === 1 ? [c[45], c[46], c[47]] : null;\n    this.mulMat(M, v, tr, sf, lm);\n  }\n}\n\nreturn { GTE };\n})();\nconst __src_cpu = (() => {\n// ============================================================================\n//  CPU MIPS R3000A (LSI LR33300) do PS1 - interpretador\n// ============================================================================\n//  Características emuladas:\n//   - 32 registradores + HI/LO\n//   - Branch delay slot (modelo pc / nextPc)\n//   - Load delay slot (1 instrução, com cancelamento e forwarding p/ LWL/LWR)\n//   - COP0: SR, CAUSE, EPC, BadVAddr, PRID, breakpoints (só armazenados)\n//   - Exceções (IRQ, AdEL, AdES, SYSCALL, BREAK, RI, CpU, Overflow)\n//   - Cache isolado (SR.IsC): escritas não chegam à memória\n//   - COP2 (GTE): acesso aos registradores; comandos ainda em stub\n//\n//  NÃO emulado ainda: I-Cache (só importa p/ código auto-modificável),\n//  timing real de MULT/DIV, bus error, write buffer, GTE.\n// ============================================================================\nconst { GTE } = __src_gte;\nconst EXC = { INT: 0, ADEL: 4, ADES: 5, IBE: 6, DBE: 7, SYS: 8, BP: 9, RI: 10, CPU: 11, OV: 12 };\n\nconst REG_NAMES = [\n  'zero', 'at', 'v0', 'v1', 'a0', 'a1', 'a2', 'a3',\n  't0', 't1', 't2', 't3', 't4', 't5', 't6', 't7',\n  's0', 's1', 's2', 's3', 's4', 's5', 's6', 's7',\n  't8', 't9', 'k0', 'k1', 'gp', 'sp', 'fp', 'ra',\n];\n\n// COP0 register indices\nconst C0_BPC = 3, C0_BDA = 5, C0_JUMPDEST = 6, C0_DCIC = 7, C0_BADVADDR = 8,\n      C0_BDAM = 9, C0_BPCM = 11, C0_SR = 12, C0_CAUSE = 13, C0_EPC = 14, C0_PRID = 15;\n\nconst SR_IEC = 0x1, SR_KUC = 0x2, SR_ISC = 0x10000, SR_BEV = 0x400000,\n      SR_CU0 = 0x10000000, SR_CU2 = 0x40000000;\nconst SR_WRITE_MASK = 0xF27FFF3F;\n\nconst RESET_VECTOR = 0xBFC00000;\n\n// custo extra (ciclos, além do 1 da instrução) de um load, por região e largura (1/2/4 bytes).\n// Valores medidos no PS1 real com ps1-tests/cpu/access-time (ciclos por acesso - 1).\nconst LD_RAM = 4;\nfunction memCost(a, size = 4) {\n  const p = a & 0x1FFFFFFF, k = size === 1 ? 0 : size === 2 ? 1 : 2;\n  if (p < 0x800000) return LD_RAM;                                                    // RAM\n  if (p >= 0x1FC00000) return [6, 12, 24][k];                                         // BIOS ROM (barramento de 8 bits)\n  if (p >= 0x1FA00000) return [6, 5, 9][k];                                           // expansão 3\n  if (p >= 0x1F800000) {\n    if (p < 0x1F800400) return 0;                                                     // scratchpad\n    if (p >= 0x1F802000) return [10, 25, 55][k];                                      // expansão 2\n    if (p >= 0x1F801C00) return [17, 17, 38][k];                                      // SPU\n    if (p >= 0x1F801800 && p < 0x1F801804) return [6, 13, 25][k];                     // CD-ROM\n    return 2;                                                                         // registradores de I/O\n  }\n  if (p >= 0x1F000000) return [5, 12, 24][k];                                         // expansão 1\n  return 3;\n}\n\nclass CPU {\n  constructor(bus) {\n    this.bus = bus;\n    this.gte = new GTE();\n    this.r = new Uint32Array(32);\n    this.cop0 = new Uint32Array(32);\n    this.reset();\n  }\n\n  reset() {\n    this.r.fill(0);\n    this.cop0.fill(0);\n    this.hi = 0; this.lo = 0;\n    this.pc = RESET_VECTOR;\n    this.nextPc = RESET_VECTOR + 4;\n    this.currentPc = this.pc;\n    this.isBranch = false;     // a instrução atual é um branch/jump?\n    this.inDelay = false;      // a instrução atual está num delay slot?\n    // load delay: carga pendente vinda da instrução anterior\n    this.pendReg = 0; this.pendVal = 0;\n    // carga gerada pela instrução atual (vira pendente no próximo passo)\n    this.nextLdReg = 0; this.nextLdVal = 0;\n    this.wr = 0;               // registrador escrito pela instrução atual\n    this.cop0[C0_SR] = SR_BEV; // BEV=1 após reset\n    this.cop0[C0_PRID] = 0x00000002;\n    this.cycles = 0;\n    this.instrCount = 0;\n  }\n\n  // -------------------------------------------------------------------------\n  //  Helpers\n  // -------------------------------------------------------------------------\n  setR(i, v) { this.r[i] = v; this.wr = i; }\n  setLoad(i, v) { this.nextLdReg = i; this.nextLdVal = v; }\n\n  jump(target) { this.nextPc = target >>> 0; this.isBranch = true; }\n\n  exception(code, cop = 0) {\n    const c0 = this.cop0;\n    const sr = c0[C0_SR];\n    const handler = (sr & SR_BEV) ? 0xBFC00180 : 0x80000080;\n    // empilha o modo: (KUo,IEo)<-(KUp,IEp)<-(KUc,IEc)<-0\n    c0[C0_SR] = (sr & 0xFFFFFFC0) | ((sr << 2) & 0x3F);\n    let cause = (c0[C0_CAUSE] & ~0x3000007C) | (code << 2) | (cop << 28);\n    if (this.inDelay) {\n      c0[C0_EPC] = (this.currentPc - 4) >>> 0;\n      cause |= 0x80000000;                       // BD\n    } else {\n      c0[C0_EPC] = this.currentPc;\n      cause &= 0x7FFFFFFF;\n    }\n    c0[C0_CAUSE] = cause;\n    this.pc = handler;\n    this.nextPc = (handler + 4) >>> 0;\n    this.isBranch = false;\n  }\n\n  addrError(addr, store) {\n    this.cop0[C0_BADVADDR] = addr;\n    this.exception(store ? EXC.ADES : EXC.ADEL);\n  }\n\n  // leitura/escrita de memória com checagem de alinhamento, modo usuário e cache isolado\n  rdMem(a, size) {\n    if ((a & (size - 1)) !== 0 || ((a & 0x80000000) && (this.cop0[C0_SR] & SR_KUC))) {\n      this.addrError(a, false); return null;\n    }\n    if (this.cop0[C0_SR] & SR_ISC) return 0;\n    this.cycles += memCost(a, size);                 // custo de acesso por região/largura\n    return this.bus.read(a, size);\n  }\n  wrMem(a, size, v) {\n    if ((a & (size - 1)) !== 0 || ((a & 0x80000000) && (this.cop0[C0_SR] & SR_KUC))) {\n      this.addrError(a, true); return false;\n    }\n    if (this.cop0[C0_SR] & SR_ISC) return true;   // cache isolado: escrita vai pra \"cache\" e some\n    this.bus.write(a, size, v);\n    return true;\n  }\n\n  writeCop0(n, v) {\n    const c0 = this.cop0;\n    switch (n) {\n      case C0_BPC: case C0_BDA: case C0_DCIC: case C0_BDAM: case C0_BPCM:\n        c0[n] = v; break;\n      case C0_SR: c0[C0_SR] = v & SR_WRITE_MASK; break;\n      case C0_CAUSE: c0[C0_CAUSE] = (c0[C0_CAUSE] & ~0x300) | (v & 0x300); break;\n      default: break;                              // BadVAddr/EPC/PRID/JUMPDEST: somente leitura\n    }\n  }\n\n  // multiplicação 32x32 -> 64 sem BigInt\n  mul64(a, b, signed) {\n    const a0 = a & 0xFFFF, a1 = a >>> 16, b0 = b & 0xFFFF, b1 = b >>> 16;\n    const p00 = a0 * b0, p01 = a0 * b1, p10 = a1 * b0, p11 = a1 * b1;\n    const mid = p01 + p10 + (p00 >>> 16);\n    this.lo = (((mid & 0xFFFF) << 16) | (p00 & 0xFFFF)) >>> 0;\n    let hi = p11 + Math.floor(mid / 65536);\n    if (signed) hi -= (a >>> 31 ? b : 0) + (b >>> 31 ? a : 0);\n    this.hi = hi >>> 0;\n  }\n\n  div(a, b) {\n    const n = a | 0, d = b | 0;\n    if (d === 0) { this.hi = n >>> 0; this.lo = n >= 0 ? 0xFFFFFFFF : 1; }\n    else if (n === -2147483648 && d === -1) { this.hi = 0; this.lo = 0x80000000; }\n    else { this.lo = ((n / d) | 0) >>> 0; this.hi = (n % d) >>> 0; }\n  }\n  divu(n, d) {\n    if (d === 0) { this.hi = n; this.lo = 0xFFFFFFFF; }\n    else { this.lo = Math.floor(n / d) >>> 0; this.hi = n % d; }\n  }\n\n  // -------------------------------------------------------------------------\n  //  Um passo = uma instrução\n  // -------------------------------------------------------------------------\n  step() {\n    const lr = this.pendReg, lv = this.pendVal;\n    this.nextLdReg = 0; this.wr = 0;\n\n    this.execute();\n\n    // aplica a carga da instrução anterior, a menos que esta tenha escrito o mesmo reg\n    if (lr !== 0 && lr !== this.wr) this.r[lr] = lv;\n    this.pendReg = this.nextLdReg; this.pendVal = this.nextLdVal;\n    this.r[0] = 0;\n    this.cycles++; this.instrCount++;\n  }\n\n  execute() {\n    const bus = this.bus, r = this.r, c0 = this.cop0;\n    const cur = this.pc;\n    this.currentPc = cur;\n    this.inDelay = this.isBranch;\n    this.isBranch = false;\n\n    // ---- interrupções ----\n    if (bus.irqPending()) c0[C0_CAUSE] |= 0x400; else c0[C0_CAUSE] &= ~0x400;\n    const sr = c0[C0_SR];\n    if ((sr & SR_IEC) && (c0[C0_CAUSE] & sr & 0xFF00)) { this.exception(EXC.INT); return; }\n\n    // ---- fetch ----\n    if (cur & 3) { c0[C0_BADVADDR] = cur; this.exception(EXC.ADEL); return; }\n    const w = bus.read(cur, 4);\n    if (cur >= 0xA0000000 && cur < 0xC0000000) this.cycles += (cur & 0x1FFFFFFF) >= 0x1FC00000 ? 22 : 4;   // fetch sem cache\n    this.pc = this.nextPc;\n    this.nextPc = (this.nextPc + 4) >>> 0;\n\n    const op = w >>> 26, rs = (w >>> 21) & 31, rt = (w >>> 16) & 31, rd = (w >>> 11) & 31;\n    const sh = (w >>> 6) & 31, imm = w & 0xFFFF, simm = (w << 16) >> 16;\n\n    switch (op) {\n      // ======================= SPECIAL =======================\n      case 0x00:\n        switch (w & 0x3F) {\n          case 0x00: this.setR(rd, r[rt] << sh); return;                    // SLL\n          case 0x02: this.setR(rd, r[rt] >>> sh); return;                   // SRL\n          case 0x03: this.setR(rd, (r[rt] | 0) >> sh); return;              // SRA\n          case 0x04: this.setR(rd, r[rt] << (r[rs] & 31)); return;          // SLLV\n          case 0x06: this.setR(rd, r[rt] >>> (r[rs] & 31)); return;         // SRLV\n          case 0x07: this.setR(rd, (r[rt] | 0) >> (r[rs] & 31)); return;    // SRAV\n          case 0x08: this.jump(r[rs]); return;                              // JR\n          case 0x09: { const t = r[rs]; this.setR(rd, cur + 8); this.jump(t); return; } // JALR\n          case 0x0C: this.exception(EXC.SYS); return;                       // SYSCALL\n          case 0x0D: this.exception(EXC.BP); return;                        // BREAK\n          case 0x10: this.setR(rd, this.hi); return;                        // MFHI\n          case 0x11: this.hi = r[rs]; return;                               // MTHI\n          case 0x12: this.setR(rd, this.lo); return;                        // MFLO\n          case 0x13: this.lo = r[rs]; return;                               // MTLO\n          case 0x18: this.mul64(r[rs], r[rt], true); return;                // MULT\n          case 0x19: this.mul64(r[rs], r[rt], false); return;               // MULTU\n          case 0x1A: this.div(r[rs], r[rt]); return;                        // DIV\n          case 0x1B: this.divu(r[rs], r[rt]); return;                       // DIVU\n          case 0x20: {                                                      // ADD\n            const a = r[rs] | 0, b = r[rt] | 0, s = (a + b) | 0;\n            if (((a ^ s) & (b ^ s)) < 0) { this.exception(EXC.OV); return; }\n            this.setR(rd, s); return;\n          }\n          case 0x21: this.setR(rd, r[rs] + r[rt]); return;                  // ADDU\n          case 0x22: {                                                      // SUB\n            const a = r[rs] | 0, b = r[rt] | 0, s = (a - b) | 0;\n            if (((a ^ b) & (a ^ s)) < 0) { this.exception(EXC.OV); return; }\n            this.setR(rd, s); return;\n          }\n          case 0x23: this.setR(rd, r[rs] - r[rt]); return;                  // SUBU\n          case 0x24: this.setR(rd, r[rs] & r[rt]); return;                  // AND\n          case 0x25: this.setR(rd, r[rs] | r[rt]); return;                  // OR\n          case 0x26: this.setR(rd, r[rs] ^ r[rt]); return;                  // XOR\n          case 0x27: this.setR(rd, ~(r[rs] | r[rt])); return;               // NOR\n          case 0x2A: this.setR(rd, (r[rs] | 0) < (r[rt] | 0) ? 1 : 0); return; // SLT\n          case 0x2B: this.setR(rd, r[rs] < r[rt] ? 1 : 0); return;          // SLTU\n          default: this.exception(EXC.RI); return;\n        }\n\n      // ======================= REGIMM (BLTZ/BGEZ/BLTZAL/BGEZAL) =======================\n      case 0x01: {\n        const v = r[rs] | 0;\n        const cond = (rt & 1) ? v >= 0 : v < 0;\n        if ((rt & 0x1E) === 0x10) this.setR(31, cur + 8);      // link sempre, mesmo sem tomar o branch\n        this.isBranch = true;\n        if (cond) this.nextPc = (cur + 4 + (simm << 2)) >>> 0;\n        return;\n      }\n\n      // ======================= Jumps =======================\n      case 0x02: this.nextPc = ((this.pc & 0xF0000000) | ((w & 0x3FFFFFF) << 2)) >>> 0; this.isBranch = true; return; // J\n      case 0x03: this.setR(31, cur + 8);                                                                              // JAL\n                 this.nextPc = ((this.pc & 0xF0000000) | ((w & 0x3FFFFFF) << 2)) >>> 0; this.isBranch = true; return;\n\n      // ======================= Branches =======================\n      case 0x04: this.isBranch = true; if (r[rs] === r[rt]) this.nextPc = (cur + 4 + (simm << 2)) >>> 0; return;  // BEQ\n      case 0x05: this.isBranch = true; if (r[rs] !== r[rt]) this.nextPc = (cur + 4 + (simm << 2)) >>> 0; return;  // BNE\n      case 0x06: this.isBranch = true; if ((r[rs] | 0) <= 0) this.nextPc = (cur + 4 + (simm << 2)) >>> 0; return; // BLEZ\n      case 0x07: this.isBranch = true; if ((r[rs] | 0) > 0)  this.nextPc = (cur + 4 + (simm << 2)) >>> 0; return; // BGTZ\n\n      // ======================= Imediatos =======================\n      case 0x08: {                                                          // ADDI\n        const a = r[rs] | 0, s = (a + simm) | 0;\n        if (((a ^ s) & (simm ^ s)) < 0) { this.exception(EXC.OV); return; }\n        this.setR(rt, s); return;\n      }\n      case 0x09: this.setR(rt, r[rs] + simm); return;                       // ADDIU\n      case 0x0A: this.setR(rt, (r[rs] | 0) < simm ? 1 : 0); return;         // SLTI\n      case 0x0B: this.setR(rt, r[rs] < (simm >>> 0) ? 1 : 0); return;       // SLTIU\n      case 0x0C: this.setR(rt, r[rs] & imm); return;                        // ANDI\n      case 0x0D: this.setR(rt, r[rs] | imm); return;                        // ORI\n      case 0x0E: this.setR(rt, r[rs] ^ imm); return;                        // XORI\n      case 0x0F: this.setR(rt, imm << 16); return;                          // LUI\n\n      // ======================= COP0 =======================\n      case 0x10:\n        if ((sr & SR_KUC) && !(sr & SR_CU0)) { this.exception(EXC.CPU, 0); return; }\n        switch (rs) {\n          case 0x00: this.setLoad(rt, c0[rd]); return;                      // MFC0 (tem load delay)\n          case 0x04: this.writeCop0(rd, r[rt]); return;                     // MTC0\n          case 0x10:\n            if ((w & 0x3F) === 0x10) {                                      // RFE\n              c0[C0_SR] = (sr & 0xFFFFFFF0) | ((sr >>> 2) & 0xF); return;\n            }\n            this.exception(EXC.RI); return;\n          default: return;                                                  // cop0 com rs desconhecido: não gera exceção no console (ps1-tests/cpu/cop)\n        }\n\n      // ======================= COP2 (GTE) =======================\n      case 0x12:\n        if (!(sr & SR_CU2)) { this.exception(EXC.CPU, 2); return; }\n        if (w & 0x02000000) { this.gte.command(w & 0x1FFFFFF); return; }    // comando GTE\n        switch (rs) {\n          case 0x00: this.setLoad(rt, this.gte.readData(rd)); return;       // MFC2\n          case 0x02: this.setLoad(rt, this.gte.readCtrl(rd)); return;       // CFC2\n          case 0x04: this.gte.writeData(rd, r[rt]); return;                 // MTC2\n          case 0x06: this.gte.writeCtrl(rd, r[rt]); return;                 // CTC2\n          default: this.exception(EXC.RI); return;\n        }\n\n      // COP1/COP3 e LWC/SWC 0,1,3 não existem no PS1 -> Coprocessor Unusable\n      // só geram a exceção se o bit CU do coprocessador estiver desligado; ligado, são NOPs\n      case 0x11: case 0x13: case 0x30: case 0x31: case 0x33: case 0x38: case 0x39: case 0x3B:\n        if (!(sr & (0x10000000 << (op & 3)))) this.exception(EXC.CPU, op & 3);\n        return;\n\n      // ======================= Loads =======================\n      case 0x20: { const v = this.rdMem((r[rs] + simm) >>> 0, 1); if (v === null) return; this.setLoad(rt, (v << 24) >> 24); return; } // LB\n      case 0x21: { const v = this.rdMem((r[rs] + simm) >>> 0, 2); if (v === null) return; this.setLoad(rt, (v << 16) >> 16); return; } // LH\n      case 0x23: { const v = this.rdMem((r[rs] + simm) >>> 0, 4); if (v === null) return; this.setLoad(rt, v); return; }               // LW\n      case 0x24: { const v = this.rdMem((r[rs] + simm) >>> 0, 1); if (v === null) return; this.setLoad(rt, v); return; }               // LBU\n      case 0x25: { const v = this.rdMem((r[rs] + simm) >>> 0, 2); if (v === null) return; this.setLoad(rt, v); return; }               // LHU\n      case 0x22: {                                                          // LWL\n        const a = (r[rs] + simm) >>> 0;\n        const m = this.rdMem((a & 0xFFFFFFFC) >>> 0, 4); if (m === null) return;\n        const c = (this.pendReg === rt) ? this.pendVal : r[rt];             // enxerga a carga em andamento\n        let v;\n        switch (a & 3) {\n          case 0: v = (c & 0x00FFFFFF) | (m << 24); break;\n          case 1: v = (c & 0x0000FFFF) | (m << 16); break;\n          case 2: v = (c & 0x000000FF) | (m << 8); break;\n          default: v = m;\n        }\n        this.setLoad(rt, v); return;\n      }\n      case 0x26: {                                                          // LWR\n        const a = (r[rs] + simm) >>> 0;\n        const m = this.rdMem((a & 0xFFFFFFFC) >>> 0, 4); if (m === null) return;\n        const c = (this.pendReg === rt) ? this.pendVal : r[rt];\n        let v;\n        switch (a & 3) {\n          case 0: v = m; break;\n          case 1: v = (c & 0xFF000000) | (m >>> 8); break;\n          case 2: v = (c & 0xFFFF0000) | (m >>> 16); break;\n          default: v = (c & 0xFFFFFF00) | (m >>> 24);\n        }\n        this.setLoad(rt, v); return;\n      }\n      case 0x32: { if (!(sr & SR_CU2)) { this.exception(EXC.CPU, 2); return; } const v = this.rdMem((r[rs] + simm) >>> 0, 4); if (v === null) return; this.gte.writeData(rt, v); return; } // LWC2\n\n      // ======================= Stores =======================\n      case 0x28: this.wrMem((r[rs] + simm) >>> 0, 1, r[rt] & 0xFF); return;   // SB\n      case 0x29: this.wrMem((r[rs] + simm) >>> 0, 2, r[rt] & 0xFFFF); return; // SH\n      case 0x2B: this.wrMem((r[rs] + simm) >>> 0, 4, r[rt]); return;          // SW\n      case 0x2A: {                                                          // SWL\n        const a = (r[rs] + simm) >>> 0, al = (a & 0xFFFFFFFC) >>> 0;\n        const m = this.rdMem(al, 4); if (m === null) return;\n        const t = r[rt]; let v;\n        switch (a & 3) {\n          case 0: v = (m & 0xFFFFFF00) | (t >>> 24); break;\n          case 1: v = (m & 0xFFFF0000) | (t >>> 16); break;\n          case 2: v = (m & 0xFF000000) | (t >>> 8); break;\n          default: v = t;\n        }\n        this.wrMem(al, 4, v >>> 0); return;\n      }\n      case 0x2E: {                                                          // SWR\n        const a = (r[rs] + simm) >>> 0, al = (a & 0xFFFFFFFC) >>> 0;\n        const m = this.rdMem(al, 4); if (m === null) return;\n        const t = r[rt]; let v;\n        switch (a & 3) {\n          case 0: v = t; break;\n          case 1: v = (m & 0x000000FF) | (t << 8); break;\n          case 2: v = (m & 0x0000FFFF) | (t << 16); break;\n          default: v = (m & 0x00FFFFFF) | (t << 24);\n        }\n        this.wrMem(al, 4, v >>> 0); return;\n      }\n      case 0x3A: if (!(sr & SR_CU2)) { this.exception(EXC.CPU, 2); return; } this.wrMem((r[rs] + simm) >>> 0, 4, this.gte.readData(rt)); return; // SWC2\n\n      default: this.exception(EXC.RI); return;\n    }\n  }\n\n  dump() {\n    let s = `PC=${hex(this.pc)} NPC=${hex(this.nextPc)} HI=${hex(this.hi)} LO=${hex(this.lo)}\\n`;\n    for (let i = 0; i < 32; i += 4) {\n      s += [0, 1, 2, 3].map(j => `${REG_NAMES[i + j].padStart(4)}=${hex(this.r[i + j])}`).join('  ') + '\\n';\n    }\n    s += `SR=${hex(this.cop0[C0_SR])} CAUSE=${hex(this.cop0[C0_CAUSE])} EPC=${hex(this.cop0[C0_EPC])} BADV=${hex(this.cop0[C0_BADVADDR])}`;\n    return s;\n  }\n}\n\nconst hex = (v, n = 8) => (v >>> 0).toString(16).toUpperCase().padStart(n, '0');\n\nreturn { EXC, REG_NAMES, RESET_VECTOR, LD_RAM, memCost, CPU, hex };\n})();\nconst __src_jit = (() => {\n// ============================================================================\n//  Recompilador dinâmico MIPS R3000A -> JavaScript\n// ============================================================================\n//  Cada \"bloco\" é uma sequência linear de instruções que começa num PC e termina\n//  num branch/jump (incluindo o delay slot), SYSCALL/BREAK, MTC0 em SR/CAUSE, RFE\n//  ou ao atingir MAX_BLOCK instruções. O bloco vira uma função JS (new Function).\n//\n//  Semântica preservada em relação ao interpretador (cpu.js):\n//   - delay slot de branch e load delay slot são resolvidos ESTATICAMENTE na geração\n//     (a carga pendente cruza o fim do bloco via cpu.pendReg/pendVal; se um bloco é\n//     entrado com carga pendente, roda-se 1 passo no interpretador);\n//   - exceções (AdEL/AdES/Overflow/SYSCALL/BREAK/RI/CpU) saem do bloco com o estado exato\n//     (EPC, BD, BadVAddr, ciclos, instrCount);\n//   - ciclos: 1/instrução + custo de fetch KSEG1 + 5 por load (corrigido no acesso lento),\n//     descarregados em cpu.cycles antes de cada acesso à memória (I/O vê o relógio certo);\n//   - interrupções são verificadas na ENTRADA de cada bloco (blocos curtos: ≤ MAX_BLOCK).\n//  Blocos só são usados em modo kernel e sem cache isolado; senão cai no interpretador.\n//\n//  Invalidação: a RAM é dividida em linhas de 64 B; bus.codeFlags marca as que têm código.\n//  Escritas da CPU (inline), do interpretador e de DMA chamam bus.onCodeWrite -> descarta os\n//  blocos que tocam a linha.\n// ============================================================================\nconst { EXC, memCost, LD_RAM } = __src_cpu;\nconst MAX_BLOCK = 48;\nconst INTERP = function interp() {};            // sentinela: \"este PC é executado pelo interpretador\"\n\nconst isBranchWord = w => {\n  const op = w >>> 26;\n  return op === 1 || (op >= 2 && op <= 7) || (op === 0 && ((w & 0x3F) === 8 || (w & 0x3F) === 9));\n};\n\nclass JIT {\n  constructor(cpu, bus) {\n    this.cpu = cpu; this.bus = bus; this.epoch = 0;\n    this.gp = new Uint32Array(0x4000); this.gb = new Array(0x4000).fill(null); this.ge = new Int32Array(0x4000).fill(-1);\n    this.cf = bus.codeFlags;\n    this.lineBlocks = new Array(this.cf.length).fill(null);\n    this.tables = [];\n    this.stats = { compiled: 0, interp: 0, invalidations: 0, loops: 0, inlined: 0 };\n    bus.onCodeWrite = o => this.invalidateLine(o >>> 6);\n\n    const ram = bus.ram;\n    const self = this;\n    this.H = {\n      r: cpu.r, c0: cpu.cop0, gte: cpu.gte, bus, ps: { nextTick: 0 }, J: this,   // ps: o PSX (nextTick) para laços internos; J: este JIT (epoch)\n      ram8: ram, ram16: new Uint16Array(ram.buffer, ram.byteOffset, ram.length >> 1), ram32: new Uint32Array(ram.buffer, ram.byteOffset, ram.length >> 2),\n      cf: this.cf,\n      inv: o => self.invalidateLine(o >>> 6),\n      rd(a, size) { cpu.cycles += memCost(a, size) - LD_RAM; return bus.read(a, size); },\n      lwl(a, c) {\n        const m = this.rd((a & 0xFFFFFFFC) >>> 0, 4);\n        switch (a & 3) { case 0: return (c & 0x00FFFFFF) | (m << 24); case 1: return (c & 0x0000FFFF) | (m << 16); case 2: return (c & 0x000000FF) | (m << 8); default: return m; }\n      },\n      lwr(a, c) {\n        const m = this.rd((a & 0xFFFFFFFC) >>> 0, 4);\n        switch (a & 3) { case 0: return m; case 1: return (c & 0xFF000000) | (m >>> 8); case 2: return (c & 0xFFFF0000) | (m >>> 16); default: return (c & 0xFFFFFF00) | (m >>> 24); }\n      },\n      swl(a, t) {\n        const al = (a & 0xFFFFFFFC) >>> 0, m = this.rd(al, 4); let v;\n        switch (a & 3) { case 0: v = (m & 0xFFFFFF00) | (t >>> 24); break; case 1: v = (m & 0xFFFF0000) | (t >>> 16); break; case 2: v = (m & 0xFF000000) | (t >>> 8); break; default: v = t; }\n        bus.write(al, 4, v >>> 0);\n      },\n      swr(a, t) {\n        const al = (a & 0xFFFFFFFC) >>> 0, m = this.rd(al, 4); let v;\n        switch (a & 3) { case 0: v = t; break; case 1: v = (m & 0x000000FF) | (t << 8); break; case 2: v = (m & 0x0000FFFF) | (t << 16); break; default: v = (m & 0x00FFFFFF) | (t << 24); }\n        bus.write(al, 4, v >>> 0);\n      },\n    };\n  }\n\n  /** descarta tudo (após carregar código na RAM por fora, reset, etc.) */\n  flush() {\n    this.tables = []; this.cf.fill(0); this.lineBlocks.fill(null); this.epoch++;\n  }\n\n  invalidateLine(l) {\n    this.epoch++;\n    const list = this.lineBlocks[l];\n    if (list) { for (const e of list) e.t[e.i] = undefined; this.lineBlocks[l] = null; this.stats.invalidations++; }\n    this.cf[l] = 0;\n  }\n\n  table(key, size) {\n    return this.tables[key] || (this.tables[key] = new Array(size).fill(undefined));\n  }\n\n  /** executa um bloco (ou 1 instrução no interpretador, nos casos especiais) */\n  exec() {\n    const cpu = this.cpu, c0 = cpu.cop0, sr = c0[12], pc = cpu.pc;\n    if (cpu.isBranch || cpu.pendReg !== 0 || (sr & 0x10002) !== 0 || (pc & 3) !== 0) { cpu.step(); return; }\n    if (this.bus.irqPending()) c0[13] |= 0x400; else c0[13] &= ~0x400;\n    if ((sr & 1) && (c0[13] & sr & 0xFF00)) { cpu.step(); return; }\n\n    const seg = pc >>> 29;\n    if (seg >= 6) { cpu.step(); return; }\n    const phys = seg < 4 ? pc : (seg === 4 ? pc & 0x7FFFFFFF : pc & 0x1FFFFFFF);\n    let t, idx, isRam;\n    if (phys < 0x800000) { t = this.table(seg * 2, 0x80000); idx = (phys & 0x1FFFFF) >>> 2; isRam = true; }\n    else if (phys >= 0x1FC00000 && phys < 0x1FC80000) { t = this.table(seg * 2 + 1, 0x20000); idx = (phys - 0x1FC00000) >>> 2; isRam = false; }\n    else { cpu.step(); return; }\n\n    let b = t[idx];\n    if (b === undefined) b = t[idx] = this.compile(pc, isRam, t, idx);\n    if (b === INTERP) { cpu.step(); return; }\n    b();\n  }\n\n  /** laço quente: executa blocos até cpu.cycles alcançar psx.nextTick (mesma lógica de exec(), sem a sobrecarga por chamada).\n   *  Encadeamento: cada bloco lembra o último sucessor (b.lp = pc, b.lb = bloco, b.le = época); qualquer invalidação/flush muda a época. */\n  runBlocks(psx) {\n    const cpu = this.cpu, c0 = cpu.cop0, bus = this.bus, hook = psx.hookTTY;\n    const gp = this.gp, gb = this.gb, ge = this.ge;                  // cache global direto-mapeado pc -> bloco (evita a busca nas tabelas)\n    let prev = null;\n    while (cpu.cycles < psx.nextTick) {\n      const sr = c0[12], pc = cpu.pc;\n      if (cpu.isBranch || cpu.pendReg !== 0 || (sr & 0x10002) !== 0 || (pc & 3) !== 0) { cpu.step(); prev = null; continue; }\n      let cz = c0[13];\n      if (bus.istat & bus.imask) { if ((cz & 0x400) === 0) c0[13] = cz |= 0x400; } else if ((cz & 0x400) !== 0) c0[13] = cz &= ~0x400;\n      if ((sr & 1) && (cz & sr & 0xFF00)) { cpu.step(); prev = null; continue; }\n      let b;\n      if (prev !== null && prev.lp === pc && prev.le === this.epoch) b = prev.lb;\n      else if (gp[(pc >>> 2) & 0x3FFF] === pc && ge[(pc >>> 2) & 0x3FFF] === this.epoch) {\n        b = gb[(pc >>> 2) & 0x3FFF];\n        if (prev !== null) { prev.lp = pc; prev.lb = b; prev.le = this.epoch; }\n      } else {\n        const seg = pc >>> 29;\n        if (seg >= 6) { cpu.step(); prev = null; continue; }\n        const phys = seg < 4 ? pc : (seg === 4 ? pc & 0x7FFFFFFF : pc & 0x1FFFFFFF);\n        let t, idx, isRam;\n        if (phys < 0x800000) {\n          if (hook && (phys === 0xA0 || phys === 0xB0)) { psx.tty(); }\n          t = this.tables[seg * 2] || this.table(seg * 2, 0x80000); idx = (phys & 0x1FFFFF) >>> 2; isRam = true;\n        } else if (phys >= 0x1FC00000 && phys < 0x1FC80000) { t = this.tables[seg * 2 + 1] || this.table(seg * 2 + 1, 0x20000); idx = (phys - 0x1FC00000) >>> 2; isRam = false; }\n        else { cpu.step(); prev = null; continue; }\n        b = t[idx];\n        if (b === undefined) b = t[idx] = this.compile(pc, isRam, t, idx);\n        if (b === INTERP) { cpu.step(); prev = null; continue; }\n        if (!(hook && phys < 0x100)) {\n          if (prev !== null) { prev.lp = pc; prev.lb = b; prev.le = this.epoch; }\n          const h = (pc >>> 2) & 0x3FFF; gp[h] = pc; gb[h] = b; ge[h] = this.epoch;\n        }\n      }\n      b(); prev = b;\n    }\n  }\n\n  // -------------------------------------------------------------------------\n  //  Geração de código\n  // -------------------------------------------------------------------------\n  compile(startPc, isRam, tbl, tidx) {\n    const cpu = this.cpu, bus = this.bus;\n    const code = [];\n    let unf = 0, cnt = 0, k = 0, pend = null, ipc = startPc, delay = false;\n    const tmp = () => 't' + (k++);\n    const dirty = new Set();                                         // registradores MIPS escritos até aqui (vivem em variáveis locais r<N>; gravados em r[] nas saídas)\n    const R = n => n === 0 ? '0' : `r${n}`;\n    const flushSets = [];                                            // pontos de gravação dos registradores: marcador \\u0001<id>\\u0002, resolvido no fim\n    const flushRegs = () => { let o = ''; for (const n of dirty) o += `r[${n}]=r${n};`; flushSets.push(o); return `\\u0001${flushSets.length - 1}\\u0002`; };\n    let hasLoop = false, knownRa = null, segStart = startPc; const segs = [], vis = new Set();\n    const fetchCost = a => (a >>> 29) === 5 ? (((a & 0x1FFFFFFF) >= 0x1FC00000) ? 22 : 4) : 0;\n    const pendApply = () => pend ? `r[${pend.reg}]=${pend.tmp};` : '';\n    const X = (c, cop = 0, bad = null, refund = 0) =>\n      `{cpu.cycles+=${unf - refund};cpu.instrCount+=${cnt};${flushRegs()}${pendApply()}cpu.currentPc=${ipc};cpu.inDelay=${delay};${bad ? `c0[8]=${bad};` : ''}cpu.exception(${c},${cop});return;}`;\n    const flushCyc = () => { if (unf) { code.push(`cpu.cycles+=${unf};`); unf = 0; } };\n    const RAMFAST = a => `(${a}&0x1FFFFFFF)<0x800000`;\n\n    // finaliza o bloco: pc/nextPc, ciclos, carga pendente\n    const finish = (pcExpr) => {\n      let s = `cpu.cycles+=${unf};cpu.instrCount+=${cnt};${flushRegs()}`;\n      if (pend) s += `cpu.pendReg=${pend.reg};cpu.pendVal=${pend.tmp};`;\n      s += pcExpr;\n      code.push(s);\n    };\n    const finishSeq = (next) => finish(`cpu.pc=${next >>> 0};cpu.nextPc=${(next + 4) >>> 0};`);\n\n    // aplica o efeito de \"fim de instrução\": carga anterior (se não cancelada) e nova carga\n    let newLd = null;\n    const post = (dest) => {\n      if (dest === 31 || (newLd && newLd.reg === 31) || (pend && pend.reg === 31)) knownRa = null;\n      if (pend && pend.reg !== dest) { code.push(`r${pend.reg}=${pend.tmp}>>>0;`); dirty.add(pend.reg); }\n      pend = newLd; newLd = null;\n    };\n\n    // emite UMA instrução não-branch. Devolve { dest, term }.\n    const emit = (w, pcv) => {\n      const op = w >>> 26, rs = (w >>> 21) & 31, rt = (w >>> 16) & 31, rd = (w >>> 11) & 31;\n      const sh = (w >>> 6) & 31, imm = w & 0xFFFF, simm = (w << 16) >> 16;\n      const RS = R(rs), RT = R(rt);\n      const W = (d, e) => { if (d) { code.push(e.endsWith('?1:0') && !e.includes('?1:0)') ? `r${d}=${e};` : `r${d}=(${e})>>>0;`); dirty.add(d); } return d; };   // locais guardam uint32 (como o Uint32Array r[])\n      let dest = 0, term = false;\n      newLd = null;\n\n      const load = (size, conv) => {\n        const a = tmp(), v = tmp();\n        flushCyc();\n        code.push(`const ${a}=(${RS}+${simm})>>>0;`);\n        if (size > 1) code.push(`if(${a}&${size - 1})${X(EXC.ADEL, 0, a, LD_RAM)}`);\n        const fast = size === 4 ? `ram32[(${a}&0x1FFFFF)>>>2]` : size === 2 ? `ram16[(${a}&0x1FFFFF)>>>1]` : `ram8[${a}&0x1FFFFF]`;\n        code.push(`const ${v}=${conv(`(${RAMFAST(a)}?${fast}:rd(${a},${size}))`)};`);\n        if (rt) newLd = { reg: rt, tmp: v };\n      };\n      const store = (size, valExpr) => {\n        const a = tmp(), v = tmp();\n        flushCyc();\n        code.push(`const ${a}=(${RS}+${simm})>>>0;`);\n        if (size > 1) code.push(`if(${a}&${size - 1})${X(EXC.ADES, 0, a)}`);\n        code.push(`const ${v}=${valExpr};`);\n        const arr = size === 4 ? `ram32[q>>>2]` : size === 2 ? `ram16[q>>>1]` : `ram8[q]`;\n        code.push(`if(${RAMFAST(a)}){const q=${a}&0x1FFFFF;${arr}=${v};if(cf[q>>>6])inv(q);}else bus.write(${a},${size},${v});`);\n      };\n\n      switch (op) {\n        case 0x00:\n          switch (w & 0x3F) {\n            case 0x00: dest = W(rd, `${RT}<<${sh}`); break;\n            case 0x02: dest = W(rd, `${RT}>>>${sh}`); break;\n            case 0x03: dest = W(rd, `(${RT}|0)>>${sh}`); break;\n            case 0x04: dest = W(rd, `${RT}<<(${RS}&31)`); break;\n            case 0x06: dest = W(rd, `${RT}>>>(${RS}&31)`); break;\n            case 0x07: dest = W(rd, `(${RT}|0)>>(${RS}&31)`); break;\n            case 0x0C: code.push(X(EXC.SYS)); term = 'x'; break;\n            case 0x0D: code.push(X(EXC.BP)); term = 'x'; break;\n            case 0x10: dest = W(rd, 'cpu.hi'); break;\n            case 0x11: code.push(`cpu.hi=${RS};`); break;\n            case 0x12: dest = W(rd, 'cpu.lo'); break;\n            case 0x13: code.push(`cpu.lo=${RS};`); break;\n            case 0x18: code.push(`cpu.mul64(${RS},${RT},true);`); break;\n            case 0x19: code.push(`cpu.mul64(${RS},${RT},false);`); break;\n            case 0x1A: code.push(`cpu.div(${RS},${RT});`); break;\n            case 0x1B: code.push(`cpu.divu(${RS},${RT});`); break;\n            case 0x20: { const a = tmp(), b = tmp(), s = tmp();\n              code.push(`const ${a}=${RS}|0,${b}=${RT}|0,${s}=(${a}+${b})|0;if(((${a}^${s})&(${b}^${s}))<0)${X(EXC.OV)}`);\n              dest = W(rd, s); break; }\n            case 0x21: dest = W(rd, `${RS}+${RT}`); break;\n            case 0x22: { const a = tmp(), b = tmp(), s = tmp();\n              code.push(`const ${a}=${RS}|0,${b}=${RT}|0,${s}=(${a}-${b})|0;if(((${a}^${b})&(${a}^${s}))<0)${X(EXC.OV)}`);\n              dest = W(rd, s); break; }\n            case 0x23: dest = W(rd, `${RS}-${RT}`); break;\n            case 0x24: dest = W(rd, `${RS}&${RT}`); break;\n            case 0x25: dest = W(rd, `${RS}|${RT}`); break;\n            case 0x26: dest = W(rd, `${RS}^${RT}`); break;\n            case 0x27: dest = W(rd, `~(${RS}|${RT})`); break;\n            case 0x2A: dest = W(rd, `(${RS}|0)<(${RT}|0)?1:0`); break;\n            case 0x2B: dest = W(rd, `${RS}<${RT}?1:0`); break;\n            default: code.push(X(EXC.RI)); term = 'x';\n          }\n          break;\n        case 0x08: { const a = tmp(), s = tmp();\n          code.push(`const ${a}=${RS}|0,${s}=(${a}+${simm})|0;if(((${a}^${s})&(${simm}^${s}))<0)${X(EXC.OV)}`);\n          dest = W(rt, s); break; }\n        case 0x09: dest = W(rt, `${RS}+${simm}`); break;\n        case 0x0A: dest = W(rt, `(${RS}|0)<${simm}?1:0`); break;\n        case 0x0B: dest = W(rt, `${RS}<${simm >>> 0}?1:0`); break;\n        case 0x0C: dest = W(rt, `${RS}&${imm}`); break;\n        case 0x0D: dest = W(rt, `${RS}|${imm}`); break;\n        case 0x0E: dest = W(rt, `${RS}^${imm}`); break;\n        case 0x0F: dest = W(rt, `${(imm << 16) >>> 0}`); break;\n\n        case 0x10:                                                // COP0 (modo kernel garantido na entrada)\n          if (rs === 0x00) { const v = tmp(); code.push(`const ${v}=c0[${rd}];`); if (rt) newLd = { reg: rt, tmp: v }; }\n          else if (rs === 0x04) { code.push(`cpu.writeCop0(${rd},${RT});`); if (rd === 12 || rd === 13) term = 'seq'; }\n          else if (rs === 0x10 && (w & 0x3F) === 0x10) { code.push('c0[12]=(c0[12]&0xFFFFFFF0)|((c0[12]>>>2)&0xF);'); term = 'seq'; }\n          else if (rs === 0x10) { code.push(X(EXC.RI)); term = 'x'; }\n          break;\n\n        case 0x12:                                                // COP2 / GTE\n          code.push(`if(!(c0[12]&0x40000000))${X(EXC.CPU, 2)}`);\n          if (w & 0x02000000) code.push(`gte.command(${w & 0x1FFFFFF});`);\n          else if (rs === 0x00) { const v = tmp(); code.push(`const ${v}=gte.readData(${rd});`); if (rt) newLd = { reg: rt, tmp: v }; }\n          else if (rs === 0x02) { const v = tmp(); code.push(`const ${v}=gte.readCtrl(${rd});`); if (rt) newLd = { reg: rt, tmp: v }; }\n          else if (rs === 0x04) code.push(`gte.writeData(${rd},${RT});`);\n          else if (rs === 0x06) code.push(`gte.writeCtrl(${rd},${RT});`);\n          else { code.push(X(EXC.RI)); term = 'x'; }\n          break;\n\n        case 0x11: case 0x13: case 0x30: case 0x31: case 0x33: case 0x38: case 0x39: case 0x3B:\n          code.push(`if(!(c0[12]&${0x10000000 * (1 << (op & 3))}))${X(EXC.CPU, op & 3)}`); break;\n\n        case 0x20: load(1, e => `((${e}<<24)>>24)`); break;\n        case 0x21: load(2, e => `((${e}<<16)>>16)`); break;\n        case 0x23: load(4, e => e); break;\n        case 0x24: load(1, e => e); break;\n        case 0x25: load(2, e => e); break;\n        case 0x22: case 0x26: {                                   // LWL / LWR\n          const a = tmp(), v = tmp();\n          flushCyc();\n          const cur = (pend && pend.reg === rt) ? pend.tmp : R(rt);\n          code.push(`const ${a}=(${RS}+${simm})>>>0;const ${v}=H.${op === 0x22 ? 'lwl' : 'lwr'}(${a},${cur});`);\n          if (rt) newLd = { reg: rt, tmp: v };\n          break;\n        }\n        case 0x32: {                                              // LWC2\n          const a = tmp(), v = tmp();\n          flushCyc();\n          code.push(`if(!(c0[12]&0x40000000))${X(EXC.CPU, 2)}`);\n          code.push(`const ${a}=(${RS}+${simm})>>>0;`);\n          code.push(`if(${a}&3)${X(EXC.ADEL, 0, a, LD_RAM)}`);\n          code.push(`const ${v}=(${RAMFAST(a)}?ram32[(${a}&0x1FFFFF)>>>2]:rd(${a},4));gte.writeData(${rt},${v});`);\n          break;\n        }\n        case 0x28: store(1, `${RT}&0xFF`); break;\n        case 0x29: store(2, `${RT}&0xFFFF`); break;\n        case 0x2B: store(4, `${RT}`); break;\n        case 0x2A: case 0x2E: {                                   // SWL / SWR\n          const a = tmp();\n          flushCyc();\n          code.push(`const ${a}=(${RS}+${simm})>>>0;H.${op === 0x2A ? 'swl' : 'swr'}(${a},${RT});`);\n          break;\n        }\n        case 0x3A: {                                              // SWC2\n          const a = tmp(), v = tmp();\n          flushCyc();\n          code.push(`if(!(c0[12]&0x40000000))${X(EXC.CPU, 2)}`);\n          code.push(`const ${a}=(${RS}+${simm})>>>0;`);\n          code.push(`if(${a}&3)${X(EXC.ADES, 0, a)}`);\n          code.push(`const ${v}=gte.readData(${rt});`);\n          code.push(`if(${RAMFAST(a)}){const q=${a}&0x1FFFFF;ram32[q>>>2]=${v};if(cf[q>>>6])inv(q);}else bus.write(${a},4,${v}>>>0);`);\n          break;\n        }\n        default: code.push(X(EXC.RI)); term = 'x';\n      }\n      return { dest, term };\n    };\n\n    // custo estático de uma instrução (1 + fetch KSEG1 + 5 se faz acesso de leitura)\n    const instCost = (w, a) => {\n      const op = w >>> 26;\n      const rdAccess = op === 0x20 || op === 0x21 || op === 0x22 || op === 0x23 || op === 0x24 || op === 0x25 || op === 0x26 || op === 0x32 || op === 0x2A || op === 0x2E;\n      return 1 + fetchCost(a) + (rdAccess ? LD_RAM : 0);\n    };\n    const fetch = a => bus.read(a, 4);\n\n    // volta ao início do próprio bloco (laço): mantém os registradores em variáveis locais; sai para o despachante quando acabar o tempo\n    // do tick, houver IRQ pendente ou o código for invalidado\n    const backedge = () => { hasLoop = true; return `cpu.cycles+=${unf};cpu.instrCount+=${cnt};if(cpu.cycles>=ps.nextTick||(bus.istat&bus.imask)!==0||J.epoch!==E0){${flushRegs()}cpu.pc=${startPc};cpu.nextPc=${(startPc + 4) >>> 0};return;}continue;`; };\n    const inlineOk = t => { const ph = t & 0x1FFFFFFF; return (t & 3) === 0 && ph >= 0x100 && !vis.has(t) && (isRam ? ph < 0x800000 : (ph >= 0x1FC00000 && ph < 0x1FC80000)); };\n\n    let done = false;\n    while (!done) {\n      const w = fetch(ipc); vis.add(ipc);\n      if (isBranchWord(w)) {\n        const dw = fetch((ipc + 4) >>> 0);\n        if (isBranchWord(dw)) { // branch no delay slot: deixa para o interpretador\n          if (cnt === 0) { this.stats.interp++; this.register(startPc, isRam, tbl, tidx, ipc); return INTERP; }\n          finishSeq(ipc); done = true; break;\n        }\n        const op = w >>> 26, rs = (w >>> 21) & 31, rt = (w >>> 16) & 31, rd = (w >>> 11) & 31, simm = (w << 16) >> 16;\n        const RS = R(rs), RT = R(rt);\n        const tgt = (ipc + 4 + (simm << 2)) >>> 0;\n        let target, cond = null, dest = 0, link = '', bkn = '';\n        cnt++; unf += instCost(w, ipc); delay = false;\n        let jt = -1, raNew = null, jrKnown = false, btn = 'bt';\n        if (op === 0x02 || op === 0x03) {\n          jt = (((ipc + 4) & 0xF0000000) | ((w & 0x3FFFFFF) << 2)) >>> 0; target = `${jt}`;\n          if (op === 3) { link = `r31=${(ipc + 8) >>> 0};`; dest = 31; dirty.add(31); raNew = (ipc + 8) >>> 0; }\n          btn = tmp(); code.push(`const ${btn}=${target};${link}`);\n        } else if (op === 0 /* JR/JALR */) {\n          if ((w & 0x3F) === 8 && rs === 31 && knownRa !== null && cnt < MAX_BLOCK - 8 && inlineOk(knownRa)) { jt = knownRa; jrKnown = true; }\n          btn = tmp(); code.push(`const ${btn}=${RS}>>>0;`);\n          if ((w & 0x3F) === 9 && rd) { code.push(`r${rd}=${(ipc + 8) >>> 0};`); dest = rd; dirty.add(rd); }\n        } else {\n          const cexp = op === 4 ? `${RS}===${RT}` : op === 5 ? `${RS}!==${RT}` : op === 6 ? `(${RS}|0)<=0` : op === 7 ? `(${RS}|0)>0`\n            : ((rt & 1) ? `(${RS}|0)>=0` : `(${RS}|0)<0`);\n          bkn = tmp(); code.push(`const ${bkn}=${cexp};`);\n          if (op === 1 && (rt & 0x1E) === 0x10) { code.push('r31=' + ((ipc + 8) >>> 0) + ';'); dest = 31; dirty.add(31); }\n          cond = true;\n        }\n        post(dest);\n        // delay slot\n        delay = true; cnt++; const dpc = (ipc + 4) >>> 0; ipc = dpc; unf += instCost(dw, dpc);\n        const res = emit(dw, dpc);\n        post(res.dest);\n        const dualExit = res.term === 'x';           // exceção incondicional no delay slot: o resto é morto\n        if (!dualExit) {\n          if (!cond && jt >= 0 && !res.term) {\n            if (jt === startPc && !pend) { code.push(backedge()); done = true; break; }          // salto incondicional para o próprio início: laço interno\n            if (jt !== startPc && (jrKnown || cnt < MAX_BLOCK - 8) && inlineOk(jt)) {              // j/jal/jr $ra conhecido: embute o destino no mesmo bloco\n              segs.push([segStart, dpc]); segStart = jt; ipc = jt; delay = false;\n              if (raNew !== null) knownRa = raNew; else if (jrKnown) knownRa = null;\n              continue;\n            }\n          }\n          if (cond) {\n            if (!res.term && cnt < MAX_BLOCK - 3) {   // superbloco: o desvio tomado vira saída lateral; o fluxo sequencial continua no mesmo bloco\n              if (tgt === startPc && !pend) code.push(`if(${bkn}){${backedge()}}`);              // desvio para trás até o início: laço interno\n              else {\n                let s = `cpu.cycles+=${unf};cpu.instrCount+=${cnt};${flushRegs()}`;\n                if (pend) s += `cpu.pendReg=${pend.reg};cpu.pendVal=${pend.tmp};`;\n                code.push(`if(${bkn}){${s}cpu.pc=${tgt};cpu.nextPc=${(tgt + 4) >>> 0};return;}`);\n              }\n              ipc = (dpc + 4) >>> 0; delay = false; continue;\n            }\n            finish(`if(${bkn}){cpu.pc=${tgt};cpu.nextPc=${(tgt + 4) >>> 0};}else{cpu.pc=${(dpc + 4) >>> 0};cpu.nextPc=${(dpc + 8) >>> 0};}`);\n          } else finish(`cpu.pc=${btn};cpu.nextPc=(${btn}+4)>>>0;`);\n        }\n        done = true; break;\n      }\n\n      // instrução comum\n      cnt++; unf += instCost(w, ipc); delay = false;\n      const res = emit(w, ipc);\n      post(res.dest);\n      if (res.term === 'x') { done = true; break; }\n      if (res.term === 'seq' || cnt >= MAX_BLOCK) { finishSeq((ipc + 4) >>> 0); done = true; break; }\n      ipc = (ipc + 4) >>> 0;\n    }\n\n    segs.push([segStart, ipc]);\n    const fullFlush = [...dirty].map(n => `r[${n}]=r${n};`).join('');       // num laço, qualquer saída grava TODOS os registradores alterados no corpo\n    let body = code.join('\\n').replace(/\\u0001(\\d+)\\u0002/g, (_, i) => hasLoop ? fullFlush : flushSets[+i]);\n    const used = new Set(); for (const m of body.matchAll(/\\br(\\d{1,2})\\b/g)) used.add(+m[1]);\n    const load = used.size ? 'let ' + [...used].map(n => `r${n}=r[${n}]`).join(',') + ';\\n' : '';\n    if (hasLoop) body = `const E0=J.epoch;\\nfor(;;){\\n${body}\\nreturn;\\n}`;\n    const src = `const {r,c0,gte,ram8,ram16,ram32,cf,inv,rd,bus,ps,J}=H;return function block(){\\n${load}${body}\\n}\\n//# sourceURL=jit_${startPc.toString(16)}`;\n    let fn;\n    try { fn = new Function('cpu', 'H', src)(cpu, this.H); }\n    catch (e) { this.stats.interp++; for (const [a, b] of segs) this.register(a, isRam, tbl, tidx, b); return INTERP; }\n    this.stats.compiled++; if (hasLoop) this.stats.loops++; this.stats.inlined += segs.length - 1;\n    fn.lp = -1; fn.lb = null; fn.le = -1;                  // cache de sucessor (ver runBlocks)\n    for (const [a, b] of segs) this.register(a, isRam, tbl, tidx, b);\n    return fn;\n  }\n\n  /** marca as linhas de RAM cobertas pelo bloco [start, endPc] para invalidação */\n  register(startPc, isRam, tbl, tidx, endPc) {\n    if (!isRam) return;\n    const seg = startPc >>> 29;\n    const p0 = (seg < 4 ? startPc : seg === 4 ? startPc & 0x7FFFFFFF : startPc & 0x1FFFFFFF) & 0x1FFFFF;\n    const p1 = (p0 + ((endPc - startPc) >>> 0) + 3) & 0x1FFFFF;\n    const l0 = p0 >>> 6, l1 = p1 >>> 6;\n    for (let l = l0; ; l = (l + 1) & (this.cf.length - 1)) {\n      (this.lineBlocks[l] ??= []).push({ t: tbl, i: tidx });\n      this.cf[l] = 1;\n      if (l === l1) break;\n    }\n  }\n}\n\nreturn { JIT };\n})();\nconst __src_wasmbin = (() => {\n// gerado por wasm/build.sh (não edite)\nconst WASM_B64 = 'AGFzbQEAAAABOgpgAn9/AX9gA39/fwBgAABgAX8Bf2AAAX9gAn9/AGABfwBgA39/fwF/YAR/f39/AGAHf39/f39/fwACKQMDZW52Bm1lbW9yeQIBQEADZW52BWJyZWFkAAADZW52BmJ3cml0ZQABAxEQAgMEBQYDBQUHBgABAQgJCAQFAXABAQEGCQF/AUGAn6IBCwcpBQNwdHIAAwNydW4ABAdndGVfY21kAAsGZ3RlX3JkAAwGZ3RlX3dyAA0IAQIKoMUBEA8AQaAIQQBB1JagAfwLAAuQAQEBf0GgiICAACEBAkACQAJAAkACQAJAAkACQAJAAkACQAJAIAAOCwsAAQIDBAUGBwgJCgtBoImAgAAPC0GgioCAAA8LQeCKgIAADwtBgIuAgAAPC0GAi4CBAA8LQYCLoIEADwtBgJOggQAPC0GAlKCBAA8LQYCWoIEADwtBoJaggQAPC0HAlqCBACEBCyABC9ZEAg5/AXwjgICAgABBEGsiACSAgICAAEEAIQECQEEAKwPgioCAAEEAKwPwioCAAGNFDQADQEEAKAKoioCAACEBAkBBACgCwIqAgABFDQAgAUHv////AXFBoAFHDQACQEEAKALEioCAAA0AQQEhAQwDC0EAQQA2AsSKgIAAC0EAIAE2AsiKgIAAQQBBACgCsIqAgAAiAjYCzIqAgABBAEEAKAK8ioCAAEEAR0EKdEEAKALUiYCAAEH/d3FyIgM2AtSJgIAAQQBBADYC1JaggQBBAEEANgLYlqCBAEEAQQA2ArCKgIAAQQAoAriKgIAAIQRBACgCtIqAgAAhBQJAAkBBACgC0ImAgAAiBkEBcUUNACAGIANxQYD+A3FFDQBBACABQXxqIAEgAhs2AtiJgIAAQQBBgIOA/ntBgIGAgHggBkGAgIACcRsiATYCqIqAgABBACAGQQJ0QTxxIAZBQHFyNgLQiYCAAEEAIANBg////wRxIAJBAEdBH3RyNgLUiYCAAEEAIAFBBHI2AqyKgIAAQQBBADYCsIqAgAAMAQsCQCABQQNxRQ0AQQAgATYCwImAgABBACABQXxqIAEgAhs2AtiJgIAAQQAgA0GD////BHFBkICAgHhBECACG3I2AtSJgIAAQQBBgIOA/ntBgIGAgHggBkGAgIACcRsiATYCqIqAgABBACAGQQJ0QTxxIAZBQHFyNgLQiYCAAEEAIAFBBHI2AqyKgIAAQQBBADYCsIqAgAAMAQsCQAJAIAFB/P///wFxIAEgAUGAgICAfHFBgICAgHhGGyICQf///wNLDQAgAkH8//8AcUGAi4CAAGooAgAhAgwBCwJAIAJBgICAgn5qIgNB//8fSw0AIANBgIuAgQBqKAIAIQIMAQsCQCACQYCAgIR+aiICQf8HSw0AIAJBgIuggQBqKAIAIQIMAQsgAUEEEICAgIAAIQILAkAgAUGAgICAfnFBgICAgHpHDQBBAEEAKwPgioCAAEEWQQQgAUGAgID+AXFBgICA/gFGG7egOQPgioCAAAtBAEEAKAKsioCAACIDNgKoioCAAEEAIANBBGo2AqyKgIAAIAJBEHQhByACQf//A3EhCCACQQt2QR9xIQkgAkEQdkEfcSEKIAJBFXZBH3EhCyACwSEMAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAIAJBGnYiDQ48AAECAwQFBgcICQoLDA0ODxASERIhISEhISEhISEhISETFBgVFhcZIRscHh0hIR8hEhIaEiEhISESEiASIQsgAkEGdkEfcSEGAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQCACQT9xDiwAHAECAxwEBQYHHBwICRwcCgsMDRwcHBwODxARHBwcHBITFBUWFxgZHBwaGxwLQQAgCTYC2JaggQAgCUECdEGgiICAAGogCkECdEGgiICAAGooAgAgBnQ2AgAMPwtBACAJNgLYlqCBACAJQQJ0QaCIgIAAaiAKQQJ0QaCIgIAAaigCACAGdjYCAAw+C0EAIAk2AtiWoIEAIAlBAnRBoIiAgABqIApBAnRBoIiAgABqKAIAIAZ1NgIADD0LQQAgCTYC2JaggQAgCUECdEGgiICAAGogCkECdEGgiICAAGooAgAgC0ECdEGgiICAAGooAgB0NgIADDwLQQAgCTYC2JaggQAgCUECdEGgiICAAGogCkECdEGgiICAAGooAgAgC0ECdEGgiICAAGooAgB2NgIADDsLQQAgCTYC2JaggQAgCUECdEGgiICAAGogCkECdEGgiICAAGooAgAgC0ECdEGgiICA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dEGgiICAAGogBDYCAAtBACEBQQBBACgC1JaggQA2ArSKgIAAQQBBACgC3JaggQA2AriKgIAAQQBBACsD4IqAgABEAAAAAAAA8D+gIg45A+CKgIAAQQBBACsD6IqAgABEAAAAAAAA8D+gOQPoioCAAEEAQQA2AqCIgIAAIA5BACsD8IqAgABjDQALCyAAQRBqJICAgIAAIAELsAEBA39BAEEAKALIioCAACICQXxqIAJBACgCzIqAgAAiAxs2AtiJgIAAQQBBgIOA/ntBgIGAgHhBACgC0ImAgAAiAkGAgIACcRsiBDYCqIqAgABBACACQQJ0QTxxIAJBQHFyNgLQiYCAAEEAIAFBHHQgAEECdHJBACgC1ImAgABBg////wRxciADQQBHQR90cjYC1ImAgABBACAEQQRyNgKsioCAAEEAQQA2ArCKgIAAC+tHAwR/CX4EfyOAgICAAEHgAGsiASSAgICAAAJAQQAtAOCWoIEADQBBAEEBOgDglqCBAEHwlqCBACECQYECIQMDQCACQYCAECADQX9qbkEBakEBdiIEQYECIARBgQJKG0H/fWo2AgAgA0GBBEYNASACQQRqQYCAECADbkEBakEBdiIEQYECIARBgQJKG0H/fWo2AgAgAkEIaiECIANBAmohAwwACwtBAEEANgLQioCAACAAQQp2QQFxIQIgAEETdkEBcSEDAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQCAAQT9xQX9qDj8BHBwcHAMcHBwcHAQcHBwFBgcIDhwJHBwcHAoPHAwcDRwcHBwcHBwREAAcHBITHAIcHBwcHBwcHBwcHBwUFQscCyABQQAoAtCToIEAIgRBgID8B3GtNwNQIAEgBEEIdEGAgPwHca03A0ggASAEQRB0QYCA/AdxrTcDQCABQcAAaiADIAIQjoCAgAAgAUEAKALQk6CBACIEQYCA/AdxrTcDUCABIARBCHRBgID8B3GtNwNIIAEgBEEQdEGAgPwHca03A0AgAUHAAGogAyACEI6AgIAAIAFBACgC0JOggQAiBEGAgPwHca03A1AgASAEQQh0QYCA/AdxrTcDSCABIARBEHRBgID8B3GtNwNAIAFBwABqIAMgAhCOgICAAAwbC0EAQQEgAyACEI+AgIAADBoLQQBBACADIAIQj4CAgABBAUEAIAMgAhCPgICAAEECQQEgAyACEI+AgIAADBkLQYCABCEDAkACQEEAKAK0k6CBACICwawiBUEAKAK4k6CBACIEQRB1rCIGfkEAKAKwk6CBACIAwawiByACQRB1rCIIfnwgBMGsIgkgAEEQdawiCn58IAYgB34gBSAKfnwgCSAIfnx9IgVC/////wdVDQBBgIACIQMgBUL/////d1UNAQtBACADNgLQioCAAAtBACAFPgLgk6CBAAwYC0GAgICABCEAAkACQEEAMgGIlqCBACIJQQA0AqyToIEAIgp+QQAyAZCWoIEAIgtBADQCqJOggQAiDH59IgVC////////AVUNAEGAgIDAACEAQQAhBCAFQv///////31VDQELQQAgADYC0IqAgAAgACEEC0EAMgGAlqCBACEGQQA0AqSToIEAIQdBACAFQhSGQhSHIgVCDIggBSADGyINPgLkk6CBAEIAQoCAfiACGyIFIQgCQAJAIAUgDcQiDVUNAEL//wEhCCANQoCAAlkNACANIQgMAQtBACAEQYCAgAhyIgQ2AtCKgIAAC0EAIAg+AqSToIEAQYCAgIACIQICQAJAIAsgB34gBiAKfn0iCEL///////8BVQ0AQYCAgCAhAiAIQv///////31VDQELQQAgBCACciIENgLQioCAAAtBACAIQhSGQhSHIghCDIggCCADGyIKPgLok6CBACAFIQgCQAJAIAUgCsQiClUNAEL//wEhCCAKQoCAAlkNACAKIQgMAQtBACAEQYCAgARyIgQ2AtCKgIAAC0EAIAg+AqiToIEAQYCAgIABIQICQAJAIAYgDH4gCSAHfn0iBkL///////8BVQ0AQYCAgBAhAiAGQv///////31VDQELQQAgBCACciIENgLQioCAAAtBACAGQhSGQhSHIgZCDIggBiADGyIGPgLsk6CBAAJAAkAgBSAGxCIGVQ0AQv//ASEFIAZCgIACUw0BC0EAIARBgICAAnI2AtCKgIAAIAUhBgtBACAGPgKsk6CBAAwXCyABQQAoApiToIEAIgRBgID8B3GtNwNQIAEgBEEIdEGAgPwHca03A0ggASAEQRB0QYCA/AdxrTcDQCABQcAAaiADIAIQjoCAgAAMFgtBADQCpJOggQAhBUEANAKok6CBACEGIAFBADQCrJOggQBCDIY3A1AgASAGQgyGNwNIIAEgBUIMhjcDQCABQcAAaiADIAIQjoCAgAAMFQsgAEENdiEOIABBD3ZBA3EhDwJAAkAgAEERdkEDcSIEQQNHDQAgAUEAKAKgk6CBADsBFCABQQAvAYSWoIEAIgQ7ARogASAEOwEYIAEgBDsBFiABQQAvAYiWoIEAIgQ7ASAgASAEOwEeIAEgBDsBHCABQQAvAZiToIEAQQR0QfAfcSIEOwESIAFBACAEazsBECABQRBqIQQMAQsgBEECdEGUiICAAGooAgAhBAsgDkEDcSEAAkACQAJAAkACQAJAIA8OBAECAwADCyABQQAoAqSToIEAIg82AjQgAUEAKAKok6CBACIQNgI4QQAoAqyToIEAIQ4MBAsgAUEAKAKAk6CBACIOwSIPNgI0QYSToIEAIREMAgsgAUEAKAKIk6CBACIOwSIPNgI0QYyToIEAIREMAQsgAUEAKAKQk6CBACIOwSIPNgI0QZSToIEAIRELIAEgDkEQdSIQNgI4IBEuAQAhDgsgASAONgI8AkAgAEECRw0AQgBCgIB+IAIbIQVCIEIUIAMbIQZBACECQYCAgIAEIQACQAJAIAQyAQAgD6wiCn5BADQC1JWggQBCDIZ8IglC////////AVUNAEGAgIDAACEAIAlC////////fVUNAQtBACAANgLQioCAACAAIQILIA6sIQcgEKwhCAJAAkAgCUIUhiAGhyIJIAVTDQAgCUKAgAJTDQELQQAgAkGAgIAIciICNgLQioCAAAtBgICAgAQhAAJAAkAgBDIBBCAHfiAEMgECIAh+fCIJQv///////wFVDQBBgICAwAAhACAJQv///////31VDQELQQAgACACciICNgLQioCAAAtBACAJQgyIIAkgAxsiC6ciADYC5JOggQAgBSEJAkACQCAFIAvEIgtVDQBC//8BIQkgAEGAgAJODQAgCyEJDAELQQAgAkGAgIAIciICNgLQioCAAAtBACAJPgKkk6CBAEGAgICAAiEAAkACQCAEMgEGIAp+QQA0AtiVoIEAQgyGfCIJQv///////wFVDQBBgICAICEAIAlC////////fVUNAQtBACAAIAJyIgI2AtCKgIAACwJAAkAgCUIUhiAGhyIJIAVTDQAgCUKAgAJTDQELQQAgAkGAgIAEciICNgLQioCAAAtBgICAgAIhAAJAAkAgBDIBCiAHfiAEMgEIIAh+fCIJQv///////wFVDQBBgICAICEAIAlC////////fVUNAQtBACAAIAJyIgI2AtCKgIAAC0EAIAlCDIggCSADGyILpyIANgLok6CBACAFIQkCQAJAIAUgC8QiC1UNAEL//wEhCSAAQYCAAk4NACALIQkMAQtBACACQYCAgARyIgI2AtCKgIAAC0EAIAk+AqiToIEAQYCAgIABIQACQAJAIAQyAQwgCn5BADQC3JWggQBCDIZ8IglC////////AVUNAEGAgIAQIQAgCUL///////99VQ0BC0EAIAAgAnIiAjYC0IqAgAALAkACQCAJQhSGIAaHIgYgBVMNACAGQoCAAlMNAQtBACACQYCAgAJyIgI2AtCKgIAAC0GAgICAASEAAkACQCAEMgEQIAd+IAQyAQ4gCH58IgZC////////AVUNAEGAgIAQIQAgBkL///////99VQ0BC0EAIAAgAnIiAjYC0IqAgAALQQAgBkIMiCAGIAMbIganIgM2AuyToIEAAkACQCAFIAbEIgZVDQBC//8BIQUgA0GAgAJIDQELQQAgAkGAgIACcjYC0IqAgAAgBSEGC0EAIAY+AqyToIEADBULQZyVoIEAIQ9BmJWggQAhEEGUlaCBACERQQAhDgJAAkACQCAADgIBAAILQbyVoIEAIQ9BuJWggQAhEEG0laCBACERCyABIBEoAgA2AiggASAQKAIANgIsIAEgDygCADYCMCABQShqIQ4LIAQgAUE0aiAOIAMgAkEBIAFBwABqEJCAgIAADBQLIAFBAC4BhJOggQA2AgwgAUEAKAKAk6CBACIEQRB1NgIIIAEgBME2AgRBoJaggQAgAUEEakEAIAMgAkEBIAFBwABqEJCAgIAAIAFBACgCpJOggQA2AjQgAUEAKQOok6CBADcCOCABQQAoArSVoIEANgIoIAFBACkDuJWggQA3AixBwJaggQAgAUE0aiABQShqIAMgAkEBIAFBwABqEJCAgIAAIAFBADQCrJOggQBBACgCmJOggQAiBEEMdkHwH3GtfjcDICABIARBBHZB8B9xrUEANAKok6CBAH43AxggASAEQQR0QfAfca1BADQCpJOggQB+NwMQIAFBEGogAyACEI6AgIAADBMLIAFBAC4BhJOggQA2AgwgAUEAKAKAk6CBACIEQRB1NgIIIAEgBME2AgRBoJaggQAgAUEEakEAIAMgAkEBIAFBwABqEJCAgIAAIAFBACgCpJOggQA2AjQgAUEAKQOok6CBADcCOCABQQAoArSVoIEANgIoIAFBACkDuJWggQA3AixBwJaggQAgAUE0aiABQShqIAMgAkEBIAFBwABqEJCAgIAAIAFBADQCrJOggQBBACgCmJOggQAiBEEMdkHwH3GtfjcDICABIARBBHZB8B9xrUEANAKok6CBAH43AxggASAEQQR0QfAfca1BADQCpJOggQB+NwMQIAFBEGogAyACEI6AgIAAIAFBAC4BjJOggQA2AgwgAUEAKAKIk6CBACIEQRB1NgIIIAEgBME2AgRBoJaggQAgAUEEakEAIAMgAkEBIAFBwABqEJCAgIAAIAFBACgCpJOggQA2AjQgAUEAKQOok6CBADcCOCABQQAoArSVoIEANgIoIAFBACkDuJWggQA3AixBwJaggQAgAUE0aiABQShqIAMgAkEBIAFBwABqEJCAgIAAIAFBADQCrJOggQBBACgCmJOggQAiBEEMdkHwH3GtfjcDICABIARBBHZB8B9xrUEANAKok6CBAH43AxggASAEQQR0QfAfca1BADQCpJOggQB+NwMQIAFBEGogAyACEI6AgIAAIAFBAC4BlJOggQA2AgwgAUEAKAKQk6CBACIEQRB1NgIIIAEgBME2AgRBoJaggQAgAUEEakEAIAMgAkEBIAFBwABqEJCAgIAAIAFBACgCpJOggQA2AjQgAUEAKQOok6CBADcCOCABQQAoArSVoIEANgIoIAFBACkDuJWggQA3AixBwJaggQAgAUE0aiABQShqIAMgAkEBIAFBwABqEJCAgIAAIAFBADQCrJOggQBBACgCmJOggQAiBEEMdkHwH3GtfjcDICABIARBBHZB8B9xrUEANAKok6CBAH43AxggASAEQQR0QfAfca1BADQCpJOggQB+NwMQIAFBEGogAyACEI6AgIAADBILIAFBAC4BhJOggQA2AgwgAUEAKAKAk6CBACIEQRB1NgIIIAEgBME2AgQgAUEEakEBIAMgAhCRgICAAAwRCyABQQAuAYSToIEANgIMIAFBACgCgJOggQAiBEEQdTYCCCABIATBNgIEIAFBBGpBASADIAIQkYCAgAAgAUEALgGMk6CBADYCDCABQQAoAoiToIEA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IgY+AuyToIEAIAUgBsQiBlUNBkL//wEhBSAGQv//AVUNBgwHC0GAgAQhAwJAAkBBAC8BxJOggQBBAC8ByJOggQBqQQAvAcyToIEAaq1BADIB9JWggQB+IgVC/////wdVDQBBgIAQIQJBgIACIQMgBUL/////d1UNAQtBACADNgLQioCAACADQYCAEHIhAgtBACAFPgLgk6CBAAJAIAVCDIciBUJ/VQ0AQQAgAjYC0IqAgABBAEEANgKck6CBAAwKCwJAIAVCgIAEVA0AQQAgAjYC0IqAgABBAEH//wM2ApyToIEADAoLQQAgBT4CnJOggQAMCQtBgIAEIQMCQAJAQQAvAcSToIEAQQAvAcCToIEAakEALwHIk6CBAGpBAC8BzJOggQBqrUEAMgH4laCBAH4iBUL/////B1UNAEGAgBAhAkGAgAIhAyAFQv////93VQ0BC0EAIAM2AtCKgIAAIANBgIAQciECC0EAIAU+AuCToIEAAkAgBUIMhyIFQn9VDQBBACACNgLQioCAAEEAQQA2ApyToIEADAkLAkAgBUKAgARUDQBBACACNgLQioCAAEEAQf//AzYCnJOggQAMCQtBACAFPgKck6CBAAwIC0IAQoCAfiACGyEFQQAyAaCToIEAIgdBADQCpJOggQB+IQZBACgCrJOggQAhAkEAKAKok6CBACEEAkACQAJAIANFDQBBgICAgAQhAAJAAkAgBkL///////8BVQ0AQQAhA0GAgIDAACEAIAZC////////fVUNAQtBACAANgLQioCAACAAIQMLQQAgBkIMiKciADYC5JOggQAgBSEIIAUgBkIUhkIghyIGVQ0BQv//ASEIIAZCgIACWQ0BIAYhCAwCC0GAgICABCEAAkACQCAGQv///////wFVDQBBACEDQYCAgMAAIQAgBkL///////99VQ0BC0EAIAA2AtCKgIAAIAAhAwtBACAGpyIANgLkk6CBACAFIQgCQAJAIAUgBsQiBlUNAEL//wEhCCAGQoCAAlkNACAGIQgMAQtBACADQYCAgAhyIgM2AtCKgIAAC0EAIAg+AqSToIEAQYCAgIACIQ4CQAJAIAcgBKx+IgZC////////AVUNAEGAgIAgIQ4gBkL///////99VQ0BC0EAIA4gA3IiAzYC0IqAgAALQQAgBqciDjYC6JOggQAgBSEIAkACQCAFIAbEIgZVDQBC//8BIQggBkKAgAJZDQAgBiEIDAELQQAgA0GAgIAEciIDNgLQioCAAAtBACAIPgKok6CBAEGAgICAASEEAkACQCAHIAKsfiIGQv///////wFVDQBBgICAECEEIAZC////////fVUNAQtBACAEIANyIgM2AtCKgIAAC0EAIAanIgI2AuyToIEAIAUgBsQiBlUNA0L//wEhBSAGQoCAAlMNBAwDC0EAIANBgICACHIiAzYC0IqAgAALQQAgCD4CpJOggQBBgICAgAIhDgJAAkAgByAErH4iBkL///////8BVQ0AQYCAgCAhDiAGQv///////31VDQELQQAgDiADciIDNgLQioCAAAtBACAGQgyIpyIONgLok6CBACAFIQgCQAJAIAUgBkIUhkIghyIGVQ0AQv//ASEIIAZCgIACWQ0AIAYhCAwBC0EAIANBgICABHIiAzYC0IqAgAALQQAgCD4CqJOggQBBgICAgAEhBAJAAkAgByACrH4iBkL///////8BVQ0AQYCAgBAhBCAGQv///////31VDQELQQAgBCADciIDNgLQioCAAAtBACAGQgyIpyICNgLsk6CBACAFIAZCFIZCIIciBlUNAUL//wEhBSAGQv//AVUNAQwCC0IAQoCAfiACGyEFQQA0AuSToIEAIQdBADIBoJOggQAhBkEAKAKsk6CBACECQQAoAqiToIEAIQRBACgCpJOggQAhAAJAAkACQAJAAkAgA0UNAEGAgICABCEOAkACQCAGIACsfiAHQgyGfCIHQv///////wFVDQBBACEDQYCAgMAAIQ4gB0L///////99VQ0BC0EAIA42AtCKgIAAIA4hAwtBACAHQgyIpyIANgLkk6CBACAFIQggBSAHQhSGQiCHIgdVDQFC//8BIQggB0KAgAJZDQEgByEIDAILQYCAgIAEIQ4CQAJAIAYgAKx+IAd8IgdC////////AVUNAEEAIQNBgICAwAAhDiAHQv///////31VDQELQQAgDjYC0IqAgAAgDiEDC0EAIAenIgA2AuSToIEAIAUhCAJAAkAgBSAHxCIHVQ0AQv//ASEIIAdCgIACWQ0AIAchCAwBC0EAIANBgICACHIiAzYC0IqAgAALQQAgCD4CpJOggQBBgICAgAIhDgJAAkAgBiAErH5BADQC6JOggQB8IgdC////////AVUNAEGAgIAgIQ4gB0L///////99VQ0BC0EAIA4gA3IiAzYC0IqAgAALQQAgB6ciDjYC6JOggQAgBSEIAkACQCAFIAfEIgdVDQBC//8BIQggB0KAgAJZDQAgByEIDAELQQAgA0GAgIAEciIDNgLQioCAAAtBACAIPgKok6CBAEGAgICAASEEAkACQCAGIAKsfkEANALsk6CBAHwiBkL///////8BVQ0AQYCAgBAhBCAGQv///////31VDQELQQAgBCADciIDNgLQioCAAAtBACAGpyICNgLsk6CBACAFIAbEIgZVDQJC//8BIQUgBkKAgAJTDQMMAgtBACADQYCAgAhyIgM2AtCKgIAAC0EAIAg+AqSToIEAQYCAgIACIQ4CQAJAQQA0AuiToIEAQgyGIAYgBKx+fCIHQv///////wFVDQBBgICAICEOIAdC////////fVUNAQtBACAOIANyIgM2AtCKgIAAC0EAIAdCDIinIg42AuiToIEAIAUhCAJAAkAgBSAHQhSGQiCHIgdVDQBC//8BIQggB0KAgAJZDQAgByEIDAELQQAgA0GAgIAEciIDNgLQioCAAAtBACAIPgKok6CBAEGAgICAASEEAkACQEEANALsk6CBAEIMhiAGIAKsfnwiBkL///////8BVQ0AQYCAgBAhBCAGQv///////31VDQELQQAgBCADciIDNgLQioCAAAtBACAGQgyIpyICNgLsk6CBACAFIAZCFIZCIIciBlUNAEL//wEhBSAGQv//AVcNAQtBACADQYCAgAJyIgM2AtCKgIAAIAUhBgtBACAGPgKsk6CBAEEAIQQCQAJAIABBBHUiAEEASA0AQf8BIQQgAEGAAk8NACAAIQQMAQtBACADQYCAgAFyIgM2AtCKgIAAC0EAIQACQAJAIA5BBHUiDkEASA0AQf8BIQAgDkGAAk8NACAOIQAMAQtBACADQYCAwAByIgM2AtCKgIAAC0EAIQ4CQAJAIAJBBHUiAkEASA0AQf8BIQ4gAkGAAkkNAQtBACADQYCAIHI2AtCKgIAAIA4hAgtBAEEAKQLUk6CBADcD0JOggQBBACAAQQh0IARqIAJBEHRqQQAtAJuToIEAQRh0ajYC2JOggQAMBgtBACADQYCAgAJyIgM2AtCKgIAAIAUhBgtBACAGPgKsk6CBAEEAIQQCQAJAIABBBHUi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AyAAIABBgICAgHxxQYCAgIB4RhsiA0H///8DSw0AIANB////AHEhAwJAAkACQCABQX5qDgMBAgACCyADQYCLgIAAaigCACEDDAMLIANBgIuAgABqLwEAIQMMAgsgA0GAi4CAAGotAAAhAwwBCwJAIANBgICAgn5qIgVB//8fSw0AAkACQAJAIAFBfmoOAwECAAILIAVBgIuAgQBqKAIAIQMMAwsgBUGAi4CBAGovAQAhAwwCCyAFQYCLgIEAai0AACEDDAELAkAgA0GAgICEfmoiA0H/B0sNAAJAAkACQCABQX5qDgMBAgACCyADQYCLoIEAaigCACEDDAMLIANBgIuggQBqLwEAIQMMAgsgA0GAi6CBAGotAAAhAwwBCyAAIAEQgICAgAAhAwsgAiADNgIAQQELCgAgABCGgICAAAt2AAJAIAANACABEIeAgIAADwsgAUEgaiEAAkACQCABQR9LDQBBASABdEGQoMDgBnENASABQR9HDQBBACgC0IqAgAAiAUGAwJ/8B3FBAEdBH3QgAXIPCyAAQQJ0QYCUoIEAaigCAA8LIABBAnRBgJSggQBqLgEACx4AAkAgAA0AIAEgAhCIgICAAA8LIAEgAhCJgICAAAv2CQYBfgJ/A34BfwF+AX9CIEIUIAEbIQNBACgC0IqAgAAhBEGAgICABCEFAkACQEEANALUlaCBAEIMhiAAKQMAIgZ9IgdC////////AVUNAEGAgIDAACEFIAdC////////fVUNAQtBACAEIAVyIgQ2AtCKgIAAC0EALgGgk6CBACEFQoCAfiEIAkACQCAHQhSGIAOHxCIHQoCAflMNAEL//wEhCCAHQoCAAlkNACAHIQgMAQtBACAEQYCAgAhyIgQ2AtCKgIAAC0IAQoCAfiACGyEHQYCAgIAEIQICQAJAIAYgBSAIp2ysfCIIQv///////wFVDQBBgICAwAAhAiAIQv///////31VDQELQQAgBCACciIENgLQioCAAAtBACAIQhSGQhSHIghCDIggCCABGyIGpyIJNgLkk6CBACAHIQgCQAJAIAcgBsQiBlUNAEL//wEhCCAGQoCAAlkNACAGIQgMAQtBACAEQYCAgAhyIgQ2AtCKgIAAC0EAIAg+AqSToIEAQYCAgIACIQICQAJAQQA0AtiVoIEAQgyGIAApAwgiCn0iBkL///////8BVQ0AQYCAgCAhAiAGQv///////31VDQELQQAgBCACciIENgLQioCAAAtCgIB+IQgCQAJAIAZCFIYgA4fEIgZCgIB+Uw0AQv//ASEIIAZCgIACWQ0AIAYhCAwBC0EAIARBgICABHIiBDYC0IqAgAALQYCAgIACIQICQAJAIAogBSAIp2ysfCIIQv///////wFVDQBBgICAICECIAhC////////fVUNAQtBACAEIAJyIgQ2AtCKgIAAC0EAIAhCFIZCFIciCEIMiCAIIAEbIganIgs2AuiToIEAIAchCAJAAkAgByAGxCIGVQ0AQv//ASEIIAZCgIACWQ0AIAYhCAwBC0EAIARBgICABHIiBDYC0IqAgAALQQAgCD4CqJOggQBBgICAgAEhAgJAAkBBADQC3JWggQBCDIYgACkDECIKfSIGQv///////wFVDQBBgICAECECIAZC////////fVUNAQtBACAEIAJyIgQ2AtCKgIAAC0KAgH4hCAJAAkAgBkIUhiADh8QiA0KAgH5TDQBC//8BIQggA0KAgAJZDQAgAyEIDAELQQAgBEGAgIACciIENgLQioCAAAtBgICAgAEhAAJAAkAgCiAFIAinbKx8IgNC////////AVUNAEGAgIAQIQAgA0L///////99VQ0BC0EAIAQgAHIiBDYC0IqAgAALQQAgA0IUhkIUhyIDQgyIIAMgARsiA6ciATYC7JOggQACQAJAIAcgA8QiA1UNAEL//wEhByADQoCAAlkNACADIQcMAQtBACAEQYCAgAJyIgQ2AtCKgIAAC0EAIAc+AqyToIEAQQAhAAJAAkAgCUEEdSIFQQBIDQBB/wEhACAFQYACTw0AIAUhAAwBC0EAIARBgICAAXIiBDYC0IqAgAALQQAhBQJAAkAgC0EEdSICQQBIDQBB/wEhBSACQYACTw0AIAIhBQwBC0EAIARBgIDAAHIiBDYC0IqAgAALQQAhAgJAAkAgAUEEdSIBQQBIDQBB/wEhAiABQYACSQ0BC0EAIARBgIAgcjYC0IqAgAAgAiEBC0EAQQApAtSToIEANwPQk6CBAEEAQQAtAJuToIEAQRh0IAFBEHQgBUEIdCAAampqNgLYk6CBAAvrCQQCfwN+AX8BfiOAgICAAEEwayIEJICAgIAAIARBACgClJWggQA2AhggBEEAKQOYlaCBADcCHAJAAkACQAJAIAAOAgABAgsgBEEAKAKAk6CBACIAwTYCJEGEk6CBACEFDAILIARBACgCiJOggQAiAME2AiRBjJOggQAhBQwBCyAEQQAoApCToIEAIgDBNgIkQZSToIEAIQULIAQgAEEQdTYCKCAEIAUuAQA2AixBgJaggQAgBEEkaiAEQRhqIAIgA0EAIAQQkICAgABCAEKAgH4gAxsiBiEHAkACQCAGQQAoAuSToIEAIgOsVQ0AQv//ASEHIANBgIACSA0BC0EAQQAoAtCKgIAAQYCAgAhyNgLQioCAACAHpyEDC0EAIAM2AqSToIEAIAYhBwJAAkAgBkEAKALok6CBACIArFUNAEL//wEhByAAQYCAAkgNAQtBAEEAKALQioCAAEGAgIAEcjYC0IqAgAAgB6chAAtBACAANgKok6CBAAJAIAQpAxBCDIciB0KAgH58Qv//e1YNAEEAQQAoAtCKgIAAQYCAgAJyNgLQioCAAAtBACAGQQA0AuyToIEAIghC//8BIAhC//8BUxsgBiAIVRs+AqyToIEAQgAhBgJAAkAgB0IAUw0AQv//AyEGIAdCgIAEVA0BC0EAQQAoAtCKgIAAQYCAEHI2AtCKgIAAIAYhBwtBACkCxJOggQAhBkEAQQAoAsyToIEANgLIk6CBAEEAIAY3A8CToIEAQQAgB6ciAjYCzJOggQACQAJAIAJBAXRBAC8B6JWggQAiBUsNAEEAQQAoAtCKgIAAQYCACHI2AtCKgIAAQv//ByEHDAELIAIgAmdBcGoiCXQiAkHAgH5qQQd1QQJ0QfCWoIEAaigCAEGBAmqsIgZCgICAgIiAgAEgBiACrX5CGIZ9QiCHfkIYhkKAgICACHxCIIcgBa0gCa2GfkKAgAJ8QhCHIgZC//8HIAZC//8HUxshBwtBgIAEIQICQAJAIAcgA6x+QQA0AuCVoIEAfCIIQv////8HVQ0AQYCAAiECIAhC/////3dVDQELQQBBACgC0IqAgAAgAnI2AtCKgIAAC0GAgAQhAwJAAkAgByAArH5BADQC5JWggQB8IgZC/////wdVDQBBgIACIQMgBkL/////d1UNAQtBAEEAKALQioCAACADcjYC0IqAgAALQQAgBj4C4JOggQAgBkIQhyEGQoB4IQoCQAJAIAhCEIciCEKAeFMNAEL/ByEKIAhCgAhTDQELQQBBACgC0IqAgABBgIABcjYC0IqAgAAgCiEIC0KAeCEKAkACQCAGQoB4Uw0AQv8HIQogBkKACFMNAQtBAEEAKALQioCAAEGAwAByNgLQioCAACAKIQYLQQBBACkCtJOggQA3A7CToIEAQQAgBqdBEHQgCKdB//8DcXI2AriToIEAAkAgAUUNAEGAgAQhAwJAAkAgB0EAMgHslaCBAH5BADQC8JWggQB8IgZC/////wdVDQBBgIACIQMgBkL/////d1UNAQtBAEEAKALQioCAACADcjYC0IqAgAALQQAgBj4C4JOggQBBACAGQgyHIgZCgCAgBkKAIFMbIgdCACAHQgBVGz4CoJOggQAgBkKBIFQNAEEAQQAoAtCKgIAAQYAgcjYC0IqAgAALIARBMGokgICAgAAL2QkDAX4BfwJ+QgAhBwJAIAJFDQAgAjQCAEIMhiEHC0GAgICABCEIAkACQCABNAIAIAAyAQB+IAd8IgdC////////AVUNAEGAgIDAACEIIAdC////////fVUNAQtBAEEAKALQioCAACAIcjYC0IqAgAALQYCAgIAEIQgCQAJAIAE0AgQgAEECajIBAH4gB0IUhkIUh3wiB0L///////8BVQ0AQYCAgMAAIQggB0L///////99VQ0BC0EAQQAoAtCKgIAAIAhyNgLQioCAAAtBgICAgAQhCAJAAkAgATQCCCAAQQRqMgEAfiAHQhSGQhSHfCIJQv///////wFVDQBBgICAwAAhCCAJQv///////31VDQELQQBBACgC0IqAgAAgCHI2AtCKgIAAC0IAQoCAfiAEGyEHIAYgCUIUhkIUhzcDAEEAIAlCDIggCSADGyIJpyIINgLkk6CBAAJAIAVFDQAgByEKAkACQCAHIAnEIglVDQBC//8BIQogCEGAgAJIDQELQQBBACgC0IqAgABBgICACHI2AtCKgIAAIAohCQtBACAJPgKkk6CBAAsCQAJAIAINAEIAIQkMAQsgAjQCBEIMhiEJC0GAgICAAiEIAkACQCABNAIAIAAyAQZ+IAl8IglC////////AVUNAEGAgIAgIQggCUL///////99VQ0BC0EAQQAoAtCKgIAAIAhyNgLQioCAAAtBgICAgAIhCAJAAkAgATQCBCAAQQhqMgEAfiAJQhSGQhSHfCIJQv///////wFVDQBBgICAICEIIAlC////////fVUNAQtBAEEAKALQioCAACAIcjYC0IqAgAALQYCAgIACIQgCQAJAIAE0AgggAEEKajIBAH4gCUIUhkIUh3wiCUL///////8BVQ0AQYCAgCAhCCAJQv///////31VDQELQQBBACgC0IqAgAAgCHI2AtCKgIAACyAGIAlCFIZCFIc3AwhBACAJQgyIIAkgAxsiCaciCDYC6JOggQACQCAFRQ0AIAchCgJAAkAgByAJxCIJVQ0AQv//ASEKIAhBgIACSA0BC0EAQQAoAtCKgIAAQYCAgARyNgLQioCAACAKIQkLQQAgCT4CqJOggQALAkACQCACDQBCACEJDAELIAI0AghCDIYhCQtBgICAgAEhAgJAAkAgATQCACAAMgEMfiAJfCIJQv///////wFVDQBBgICAECECIAlC////////fVUNAQtBAEEAKALQioCAACACcjYC0IqAgAALQYCAgIABIQICQAJAIAE0AgQgAEEOajIBAH4gCUIUhkIUh3wiCUL///////8BVQ0AQYCAgBAhAiAJQv///////31VDQELQQBBACgC0IqAgAAgAnI2AtCKgIAAC0GAgICAASECAkACQCABNAIIIABBEGoyAQB+IAlCFIZCFId8IglC////////AVUNAEGAgIAQIQIgCUL///////99VQ0BC0EAQQAoAtCKgIAAIAJyNgLQioCAAAsgBiAJQhSGQhSHNwMQQQAgCUIMiCAJIAMbIgmnIgE2AuyToIEAAkAgBUUNAAJAAkAgByAJxCIJVQ0AQv//ASEHIAFBgIACSA0BC0EAQQAoAtCKgIAAQYCAgAJyNgLQioCAACAHIQkLQQAgCT4CrJOggQALC/YKBAJ/An4DfwF+I4CAgIAAQdAAayIEJICAgIAAQQAhBUGglqCBACAAQQAgAiADQQEgBEEwahCQgICAACAEQQAoAqSToIEANgIkIARBACkDqJOggQA3AiggBEEAKAK0laCBADYCGCAEQQApA7iVoIEANwIcQcCWoIEAIARBJGogBEEYaiACIANBASAEQTBqEJCAgIAAAkACQAJAAkACQAJAIAEOAgABAgtBACgC0IqAgAAhAwJAAkBBACgC5JOggQBBBHUiAkEASA0AQf8BIQUgAkGAAk8NACACIQUMAQtBACADQYCAgAFyIgM2AtCKgIAAC0EAIQACQAJAQQAoAuiToIEAQQR1IgJBAEgNAEH/ASEAIAJBgAJPDQAgAiEADAELQQAgA0GAgMAAciIDNgLQioCAAAtBACEBAkACQEEAKALsk6CBAEEEdSICQQBIDQBB/wEhASACQYACSQ0BC0EAIANBgIAgcjYC0IqAgAAgASECC0EAQQApAtSToIEANwPQk6CBAEEAQQAtAJuToIEAQRh0IAJBEHQgAEEIdCAFampqNgLYk6CBAAwEC0IAQoCAfiADGyEGQQAoApiToIEAIgBBEHZB/wFxIQEgAEEIdkH/AXEhBSAAQf8Bca0hB0EAKALQioCAACEDQQAoAqyToIEAIQhBACgCqJOggQAhCUEAKAKkk6CBACEKAkAgAg0AQQAgCq0gB34iC6dBBHQiAjYC5JOggQAgBiEHAkACQCAGIAtCJIZCIIciC1UNAEL//wEhByALQoCAAlkNACALIQcMAQtBACADQYCAgAhyIgM2AtCKgIAAC0EAIAc+AqSToIEAQQAgCa0gBa1+IgunQQR0Igk2AuiToIEAIAYhBwJAAkAgBiALQiSGQiCHIgtVDQBC//8BIQcgC0KAgAJZDQAgCyEHDAELQQAgA0GAgIAEciIDNgLQioCAAAtBACAHPgKok6CBAEEAIAitIAGtfiIHp0EEdCIKNgLsk6CBACAGIAdCJIZCIIciB1UNAkL//wEhBiAHQoCAAlMNAwwCC0EAIAqsIAd+QgiIIgunIgI2AuSToIEAIAYhBwJAAkAgBiALxCILVQ0AQv//ASEHIAtCgIACWQ0AIAshBwwBC0EAIANBgICACHIiAzYC0IqAgAALQQAgBz4CpJOggQBBACAJrCAFrX5CCIgiC6ciCTYC6JOggQAgBiEHAkACQCAGIAvEIgtVDQBC//8BIQcgC0KAgAJZDQAgCyEHDAELQQAgA0GAgIAEciIDNgLQioCAAAtBACAHPgKok6CBAEEAIAisIAGtfkIIiCIHpyIKNgLsk6CBACAGIAfEIgdVDQFC//8BIQYgB0L//wFVDQEMAgsgBEEAKAKYk6CBACIAQQx2QfAfca1BADQCrJOggQB+NwMQIAQgAEEEdkHwH3GtQQA0AqiToIEAfjcDCCAEIABBBHRB8B9xrUEANAKkk6CBAH43AwAgBCACIAMQjoCAgAAMAgtBACADQYCAgAJyIgM2AtCKgIAAIAYhBwtBACAHPgKsk6CBAEEAIQECQAJAIAJBBHUiAkEASA0AQf8BIQEgAkGAAk8NACACIQEMAQtBACADQYCAgAFyIgM2AtCKgIAAC0EAIQUCQAJAIAlBBHUiAkEASA0AQf8BIQUgAkGAAk8NACACIQUMAQtBACADQYCAwAByIgM2AtCKgIAAC0EAIQgCQAJAIApBBHUiAkEASA0AQf8BIQggAkGAAkkNAQtBACADQYCAIHI2AtCKgIAAIAghAgtBAEEAKQLUk6CBADcD0JOggQBBACAAQYCAgHhxIAJBEHQgBUEIdCABampqNgLYk6CBAAsgBEHQAGokgICAgAALCycBAEGACAsgBgwYBgUJChk3EREmBg0ZBQwYAAAACygAIAsoAEALKAA=';\n\nreturn { WASM_B64 };\n})();\nconst __src_wasmcpu = (() => {\n// ============================================================================\n//  CPU em WebAssembly (wasm/cpu.c): liga o núcleo compilado ao PSX.\n//  RAM, BIOS e scratchpad passam a viver na memória linear do wasm (o JS enxerga como os mesmos Uint8Array de sempre);\n//  os registradores da CPU também (cpu.r, cpu.cop0 e as propriedades pc/nextPc/cycles... viram janelas para essa memória).\n//  Acessos a I/O e o GTE voltam ao JS por imports. Sem JIT: o núcleo é um interpretador compilado (sem aquecimento).\n// ============================================================================\nconst { WASM_B64 } = __src_wasmbin;\nlet compiled = null;\nfunction module_() {\n  if (!compiled) {\n    const bin = atob(WASM_B64), u8 = new Uint8Array(bin.length);\n    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);\n    compiled = new WebAssembly.Module(u8);\n  }\n  return compiled;\n}\n\nfunction wasmAvailable() { return typeof WebAssembly === 'object' && typeof WebAssembly.Module === 'function'; }\n\n/** troca a CPU do `psx` pelo núcleo wasm. Pode ser chamado com a máquina em qualquer estado (copia o que já existe). */\nfunction enableWasm(psx) {\n  if (psx.wasm) return psx.wasm;\n  const cpu = psx.cpu, bus = psx.bus, gte = cpu.gte;\n  const memory = new WebAssembly.Memory({ initial: 64, maximum: 64 });\n  const env = {\n    memory,\n    bread: (a, s) => { const v = bus.read(a >>> 0, s); S[7] = (bus.istat & bus.imask) !== 0 ? 1 : 0; return v | 0; },\n    bwrite: (a, s, v) => { bus.write(a >>> 0, s, v >>> 0); S[7] = (bus.istat & bus.imask) !== 0 ? 1 : 0; },\n  };\n  const inst = new WebAssembly.Instance(module_(), { env });\n  const x = inst.exports, buf = memory.buffer, P = i => x.ptr(i);\n  const R = new Uint32Array(buf, P(0), 32), C0 = new Uint32Array(buf, P(1), 32), S = new Uint32Array(buf, P(2), 16), D = new Float64Array(buf, P(3), 4);\n  const RAM = new Uint8Array(buf, P(4), 2 * 1024 * 1024), BIOS = new Uint8Array(buf, P(5), 512 * 1024), SCR = new Uint8Array(buf, P(6), 1024);\n\n  // GTE: registradores na memória do wasm (o GTE em C substitui o de JS)\n  const gd = new Int32Array(buf, P(7), 32), gc = new Int32Array(buf, P(8), 64), grt = new Int16Array(buf, P(9), 9), gll = new Int16Array(buf, P(10), 9), glc = new Int16Array(buf, P(11), 9);\n  gd.set(gte.d); gc.set(gte.c); grt.set(gte.rt); gll.set(gte.ll); glc.set(gte.lc); const gflag = gte.flag;\n  gte.d = gd; gte.c = gc; gte.rt = grt; gte.ll = gll; gte.lc = glc;\n  Object.defineProperty(gte, 'flag', { get: () => S[12], set: v => { S[12] = v >>> 0; }, enumerable: true, configurable: true }); gte.flag = gflag;\n  // copia o estado atual para a memória do wasm\n  R.set(cpu.r); C0.set(cpu.cop0); RAM.set(bus.ram); BIOS.set(bus.bios); SCR.set(bus.scratch);\n  const cur = { hi: cpu.hi, lo: cpu.lo, pc: cpu.pc, nextPc: cpu.nextPc, isBranch: cpu.isBranch, pendReg: cpu.pendReg, pendVal: cpu.pendVal, cycles: cpu.cycles, instrCount: cpu.instrCount, nextTick: psx.nextTick };\n  cpu.r = R; cpu.cop0 = C0;\n  bus.ram = RAM; bus.ramView = new DataView(buf, P(4), RAM.length);\n  bus.bios = BIOS; bus.biosView = new DataView(buf, P(5), BIOS.length);\n  bus.scratch = SCR; bus.scratchView = new DataView(buf, P(6), SCR.length);\n\n  const u32 = (o, name, i) => Object.defineProperty(o, name, { get: () => S[i], set: v => { S[i] = v; }, enumerable: true, configurable: true });\n  const bool = (o, name, i) => Object.defineProperty(o, name, { get: () => S[i] !== 0, set: v => { S[i] = v ? 1 : 0; }, enumerable: true, configurable: true });\n  const f64 = (o, name, i) => Object.defineProperty(o, name, { get: () => D[i], set: v => { D[i] = v; }, enumerable: true, configurable: true });\n  u32(cpu, 'hi', 0); u32(cpu, 'lo', 1); u32(cpu, 'pc', 2); u32(cpu, 'nextPc', 3); bool(cpu, 'isBranch', 4); u32(cpu, 'pendReg', 5); u32(cpu, 'pendVal', 6);\n  f64(cpu, 'cycles', 0); f64(cpu, 'instrCount', 1); f64(psx, 'nextTick', 2);\n  cpu.hi = cur.hi; cpu.lo = cur.lo; cpu.pc = cur.pc; cpu.nextPc = cur.nextPc; cpu.isBranch = cur.isBranch; cpu.pendReg = cur.pendReg; cpu.pendVal = cur.pendVal;\n  cpu.cycles = cur.cycles; cpu.instrCount = cur.instrCount; psx.nextTick = cur.nextTick;\n  S[8] = psx.hookTTY ? 1 : 0;\n\n  psx.useJit = false; psx.jit.flush();\n  const w = psx.wasm = {\n    memory, exports: x, S,\n    /** roda até o próximo tick; devolve 1 se parou no vetor A0/B0 (TTY) */\n    run() { S[7] = (bus.istat & bus.imask) !== 0 ? 1 : 0; S[8] = psx.hookTTY ? 1 : 0; return x.run(); },\n    skipHook() { S[9] = 1; },\n  };\n  return w;\n}\n\nreturn { wasmAvailable, enableWasm };\n})();\nconst __src_disasm = (() => {\n// Disassembler MIPS I (R3000A) - usado para trace/debug\nconst { REG_NAMES } = __src_cpu;\nconst R = REG_NAMES.map(n => '$' + n);\nconst h = (v, n = 8) => '0x' + (v >>> 0).toString(16).padStart(n, '0');\n\nfunction disasm(w, pc) {\n  if (w === 0) return 'nop';\n  const op = w >>> 26, rs = (w >>> 21) & 31, rt = (w >>> 16) & 31, rd = (w >>> 11) & 31;\n  const sh = (w >>> 6) & 31, imm = w & 0xFFFF, simm = (w << 16) >> 16;\n  const mem = n => `${n} ${R[rt]}, ${simm}(${R[rs]})`;\n  const br = n => `${n} ${R[rs]}, ${R[rt]}, ${h(pc + 4 + (simm << 2))}`;\n  switch (op) {\n    case 0x00: {\n      const f = w & 0x3F;\n      const sh3 = { 0x00: 'sll', 0x02: 'srl', 0x03: 'sra' };\n      const shv = { 0x04: 'sllv', 0x06: 'srlv', 0x07: 'srav' };\n      const alu = { 0x20: 'add', 0x21: 'addu', 0x22: 'sub', 0x23: 'subu', 0x24: 'and', 0x25: 'or', 0x26: 'xor', 0x27: 'nor', 0x2A: 'slt', 0x2B: 'sltu' };\n      if (sh3[f]) return `${sh3[f]} ${R[rd]}, ${R[rt]}, ${sh}`;\n      if (shv[f]) return `${shv[f]} ${R[rd]}, ${R[rt]}, ${R[rs]}`;\n      if (alu[f]) return `${alu[f]} ${R[rd]}, ${R[rs]}, ${R[rt]}`;\n      switch (f) {\n        case 0x08: return `jr ${R[rs]}`;\n        case 0x09: return `jalr ${R[rd]}, ${R[rs]}`;\n        case 0x0C: return 'syscall';\n        case 0x0D: return 'break';\n        case 0x10: return `mfhi ${R[rd]}`;\n        case 0x11: return `mthi ${R[rs]}`;\n        case 0x12: return `mflo ${R[rd]}`;\n        case 0x13: return `mtlo ${R[rs]}`;\n        case 0x18: return `mult ${R[rs]}, ${R[rt]}`;\n        case 0x19: return `multu ${R[rs]}, ${R[rt]}`;\n        case 0x1A: return `div ${R[rs]}, ${R[rt]}`;\n        case 0x1B: return `divu ${R[rs]}, ${R[rt]}`;\n      }\n      return `.word ${h(w)}`;\n    }\n    case 0x01: {\n      const n = ['bltz', 'bgez', 'bltzal', 'bgezal'][((rt >> 3) & 2) | (rt & 1)];\n      return `${n} ${R[rs]}, ${h(pc + 4 + (simm << 2))}`;\n    }\n    case 0x02: return `j ${h(((pc + 4) & 0xF0000000) | ((w & 0x3FFFFFF) << 2))}`;\n    case 0x03: return `jal ${h(((pc + 4) & 0xF0000000) | ((w & 0x3FFFFFF) << 2))}`;\n    case 0x04: return br('beq');\n    case 0x05: return br('bne');\n    case 0x06: return `blez ${R[rs]}, ${h(pc + 4 + (simm << 2))}`;\n    case 0x07: return `bgtz ${R[rs]}, ${h(pc + 4 + (simm << 2))}`;\n    case 0x08: return `addi ${R[rt]}, ${R[rs]}, ${simm}`;\n    case 0x09: return `addiu ${R[rt]}, ${R[rs]}, ${simm}`;\n    case 0x0A: return `slti ${R[rt]}, ${R[rs]}, ${simm}`;\n    case 0x0B: return `sltiu ${R[rt]}, ${R[rs]}, ${simm}`;\n    case 0x0C: return `andi ${R[rt]}, ${R[rs]}, ${h(imm, 4)}`;\n    case 0x0D: return `ori ${R[rt]}, ${R[rs]}, ${h(imm, 4)}`;\n    case 0x0E: return `xori ${R[rt]}, ${R[rs]}, ${h(imm, 4)}`;\n    case 0x0F: return `lui ${R[rt]}, ${h(imm, 4)}`;\n    case 0x10:\n      if (rs === 0) return `mfc0 ${R[rt]}, cop0r${rd}`;\n      if (rs === 4) return `mtc0 ${R[rt]}, cop0r${rd}`;\n      if (w === 0x42000010) return 'rfe';\n      return `cop0 ${h(w & 0x1FFFFFF)}`;\n    case 0x12:\n      if (w & 0x02000000) return `cop2 ${h(w & 0x1FFFFFF, 7)}`;\n      return `${{ 0: 'mfc2', 2: 'cfc2', 4: 'mtc2', 6: 'ctc2' }[rs] || 'cop2?'} ${R[rt]}, cop2r${rd}`;\n    case 0x20: return mem('lb');\n    case 0x21: return mem('lh');\n    case 0x22: return mem('lwl');\n    case 0x23: return mem('lw');\n    case 0x24: return mem('lbu');\n    case 0x25: return mem('lhu');\n    case 0x26: return mem('lwr');\n    case 0x28: return mem('sb');\n    case 0x29: return mem('sh');\n    case 0x2A: return mem('swl');\n    case 0x2B: return mem('sw');\n    case 0x2E: return mem('swr');\n    case 0x32: return `lwc2 cop2r${rt}, ${simm}(${R[rs]})`;\n    case 0x3A: return `swc2 cop2r${rt}, ${simm}(${R[rs]})`;\n  }\n  return `.word ${h(w)}`;\n}\n\nreturn { disasm };\n})();\nconst __src_bus = (() => {\n// ============================================================================\n//  Bus / Memory map do PS1\n// ============================================================================\n//  Endereço virtual (KUSEG/KSEG0/KSEG1) -> físico removendo os 3 bits altos:\n//    KUSEG 0x00000000-0x7FFFFFFF  (cacheado, máscara 0xFFFFFFFF)\n//    KSEG0 0x80000000-0x9FFFFFFF  (cacheado, máscara 0x7FFFFFFF)\n//    KSEG1 0xA0000000-0xBFFFFFFF  (NÃO cacheado, máscara 0x1FFFFFFF)\n//    KSEG2 0xC0000000-0xFFFFFFFF  (só 0xFFFE0130 = Cache Control)\n//\n//  Mapa físico:\n//    0x00000000-0x007FFFFF  RAM 2MB (espelhada 4x até 8MB)\n//    0x1F000000-0x1F7FFFFF  Expansion 1 (cartucho / PIO) - sem nada = 0xFF\n//    0x1F800000-0x1F8003FF  Scratchpad (D-Cache usado como RAM, 1KB)\n//    0x1F801000-0x1F801FFF  I/O (memctrl, DMA, timers, CDROM, GPU, MDEC, SPU)\n//    0x1F802000-0x1F803FFF  Expansion 2 (POST/DUART)\n//    0x1FC00000-0x1FC7FFFF  BIOS ROM 512KB\n// ============================================================================\n\nconst REGION_MASK = new Uint32Array([\n  0xFFFFFFFF, 0xFFFFFFFF, 0xFFFFFFFF, 0xFFFFFFFF, // KUSEG\n  0x7FFFFFFF,                                     // KSEG0\n  0x1FFFFFFF,                                     // KSEG1\n  0xFFFFFFFF, 0xFFFFFFFF,                         // KSEG2\n]);\nconst SIZE_MASK = [0, 0xFF, 0xFFFF, 0, 0xFFFFFFFF];\n\nconst RAM_SIZE = 2 * 1024 * 1024;\nconst BIOS_SIZE = 512 * 1024;\n\nclass Bus {\n  constructor() {\n    this.pollOn = false; this.ioSeq = 0; this.psx = null; this.poll = { p: -1, v: -1, t: 0, d1: -1, d2: -2, n: 0, seq: 0, skipped: 0, jumps: 0 };\n    this.ram = new Uint8Array(RAM_SIZE);\n    this.ramView = new DataView(this.ram.buffer);\n    this.scratch = new Uint8Array(1024);\n    this.scratchView = new DataView(this.scratch.buffer);\n    this.bios = new Uint8Array(BIOS_SIZE).fill(0xFF);\n    this.biosView = new DataView(this.bios.buffer);\n    this.io = new Uint8Array(0x2000);          // backing store dos registradores I/O ainda não emulados\n    this.ioView = new DataView(this.io.buffer);\n\n    this.codeFlags = new Uint8Array(RAM_SIZE >> 6);   // linhas de 64 B da RAM que contêm código compilado (JIT)\n    this.onCodeWrite = null;\n    this.istat = 0;                            // 0x1F801070 I_STAT\n    this.imask = 0;                            // 0x1F801074 I_MASK\n    this.cacheCtrl = 0;                        // 0xFFFE0130\n    this.gpuToggle = 0;\n\n    this.logIo = false;                        // contabiliza acessos a I/O (útil p/ mapear o que a BIOS usa)\n    this.ioStats = new Map();\n    this.unmapped = new Map();\n    this.onPost = null;                        // callback(code) escrita em 0x1F802041\n    this.gpu = null;                           // GPU  (0x1F801810 / 0x1F801814)\n    this.spu = null;                           // SPU  (0x1F801C00-0x1F801FFF)\n    this.dma = null; this.timers = null; this.sio = null; this.cdrom = null; this.mdec = null;   // dispositivos (ligados pelo PSX)\n  }\n\n  loadBios(data) {\n    if (data.length !== BIOS_SIZE) throw new Error(`BIOS deve ter ${BIOS_SIZE} bytes, recebeu ${data.length}`);\n    this.bios.set(data);\n  }\n\n  // ---- IRQ (I_STAT / I_MASK) ----\n  irqPending() { return (this.istat & this.imask) !== 0; }\n  raiseIrq(n) { this.istat |= (1 << n); }\n\n  // ---- Leitura ----\n  read32(addr) { return this.read(addr, 4); }\n  read16(addr) { return this.read(addr, 2); }\n  read8(addr)  { return this.read(addr, 1); }\n\n  read(addr, size) {\n    const p = (addr & REGION_MASK[addr >>> 29]) >>> 0;\n    if (p < 0x00800000) {\n      const o = p & 0x1FFFFF;\n      return size === 4 ? this.ramView.getUint32(o, true)\n           : size === 2 ? this.ramView.getUint16(o, true) : this.ram[o];\n    }\n    if (p >= 0x1FC00000 && p < 0x1FC80000) {\n      const o = p - 0x1FC00000;\n      return size === 4 ? this.biosView.getUint32(o, true)\n           : size === 2 ? this.biosView.getUint16(o, true) : this.bios[o];\n    }\n    if (p >= 0x1F800000 && p < 0x1F800400) {\n      const o = p - 0x1F800000;\n      return size === 4 ? this.scratchView.getUint32(o, true)\n           : size === 2 ? this.scratchView.getUint16(o, true) : this.scratch[o];\n    }\n    if (p >= 0x1F801000 && p < 0x1F802000) return this.ioRead(p, size);\n    if (p >= 0x1F000000 && p < 0x1F800000) return SIZE_MASK[size];   // Expansion 1 vazio\n    if (p >= 0x1F802000 && p < 0x1F804000) return 0;                 // Expansion 2\n    if (p === 0xFFFE0130) return this.cacheCtrl;\n    this.noteUnmapped('R', p, size);\n    return SIZE_MASK[size];\n  }\n\n  // ---- Escrita ----\n  write32(addr, v) { this.write(addr, 4, v); }\n  write16(addr, v) { this.write(addr, 2, v); }\n  write8(addr, v)  { this.write(addr, 1, v); }\n\n  write(addr, size, v) {\n    const p = (addr & REGION_MASK[addr >>> 29]) >>> 0;\n    if (p < 0x00800000) {\n      const o = p & 0x1FFFFF;\n      if (size === 4) this.ramView.setUint32(o, v >>> 0, true);\n      else if (size === 2) this.ramView.setUint16(o, v & 0xFFFF, true);\n      else this.ram[o] = v;\n      if (this.codeFlags[o >>> 6]) this.onCodeWrite(o);\n      return;\n    }\n    if (p >= 0x1F800000 && p < 0x1F800400) {\n      const o = p - 0x1F800000;\n      if (size === 4) this.scratchView.setUint32(o, v >>> 0, true);\n      else if (size === 2) this.scratchView.setUint16(o, v & 0xFFFF, true);\n      else this.scratch[o] = v;\n      return;\n    }\n    if (p >= 0x1F801000 && p < 0x1F802000) return this.ioWrite(p, size, v);\n    if (p >= 0x1F802000 && p < 0x1F804000) {\n      if (p === 0x1F802041 && this.onPost) this.onPost(v & 0xFF);\n      return;\n    }\n    if (p >= 0x1FC00000 && p < 0x1FC80000) return;                   // ROM: ignora\n    if (p >= 0x1F000000 && p < 0x1F800000) return;                   // Expansion 1\n    if (p === 0xFFFE0130) { this.cacheCtrl = v >>> 0; return; }\n    this.noteUnmapped('W', p, size);\n  }\n\n  // ---- I/O ----\n  /** leitura de I/O. Com pollOn (psx.pollSkip = true) reconhece laços de espera (\"lê o mesmo registrador, mesmo valor, período constante\")\n   *  e avança o relógio até o próximo instante em que o valor pode mudar (fim da linha de vídeo, evento agendado, fim do \"ocupado\" da GPU). */\n  ioRead(p, size) {\n    if (!this.pollOn) return this.ioRead0(p, size);\n    const q = p & ~3;\n    if (!(q === 0x1F801814 || q === 0x1F801070 || (p >= 0x1F801100 && p < 0x1F801130 && (p & 0xF) === 0) || (p >= 0x1F801080 && p < 0x1F801100 && (p & 0xF) === 8))) { this.ioSeq = (this.ioSeq + 1) | 0; return this.ioRead0(p, size); }\n    let v = this.ioRead0(p, size);\n    const ps = this.poll, psx = this.psx, now = psx.cpu.cycles, d = now - ps.t;\n    if (p === ps.p && v === ps.v && this.ioSeq === ps.seq && d === ps.d2) ps.n++; else ps.n = 0;\n    ps.d2 = ps.d1; ps.d1 = d; ps.t = now; ps.p = p; ps.v = v; ps.seq = this.ioSeq;\n    if (ps.n >= 8) {\n      ps.n = 0;\n      if (!(this.istat & this.imask)) {\n        let end = psx.lastTick + (psx.gpu.pal ? 2157.2 : 2146.3) - psx.lineAcc; const ev = psx.sched.next; if (ev < end) end = ev;\n        const bu = psx.gpu.busyUntil; if (bu > now && bu < end) end = bu;\n        if (end - now > 4 * (d > 0 ? d : 1)) { psx.cpu.cycles = Math.ceil(end); ps.skipped += end - now; ps.jumps++; v = this.ioRead0(p, size); ps.v = v; ps.t = psx.cpu.cycles; }\n      }\n    }\n    return v;\n  }\n  ioRead0(p, size) {\n    if (this.logIo) this.countIo('R', p, size);\n    const off = p - 0x1F801000;\n    if (p >= 0x1F801810 && p < 0x1F801818 && this.gpu) { if ((p & ~3) === 0x1F801810) return this.gpu.readData() >>> ((p & 3) * 8); return this.gpu.readStatus() >>> ((p & 3) * 8); }   // GPU primeiro (é o registrador mais lido)\n    if (this.spu && p >= 0x1F801C00) return this.spu.read(p, size);\n    if (this.cdrom && p >= 0x1F801800 && p < 0x1F801804) return this.cdrom.read(p, size);\n    if (this.mdec && (p & ~3) >= 0x1F801820 && (p & ~3) <= 0x1F801824) return this.mdec.read(p & ~3);\n    if (p >= 0x1F801820 && p < 0x1F801828) return (p & ~3) === 0x1F801824 ? 0x80040000 >>> ((p & 3) * 8) : 0;   // sem MDEC: status \"FIFOs vazios\"\n    if (this.dma && p >= 0x1F801080 && p < 0x1F801100) return this.dma.read(p, size);\n    if (this.timers && p >= 0x1F801100 && p < 0x1F801130) return this.timers.read(p, size);\n    if (this.sio && p >= 0x1F801040 && p < 0x1F801050) return this.sio.read(p, size);\n    // SPUSTAT (0x1F801DAE) espelha os 6 bits baixos do SPUCNT (0x1F801DAA) - fallback sem SPU\n    if (p === 0x1F801DAE && size === 2) return this.ioView.getUint16(0xDAA, true) & 0x3F;\n\n    const base = (p & ~3) >>> 0, shift = (p & 3) * 8;\n    let v = null;\n    switch (base) {\n      case 0x1F801070: v = this.istat; break;\n      case 0x1F801074: v = this.imask; break;\n      case 0x1F801814:                                   // GPUSTAT (fallback sem GPU): pronto\n        v = 0x1C000000; break;\n    }\n    if (v !== null) return ((v >>> shift) & SIZE_MASK[size]) >>> 0;\n\n    return size === 4 ? this.ioView.getUint32(off, true)\n         : size === 2 ? this.ioView.getUint16(off, true) : this.io[off];\n  }\n\n  ioWrite(p, size, v) {\n    if (this.logIo) this.countIo('W', p, size);\n    const off = p - 0x1F801000;\n    if (this.spu && p >= 0x1F801C00) return this.spu.write(p, size, v);\n    if (this.cdrom && p >= 0x1F801800 && p < 0x1F801804) return this.cdrom.write(p, size, v);\n    if (this.dma && p >= 0x1F801080 && p < 0x1F801100) return this.dma.write(p, size, v);\n    if (this.timers && p >= 0x1F801100 && p < 0x1F801130) return this.timers.write(p, size, v);\n    if (this.sio && p >= 0x1F801040 && p < 0x1F801050) return this.sio.write(p, size, v);\n    if (this.mdec && (p & ~3) >= 0x1F801820 && (p & ~3) <= 0x1F801824) return this.mdec.write(p & ~3, v);\n    if (this.gpu && (p & ~3) === 0x1F801810) return this.gpu.writeGP0(v);\n    if (this.gpu && (p & ~3) === 0x1F801814) return this.gpu.writeGP1(v);\n    const base = (p & ~3) >>> 0, shift = (p & 3) * 8;\n    const m = (SIZE_MASK[size] << shift);\n    if (base === 0x1F801070) {                           // I_STAT: escrever 0 reconhece (limpa) o bit\n      this.istat = (this.istat & (~m | (v << shift))) & 0x7FF; return;\n    }\n    if (base === 0x1F801074) {                           // I_MASK\n      this.imask = ((this.imask & ~m) | ((v << shift) & m)) & 0x7FF; return;\n    }\n    if (size === 4) this.ioView.setUint32(off, v >>> 0, true);\n    else if (size === 2) this.ioView.setUint16(off, v & 0xFFFF, true);\n    else this.io[off] = v;\n  }\n\n  countIo(rw, p, size) {\n    const k = `${rw}${size} ${p.toString(16).toUpperCase().padStart(8, '0')}`;\n    this.ioStats.set(k, (this.ioStats.get(k) || 0) + 1);\n  }\n  noteUnmapped(rw, p, size) {\n    const k = `${rw}${size} ${p.toString(16).toUpperCase().padStart(8, '0')}`;\n    this.unmapped.set(k, (this.unmapped.get(k) || 0) + 1);\n  }\n}\n\nreturn { RAM_SIZE, BIOS_SIZE, Bus };\n})();\nconst __src_gpu = (() => {\n// ============================================================================\n//  GPU do PS1 - rasterizador por software\n// ============================================================================\n//  Portas:  0x1F801810 GP0 (desenho/VRAM) / GPUREAD      0x1F801814 GP1 (controle) / GPUSTAT\n//  VRAM:    1024x512 pixels de 16 bits (RGB555 + bit de máscara)\n//\n//  Implementado: fill, polígonos (flat/gouraud/texturizados 4/8/15 bits, semi-transparência\n//  4 modos, dither, máscara), retângulos, linhas/polilinhas, cópias de VRAM (CPU<->VRAM,\n//  VRAM->VRAM), janela de textura, area/offset de desenho, saída 15/24 bits.\n//  Simplificações: sem timing real de GPU, interpolação em ponto flutuante (não bit-exata).\n// ============================================================================\n\nconst PH_CMD = 0, PH_VRAM_WRITE = 1, PH_POLYLINE = 2;\nconst LINE_EX = 1 / 4194304, LINE_EY = 0;                  // viés de arredondamento de x (medido no console real)\nconst DITHER = [-4, 0, -3, 1, 2, -2, 3, -1, -3, 1, -4, 0, 3, -1, 2, -2];\nconst sx11 = v => (v << 21) >> 21;                       // sinal 11 bits\n\n\n// ---- scanline especializada (gerada por combinação de modos): mesma aritmética do plotNB/texel, sem ramos por pixel ----\nconst QT = new Uint8Array(1024); for (let i = 0; i < 1024; i++) { const v = i - 8; QT[i] = (v < 0 ? 0 : v > 255 ? 255 : v) >> 3; }   // clamp8(v) >> 3, índice v+8\nconst DITHER_T = new Int8Array(DITHER);\nconst SPANS = new Map();\nfunction spanFor(tex, td, gour, raw, semi, dd, chk, win) {\n  const key = (tex ? td : 'n') + (gour ? 'G' : 'f') + (raw ? 'R' : 'm') + (semi ? 'S' : 'o') + (dd ? 'D' : 'n') + (chk ? 'C' : '-') + (win ? 'W' : '-');\n  let f = SPANS.get(key); if (f) return f;\n  let c = 'const rowI = y * 1024, dRow = (y & 3) << 2;\\nfor (let x = xl; x < xr; x++) {\\n';\n  c += gour ? 'let r = ((cr | 0) >> 12) & 255, g = ((cg | 0) >> 12) & 255, bl = ((cb | 0) >> 12) & 255; cr += rGx; cg += gGx; cb += bGx;\\n' : 'let r = fr, g = fg, bl = fb;\\n';\n  if (tex) {\n    c += win ? 'const u = (((cu | 0) >> 12) & 255 & uAnd) | uOr, v = (((cv | 0) >> 12) & 255 & vAnd) | vOr;\\n' : 'const u = ((cu | 0) >> 12) & 255, v = ((cv | 0) >> 12) & 255;\\n';\n    c += 'cu += uGx; cv += vGx;\\nconst row = ((tY + v) & 0x1FF) << 10;\\n';\n    if (td === 0) c += 'const texel = clut[(vram[row + ((tBase + (u >> 2)) & 0x3FF)] >> ((u & 3) << 2)) & 15];\\n';\n    else if (td === 1) c += 'const texel = clut[(vram[row + ((tBase + (u >> 1)) & 0x3FF)] >> ((u & 1) << 3)) & 255];\\n';\n    else c += 'const texel = vram[row + ((tBase + u) & 0x3FF)];\\n';\n    c += 'if (texel === 0) continue;\\n';\n    if (semi) c += 'const sm = (texel & 0x8000) !== 0;\\n';\n    c += 'const tr = texel & 31, tg = (texel >> 5) & 31, tb = (texel >> 10) & 31;\\n';\n    c += raw ? 'r = tr << 3; g = tg << 3; bl = tb << 3;\\n' : 'r = (tr * r) >> 4; g = (tg * g) >> 4; bl = (tb * bl) >> 4;\\n';\n  }\n  c += 'const idx = rowI + x;\\n';\n  if (chk || semi) c += 'const back = vram[idx];\\n';\n  if (chk) c += 'if (back & 0x8000) continue;\\n';\n  if (dd) c += 'const d = DITHER[dRow | (x & 3)]; r += d; g += d; bl += d;\\n';\n  c += 'r = QT[r + 8]; g = QT[g + 8]; bl = QT[bl + 8];\\n';\n  if (semi) {\n    const blend = 'const br = back & 31, bg = (back >> 5) & 31, bb = (back >> 10) & 31;\\n' +\n      'switch (smode) {\\ncase 0: r = (br + r) >> 1; g = (bg + g) >> 1; bl = (bb + bl) >> 1; break;\\n' +\n      'case 1: r = br + r > 31 ? 31 : br + r; g = bg + g > 31 ? 31 : bg + g; bl = bb + bl > 31 ? 31 : bb + bl; break;\\n' +\n      'case 2: r = br - r < 0 ? 0 : br - r; g = bg - g < 0 ? 0 : bg - g; bl = bb - bl < 0 ? 0 : bb - bl; break;\\n' +\n      'default: r = Math.min(31, br + (r >> 2)); g = Math.min(31, bg + (g >> 2)); bl = Math.min(31, bb + (bl >> 2));\\n}\\n';\n    c += tex ? 'if (sm) {\\n' + blend + '}\\n' : '{\\n' + blend + '}\\n';\n  }\n  c += 'vram[idx] = r | (g << 5) | (bl << 10) | setM;\\n}';\n  f = new Function('vram', 'clut', 'QT', 'DITHER', 'y', 'xl', 'xr', 'cr', 'cg', 'cb', 'cu', 'cv', 'rGx', 'gGx', 'bGx', 'uGx', 'vGx', 'fr', 'fg', 'fb', 'tBase', 'tY', 'uAnd', 'uOr', 'vAnd', 'vOr', 'smode', 'setM', c);\n  SPANS.set(key, f); return f;\n}\n\nclass GPU {\n  constructor() {\n    this.vram = new Uint16Array(1024 * 512);\n    this.pal = false;\n    this.onIrq = null;\n    this.hw = null;                                          // renderizador WebGL (glgpu.js); null = software\n    this.remote = null;                                      // GpuStream: o desenho acontece num worker (esta instância só analisa os comandos e mantém o estado/temporização)\n    this.line = 0; this.vblank = false; this.field = 0;      // temporização (atualizada pelo PSX)\n    this.reset();\n  }\n\n  reset() {\n    this.phase = PH_CMD; this.buf = []; this.need = 1;\n    // ---- estado de desenho (GP0 E1..E6) ----\n    this.texX = 0; this.texY = 0; this.semiMode = 0; this.texDepth = 0; this.dither = false;\n    this.drawToDisplay = false; this.texDisable = false; this.texDisAllow = false; this.busyUntil = 0; this.skipDraw = false; this.flipX = false; this.flipY = false;\n    this.twMaskX = 0; this.twMaskY = 0; this.twOffX = 0; this.twOffY = 0;\n    this.daX1 = 0; this.daY1 = 0; this.daX2 = 0; this.daY2 = 0;\n    this.offX = 0; this.offY = 0;\n    this.setMask = false; this.checkMask = false;\n    this.clutValid = false; this.clutX = 0; this.clutY = 0; this.clutCount = 0; this.clut ??= new Uint16Array(256);   // cache de CLUT\n    // ---- display (GP1) ----\n    this.dispOn = false; this.dmaDir = 0; this.startX = 0; this.startY = 0;\n    this.hx1 = 0x200; this.hx2 = 0xC00; this.vy1 = 0x10; this.vy2 = 0x100;\n    this.hres1 = 0; this.hres2 = 0; this.vres = 0; this.rgb24 = false; this.interlace = false; this.reverse = false; this.deint = 1; this.snapPar = 0;\n    this.irq1 = false;\n    this.gpuRead = 0; this.infoSel = 0;\n    // ---- transferências ----\n    this.vw = null; this.vr = null;\n    this.toggle = 0; this.line = 0; this.vblank = false; this.field = 0;\n    this.frameCount = 0; this.snap = null; this.snapKey = '';\n  }\n\n  // ===================== Registradores =====================\n  readStatus() {\n    let s = (this.texX & 15) | ((this.texY & 1) << 4) | (this.semiMode << 5) | (this.texDepth << 7) |\n            ((this.dither ? 1 : 0) << 9) | ((this.drawToDisplay ? 1 : 0) << 10) | ((this.setMask ? 1 : 0) << 11) |\n            ((this.checkMask ? 1 : 0) << 12) | (1 << 13) | ((this.reverse ? 1 : 0) << 14) | ((this.texDisable ? 1 : 0) << 15) |\n            (this.hres2 << 16) | (this.hres1 << 17) | (this.vres << 19) | ((this.pal ? 1 : 0) << 20) |\n            ((this.rgb24 ? 1 : 0) << 21) | ((this.interlace ? 1 : 0) << 22) | ((this.dispOn ? 0 : 1) << 23) |\n            ((this.irq1 ? 1 : 0) << 24);\n    const busy = !!this.clock && this.clock() < this.busyUntil;                 // GPU ainda desenhando o último comando\n    const readyCmd = this.phase === PH_CMD && !this.vr && !busy;\n    s |= (readyCmd ? 1 << 26 : 0) | (this.vr ? 1 << 27 : 0) | ((this.dmaDir === 0 || !busy ? 1 : 0) << 28) | (this.dmaDir << 29);\n    // bit 25 = DMA data request, depende da direção\n    const req = this.dmaDir === 0 ? 0 : this.dmaDir === 1 ? 1 : this.dmaDir === 2 ? (readyCmd ? 1 : 0) : (this.vr ? 1 : 0);\n    s |= req << 25;\n    // bit 31: campo par/ímpar - alterna (aproximação até existir timing de scanline)\n    const odd = (this.interlace && this.vres) ? this.field : (this.vblank ? 0 : (this.line & 1));\n    s |= (odd << 31);\n    return s >>> 0;\n  }\n\n  readData() {                                    // GPUREAD\n    if (this.vr) return this.vramReadWord();\n    return this.gpuRead >>> 0;\n  }\n\n  // ===================== GP1 =====================\n  writeGP1(w) {\n    if (this.remote) this.remote.push(1, w >>> 0);\n    const cmd = w >>> 24, p = w & 0xFFFFFF;\n    switch (cmd) {\n      case 0x00: this.reset(); break;\n      case 0x01: this.phase = PH_CMD; this.buf = []; this.vw = null; this.vr = null; break;\n      case 0x02: this.irq1 = false; break;\n      case 0x03: this.dispOn = !(p & 1); break;\n      case 0x04: this.dmaDir = p & 3; break;\n      case 0x05: this.startX = p & 0x3FE; this.startY = (p >> 10) & 0x1FF; break;\n      case 0x06: this.hx1 = p & 0xFFF; this.hx2 = (p >> 12) & 0xFFF; break;\n      case 0x07: this.vy1 = p & 0x3FF; this.vy2 = (p >> 10) & 0x3FF; break;\n      case 0x08:\n        this.hres1 = p & 3; this.vres = (p >> 2) & 1; this.pal = !!((p >> 3) & 1);\n        this.rgb24 = !!((p >> 4) & 1); this.interlace = !!((p >> 5) & 1); this.hres2 = (p >> 6) & 1; this.reverse = !!((p >> 7) & 1);\n        break;\n      case 0x09: this.texDisAllow = !!(p & 1); break;   // permite o bit \"texture disable\" (E1.11)\n      default:\n        if (cmd >= 0x10 && cmd <= 0x1F) {           // GET GPU INFO\n          switch (p & 7) {\n            case 2: this.gpuRead = this.twMaskX | (this.twMaskY << 5) | (this.twOffX << 10) | (this.twOffY << 15); break;\n            case 3: this.gpuRead = this.daX1 | (this.daY1 << 10); break;\n            case 4: this.gpuRead = this.daX2 | (this.daY2 << 10); break;\n            case 5: this.gpuRead = (this.offX & 0x7FF) | ((this.offY & 0x7FF) << 11); break;\n            case 7: this.gpuRead = 2; break;        // tipo de GPU\n            default: break;\n          }\n        }\n    }\n  }\n\n  // ===================== GP0 =====================\n  writeGP0(w) {\n    w >>>= 0;\n    const R = this.remote; if (R) { if (R.n >= R.q.length) R.flush(); R.q[R.n++] = 0; R.q[R.n++] = w; }\n    if (this.phase === PH_VRAM_WRITE) { this.vramWriteWord(w); return; }\n    if (this.phase === PH_POLYLINE) { this.polylineWord(w); return; }\n    if (this.buf.length === 0) this.need = this.wordsFor(w >>> 24);\n    this.buf.push(w);\n    if (this.buf.length >= this.need) {\n      const b = this.buf; this.buf = [];\n      this.exec(b);\n    }\n  }\n  /** Para DMA (canal 2): bloco de palavras em RAM */\n  dmaWrite(words) { for (let i = 0; i < words.length; i++) this.writeGP0(words[i]); }\n  dmaRead(n) { const o = new Uint32Array(n); for (let i = 0; i < n; i++) o[i] = this.readData(); return o; }\n\n  wordsFor(c) {\n    if (c === 0x02) return 3;\n    if (c >= 0x20 && c <= 0x3F) { const v = (c & 8) ? 4 : 3; return 1 + v + ((c & 4) ? v : 0) + ((c & 0x10) ? v - 1 : 0); }\n    if (c >= 0x40 && c <= 0x5F) return (c & 0x10) ? 4 : 3;           // polilinha trata o resto\n    if (c >= 0x60 && c <= 0x7F) return 2 + ((c & 4) ? 1 : 0) + (((c >> 3) & 3) === 0 ? 1 : 0);\n    if (c >= 0x80 && c <= 0x9F) return 4;\n    if (c >= 0xA0 && c <= 0xDF) return 3;\n    return 1;\n  }\n\n  exec(b) {\n    const c = b[0] >>> 24;\n    if (this.clock) this.chargeBusy(c, b);\n    if (c === 0x02) return this.fillRect(b);\n    if (c >= 0x20 && c <= 0x3F) return this.polygon(b, c);\n    if (c >= 0x40 && c <= 0x5F) return this.lineCmd(b, c);\n    if (c >= 0x60 && c <= 0x7F) return this.rect(b, c);\n    if (c >= 0x80 && c <= 0x9F) return this.vramCopy(b);\n    if (c >= 0xA0 && c <= 0xBF) return this.beginVramWrite(b);\n    if (c >= 0xC0 && c <= 0xDF) return this.beginVramRead(b);\n    switch (c) {\n      case 0x01: this.clutValid = false; break;                  // limpa o cache de CLUT\n      case 0x1F: this.irq1 = true; this.onIrq?.(); break;\n      case 0xE1: {\n        this.texX = b[0] & 15; this.texY = (b[0] >> 4) & 1; this.semiMode = (b[0] >> 5) & 3; this.texDepth = (b[0] >> 7) & 3;      // 3 é reservado: lido de volta como 3, tratado como 15 bits\n        this.dither = !!((b[0] >> 9) & 1); this.drawToDisplay = !!((b[0] >> 10) & 1); this.texDisable = this.texDisAllow && !!((b[0] >> 11) & 1);\n        this.flipX = !!((b[0] >> 12) & 1); this.flipY = !!((b[0] >> 13) & 1); break;\n      }\n      case 0xE2: this.twMaskX = b[0] & 31; this.twMaskY = (b[0] >> 5) & 31; this.twOffX = (b[0] >> 10) & 31; this.twOffY = (b[0] >> 15) & 31; break;\n      case 0xE3: this.daX1 = b[0] & 0x3FF; this.daY1 = (b[0] >> 10) & 0x3FF; break;\n      case 0xE4: this.daX2 = b[0] & 0x3FF; this.daY2 = (b[0] >> 10) & 0x3FF; break;\n      case 0xE5: this.offX = sx11(b[0] & 0x7FF); this.offY = sx11((b[0] >> 11) & 0x7FF); break;\n      case 0xE6: this.setMask = !!(b[0] & 1); this.checkMask = !!(b[0] & 2); break;\n      default: break;                                // NOP / clear cache / etc.\n    }\n  }\n\n  // ===================== Tempo de desenho (GPUSTAT: pronto p/ comando / DMA) =====================\n  /** estima quantos ciclos de CPU o comando mantém a GPU ocupada e soma em busyUntil */\n  chargeBusy(c, b) {\n    let cyc = 0;\n    const semi = !!(c & 2), tex = !!(c & 4);\n    // fatores calibrados com ps1-tests/gpu/bandwidth (PS1 real): ciclos de CPU por pixel\n    if (c === 0x02) cyc = (((b[2] & 0x3FF) + 15) & ~15) * ((b[2] >>> 16) & 0x1FF) * 0.085 + 30;\n    else if (c >= 0x20 && c <= 0x3F) {\n      const n = (c & 8) ? 4 : 3, gour = !!(c & 0x10), tx = !!(c & 4);\n      let p = 1, x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;\n      for (let i = 0; i < n; i++) {\n        if (i > 0 && gour) p++;\n        const v = b[p++], x = ((v << 21) >> 21) + this.offX, y = ((v << 5) >> 21) + this.offY; if (tx) p++;\n        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;\n      }\n      x0 = Math.max(x0, this.daX1); y0 = Math.max(y0, this.daY1); x1 = Math.min(x1, this.daX2); y1 = Math.min(y1, this.daY2);   // só conta a parte visível\n      const area = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);\n      cyc = area * (n === 4 ? 0.54 : 0.27) * (semi ? 1.5 : 1) * (tx ? 5.2 : 1) + 60;\n    } else if (c >= 0x40 && c <= 0x5F) {\n      const a = b[1], d = b[(c & 0x10) ? 3 : 2], dx = Math.abs(((a << 21) >> 21) - ((d << 21) >> 21)), dy = Math.abs(((a << 5) >> 21) - ((d << 5) >> 21));\n      cyc = Math.max(dx, dy) * 1.2 + 40;\n    } else if (c >= 0x60 && c <= 0x7F) {\n      const sz = (c >> 3) & 3, w = sz === 0 ? b[b.length - 1] & 0x3FF : sz === 1 ? 1 : sz === 2 ? 8 : 16, h = sz === 0 ? (b[b.length - 1] >>> 16) & 0x1FF : sz === 1 ? 1 : sz === 2 ? 8 : 16;\n      cyc = w * h * (tex ? 1.06 : semi ? 0.8 : 0.53) + 30;\n    } else if (c >= 0x80 && c <= 0x9F) cyc = (((b[3] - 1) & 0x3FF) + 1) * ((((b[3] >>> 16) - 1) & 0x1FF) + 1) * 1.33 + 40;\n    if (cyc > 0 && this.rowMask >= 0 && c !== 0x80 && !(c >= 0x80 && c <= 0x9F)) cyc *= 0.5;   // 480i: só metade das linhas é desenhada\n    if (cyc > 0) { const now = this.clock(); this.busyUntil = Math.max(now, this.busyUntil) + cyc; }\n  }\n\n  // ===================== Transferências VRAM =====================\n  fillRect(b) {\n    const col = rgb24to15(b[0]);\n    const x0 = b[1] & 0x3F0, y0 = (b[1] >>> 16) & 0x1FF;\n    const w = ((b[2] & 0x3FF) + 0xF) & ~0xF, h = (b[2] >>> 16) & 0x1FF;\n    if (this.remote) return;\n    if (this.hw) return this.hw.fill(x0, y0, w, h, b[0]);\n    const mk = this.rowMask;\n    for (let y = 0; y < h; y++) {\n      if (mk >= 0 && ((y0 + y) & 1) === mk) continue;\n      const row = ((y0 + y) & 0x1FF) * 1024;\n      for (let x = 0; x < w; x++) this.vram[row + ((x0 + x) & 0x3FF)] = col;\n    }\n  }\n\n  beginVramWrite(b) {\n    const x = b[1] & 0x3FF, y = (b[1] >>> 16) & 0x1FF;\n    const w = ((b[2] - 1) & 0x3FF) + 1, h = (((b[2] >>> 16) - 1) & 0x1FF) + 1;\n    if (this.hw && this.checkMask) this.hw.rects(x, y, w, h, (rx, ry, rw, rh) => this.hw.syncNative(rx, ry, rw, rh));\n    this.vw = { x, y, w, h, i: 0, total: w * h };\n    this.phase = PH_VRAM_WRITE;\n  }\n  vramWriteWord(word) {\n    const t = this.vw;\n    if (this.remote) { t.i += 2; if (t.i >= t.total) { this.phase = PH_CMD; this.vw = null; } return; }\n    for (let k = 0; k < 2 && t.i < t.total; k++, t.i++) {\n      const px = (word >>> (16 * k)) & 0xFFFF;\n      const xx = (t.x + (t.i % t.w)) & 0x3FF, yy = (t.y + ((t.i / t.w) | 0)) & 0x1FF;\n      const idx = yy * 1024 + xx;\n      if (this.checkMask && (this.vram[idx] & 0x8000)) continue;\n      this.vram[idx] = px | (this.setMask ? 0x8000 : 0);\n    }\n    if (t.i >= t.total) { this.phase = PH_CMD; this.vw = null; if (this.hw) this.hw.uploaded(t.x, t.y, t.w, t.h); }\n  }\n\n  beginVramRead(b) {\n    const x = b[1] & 0x3FF, y = (b[1] >>> 16) & 0x1FF;\n    const w = ((b[2] - 1) & 0x3FF) + 1, h = (((b[2] >>> 16) - 1) & 0x1FF) + 1;\n    if (this.remote) this.remote.onRead?.();                   // o jogo lê a VRAM de volta: o worker volta para esta thread (a leitura atual sai defasada)\n    if (this.hw) this.hw.rects(x, y, w, h, (rx, ry, rw, rh) => this.hw.syncNative(rx, ry, rw, rh));\n    this.vr = { x, y, w, h, i: 0, total: w * h };\n  }\n  vramReadWord() {\n    const t = this.vr; let out = 0;\n    for (let k = 0; k < 2; k++) {\n      let px = 0;\n      if (t.i < t.total) { px = this.vram[((t.y + ((t.i / t.w) | 0)) & 0x1FF) * 1024 + ((t.x + (t.i % t.w)) & 0x3FF)]; t.i++; }\n      out |= px << (16 * k);\n    }\n    if (t.i >= t.total) this.vr = null;\n    return out >>> 0;\n  }\n\n  vramCopy(b) {\n    const sx = b[1] & 0x3FF, sy = (b[1] >>> 16) & 0x1FF, dx = b[2] & 0x3FF, dy = (b[2] >>> 16) & 0x1FF;\n    const w = ((b[3] - 1) & 0x3FF) + 1, h = (((b[3] >>> 16) - 1) & 0x1FF) + 1;\n    if (this.remote) return;\n    if (this.hw && this.hw.copy(sx, sy, dx, dy, w, h)) return;\n    const CH = 16, buf = new Uint16Array(CH);          // o hardware lê/escreve em rajadas de 16 pixels (medido)\n    for (let y = 0; y < h; y++) for (let x0 = 0; x0 < w; x0 += CH) {\n      const n = Math.min(CH, w - x0);\n      for (let k = 0; k < n; k++) buf[k] = this.vram[((sy + y) & 0x1FF) * 1024 + ((sx + x0 + k) & 0x3FF)];\n      for (let k = 0; k < n; k++) {\n        const di = ((dy + y) & 0x1FF) * 1024 + ((dx + x0 + k) & 0x3FF);\n        if (this.checkMask && (this.vram[di] & 0x8000)) continue;\n        this.vram[di] = buf[k] | (this.setMask ? 0x8000 : 0);\n      }\n    }\n    if (this.hw) this.hw.uploaded(dx, dy, w, h);\n  }\n\n  // ===================== Pixel =====================\n  /** Escreve um pixel já com offset aplicado. r,g,b: 0..255. */\n  plot(x, y, r, g, b, semi, dith) {\n    if (x < this.daX1 || x > this.daX2 || y < this.daY1 || y > this.daY2 || x < 0 || x > 1023 || y < 0 || y > 511) return;\n    this.plotNB(x, y, r, g, b, semi, dith);\n  }\n  /** plot sem checagem de limites (o chamador já recortou para a área de desenho e para a VRAM) */\n  plotNB(x, y, r, g, b, semi, dith) {\n    const idx = y * 1024 + x, back = this.vram[idx];\n    if (this.checkMask && (back & 0x8000)) return;\n    if (dith) { const d = DITHER[((y & 3) << 2) | (x & 3)]; r += d; g += d; b += d; }\n    r = clamp8(r) >> 3; g = clamp8(g) >> 3; b = clamp8(b) >> 3;\n    if (semi) {\n      const br = back & 31, bg = (back >> 5) & 31, bb = (back >> 10) & 31;\n      switch (this.semiMode) {\n        case 0: r = (br + r) >> 1; g = (bg + g) >> 1; b = (bb + b) >> 1; break;\n        case 1: r = Math.min(31, br + r); g = Math.min(31, bg + g); b = Math.min(31, bb + b); break;\n        case 2: r = Math.max(0, br - r); g = Math.max(0, bg - g); b = Math.max(0, bb - b); break;\n        default: r = Math.min(31, br + (r >> 2)); g = Math.min(31, bg + (g >> 2)); b = Math.min(31, bb + (b >> 2));\n      }\n    }\n    this.vram[idx] = r | (g << 5) | (b << 10) | (this.setMask ? 0x8000 : 0);\n  }\n\n  /** Cache de CLUT da GPU: carregado só ao desenhar com textura 4/8 bits; chave = posição; 4 bits carrega 16 entradas, 8 bits 256. */\n  clutPrep(cx, cy) {\n    if (this.texDepth > 1) return;\n    const need = this.texDepth === 0 ? 16 : 256;\n    if (this.clutValid && this.clutX === cx && this.clutY === cy && this.clutCount >= need) return;\n    for (let i = 0; i < need; i++) this.clut[i] = this.vram[cy * 1024 + ((cx * 16 + i) & 0x3FF)];\n    this.clutValid = true; this.clutX = cx; this.clutY = cy; this.clutCount = need;\n  }\n\n  /** Busca um texel (devolve a palavra de 16 bits; 0 = transparente). */\n  texel(u, v, clutX, clutY) {\n    u &= 255; v &= 255;\n    u = (u & ~(this.twMaskX << 3)) | ((this.twOffX & this.twMaskX) << 3);\n    v = (v & ~(this.twMaskY << 3)) | ((this.twOffY & this.twMaskY) << 3);\n    const base = this.texX * 64, row = ((this.texY * 256 + v) & 0x1FF) * 1024;\n    if (this.texDepth === 0) {\n      const w = this.vram[row + ((base + (u >> 2)) & 0x3FF)];\n      return this.clut[(w >> ((u & 3) * 4)) & 15];\n    }\n    if (this.texDepth === 1) {\n      const w = this.vram[row + ((base + (u >> 1)) & 0x3FF)];\n      return this.clut[(w >> ((u & 1) * 8)) & 255];\n    }\n    return this.vram[row + ((base + u) & 0x3FF)];\n  }\n\n  /** Aplica o texel + cor do vértice e plota. */\n  shadeTexel(x, y, t, r, g, b, raw, semi, gour, clutX, clutY, u, v, noClip, dith) {\n    const texel = this.texel(u, v, clutX, clutY);\n    if (texel === 0) return;\n    const tr = texel & 31, tg = (texel >> 5) & 31, tb = (texel >> 10) & 31;\n    const s = semi && (texel & 0x8000);\n    if (noClip) {\n      if (raw) this.plotNB(x, y, tr << 3, tg << 3, tb << 3, s, false);\n      else this.plotNB(x, y, (tr * r) >> 4, (tg * g) >> 4, (tb * b) >> 4, s, dith);\n    } else if (raw) this.plot(x, y, tr << 3, tg << 3, tb << 3, s, false);\n    else this.plot(x, y, (tr * r) >> 4, (tg * g) >> 4, (tb * b) >> 4, s, dith);\n  }\n\n  // ===================== Polígonos =====================\n  polygon(b, c) {\n    const quad = !!(c & 8), tex = !!(c & 4), gour = !!(c & 0x10), semi = !!(c & 2), raw = !!(c & 1);\n    const n = quad ? 4 : 3, V = []; let i = 1;\n    let clutX = 0, clutY = 0;\n    for (let k = 0; k < n; k++) {\n      const col = (gour && k > 0) ? b[i++] : b[0];\n      const pos = b[i++];\n      let u = 0, v = 0;\n      if (tex) {\n        const t = b[i++]; u = t & 255; v = (t >> 8) & 255;\n        if (k === 0) { clutX = (t >>> 16) & 63; clutY = (t >>> 22) & 511; }\n        if (k === 1) {                                   // texpage atualiza o estado do GPU\n          const tp = t >>> 16;\n          this.texX = tp & 15; this.texY = (tp >> 4) & 1; this.semiMode = (tp >> 5) & 3; this.texDepth = (tp >> 7) & 3;\n          this.texDisable = this.texDisAllow && !!((tp >> 11) & 1);\n        }\n      }\n      V.push({ x: sx11(pos & 0x7FF) + this.offX, y: sx11((pos >>> 16) & 0x7FF) + this.offY,\n               r: col & 255, g: (col >> 8) & 255, b: (col >> 16) & 255, u, v });\n    }\n    const o = { tex, gour, semi, raw, clutX, clutY };\n    if (this.skipDraw || this.remote) return;                   // quadro descartado (frameskip): mantém o estado, não desenha\n    if (this.hw) return this.hw.polygon(V, quad, o);\n    if (tex) this.clutPrep(clutX, clutY);\n    this.triangle(V[0], V[1], V[2], o);\n    if (quad) this.triangle(V[1], V[2], V[3], o);\n  }\n\n  /**\n   * Triângulo estilo hardware: arestas exatas (regra de cobertura do PS1: linhas [yTopo, yBase), colunas [ceil(xE), ceil(xD)))\n   * e atributos (cor, u, v) interpolados em ponto fixo com gradientes truncados a 12 bits fracionários, a partir do\n   * primeiro vértice do comando (medido contra o console real; aritmética de 32 bits que \"dá a volta\").\n   */\n  triangle(a, b, c, o) {\n    let A = a, B = b, C = c, t;\n    if (C.y < B.y) { t = B; B = C; C = t; }\n    if (B.y < A.y) { t = A; A = B; B = t; }\n    if (C.y < B.y) { t = B; B = C; C = t; }\n    if (C.y === A.y) return;\n    const D = (B.x - A.x) * (C.y - A.y) - (C.x - A.x) * (B.y - A.y);\n    if (D === 0) return;\n    const minX = Math.min(A.x, B.x, C.x), maxX = Math.max(A.x, B.x, C.x);\n    if (maxX - minX > 1023 || C.y - A.y > 511) return;          // limite do hardware\n    const yS = Math.max(A.y, this.daY1, 0), yE = Math.min(C.y - 1, this.daY2, 511);\n    if (yS > yE) return;\n    const xMin = Math.max(this.daX1, 0), xMax = Math.min(this.daX2, 1023);\n    const shortRight = D > 0;\n    const dxL = C.x - A.x, dyL = C.y - A.y;\n    const ceilDiv = (n, d) => Math.ceil(n / d);                  // d > 0; n/d exato o bastante (|n| < 2^31, d < 2^11)\n    // gradientes (12 bits fracionários, truncados para zero)\n    const tex = o.tex, gour = o.gour, raw = o.raw, semi = o.semi, clutX = o.clutX, clutY = o.clutY;\n    const grad = (ca, cb, cc) => {\n      const nx = (cb - ca) * (C.y - A.y) - (cc - ca) * (B.y - A.y);\n      const ny = (cc - ca) * (B.x - A.x) - (cb - ca) * (C.x - A.x);\n      return [Math.trunc(nx * 4096 / D), Math.trunc(ny * 4096 / D)];\n    };\n    let rGx = 0, rGy = 0, gGx = 0, gGy = 0, bGx = 0, bGy = 0, uGx = 0, uGy = 0, vGx = 0, vGy = 0;\n    if (gour) { [rGx, rGy] = grad(A.r, B.r, C.r); [gGx, gGy] = grad(A.g, B.g, C.g); [bGx, bGy] = grad(A.b, B.b, C.b); }\n    if (tex) { [uGx, uGy] = grad(A.u, B.u, C.u); [vGx, vGy] = grad(A.v, B.v, C.v); }\n    const P = a;                                                 // o hardware parte do 1o vértice do comando\n    const r0 = (P.r << 12) + 2048, g0 = (P.g << 12) + 2048, b0 = (P.b << 12) + 2048, u0 = (P.u << 12) + 2048, v0 = (P.v << 12) + 2048;\n    const dith = this.dither && (gour || (tex && !raw));\n    const vram = this.vram, chk = this.checkMask, setM = this.setMask ? 0x8000 : 0, smode = this.semiMode, dthrOn = !!this.dither;\n    const clut = this.clut, td = this.texDepth, tBase = this.texX * 64, tY = this.texY * 256;\n    const mx = this.twMaskX, my = this.twMaskY, uAnd = ~(mx << 3), uOr = (this.twOffX & mx) << 3, vAnd = ~(my << 3), vOr = (this.twOffY & my) << 3;\n    const ddOn = tex ? (!raw && dthrOn) : dith;\n    const span = spanFor(tex, tex ? td : 0, gour, raw && tex, semi && true, ddOn, chk, tex && (mx | my) !== 0);\n    const mk = this.rowMask;                                     // 480i: o hardware não desenha as linhas do campo exibido\n    for (let y = yS; y <= yE; y++) {\n      if (mk >= 0 && (y & 1) === mk) continue;\n      const nL = A.x * dyL + (y - A.y) * dxL;                      // aresta longa: x = nL / dyL\n      let xl, xr;\n      const lx = ceilDiv(nL, dyL);\n      let sx;\n      if (y < B.y) sx = ceilDiv(A.x * (B.y - A.y) + (y - A.y) * (B.x - A.x), B.y - A.y);\n      else sx = ceilDiv(B.x * (C.y - B.y) + (y - B.y) * (C.x - B.x), C.y - B.y);\n      if (shortRight) { xl = lx; xr = sx; } else { xl = sx; xr = lx; }\n      if (xl < xMin) xl = xMin;\n      if (xr > xMax + 1) xr = xMax + 1;\n      if (xl >= xr) continue;\n      const dy = y - P.y, dx = xl - P.x;\n      let cr = r0 + rGy * dy + rGx * dx, cg = g0 + gGy * dy + gGx * dx, cb = b0 + bGy * dy + bGx * dx;\n      let cu = u0 + uGy * dy + uGx * dx, cv = v0 + vGy * dy + vGx * dx;\n      span(vram, clut, QT, DITHER_T, y, xl, xr, cr, cg, cb, cu, cv, rGx, gGx, bGx, uGx, vGx, A.r, A.g, A.b, tBase, tY, uAnd, uOr, vAnd, vOr, smode, setM);\n    }\n  }\n\n  // ===================== Retângulos =====================\n  rect(b, c) {\n    const tex = !!(c & 4), semi = !!(c & 2), raw = !!(c & 1), sz = (c >> 3) & 3;\n    let i = 1;\n    const col = b[0], r = col & 255, g = (col >> 8) & 255, bl = (col >> 16) & 255;\n    const pos = b[i++];\n    let u0 = 0, v0 = 0, clutX = 0, clutY = 0;\n    if (tex) { const t = b[i++]; u0 = t & 255; v0 = (t >> 8) & 255; clutX = (t >>> 16) & 63; clutY = (t >>> 22) & 511; }\n    let w, h;\n    if (sz === 0) { const s = b[i++]; w = s & 0x3FF; h = (s >>> 16) & 0x1FF; }\n    else if (sz === 1) { w = 1; h = 1; } else if (sz === 2) { w = 8; h = 8; } else { w = 16; h = 16; }\n    const x0 = sx11(pos & 0x7FF) + this.offX, y0 = sx11((pos >>> 16) & 0x7FF) + this.offY;\n    if (this.skipDraw || this.remote) return;\n    if (this.hw) return this.hw.rect(x0, y0, w, h, { tex, semi, raw, r, g, b: bl, u0, v0, clutX, clutY, flipX: this.flipX, flipY: this.flipY });\n    if (tex) this.clutPrep(clutX, clutY);\n    const mk = this.rowMask;\n    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {\n      const px = x0 + x, py = y0 + y;\n      if (mk >= 0 && (py & 1) === mk) continue;\n      if (px < this.daX1 || px > this.daX2 || py < this.daY1 || py > this.daY2) continue;\n      if (tex) {\n        const u = this.flipX ? u0 + 1 - x : u0 + x, v = this.flipY ? v0 - y : v0 + y;   // flip X: o hardware começa em u0+1 (medido)\n        this.shadeTexel(px, py, true, r, g, bl, raw, semi, false, clutX, clutY, u, v, false, false);\n      } else this.plot(px, py, r, g, bl, semi, false);\n    }\n  }\n\n  // ===================== Linhas =====================\n  lineCmd(b, c) {\n    const gour = !!(c & 0x10), poly = !!(c & 8);\n    this.line = { semi: !!(c & 2), gour, pts: [], cols: [] };\n    const L = this.line;\n    L.pts.push(b[1]); L.cols.push(b[0] & 0xFFFFFF);\n    if (gour) { L.cols.push(b[2] & 0xFFFFFF); L.pts.push(b[3]); } else { L.cols.push(b[0] & 0xFFFFFF); L.pts.push(b[2]); }\n    if (!poly) { this.drawSeg(L, 0); this.line = null; return; }\n    this.drawSeg(L, 0); this.phase = PH_POLYLINE; this.polyExpectColor = gour;\n  }\n  polylineWord(w) {\n    const L = this.line;\n    if ((w & 0xF000F000) === 0x50005000) { this.phase = PH_CMD; this.line = null; return; }\n    if (L.gour && this.polyExpectColor) { this.polyColor = w & 0xFFFFFF; this.polyExpectColor = false; return; }\n    L.pts.push(w); L.cols.push(L.gour ? this.polyColor : L.cols[0]);\n    this.drawSeg(L, L.pts.length - 2);\n    if (L.gour) this.polyExpectColor = true;\n  }\n  drawSeg(L, i) {\n    const p0 = L.pts[i], p1 = L.pts[i + 1], c0 = L.cols[i], c1 = L.cols[i + 1];\n    const x0 = sx11(p0 & 0x7FF) + this.offX, y0 = sx11((p0 >>> 16) & 0x7FF) + this.offY;\n    const x1 = sx11(p1 & 0x7FF) + this.offX, y1 = sx11((p1 >>> 16) & 0x7FF) + this.offY;\n    if (this.skipDraw || this.remote) return;\n    if (this.hw) return this.hw.line(x0, y0, x1, y1, c0, c1, L.semi, L.gour);\n    // Algoritmo do hardware: passo em ponto fixo 32.32 (arredondado \"para longe do zero\"), pixel = floor(pos + 0.5 - eps)\n    let ax = x0, ay = y0, bx = x1, by = y1, ca = c0, cb = c1;\n    const adx = Math.abs(x1 - x0), ady = Math.abs(y1 - y0), k = Math.max(adx, ady);\n    if (adx >= 1024 || ady >= 512) return;\n    if (ax >= bx && k) { ax = x1; ay = y1; bx = x0; by = y0; ca = c1; cb = c0; }\n    const div = d => { if (k === 0) return 0; const n = d * 4294967296, q = n / k; return (q < 0 ? Math.floor(q) : Math.ceil(q)) / 4294967296; };\n    const sx = div(bx - ax), sy = div(by - ay);\n    const EX = LINE_EX, EY = LINE_EY;\n    let px = ax + 0.5 - EX, py = ay + 0.5 - EY;\n    const gour = L.gour, dither = this.dither;                 // linhas flat também recebem dithering (medido)\n    const r0 = ca & 255, g0 = (ca >> 8) & 255, b0 = (ca >> 16) & 255;\n    const tr = (cb & 255) - r0, tg = ((cb >> 8) & 255) - g0, tb = ((cb >> 16) & 255) - b0;\n    const kk = k || 1, mk = this.rowMask;\n    const dr = Math.trunc((tr * 4096) / kk), dg = Math.trunc((tg * 4096) / kk), db = Math.trunc((tb * 4096) / kk);\n    for (let i = 0; i <= k; i++, px += sx, py += sy) {\n      const x = Math.floor(px), y = Math.floor(py);\n      if (mk >= 0 && (y & 1) === mk) continue;\n      let r = r0, g = g0, bl = b0;\n      if (gour) { r = ((r0 << 12) + 2048 + dr * i) >> 12; g = ((g0 << 12) + 2048 + dg * i) >> 12; bl = ((b0 << 12) + 2048 + db * i) >> 12; }\n      this.plot(x, y, r, g, bl, L.semi, dither);\n    }\n  }\n\n  // ===================== Saída de vídeo =====================\n  /** paridade das linhas que NÃO podem ser desenhadas (campo exibido) em 480i com 'desenhar na área de display' proibido; -1 = sem restrição */\n  get rowMask() { return (this.interlace && this.vres && !this.drawToDisplay) ? this.field : -1; }\n\n  /** Chamado a cada fim de quadro: guarda as linhas do campo exibido (completas) para tecer com o campo anterior na saída. */\n  toggleField() { this.field ^= 1; if (this.remote) this.remote.push(6, this.field); }\n  captureField() {\n    if (this.remote) { this.remote.push(2, 0); return; }\n    if (this.hw) return this.hw.captureField(this);\n    this.captureFieldSW();\n  }\n  captureFieldSW() {\n    if (!(this.interlace && this.vres) || !this.dispOn) { this.snapKey = ''; return; }\n    const w = this.width, h = this.height, wv = this.rgb24 ? Math.ceil(w * 1.5) + 2 : w + 2;\n    const key = this.startX + ',' + this.startY + ',' + w + ',' + h + ',' + (this.rgb24 ? 1 : 0);\n    if (!this.snap) { this.snap = new Uint16Array(1024 * 512); this.mot = new Uint8Array(1024 * 512); }\n    const vr = this.vram, sn = this.snap, mot = this.mot, par = this.field; this.snapPar = par;\n    const full = key !== this.snapKey; this.snapKey = key;\n    for (let y = 0; y < h; y++) {\n      const ry = (this.startY + y) & 0x1FF;\n      if (!full && (ry & 1) !== par) continue;\n      const row = ry * 1024;\n      for (let x = 0; x < wv; x++) {\n        const i = row + ((this.startX + x) & 0x3FF), n = vr[i], o = sn[i];\n        // movimento = este pixel mudou em relação ao MESMO campo de 2 quadros atrás (o campo velho é do instante t-1: usado no desentrelaçamento adaptativo)\n        mot[i] = full || ((((n & 31) - (o & 31)) + 1) >>> 0) > 2 || (((((n >> 5) & 31) - ((o >> 5) & 31)) + 1) >>> 0) > 2 || (((((n >> 10) & 31) - ((o >> 10) & 31)) + 1) >>> 0) > 2 ? 1 : 0;\n        sn[i] = n;\n      }\n    }\n  }\n\n  get dotDiv() { return this.hres2 ? 7 : [10, 8, 5, 4][this.hres1]; }   // divisor do dot clock\n  get width() { return this.hres2 ? 368 : [256, 320, 512, 640][this.hres1]; }\n  get height() {\n    const lines = Math.max(0, this.vy2 - this.vy1);\n    const h = (lines > 0 && lines <= 288) ? lines * (this.vres ? 2 : 1) : (this.vres ? 480 : 240);\n    return Math.min(h, 576);\n  }\n\n  /** Converte a área de display da VRAM para RGBA (Uint8ClampedArray width*height*4). */\n  renderRGBA(out) {\n    const w = this.width, h = this.height;\n    out = out ?? new Uint8ClampedArray(w * h * 4);\n    if (!this.dispOn) { out.fill(0); for (let i = 3; i < out.length; i += 4) out[i] = 255; return { data: out, width: w, height: h }; }\n    const vram = (this.snap && this.snapKey && this.interlace && this.vres) ? this.snap : this.vram;   // 480i: dois últimos campos completos\n    const dmode = (vram === this.snap && !this.rgb24) ? this.deint : 0, spar = this.snapPar;\n    for (let y = 0; y < h; y++) {\n      const ry = (this.startY + y) & 0x1FF, row = ry * 1024;\n      // 480i: as linhas do campo ANTIGO podem estar \"fantasmas\" onde algo se mexeu -> adaptativo troca pela média das vizinhas do campo atual\n      const di = dmode !== 0 && (ry & 1) !== spar;\n      const rA = di && y > 0 ? ((ry - 1) & 0x1FF) * 1024 : -1, rB = di && y < h - 1 ? ((ry + 1) & 0x1FF) * 1024 : -1;\n      for (let x = 0; x < w; x++) {\n        let r, g, b;\n        if (this.rgb24) {\n          const bx = ((this.startX * 2 + x * 3) >> 0);             // posição em bytes\n          const wi = row + ((bx >> 1) & 0x3FF), lo = vram[wi], hi = vram[(wi & ~1023) + (((bx >> 1) + 1) & 0x3FF)];\n          const bytes = (bx & 1) ? [lo >> 8, hi & 255, hi >> 8] : [lo & 255, lo >> 8, hi & 255];\n          r = bytes[0]; g = bytes[1]; b = bytes[2];\n        } else {\n          const p = vram[row + ((this.startX + x) & 0x3FF)];\n          r = (p & 31) << 3; g = ((p >> 5) & 31) << 3; b = ((p >> 10) & 31) << 3;\n          r |= r >> 5; g |= g >> 5; b |= b >> 5;\n          if (di && (rA >= 0 || rB >= 0)) {\n            const xi = (this.startX + x) & 0x3FF, pa = vram[(rA >= 0 ? rA : rB) + xi], pb = vram[(rB >= 0 ? rB : rA) + xi];\n            if (dmode === 1 && !(this.mot[(rA >= 0 ? rA : rB) + xi] | this.mot[(rB >= 0 ? rB : rA) + xi])) { /* sem movimento perto: mantém a linha do campo antigo (tecer) */ } else {\n            let ar = (((pa & 31) + (pb & 31)) << 2) , ag = ((((pa >> 5) & 31) + ((pb >> 5) & 31)) << 2), ab = ((((pa >> 10) & 31) + ((pb >> 10) & 31)) << 2);\n            ar |= ar >> 5; ag |= ag >> 5; ab |= ab >> 5;\n            r = ar; g = ag; b = ab; }\n          }\n        }\n        const o = (y * w + x) * 4; out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = 255;\n      }\n    }\n    this.frameCount++;\n    return { data: out, width: w, height: h };\n  }\n}\n\nconst DEINT_THR = 40;\nfunction rgb24to15(c) { return (((c & 255) >> 3) | ((((c >> 8) & 255) >> 3) << 5) | ((((c >> 16) & 255) >> 3) << 10)); }\nfunction clamp8(v) { return v < 0 ? 0 : v > 255 ? 255 : v; }\n\n/** Fluxo de comandos para o rasterizador em worker: pares [tipo, valor] (0=GP0, 1=GP1, 2=captura do campo, 3=apresentar, 6=campo atual). */\nclass GpuStream {\n  constructor(post) { this.post = post; this.q = new Uint32Array(1 << 16); this.n = 0; this.inflight = 0; this.onRead = null; }\n  push(t, v) { if (this.n >= this.q.length) this.flush(); this.q[this.n++] = t; this.q[this.n++] = v; }\n  flush() {\n    if (!this.n) return;\n    const o = this.q.slice(0, this.n); this.n = 0;\n    this.post({ t: 'cmds', q: o }, [o.buffer]);\n  }\n}\n\nreturn { GPU, DEINT_THR, GpuStream };\n})();\nconst __src_gauss = (() => {\n// Tabela de interpolação Gaussiana da SPU do PS1 (512 entradas, Int16).\n// Dados de hardware (os mesmos de psx-spx / emuladores): g[i], i = 0..511.\n// Verificação embutida no teste: para todo i, g[0xFF-i]+g[0x1FF-i]+g[0x100+i]+g[i] está em 32639..32641.\nconst GAUSS = new Int16Array([\n  -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,\n  0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 3, 3,\n  3, 4, 4, 5, 5, 6, 7, 7, 8, 9, 9, 10, 11, 12, 13, 14,\n  15, 16, 17, 18, 19, 21, 22, 24, 25, 27, 28, 30, 32, 33, 35, 37,\n  39, 41, 44, 46, 48, 51, 53, 56, 58, 61, 64, 67, 70, 73, 77, 80,\n  84, 87, 91, 95, 99, 103, 107, 111, 116, 120, 125, 130, 135, 140, 145, 150,\n  156, 161, 167, 173, 179, 186, 192, 199, 205, 212, 219, 227, 234, 242, 250, 257,\n  266, 274, 283, 291, 300, 309, 319, 328, 338, 348, 358, 369, 379, 390, 401, 412,\n  424, 436, 448, 460, 473, 485, 498, 512, 525, 539, 553, 567, 582, 597, 612, 627,\n  643, 659, 675, 692, 708, 726, 743, 761, 779, 797, 816, 835, 854, 874, 894, 914,\n  935, 956, 977, 999, 1020, 1043, 1066, 1089, 1112, 1136, 1160, 1184, 1209, 1234, 1260, 1286,\n  1312, 1339, 1366, 1394, 1422, 1450, 1479, 1508, 1537, 1567, 1598, 1628, 1660, 1691, 1723, 1756,\n  1789, 1822, 1856, 1890, 1924, 1959, 1995, 2031, 2067, 2104, 2141, 2179, 2217, 2256, 2295, 2334,\n  2374, 2415, 2456, 2497, 2539, 2582, 2624, 2668, 2712, 2756, 2801, 2846, 2892, 2938, 2985, 3032,\n  3079, 3128, 3176, 3225, 3275, 3325, 3376, 3427, 3479, 3531, 3584, 3637, 3691, 3745, 3799, 3855,\n  3910, 3967, 4023, 4081, 4138, 4197, 4255, 4315, 4374, 4435, 4495, 4557, 4619, 4681, 4744, 4807,\n  4871, 4935, 5000, 5065, 5131, 5197, 5264, 5332, 5399, 5468, 5536, 5606, 5676, 5746, 5817, 5888,\n  5959, 6032, 6104, 6177, 6251, 6325, 6400, 6475, 6550, 6626, 6702, 6779, 6856, 6934, 7012, 7091,\n  7170, 7249, 7329, 7409, 7490, 7571, 7653, 7735, 7817, 7900, 7983, 8066, 8150, 8234, 8319, 8404,\n  8489, 8575, 8661, 8748, 8834, 8922, 9009, 9097, 9185, 9273, 9362, 9451, 9541, 9630, 9720, 9811,\n  9901, 9992, 10083, 10174, 10266, 10358, 10450, 10542, 10635, 10727, 10820, 10913, 11007, 11100, 11194, 11288,\n  11382, 11476, 11571, 11665, 11760, 11855, 11950, 12045, 12140, 12236, 12331, 12427, 12522, 12618, 12714, 12809,\n  12905, 13001, 13097, 13193, 13289, 13385, 13481, 13577, 13673, 13769, 13865, 13961, 14056, 14152, 14248, 14343,\n  14439, 14534, 14630, 14725, 14820, 14915, 15010, 15104, 15199, 15293, 15387, 15481, 15575, 15669, 15762, 15855,\n  15948, 16041, 16133, 16226, 16317, 16409, 16500, 16592, 16682, 16773, 16863, 16953, 17042, 17131, 17220, 17308,\n  17396, 17484, 17571, 17658, 17744, 17830, 17916, 18001, 18086, 18170, 18254, 18337, 18420, 18502, 18584, 18665,\n  18746, 18826, 18905, 18985, 19063, 19141, 19219, 19295, 19372, 19447, 19522, 19597, 19671, 19744, 19816, 19888,\n  19959, 20030, 20100, 20169, 20238, 20306, 20373, 20439, 20505, 20570, 20634, 20698, 20760, 20822, 20884, 20944,\n  21004, 21063, 21121, 21178, 21235, 21290, 21345, 21399, 21452, 21505, 21556, 21607, 21657, 21706, 21754, 21801,\n  21848, 21893, 21938, 21982, 22025, 22066, 22107, 22148, 22187, 22225, 22262, 22299, 22334, 22369, 22402, 22435,\n  22467, 22498, 22527, 22556, 22584, 22611, 22637, 22662, 22686, 22709, 22731, 22752, 22772, 22791, 22809, 22826,\n  22842, 22857, 22872, 22885, 22897, 22908, 22918, 22927, 22935, 22942, 22948, 22953, 22957, 22960, 22962, 22963\n]);\n\nreturn { GAUSS };\n})();\nconst __src_spu = (() => {\n// ============================================================================\n//  SPU do PS1 - 24 vozes ADPCM, ADSR, modulação de pitch, ruído, reverb\n// ============================================================================\n//  Registradores: 0x1F801C00-0x1F801FFF (16 bits)\n//    voz n (0..23): 0x1C00 + n*0x10\n//      +0 volL  +2 volR  +4 pitch(0x1000=44100Hz)  +6 start(>>3)\n//      +8 ADSR1 +A ADSR2 +C ADSR atual  +E repeat(>>3)\n//    0x1D80 mainL, 0x1D82 mainR, 0x1D84 revL, 0x1D86 revR\n//    0x1D88/8A KON, 0x1D8C/8E KOFF, 0x1D90/92 PMON, 0x1D94/96 NON, 0x1D98/9A EON\n//    0x1D9C/9E ENDX, 0x1DA2 reverb base, 0x1DA4 IRQ addr, 0x1DA6 xfer addr, 0x1DA8 FIFO,\n//    0x1DAA SPUCNT, 0x1DAC xfer ctrl, 0x1DAE SPUSTAT, 0x1DB0 CD vol, 0x1DC0.. regs de reverb\n//  Amostragem de saída: 44100 Hz estéreo. Interpolação: Gaussiana de 4 taps (tabela de 512 entradas).\n//  Volumes: modo fixo e SWEEP (linear/exponencial, crescente/decrescente, fase +/-) em cada volume de voz e no principal.\n//  Ruído: LFSR de 16 bits com timer (shift/step do SPUCNT). Reverb: motor a 22,05 kHz com FIR de 39 taps\n//  na entrada (decimação) e na saída (interpolação), escrita no buffer só com SPUCNT.7 ligado.\n// ============================================================================\nconst { GAUSS } = __src_gauss;\nconst SPU_RAM_SIZE = 512 * 1024;\nconst POS = [0, 60, 115, 98, 122], NEG = [0, 0, -52, -55, -60];\nconst sat16 = v => v > 32767 ? 32767 : v < -32768 ? -32768 : v;\nconst s16 = v => (v << 16) >> 16;\n\nconst R = { MAINL: 0x1D80, MAINR: 0x1D82, REVL: 0x1D84, REVR: 0x1D86, KONL: 0x1D88, KONH: 0x1D8A, KOFFL: 0x1D8C, KOFFH: 0x1D8E,\n  PMONL: 0x1D90, PMONH: 0x1D92, NONL: 0x1D94, NONH: 0x1D96, EONL: 0x1D98, EONH: 0x1D9A, ENDXL: 0x1D9C, ENDXH: 0x1D9E,\n  REVBASE: 0x1DA2, IRQADDR: 0x1DA4, XFERADDR: 0x1DA6, FIFO: 0x1DA8, CNT: 0x1DAA, XFERCTL: 0x1DAC, STAT: 0x1DAE, CDVOL: 0x1DB0, REVREGS: 0x1DC0 };\n\n// FIR de reamostragem do reverb (39 taps; soma = 0x7FFE ~ ganho 1,0 em >>15)\nconst REV_FIR = new Int32Array([-1, 0, 2, 0, -10, 0, 35, 0, -103, 0, 266, 0, -616, 0, 1332, 0, -2960, 0, 10246, 0x4000,\n  10246, 0, -2960, 0, 1332, 0, -616, 0, 266, 0, -103, 0, 35, 0, -10, 0, 2, 0, -1]);\nconst FIR_K = [], FIR_C = []; for (let k = 0; k < 39; k++) if (REV_FIR[k]) { FIR_K.push(k); FIR_C.push(REV_FIR[k]); }   // só os coeficientes não nulos\nconst FIR_N = FIR_K.length;\n\nconst ATTACK = 0, DECAY = 1, SUSTAIN = 2, RELEASE = 3, OFF = 4;\n\nclass Voice {\n  constructor() { this.reset(); }\n  reset() {\n    this.addr = 0; this.counter = 0; this.phase = OFF; this.level = 0; this.envCnt = 0;\n    this.samples = new Int16Array(28); this.idx = 28; this.old1 = 0; this.old2 = 0; this.prev = 0; this.cur = 0;\n    this.repeat = 0; this.loopEnd = false; this.last = 0; this.h1 = 0; this.h2 = 0; this.h3 = 0;\n  }\n}\n\nclass SPU {\n  constructor() {\n    this.ram = new Uint8Array(SPU_RAM_SIZE);\n    this.ramView = new DataView(this.ram.buffer);\n    this.regs = new Uint16Array(0x200);            // 0x1F801C00 + i*2\n    this.voices = Array.from({ length: 24 }, () => new Voice());\n    this.xferAddr = 0; this.endx = 0; this.irqFlag = false; this.onIrq = null;\n    this.revPos = 0; this.revToggle = 0; this.revOutL = 0; this.revOutR = 0;\n    this.noise = 1; this.noiseTimer = 0;\n    // volumes: 0..47 = voz n (L = 2n, R = 2n+1), 48/49 = principal L/R. level é o valor atual (com sinal).\n    this.sw = Array.from({ length: 50 }, () => ({ reg: 0, level: 0, cnt: 0 }));\n    this.revHL = new Int32Array(64); this.revHR = new Int32Array(64); this.revUL = new Int32Array(64); this.revUR = new Int32Array(64); this.revHead = 0;\n    this.cdBufL = new Int16Array(65536); this.cdBufR = new Int16Array(65536); this.cdHead = 0; this.cdTail = 0;   // áudio do CD (XA/CDDA)\n    this.sampleCount = 0;\n  }\n\n  // ---------------- acesso aos registradores ----------------\n  reg(addr) { return this.regs[(addr - 0x1C00) >> 1]; }\n  setReg(addr, v) { this.regs[(addr - 0x1C00) >> 1] = v; }\n\n  read(addr, size) {\n    addr &= 0xFFFF;                                  // 0x1F801C00 -> 0x1C00\n    if (size === 4) return (this.read16(addr) | (this.read16(addr + 2) << 16)) >>> 0;\n    if (size === 1) return (this.read16(addr & ~1) >> ((addr & 1) * 8)) & 0xFF;\n    return this.read16(addr);\n  }\n  write(addr, size, v) {\n    addr &= 0xFFFF;\n    if (size === 4) { this.write16(addr, v & 0xFFFF); this.write16(addr + 2, v >>> 16); return; }\n    if (size === 1) {                                         // byte: read-modify-write\n      const a = addr & ~1, sh = (addr & 1) * 8, cur = this.reg(a);\n      this.write16(a, (cur & ~(0xFF << sh)) | ((v & 0xFF) << sh)); return;\n    }\n    this.write16(addr, v & 0xFFFF);\n  }\n\n  read16(a) {\n    switch (a) {\n      case R.ENDXL: return this.endx & 0xFFFF;\n      case R.ENDXH: return (this.endx >>> 16) & 0xFF;\n      case R.XFERADDR: return this.xferAddr >> 3;\n      case R.STAT: return (this.reg(R.CNT) & 0x3F) | (this.irqFlag ? 0x40 : 0);\n      case 0x1DB8: case 0x1DBA: return 0;\n    }\n    if (a >= 0x1E00 && a < 0x1E64) return this.sw[(a - 0x1E00) >> 1].level & 0xFFFF;     // volume atual (voz e principal)\n    if (a < 0x1D80) {                                          // voz: ADSR atual (+0xC) = nível\n      const n = (a - 0x1C00) >> 4;\n      if ((a & 15) === 0xC) return this.voices[n].level & 0x7FFF;\n    }\n    return this.reg(a);\n  }\n\n  /** escrita num registrador de volume (voz ou principal): fixo ou sweep */\n  setVolReg(idx, v) {\n    const s = this.sw[idx]; s.reg = v; s.cnt = 0;\n    if (!(v & 0x8000)) s.level = s16((v & 0x7FFF) << 1);                // fixo: -0x8000..+0x7FFE\n  }\n  sweepTick(s) {\n    const v = s.reg; if (!(v & 0x8000)) return;\n    const exp = (v >> 14) & 1, dec = (v >> 13) & 1, shift = (v >> 2) & 31, stp = v & 3;\n    let step = dec ? -8 + stp : 7 - stp, cycles = 1 << Math.max(0, shift - 11), m = Math.abs(s.level);\n    step <<= Math.max(0, 11 - shift);\n    if (exp && !dec && m > 0x6000) cycles *= 4;\n    if (exp && dec) step = (step * m) >> 15;\n    if (++s.cnt >= cycles) { s.cnt = 0; m = m + step; m = m < 0 ? 0 : m > 0x7FFF ? 0x7FFF : m; }\n    s.level = (v & 0x1000) ? -m : m;                                     // fase negativa\n  }\n\n  write16(a, v) {\n    this.setReg(a, v);\n    if (a < 0x1D80) { const k = a & 15; if (k < 4) this.setVolReg(((a - 0x1C00) >> 4) * 2 + (k >> 1), v); }\n    else if (a === R.MAINL) this.setVolReg(48, v); else if (a === R.MAINR) this.setVolReg(49, v);\n    switch (a) {\n      case R.KONL: for (let i = 0; i < 16; i++) if (v & (1 << i)) this.keyOn(i); break;\n      case R.KONH: for (let i = 0; i < 8; i++) if (v & (1 << i)) this.keyOn(16 + i); break;\n      case R.KOFFL: for (let i = 0; i < 16; i++) if (v & (1 << i)) this.keyOff(i); break;\n      case R.KOFFH: for (let i = 0; i < 8; i++) if (v & (1 << i)) this.keyOff(16 + i); break;\n      case R.XFERADDR: this.xferAddr = (v << 3) & (SPU_RAM_SIZE - 1); break;\n      case R.FIFO: this.ramWrite16(v); break;\n      case R.CNT: if (!(v & 0x40)) this.irqFlag = false; break;         // desabilitar IRQ limpa o flag\n      case R.REVBASE: this.revPos = (v << 3) & (SPU_RAM_SIZE - 1); break;\n    }\n  }\n\n  // ---------------- RAM do SPU / transferências ----------------\n  ramWrite16(v) { this.ramView.setUint16(this.xferAddr, v & 0xFFFF, true); this.checkIrq(this.xferAddr); this.xferAddr = (this.xferAddr + 2) & (SPU_RAM_SIZE - 1); }\n  ramRead16() { const v = this.ramView.getUint16(this.xferAddr, true); this.xferAddr = (this.xferAddr + 2) & (SPU_RAM_SIZE - 1); return v; }\n  dmaWrite(words) { for (const w of words) { this.ramWrite16(w & 0xFFFF); this.ramWrite16(w >>> 16); } }     // DMA canal 4\n  dmaRead(n) { const o = new Uint32Array(n); for (let i = 0; i < n; i++) o[i] = this.ramRead16() | (this.ramRead16() << 16); return o; }\n  checkIrq(addr) {\n    if ((this.reg(R.CNT) & 0x40) && (addr >> 3) === (this.reg(R.IRQADDR) & 0xFFFF)) this.raiseIrq();\n  }\n  raiseIrq() { if (!this.irqFlag) { this.irqFlag = true; this.onIrq?.(); } }\n\n  // ---------------- voz ----------------\n  keyOn(n) {\n    const v = this.voices[n], base = 0x1C00 + n * 16;\n    v.addr = (this.reg(base + 6) << 3) & (SPU_RAM_SIZE - 1);\n    v.repeat = v.addr; v.counter = 0; v.idx = 28; v.old1 = 0; v.old2 = 0; v.prev = 0; v.cur = 0;\n    v.level = 0; v.envCnt = 0; v.h1 = v.h2 = v.h3 = 0; v.phase = ATTACK; this.endx &= ~(1 << n);\n    this.decodeBlock(v);\n    v.idx = 0; v.cur = v.samples[0];\n  }\n  keyOff(n) { const v = this.voices[n]; if (v.phase !== OFF) { v.phase = RELEASE; v.envCnt = 0; } }\n\n  /** Decodifica 1 bloco ADPCM de 16 bytes (28 amostras) */\n  decodeBlock(v) {\n    if (this.reg(R.CNT) & 0x40) {                               // IRQ se o endereço cair em qualquer ponto do bloco lido\n      const ia = (this.reg(R.IRQADDR) << 3) & (SPU_RAM_SIZE - 1);\n      if (ia >= v.addr && ia < v.addr + 16) this.raiseIrq();\n    }\n    const o = v.addr, head = this.ram[o], flags = this.ram[o + 1];\n    const shift = head & 15, filter = Math.min((head >> 4) & 7, 4);\n    if (flags & 4) v.repeat = v.addr;                          // loop start\n    let o1 = v.old1, o2 = v.old2;\n    for (let i = 0; i < 28; i++) {\n      const byte = this.ram[o + 2 + (i >> 1)];\n      let nib = (i & 1) ? byte >> 4 : byte & 15;\n      let s = s16(nib << 12) >> (shift > 12 ? 9 : shift);\n      s += (o1 * POS[filter] + o2 * NEG[filter] + 32) >> 6;\n      s = sat16(s); o2 = o1; o1 = s; v.samples[i] = s;\n    }\n    v.old1 = o1; v.old2 = o2; v.flags = flags;\n  }\n\n  /** Avança o envelope ADSR 1 amostra */\n  envelope(v, n) {\n    const base = 0x1C00 + n * 16, a1 = this.reg(base + 8), a2 = this.reg(base + 10);\n    let mode, dec, shift, step;\n    switch (v.phase) {\n      case ATTACK: mode = a1 >> 15; dec = false; shift = (a1 >> 10) & 31; step = 7 - ((a1 >> 8) & 3); break;\n      case DECAY: mode = 1; dec = true; shift = (a1 >> 4) & 15; step = -8; break;\n      case SUSTAIN: mode = a2 >> 15; dec = !!((a2 >> 14) & 1); shift = (a2 >> 8) & 31; step = dec ? -8 + ((a2 >> 6) & 3) : 7 - ((a2 >> 6) & 3); break;\n      case RELEASE: mode = (a2 >> 5) & 1; dec = true; shift = a2 & 31; step = -8; break;\n      default: return;\n    }\n    let cycles = 1 << Math.max(0, shift - 11);\n    step <<= Math.max(0, 11 - shift);\n    if (mode && !dec && v.level > 0x6000) cycles *= 4;           // ataque exponencial desacelera\n    if (mode && dec) step = (step * v.level) >> 15;               // decaimento exponencial\n    if (++v.envCnt >= cycles) {\n      v.envCnt = 0;\n      v.level = Math.max(0, Math.min(0x7FFF, v.level + step));\n    }\n    // transições de fase\n    if (v.phase === ATTACK && v.level >= 0x7FFF) { v.phase = DECAY; v.envCnt = 0; }\n    else if (v.phase === DECAY && v.level <= (((a1 & 15) + 1) << 11)) { v.phase = SUSTAIN; v.envCnt = 0; }\n    else if (v.phase === RELEASE && v.level <= 0) { v.phase = OFF; }\n  }\n\n  // ---------------- gera 1 amostra estéreo (44.1kHz) ----------------\n  tick() {\n    let mixL = 0, mixR = 0, revInL = 0, revInR = 0;\n    const cnt = this.reg(R.CNT), sw = this.sw;\n    const eon = this.reg(R.EONL) | (this.reg(R.EONH) << 16), pmon = this.reg(R.PMONL) | (this.reg(R.PMONH) << 16),\n          non = this.reg(R.NONL) | (this.reg(R.NONH) << 16);\n\n    // ruído: timer decrementa (4 + step) por amostra; no estouro recarrega (0x20000 >> shift) e avança o LFSR\n    this.noiseTimer -= 4 + ((cnt >> 8) & 3);\n    if (this.noiseTimer < 0) {\n      this.noiseTimer += 0x20000 >> ((cnt >> 10) & 15); if (this.noiseTimer < 0) this.noiseTimer = 0;\n      const nz = this.noise;\n      this.noise = ((nz << 1) | (((nz >> 15) ^ (nz >> 12) ^ (nz >> 11) ^ (nz >> 10) ^ 1) & 1)) & 0xFFFF;\n    }\n    for (let i = 0; i < 50; i++) if (sw[i].reg & 0x8000) this.sweepTick(sw[i]);    // sweeps de volume\n\n    for (let n = 0; n < 24; n++) {\n      const v = this.voices[n];\n      if (v.phase === OFF) continue;\n      const base = 0x1C00 + n * 16;\n      // amostra atual: Gauss de 4 taps sobre as 4 últimas amostras decodificadas (ou ruído)\n      let smp;\n      if (non & (1 << n)) smp = s16(this.noise);\n      else {\n        const i = (v.counter >> 4) & 0xFF;\n        smp = (GAUSS[0xFF - i] * v.h3 + GAUSS[0x1FF - i] * v.h2 + GAUSS[0x100 + i] * v.h1 + GAUSS[i] * v.cur) >> 15;\n        smp = sat16(smp);\n      }\n      this.envelope(v, n);\n      smp = (smp * v.level) >> 15;\n      v.last = smp;\n      const l = (smp * sw[n * 2].level) >> 15, r = (smp * sw[n * 2 + 1].level) >> 15;\n      mixL += l; mixR += r;\n      if (eon & (1 << n)) { revInL += l; revInR += r; }\n\n      // avanço do pitch\n      let step = this.reg(base + 4) & 0x3FFF;\n      if ((pmon & (1 << n)) && n > 0) step = (step * (this.voices[n - 1].last + 0x8000)) >> 15;\n      v.counter += Math.min(step, 0x3FFF);\n      while (v.counter >= 0x1000) {\n        v.counter -= 0x1000; v.idx++;\n        if (v.idx >= 28) {\n          const f = v.flags;\n          if (f & 1) {                                              // loop end\n            this.endx |= (1 << n);\n            if (f & 2) v.addr = v.repeat; else { v.phase = OFF; v.level = 0; break; }   // repeat ou silêncio\n          } else v.addr = (v.addr + 16) & (SPU_RAM_SIZE - 1);\n          this.decodeBlock(v); v.idx = 0;\n        }\n        v.h3 = v.h2; v.h2 = v.h1; v.h1 = v.cur; v.cur = v.samples[v.idx];\n      }\n    }\n\n    // CD audio (entra no mix principal; SPUCNT.2 também o envia ao reverb)\n    if (this.cdHead !== this.cdTail) {\n      const l = this.cdBufL[this.cdHead], r = this.cdBufR[this.cdHead]; this.cdHead = (this.cdHead + 1) & 0xFFFF;\n      if (cnt & 1) {\n        const cl = (l * this.volume(this.reg(R.CDVOL))) >> 15, cr = (r * this.volume(this.reg(R.CDVOL + 2))) >> 15;\n        mixL += cl; mixR += cr;\n        if (cnt & 4) { revInL += cl; revInR += cr; }\n      }\n    }\n\n    // reverb: entra a 44,1 kHz, o motor roda a 22,05 kHz (FIR de 39 taps para decimar/interpolar)\n    const hd = this.revHead = (this.revHead + 1) & 63;\n    this.revHL[hd] = sat16(revInL); this.revHR[hd] = sat16(revInR);\n    this.revToggle ^= 1;\n    let newL = 0, newR = 0;\n    if (this.revToggle) {\n      let aL = 0, aR = 0;\n      if (cnt & 0x80) for (let q = 0; q < FIR_N; q++) { const c = FIR_C[q], j = (hd - FIR_K[q]) & 63; aL += c * this.revHL[j]; aR += c * this.revHR[j]; }\n      if (cnt & 0x80) this.reverbStep(sat16(aL >> 15), sat16(aR >> 15)); else { this.revOutL = this.revOutR = 0; this.revAdvance(); }\n      newL = this.revOutL; newR = this.revOutR;\n    }\n    this.revUL[hd] = newL; this.revUR[hd] = newR;                    // saída do reverb: zero-stuffing + FIR (ganho 2)\n    if (cnt & 0x80) {\n      let uL = 0, uR = 0;\n      for (let q = 0; q < FIR_N; q++) { const c = FIR_C[q], j = (hd - FIR_K[q]) & 63; uL += c * this.revUL[j]; uR += c * this.revUR[j]; }\n      mixL += sat16(uL >> 14); mixR += sat16(uR >> 14);\n    }\n\n    if (!(cnt & 0x8000)) return [0, 0];                              // SPU desabilitado (mudo)\n    const mL = (mixL * sw[48].level) >> 15, mR = (mixR * sw[49].level) >> 15;\n    this.sampleCount++;\n    return [sat16(cnt & 0x4000 ? mL : 0), sat16(cnt & 0x4000 ? mR : 0)];   // bit 14: 0 = mudo\n  }\n\n  volume(v) {                                                        // modo fixo (bit15=0). Sweep: TODO\n    return s16((v & 0x7FFF) << 1) ;\n  }\n\n  // ---------------- reverb ----------------\n  // Endereço do reverb = base + ((posição_atual - base + reg*8 + extra) mod tamanho). Roda a 22.05kHz.\n  reverbStep(inL, inR) {\n    const rg = i => this.reg(R.REVREGS + i * 2), g = i => s16(rg(i));\n    const base = (this.reg(R.REVBASE) << 3) & (SPU_RAM_SIZE - 1), size = SPU_RAM_SIZE - base;\n    if (size <= 0) return;\n    const ad = (reg, extra = 0) => base + ((((this.revPos - base) + (reg << 3) + extra) % size) + size) % size & ~1;\n    const wrEn = !!(this.reg(R.CNT) & 0x80);\n    const rd = (reg, extra = 0) => { const a = ad(reg, extra); this.checkIrq(a); return this.ramView.getInt16(a, true); };\n    const wr = (reg, v) => { const a = ad(reg); this.checkIrq(a); if (wrEn) this.ramView.setInt16(a, sat16(v), true); };\n    const dAPF1 = rg(0), dAPF2 = rg(1), vIIR = g(2), vCOMB1 = g(3), vCOMB2 = g(4), vCOMB3 = g(5), vCOMB4 = g(6), vWALL = g(7), vAPF1 = g(8), vAPF2 = g(9);\n    const mLSAME = rg(10), mRSAME = rg(11), mLCOMB1 = rg(12), mRCOMB1 = rg(13), mLCOMB2 = rg(14), mRCOMB2 = rg(15), dLSAME = rg(16), dRSAME = rg(17),\n          mLDIFF = rg(18), mRDIFF = rg(19), mLCOMB3 = rg(20), mRCOMB3 = rg(21), mLCOMB4 = rg(22), mRCOMB4 = rg(23), dLDIFF = rg(24), dRDIFF = rg(25),\n          mLAPF1 = rg(26), mRAPF1 = rg(27), mLAPF2 = rg(28), mRAPF2 = rg(29), vLIN = g(30), vRIN = g(31);\n    const Lin = (sat16(inL) * vLIN) >> 15, Rin = (sat16(inR) * vRIN) >> 15;\n    const iir = (x, prev, d) => ((((x + ((d * vWALL) >> 15) - prev) * vIIR) >> 15) + prev);\n    // reflexão (mesmo lado e lado oposto) - \"prev\" é a amostra 2 bytes antes\n    wr(mLSAME, iir(Lin, rd(mLSAME, -2), rd(dLSAME)));\n    wr(mRSAME, iir(Rin, rd(mRSAME, -2), rd(dRSAME)));\n    wr(mLDIFF, iir(Lin, rd(mLDIFF, -2), rd(dRDIFF)));\n    wr(mRDIFF, iir(Rin, rd(mRDIFF, -2), rd(dLDIFF)));\n    // eco inicial (4 combs)\n    let L = (rd(mLCOMB1) * vCOMB1 + rd(mLCOMB2) * vCOMB2 + rd(mLCOMB3) * vCOMB3 + rd(mLCOMB4) * vCOMB4) >> 15;\n    let Rr = (rd(mRCOMB1) * vCOMB1 + rd(mRCOMB2) * vCOMB2 + rd(mRCOMB3) * vCOMB3 + rd(mRCOMB4) * vCOMB4) >> 15;\n    // all-pass 1 e 2\n    const apf = (x, m, d, v) => { const t = rd(m - d); const y = x - ((t * v) >> 15); wr(m, y); return ((y * v) >> 15) + t; };\n    L = apf(L, mLAPF1, dAPF1, vAPF1); Rr = apf(Rr, mRAPF1, dAPF1, vAPF1);\n    L = apf(L, mLAPF2, dAPF2, vAPF2); Rr = apf(Rr, mRAPF2, dAPF2, vAPF2);\n    this.revOutL = (sat16(L) * s16(this.reg(R.REVL))) >> 15;\n    this.revOutR = (sat16(Rr) * s16(this.reg(R.REVR))) >> 15;\n    this.revAdvance(base);\n  }\n  revAdvance(base = (this.reg(R.REVBASE) << 3) & (SPU_RAM_SIZE - 1)) { this.revPos += 2; if (this.revPos >= SPU_RAM_SIZE) this.revPos = base; }\n\n  /** Gera `frames` amostras estéreo intercaladas (Int16Array L,R,L,R...) */\n  render(frames, out) {\n    out = out ?? new Int16Array(frames * 2);\n    for (let i = 0; i < frames; i++) { const [l, r] = this.tick(); out[2 * i] = l; out[2 * i + 1] = r; }\n    return out;\n  }\n\n  /** Entrada de áudio do CD (amostras estéreo já em 44.1kHz) */\n  pushCd(l, r) {\n    const n = (this.cdTail + 1) & 0xFFFF; if (n === this.cdHead) return;      // cheio\n    this.cdBufL[this.cdTail] = sat16(l | 0); this.cdBufR[this.cdTail] = sat16(r | 0); this.cdTail = n;\n  }\n}\n\nreturn { SPU_RAM_SIZE, REV_FIR, SPU };\n})();\nconst __src_disc = (() => {\n// ============================================================================\n//  Imagem de disco (.bin crua 2352 bytes/setor, ou .iso 2048) + ISO9660 + PS-X EXE\n// ============================================================================\n//  Layout de um setor CD-ROM XA \"MODE 2\" (2352 bytes):\n//    0x000  12  sync (00 FF*10 00)\n//    0x00C   4  header: MM SS FF (BCD) + modo (2)\n//    0x010   8  subheader: file, channel, submode, coding (x2)\n//    0x018 2048 dados (Form 1)   [Form 2 = 2324 bytes, usado em XA-ADPCM/vídeo]\n//    ...        EDC/ECC\n//  LBA 0 == tempo absoluto 00:02:00 (pregap de 150 setores).\n// ============================================================================\n\nconst SECTOR_RAW = 2352;\nconst SECTOR_USER = 2048;\nconst SYNC = [0x00, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0x00];\n\nconst bcd = v => ((v / 10 | 0) << 4) | (v % 10);\nconst unbcd = v => (v >> 4) * 10 + (v & 15);\nconst u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;\n\nconst lbaToMsf = lba => { lba += 150; return { m: bcd(lba / 4500 | 0), s: bcd((lba / 75 | 0) % 60), f: bcd(lba % 75) }; };\nconst msfToLba = (m, s, f) => (unbcd(m) * 60 + unbcd(s)) * 75 + unbcd(f) - 150;\n\nclass PsxExe {\n  constructor(bytes) {\n    const magic = String.fromCharCode(...bytes.subarray(0, 8));\n    if (magic !== 'PS-X EXE') throw new Error('Não é um PS-X EXE');\n    this.pc = u32(bytes, 0x10);\n    this.gp = u32(bytes, 0x14);\n    this.textAddr = u32(bytes, 0x18);\n    this.textSize = u32(bytes, 0x1C);\n    this.sp = u32(bytes, 0x30) ? (u32(bytes, 0x30) + u32(bytes, 0x34)) >>> 0 : 0;\n    this.region = String.fromCharCode(...bytes.subarray(0x4C, 0x80)).split('\\0')[0];\n    this.data = bytes.slice(0x800, 0x800 + this.textSize);\n  }\n}\n\nconst cueTime = t => { const m = /^(\\d+):(\\d+):(\\d+)$/.exec(t); if (!m) throw new Error('Tempo inválido no CUE: ' + t); return (+m[1] * 60 + +m[2]) * 75 + +m[3]; };\n\n/**\n * Fonte de bytes PREGUIÇOSA sobre um Blob/File: lê do arquivo só o que o emulador pede (blocos de 256 KB em cache LRU), em vez de\n * carregar o disco inteiro na memória (um .bin de 700 MB estourava a memória da aba no celular). Só funciona dentro de um Web Worker\n * (usa FileReaderSync). Mesma interface que o DiscImage usa de um Uint8Array: `length` e `subarray(a, b)`.\n */\nclass BlobSource {\n  constructor(blob, reader = null, chunk = 262144, keep = 12) {\n    this.blob = blob; this.length = blob.size; this.CH = chunk; this.keep = keep; this.lru = new Map();\n    const frs = reader ? null : new FileReaderSync();\n    this.read = reader || ((a, b) => new Uint8Array(frs.readAsArrayBuffer(blob.slice(a, b))));\n  }\n  chunk(i) {\n    let c = this.lru.get(i);\n    if (c) { this.lru.delete(i); this.lru.set(i, c); return c; }\n    c = this.read(i * this.CH, Math.min(this.length, (i + 1) * this.CH));\n    this.lru.set(i, c); if (this.lru.size > this.keep) this.lru.delete(this.lru.keys().next().value);\n    return c;\n  }\n  subarray(a, b = this.length) {\n    a = Math.max(0, a); b = Math.min(this.length, b); if (b <= a) return new Uint8Array(0);\n    const ca = Math.floor(a / this.CH), cb = Math.floor((b - 1) / this.CH);\n    if (ca === cb) return this.chunk(ca).subarray(a - ca * this.CH, b - ca * this.CH);\n    const out = new Uint8Array(b - a);                                       // setor que cruza dois blocos: monta uma cópia\n    for (let i = ca; i <= cb; i++) { const base = i * this.CH, c = this.chunk(i), lo = Math.max(a, base), hi = Math.min(b, base + c.length); out.set(c.subarray(lo - base, hi - base), lo - a); }\n    return out;\n  }\n}\n\nclass DiscImage {\n  /**\n   * `bytes` = imagem de UMA trilha de dados (.bin 2352 cru ou .iso 2048).\n   * `layout` (usado por fromCue) = { files:[{bytes,sectorSize,lba0,count}], tracks:[{n,type,start}] }.\n   */\n  constructor(bytes, layout = null) {\n    if (layout) { this.files = layout.files; this.tracks = layout.tracks; }\n    else {\n      const head = bytes.subarray(0, 12), raw = bytes.length % SECTOR_RAW === 0 && SYNC.every((v, i) => head[i] === v), ss = raw ? SECTOR_RAW : SECTOR_USER;\n      this.files = [{ bytes, sectorSize: ss, lba0: 0, count: Math.floor(bytes.length / ss) }];\n      this.tracks = [{ n: 1, type: 'data', start: 0 }];\n    }\n    const f0 = this.files[0], last = this.files[this.files.length - 1];\n    this.bytes = f0.bytes;\n    this.sectorSize = f0.sectorSize;\n    this.raw = f0.sectorSize === SECTOR_RAW;\n    this.sectorCount = last.lba0 + last.count;\n    this.tracks.forEach((t, i) => { const nx = this.tracks[i + 1]; t.end = nx ? (nx.pre ?? nx.start) : this.sectorCount; });\n    this.silence = new Uint8Array(SECTOR_RAW);                            // PREGAP virtual (sem dados no arquivo)\n    this.userOffset = this.raw ? (f0.bytes.subarray(15, 16)[0] === 2 ? 24 : 16) : 0;      // MODE2 -> 24, MODE1 -> 16\n    this.pvd = this.readUser(16);\n    if (!this.pvd || String.fromCharCode(...this.pvd.subarray(1, 6)) !== 'CD001') throw new Error('Volume ISO9660 não encontrado no LBA 16');\n    this.volumeId = text(this.pvd, 40, 32);\n    this.systemId = text(this.pvd, 8, 32);\n    this.rootLba = u32(this.pvd, 158);\n    this.rootLen = u32(this.pvd, 166);\n    this.cache = new Map();\n  }\n\n  /**\n   * Monta um disco a partir de um .cue. `files` = { 'nome.bin': Uint8Array, ... } (ou Map).\n   * Suporta várias trilhas por arquivo ou um arquivo por trilha, MODE1/2048, MODE1/2352,\n   * MODE2/2352 e AUDIO (PCM 16-bit estéreo 44.1 kHz), INDEX 00/01 e PREGAP.\n   */\n  static fromCue(cueText, files) {\n    const map = files instanceof Map ? files : new Map(Object.entries(files));\n    const find = name => {\n      if (map.has(name)) return map.get(name);\n      const base = name.split(/[\\\\/]/).pop().toLowerCase();\n      for (const [k, v] of map) if (k.split(/[\\\\/]/).pop().toLowerCase() === base) return v;\n      throw new Error('Arquivo do CUE não fornecido: ' + name);\n    };\n    const fl = [], tracks = []; let cur = null, curTrack = null, running = 0;\n    const closeFile = () => { if (cur) { cur.count = Math.floor(cur.bytes.length / cur.sectorSize); running = cur.lba0 + cur.count; } };\n    for (const raw of cueText.split(/\\r?\\n/)) {\n      const line = raw.trim(); let m;\n      if ((m = /^FILE\\s+(?:\"([^\"]+)\"|(\\S+))\\s+(\\S+)/i.exec(line))) {\n        closeFile();\n        cur = { bytes: find(m[1] ?? m[2]), sectorSize: 0, lba0: running, count: 0, first: true };\n        fl.push(cur);\n      } else if ((m = /^TRACK\\s+(\\d+)\\s+(\\S+)/i.exec(line))) {\n        if (!cur) throw new Error('TRACK antes de FILE no CUE');\n        const mode = m[2].toUpperCase(), audio = mode === 'AUDIO';\n        const ss = mode === 'MODE1/2048' ? SECTOR_USER : mode === 'MODE2/2336' ? 2336 : SECTOR_RAW;\n        if (!cur.sectorSize) cur.sectorSize = ss;\n        curTrack = { n: +m[1], type: audio ? 'audio' : 'data', start: 0, file: cur, firstInFile: cur.first };\n        cur.first = false; tracks.push(curTrack);\n      } else if ((m = /^PREGAP\\s+(\\S+)/i.exec(line)) && curTrack) {\n        if (curTrack.firstInFile) { const g = cueTime(m[1]); cur.lba0 += g; }          // silêncio antes do arquivo\n      } else if ((m = /^INDEX\\s+(\\d+)\\s+(\\S+)/i.exec(line)) && curTrack) {\n        if (+m[1] === 1) curTrack.start = cur.lba0 + cueTime(m[2]);\n        else if (+m[1] === 0) curTrack.pre = cur.lba0 + cueTime(m[2]);                  // início do pregap (INDEX 00)\n      }\n    }\n    closeFile();\n    if (!tracks.length) throw new Error('CUE sem trilhas');\n    tracks.forEach(t => delete t.file);\n    tracks[0].start = 0;                                                                // LBA 0 = início da trilha 1\n    return new DiscImage(null, { files: fl.map(({ bytes, sectorSize, lba0, count }) => ({ bytes, sectorSize, lba0, count })), tracks: tracks.map(({ n, type, start, pre }) => (pre !== undefined && pre < start ? { n, type, start, pre } : { n, type, start })) });\n  }\n\n  trackAt(lba) {\n    for (let i = this.tracks.length - 1; i >= 0; i--) if (lba >= (this.tracks[i].pre ?? this.tracks[i].start)) return this.tracks[i];\n    return this.tracks[0];\n  }\n\n  /** Setor inteiro (2352 bytes se raw; 2048 se .iso) */\n  readSector(lba) {\n    if (lba < 0 || lba >= this.sectorCount) return null;\n    for (const f of this.files) {\n      if (lba >= f.lba0 && lba < f.lba0 + f.count) return f.bytes.subarray((lba - f.lba0) * f.sectorSize, (lba - f.lba0 + 1) * f.sectorSize);\n    }\n    return this.silence;\n  }\n  /** 2048 bytes de dados (Form 1) */\n  readUser(lba) {\n    const s = this.readSector(lba);\n    return s && s.subarray(this.userOffset, this.userOffset + SECTOR_USER);\n  }\n  /** Cabeçalho/subheader XA: o controlador de CD-ROM usa isso (filtros XA, tipo de setor) */\n  sectorInfo(lba) {\n    const s = this.readSector(lba);\n    if (!s || !this.raw || s.length !== SECTOR_RAW || this.trackAt(lba).type === 'audio') return null;\n    const sm = s[18];\n    return { mode: s[15], file: s[16], channel: s[17], submode: sm, coding: s[19],\n             form2: !!(sm & 0x20), audio: !!(sm & 0x04), video: !!(sm & 0x02), data: !!(sm & 0x08), rt: !!(sm & 0x40), eof: !!(sm & 0x80) };\n  }\n\n  // ---------------- ISO9660 ----------------\n  readDir(lba, len) {\n    const out = [];\n    for (let blk = 0; blk < Math.ceil(len / 2048); blk++) {\n      const d = this.readUser(lba + blk); let o = 0;\n      while (o < 2048 && d[o]) {\n        const l = d[o], nl = d[o + 32];\n        const name = text(d, o + 33, nl);\n        if (name !== '\\0' && name !== '\\x01')\n          out.push({ name, lba: u32(d, o + 2), size: u32(d, o + 10), dir: !!(d[o + 25] & 2) });\n        o += l;\n      }\n    }\n    return out;\n  }\n  listRoot() { return this.cache.get('root') ?? (this.cache.set('root', this.readDir(this.rootLba, this.rootLen)), this.cache.get('root')); }\n\n  /** Procura \"DIR\\ARQ.EXT\" ignorando o \";1\" e maiúsc./minúsc. */\n  findFile(path) {\n    const parts = path.replace(/^cdrom:/i, '').split(/[\\\\/]/).filter(Boolean);\n    let list = this.listRoot(), ent = null;\n    for (const p of parts) {\n      const want = p.toUpperCase().replace(/;\\d+$/, '');\n      ent = list.find(e => e.name.toUpperCase().replace(/;\\d+$/, '') === want);\n      if (!ent) return null;\n      if (ent.dir) list = this.readDir(ent.lba, ent.size);\n    }\n    return ent;\n  }\n  readFile(path) {\n    const e = this.findFile(path); if (!e) return null;\n    const out = new Uint8Array(e.size);\n    for (let i = 0; i * 2048 < e.size; i++) out.set(this.readUser(e.lba + i).subarray(0, Math.min(2048, e.size - i * 2048)), i * 2048);\n    return out;\n  }\n\n  systemCnf() {\n    const f = this.readFile('SYSTEM.CNF'); if (!f) return null;\n    const cnf = {};\n    for (const line of String.fromCharCode(...f).split(/\\r?\\n/)) {\n      const m = line.match(/^\\s*(\\w+)\\s*=\\s*(.*?)\\s*$/); if (m) cnf[m[1].toUpperCase()] = m[2];\n    }\n    return cnf;\n  }\n\n  /** Região lida da área de licença (setores 4..): SCEI (JP), SCEA (US), SCEE (EU) */\n  region() {\n    let t = '';\n    for (let i = 0; i < 12; i++) t += String.fromCharCode(...this.readUser(i));\n    const c = t.replace(/[^A-Za-z]/g, '');\n    if (/Entertainment(Euro)*pe/.test(c) || /Europe/.test(c)) return 'SCEE';\n    if (/America|Amer/.test(c)) return 'SCEA';\n    if (/LicensedbySonyComputerEntertainmentInc/.test(c)) return 'SCEI';\n    return 'desconhecida';\n  }\n\n  /** Executável de boot (BOOT= do SYSTEM.CNF; fallback PSX.EXE) */\n  loadBootExe() {\n    const cnf = this.systemCnf();\n    const path = cnf?.BOOT?.replace(/^cdrom:\\\\?/i, '') ?? 'PSX.EXE';\n    const bytes = this.readFile(path);\n    if (!bytes) throw new Error('Executável de boot não encontrado: ' + path);\n    const exe = new PsxExe(bytes);\n    exe.path = path; exe.cnf = cnf ?? {};\n    exe.stack = cnf?.STACK ? parseInt(cnf.STACK, 16) >>> 0 : 0x801FFF00;\n    return exe;\n  }\n\n  info() {\n    const cnf = this.systemCnf();\n    const secs = this.sectorCount, sec = secs / 75 | 0;\n    return { formato: this.raw ? 'BIN cru 2352 (MODE2/XA)' : 'ISO 2048', setores: secs, trilhas: this.tracks.length, audio: this.tracks.filter(t => t.type === 'audio').length,\n             duracao: `${sec / 60 | 0}:${String(sec % 60).padStart(2, '0')}`, volume: this.volumeId.trim(),\n             regiao: this.region(), boot: cnf?.BOOT, stack: cnf?.STACK };\n  }\n}\n\nconst text = (b, o, n) => String.fromCharCode(...b.subarray(o, o + n));\n\nreturn { SECTOR_RAW, SECTOR_USER, lbaToMsf, msfToLba, PsxExe, BlobSource, DiscImage };\n})();\nconst __src_scheduler = (() => {\n// Agendador de eventos em ciclos de CPU (usado por CD-ROM, SIO0, DMA...)\n// Dois tipos de evento:\n//   add(time, fn)                      closure (não entra em save states; só para testes/uso interno)\n//   call(time, obj, método, args)      descritor serializável: chama reg[obj][método](...args)\nclass Scheduler {\n  constructor() { this.q = []; this.reg = {}; this.onEarly = null; }\n  /** registra os objetos que podem receber eventos descritores (cdrom, dma, sio...) */\n  register(name, obj) { this.reg[name] = obj; }\n  _ins(e) { if (this.onEarly) this.onEarly(e.time); let i = this.q.length; while (i > 0 && this.q[i - 1].time > e.time) i--; this.q.splice(i, 0, e); return e; }\n  /** agenda fn para o instante absoluto `time` (em ciclos) */\n  add(time, fn) { return this._ins({ time, fn }); }\n  call(time, o, m, a = []) { return this._ins({ time, o, m, a }); }\n  cancel(e) { const i = this.q.indexOf(e); if (i >= 0) this.q.splice(i, 1); }\n  run(now) {\n    while (this.q.length && this.q[0].time <= now) {\n      const e = this.q.shift();\n      if (e.fn) e.fn(); else this.reg[e.o][e.m](...e.a);\n    }\n  }\n  clear() { this.q.length = 0; }\n  get next() { return this.q.length ? this.q[0].time : Infinity; }\n  /** lista serializável (falha se houver closures) */\n  snapshot() {\n    return this.q.map(e => { if (e.fn) throw new Error('evento com closure não pode entrar no save state'); return { time: e.time, o: e.o, m: e.m, a: e.a }; });\n  }\n  restore(list) { this.q = list.map(e => ({ time: e.time, o: e.o, m: e.m, a: e.a })); }\n  find(o, m) { return this.q.find(e => e.o === o && e.m === m) || null; }\n}\n\nreturn { Scheduler };\n})();\nconst __src_timers = (() => {\n// ============================================================================\n//  Root counters (timers) 0x1F801100-0x1F80112F\n//   +0 contador  +4 modo  +8 alvo\n//   modo: b0 sync, b1-2 sync mode, b3 reset no alvo, b4 IRQ no alvo, b5 IRQ em 0xFFFF,\n//         b6 IRQ repetido, b7 toggle, b8-9 clock, b10 IRQ flag (1=sem IRQ), b11 atingiu alvo, b12 atingiu FFFF\n//   Timer0: sysclk | dotclock    Timer1: sysclk | hblank    Timer2: sysclk | sysclk/8\n//  Modos de sincronização (mode bit0=1; bits 1-2):\n//    Timer0 (hblank) / Timer1 (vblank):  0 = pausa durante o blank   1 = zera o contador ao entrar no blank\n//        2 = zera ao entrar no blank e só conta DENTRO dele          3 = pausa até o 1º blank, depois roda livre\n//    Timer2: 0 e 3 = parado   1 e 2 = livre.\n//  O PSX informa o estado (hblank, vblank) por tick() via setBlank(); as bordas aplicam reset/liberação.\n// ============================================================================\nclass Timers {\n  constructor(sys) {\n    this.sys = sys; this.dotDiv = 10; this.hb = false; this.vb = false;\n    this.t = [0, 1, 2].map(() => ({ counter: 0, mode: 0x400, target: 0, irqDone: false, frac: 0, free: false }));\n  }\n  reset() { for (const t of this.t) { t.counter = 0; t.mode = 0x400; t.target = 0; t.irqDone = false; t.frac = 0; t.free = false; } this.hb = false; this.vb = false; }\n\n  read(addr, size) {\n    const n = (addr >> 4) & 3, r = addr & 0xC; if (n > 2) return 0;\n    this.sys.syncTimers?.(); const t = this.t[n]; let v = 0;\n    if (r === 0) v = t.counter; else if (r === 4) { v = t.mode; t.mode &= ~0x1800; } else if (r === 8) v = t.target;\n    if (addr & 2) return 0;\n    return size === 1 ? v & 0xFF : v >>> 0;\n  }\n  write(addr, size, v) {\n    const n = (addr >> 4) & 3, r = addr & 0xC; if (n > 2 || (addr & 2)) return;\n    this.sys.syncTimers?.(); const t = this.t[n];\n    if (r === 0) t.counter = v & 0xFFFF;\n    else if (r === 4) { t.mode = (v & 0x3FF) | 0x400; t.counter = 0; t.irqDone = false; t.frac = 0; t.free = false; }\n    else if (r === 8) t.target = v & 0xFFFF;\n    this.sys.retime?.();\n  }\n\n  /** estado do blank horizontal/vertical no início do tick; as bordas aplicam os modos de sync */\n  setBlank(hb, vb) {\n    if (hb !== this.hb) { this.hb = hb; this.edge(0, hb); }\n    if (vb !== this.vb) { this.vb = vb; this.edge(1, vb); }\n  }\n  edge(n, on) {\n    const t = this.t[n]; if (!(t.mode & 1) || !on) return;\n    const sm = (t.mode >> 1) & 3;\n    if (sm === 1 || sm === 2) t.counter = 0; else if (sm === 3) t.free = true;\n  }\n  /** o contador n pode contar agora? (timers 0/1 conforme o blank; timer 2 conforme o modo) */\n  gate(n) {\n    const t = this.t[n]; if (!(t.mode & 1)) return true;\n    const sm = (t.mode >> 1) & 3;\n    if (n === 2) return sm === 1 || sm === 2;\n    const blank = n === 0 ? this.hb : this.vb;\n    return sm === 0 ? !blank : sm === 1 ? true : sm === 2 ? blank : t.free;\n  }\n\n  /** avança `dt` ciclos de CPU */\n  advance(dt) {\n    for (let n = 0; n < 3; n++) {\n      const t = this.t[n], src = (t.mode >> 8) & 3; let ticks = 0;\n      if (n === 0) { if (src & 1) { t.frac += dt * 11 / (7 * this.dotDiv); ticks = t.frac | 0; t.frac -= ticks; } else ticks = dt; }\n      else if (n === 1) { if (src & 1) continue; ticks = dt; }                 // hblank: via hblank()\n      else if (src & 2) { t.frac += dt / 8; ticks = t.frac | 0; t.frac -= ticks; } else ticks = dt;\n      if (ticks && this.gate(n)) this.add(n, t, ticks);\n    }\n  }\n  /** ciclos de CPU (>= 1) até o próximo evento de IRQ de algum contador (alvo/0xFFFF); Infinity se nada pode disparar. Usado para limitar o tick adaptativo. */\n  nextEvent() {\n    let best = Infinity;\n    for (let n = 0; n < 3; n++) {\n      const t = this.t[n], m = t.mode; if (!(m & 0x30)) continue;                        // sem IRQ no alvo nem em 0xFFFF\n      const src = (m >> 8) & 3; let rate;\n      if (n === 0) rate = (src & 1) ? 11 / (7 * this.dotDiv) : 1; else if (n === 1) { if (src & 1) continue; rate = 1; } else rate = (src & 2) ? 1 / 8 : 1;\n      if (!this.gate(n)) continue;\n      const v = t.counter; let need = 0x10000 - v;                                       // 0xFFFF -> 0 (IRQ do estouro)\n      if (!(m & 0x20)) need = Infinity;\n      if (m & 0x10) { const a = v < t.target ? t.target - v : (0x10000 - v) + t.target; if (a < need) need = a; }\n      const cyc = Math.floor((need - t.frac) / rate);\n      if (cyc < best) best = cyc;\n    }\n    return best < 1 ? 1 : best;\n  }\n  hblank() { const t = this.t[1]; if (((t.mode >> 8) & 1) && this.gate(1)) this.add(1, t, 1); }\n\n  add(n, t, count) {\n    const reset = !!(t.mode & 8); let v = t.counter, left = count;\n    while (left > 0) {\n      const limit = (reset && v <= t.target) ? t.target : 0xFFFF, room = limit - v;\n      if (left <= room) { this.hit(n, t, v, v + left); v += left; left = 0; }\n      else {\n        this.hit(n, t, v, limit); left -= room + 1; v = 0;\n        if (limit === 0xFFFF) { t.mode |= 0x1000; if (t.mode & 0x20) this.irq(n, t); }\n      }\n    }\n    t.counter = v;\n  }\n  hit(n, t, a, b) { if (a < t.target && t.target <= b) { t.mode |= 0x800; if (t.mode & 0x10) this.irq(n, t); } }\n  irq(n, t) {\n    if (!(t.mode & 0x40) && t.irqDone) return;\n    t.irqDone = true;\n    if (t.mode & 0x80) { t.mode ^= 0x400; if (!(t.mode & 0x400)) this.sys.irq(4 + n); }   // toggle\n    else this.sys.irq(4 + n);                                                           // pulso\n  }\n}\n\nreturn { Timers };\n})();\nconst __src_dma = (() => {\n// ============================================================================\n//  Controlador de DMA  0x1F801080-0x1F8010F7\n//   canal n: +0 MADR, +4 BCR, +8 CHCR    0xF0 DPCR    0xF4 DICR\n//   0 MDEC-in 1 MDEC-out 2 GPU 3 CD-ROM 4 SPU 5 PIO 6 OTC\n//  A transferência é feita na hora; só a conclusão/IRQ é agendada (1 ciclo/palavra).\n// ============================================================================\nclass DMA {\n  constructor(sys) {\n    this.sys = sys; this.dev = {};                    // gpu, spu, cdrom, mdec (preenchido pelo PSX)\n    this.madr = new Uint32Array(7); this.bcr = new Uint32Array(7); this.chcr = new Uint32Array(7);\n    this.reset();\n  }\n  reset() { this.madr.fill(0); this.bcr.fill(0); this.chcr.fill(0); this.dpcr = 0x07654321; this.dicr = 0; this.prevIrq = false; this.deferred = null; }\n\n  read(addr, size) {\n    const sh = (addr & 3) * 8, a = addr & ~3; let v = 0;\n    if (a === 0x1F8010F0) v = this.dpcr; else if (a === 0x1F8010F4) v = this.dicr;\n    else {\n      const ch = (a - 0x1F801080) >> 4;\n      if (ch >= 0 && ch < 7) { const r = a & 0xC; v = r === 0 ? this.madr[ch] : r === 4 ? this.bcr[ch] : r === 8 ? this.chcr[ch] : 0; }\n    }\n    return size === 4 ? v >>> 0 : ((v >>> sh) & (size === 2 ? 0xFFFF : 0xFF)) >>> 0;\n  }\n\n  write(addr, size, v) {\n    if (size !== 4) {                                   // sub-palavra: read-modify-write\n      const a = addr & ~3, sh = (addr & 3) * 8, m = (size === 2 ? 0xFFFF : 0xFF) << sh;\n      // no DICR os bits 24-30 são \"escreva 1 para limpar\": os bytes NÃO escritos devem valer 0 nas flags\n      // (senão a flag atual seria remendada no valor e apagada por engano)\n      const cur = a === 0x1F8010F4 ? (this.read(a, 4) & 0x80FFFFFF) : this.read(a, 4);\n      v = ((cur & ~m) | ((v << sh) & m)) >>> 0; addr = a;\n    }\n    if (addr === 0x1F8010F0) { this.dpcr = v >>> 0; return; }\n    if (addr === 0x1F8010F4) {\n      const keep = this.dicr & 0x7F000000 & ~(v & 0x7F000000);\n      this.dicr = ((v & 0x00FF803F) | keep) >>> 0; this.updateIrq(); return;\n    }\n    const ch = (addr - 0x1F801080) >> 4; if (ch < 0 || ch > 6) return;\n    const r = addr & 0xC;\n    if (r === 0) this.madr[ch] = v & 0xFFFFFF;\n    else if (r === 4) this.bcr[ch] = v;\n    else if (r === 8) {\n      this.chcr[ch] = ch === 6 ? ((v & 0x51000000) | 2) >>> 0 : v >>> 0;\n      this.maybeStart(ch);\n    }\n  }\n\n  maybeStart(ch) {\n    const c = this.chcr[ch];\n    if (!(c & 0x01000000)) return;                                   // start/busy\n    if (!(this.dpcr & (8 << (ch * 4)))) return;                      // canal desabilitado no DPCR\n    const sync = (c >> 9) & 3;\n    // modo 0: só o OTC (sem linha DREQ) e o PIO precisam do bit de trigger; GPU/CD/SPU/MDEC iniciam sozinhos (medido em hardware)\n    if (sync === 0 && !(c & 0x10000000) && (ch === 6 || ch === 5)) return;\n    const words = this.run(ch);\n    if (words < 0) return;                                           // adiado (aguardando dados do MDEC)\n    this.sys.sched.call(this.sys.now() + this.duration(ch, words, c), 'dma', 'finish', [ch]);\n  }\n\n  /** duração (ciclos de CPU) de uma transferência. Ajustado às medições do ps1-tests/dma/chopping:\n   *  1 ciclo/palavra (CD 24, SPU 12), +~10 por bloco no sync 1, e chopping = janela de DMA + pausa da CPU a cada fatia */\n  duration(ch, words, c) {\n    const per = ch === 3 ? 24 : ch === 4 ? 12 : 1, sync = (c >> 9) & 3; let cyc = words * per + (ch === 2 ? 150 : 16);\n    if (c & 0x100) {                                                 // chopping\n      const win = 1 << ((c >> 16) & 7), cpu = Math.min(1 << ((c >> 20) & 7), 32 * win);\n      cyc += Math.ceil(words / win) * (6 + cpu);\n    } else if (sync === 1) cyc += (((this.bcr[ch] >>> 16) || 0x10000)) * 10;\n    return Math.max(8, Math.round(cyc));\n  }\n\n  finish(ch) {\n    this.chcr[ch] &= ~0x11000000;\n    if ((this.dicr >> (16 + ch)) & 1) {\n      this.dicr |= (1 << (24 + ch));\n      this.updateIrq();\n      // cada conclusão de um canal habilitado reafirma a IRQ3 (não só na subida do bit 31):\n      // evita que uma flag não reconhecida silencie todas as próximas interrupções de DMA\n      if ((this.dicr >>> 31) & 1) this.sys.irq(3);\n    } else this.updateIrq();\n  }\n  updateIrq() {\n    const flags = (this.dicr >> 24) & 0x7F, en = (this.dicr >> 16) & 0x7F, master = (this.dicr >> 23) & 1, force = (this.dicr >> 15) & 1;\n    const m = !!(force || (master && (flags & en)));\n    this.dicr = ((this.dicr & 0x7FFFFFFF) | (m ? 0x80000000 : 0)) >>> 0;\n    if (m && !this.prevIrq) this.sys.irq(3);\n    this.prevIrq = m;\n  }\n\n  /** o MDEC produziu dados: atende um DMA1 que estava esperando */\n  mdecOutReady() {\n    const m = this.dev.mdec, p = m && m.pendingOut; if (!p || m.outWords() < p.words) return;\n    m.pendingOut = null; const rv = this.sys.bus.ramView, b = m.dmaRead(p.words); let a = p.addr;\n    const bus = this.sys.bus; for (let i = 0; i < p.words; i++) { const o = a & 0x1FFFFC; rv.setUint32(o, b[i], true); if (bus.codeFlags[o >>> 6]) bus.onCodeWrite(o); a += p.step; }\n    this.madr[1] = a & 0xFFFFFF;\n    this.sys.sched.call(this.sys.now() + Math.max(8, p.words), 'dma', 'finish', [1]);\n  }\n\n  /** executa a transferência; devolve o nº de palavras */\n  run(ch) {\n    const bus = this.sys.bus, rv = bus.ramView, c = this.chcr[ch];\n    const dir = c & 1, step = (c & 2) ? -4 : 4, sync = (c >> 9) & 3;\n    let addr = this.madr[ch] & 0x1FFFFC, bcr = this.bcr[ch];\n    const words = sync === 1 ? ((bcr & 0xFFFF) * (bcr >>> 16)) || 0x10000 : ((bcr & 0xFFFF) || 0x10000);\n    const rd = a => rv.getUint32(a & 0x1FFFFC, true), wr = (a, v) => { const o = a & 0x1FFFFC; rv.setUint32(o, v >>> 0, true); if (bus.codeFlags[o >>> 6]) bus.onCodeWrite(o); };\n    const d = this.dev;\n\n    switch (ch) {\n      case 6: {                                                      // OTC: lista encadeada reversa\n        for (let i = 0; i < words; i++) { wr(addr, i === words - 1 ? 0x00FFFFFF : (addr - 4) & 0x1FFFFF); addr = (addr - 4) & 0x1FFFFC; }\n        this.madr[6] = addr; return words;\n      }\n      case 2:                                                        // GPU\n        if (sync === 2) {                                            // linked list\n          let n = 0, a = addr;\n          for (let g = 0; g < 0x100000; g++) {\n            const hdr = rd(a), cnt = hdr >>> 24;\n            for (let i = 1; i <= cnt; i++) d.gpu.writeGP0(rd(a + 4 * i));\n            n += cnt + 1; if (hdr & 0x800000) break; a = hdr & 0x1FFFFC;\n          }\n          this.madr[2] = a; return n;\n        }\n        if (dir) { for (let i = 0; i < words; i++) { d.gpu.writeGP0(rd(addr)); addr += step; } }\n        else { for (let i = 0; i < words; i++) { wr(addr, d.gpu.readData()); addr += step; } }\n        this.madr[2] = addr & 0xFFFFFF; return words;\n      case 4: {                                                      // SPU\n        if (dir) { const b = new Uint32Array(words); for (let i = 0; i < words; i++) { b[i] = rd(addr); addr += step; } d.spu.dmaWrite(b); }\n        else { const b = d.spu.dmaRead(words); for (let i = 0; i < words; i++) { wr(addr, b[i]); addr += step; } }\n        this.madr[4] = addr & 0xFFFFFF; return words;\n      }\n      case 3: {                                                      // CD-ROM -> RAM\n        const b = d.cdrom.dmaRead(words); for (let i = 0; i < words; i++) { wr(addr, b[i]); addr += step; }\n        this.madr[3] = addr & 0xFFFFFF; return words;\n      }\n      case 0: {                                                      // MDEC in (RAM -> MDEC)\n        if (d.mdec) { const b = new Uint32Array(words); for (let i = 0; i < words; i++) { b[i] = rd(addr); addr += step; } d.mdec.dmaWrite(b); }\n        return words;\n      }\n      case 1: {                                                      // MDEC out (MDEC -> RAM)\n        const m = d.mdec;\n        if (m && m.outWords() < words) { m.pendingOut = { addr, step, words }; return -1; }          // espera o decodificador\n        const b = m ? m.dmaRead(words) : new Uint32Array(words);\n        for (let i = 0; i < words; i++) { wr(addr, b[i]); addr += step; }\n        this.madr[1] = addr & 0xFFFFFF; return words;\n      }\n      default: return words;                                         // PIO: ignorado\n    }\n  }\n}\n\nreturn { DMA };\n})();\nconst __src_mdec = (() => {\n// ============================================================================\n//  MDEC - decodificador de macroblocos (vídeo STR / imagens) 0x1F801820 / 0x1F801824\n//   0x1F801820 W: comando/parâmetros   R: dados decodificados\n//   0x1F801824 W: controle (b31 reset, b30 DMA0 on, b29 DMA1 on)   R: status\n//  Comandos (bits 31-29 da palavra de comando):\n//   1 = decodificar macroblocos (b28-27 profundidade: 0=4bit 1=8bit 2=24bit 3=15bit, b26 signed, b25 bit15, b15-0 = nº de palavras)\n//   2 = tabelas de quantização (b0: 0 = só luma 64B, 1 = luma + croma 128B)\n//   3 = tabela de escala do IDCT (64 halfwords)\n//  Entrada: halfwords RLE: [qscale(6) | DC(10)] depois [run(6) | valor(10)] ... até 0xFE00 (fim de bloco)\n//  Saída: macroblocos 16x16 (cores) na ordem do fluxo; cada um é decodificado de blocos Cr,Cb,Y1,Y2,Y3,Y4.\n//  A decodificação é imediata (sem temporização); a conclusão do DMA é agendada pelo controlador de DMA.\n// ============================================================================\nconst ZIGZAG = [0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28,\n                35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63];\nconst IDLE = 0, DECODE = 1, QUANT = 2, SCALE = 3;\nconst sx10 = v => (v << 22) >> 22;\nconst clamp = (v, lo, hi) => v < lo ? lo : v > hi ? hi : v;\n\n/** tabela de cossenos padrão: T[k*8+n] = a_k * cos((2n+1)kπ/16) * 32768  (a_0 = 1/√2) */\nfunction defaultScaleTable() {\n  const t = new Int16Array(64);\n  for (let k = 0; k < 8; k++) for (let n = 0; n < 8; n++) t[k * 8 + n] = Math.trunc((k === 0 ? Math.SQRT1_2 : 1) * Math.cos((2 * n + 1) * k * Math.PI / 16) * 32768);\n  return t;\n}\n\nclass MDEC {\n  constructor() {\n    this.out = new Uint8Array(1 << 22); this.onOutput = null; this.pendingOut = null;\n    this.qtY = new Uint8Array(64).fill(2); this.qtC = new Uint8Array(64).fill(2); this.scale = defaultScaleTable();\n    this.reset();\n  }\n\n  reset() {\n    this.state = IDLE; this.remaining = 0; this.depth = 0; this.signed = 0; this.bit15 = 0;\n    this.hw = []; this.hwPos = 0; this.blocks = [0, 1, 2, 3, 4, 5].map(() => new Int32Array(64)); this.blk = 0;\n    this.head = 0; this.tail = 0; this.dmaInEn = false; this.dmaOutEn = false; this.qbuf = []; this.sbuf = []; this.colorQ = false;\n    this.coef = new Int32Array(64); this.tmp = new Int32Array(64); this.pendingOut = null; this.blocksDone = 0;\n  }\n\n  outWords() { return (this.tail - this.head) >> 2; }\n\n  // ---------------- registradores ----------------\n  read(addr) {\n    if ((addr & 4) === 0) return this.dmaRead(1)[0];\n    let s = 0;\n    if (this.outWords() === 0) s |= 0x80000000;\n    if (this.state !== IDLE) s |= 0x20000000;                       // comando em andamento (busy)\n    if (this.dmaInEn) s |= 0x10000000;\n    if (this.dmaOutEn && this.outWords() > 0) s |= 0x08000000;\n    s |= (this.depth << 25) | (this.signed << 24) | (this.bit15 << 23) | ((this.blk < 6 ? (this.blk + 4) % 6 : 0) << 16);\n    s |= this.state === IDLE ? 0 : ((this.remaining - 1) & 0xFFFF);\n    return s >>> 0;\n  }\n  write(addr, v) {\n    if ((addr & 4) === 0) { this.writeWord(v >>> 0); return; }\n    if (v & 0x80000000) { const o = this.out; const e1 = this.onOutput; this.reset(); this.out = o; this.onOutput = e1; }\n    this.dmaInEn = !!(v & 0x40000000); this.dmaOutEn = !!(v & 0x20000000);\n  }\n\n  // palavra de comando ou de parâmetro (via CPU ou DMA0)\n  writeWord(w) {\n    if (this.state === IDLE) {\n      const cmd = w >>> 29;\n      if (cmd === 1) {\n        this.depth = (w >>> 27) & 3; this.signed = (w >>> 26) & 1; this.bit15 = (w >>> 25) & 1; this.remaining = w & 0xFFFF;\n        this.state = this.remaining ? DECODE : IDLE; this.blk = 0; this.hw = []; this.hwPos = 0;\n      } else if (cmd === 2) { this.colorQ = !!(w & 1); this.remaining = this.colorQ ? 32 : 16; this.qbuf = []; this.state = QUANT; }\n      else if (cmd === 3) { this.remaining = 32; this.sbuf = []; this.state = SCALE; }\n      return;\n    }\n    if (this.state === QUANT) {\n      this.qbuf.push(w & 255, (w >>> 8) & 255, (w >>> 16) & 255, w >>> 24);\n      if (--this.remaining === 0) {\n        this.qtY.set(this.qbuf.slice(0, 64));\n        if (this.colorQ) this.qtC.set(this.qbuf.slice(64, 128)); else this.qtC.set(this.qtY);\n        this.state = IDLE;\n      }\n    } else if (this.state === SCALE) {\n      this.sbuf.push(((w & 0xFFFF) << 16) >> 16, (w >> 16));\n      if (--this.remaining === 0) { this.scale.set(this.sbuf); this.state = IDLE; }\n    } else {                                                          // DECODE\n      this.hw.push(w & 0xFFFF, w >>> 16);\n      if (this.hw.length > 8192) { this.hw = this.hw.slice(this.hwPos); this.hwPos = 0; }   // evita crescer sem limite\n      this.decodeAvailable();\n      if (--this.remaining === 0) {\n        this.state = IDLE; this.hw = []; this.hwPos = 0;\n        if (this.outWords() > 0) this.onOutput?.();\n      }\n    }\n  }\n\n  dmaWrite(words) { for (let i = 0; i < words.length; i++) this.writeWord(words[i]); }\n  /** retira n palavras da saída (as que faltarem vêm como zero) */\n  dmaRead(n) {\n    const o = new Uint32Array(n); let p = this.head;\n    for (let i = 0; i < n && p + 4 <= this.tail; i++, p += 4) o[i] = (this.out[p] | (this.out[p + 1] << 8) | (this.out[p + 2] << 16) | (this.out[p + 3] << 24)) >>> 0;\n    this.head = Math.min(this.tail, p); if (this.head === this.tail) this.head = this.tail = 0;\n    return o;\n  }\n\n  // ---------------- decodificação ----------------\n  /** decodifica todos os blocos completos disponíveis na fila de halfwords */\n  decodeAvailable() {\n    const color = this.depth >= 2;\n    for (;;) {\n      const res = this.decodeBlock(color ? (this.blk < 2 ? this.qtC : this.qtY) : this.qtY, this.blocks[color ? this.blk : 0]);\n      if (!res) return;\n      if (!color) { this.emitMono(this.blocks[0]); continue; }\n      if (++this.blk === 6) { this.blk = 0; this.emitColor(); }\n    }\n  }\n\n  /** lê 1 bloco (DC + ACs até EOB). Devolve false se faltarem halfwords (nada é consumido). */\n  decodeBlock(qt, dst) {\n    const hw = this.hw; let p = this.hwPos;\n    while (p < hw.length && hw[p] === 0xFE00) p++;                   // preenchimento antes do bloco\n    if (p >= hw.length) { this.hwPos = p; return false; }\n    const first = hw[p++], qscale = first >>> 10, coef = this.coef; coef.fill(0);\n    coef[0] = clamp(qscale === 0 ? sx10(first & 0x3FF) * 2 : sx10(first & 0x3FF) * qt[0], -1024, 1023);\n    let k = 0, done = false;\n    while (p < hw.length) {\n      const h = hw[p++];\n      if (h === 0xFE00) { done = true; break; }\n      k += (h >>> 10) + 1;\n      if (k > 63) { done = true; break; }\n      { const n = sx10(h & 0x3FF), q = qscale === 0 ? n * 2 : (n * qt[k] * qscale + 4) >> 3; coef[ZIGZAG[k]] = q < -1024 ? -1024 : q > 1023 ? 1023 : q; }\n      if (k === 63) { done = true; break; }\n    }\n    if (!done) return false;                                         // bloco incompleto: espera mais dados\n    this.hwPos = p; this.idct(coef, dst); this.blocksDone++; return true;\n  }\n\n  /** IDCT 2D inteira (2 passadas), resultado saturado em -128..127 */\n  idct(src, dst) {\n    const T = this.scale, tmp = this.tmp, nzz = this.nzz || (this.nzz = new Int32Array(8)), nzv = this.nzv || (this.nzv = new Int32Array(8));\n    for (let pass = 0; pass < 2; pass++) {\n      const s = pass === 0 ? src : tmp, d = pass === 0 ? tmp : dst;\n      for (let y = 0; y < 8; y++) {\n        let n = 0;                                                    // só os coeficientes não nulos da coluna entram na soma (resultado idêntico, bem menos multiplicações)\n        for (let z = 0; z < 8; z++) { const v = s[y + z * 8]; if (v !== 0) { nzz[n] = z * 8; nzv[n++] = v; } }\n        if (n === 0) { for (let x = 0; x < 8; x++) d[x + y * 8] = 0; continue; }\n        for (let x = 0; x < 8; x++) {\n          let sum = 0;\n          for (let i = 0; i < n; i++) sum += nzv[i] * T[x + nzz[i]];\n          d[x + y * 8] = pass === 0 ? sum >> 13 : Math.floor((sum + 0x4000) / 32768);   // medido contra o console real (ps1-tests/mdec/frame)\n        }\n      }\n    }\n    for (let i = 0; i < 64; i++) { const v = (dst[i] + 8) >> 4; dst[i] = v < -128 ? -128 : v > 127 ? 127 : v; }\n  }\n\n  put(b) { if (this.tail < this.out.length) this.out[this.tail++] = b; }\n\n  emitMono(blk) {\n    const off = this.signed ? 0 : 128;\n    if (this.depth === 1) for (let i = 0; i < 64; i++) this.put((blk[i] + off) & 255);              // 8 bits\n    else for (let i = 0; i < 64; i += 2) this.put((((blk[i] + off) & 255) >> 4) | ((((blk[i + 1] + off) & 255) >> 4) << 4));   // 4 bits\n  }\n\n  emitColor() {\n    const [cr, cb, y1, y2, y3, y4] = this.blocks, off = this.signed ? 0 : 128, b15 = this.bit15 << 15, ys = [y1, y2, y3, y4];\n    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {\n      const Y = ys[((y >> 3) << 1) | (x >> 3)][((y & 7) << 3) | (x & 7)], ci = ((y >> 1) << 3) | (x >> 1), Cr = cr[ci], Cb = cb[ci];\n      const r = clamp(Y + ((359 * Cr + 128) >> 8), -128, 127), g = clamp(Y - ((88 * Cb + 183 * Cr + 128) >> 8), -128, 127), b = clamp(Y + ((454 * Cb + 128) >> 8), -128, 127);\n      if (this.depth === 2) { this.put((r + off) & 255); this.put((g + off) & 255); this.put((b + off) & 255); }          // 24 bits\n      else {                                                                                                          // 15 bits\n        const q = v => Math.min(((v + off) & 255) + 4 >> 3, 31);   // 15 bits: arredonda (confirmado no console real)\n        const px = q(r) | (q(g) << 5) | (q(b) << 10) | b15;\n        this.put(px & 255); this.put(px >> 8);\n      }\n    }\n  }\n}\n\nreturn { defaultScaleTable, MDEC };\n})();\nconst __src_memcard = (() => {\n// ============================================================================\n//  Memory Card (128 KB = 1024 setores de 128 bytes = 16 blocos de 8 KB)\n//   bloco 0 = diretório: frame 0 \"MC\" | frames 1..15 = entradas dos 15 blocos de dados |\n//                        frames 16..35 = lista de setores ruins | 63 = cópia do frame 0\n//  Formatos de arquivo aceitos: cru 128KB (.mcr/.mcd/.mc/.bin), VGS (+64 bytes \"VgsM\"),\n//  DexDrive (+3904 bytes \"123-456-STD\"). Exporta sempre em formato cru (compatível com ePSXe/DuckStation).\n// ============================================================================\nconst CARD_SIZE = 131072, SECTOR = 128, SECTORS = 1024;\n\nconst xor127 = (b, o) => { let x = 0; for (let i = 0; i < 127; i++) x ^= b[o + i]; return x; };\n\nclass MemoryCard {\n  constructor(bytes) {\n    this.data = new Uint8Array(CARD_SIZE);\n    this.flag = 0x08;                        // bit3 = \"diretório ainda não lido\" (cartão recém-inserido)\n    this.dirty = false;                      // houve gravação desde o último export\n    this.onWrite = null;                     // callback(sector) a cada setor gravado\n    this.format();\n    if (bytes) this.load(bytes);\n  }\n\n  /** Cartão em branco, formatado como o hardware/BIOS faz */\n  format() {\n    const d = this.data; d.fill(0);\n    d[0] = 0x4D; d[1] = 0x43; d[127] = xor127(d, 0);                       // frame 0: \"MC\"\n    for (let i = 1; i <= 15; i++) {                                         // entradas livres\n      const o = i * SECTOR; d[o] = 0xA0; d[o + 8] = 0xFF; d[o + 9] = 0xFF; d[o + 127] = xor127(d, o);\n    }\n    for (let i = 16; i <= 35; i++) {                                        // lista de setores ruins (vazia)\n      const o = i * SECTOR; d.fill(0xFF, o, o + 4); d[o + 8] = 0xFF; d[o + 9] = 0xFF; d[o + 127] = xor127(d, o);\n    }\n    d.copyWithin(63 * SECTOR, 0, SECTOR);                                   // frame 63 = cópia do 0\n    this.flag = 0x08; this.dirty = true;\n  }\n\n  /** Carrega um arquivo de cartão (detecta o formato). Lança erro se inválido. */\n  load(bytes) {\n    let off = 0;\n    const tag = String.fromCharCode(...bytes.subarray(0, 4));\n    if (bytes.length === CARD_SIZE + 64 && tag === 'VgsM') off = 64;\n    else if (bytes.length === CARD_SIZE + 3904 && String.fromCharCode(...bytes.subarray(0, 11)) === '123-456-STD') off = 3904;\n    else if (bytes.length !== CARD_SIZE) throw new Error(`tamanho de cartão inválido: ${bytes.length} bytes (esperado ${CARD_SIZE})`);\n    if (bytes[off] !== 0x4D || bytes[off + 1] !== 0x43) throw new Error('cartão sem assinatura \"MC\" (não formatado?)');\n    this.data.set(bytes.subarray(off, off + CARD_SIZE));\n    this.flag = 0x08; this.dirty = false;\n    return this;\n  }\n\n  /** Bytes crus para salvar em disco */\n  export() { this.dirty = false; return this.data.slice(); }\n\n  // ---- acesso por setor (usado pelo protocolo) ----\n  readSector(n) { return this.data.subarray(n * SECTOR, (n + 1) * SECTOR); }\n  writeSector(n, buf) {\n    this.data.set(buf.subarray(0, SECTOR), n * SECTOR);\n    this.flag &= ~0x08; this.dirty = true; this.onWrite?.(n);\n  }\n\n  /** Lista os saves do diretório (para a interface/depuração) */\n  listSaves() {\n    const d = this.data, out = [];\n    const dec = (b) => { try { return new TextDecoder('shift_jis').decode(b).replace(/\\0.*$/s, '').trim(); } catch { return ''; } };\n    for (let i = 1; i <= 15; i++) {\n      const o = i * SECTOR, st = d[o];\n      if (st !== 0x51) continue;                                           // 0x51 = primeiro bloco de um save\n      const size = (d[o + 4] | (d[o + 5] << 8) | (d[o + 6] << 16)) >>> 0;\n      const code = String.fromCharCode(...d.subarray(o + 10, o + 31)).replace(/\\0.*$/s, '');\n      const blk = i * 8192, hdr = d.subarray(blk, blk + 128);\n      out.push({ slot: i, code, blocks: Math.max(1, size / 8192 | 0), title: hdr[0] === 0x53 && hdr[1] === 0x43 ? dec(hdr.subarray(4, 68)) : '',\n                 ok: xor127(d, o) === d[o + 127] });\n    }\n    return out;\n  }\n  freeBlocks() { let n = 0; for (let i = 1; i <= 15; i++) if (this.data[i * SECTOR] === 0xA0 || this.data[i * SECTOR] === 0xA1 ||\n                                                              this.data[i * SECTOR] === 0xA2 || this.data[i * SECTOR] === 0xA3) n++; return n; }\n}\n\nreturn { CARD_SIZE, MemoryCard };\n})();\nconst __src_sio = (() => {\n// ============================================================================\n//  SIO0 (porta de controles / memory cards)  0x1F801040-0x1F80104F\n//   +0 DATA  +4 STAT  +8 MODE  +A CTRL  +E BAUD\n//  Emula: controle digital (ID 0x41) na porta 1; porta 2 e memory cards desconectados.\n// ============================================================================\nconst BUTTONS = { select: 0, l3: 1, r3: 2, start: 3, up: 4, right: 5, down: 6, left: 7,\n                         l2: 8, r2: 9, l1: 10, r1: 11, triangle: 12, circle: 13, cross: 14, square: 15 };\n\n//  Controles: 'digital' (ID 0x41) ou 'dualshock' (começa digital; o jogo entra em modo de configuração (0x43),\n//  liga o modo analógico (0x44) e passa a receber ID 0x73 com os 4 eixos; vibração via mapeamento 0x4D).\nconst STICKS = { rx: 0, ry: 1, lx: 2, ly: 3 };\n\nclass SIO {\n  constructor(sys) {\n    this.sys = sys; this.padConnected = [true, false]; this.cards = [null, null]; this.buttons = [0xFFFF, 0xFFFF];\n    this.padType = ['digital', 'digital'];                                  // configuração (não faz parte do save state)\n    this.sticks = [[0x80, 0x80, 0x80, 0x80], [0x80, 0x80, 0x80, 0x80]];     // rx, ry, lx, ly (0..255, centro 0x80)\n    this.onRumble = null;                                                   // (porta, pequeno 0/1, grande 0..255)\n    this.reset();\n  }\n  newPad() { return { analog: false, lock: false, config: false, map: [0x00, 0x01, 0xFF, 0xFF, 0xFF, 0xFF], small: 0, large: 0, cmd: 0, n: 0, pend: null }; }\n  /** troca o tipo do controle da porta: 'digital' | 'dualshock' */\n  setPadType(port, type) { this.padType[port] = type; this.pads[port] = this.newPad(); }\n  /** eixo analógico 0..255 (0x80 = centro): 'lx' | 'ly' | 'rx' | 'ry' */\n  setStick(name, value, port = 0) { this.sticks[port][STICKS[name]] = Math.max(0, Math.min(255, Math.round(value))); }\n  /** botão ANALOG do controle: liga/desliga o modo (se o jogo não o travou) */\n  toggleAnalog(port = 0) { const p = this.pads[port]; if (this.padType[port] === 'dualshock' && !p.lock) p.analog = !p.analog; return p.analog; }\n  reset() {\n    this.pads = [this.newPad(), this.newPad()];\n    this.stat = 0x5; this.mode = 0; this.ctrl = 0; this.baud = 0; this.rx = 0xFF; this.rxValid = false;\n    this.state = 0; this.dev = null; this.busyEvt = null; this.mc = null;\n  }\n  /** pressiona/solta um botão (bits em nível baixo = pressionado) */\n  setButton(name, pressed, port = 0) {\n    const b = 1 << BUTTONS[name]; this.buttons[port] = pressed ? (this.buttons[port] & ~b) : (this.buttons[port] | b);\n  }\n\n  read(addr, size) {\n    switch (addr & 0xF) {\n      case 0: { const v = this.rx; this.rxValid = false; this.stat &= ~2; return v; }\n      case 4: return this.stat >>> 0;\n      case 8: return this.mode;\n      case 0xA: return this.ctrl;\n      case 0xE: return this.baud;\n    }\n    return 0;\n  }\n  write(addr, size, v) {\n    switch (addr & 0xF) {\n      case 0: this.tx(v & 0xFF); break;\n      case 8: this.mode = v & 0xFFFF; break;\n      case 0xA: {\n        this.ctrl = v & 0xFFFF;\n        if (v & 0x10) this.stat &= ~0x200;                           // ACK: limpa flag de IRQ\n        if (v & 0x40) { const c = this.ctrl; this.reset(); this.ctrl = 0; }   // reset\n        if (!(v & 2)) { this.state = 0; this.dev = null; this.mc = null; }   // /JOY desmarcado: fim da transação\n        break;\n      }\n      case 0xE: this.baud = v & 0xFFFF; break;\n    }\n  }\n\n  tx(byte) {\n    if (!(this.ctrl & 1)) return;                                    // TXEN desligado\n    this.stat &= ~0x5;                                               // TX ocupado\n    const factor = [1, 1, 16, 64][this.mode & 3], cyc = Math.max(8 * (this.baud || 0x88) * factor, 200);\n    this.sys.sched.call(this.sys.now() + cyc, 'sio', 'txDone', [byte]);\n  }\n  txDone(byte) {\n    const [resp, ack] = this.exchange(byte);\n    this.rx = resp; this.rxValid = true; this.stat |= 0x2 | 0x5;\n    if (ack) { this.stat |= 0x80; this.sys.sched.call(this.sys.now() + 100, 'sio', 'ackIrq', []); }   // DSR\n  }\n  ackIrq() {\n    this.stat |= 0x200; if (this.ctrl & 0x1000) this.sys.irq(7);\n    this.sys.sched.call(this.sys.now() + 60, 'sio', 'dsrOff', []);\n  }\n  dsrOff() { this.stat &= ~0x80; }\n\n  /** protocolo: devolve [byte de resposta, ack?] */\n  exchange(b) {\n    const port = (this.ctrl >> 13) & 1;\n    if (this.state === 0) {                                          // 1º byte = endereço do dispositivo\n      if (b === 0x01 && this.padConnected[port]) { this.dev = 'pad'; this.state = 1; return [0xFF, true]; }\n      if (b === 0x81 && this.cards[port]) { this.dev = 'mc'; this.state = 1; this.mc = { k: 1, cmd: 0, msb: 0, lsb: 0, sector: 0, buf: new Uint8Array(128), chk: 0, bad: false }; return [0xFF, true]; }\n      this.dev = null; this.state = -1; return [0xFF, false];        // porta vazia / memory card ausente: sem ACK\n    }\n    if (this.dev === 'pad') return this.exchangePad(b, port);\n    if (this.dev === 'mc') return this.exchangeMC(b, this.cards[port]);\n    return [0xFF, false];\n  }\n\n  /** controle: byte 1 = comando, 2 = 0x5A, depois dados. Devolve [byte, ack] */\n  exchangePad(b, port) {\n    const pad = this.pads[port], btn = this.buttons[port], s = this.state++;\n    const dual = this.padType[port] === 'dualshock';\n    if (s === 1) {\n      pad.cmd = dual ? b : 0x42; pad.n = 0; pad.pend = null;\n      const id = !dual ? 0x41 : pad.config ? 0xF3 : pad.analog ? 0x73 : 0x41;\n      pad.len = (id & 0xF) * 2; return [id, true];\n    }\n    if (s === 2) return [0x5A, true];\n    const i = s - 3, last = i === pad.len - 1;\n    if (i >= pad.len) return [0xFF, false];\n    const sticks = this.sticks[port], withSticks = pad.analog || pad.config;\n    let out = 0;\n    switch (pad.cmd) {\n      case 0x42: case 0x43: {\n        out = i === 0 ? btn & 0xFF : i === 1 ? btn >> 8 : (withSticks ? sticks[i - 2] : 0xFF);\n        if (pad.cmd === 0x42) {                                       // vibração: mapa 4D define que byte aciona qual motor\n          if (pad.map[i] === 0) pad.small = b & 1; else if (pad.map[i] === 1) pad.large = b;\n        } else if (i === 0) pad.pend = b === 1;                       // 0x43: 1 entra / 0 sai do modo de configuração\n        break;\n      }\n      case 0x44: out = 0; if (i === 0) pad.pend = b === 1; else if (i === 1) pad.lock = b === 3; break;\n      case 0x45: out = [0x01, 0x02, pad.analog ? 1 : 0, 0x02, 0x01, 0x00][i]; break;\n      case 0x46: out = (b === 1 ? [0x00, 0x01, 0x01, 0x01, 0x14, 0x00] : [0x00, 0x01, 0x02, 0x00, 0x0A, 0x00])[i]; if (i === 0) pad.sel = b; break;\n      case 0x47: out = [0x00, 0x00, 0x02, 0x00, 0x01, 0x00][i]; break;\n      case 0x4C: out = [0x00, 0x00, 0x00, 0x04, 0x00, 0x00][i]; break;\n      case 0x4D: out = pad.map[i]; if (!pad.pend) pad.pend = []; pad.pend[i] = b; break;\n      default: out = 0;\n    }\n    if (pad.cmd === 0x46 && i > 0) out = ((pad.sel === 1) ? [0x00, 0x01, 0x01, 0x01, 0x14, 0x00] : [0x00, 0x01, 0x02, 0x00, 0x0A, 0x00])[i];\n    if (last) this.padEnd(port, pad);\n    return [out, !last];\n  }\n  /** fim da transação: efetiva mudanças de modo/mapa e avisa a vibração */\n  padEnd(port, pad) {\n    if (pad.cmd === 0x43 && typeof pad.pend === 'boolean') pad.config = pad.pend;\n    else if (pad.cmd === 0x44 && typeof pad.pend === 'boolean') pad.analog = pad.pend;\n    else if (pad.cmd === 0x4D && Array.isArray(pad.pend)) pad.map = [0, 1, 2, 3, 4, 5].map(k => pad.pend[k] ?? 0xFF);\n    pad.pend = null;\n    const key = pad.small | (pad.large << 1);\n    if (key !== pad.sent) { pad.sent = key; this.onRumble?.(port, pad.small, pad.large); }\n  }\n\n  /**\n   * Protocolo do Memory Card (byte 0 = 0x81 já tratado). k = índice do byte na transação.\n   *  Leitura 'R'(52): FLAG 5A 5D 00 MSB 5C 5D MSB LSB [128 dados] CHK 47\n   *  Escrita 'W'(57): FLAG 5A 5D 00 MSB [eco...] CHK 5C 5D END(47 ok | 4E checksum | FF setor ruim)\n   *  GetID   'S'(53): FLAG 5A 5D 5C 5D 04 00 00 80\n   * Todos os bytes têm ACK, exceto o último da transação.\n   */\n  exchangeMC(b, card) {\n    const m = this.mc, k = m.k++, A = true, END = false;\n    if (k === 1) {\n      m.cmd = b;\n      if (b === 0x52 || b === 0x57 || b === 0x53) return [card.flag, A];\n      this.dev = null; this.state = -1; return [0xFF, END];            // comando desconhecido\n    }\n    if (m.cmd === 0x53) {                                              // GetID\n      const r = { 2: 0x5A, 3: 0x5D, 4: 0x5C, 5: 0x5D, 6: 0x04, 7: 0x00, 8: 0x00, 9: 0x80 }[k];\n      return r === undefined ? [0xFF, END] : [r, k < 9];\n    }\n    if (k === 2) return [0x5A, A];\n    if (k === 3) return [0x5D, A];\n    if (k === 4) { m.msb = b; return [0x00, A]; }\n    if (k === 5) { m.lsb = b; m.sector = (m.msb << 8) | m.lsb; m.bad = m.sector >= 1024; return [m.msb, A]; }\n\n    if (m.cmd === 0x52) {                                              // ---- leitura ----\n      if (k === 6) return [0x5C, A];\n      if (k === 7) return [0x5D, A];\n      if (k === 8) return [m.bad ? 0xFF : m.msb, A];\n      if (k === 9) return [m.bad ? 0xFF : m.lsb, !m.bad];             // setor inválido: encerra sem dados\n      if (m.bad) return [0xFF, END];\n      if (k === 10) { m.buf.set(card.readSector(m.sector)); m.chk = m.msb ^ m.lsb; }\n      if (k >= 10 && k < 138) { const v = m.buf[k - 10]; m.chk ^= v; return [v, A]; }\n      if (k === 138) return [m.chk, A];\n      if (k === 139) return [0x47, END];\n      return [0xFF, END];\n    }\n    // ---- escrita ----\n    if (k >= 6 && k < 134) { const i = k - 6; m.buf[i] = b; return [i === 0 ? m.lsb : m.buf[i - 1], A]; }\n    if (k === 134) { m.chk = b; return [m.buf[127], A]; }\n    if (k === 135) return [0x5C, A];\n    if (k === 136) return [0x5D, A];\n    if (k === 137) {\n      let want = m.msb ^ m.lsb; for (let i = 0; i < 128; i++) want ^= m.buf[i];\n      let end = 0x47;\n      if (m.bad) end = 0xFF; else if (want !== m.chk) end = 0x4E; else card.writeSector(m.sector, m.buf);\n      return [end, END];\n    }\n    return [0xFF, END];\n  }\n}\n\nreturn { BUTTONS, STICKS, SIO };\n})();\nconst __src_cdrom = (() => {\n// ============================================================================\n//  Controlador de CD-ROM  0x1F801800-0x1F801803  (4 registradores com \"index\" 0..3)\n//   0x1800 R: status   W: index\n//   0x1801 R: resposta W: comando(idx0)\n//   0x1802 R: dados    W: parâmetro(idx0) / enable de INT(idx1)\n//   0x1803 R: enable(idx0,2) / flags(idx1,3)   W: request(idx0) / ack(idx1)\n//  INT1 dado pronto | INT2 completo | INT3 ack | INT4 fim de dados | INT5 erro  -> IRQ2\n//  Inclui decodificação XA-ADPCM (4 bits) enviada ao mixer do SPU.\n// ============================================================================\nconst { lbaToMsf, msfToLba } = __src_disc;\nconst bcd = v => ((v / 10 | 0) << 4) | (v % 10);\nconst CMD_DELAY = 25000;                    // ciclos até a 1ª resposta\n// medidos no console real (ps1-tests/cdrom/timing; média de 'Remaining Sectors' em ciclos) — ~0,7% mais rápido que 33868800/75\nconst SECTOR_1X = 448342, SECTOR_2X = 223825;\nconst XA_POS = [0, 60, 115, 98], XA_NEG = [0, 0, -52, -55];\nconst sat16 = v => v > 32767 ? 32767 : v < -32768 ? -32768 : v;\n\nclass CDROM {\n  constructor(sys) { this.sys = sys; this.disc = null; this.spu = null; this.regionOverride = 'SCEA'; this.log = null; this.reset(); }\n\n  reset() {\n    this.index = 0; this.param = []; this.resp = []; this.intEnable = 0; this.intFlag = 0; this.queue = [];\n    this.mode = 0; this.busy = false; this.reading = false; this.seeking = false; this.playing = false;\n    this.pos = 0; this.seekLba = 0; this.hasSetloc = false; this.filterFile = 0; this.filterChan = 0;\n    this.data = null; this.dpos = 0; this.sector = null; this.readEvt = null; this.lastHdr = new Uint8Array(8);\n    this.xaOld = [[0, 0], [0, 0]]; this.xaPhase = 0; this.motor = !!this.disc; this.sectorsRead = 0;\n    this.muted = false; this.lid = false; this.shellFlag = false; this.playCount = 0; this.reportAlt = 0; this.peak = 0;\n  }\n  setDisc(d) { this.disc = d; this.motor = !!d; }\n\n  // ---------------- tampa / troca de disco ----------------\n  /** abre a tampa: para tudo; Getstat passa a mostrar \"shell open\" (bit 4) */\n  openLid() { this.stopRead(); this.lid = true; this.motor = false; }\n  /** fecha a tampa com outro disco (ou nenhum); o 1º Getstat depois reporta o bit 4 uma vez, como o hardware */\n  closeLid(disc) { this.disc = disc || null; this.lid = false; this.shellFlag = true; this.motor = !!disc; this.hasSetloc = false; this.pos = 0; }\n\n  // ---------------- trilhas / TOC ----------------\n  tocTracks() { return (this.disc && this.disc.tracks) || [{ n: 1, type: 'data', start: 0 }]; }\n  trackAt(lba) { const t = this.tocTracks(); for (let i = t.length - 1; i >= 0; i--) if (lba >= (t[i].pre ?? t[i].start)) return t[i]; return t[0]; }\n  total() { return this.disc ? this.disc.sectorCount : 0; }\n\n  stat() {\n    let s = 0;\n    if (!this.disc || this.lid || this.shellFlag) s |= 0x10; if (this.disc && this.motor) s |= 0x02;\n    if (this.reading) s |= 0x20; if (this.seeking) s |= 0x40; if (this.playing) s |= 0x80;\n    return s;\n  }\n\n  // ---------------- registradores ----------------\n  read(addr, size) {\n    switch (addr & 3) {\n      case 0: return this.index | ((this.data && this.dpos < this.data.length) ? 0x40 : 0) | (this.param.length === 0 ? 0x08 : 0) |\n                     (this.param.length < 16 ? 0x10 : 0) | (this.resp.length ? 0x20 : 0) | (this.busy ? 0x80 : 0);\n      case 1: return this.resp.length ? this.resp.shift() : 0;\n      case 2: { let v = 0; for (let i = 0; i < size; i++) v |= this.readData() << (8 * i); return v >>> 0; }\n      case 3: return ((this.index & 1) ? this.intFlag : this.intEnable) | 0xE0;\n    }\n  }\n  write(addr, size, v) {\n    v &= 0xFF;\n    switch (addr & 3) {\n      case 0: this.index = v & 3; return;\n      case 1: if (this.index === 0) this.command(v); return;\n      case 2:\n        if (this.index === 0) { if (this.param.length < 16) this.param.push(v); }\n        else if (this.index === 1) { this.intEnable = v & 0x1F; if (this.intFlag & this.intEnable) this.sys.irq(2); }\n        return;\n      case 3:\n        if (this.index === 0) { if (v & 0x80) { if (this.sector && !(this.data && this.dpos < this.data.length)) { this.data = this.sector; this.dpos = 0; } } else this.data = null; }\n        else if (this.index === 1) this.ack(v);\n        return;\n    }\n  }\n\n  readData() {\n    if (!this.data || this.dpos >= this.data.length) return 0;\n    const b = this.data[this.dpos++]; if (this.dpos >= this.data.length) this.data = null; return b;\n  }\n  dmaRead(words) {\n    const o = new Uint32Array(words);\n    for (let i = 0; i < words; i++) o[i] = (this.readData() | (this.readData() << 8) | (this.readData() << 16) | (this.readData() << 24)) >>> 0;\n    return o;\n  }\n\n  // ---------------- interrupções ----------------\n  respond(type, resp, delay, clearBusy) {\n    this.sys.sched.call(this.sys.now() + delay, 'cdrom', 'fire', [type, resp, !!clearBusy]);\n  }\n  /** resposta atrasada: `resp` é um vetor de bytes fixo ou uma especificação ['S', ...extras] / ['GS'] / ['PARAM'] / ['LOCL'] / ['MON'] / ['MOFF'] / ['SEEK'] resolvida na entrega */\n  fire(type, resp, clearBusy) { if (clearBusy) this.busy = false; this.deliver(type, this.mkResp(resp)); }\n  mkResp(r) {\n    if (typeof r[0] === 'number' || r.length === 0) return r;\n    switch (r[0]) {\n      case 'S': return [this.stat(), ...r.slice(1)];\n      case 'GS': { const st = this.stat(); this.shellFlag = false; return [st]; }\n      case 'PARAM': return [this.stat(), this.mode, 0, this.filterFile, this.filterChan];\n      case 'LOCL': return [...this.lastHdr];\n      case 'MON': this.motor = !!this.disc; return [this.stat()];\n      case 'MOFF': this.motor = false; return [this.stat()];\n      case 'SEEK': if (this.hasSetloc) { this.pos = this.seekLba; this.hasSetloc = false; } return [this.stat()];\n    }\n    throw new Error('resposta CD desconhecida ' + r[0]);\n  }\n  deliver(type, resp) {\n    if (this.intFlag !== 0) { this.queue.push({ type, resp }); return; }\n    this.intFlag = type; this.resp = resp.slice();\n    this.log?.(`INT${type} [${resp.map(b => b.toString(16)).join(' ')}]`);\n    if (this.intEnable & type) this.sys.irq(2);\n  }\n  ack(v) {\n    this.intFlag &= ~(v & 0x1F);\n    if (v & 0x40) this.param.length = 0;\n    if (this.intFlag === 0 && this.queue.length) {\n      const q = this.queue.shift(); this.sys.sched.call(this.sys.now() + 500, 'cdrom', 'deliver', [q.type, q.resp]);\n    }\n  }\n\n  // ---------------- comandos ----------------\n  command(c) {\n    const p = this.param; this.param = []; this.busy = true; this.resp = [];\n    this.log?.(`CMD ${c.toString(16)} (${p.map(b => b.toString(16)).join(' ')})`);\n    const first = (resp, d = CMD_DELAY) => this.respond(3, resp, d, true);\n    const second = (resp, d) => this.respond(2, resp, d, false);\n    const err = (code, d = CMD_DELAY) => this.respond(5, [this.stat() | 1, code], d, true);\n\n    switch (c) {\n      case 0x01: first(['GS']); break;   // Getstat\n      case 0x02:                                                                       // Setloc\n        if (p.length < 3) return err(0x20);\n        this.seekLba = msfToLba(p[0], p[1], p[2]); this.hasSetloc = true; first(['S']); break;\n      case 0x06: case 0x1B: {                                                          // ReadN / ReadS\n        if (!this.disc) return err(0x80);\n        this.stopRead(); this.reading = true; this.seeking = false;\n        let delay = 0;\n        if (this.hasSetloc) { this.pos = this.seekLba; this.hasSetloc = false; delay = (this.mode & 0x80) ? 667000 : 362000; }   // 1º setor medido no console: ~784k (1x) / ~865k (2x)\n        first(['S']);\n        this.readEvt = this.sys.sched.call(this.sys.now() + delay + this.interval(), 'cdrom', 'readSector');\n        break;\n      }\n      case 0x07: first(['S']); second(['MON'], 100000); break;   // MotorOn\n      case 0x08: { first(['S']); this.stopRead(); second(['MOFF'], 200000); break; }  // Stop\n      case 0x09: { const s = this.stat(), was = this.reading || this.playing; this.stopRead(); first([s]); second(['S'], was ? ((this.mode & 0x80) ? 1062000 : 1038000) : 150000); break; }  // Pause (lendo: ~1,0M ciclos no console)\n      case 0x0A: {                                                                      // Init\n        this.stopRead(); this.mode = 0; this.hasSetloc = false;\n        first(['S']); second(['MON'], 502000); break;                                 // Init completo: ~476k em média no console\n      }\n      case 0x0B: this.muted = true; first(['S']); break;                  // Mute\n      case 0x0C: this.muted = false; first(['S']); break;                 // Demute\n      case 0x0D: this.filterFile = p[0] | 0; this.filterChan = p[1] | 0; first(['S']); break;   // Setfilter\n      case 0x0E: this.mode = p[0] | 0; first(['S']); break;               // Setmode\n      case 0x0F: first(['PARAM']); break;           // Getparam\n      case 0x10: first(['LOCL']); break;                                 // GetlocL\n      case 0x11: {                                                                      // GetlocP\n        const lba = Math.max(0, this.pos - (this.playing ? 0 : 1)), t = this.trackAt(lba), a = lbaToMsf(lba);\n        const idx = lba >= t.start ? 1 : 0, rel = idx ? lba - t.start : t.start - lba;\n        first([bcd(t.n), idx, bcd(rel / 4500 | 0), bcd((rel / 75 | 0) % 60), bcd(rel % 75), a.m, a.s, a.f]); break;\n      }\n      case 0x13: { const tr = this.tocTracks(); first(['S', bcd(tr[0].n), bcd(tr[tr.length - 1].n)]); break; }   // GetTN\n      case 0x14: {                                                                      // GetTD\n        const t = (p[0] >> 4) * 10 + (p[0] & 15), tr = this.tocTracks();\n        if (t === 0) { const m = lbaToMsf(this.total()); first(['S', m.m, m.s]); }\n        else { const e = tr.find(x => x.n === t); if (e) { const m = lbaToMsf(e.start); first(['S', m.m, m.s]); } else err(0x10); }\n        break;\n      }\n      case 0x15: case 0x16: {                                                           // SeekL / SeekP\n        first(['S']); second(['SEEK'], 100000); break;\n      }\n      case 0x19:                                                                        // Test\n        if (p[0] === 0x20) first([0x94, 0x09, 0x19, 0xC0]); else first(['S']); break;\n      case 0x1A:                                                                        // GetID\n        first(['S']);\n        if (!this.disc) this.respond(5, [0x08, 0x40, 0, 0, 0, 0, 0, 0], 50000, false);\n        else {\n          const reg = this.regionOverride || this.disc.region(), L = reg.charCodeAt(3) || 0x41;\n          this.respond(2, ['S', 0x00, 0x20, 0x00, 0x53, 0x43, 0x45, L], 50000, false);\n        }\n        break;\n      case 0x12: case 0x1E: case 0x1C: first(['S']); second(['S'], 400000); break;   // SetSession / ReadTOC / Reset\n      case 0x03: {                                                                      // Play (CD-DA)\n        if (!this.disc) return err(0x80);\n        this.stopRead();\n        const t = p.length && p[0] ? this.tocTracks().find(x => x.n === ((p[0] >> 4) * 10 + (p[0] & 15))) : null;\n        let delay = 0;\n        if (t) { this.pos = t.start; this.hasSetloc = false; delay = 100000; }\n        else if (this.hasSetloc) { this.pos = this.seekLba; this.hasSetloc = false; delay = 100000; }\n        this.playing = true; this.playCount = 0; this.reportAlt = 0;\n        first(['S']);\n        this.readEvt = this.sys.sched.call(this.sys.now() + delay + this.interval(), 'cdrom', 'playSector');\n        break;\n      }\n      case 0x04: case 0x05: first(['S']); break;                          // Forward/Backward (busca rápida: ignorada)\n      default: err(0x40);                                                               // comando inválido\n    }\n  }\n\n  interval() { return (this.mode & 0x80) ? SECTOR_2X : SECTOR_1X; }\n  stopRead() { this.reading = false; this.seeking = false; this.playing = false; if (this.readEvt) { this.sys.sched.cancel(this.readEvt); this.readEvt = null; } }\n\n  readSector() {\n    this.readEvt = null; if (!this.reading || !this.disc) return;\n    // hardware: não avança p/ o próximo setor enquanto houver interrupção pendente (evita sobrescrever o buffer)\n    if (this.intFlag !== 0 || this.queue.length) { this.readEvt = this.sys.sched.call(this.sys.now() + 1500, 'cdrom', 'readSector'); return; }\n    const lba = this.pos, sec = this.disc.readSector(lba);\n    if (!sec) { this.reading = false; this.deliver(4, [this.stat()]); return; }\n    const raw = this.disc.raw, info = raw ? this.disc.sectorInfo(lba) : null;\n    this.lastHdr = raw ? sec.slice(12, 20) : Uint8Array.from([...Object.values(lbaToMsf(lba)), 1, 0, 0, 0, 0]);\n    this.sectorsRead++;\n    if (info && (this.mode & 0x40) && info.audio && info.form2) {                     // XA-ADPCM: toca em vez de entregar\n      if (!(this.mode & 0x08) || (info.file === this.filterFile && info.channel === this.filterChan)) this.decodeXA(sec, info.coding);\n    } else {\n      this.sector = raw ? ((this.mode & 0x20) ? sec.slice(12, 12 + 0x924) : sec.slice(24, 24 + 0x800)) : sec.slice(0);\n      this.deliver(1, [this.stat()]);\n    }\n    this.pos++;\n    this.readEvt = this.sys.sched.call(this.sys.now() + this.interval(), 'cdrom', 'readSector');\n  }\n\n  // ---------------- CD-DA ----------------\n  playSector() {\n    this.readEvt = null; if (!this.playing || !this.disc) return;\n    const lba = this.pos;\n    if (lba >= this.total()) { this.playing = false; this.deliver(4, [this.stat()]); return; }\n    const t = this.trackAt(lba), sec = this.disc.readSector(lba);\n    let pk = 0;\n    if (t.type === 'audio' && sec && sec.length >= 2352) {\n      for (let i = 0; i < 588; i++) {\n        const o = i * 4, l = (sec[o] | (sec[o + 1] << 8)) << 16 >> 16, r = (sec[o + 2] | (sec[o + 3] << 8)) << 16 >> 16;\n        if (!this.muted && this.spu) this.spu.pushCd(l, r);\n        const a = l < 0 ? -l : l, b = r < 0 ? -r : r; if (a > pk) pk = a; if (b > pk) pk = b;\n      }\n    }\n    // relatório (mode bit 2): a cada 10 setores alterna tempo relativo/absoluto\n    if ((this.mode & 0x04) && (this.playCount++ % 10) === 0 && this.intFlag === 0 && !this.queue.length) {\n      const a = lbaToMsf(lba), idx = lba >= t.start ? 1 : 0, rel = idx ? lba - t.start : t.start - lba;\n      this.reportAlt ^= 1;\n      const mm = this.reportAlt ? bcd(rel / 4500 | 0) : a.m, ss = this.reportAlt ? (bcd((rel / 75 | 0) % 60) | 0x80) : a.s, ff = this.reportAlt ? bcd(rel % 75) : a.f;\n      this.deliver(1, [this.stat(), bcd(t.n), idx, mm, ss, ff, pk & 0xFF, pk >> 8]);\n    }\n    this.pos++;\n    if (((this.mode & 0x02) && this.pos >= t.end) || this.pos >= this.total()) {       // AutoPause / fim do disco\n      this.playing = false; this.deliver(4, [this.stat()]); return;\n    }\n    this.readEvt = this.sys.sched.call(this.sys.now() + this.interval(), 'cdrom', 'playSector');\n  }\n\n  // ---------------- XA-ADPCM ----------------\n  decodeXA(sec, coding) {\n    if (!this.spu || (coding & 0x10)) return;                                          // 8 bits: TODO\n    const stereo = !!(coding & 1), ratio = ((coding & 4) ? 18900 : 37800) / 44100;\n    const L = [], R = [];\n    for (let g = 0; g < 18; g++) {\n      const base = 24 + g * 128, units = [];\n      for (let i = 0; i < 8; i++) {\n        const hdr = sec[base + (i < 4 ? i : i + 4)], range = hdr & 15, filt = (hdr >> 4) & 3, shift = range > 12 ? 9 : range;\n        const old = this.xaOld[stereo ? (i & 1) : 0], out = new Int16Array(28);\n        for (let w = 0; w < 28; w++) {\n          const byte = sec[base + 16 + w * 4 + (i >> 1)], nib = (i & 1) ? byte >> 4 : byte & 15;\n          let s = (((nib << 12) << 16) >> 16) >> shift;\n          s = sat16(s + ((old[0] * XA_POS[filt] + old[1] * XA_NEG[filt] + 32) >> 6));\n          old[1] = old[0]; old[0] = s; out[w] = s;\n        }\n        units.push(out);\n      }\n      if (stereo) for (let q = 0; q < 4; q++) for (let k = 0; k < 28; k++) { L.push(units[2 * q][k]); R.push(units[2 * q + 1][k]); }\n      else for (let i = 0; i < 8; i++) for (let k = 0; k < 28; k++) { L.push(units[i][k]); R.push(units[i][k]); }\n    }\n    const n = L.length; let t = this.xaPhase;                                           // reamostra p/ 44.1kHz (linear)\n    while (t < n - 1) {\n      const i = t | 0, f = t - i;\n      if (!this.muted) this.spu.pushCd((L[i] + (L[i + 1] - L[i]) * f) | 0, (R[i] + (R[i + 1] - R[i]) * f) | 0);\n      t += ratio;\n    }\n    this.xaPhase = t - (n - 1);\n  }\n}\n\nreturn { CDROM };\n})();\nconst __src_state = (() => {\n// ============================================================================\n//  Save states: serialização genérica do estado do PSX\n//   Container: \"PS1S\" | versão u32 | tamanho do cabeçalho u32 | cabeçalho JSON | blobs binários\n//   Os arrays tipados (RAM, VRAM, RAM do SPU...) vão no blob sem os zeros finais; o resto, em JSON.\n//   Não entram: disco, BIOS, entradas (botões), memory cards (têm persistência própria), caches do JIT\n//   e do renderizador (reconstruídos ao restaurar), áudio já gerado.\n// ============================================================================\nconst STATE_VERSION = 1;\nconst MAGIC = 0x53315350;                                  // \"PS1S\" (little endian)\nconst TYPES = { Int8Array, Uint8Array, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array };\n\n// propriedades que nunca são salvas (referências cruzadas, callbacks, configuração, entradas)\nconst SKIP = new Set(['sys', 'bus', 'dev', 'disc', 'spu', 'gpu', 'dma', 'timers', 'sio', 'cdrom', 'mdec', 'hw', 'log', 'logIo', 'ioStats', 'unmapped',\n  'cards', 'buttons', 'padConnected', 'padType', 'sticks', 'onRumble', 'clock', 'regionOverride', 'bios', 'biosView', 'codeFlags', 'jit', 'deint']);\nconst COMPONENTS = ['cpu', 'bus', 'gpu', 'spu', 'dma', 'timers', 'sio', 'cdrom', 'mdec'];\nconst PSX_FIELDS = ['audioLen', 'lastTick', 'timerAt', 'nextTick', 'lineAcc', 'line', 'audioAcc', 'frameDone', 'frames', 'useJit'];\n\nclass Writer { constructor() { this.bufs = []; this.size = 0; }\n  add(u8) { let n = u8.length; while (n > 0 && u8[n - 1] === 0) n--; const off = this.size; this.bufs.push(u8.subarray(0, n)); this.size += n; return [off, n]; } }\n\nfunction enc(v, w, depth = 0) {\n  if (depth > 12) throw new Error('estrutura profunda demais no save state');\n  if (v === null || typeof v === 'boolean' || typeof v === 'string') return v;\n  if (typeof v === 'number') return Number.isFinite(v) ? v : { $n: String(v) };\n  if (v === undefined) return { $u: 1 };\n  if (typeof v === 'function' || v instanceof Map || v instanceof DataView) return undefined;\n  if (ArrayBuffer.isView(v)) {\n    const name = v.constructor.name; if (!TYPES[name]) throw new Error('tipo não suportado: ' + name);\n    const [off, n] = w.add(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));\n    return { $a: name, len: v.length, off, n };\n  }\n  if (Array.isArray(v)) return v.map(x => { const e = enc(x, w, depth + 1); return e === undefined ? null : e; });\n  const o = {};\n  for (const k of Object.keys(v)) { if (SKIP.has(k)) continue; const e = enc(v[k], w, depth + 1); if (e !== undefined) o[k] = e; }\n  return o;\n}\nconst isTyped = d => d && typeof d === 'object' && d.$a !== undefined;\nfunction dec(d, blob) {\n  if (d === null || typeof d !== 'object') return d;\n  if (d.$n !== undefined) return Number(d.$n);\n  if (d.$u) return undefined;\n  if (isTyped(d)) { const T = TYPES[d.$a], a = new T(d.len); new Uint8Array(a.buffer).set(blob.subarray(d.off, d.off + d.n)); return a; }\n  if (Array.isArray(d)) return d.map(x => dec(x, blob));\n  const o = {}; for (const k of Object.keys(d)) o[k] = dec(d[k], blob); return o;\n}\n/** grava `d` em `target[key]` preservando arrays tipados, instâncias (Voice, GTE...) e protótipos */\nfunction put(target, key, d, blob) {\n  const cur = target[key];\n  if (isTyped(d) && ArrayBuffer.isView(cur) && cur.constructor.name === d.$a && cur.length === d.len) {\n    const u = new Uint8Array(cur.buffer, cur.byteOffset, cur.byteLength); u.fill(0); u.set(blob.subarray(d.off, d.off + d.n)); return;\n  }\n  if (Array.isArray(d) && Array.isArray(cur) && cur.length === d.length && d.every(x => x && typeof x === 'object' && !Array.isArray(x) && !isTyped(x) && x.$n === undefined && !x.$u)) {\n    d.forEach((x, i) => apply(cur[i], x, blob)); return;\n  }\n  if (d && typeof d === 'object' && !Array.isArray(d) && !isTyped(d) && d.$n === undefined && !d.$u && cur && typeof cur === 'object' && !Array.isArray(cur) && !ArrayBuffer.isView(cur)) {\n    apply(cur, d, blob); return;\n  }\n  target[key] = dec(d, blob);\n}\nfunction apply(target, data, blob) { for (const k of Object.keys(data)) { if (!SKIP.has(k)) put(target, k, data[k], blob); } }\n\n/** Snapshot de um PSX → Uint8Array */\nfunction saveState(psx, meta = {}) {\n  const w = new Writer(), st = {};\n  for (const c of COMPONENTS) st[c] = enc(c === 'bus' ? pick(psx.bus, ['ram', 'scratch', 'io', 'istat', 'imask', 'cacheCtrl', 'gpuToggle']) : psx[c], w);\n  st.psx = enc(pick(psx, PSX_FIELDS), w);\n  st.sched = psx.sched.snapshot();\n  const head = new TextEncoder().encode(JSON.stringify({ version: STATE_VERSION, meta: { ...meta, savedAt: Date.now(), frames: psx.frames, cycles: psx.cpu.cycles }, st }));\n  const out = new Uint8Array(12 + head.length + w.size), dv = new DataView(out.buffer);\n  dv.setUint32(0, MAGIC, true); dv.setUint32(4, STATE_VERSION, true); dv.setUint32(8, head.length, true);\n  out.set(head, 12); let o = 12 + head.length; for (const b of w.bufs) { out.set(b, o); o += b.length; }\n  return out;\n}\nfunction pick(o, keys) { const r = {}; for (const k of keys) r[k] = o[k]; return r; }\n\n/** lê só o cabeçalho (meta) sem restaurar */\nfunction readStateMeta(bytes) { return parse(bytes).head.meta; }\nfunction parse(bytes) {\n  if (bytes.length < 12) throw new Error('arquivo de save state inválido');\n  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);\n  if (dv.getUint32(0, true) !== MAGIC) throw new Error('não é um save state do ps1emu');\n  const ver = dv.getUint32(4, true); if (ver !== STATE_VERSION) throw new Error(`versão de save state incompatível (${ver}, esperada ${STATE_VERSION})`);\n  const hl = dv.getUint32(8, true);\n  if (12 + hl > bytes.length) throw new Error('save state truncado');\n  return { head: JSON.parse(new TextDecoder().decode(bytes.subarray(12, 12 + hl))), blob: bytes.subarray(12 + hl) };\n}\n\n/** Restaura um snapshot no PSX (o mesmo disco/BIOS devem estar carregados). Devolve o meta. */\nfunction loadState(psx, bytes) {\n  const { head, blob } = parse(bytes), st = head.st;\n  for (const c of COMPONENTS) apply(psx[c], st[c], blob);\n  apply(psx, st.psx, blob);\n  if (!Number.isFinite(psx.timerAt)) psx.timerAt = psx.lastTick;           // estados antigos não tinham timerAt\n  psx.sched.restore(st.sched);\n  const cd = psx.cdrom;\n  cd.readEvt = psx.sched.find('cdrom', 'readSector') || psx.sched.find('cdrom', 'playSector');\n  if (cd.data && cd.data.length === 0) cd.data = null;\n  psx.jit.flush(); psx.bus.codeFlags.fill(0);\n  psx.audioLen = 0;\n  if (psx.gpu.hw) psx.gpu.hw.attach(psx.gpu);               // renderizador GL: reenvia a VRAM restaurada\n  return head.meta;\n}\n\n// ---- compressão (CompressionStream: navegadores modernos e Node ≥ 18) ----\nasync function pipe(u8, stream) { return new Uint8Array(await new Response(new Blob([u8]).stream().pipeThrough(stream)).arrayBuffer()); }\nconst gzip = u8 => pipe(u8, new CompressionStream('gzip'));\nconst gunzip = u8 => pipe(u8, new DecompressionStream('gzip'));\nconst isGzip = u8 => u8.length > 2 && u8[0] === 0x1F && u8[1] === 0x8B;\n\nreturn { STATE_VERSION, saveState, readStateMeta, loadState, gzip, gunzip, isGzip };\n})();\nconst __src_psx = (() => {\n// ============================================================================\n//  Máquina PS1: Bus + CPU + GPU + SPU + DMA + Timers + SIO0 (controle/memory card) + CD-ROM + MDEC\n//  Relógio central = cpu.cycles (1 ciclo por instrução). A cada 32 ciclos roda tick():\n//  timers, scanlines/VBLANK, eventos agendados (CD-ROM, SIO, DMA) e geração de áudio.\n// ============================================================================\nconst { Bus } = __src_bus;\nconst { CPU } = __src_cpu;\nconst { JIT } = __src_jit;\nconst { enableWasm, wasmAvailable } = __src_wasmcpu;\nconst { GPU } = __src_gpu;\nconst { SPU } = __src_spu;\nconst { DiscImage } = __src_disc;\nconst { Scheduler } = __src_scheduler;\nconst { Timers } = __src_timers;\nconst { DMA } = __src_dma;\nconst { SIO } = __src_sio;\nconst { CDROM } = __src_cdrom;\nconst { MemoryCard } = __src_memcard;\nconst { MDEC } = __src_mdec;\nconst { saveState, loadState } = __src_state;\nconst TICK = 32, TICK_MAX = +(globalThis.PS1_TICKMAX || (typeof process !== \"undefined\" && process.env && process.env.PS1_TICKMAX)) || 2000, SPU_PERIOD = 768;   // tick adaptativo: curto só quando algo está para acontecer (evento, borda de linha)\n           // 33.8688MHz / 44100Hz = 768\nconst REGIONS = { A: 'SCEA', E: 'SCEE', J: 'SCEI' };\n\nclass PSX {\n  constructor() {\n    this.bus = new Bus();\n    this.cpu = new CPU(this.bus);\n    this.jit = new JIT(this.cpu, this.bus); this.jit.H.ps = this; this.useJit = true;      // recompilador dinâmico (desligue com psx.useJit = false)\n    this.gpu = new GPU();\n    this.spu = new SPU();\n    this.sched = new Scheduler();\n    this.sys = { bus: this.bus, sched: this.sched, now: () => this.cpu.cycles, irq: n => this.bus.raiseIrq(n), syncTimers: () => this.syncTimers(), retime: () => this.retime() };\n    this.sched.onEarly = t => { if (t < this.nextTick) this.nextTick = t; };\n    this.timers = new Timers(this.sys);\n    this.dma = new DMA(this.sys);\n    this.sio = new SIO(this.sys);\n    this.cdrom = new CDROM(this.sys);\n    this.mdec = new MDEC();\n    this.dma.dev = { gpu: this.gpu, spu: this.spu, cdrom: this.cdrom, mdec: this.mdec };\n    this.mdec.onOutput = () => this.dma.mdecOutReady();\n    this.cdrom.spu = this.spu; this.gpu.clock = () => this.cpu.cycles; this.bus.psx = this;\n    for (const [k, o] of [['cdrom', this.cdrom], ['dma', this.dma], ['sio', this.sio]]) this.sched.register(k, o);\n    Object.assign(this.bus, { gpu: this.gpu, spu: this.spu, dma: this.dma, timers: this.timers, sio: this.sio, cdrom: this.cdrom, mdec: this.mdec });\n    this.spu.onIrq = () => this.bus.raiseIrq(9);\n    this.gpu.onIrq = () => this.bus.raiseIrq(1);\n\n    this.disc = null;\n    this.onTTY = null; this.onTrace = null; this.hookTTY = true; this.postCodes = [];\n    this.bus.onPost = c => this.postCodes.push(c);\n    this.audio = new Int16Array(16384 * 2); this.audioLen = 0;\n    this.resetTiming();\n    if ((globalThis.PS1_WASM || (typeof process !== \"undefined\" && process.env && process.env.PS1_WASM)) && wasmAvailable()) this.enableWasm();\n  }\n\n  /** troca a CPU pelo núcleo WebAssembly (wasm/cpu.c); true se ativou */\n  enableWasm() { try { enableWasm(this); return true; } catch (e) { return false; } }\n\n  resetTiming() {\n    this.lastTick = this.timerAt = this.cpu.cycles; this.nextTick = this.cpu.cycles + TICK;\n    this.lineAcc = 0; this.line = 0; this.audioAcc = 0; this.frameDone = false; this.frames = 0;\n  }\n\n  loadBios(bytes) {\n    this.bus.loadBios(bytes);\n    const info = this.biosInfo();\n    this.cdrom.regionOverride = REGIONS[info.trim().slice(-1)] || 'SCEA';   // GetID devolve a região da BIOS (pula a trava regional)\n    return info;\n  }\n  // versão da BIOS: texto em 0x7FF32\n  biosInfo() {\n    const b = this.bus.bios; let s = '';\n    for (let i = 0x7FF32; i < 0x7FF60 && b[i]; i++) s += String.fromCharCode(b[i]);\n    return s;\n  }\n  /** Insere um cartão (bytes de .mcr/.mcd/VGS/DexDrive) no slot 0 ou 1; sem bytes, cria um cartão em branco. */\n  loadMemoryCard(slot, bytes) {\n    const card = new MemoryCard(bytes); this.sio.cards[slot] = card;\n    return { slot, saves: card.listSaves(), livres: card.freeBlocks() };\n  }\n  ejectMemoryCard(slot) { this.sio.cards[slot] = null; }\n\n  loadDisc(bytes) { this.disc = new DiscImage(bytes); this.cdrom.setDisc(this.disc); return this.disc.info(); }\n\n  /** carrega .cue + arquivos de trilha ({ 'nome.bin': Uint8Array, ... }) */\n  loadCue(cueText, files) { this.disc = DiscImage.fromCue(cueText, files); this.cdrom.setDisc(this.disc); return this.disc.info(); }\n  /** troca de disco em execução: abre a tampa; fechar com closeDiscLid(disc) */\n  openDiscLid() { this.cdrom.openLid(); }\n  closeDiscLid(disc) { this.disc = disc; this.cdrom.closeLid(disc); }\n\n  reset() {\n    this.cpu.reset(); this.gpu.reset(); this.timers.reset(); this.dma.reset(); this.sio.reset(); this.cdrom.reset(); this.mdec.reset();\n    this.cdrom.setDisc(this.disc); this.jit.flush(); this.sched.clear(); this.bus.istat = 0; this.bus.imask = 0;\n    this.postCodes.length = 0; this.audioLen = 0; this.resetTiming();\n  }\n\n  // ---------------- save states ----------------\n  /** estado completo (Uint8Array); chamar entre quadros/instruções, nunca dentro de um bloco do JIT */\n  saveState(meta = {}) { return saveState(this, { disc: this.disc ? this.disc.info().volume || '' : '', ...meta }); }\n  loadState(bytes) { return loadState(this, bytes); }\n\n  // ---------------- TTY da BIOS (A0/B0: putchar/puts) ----------------\n  tty() {\n    const cpu = this.cpu, r = cpu.r, pc = cpu.pc & 0x1FFFFFFF;\n    if (pc !== 0xA0 && pc !== 0xB0) return;\n    const fn = r[9];\n    if ((pc === 0xA0 && fn === 0x3C) || (pc === 0xB0 && fn === 0x3D)) this.onTTY?.(String.fromCharCode(r[4] & 0xFF));\n    else if ((pc === 0xA0 && fn === 0x3E) || (pc === 0xB0 && fn === 0x3F)) {\n      let a = r[4], s = '';\n      for (let i = 0; i < 1024; i++) { const c = this.bus.read8(a++); if (!c) break; s += String.fromCharCode(c); }\n      this.onTTY?.(s);\n    }\n  }\n\n  /** liga/desliga o atalho para laços de espera (leitura repetida de status/contador); desligado por padrão */\n  get pollSkip() { return this.bus.pollOn; }\n  set pollSkip(v) { this.bus.pollOn = !!v; }\n\n  // ---------------- tempo ----------------\n  tick() {\n    const now = this.cpu.cycles, dt = now - this.lastTick; this.lastTick = now;\n    const gpu = this.gpu;\n    this.timers.dotDiv = gpu.dotDiv;\n    {   // blank horizontal/vertical (início do tick): fora da faixa ativa [hx1, hx2] da linha = hblank; linhas >= vb = vblank\n      const k = (gpu.pal ? 2157.2 / 3406 : 2146.3 / 3413), x = this.lineAcc;\n      this.timers.setBlank(x < gpu.hx1 * k || x >= gpu.hx2 * k, this.line >= (gpu.pal ? 256 : 240));\n    }\n    this.timers.advance(now - this.timerAt); this.timerAt = now;\n\n    // linhas de vídeo: NTSC 263 x ~2146 ciclos, PAL 314 x ~2157\n    const lc = gpu.pal ? 2157.2 : 2146.3, lines = gpu.pal ? 314 : 263, vb = gpu.pal ? 256 : 240;\n    this.lineAcc += dt;\n    while (this.lineAcc >= lc) {\n      this.lineAcc -= lc; this.line++; gpu.line = this.line; this.timers.hblank();\n      if (this.line === vb) { gpu.vblank = true; gpu.toggleField(); this.bus.raiseIrq(0); }   // o campo entrelaçado muda no início do vblank (os desenhos do jogo depois do IRQ vão todos para o mesmo campo)          // IRQ0 = VBLANK\n      if (this.line >= lines) { this.line = 0; gpu.line = 0; gpu.vblank = false; gpu.captureField(); this.frameDone = true; this.frames++; }\n    }\n\n    this.sched.run(now);\n\n    this.audioAcc += dt;                                                           // 1 amostra a cada 768 ciclos\n    while (this.audioAcc >= SPU_PERIOD) {\n      this.audioAcc -= SPU_PERIOD; const [l, r] = this.spu.tick();\n      if (this.audioLen < 16384) { this.audio[this.audioLen * 2] = l; this.audio[this.audioLen * 2 + 1] = r; this.audioLen++; }\n    }\n    // próximo tick: no máximo TICK_MAX ciclos, antes se houver evento agendado ou fim de linha de vídeo\n    let nt = now + TICK_MAX; const ev = this.sched.next; if (ev < nt) nt = ev;\n    const ln = now + (lc - this.lineAcc); if (ln < nt) nt = ln;\n    if (TICK_MAX > 128) {                                                          // tick longo: limita pelas bordas de hblank dentro da linha e pelo próximo IRQ de timer\n      const k = gpu.pal ? 2157.2 / 3406 : 2146.3 / 3413, x = this.lineAcc, e1 = gpu.hx1 * k, e2 = gpu.hx2 * k;\n      if (e1 > x && now + (e1 - x) < nt) nt = now + (e1 - x); if (e2 > x && now + (e2 - x) < nt) nt = now + (e2 - x);\n      const te = now + this.timers.nextEvent(); if (te < nt) nt = te;\n    }\n    this.nextTick = nt > now ? nt : now + 1;\n  }\n  /** um registrador de timer mudou: o próximo tick pode ter que vir antes */\n  retime() { if (TICK_MAX > 128) { const te = this.cpu.cycles + this.timers.nextEvent(); if (te < this.nextTick) this.nextTick = te; } }\n  /** contadores exatos numa leitura/escrita de registrador (sem rodar eventos) */\n  syncTimers() { const now = this.cpu.cycles; if (now > this.timerAt) { this.timers.advance(now - this.timerAt); this.timerAt = now; } }\n  takeAudio() { const o = this.audio.slice(0, this.audioLen * 2); this.audioLen = 0; return o; }\n\n  step() {\n    if (this.wasm && !this.onTrace) {                   // 1 passo = 1 instrução no núcleo wasm\n      if (this.hookTTY) this.tty();\n      const w = this.wasm, nt = this.nextTick; w.S[9] = 1; this.nextTick = this.cpu.cycles + 1; w.run(); this.nextTick = nt; w.S[9] = 0;\n      if (this.cpu.cycles >= nt) this.tick();\n      return;\n    }\n    if (this.useJit && !this.onTrace) {                 // 1 \"passo\" = 1 bloco recompilado\n      if (this.hookTTY) this.tty();\n      this.jit.exec();\n      if (this.cpu.cycles >= this.nextTick) this.tick();\n      return;\n    }\n    if (this.onTrace) this.onTrace(this.cpu.pc, this.bus.read32(this.cpu.pc));\n    if (this.hookTTY) this.tty();\n    this.cpu.step();\n    if (this.cpu.cycles >= this.nextTick) this.tick();\n  }\n  run(n) { for (let i = 0; i < n; i++) this.step(); }\n  /** roda pelo menos n instruções (conta instruções, não passos) */\n  runInstr(n) { const end = this.cpu.instrCount + n; while (this.cpu.instrCount < end) this.step(); }\n\n  /** Roda até o fim do quadro de vídeo atual; devolve o áudio (Int16 estéreo) gerado nesse tempo. */\n  runFrame() {\n    this.frameDone = false;\n    if (this.wasm && !this.onTrace) {                    // CPU em WebAssembly: roda até o tick; A0/B0 voltam ao JS (TTY da BIOS)\n      const w = this.wasm;\n      while (!this.frameDone) { if (w.run() === 1) { this.tty(); w.skipHook(); } else this.tick(); }\n    } else if (this.useJit && !this.onTrace) { while (!this.frameDone) { this.jit.runBlocks(this); this.tick(); } }\n    else for (let g = 0; !this.frameDone && g < 4_000_000; g++) this.step();\n    return this.takeAudio();\n  }\n\n  // ---------------- boot ----------------\n  /**\n   * Sideload: roda a BIOS SEM disco até o shell (0x80030000) e depois carrega o EXE do disco.\n   * Alternativa ao boot normal (a região já é \"spoofada\", então o boot normal costuma funcionar).\n   */\n  bootToShell(maxSteps = 80_000_000) {\n    const disc = this.disc; this.cdrom.setDisc(null);\n    let ok = false;\n    for (let i = 0; i < maxSteps; i++) { if ((this.cpu.pc & 0x1FFFFFFF) === 0x30000) { ok = true; break; } this.step(); }\n    this.cdrom.setDisc(disc);\n    return ok;\n  }\n  sideload(exe) {\n    const cpu = this.cpu;\n    this.bus.ram.set(exe.data, exe.textAddr & 0x1FFFFF); this.jit.flush();\n    const sp = exe.sp || exe.stack || 0x801FFF00;\n    cpu.r[28] = exe.gp; cpu.r[29] = sp; cpu.r[30] = sp;\n    cpu.pc = exe.pc; cpu.nextPc = (exe.pc + 4) >>> 0; cpu.isBranch = false;\n    cpu.cop0[12] = 0x40000401;      // CU2 on, IM2 on, IEc on, modo kernel, BEV=0\n  }\n  bootDiscExe() {\n    if (!this.disc) throw new Error('nenhum disco carregado');\n    const exe = this.disc.loadBootExe(); this.sideload(exe); return exe;\n  }\n}\n\nreturn { PSX };\n})();\nconst __src_input = (() => {\n// ============================================================================\n//  Entrada: teclado + Gamepad API -> controles do PSX (digital ou DualShock), remapeamento e vibração.\n//  Sem dependência do DOM: recebe eventos/listas de gamepads (testável em Node).\n// ============================================================================\nconst { BUTTONS } = __src_sio;\nconst DEFAULT_KEYS = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', KeyZ: 'cross', KeyX: 'circle', KeyA: 'square',\n  KeyS: 'triangle', KeyQ: 'l1', KeyW: 'r1', KeyE: 'l2', KeyR: 'r2', KeyD: 'l3', KeyC: 'r3', Enter: 'start', ShiftRight: 'select', Backspace: 'select' };\n/** layout \"standard\" do Gamepad API (índice do botão -> botão do PSX) */\nconst DEFAULT_PAD = { 0: 'cross', 1: 'circle', 2: 'square', 3: 'triangle', 4: 'l1', 5: 'r1', 6: 'l2', 7: 'r2', 8: 'select', 9: 'start', 10: 'l3', 11: 'r3',\n  12: 'up', 13: 'down', 14: 'left', 15: 'right' };\nconst DEFAULT_HOTKEYS = { KeyP: 'pause', F5: 'save', F7: 'load', F11: 'fullscreen', F9: 'analog', KeyT: 'turbo' };\nconst ACTIONS = ['pause', 'save', 'load', 'fullscreen', 'analog', 'turbo'];\nconst ANALOG_BTN = 16;                                           // botão \"home/guide\" alterna o modo analógico\n\nclass InputManager {\n  constructor(psx) {\n    this.psx = psx; this.keys = { ...DEFAULT_KEYS }; this.padMap = { ...DEFAULT_PAD }; this.hotkeys = { ...DEFAULT_HOTKEYS };\n    this.deadzone = 0.2; this.rumbleOn = true; this.onHotkey = null; this.getPads = null;   // getPads: () => lista de gamepads\n    this.kb = new Set(); this.virt = new Set(); this.gp = [new Set(), new Set()]; this.stickDpad = [new Set(), new Set()];\n    this.assigned = [-1, -1]; this.prevHome = [false, false]; this.lastRumble = [null, null];\n    psx.sio.onRumble = (port, small, large) => this.rumble(port, small, large);\n  }\n\n  // ---- teclado ----\n  /** evento de teclado (code = KeyboardEvent.code); acompanha as teclas físicas para suportar 2 teclas no mesmo botão. true = tecla consumida */\n  keyEvent(code, down) {\n    const act = this.hotkeys[code]; if (act) { if (down && this.onHotkey) this.onHotkey(act); return true; }\n    const b = this.keys[code]; if (!b) return false;\n    this.held ??= new Set(); if (down) this.held.add(code); else this.held.delete(code);\n    this.kb = new Set([...this.held].map(c => this.keys[c]).filter(Boolean)); this.apply(0); return true;\n  }\n  /** controle virtual (toque): conjunto de botões pressionados na porta 1 */\n  setVirtual(names) { this.virt = new Set(names); this.apply(0); }\n  /** analógico virtual: x,y em -1..1 (y positivo = para baixo); side = 'l' | 'r' */\n  setVirtualStick(side, x, y) { const s = this.psx.sio; s.setStick(side + 'x', 0x80 + x * 127, 0); s.setStick(side + 'y', 0x80 + y * 127, 0); }\n  releaseAll() { this.held = new Set(); this.kb = new Set(); this.virt = new Set(); this.gp = [new Set(), new Set()]; this.stickDpad = [new Set(), new Set()]; this.apply(0); this.apply(1); }\n\n  // ---- remapeamento ----\n  bindKey(button, code) {\n    if (!(button in BUTTONS)) throw new Error('botão desconhecido ' + button);\n    delete this.hotkeys[code]; this.keys[code] = button;\n  }\n  unbindKey(code) { delete this.keys[code]; }\n  bindHotkey(action, code) { if (!ACTIONS.includes(action)) throw new Error('ação desconhecida'); for (const c of Object.keys(this.hotkeys)) if (this.hotkeys[c] === action) delete this.hotkeys[c]; delete this.keys[code]; this.hotkeys[code] = action; }\n  bindPad(button, index) { for (const i of Object.keys(this.padMap)) if (this.padMap[i] === button) delete this.padMap[i]; this.padMap[index] = button; }\n  resetBindings() { this.keys = { ...DEFAULT_KEYS }; this.padMap = { ...DEFAULT_PAD }; this.hotkeys = { ...DEFAULT_HOTKEYS }; }\n  exportConfig() { return JSON.stringify({ keys: this.keys, pad: this.padMap, hotkeys: this.hotkeys, deadzone: this.deadzone, rumble: this.rumbleOn }); }\n  importConfig(text) {\n    const c = JSON.parse(text), ok = o => o && typeof o === 'object';\n    if (ok(c.keys)) this.keys = Object.fromEntries(Object.entries(c.keys).filter(([, b]) => b in BUTTONS));\n    if (ok(c.pad)) this.padMap = Object.fromEntries(Object.entries(c.pad).filter(([, b]) => b in BUTTONS));\n    if (ok(c.hotkeys)) this.hotkeys = Object.fromEntries(Object.entries(c.hotkeys).filter(([, a]) => ACTIONS.includes(a)));\n    if (typeof c.deadzone === 'number') this.deadzone = Math.max(0, Math.min(0.9, c.deadzone));\n    if (typeof c.rumble === 'boolean') this.rumbleOn = c.rumble;\n  }\n\n  // ---- gamepads (chamar 1x por quadro) ----\n  poll() {\n    const list = (this.getPads ? this.getPads() : []) || [];\n    const pads = [...list].filter(g => g && g.connected);\n    // associa o 1º gamepad à porta 1 e o 2º à porta 2 (mantém a ordem de conexão)\n    this.assigned = [0, 1].map(p => pads[p] ? pads[p].index : -1);\n    for (let port = 0; port < 2; port++) {\n      const g = pads[port]; const sio = this.psx.sio;\n      if (!g) { if (this.gp[port].size || this.stickDpad[port].size) { this.gp[port].clear(); this.stickDpad[port].clear(); this.apply(port); this.centerSticks(port); } continue; }\n      if (port === 1) sio.padConnected[1] = true;\n      const pressed = new Set();\n      for (const [i, name] of Object.entries(this.padMap)) { const b = g.buttons[i]; if (b && (b.pressed || b.value > 0.5)) pressed.add(name); }\n      const ax = k => { const v = g.axes[k] || 0; return Math.abs(v) < this.deadzone ? 0 : v; }, lx = ax(0), ly = ax(1), rx = ax(2), ry = ax(3);\n      const dual = sio.padType[port] === 'dualshock', ds = new Set();\n      if (dual) {\n        const to8 = v => 0x80 + Math.round(v * 127.5);\n        sio.setStick('lx', to8(lx), port); sio.setStick('ly', to8(ly), port); sio.setStick('rx', to8(rx), port); sio.setStick('ry', to8(ry), port);\n      } else {                                                         // controle digital: o analógico esquerdo vira direcional\n        if (lx < -0.5) ds.add('left'); if (lx > 0.5) ds.add('right'); if (ly < -0.5) ds.add('up'); if (ly > 0.5) ds.add('down');\n      }\n      this.gp[port] = pressed; this.stickDpad[port] = ds;\n      const home = !!(g.buttons[ANALOG_BTN] && g.buttons[ANALOG_BTN].pressed);\n      if (home && !this.prevHome[port]) sio.toggleAnalog(port);\n      this.prevHome[port] = home;\n      this.apply(port);\n    }\n  }\n  centerSticks(port) { for (const k of ['lx', 'ly', 'rx', 'ry']) this.psx.sio.setStick(k, 0x80, port); }\n  /** combina todas as fontes (teclado só na porta 1) e escreve no SIO */\n  apply(port) {\n    const sio = this.psx.sio, want = new Set([...this.gp[port], ...this.stickDpad[port], ...(port === 0 ? this.kb : []), ...(port === 0 ? this.virt : [])]);\n    for (const name of Object.keys(BUTTONS)) sio.setButton(name, want.has(name), port);\n  }\n\n  // ---- vibração ----\n  rumble(port, small, large) {\n    this.lastRumble[port] = [small, large];\n    if (!this.rumbleOn || !this.getPads) return;\n    const g = [...(this.getPads() || [])].filter(x => x && x.connected)[port], act = g && g.vibrationActuator;\n    if (!act) return;\n    try {\n      if (!small && !large) { act.reset?.(); return; }\n      act.playEffect?.('dual-rumble', { startDelay: 0, duration: 1000, weakMagnitude: small ? 1 : 0, strongMagnitude: large / 255 });\n    } catch { /* navegador sem suporte: ignora */ }\n  }\n}\n\nreturn { DEFAULT_KEYS, DEFAULT_PAD, DEFAULT_HOTKEYS, ACTIONS, InputManager };\n})();\nconst __src_debug = (() => {\n// ============================================================================\n//  Depurador / tracer: registradores, desmontagem, passo a passo, breakpoints, trace e relatório de falha.\n//  Breakpoints e trace usam o interpretador (JIT desligado enquanto estiverem ativos): ficam mais lentos.\n// ============================================================================\nconst { disasm } = __src_disasm;\nconst hex = (v, n = 8) => (v >>> 0).toString(16).padStart(n, '0');\nconst RN = ['zr', 'at', 'v0', 'v1', 'a0', 'a1', 'a2', 'a3', 't0', 't1', 't2', 't3', 't4', 't5', 't6', 't7',\n            's0', 's1', 's2', 's3', 's4', 's5', 's6', 's7', 't8', 't9', 'k0', 'k1', 'gp', 'sp', 'fp', 'ra'];\n\n// só lê memória sem efeito colateral (RAM, scratchpad, BIOS); registradores de I/O não são tocados\nconst safe = a => { const p = a & 0x1FFFFFFF; return p < 0x800000 || (p >= 0x1FC00000 && p < 0x1FC80000) || (p >= 0x1F800000 && p < 0x1F800400); };\n\nclass Debugger {\n  rd32(a) { return safe(a) ? this.psx.bus.read32(a & ~3) : 0; }\n  rd8(a) { return safe(a) ? this.psx.bus.read8(a) : 0; }\n  constructor(psx) { this.psx = psx; this.breaks = new Set(); this.ring = null; this.ringPos = 0; this.ringN = 0; }\n\n  /** registradores em texto (4 por linha) */\n  regs() {\n    const c = this.psx.cpu; let s = `pc=${hex(c.pc)}  hi=${hex(c.hi)}  lo=${hex(c.lo)}  ciclos=${c.cycles}  SR=${hex(c.cop0[12])}  CAUSE=${hex(c.cop0[13])}  EPC=${hex(c.cop0[14])}\\n`;\n    for (let i = 0; i < 32; i += 4) s += [0, 1, 2, 3].map(k => `${RN[i + k].padEnd(2)}=${hex(c.r[i + k])}`).join('  ') + '\\n';\n    return s;\n  }\n  /** `before`/`after` instruções ao redor de `pc` (marca a atual com \">\") */\n  listing(pc = this.psx.cpu.pc, before = 4, after = 8) {\n    const out = [], cur = this.psx.cpu.pc;\n    for (let i = -before; i <= after; i++) {\n      const a = (pc + i * 4) >>> 0; let w = 0, txt;\n      try { w = this.rd32(a); txt = disasm(w, a); } catch { txt = '??'; }\n      out.push(`${a === cur ? '>' : ' '} ${hex(a)}: ${hex(w)}  ${txt}`);\n    }\n    return out.join('\\n');\n  }\n  /** dump hexadecimal de `len` bytes */\n  dump(addr, len = 64) {\n    let s = '';\n    for (let o = 0; o < len; o += 16) {\n      const bytes = []; for (let i = 0; i < 16 && o + i < len; i++) { bytes.push(this.rd8((addr + o + i) >>> 0)); }\n      s += `${hex(addr + o)}: ${bytes.map(b => hex(b, 2)).join(' ').padEnd(47)}  ${bytes.map(b => b >= 32 && b < 127 ? String.fromCharCode(b) : '.').join('')}\\n`;\n    }\n    return s;\n  }\n\n  // ---- trace (anel com os últimos N PCs) ----\n  startTrace(n = 256) { this.ring = new Uint32Array(n); this.ringPos = 0; this.ringN = 0; this.hook(); }\n  stopTrace() { this.ring = null; this.hook(); }\n  hook() {\n    const need = this.ring || this.breaks.size;\n    this.psx.onTrace = need ? (pc => { if (this.ring) { this.ring[this.ringPos] = pc; this.ringPos = (this.ringPos + 1) % this.ring.length; if (this.ringN < this.ring.length) this.ringN++; } }) : null;\n  }\n  /** últimas instruções executadas, da mais antiga para a mais recente */\n  traceText() {\n    if (!this.ring) return '(trace desligado)';\n    const n = this.ringN, out = [];\n    for (let i = 0; i < n; i++) {\n      const a = this.ring[(this.ringPos - n + i + this.ring.length * 2) % this.ring.length]; let w = 0, t;\n      try { w = this.rd32(a); t = disasm(w, a); } catch { t = '??'; }\n      out.push(`${hex(a)}: ${hex(w)}  ${t}`);\n    }\n    return out.join('\\n');\n  }\n\n  // ---- execução controlada ----\n  addBreak(pc) { this.breaks.add(pc >>> 0); this.hook(); }\n  delBreak(pc) { this.breaks.delete(pc >>> 0); this.hook(); }\n  /** executa exatamente 1 instrução no interpretador */\n  stepInstr() {\n    const p = this.psx, prev = p.onTrace; if (!prev) p.onTrace = () => { };\n    const n = p.cpu.instrCount; try { for (let g = 0; p.cpu.instrCount === n && g < 8; g++) p.step(); } finally { if (!prev) p.onTrace = null; }\n  }\n  /** roda até um breakpoint (ou `max` instruções). Devolve o PC do breakpoint atingido ou null */\n  run(max = 5_000_000) {\n    const p = this.psx, c = p.cpu; this.hook(); if (!p.onTrace) p.onTrace = () => { };\n    const end = c.instrCount + max; let hit = null;\n    try {\n      while (c.instrCount < end) {\n        p.step(); if (this.breaks.has(c.pc >>> 0)) { hit = c.pc >>> 0; break; }\n      }\n    } finally { this.hook(); }\n    return hit;\n  }\n\n  /** texto para diagnóstico quando algo dá errado (exceção do emulador, travamento...) */\n  report(err) {\n    const p = this.psx, cd = p.cdrom;\n    return [`== Relatório do ps1emu ==`, err ? `Erro: ${err.stack || err.message || err}` : 'Sem erro (snapshot manual)',\n      `quadros=${p.frames} ciclos=${p.cpu.cycles} jit=${p.useJit}`, `IRQ: istat=${hex(p.bus.istat)} imask=${hex(p.bus.imask)}`,\n      `CD: lendo=${cd.reading} tocando=${cd.playing} pos=${cd.pos} intFlag=${cd.intFlag} modo=${hex(cd.mode, 2)}`,\n      `GPU: ${p.gpu.width}x${p.gpu.height} display=${p.gpu.dispOn} dma=${p.gpu.dmaDir}`,\n      '', this.regs(), this.listing(p.cpu.pc, 6, 6), '', this.ring ? 'Últimas instruções:\\n' + this.traceText() : ''].join('\\n');\n  }\n}\n\nreturn { Debugger };\n})();\nconst __src_glgpu = (() => {\n// ============================================================================\n//  Renderizador WebGL2 da GPU do PS1 com resolução interna escalável (1x..8x)\n// ============================================================================\n//  Modelo de dados:\n//   H  = VRAM em alta resolução (textura RGBA8 de 1024*S x 512*S, + stencil). É a fonte da verdade:\n//        rgb = cor RGB555 expandida, alpha = bit de máscara (bit 15), stencil = espelho do bit de máscara.\n//   N  = VRAM nativa (gpu.vram, Uint16Array 1024x512) + textura R16UI usada para buscar texels\n//        4/8/15 bits e CLUTs nos shaders. É um CACHE de H: só é atualizada quando a CPU escreve na VRAM\n//        (uploads) ou quando algo precisa ler uma região que a GPU desenhou (\"tiles sujos\" de 16x16).\n//  Com o renderizador ativo o rasterizador por software NÃO roda (gpu.hw != null).\n//\n//  Fidelidade: coordenadas de vértice somam +0.5 pixel (o PS1 amostra em inteiros), texels via\n//  texelFetch (nearest), dither por pixel nativo, semi-transparência com os 4 modos (blend de hardware;\n//  texels semi/opacos em 2 passes), máscara (set/check) via stencil, janela de textura, área de desenho\n//  por scissor, cópias VRAM->VRAM na GPU, leitura de VRAM por readPixels + reamostragem.\n// ============================================================================\n\nconst VW = 1024, VH = 512, TILE = 16, TX = VW / TILE, TY = VH / TILE;\nconst STRIDE_W = 19;                                   // palavras por vértice (7 floats + 12 ints)\nconst MAX_VERTS = 6 * 8192;\n\nconst VS_PRIM = `#version 300 es\nlayout(location=0) in vec2 a_pos; layout(location=1) in vec3 a_col; layout(location=2) in vec2 a_uv;\nlayout(location=3) in ivec4 a_tex; layout(location=4) in ivec4 a_flg; layout(location=5) in ivec4 a_tw;\nout vec3 v_col; out vec2 v_uv; flat out ivec4 v_tex; flat out ivec4 v_flg; flat out ivec4 v_tw;\nvoid main(){\n  gl_Position = vec4(a_pos.x/512.0-1.0, a_pos.y/256.0-1.0, 0.0, 1.0);\n  v_col=a_col; v_uv=a_uv; v_tex=a_tex; v_flg=a_flg; v_tw=a_tw;\n}`;\n\nconst FS_PRIM = `#version 300 es\nprecision highp float; precision highp int; precision highp usampler2D;\nuniform usampler2D u_vram; uniform float u_scale; uniform int u_pass; uniform int u_setMask; uniform int u_rowMask;\nin vec3 v_col; in vec2 v_uv; flat in ivec4 v_tex; flat in ivec4 v_flg; flat in ivec4 v_tw;\nout vec4 o_color;\nconst int DITHER[16] = int[16](-4,0,-3,1, 2,-2,3,-1, -3,1,-4,0, 3,-1,2,-2);\nint vramAt(ivec2 p){ return int(texelFetch(u_vram, ivec2(p.x & 1023, p.y & 511), 0).r); }\nvoid main(){\n  if (u_rowMask >= 0 && (int(floor(gl_FragCoord.y / u_scale)) & 1) == u_rowMask) discard;   // 480i: não desenha as linhas do campo exibido\n  ivec3 c = ivec3(floor(v_col + 0.002));\n  bool textured = v_flg.x < 3;\n  bool semiTexel = false;\n  if (textured) {\n    ivec2 uv = ivec2(floor(v_uv + vec2(0.0002)));\n    int u = uv.x & 255, v = uv.y & 255;\n    u = (u & ~(v_tw.x << 3)) | ((v_tw.z & v_tw.x) << 3);\n    v = (v & ~(v_tw.y << 3)) | ((v_tw.w & v_tw.y) << 3);\n    int depth = v_flg.x, texel;\n    if (depth == 0) {\n      int w = vramAt(ivec2(v_tex.x + (u >> 2), v_tex.y + v));\n      texel = vramAt(ivec2(v_tex.z + ((w >> ((u & 3) * 4)) & 15), v_tex.w));\n    } else if (depth == 1) {\n      int w = vramAt(ivec2(v_tex.x + (u >> 1), v_tex.y + v));\n      texel = vramAt(ivec2(v_tex.z + ((w >> ((u & 1) * 8)) & 255), v_tex.w));\n    } else {\n      texel = vramAt(ivec2(v_tex.x + u, v_tex.y + v));\n    }\n    if (texel == 0) discard;\n    semiTexel = (texel & 0x8000) != 0;\n    ivec3 t = ivec3(texel & 31, (texel >> 5) & 31, (texel >> 10) & 31);\n    if (v_flg.y != 0) c = t * 8; else c = (t * c) >> 4;\n  }\n  if (u_pass == 1) { if (!textured || semiTexel) discard; }\n  else if (u_pass == 2) { if (textured && !semiTexel) discard; }\n  if (v_flg.z != 0) {\n    ivec2 np = ivec2(floor(gl_FragCoord.xy / u_scale));\n    c += DITHER[((np.y & 3) << 2) | (np.x & 3)];\n  }\n  c = clamp(c, 0, 255) >> 3;\n  o_color = vec4(vec3(c) / 31.0, float(u_setMask));\n}`;\n\nconst VS_QUAD = `#version 300 es\nlayout(location=0) in vec2 a_pos; layout(location=1) in vec2 a_uv; out vec2 v_uv;\nuniform int u_ndc;   // 1: a_pos já está em NDC (apresentação); 0: coordenadas nativas da VRAM\nvoid main(){\n  gl_Position = (u_ndc == 1) ? vec4(a_pos, 0.0, 1.0) : vec4(a_pos.x/512.0-1.0, a_pos.y/256.0-1.0, 0.0, 1.0);\n  v_uv = a_uv;\n}`;\n\nconst FS_BLIT_NATIVE = `#version 300 es\nprecision highp float; precision highp int; precision highp usampler2D;\nuniform usampler2D u_src; uniform float u_scale; uniform int u_pass;\nout vec4 o_color;\nvoid main(){\n  ivec2 p = ivec2(floor(gl_FragCoord.xy / u_scale)) & ivec2(1023, 511);\n  uint w = texelFetch(u_src, p, 0).r;\n  int bit = int((w >> 15u) & 1u);\n  if (bit != u_pass) discard;\n  o_color = vec4(vec3(ivec3(int(w & 31u), int((w >> 5u) & 31u), int((w >> 10u) & 31u))) / 31.0, float(bit));\n}`;\n\nconst FS_BLIT_RGBA = `#version 300 es\nprecision highp float; precision highp int;\nuniform sampler2D u_src; uniform ivec2 u_delta; uniform int u_pass; uniform int u_setMask;\nout vec4 o_color;\nvoid main(){\n  vec4 t = texelFetch(u_src, ivec2(gl_FragCoord.xy) + u_delta, 0);\n  int bit = (t.a > 0.5 || u_setMask != 0) ? 1 : 0;\n  if (bit != u_pass) discard;\n  o_color = vec4(t.rgb, float(bit));\n}`;\n\nconst FS_PRESENT = `#version 300 es\nprecision highp float;\nuniform sampler2D u_tex; in vec2 v_uv; out vec4 o_color;\nvoid main(){ o_color = vec4(texture(u_tex, v_uv).rgb, 1.0); }`;\n\nconst FS_FILL = `#version 300 es\nprecision highp float;\nuniform vec4 u_col; uniform float u_scale; uniform int u_row; out vec4 o_color;\nvoid main(){ if ((int(floor(gl_FragCoord.y / u_scale)) & 1) == u_row) discard; o_color = u_col; }`;\n\nconst FS_FIELD = `#version 300 es\nprecision highp float;\nuniform sampler2D u_src; uniform sampler2D u_prev; uniform float u_scale; uniform int u_par; uniform float u_mt; out vec4 o_color;\nvoid main(){\n  if ((int(floor(gl_FragCoord.y / u_scale)) & 1) != u_par) discard;\n  ivec2 p = ivec2(gl_FragCoord.xy); vec3 n = texelFetch(u_src, p, 0).rgb, o = texelFetch(u_prev, p, 0).rgb; vec3 d = abs(n - o);\n  o_color = vec4(n, max(d.r, max(d.g, d.b)) > u_mt ? 1.0 : 0.0);          // alfa = movimento em relação ao mesmo campo de 2 quadros atrás\n}`;\n\n// apresentação em 480i com desentrelaçamento: linhas do campo antigo viram a média das vizinhas (campo atual) onde houver movimento (adaptativo) ou sempre (modo 2)\nconst FS_DEINT = `#version 300 es\nprecision highp float;\nuniform sampler2D u_tex; uniform int u_par; uniform int u_mode; uniform float u_thr; uniform float u_dv; in vec2 v_uv; out vec4 o_color;\nvoid main(){\n  vec3 c = texture(u_tex, v_uv).rgb;\n  int line = int(floor(v_uv.y * 512.0));\n  if ((line & 1) != u_par) {\n    vec4 A = texture(u_tex, v_uv - vec2(0.0, u_dv)), B = texture(u_tex, v_uv + vec2(0.0, u_dv)); vec3 m = (A.rgb + B.rgb) * 0.5;\n    if (u_mode == 2 || max(A.a, B.a) > 0.5) c = m;                          // adaptativo: só onde o campo atual mudou em relação ao de 2 quadros atrás\n  }\n  o_color = vec4(c, 1.0);\n}`;\n\nconst DEINT_THR = 40;                                                     // diferença (0-255) acima da qual a linha do campo antigo é considerada \"em movimento\"\nconst Q5 = new Uint8Array(256); for (let i = 0; i < 256; i++) Q5[i] = Math.round(i * 31 / 255);\n\nclass GLRenderer {\n  /**\n   * @param canvas  <canvas> (será usado com contexto webgl2)\n   * @param scale   fator de resolução interna (1..8)\n   * @param opts    { smooth: true -> filtro linear quando a saída é reduzida }\n   */\n  constructor(canvas, scale = 2, opts = {}) {\n    const gl = this.gl = canvas.getContext('webgl2', { antialias: false, alpha: false, depth: false, stencil: false, preserveDrawingBuffer: !!opts.preserve, powerPreference: 'high-performance' });\n    if (!gl) throw new Error('WebGL2 indisponível neste navegador');\n    this.canvas = canvas; this.opts = opts; this.gpu = null;\n    const maxTex = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE), gl.getParameter(gl.MAX_RENDERBUFFER_SIZE));\n    let S = Math.max(1, Math.floor(scale)); while (S > 1 && VW * S > maxTex) S--;\n    this.scale = S; this.W = VW * S; this.H = VH * S;\n\n    this.initGL();\n    this.f32 = new Float32Array(MAX_VERTS * STRIDE_W); this.i32 = new Int32Array(this.f32.buffer);\n    this.n = 0; this.pc = new Int32Array(12);\n    this.batchKey = ''; this.batchKind = 0; this.batchSemi = 0;\n    this.pb = [1e9, 1e9, -1, -1];                              // bbox pendente (nativo) do lote ainda não desenhado\n    this.dirty = new Uint8Array(TX * TY);                      // tiles em que H é mais novo que N\n    this.rb = null; this.rgba = null;\n    this.outW = 0; this.outH = 0; this.dispKey = ''; this.texDisp = null; this.fboDisp = null;\n  }\n\n  // ------------------------------------------------------------------ GL setup\n  compile(vs, fs, bind) {\n    const gl = this.gl, mk = (t, s) => { const sh = gl.createShader(t); gl.shaderSource(sh, s); gl.compileShader(sh); if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error('shader: ' + gl.getShaderInfoLog(sh)); return sh; };\n    const p = gl.createProgram(); gl.attachShader(p, mk(gl.VERTEX_SHADER, vs)); gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs));\n    gl.linkProgram(p); if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('link: ' + gl.getProgramInfoLog(p));\n    const u = {}; const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);\n    for (let i = 0; i < n; i++) { const info = gl.getActiveUniform(p, i); u[info.name] = gl.getUniformLocation(p, info.name); }\n    return { p, u };\n  }\n\n  initGL() {\n    const gl = this.gl, S = this.scale;\n    gl.getExtension('EXT_color_buffer_float');\n    this.prim = this.compile(VS_PRIM, FS_PRIM);\n    this.blitN = this.compile(VS_QUAD, FS_BLIT_NATIVE);\n    this.blitC = this.compile(VS_QUAD, FS_BLIT_RGBA);\n    this.pres = this.compile(VS_QUAD, FS_PRESENT);\n    this.fillP = this.compile(VS_QUAD, FS_FILL);\n    this.fieldP = this.compile(VS_QUAD, FS_FIELD);\n    this.deintP = this.compile(VS_QUAD, FS_DEINT);\n\n    // H: textura + stencil\n    this.texH = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, this.texH);\n    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, this.W, this.H);\n    this.setFilter(this.texH, gl.NEAREST);\n    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);\n    this.rbDS = gl.createRenderbuffer(); gl.bindRenderbuffer(gl.RENDERBUFFER, this.rbDS);\n    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH24_STENCIL8, this.W, this.H);\n    this.fboH = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboH);\n    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.texH, 0);\n    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_STENCIL_ATTACHMENT, gl.RENDERBUFFER, this.rbDS);\n    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('FBO incompleto (memória de vídeo insuficiente para ' + S + 'x?)');\n    gl.disable(gl.SCISSOR_TEST); gl.clearColor(0, 0, 0, 0); gl.clearStencil(0); gl.stencilMask(0xFF); gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);\n\n    // N: textura R16UI\n    this.texN = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, this.texN);\n    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R16UI, VW, VH);\n    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);\n    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);\n\n    this.texScratch = null;                                      // alocada na 1ª cópia VRAM->VRAM\n    this.texVid = gl.createTexture();                            // imagem de display em 24 bits\n\n    // VBO/VAO dos primitivos\n    this.vbo = gl.createBuffer(); this.vao = gl.createVertexArray();\n    gl.bindVertexArray(this.vao); gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);\n    gl.bufferData(gl.ARRAY_BUFFER, MAX_VERTS * STRIDE_W * 4, gl.STREAM_DRAW);\n    const B = STRIDE_W * 4;\n    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, B, 0);\n    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, B, 8);\n    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 2, gl.FLOAT, false, B, 20);\n    gl.enableVertexAttribArray(3); gl.vertexAttribIPointer(3, 4, gl.INT, B, 28);\n    gl.enableVertexAttribArray(4); gl.vertexAttribIPointer(4, 4, gl.INT, B, 44);\n    gl.enableVertexAttribArray(5); gl.vertexAttribIPointer(5, 4, gl.INT, B, 60);\n\n    // quad (blits/apresentação): 6 vértices x (x,y,u,v)\n    this.qbo = gl.createBuffer(); this.qvao = gl.createVertexArray();\n    gl.bindVertexArray(this.qvao); gl.bindBuffer(gl.ARRAY_BUFFER, this.qbo);\n    gl.bufferData(gl.ARRAY_BUFFER, 6 * 4 * 4, gl.STREAM_DRAW);\n    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 16, 0);\n    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 16, 8);\n    this.qdata = new Float32Array(24);\n    gl.bindVertexArray(null);\n  }\n\n  setFilter(tex, f) {\n    const gl = this.gl; gl.bindTexture(gl.TEXTURE_2D, tex);\n    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, f); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, f);\n  }\n\n  // ------------------------------------------------------------------ ciclo de vida\n  /** liga o renderizador à GPU: envia a VRAM nativa atual para H e N */\n  attach(gpu) {\n    this.gpu = gpu; gpu.hw = this;\n    this.dirty.fill(0); this.n = 0; this.pb = [1e9, 1e9, -1, -1];\n    const cm = gpu.checkMask; gpu.checkMask = false;\n    this.uploadNativeTex(0, 0, VW, VH);\n    this.blitNativeToH(0, 0, VW, VH);\n    gpu.checkMask = cm;\n  }\n  /** desliga: traz tudo de H para a VRAM nativa e devolve o controle ao software */\n  detach() {\n    if (!this.gpu) return;\n    this.flush(); this.syncNative(0, 0, VW, VH, true);\n    this.gpu.hw = null; this.gpu = null;\n  }\n\n  // ------------------------------------------------------------------ helpers de região\n  /** divide um retângulo (com wrap em 1024x512) em pedaços que não cruzam as bordas */\n  rects(x, y, w, h, fn) {\n    x &= 1023; y &= 511; w = Math.min(w, VW); h = Math.min(h, VH);\n    const w1 = Math.min(w, VW - x), h1 = Math.min(h, VH - y);\n    fn(x, y, w1, h1);\n    if (w > w1) fn(0, y, w - w1, h1);\n    if (h > h1) { fn(x, 0, w1, h - h1); if (w > w1) fn(0, 0, w - w1, h - h1); }\n  }\n  markDirty(x0, y0, x1, y1) {                                   // inclusivo, nativo\n    x0 = Math.max(0, x0); y0 = Math.max(0, y0); x1 = Math.min(VW - 1, x1); y1 = Math.min(VH - 1, y1);\n    if (x1 < x0 || y1 < y0) return;\n    for (let ty = y0 >> 4; ty <= y1 >> 4; ty++) for (let tx = x0 >> 4; tx <= x1 >> 4; tx++) this.dirty[ty * TX + tx] = 1;\n  }\n  isDirty(x, y, w, h) {\n    for (let ty = y >> 4; ty <= (y + h - 1) >> 4; ty++) for (let tx = x >> 4; tx <= (x + w - 1) >> 4; tx++) if (this.dirty[ty * TX + tx]) return true;\n    return false;\n  }\n  pendingHits(x, y, w, h) {\n    const p = this.pb; return p[2] >= 0 && !(x > p[2] || x + w - 1 < p[0] || y > p[3] || y + h - 1 < p[1]);\n  }\n\n  // ------------------------------------------------------------------ N <-> H\n  uploadNativeTex(x, y, w, h) {\n    const gl = this.gl;\n    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.texN);\n    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, VW); gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, x); gl.pixelStorei(gl.UNPACK_SKIP_ROWS, y);\n    gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, w, h, gl.RED_INTEGER, gl.UNSIGNED_SHORT, this.gpu.vram);\n    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0); gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0); gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);\n  }\n\n  applyMask(writeBit, check) {\n    const gl = this.gl; gl.enable(gl.STENCIL_TEST); gl.stencilMask(0xFF);\n    if (check) { gl.stencilFunc(gl.EQUAL, 0, 0xFF); gl.stencilOp(gl.KEEP, gl.KEEP, writeBit ? gl.INVERT : gl.KEEP); }\n    else { gl.stencilFunc(gl.ALWAYS, writeBit, 0xFF); gl.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE); }\n  }\n\n  drawQuad(x, y, w, h, u0 = 0, v0 = 0, u1 = 0, v1 = 0, ndc = false) {\n    const gl = this.gl, q = this.qdata;\n    const X0 = x, Y0 = y, X1 = x + w, Y1 = y + h;\n    q.set([X0, Y0, u0, v0, X1, Y0, u1, v0, X0, Y1, u0, v1, X1, Y0, u1, v0, X1, Y1, u1, v1, X0, Y1, u0, v1]);\n    gl.bindVertexArray(this.qvao); gl.bindBuffer(gl.ARRAY_BUFFER, this.qbo); gl.bufferSubData(gl.ARRAY_BUFFER, 0, q);\n    gl.drawArrays(gl.TRIANGLES, 0, 6);\n  }\n\n  /** copia a região da VRAM nativa (N) para H (2 passes por bit de máscara) */\n  blitNativeToH(x0, y0, w0, h0) {\n    const gl = this.gl, S = this.scale, g = this.gpu;\n    this.rects(x0, y0, w0, h0, (x, y, w, h) => {\n      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboH); gl.viewport(0, 0, this.W, this.H);\n      gl.disable(gl.BLEND); gl.enable(gl.SCISSOR_TEST); gl.scissor(x * S, y * S, w * S, h * S); gl.colorMask(true, true, true, true);\n      gl.useProgram(this.blitN.p); gl.uniform1f(this.blitN.u.u_scale, S); gl.uniform1i(this.blitN.u.u_ndc, 0); gl.uniform1i(this.blitN.u.u_src, 0);\n      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.texN);\n      for (let pass = 0; pass < 2; pass++) {\n        this.applyMask(pass, g.checkMask); gl.uniform1i(this.blitN.u.u_pass, pass);\n        this.drawQuad(x, y, w, h);\n      }\n      if (!g.checkMask) for (let ty = y >> 4; ty <= (y + h - 1) >> 4; ty++) for (let tx = x >> 4; tx <= (x + w - 1) >> 4; tx++) {\n        if (tx * TILE >= x && ty * TILE >= y && (tx + 1) * TILE <= x + w && (ty + 1) * TILE <= y + h) this.dirty[ty * TX + tx] = 0;\n      }\n    });\n  }\n\n  /** traz de H para a VRAM nativa os tiles sujos que tocam a região; atualiza também a textura N */\n  syncNative(x0, y0, w0, h0, all = false) {\n    this.flush();\n    const gl = this.gl, S = this.scale, g = this.gpu;\n    this.rects(x0, y0, w0, h0, (x, y, w, h) => {\n      let bx0 = 1e9, by0 = 1e9, bx1 = -1, by1 = -1;\n      for (let ty = y >> 4; ty <= (y + h - 1) >> 4; ty++) for (let tx = x >> 4; tx <= (x + w - 1) >> 4; tx++) {\n        if (!all && !this.dirty[ty * TX + tx]) continue;\n        if (tx * TILE < bx0) bx0 = tx * TILE; if (ty * TILE < by0) by0 = ty * TILE;\n        if ((tx + 1) * TILE - 1 > bx1) bx1 = (tx + 1) * TILE - 1; if ((ty + 1) * TILE - 1 > by1) by1 = (ty + 1) * TILE - 1;\n      }\n      if (bx1 < 0) return;\n      const bw = bx1 - bx0 + 1, bh = by1 - by0 + 1, pw = bw * S, ph = bh * S;\n      if (!this.rb || this.rb.length < pw * ph * 4) this.rb = new Uint8Array(pw * ph * 4);\n      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.fboH);\n      gl.readPixels(bx0 * S, by0 * S, pw, ph, gl.RGBA, gl.UNSIGNED_BYTE, this.rb);\n      const rb = this.rb, c = S >> 1, vram = g.vram;\n      for (let ny = 0; ny < bh; ny++) {\n        let o = ((ny * S + c) * pw + c) * 4, di = (by0 + ny) * VW + bx0;\n        for (let nx = 0; nx < bw; nx++, o += S * 4, di++) {\n          vram[di] = Q5[rb[o]] | (Q5[rb[o + 1]] << 5) | (Q5[rb[o + 2]] << 10) | (rb[o + 3] > 127 ? 0x8000 : 0);\n        }\n      }\n      for (let ty = by0 >> 4; ty <= by1 >> 4; ty++) for (let tx = bx0 >> 4; tx <= bx1 >> 4; tx++) this.dirty[ty * TX + tx] = 0;\n      this.uploadNativeTex(bx0, by0, bw, bh);\n    });\n  }\n\n  /** a CPU escreveu na VRAM nativa (upload / cópia por software): reflete em H e N */\n  uploaded(x, y, w, h) {\n    this.flush();\n    this.rects(x, y, w, h, (rx, ry, rw, rh) => { this.uploadNativeTex(rx, ry, rw, rh); this.blitNativeToH(rx, ry, rw, rh); });\n  }\n\n  // ------------------------------------------------------------------ comandos de VRAM\n  fill(x0, y0, w, h, col) {\n    this.flush();\n    const gl = this.gl, S = this.scale, mk = this.gpu.rowMask;\n    if (mk >= 0) return this.fillMasked(x0, y0, w, h, col, mk);\n    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboH); gl.viewport(0, 0, this.W, this.H);\n    gl.disable(gl.BLEND); gl.enable(gl.SCISSOR_TEST); gl.colorMask(true, true, true, true); gl.stencilMask(0xFF);\n    gl.clearColor(((col & 255) >> 3) / 31, (((col >> 8) & 255) >> 3) / 31, (((col >> 16) & 255) >> 3) / 31, 0); gl.clearStencil(0);\n    this.rects(x0, y0, w, h, (x, y, rw, rh) => {\n      gl.scissor(x * S, y * S, rw * S, rh * S); gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);\n      this.markDirty(x, y, x + rw - 1, y + rh - 1);\n    });\n  }\n\n  /** fill em 480i: só as linhas do campo que não está sendo exibido (via shader; o stencil é zerado junto) */\n  fillMasked(x0, y0, w, h, col, mk) {\n    const gl = this.gl, S = this.scale;\n    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboH); gl.viewport(0, 0, this.W, this.H);\n    gl.disable(gl.BLEND); gl.enable(gl.SCISSOR_TEST); gl.colorMask(true, true, true, true);\n    gl.enable(gl.STENCIL_TEST); gl.stencilMask(0xFF); gl.stencilFunc(gl.ALWAYS, 0, 0xFF); gl.stencilOp(gl.REPLACE, gl.REPLACE, gl.REPLACE);\n    gl.useProgram(this.fillP.p); gl.uniform1i(this.fillP.u.u_ndc, 0);\n    gl.uniform4f(this.fillP.u.u_col, ((col & 255) >> 3) / 31, (((col >> 8) & 255) >> 3) / 31, (((col >> 16) & 255) >> 3) / 31, 0);\n    gl.uniform1f(this.fillP.u.u_scale, S); gl.uniform1i(this.fillP.u.u_row, mk);\n    this.rects(x0, y0, w, h, (x, y, rw, rh) => {\n      gl.scissor(x * S, y * S, rw * S, rh * S);\n      this.drawQuad(x, y, rw, rh);\n      this.markDirty(x, y, x + rw - 1, y + rh - 1);\n    });\n    gl.bindVertexArray(null);\n  }\n\n  /** fim de quadro em 480i: guarda as linhas do campo exibido (completas) numa textura de display; a saída tece com o campo anterior */\n  captureField(g) {\n    this.flush();\n    if (!(g.interlace && g.vres) || !g.dispOn) { this.dispKey = ''; g.snapKey = ''; return; }\n    const gl = this.gl, S = this.scale, w = g.width, h = g.height;\n    if (g.rgb24) { this.dispKey = ''; this.rects(g.startX, g.startY, Math.ceil(w * 1.5) + 2, h, (x, y, rw, rh) => this.syncNative(x, y, rw, rh)); g.captureFieldSW(); return; }\n    g.snapKey = ''; this.lastPar = g.field;\n    if (!this.texDisp) {\n      this.texDisp = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, this.texDisp);\n      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, this.W, this.H);\n      this.setFilter(this.texDisp, gl.NEAREST);\n      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);\n      this.fboDisp = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboDisp);\n      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.texDisp, 0);\n    }\n    if (!this.texPrev) {                                          // cópia do campo anterior (para detectar movimento)\n      this.texPrev = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, this.texPrev);\n      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, this.W, this.H); this.setFilter(this.texPrev, gl.NEAREST);\n      this.fboPrev = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboPrev);\n      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.texPrev, 0);\n    }\n    const key = g.startX + ',' + g.startY + ',' + w + ',' + h, full = key !== this.dispKey; this.dispKey = key;\n    if (full) {                                                  // 1º quadro (ou mudança de modo): copia a área toda\n      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.fboH); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.fboDisp);\n      this.rects(g.startX, g.startY, w, h, (x, y, rw, rh) => gl.blitFramebuffer(x * S, y * S, (x + rw) * S, (y + rh) * S, x * S, y * S, (x + rw) * S, (y + rh) * S, gl.COLOR_BUFFER_BIT, gl.NEAREST));\n    }\n    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.fboDisp); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.fboPrev);      // texDisp (campos t-1 e t-2) -> texPrev\n    gl.disable(gl.SCISSOR_TEST);\n    this.rects(g.startX, g.startY, w, h, (x, y, rw, rh) => gl.blitFramebuffer(x * S, y * S, (x + rw) * S, (y + rh) * S, x * S, y * S, (x + rw) * S, (y + rh) * S, gl.COLOR_BUFFER_BIT, gl.NEAREST));\n    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboDisp); gl.viewport(0, 0, this.W, this.H);\n    gl.disable(gl.BLEND); gl.disable(gl.STENCIL_TEST); gl.enable(gl.SCISSOR_TEST); gl.colorMask(true, true, true, true);\n    gl.useProgram(this.fieldP.p); gl.uniform1i(this.fieldP.u.u_ndc, 0); gl.uniform1i(this.fieldP.u.u_src, 0);\n    gl.uniform1f(this.fieldP.u.u_scale, S); gl.uniform1i(this.fieldP.u.u_par, g.field); gl.uniform1i(this.fieldP.u.u_prev, 5); gl.uniform1f(this.fieldP.u.u_mt, 12 / 255);\n    gl.activeTexture(gl.TEXTURE5); gl.bindTexture(gl.TEXTURE_2D, this.texPrev);\n    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.texH);\n    this.rects(g.startX, g.startY, w, h, (x, y, rw, rh) => { gl.scissor(x * S, y * S, rw * S, rh * S); this.drawQuad(x, y, rw, rh); });\n    gl.bindVertexArray(null);\n  }\n\n  /** VRAM->VRAM dentro da GPU. Devolve false se o chamador deve fazer por software (após sincronizar). */\n  copy(sx, sy, dx, dy, w, h) {\n    const g = this.gpu;\n    if (sx + w > VW || dx + w > VW || sy + h > VH || dy + h > VH) {          // com wrap: caminho por software\n      this.rects(sx, sy, w, h, (x, y, rw, rh) => this.syncNative(x, y, rw, rh));\n      if (g.checkMask) this.rects(dx, dy, w, h, (x, y, rw, rh) => this.syncNative(x, y, rw, rh));\n      return false;\n    }\n    this.flush();\n    const gl = this.gl, S = this.scale;\n    if (!this.texScratch) {\n      this.texScratch = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, this.texScratch);\n      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, this.W, this.H); this.setFilter(this.texScratch, gl.NEAREST);\n    }\n    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.fboH);\n    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, this.texScratch);\n    gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, sx * S, sy * S, sx * S, sy * S, w * S, h * S);\n    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboH); gl.viewport(0, 0, this.W, this.H);\n    gl.disable(gl.BLEND); gl.enable(gl.SCISSOR_TEST); gl.scissor(dx * S, dy * S, w * S, h * S); gl.colorMask(true, true, true, true);\n    gl.useProgram(this.blitC.p); gl.uniform1i(this.blitC.u.u_ndc, 0); gl.uniform1i(this.blitC.u.u_src, 2);\n    gl.uniform2i(this.blitC.u.u_delta, (sx - dx) * S, (sy - dy) * S); gl.uniform1i(this.blitC.u.u_setMask, g.setMask ? 1 : 0);\n    for (let pass = 0; pass < 2; pass++) { this.applyMask(pass, g.checkMask); gl.uniform1i(this.blitC.u.u_pass, pass); this.drawQuad(dx, dy, w, h); }\n    gl.activeTexture(gl.TEXTURE0);\n    this.markDirty(dx, dy, dx + w - 1, dy + h - 1);\n    return true;\n  }\n\n  // ------------------------------------------------------------------ primitivos\n  pv(x, y, r, g, b, u, v) {\n    const f = this.f32, i = this.i32, pc = this.pc; let o = this.n * STRIDE_W;\n    f[o] = x; f[o + 1] = y; f[o + 2] = r; f[o + 3] = g; f[o + 4] = b; f[o + 5] = u; f[o + 6] = v;\n    for (let k = 0; k < 12; k++) i[o + 7 + k] = pc[k];\n    this.n++;\n  }\n\n  /** prepara as constantes por primitivo + garante texturas atualizadas + gerencia o lote */\n  begin(textured, semi, raw, dith, clutX, clutY, bx0, by0, bx1, by1, nverts) {\n    const g = this.gpu, pc = this.pc;\n    const depth = textured ? g.texDepth : 3;\n    if (textured) {\n      const pw = depth === 0 ? 64 : depth === 1 ? 128 : 256, px = g.texX * 64, py = g.texY * 256;\n      const need = (x, y, w, h) => this.rects(x, y, w, h, (rx, ry, rw, rh) => {\n        if (this.pendingHits(rx, ry, rw, rh)) this.flush();\n        if (this.isDirty(rx, ry, rw, rh)) this.syncNative(rx, ry, rw, rh);\n      });\n      need(px, py, pw, 256);\n      if (depth === 0) need(clutX * 16, clutY, 16, 1); else if (depth === 1) need(clutX * 16, clutY, 256, 1);\n      pc[0] = px; pc[1] = py; pc[2] = clutX * 16; pc[3] = clutY;\n    } else { pc[0] = pc[1] = pc[2] = pc[3] = 0; }\n    pc[4] = depth; pc[5] = raw ? 1 : 0; pc[6] = dith ? 1 : 0; pc[7] = 0;\n    pc[8] = g.twMaskX; pc[9] = g.twMaskY; pc[10] = g.twOffX; pc[11] = g.twOffY;\n\n    const kind = !semi ? 0 : (textured ? 2 : 1);\n    const mk = g.rowMask, key = `${g.daX1},${g.daY1},${g.daX2},${g.daY2},${g.setMask ? 1 : 0},${g.checkMask ? 1 : 0},${kind},${semi ? g.semiMode : -1},${mk}`;\n    if (this.n > 0 && (key !== this.batchKey || this.n + nverts > MAX_VERTS)) this.flush();\n    this.batchKey = key; this.batchKind = kind; this.batchSemi = g.semiMode;\n    this.bs = { x1: g.daX1, y1: g.daY1, x2: g.daX2, y2: g.daY2, set: g.setMask ? 1 : 0, check: g.checkMask, mk };     // estado do lote (a GPU pode mudar antes do flush)\n    // bbox pendente (para dirty tiles e hazard de textura)\n    const p = this.pb;\n    p[0] = Math.min(p[0], Math.max(bx0, g.daX1, 0)); p[1] = Math.min(p[1], Math.max(by0, g.daY1, 0));\n    p[2] = Math.max(p[2], Math.min(bx1, g.daX2, VW - 1)); p[3] = Math.max(p[3], Math.min(by1, g.daY2, VH - 1));\n    return kind;\n  }\n  end(kind) { if (kind === 2) this.flush(); }\n\n  polygon(V, quad, o) {\n    this.tri(V[0], V[1], V[2], o);\n    if (quad) this.tri(V[1], V[2], V[3], o);\n  }\n\n  tri(a, b, c, o) {\n    const g = this.gpu, S = this.scale;\n    const area = (b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y);\n    if (area === 0) return;\n    const minX = Math.min(a.x, b.x, c.x), maxX = Math.max(a.x, b.x, c.x), minY = Math.min(a.y, b.y, c.y), maxY = Math.max(a.y, b.y, c.y);\n    if (maxX - minX > 1023 || maxY - minY > 511) return;\n    if (maxX < g.daX1 || minX > g.daX2 || maxY < g.daY1 || minY > g.daY2) return;\n    const dith = o.tex ? (!o.raw && g.dither) : (g.dither && o.gour);\n    const kind = this.begin(o.tex, o.semi, o.raw, dith, o.clutX, o.clutY, minX, minY, maxX, maxY, 3);\n    const s = 0.5 / S, vs = o.gour ? [a, b, c] : [a, a, a];\n    const P = [a, b, c];\n    // O hardware interpola com gradientes truncados a 12 bits fracionários a partir do 1º vértice (+0,5 de arredondamento).\n    // Reproduz o mesmo plano ajustando o valor de cada vértice: a interpolação linear da GPU do PC dá exatamente esses valores.\n    const trunc = Math.trunc, bx = b.x - a.x, by = b.y - a.y, cx = c.x - a.x, cy = c.y - a.y;\n    const plane = (va, vb, vc) => {\n      const nx = (vb - va) * cy - (vc - va) * by, ny = (vc - va) * bx - (vb - va) * cx;\n      const gx = trunc(nx * 4096 / area) / 4096, gy = trunc(ny * 4096 / area) / 4096;\n      return [va + 0.5, va + 0.5 + gx * bx + gy * by, va + 0.5 + gx * cx + gy * cy];\n    };\n    const U = o.tex ? plane(a.u, b.u, c.u) : [0, 0, 0], V = o.tex ? plane(a.v, b.v, c.v) : [0, 0, 0];\n    const R = o.gour ? plane(a.r, b.r, c.r) : null, G = o.gour ? plane(a.g, b.g, c.g) : null, B = o.gour ? plane(a.b, b.b, c.b) : null;\n    for (let k = 0; k < 3; k++) this.pv(P[k].x + s, P[k].y + s, R ? R[k] : a.r, G ? G[k] : a.g, B ? B[k] : a.b, U[k], V[k]);\n    this.end(kind);\n  }\n\n  rect(x0, y0, w, h, o) {\n    const g = this.gpu;\n    if (w <= 0 || h <= 0) return;\n    if (x0 > g.daX2 || y0 > g.daY2 || x0 + w - 1 < g.daX1 || y0 + h - 1 < g.daY1) return;\n    const kind = this.begin(o.tex, o.semi, o.raw, false, o.clutX, o.clutY, x0, y0, x0 + w - 1, y0 + h - 1, 6);\n    let ul = o.u0, ur = o.u0 + w, vt = o.v0, vb = o.v0 + h;\n    if (o.flipX) { ul = o.u0 + 1.5; ur = ul - w; }          // pixel x amostra u0+1-x (centro do pixel = x+0,5)\n    if (o.flipY) { vt = o.v0 + 0.5; vb = vt - h; }          // flip Y: v0-y\n    const x1 = x0 + w, y1 = y0 + h, r = o.r, gg = o.g, b = o.b;\n    this.pv(x0, y0, r, gg, b, ul, vt); this.pv(x1, y0, r, gg, b, ur, vt); this.pv(x0, y1, r, gg, b, ul, vb);\n    this.pv(x1, y0, r, gg, b, ur, vt); this.pv(x1, y1, r, gg, b, ur, vb); this.pv(x0, y1, r, gg, b, ul, vb);\n    this.end(kind);\n  }\n\n  /** linha: reproduz exatamente os pixels do rasterizador por software (DDA), 1 quad de 1 pixel nativo cada */\n  line(x0, y0, x1, y1, c0, c1, semi, gour) {\n    const g = this.gpu;\n    const dith = g.dither;                                            // linhas flat também recebem dithering (medido)\n    const minX = Math.min(x0, x1), maxX = Math.max(x0, x1), minY = Math.min(y0, y1), maxY = Math.max(y0, y1);\n    if (maxX < g.daX1 || minX > g.daX2 || maxY < g.daY1 || minY > g.daY2) return;\n    const adx = Math.abs(x1 - x0), ady = Math.abs(y1 - y0), k = Math.max(adx, ady);\n    if (adx >= 1024 || ady >= 512) return;                            // fora do limite do hardware\n    const kind = this.begin(false, semi, false, dith, 0, 0, minX, minY, maxX, maxY, (k + 1) * 6);\n    // mesmo algoritmo do rasterizador por software (passo 32.32 arredondado para longe do zero, pixel = floor(pos + 0,5 - eps))\n    let ax = x0, ay = y0, bx = x1, by = y1, ca = c0, cb = c1;\n    if (ax >= bx && k) { ax = x1; ay = y1; bx = x0; by = y0; ca = c1; cb = c0; }\n    const div = d => { if (k === 0) return 0; const q = d * 4294967296 / k; return (q < 0 ? Math.floor(q) : Math.ceil(q)) / 4294967296; };\n    const sx = div(bx - ax), sy = div(by - ay);\n    let px = ax + 0.5 - 1 / 4194304, py = ay + 0.5;\n    const r0 = ca & 255, g0 = (ca >> 8) & 255, b0 = (ca >> 16) & 255;\n    const kk = k || 1, dr = Math.trunc((((cb & 255) - r0) * 4096) / kk), dg = Math.trunc(((((cb >> 8) & 255) - g0) * 4096) / kk), db = Math.trunc(((((cb >> 16) & 255) - b0) * 4096) / kk);\n    for (let i = 0; i <= k; i++, px += sx, py += sy) {\n      const x = Math.floor(px), y = Math.floor(py);\n      let r = r0, gg = g0, b = b0;\n      if (gour) { r = ((r0 << 12) + 2048 + dr * i) >> 12; gg = ((g0 << 12) + 2048 + dg * i) >> 12; b = ((b0 << 12) + 2048 + db * i) >> 12; }\n      this.pv(x, y, r, gg, b, 0, 0); this.pv(x + 1, y, r, gg, b, 0, 0); this.pv(x, y + 1, r, gg, b, 0, 0);\n      this.pv(x + 1, y, r, gg, b, 0, 0); this.pv(x + 1, y + 1, r, gg, b, 0, 0); this.pv(x, y + 1, r, gg, b, 0, 0);\n    }\n    this.end(kind);\n  }\n\n  // ------------------------------------------------------------------ desenho do lote\n  setBlend(mode) {\n    const gl = this.gl; gl.enable(gl.BLEND);\n    switch (mode) {\n      case 0: gl.blendColor(0, 0, 0, 0.5); gl.blendEquationSeparate(gl.FUNC_ADD, gl.FUNC_ADD); gl.blendFuncSeparate(gl.CONSTANT_ALPHA, gl.CONSTANT_ALPHA, gl.ONE, gl.ZERO); break;\n      case 1: gl.blendEquationSeparate(gl.FUNC_ADD, gl.FUNC_ADD); gl.blendFuncSeparate(gl.ONE, gl.ONE, gl.ONE, gl.ZERO); break;\n      case 2: gl.blendEquationSeparate(gl.FUNC_REVERSE_SUBTRACT, gl.FUNC_ADD); gl.blendFuncSeparate(gl.ONE, gl.ONE, gl.ONE, gl.ZERO); break;\n      default: gl.blendColor(0, 0, 0, 0.25); gl.blendEquationSeparate(gl.FUNC_ADD, gl.FUNC_ADD); gl.blendFuncSeparate(gl.CONSTANT_ALPHA, gl.ONE, gl.ONE, gl.ZERO);\n    }\n  }\n\n  flush() {\n    if (!this.n || !this.gpu) { this.n = 0; return; }\n    const gl = this.gl, g = this.gpu, S = this.scale, n = this.n;\n    const p = this.pb;\n    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboH); gl.viewport(0, 0, this.W, this.H);\n    gl.enable(gl.SCISSOR_TEST);\n    const bs = this.bs, x1 = Math.min(bs.x2, VW - 1), y1 = Math.min(bs.y2, VH - 1);\n    gl.scissor(bs.x1 * S, bs.y1 * S, Math.max(0, x1 - bs.x1 + 1) * S, Math.max(0, y1 - bs.y1 + 1) * S);\n    gl.colorMask(true, true, true, true);\n    this.applyMask(bs.set, bs.check);\n    gl.useProgram(this.prim.p);\n    gl.uniform1f(this.prim.u.u_scale, S); gl.uniform1i(this.prim.u.u_setMask, bs.set); gl.uniform1i(this.prim.u.u_rowMask, bs.mk); gl.uniform1i(this.prim.u.u_vram, 0);\n    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.texN);\n    gl.bindVertexArray(this.vao); gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);\n    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.f32, 0, n * STRIDE_W);\n    const kind = this.batchKind;\n    if (kind === 0) { gl.disable(gl.BLEND); gl.uniform1i(this.prim.u.u_pass, 0); gl.drawArrays(gl.TRIANGLES, 0, n); }\n    else if (kind === 1) { this.setBlend(this.batchSemi); gl.uniform1i(this.prim.u.u_pass, 0); gl.drawArrays(gl.TRIANGLES, 0, n); gl.disable(gl.BLEND); }\n    else {\n      gl.disable(gl.BLEND); gl.uniform1i(this.prim.u.u_pass, 1); gl.drawArrays(gl.TRIANGLES, 0, n);\n      this.setBlend(this.batchSemi); gl.uniform1i(this.prim.u.u_pass, 2); gl.drawArrays(gl.TRIANGLES, 0, n); gl.disable(gl.BLEND);\n    }\n    gl.bindVertexArray(null);\n    if (p[2] >= 0) this.markDirty(p[0], p[1], p[2], p[3]);\n    this.pb = [1e9, 1e9, -1, -1]; this.n = 0;\n  }\n\n  // ------------------------------------------------------------------ saída\n  /** desenha a área de display no canvas */\n  present(gpu) {\n    this.flush();\n    const gl = this.gl, S = this.scale, w = gpu.width, h = gpu.height;\n    const outS = Math.max(1, Math.min(S, Math.floor(3840 / w)));\n    const cw = w * outS, ch = h * outS;\n    if (this.canvas.width !== cw || this.canvas.height !== ch) { this.canvas.width = cw; this.canvas.height = ch; }\n    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, cw, ch);\n    gl.disable(gl.SCISSOR_TEST); gl.disable(gl.BLEND); gl.disable(gl.STENCIL_TEST); gl.colorMask(true, true, true, true);\n    if (!gpu.dispOn) { gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT); return; }\n    gl.useProgram(this.pres.p); gl.uniform1i(this.pres.u.u_ndc, 1); gl.uniform1i(this.pres.u.u_tex, 1);\n    gl.activeTexture(gl.TEXTURE1);\n    if (gpu.rgb24) {\n      const vw = Math.ceil(w * 1.5) + 1;\n      this.rects(gpu.startX, gpu.startY, vw, h, (x, y, rw, rh) => this.syncNative(x, y, rw, rh));\n      if (!this.rgba || this.rgba.length !== w * h * 4) this.rgba = new Uint8ClampedArray(w * h * 4);\n      gpu.renderRGBA(this.rgba);\n      gl.bindTexture(gl.TEXTURE_2D, this.texVid);\n      if (this.vidW !== w || this.vidH !== h) { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null); this.vidW = w; this.vidH = h; }   // aloca 1x; depois só atualiza (menos custo no driver)\n      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, this.rgba);\n      this.setFilter(this.texVid, gl.NEAREST);\n      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);\n      this.drawQuad(-1, 1, 2, -2, 0, 0, 1, 1, true);\n    } else {\n      const dt = (g2 => g2.interlace && g2.vres && this.dispKey)(gpu) ? this.texDisp : this.texH;      // 480i: dois últimos campos completos\n      gl.bindTexture(gl.TEXTURE_2D, dt);\n      this.setFilter(dt, (outS === S || !this.opts.smooth) ? gl.NEAREST : gl.LINEAR);\n      if (dt === this.texDisp && gpu.deint) {                                            // 480i: desentrelaça na apresentação\n        const dp = this.deintP; gl.useProgram(dp.p); gl.uniform1i(dp.u.u_ndc, 1); gl.uniform1i(dp.u.u_tex, 1);\n        gl.uniform1i(dp.u.u_par, this.lastPar | 0); gl.uniform1i(dp.u.u_mode, gpu.deint); gl.uniform1f(dp.u.u_thr, DEINT_THR / 255); gl.uniform1f(dp.u.u_dv, 1 / 512);\n      }\n      const u0 = gpu.startX / VW, v0 = gpu.startY / VH, u1 = (gpu.startX + w) / VW, v1 = (gpu.startY + h) / VH;\n      this.drawQuad(-1, 1, 2, -2, u0, v0, u1, v1, true);\n    }\n    gl.activeTexture(gl.TEXTURE0);\n    gpu.frameCount++;\n  }\n\n  /** lê a área de display em RGBA8 (linhas de cima para baixo) na resolução interna - para testes/capturas */\n  readDisplay(gpu) {\n    this.flush();\n    const gl = this.gl, S = this.scale, w = gpu.width, h = gpu.height;\n    if (gpu.rgb24 || !gpu.dispOn) { this.syncNative(0, 0, VW, VH); const r = gpu.renderRGBA(); return { data: r.data, width: r.width, height: r.height, scale: 1 }; }\n    const out = new Uint8ClampedArray(w * S * h * S * 4), tmp = new Uint8Array(w * S * h * S * 4);\n    // lê em até 4 pedaços (wrap)\n    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.fboH);\n    this.rects(gpu.startX, gpu.startY, w, h, (x, y, rw, rh) => {\n      const buf = new Uint8Array(rw * S * rh * S * 4);\n      gl.readPixels(x * S, y * S, rw * S, rh * S, gl.RGBA, gl.UNSIGNED_BYTE, buf);\n      const ox = ((x - gpu.startX) & 1023) * S, oy = ((y - gpu.startY) & 511) * S;\n      for (let r = 0; r < rh * S; r++) tmp.set(buf.subarray(r * rw * S * 4, (r + 1) * rw * S * 4), ((oy + r) * w * S + ox) * 4);\n    });\n    for (let i = 0; i < tmp.length; i += 4) {\n      const r5 = Q5[tmp[i]], g5 = Q5[tmp[i + 1]], b5 = Q5[tmp[i + 2]];\n      let r = r5 << 3, gg = g5 << 3, b = b5 << 3; r |= r >> 5; gg |= gg >> 5; b |= b >> 5;\n      out[i] = r; out[i + 1] = gg; out[i + 2] = b; out[i + 3] = 255;\n    }\n    return { data: out, width: w * S, height: h * S, scale: S };\n  }\n}\n\nreturn { GLRenderer };\n})();\nconst __web_video_out = (() => {\nconst { GLRenderer } = __src_glgpu;\n// Saída de vídeo: apresenta a área de display da VRAM num <canvas>\nclass VideoOut {\n  constructor(canvas) { this.canvas = canvas; this.ctx = canvas.getContext('2d'); this.img = null; }\n  present(gpu) {\n    const w = gpu.width, h = gpu.height;\n    if (!this.img || this.img.width !== w || this.img.height !== h) {\n      this.canvas.width = w; this.canvas.height = h; this.img = this.ctx.createImageData(w, h);\n    }\n    gpu.renderRGBA(this.img.data);\n    this.ctx.putImageData(this.img, 0, 0);\n  }\n}\n\n/** Apresentação via WebGL2 com resolução interna escalável (usa GLRenderer; a GPU deixa de rasterizar por software) */\nclass GLVideoOut {\n  constructor(canvas, scale, psx, opts = {}) {\n    this.psx = psx; this.r = new GLRenderer(canvas, scale, opts); this.scale = this.r.scale;\n    this.r.attach(psx.gpu);\n  }\n  present(gpu) { this.r.present(gpu); }\n  dispose() { this.r.detach(); }\n}\n\nreturn { VideoOut, GLVideoOut };\n})();\nconst __web_audio_out = (() => {\n// Saída de áudio: reprodução em taxa FIXA (44,1 kHz, sem reamostragem nem controle de velocidade), então o tom nunca muda.\n// Fila de blocos com pré-buffer curto: se o emulador atrasa, há silêncio até a fila reabastecer (sem alterar o tom);\n// se ele \"recupera\" em rajada, o excesso acima do limite de latência é descartado.\nclass PCMPull {\n  constructor() { this.q = []; this.cur = null; this.pos = 0; this.fill = 0; this.primeAt = 1764; this.maxFill = 8820; this.primed = false; this.under = 0; this.drops = 0; this.lastL = 0; this.lastR = 0; this.fadeIn = 0; this.fo = 64; this.fl = 0; this.fr = 0; }\n  push(b) {\n    this.q.push(b); this.fill += b.length >> 1;\n    while (this.fill > this.maxFill && this.q.length > 1) { const d = this.q.shift(); this.fill -= d.length >> 1; this.drops++; }   // latência limitada (~200 ms)\n  }\n  /** preenche de `from` até o fim com silêncio, terminando a descida suave (64 amostras) que pode atravessar blocos */\n  silence(L, R, from) {\n    const n = L.length;\n    for (let j = from; j < n; j++) {\n      if (this.fo < 64) { const k = 1 - (this.fo + 1) / 64; L[j] = this.fl * k; R[j] = this.fr * k; this.fo++; } else { L[j] = R[j] = 0; }\n    }\n    this.lastL = this.lastR = 0;\n  }\n  pull(L, R) {\n    const n = L.length;\n    if (!this.primed) {\n      if (this.fill >= this.primeAt) { this.primed = true; this.fadeIn = this.under > 0 ? 64 : 0; }\n      else { this.silence(L, R, 0); return; }\n    }\n    for (let i = 0; i < n; i++) {\n      if (!this.cur || this.pos >= this.cur.length) {\n        this.cur = this.q.shift() || null; this.pos = 0;\n        if (!this.cur) {                                                                              // esvaziou: some suavemente (sem estalo) e espera reabastecer\n          this.primed = false; this.under++; this.fl = this.lastL; this.fr = this.lastR; this.fo = 0;\n          this.silence(L, R, i); return;\n        }\n      }\n      let l = this.cur[this.pos++] / 32768, r = this.cur[this.pos++] / 32768; this.fill--;\n      if (this.fadeIn > 0) { const g = 1 - this.fadeIn / 64; l *= g; r *= g; this.fadeIn--; }          // entrada suave após esvaziar\n      L[i] = this.lastL = l; R[i] = this.lastR = r;\n    }\n  }\n}\n\nconst WORKLET = `${PCMPull.toString()}\nclass PS1Out extends AudioWorkletProcessor {\n  constructor() {\n    super(); this.p = new PCMPull(); this.p.maxFill = 13230; this.ext = null; this.n = 0;      // teto de 300 ms: a meta adaptativa chega a 160 ms e uma rajada de 3 quadros soma ~50 ms\n    // canal direto emulador(Worker) -> áudio: o áudio não passa pela thread principal (UI/GC não causam falhas) e volta o nível do buffer\n    this.port.onmessage = e => { const d = e.data; if (d && d.ch) { this.ext = d.ch; this.ext.onmessage = ev => this.p.push(ev.data); } else this.p.push(d); };\n  }\n  process(_, outs) {\n    const o = outs[0], n = o[0].length; this.p.pull(o[0], o[1]); this.n += n;\n    if (this.ext && this.n >= 2205) { this.n = 0; this.ext.postMessage({ ms: this.p.fill / 44.1, under: this.p.under, drops: this.p.drops }); }\n    return true;\n  }\n}\nregisterProcessor('ps1-out', PS1Out);`;\n\nclass AudioOut {\n  async start() {                                  // precisa de um gesto do usuário (clique)\n    this.ctx = new AudioContext({ sampleRate: 44100 });\n    this.pull = new PCMPull(); this.pull.maxFill = 13230;\n    try {\n      if (!this.ctx.audioWorklet) throw new Error('sem AudioWorklet');\n      try { await this.ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }))); }\n      catch { await this.ctx.audioWorklet.addModule('data:text/javascript,' + encodeURIComponent(WORKLET)); }      // file://: o Chrome recusa módulo por blob:, mas aceita data: (antes caía no ScriptProcessor, que roda na thread principal)\n      this.node = new AudioWorkletNode(this.ctx, 'ps1-out', { outputChannelCount: [2] });\n      this.node.connect(this.ctx.destination);\n      this.mode = 'worklet';\n    } catch (e) {                                  // fallback (ex.: file:// bloqueando o worklet)\n      const sp = this.ctx.createScriptProcessor(2048, 0, 2);\n      sp.onaudioprocess = ev => this.pull.pull(ev.outputBuffer.getChannelData(0), ev.outputBuffer.getChannelData(1));\n      sp.connect(this.ctx.destination); this.node = sp; this.mode = 'scriptprocessor';\n    }\n    await this.ctx.resume();\n  }\n  /** cria o canal direto Worker -> AudioWorklet; devolve a porta para o Worker (ou null se não há worklet) */\n  channel() {\n    if (this.mode !== 'worklet') return null;\n    const ch = new MessageChannel(); this.node.port.postMessage({ ch: ch.port1 }, [ch.port1]); return ch.port2;\n  }\n  push(int16) {                                    // int16 = L,R,L,R...\n    if (this.mode === 'worklet') this.node.port.postMessage(int16);\n    else this.pull.push(int16);\n  }\n}\n\nreturn { PCMPull, AudioOut };\n})();\nconst __web_remote = (() => {\n// Lado da página do modo Worker: fala com web/worker.js. Expõe `sio` compatível com o InputManager (repassa botões/analógicos).\nclass SioProxy {\n  constructor(owner) {\n    this.o = owner; this.padType = ['digital', 'digital']; this.onRumble = null; this.cards = [null, null]; this.cache = new Map();\n    const self = this;\n    this.padConnected = new Proxy([true, false], { set(t, k, v) { if (t[k] !== v) { t[k] = v; self.o.call_('padConnected', [+k, v]); } return true; } });\n  }\n  setButton(name, pressed, port = 0) { const k = 'b' + port + name; if (this.cache.get(k) === pressed) return; this.cache.set(k, pressed); this.o.call_('setButton', [name, pressed, port]); }\n  setStick(name, value, port = 0) { const k = 's' + port + name, v = Math.max(0, Math.min(255, Math.round(value))); if (this.cache.get(k) === v) return; this.cache.set(k, v); this.o.call_('setStick', [name, v, port]); }\n  setPadType(port, type) { this.padType[port] = type; this.cache.clear(); this.o.call_('setPadType', [port, type]); }\n  toggleAnalog(port = 0) { this.o.post({ t: 'analog', port }); return null; }\n}\n\nclass RemoteMachine {\n  /** src = texto do worker (bundle + worker.js), gerado por build.js em PS1_WORKER_SRC */\n  constructor(src) {\n    this.url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));\n    this.w = new Worker(this.url); this.pending = new Map(); this.nid = 0; this.calls = []; this.on = {};\n    this.game = 'sem-disco'; this.cardInfo = ['', '']; this.haveCard = [false, false]; this.hasDisc = false;\n    this.sio = new SioProxy(this);\n    this.w.onmessage = e => { const m = e.data; if (m.t === 'res') { const p = this.pending.get(m.id); this.pending.delete(m.id); if (p) m.ok ? p.res(m.value) : p.rej(new Error(m.err)); } else this.on[m.t]?.(m); };\n    this.w.onerror = e => this.on.crash?.({ msg: e.message || 'erro no Worker', report: `${e.message} (${e.filename || ''}:${e.lineno || ''})` });\n  }\n  post(m, tr) { this.w.postMessage(m, tr || []); }\n  call_(f, a) { this.calls.push([f, a]); }\n  flush() { if (this.calls.length) { this.post({ t: 'sio', calls: this.calls }); this.calls = []; } }\n  req(op, data = {}, tr) { return new Promise((res, rej) => { const id = ++this.nid; this.pending.set(id, { res, rej }); this.post({ t: 'req', id, op, ...data }, tr); }); }\n  terminate() { this.w.terminate(); URL.revokeObjectURL(this.url); }\n}\n\nreturn { RemoteMachine };\n})();\nglobal.PS1 = Object.assign({}, __src_gte, __src_cpu, __src_jit, __src_wasmbin, __src_wasmcpu, __src_disasm, __src_bus, __src_gpu, __src_gauss, __src_spu, __src_disc, __src_scheduler, __src_timers, __src_dma, __src_mdec, __src_memcard, __src_sio, __src_cdrom, __src_state, __src_psx, __src_input, __src_debug, __src_glgpu, __web_video_out, __web_audio_out, __web_remote);\n})(typeof window !== 'undefined' ? window : globalThis);\n\nvar PS1_GPUW_SRC = \"/* PS1 Emu - bundle gerado por build.js (não edite) */\\n(function (global) {\\n\\\"use strict\\\";\\nconst __src_gte = (() => {\\n// ============================================================================\\n//  GTE (COP2) - Geometry Transformation Engine\\n//  Registradores: 32 de dados (cop2r0-31) e 32 de controle (cop2r32-63), acessados por\\n//  MFC2/MTC2/CFC2/CTC2/LWC2/SWC2 (a CPU passa 0..31; os de controle são somados a 32 aqui)\\n//  e por comandos \\\"cop2 imm25\\\".\\n//\\n//  Aritmética: MAC1-3 acumulam em 44 bits com sinal (detecção de overflow a cada soma),\\n//  MAC0 em 32 bits. Os valores cabem em doubles (< 2^53), então usamos Number puro (sem BigInt).\\n//  Flags (reg 63): bits 30-25 overflow MAC1-3 (+/-), 24-22 IR1-3 saturado, 21-19 FIFO de cor,\\n//  18 SZ3/OTZ, 17 divisão, 16/15 MAC0 (+/-), 14/13 SX2/SY2, 12 IR0; bit 31 = erro (OU de 30-23 e 18-13).\\n//\\n//  Comando (25 bits): b5-0 opcode, b10 lm, b14-13 MVMVA translation, b16-15 MVMVA vetor,\\n//  b18-17 MVMVA matriz, b19 sf (1 = resultado >> 12).\\n//  Não emulado: ciclos reais de cada comando (a CPU não \\\"trava\\\" lendo registrador ocupado).\\n// ============================================================================\\nconst M44 = 17592186044416, H44 = 8796093022208;                 // 2^44, 2^43\\nconst wrap44 = v => (v >= H44 || v < -H44) ? ((((v + H44) % M44) + M44) % M44) - H44 : v;\\nconst trunc32 = v => (v >= -2147483648 && v <= 2147483647) ? v : ((((v % 4294967296) + 4294967296) % 4294967296) | 0);\\nconst s16 = v => (v << 16) >> 16;\\nconst clampv = (v, lo, hi) => v < lo ? lo : v > hi ? hi : v;\\nconst sar = (v, sf) => sf ? Math.floor(v / 4096) : v;            // sf = 0 ou 1  (>> 12)\\n\\n// tabela da divisão Newton-Raphson (UNR): max(0, ((0x40000/(i+0x100)+1)/2) - 0x101)\\nconst UNR = new Int32Array(257);\\nfor (let i = 0; i <= 256; i++) UNR[i] = Math.max(0, ((((0x40000 / (i + 0x100)) | 0) + 1) >> 1) - 0x101);\\n\\nclass GTE {\\n  constructor() {\\n    this.d = new Int32Array(32); this.c = new Int32Array(64);     // c indexado por nº do registrador (32..63)\\n    this.rt = new Int16Array(9); this.ll = new Int16Array(9); this.lc = new Int16Array(9);\\n    this.flag = 0; this.commandCount = 0; this.lastCommand = 0;\\n  }\\n  reset() { this.d.fill(0); this.c.fill(0); this.rt.fill(0); this.ll.fill(0); this.lc.fill(0); this.flag = 0; }\\n\\n  // ---------------------------------------------------------------- registradores\\n  readData(i) {\\n    const d = this.d;\\n    switch (i) {\\n      case 1: case 3: case 5: case 8: case 9: case 10: case 11: return s16(d[i]);       // VZn, IR0-3\\n      case 7: case 16: case 17: case 18: case 19: return d[i] & 0xFFFF;                 // OTZ, SZ0-3\\n      case 15: return d[14];                                                            // SXYP lê SXY2\\n      case 28: case 29: return this.orgb();\\n      case 31: return this.lzcr();\\n      default: return d[i];\\n    }\\n  }\\n  writeData(i, v) {\\n    const d = this.d; v |= 0;\\n    switch (i) {\\n      case 1: case 3: case 5: case 8: case 9: case 10: case 11: d[i] = s16(v); return;\\n      case 7: case 16: case 17: case 18: case 19: d[i] = v & 0xFFFF; return;\\n      case 15: d[12] = d[13]; d[13] = d[14]; d[14] = v; return;                         // SXYP: empurra a FIFO\\n      case 28: d[28] = v; d[9] = (v & 0x1F) * 0x80; d[10] = ((v >> 5) & 0x1F) * 0x80; d[11] = ((v >> 10) & 0x1F) * 0x80; return;\\n      case 29: case 31: return;                                                         // somente leitura\\n      default: d[i] = v;\\n    }\\n  }\\n  orgb() { const d = this.d, f = x => clampv(s16(x) >> 7, 0, 0x1F); return f(d[9]) | (f(d[10]) << 5) | (f(d[11]) << 10); }\\n  lzcr() { const v = this.d[30]; return v >= 0 ? Math.clz32(v) : Math.clz32(~v); }      // bits iguais ao sinal (v=0 -> 32)\\n\\n  /** CFC2: n = 0..31 (cop2r32..63) */\\n  readCtrl(n) {\\n    const i = n + 32, c = this.c;\\n    switch (i) {\\n      case 36: case 44: case 52: case 59: case 61: case 62: case 58: return s16(c[i]);  // RT33/L33/LB3, DQA, ZSF, H (H lê com sinal: bug do hw)\\n      case 63: return (this.flag | ((this.flag & 0x7F87E000) ? 0x80000000 : 0)) | 0;\\n      default: return c[i];\\n    }\\n  }\\n  /** CTC2 */\\n  writeCtrl(n, v) {\\n    const i = n + 32; v |= 0; const c = this.c;\\n    if (i === 63) { this.flag = v & 0x7FFFF000; return; }\\n    c[i] = i === 58 ? (v & 0xFFFF) : v;                                                  // H é unsigned 16 em uso\\n    if (i <= 36) this.unpack(this.rt, 32);\\n    else if (i >= 40 && i <= 44) this.unpack(this.ll, 40);\\n    else if (i >= 48 && i <= 52) this.unpack(this.lc, 48);\\n  }\\n  unpack(m, base) { const c = this.c; for (let e = 0; e < 9; e++) { const w = c[base + (e >> 1)]; m[e] = (e & 1) ? (w >> 16) : s16(w); } }\\n\\n  // ---------------------------------------------------------------- utilitários de cálculo\\n  chk(i, v) {                                                                            // MAC1-3: flags de overflow 44 bits\\n    if (v >= H44) this.flag |= 1 << (31 - i); else if (v < -H44) this.flag |= 1 << (28 - i);\\n    return wrap44(v);\\n  }\\n  chk0(v) { if (v > 2147483647) this.flag |= 1 << 16; else if (v < -2147483648) this.flag |= 1 << 15; return v; }\\n  setMac(i, v, sf) { const m = trunc32(sar(v, sf)); this.d[24 + i] = m; return m; }\\n  setIr(i, v, lm) {\\n    const lo = lm ? 0 : -0x8000; let r = v;\\n    if (v < lo) { r = lo; this.flag |= 1 << (25 - i); } else if (v > 0x7FFF) { r = 0x7FFF; this.flag |= 1 << (25 - i); }\\n    this.d[8 + i] = r;\\n  }\\n  setMacIr(i, v, sf, lm) { this.setIr(i, this.setMac(i, v, sf), lm); }\\n  pushSZ(v) {\\n    const d = this.d; let r = v;\\n    if (v < 0) { r = 0; this.flag |= 1 << 18; } else if (v > 0xFFFF) { r = 0xFFFF; this.flag |= 1 << 18; }\\n    d[16] = d[17]; d[17] = d[18]; d[18] = d[19]; d[19] = r;\\n  }\\n  pushSXY(x, y) {\\n    const d = this.d;\\n    if (x < -0x400) { x = -0x400; this.flag |= 1 << 14; } else if (x > 0x3FF) { x = 0x3FF; this.flag |= 1 << 14; }\\n    if (y < -0x400) { y = -0x400; this.flag |= 1 << 13; } else if (y > 0x3FF) { y = 0x3FF; this.flag |= 1 << 13; }\\n    d[12] = d[13]; d[13] = d[14]; d[14] = (y << 16) | (x & 0xFFFF);\\n  }\\n  pushColor() {                                                                          // FIFO de cor a partir de MAC1-3 >> 4\\n    const d = this.d; let cc = 0;\\n    for (let i = 0; i < 3; i++) {\\n      let v = d[25 + i] >> 4;\\n      if (v < 0) { v = 0; this.flag |= 1 << (21 - i); } else if (v > 255) { v = 255; this.flag |= 1 << (21 - i); }\\n      cc |= v << (8 * i);\\n    }\\n    d[20] = d[21]; d[21] = d[22]; d[22] = (cc | (d[6] & 0xFF000000)) | 0;\\n  }\\n  vec(n) { const d = this.d; return n === 0 ? [s16(d[0]), d[0] >> 16, s16(d[1])] : n === 1 ? [s16(d[2]), d[2] >> 16, s16(d[3])] : [s16(d[4]), d[4] >> 16, s16(d[5])]; }\\n  ir() { const d = this.d; return [d[9], d[10], d[11]]; }\\n  rgb() { const w = this.d[6]; return [w & 255, (w >> 8) & 255, (w >> 16) & 255]; }\\n\\n  /** MACi = (tr*0x1000 + M*v) >> sf ; IRi = lim(MACi). Devolve os 3 valores de 44 bits (antes do shift). */\\n  mulMat(M, v, tr, sf, lm, setIr = true) {\\n    const out = [0, 0, 0];\\n    for (let r = 0; r < 3; r++) {\\n      let t = tr ? tr[r] * 4096 : 0;\\n      t = this.chk(r + 1, t + M[r * 3] * v[0]); t = this.chk(r + 1, t + M[r * 3 + 1] * v[1]); t = this.chk(r + 1, t + M[r * 3 + 2] * v[2]);\\n      out[r] = t; this.setMac(r + 1, t, sf);\\n      if (setIr) this.setIr(r + 1, this.d[25 + r], lm);\\n    }\\n    return out;\\n  }\\n\\n  /** divisão UNR: ~ (H * 0x20000 / SZ3 + 1) / 2, saturada em 0x1FFFF */\\n  divide(h, sz3) {\\n    if (h >= sz3 * 2) { this.flag |= 1 << 17; return 0x1FFFF; }\\n    const z = Math.clz32(sz3) - 16, n = h * Math.pow(2, z); let d = (sz3 << z) >>> 0;   // sz3 tratado como 16 bits\\n    const u = UNR[(d - 0x7FC0) >> 7] + 0x101;\\n    d = (0x2000080 - d * u) >> 8; d = (0x80 + d * u) >> 8;\\n    return Math.min(0x1FFFF, Math.floor((n * d + 0x8000) / 65536));\\n  }\\n\\n  // ---------------------------------------------------------------- comandos\\n  command(cmd) {\\n    this.commandCount++; this.lastCommand = cmd; this.flag = 0;\\n    const sf = (cmd >> 19) & 1, lm = (cmd >> 10) & 1, c = this.c;\\n    switch (cmd & 0x3F) {\\n      case 0x01: this.rtp(0, true, sf, lm); break;                                       // RTPS\\n      case 0x30: this.rtp(0, false, sf, lm); this.rtp(1, false, sf, lm); this.rtp(2, true, sf, lm); break;   // RTPT\\n      case 0x06: this.nclip(); break;                                                    // NCLIP\\n      case 0x0C: this.op(sf, lm); break;                                                 // OP\\n      case 0x10: this.dpcs(this.rgb(), sf, lm); break;                                   // DPCS\\n      case 0x2A: for (let i = 0; i < 3; i++) { const w = this.d[20]; this.dpcs([w & 255, (w >> 8) & 255, (w >> 16) & 255], sf, lm); } break;   // DPCT\\n      case 0x11: this.intpl(sf, lm); break;                                              // INTPL\\n      case 0x12: this.mvmva(cmd, sf, lm); break;                                         // MVMVA\\n      case 0x13: this.nc(this.vec(0), 2, sf, lm); break;                                 // NCDS\\n      case 0x16: for (let i = 0; i < 3; i++) this.nc(this.vec(i), 2, sf, lm); break;     // NCDT\\n      case 0x1B: this.nc(this.vec(0), 1, sf, lm); break;                                 // NCCS\\n      case 0x3F: for (let i = 0; i < 3; i++) this.nc(this.vec(i), 1, sf, lm); break;     // NCCT\\n      case 0x1E: this.nc(this.vec(0), 0, sf, lm); break;                                 // NCS\\n      case 0x20: for (let i = 0; i < 3; i++) this.nc(this.vec(i), 0, sf, lm); break;     // NCT\\n      case 0x14: this.cdp(sf, lm); break;                                                // CDP\\n      case 0x1C: this.cc(sf, lm); break;                                                 // CC\\n      case 0x29: this.dcpl(sf, lm); break;                                               // DCPL\\n      case 0x28: this.sqr(sf, lm); break;                                                // SQR\\n      case 0x2D: this.avsz(s16(c[61]), 3); break;                                        // AVSZ3\\n      case 0x2E: this.avsz(s16(c[62]), 4); break;                                        // AVSZ4\\n      case 0x3D: this.gpf(sf, lm); break;                                                // GPF\\n      case 0x3E: this.gpl(sf, lm); break;                                                // GPL\\n      default: break;                                                                    // opcode inválido: sem efeito\\n    }\\n  }\\n\\n  /** transformação de perspectiva de um vértice (RTPS/RTPT) */\\n  rtp(vi, last, sf, lm) {\\n    const d = this.d, c = this.c, v = this.vec(vi), tr = [c[37], c[38], c[39]];\\n    const t = this.mulMat(this.rt, v, tr, sf, lm, false);\\n    this.setIr(1, d[25], lm); this.setIr(2, d[26], lm);\\n    // IR3: valor saturado normalmente, mas a flag vem de (soma >> 12) (comportamento do hardware)\\n    const z12 = Math.floor(t[2] / 4096);\\n    if (z12 < -0x8000 || z12 > 0x7FFF) this.flag |= 1 << 22;\\n    d[11] = clampv(d[27], lm ? 0 : -0x8000, 0x7FFF);\\n    this.pushSZ(z12);\\n    const n = this.divide(c[58] & 0xFFFF, d[19] & 0xFFFF);\\n    const m0x = this.chk0(n * s16(d[9]) + c[56]), m0y = this.chk0(n * s16(d[10]) + c[57]);\\n    d[24] = trunc32(m0y);\\n    this.pushSXY(Math.floor(m0x / 65536), Math.floor(m0y / 65536));     // sem truncar em 32 bits: o hardware satura o valor completo\\n    if (last) {\\n      const m = this.chk0(n * s16(c[59]) + c[60]); d[24] = trunc32(m);\\n      const ir0 = Math.floor(m / 4096);\\n      d[8] = clampv(ir0, 0, 0x1000); if (ir0 < 0 || ir0 > 0x1000) this.flag |= 1 << 12;\\n    }\\n  }\\n\\n  nclip() {\\n    const d = this.d, x0 = s16(d[12]), y0 = d[12] >> 16, x1 = s16(d[13]), y1 = d[13] >> 16, x2 = s16(d[14]), y2 = d[14] >> 16;\\n    d[24] = trunc32(this.chk0(x0 * y1 + x1 * y2 + x2 * y0 - x0 * y2 - x1 * y0 - x2 * y1));\\n  }\\n\\n  op(sf, lm) {                                                                           // produto vetorial com a diagonal de RT\\n    const r = this.rt, ir = this.ir(), d1 = r[0], d2 = r[4], d3 = r[8];\\n    this.setMacIr(1, this.chk(1, ir[2] * d2 - ir[1] * d3), sf, lm);\\n    this.setMacIr(2, this.chk(2, ir[0] * d3 - ir[2] * d1), sf, lm);\\n    this.setMacIr(3, this.chk(3, ir[1] * d1 - ir[0] * d2), sf, lm);\\n  }\\n\\n  /** interpolação em direção à cor de distância (FC): usada por DPCS/INTPL/NCDS/CDP/DCPL */\\n  interp(mac, sf, lm) {\\n    const c = this.c, d = this.d, fc = [c[53], c[54], c[55]], ir0 = s16(d[8]);\\n    for (let i = 0; i < 3; i++) {\\n      const diff = this.chk(i + 1, fc[i] * 4096 - mac[i]);\\n      this.setIr(i + 1, trunc32(sar(diff, sf)), false);\\n      const v = this.chk(i + 1, s16(d[9 + i]) * ir0 + mac[i]);\\n      this.setMacIr(i + 1, v, sf, lm);\\n    }\\n    this.pushColor();\\n  }\\n  dpcs(rgb, sf, lm) { this.interp([rgb[0] * 65536, rgb[1] * 65536, rgb[2] * 65536], sf, lm); }\\n  intpl(sf, lm) { const ir = this.ir(); this.interp([ir[0] * 4096, ir[1] * 4096, ir[2] * 4096], sf, lm); }\\n\\n  /** normal color: matriz de luz e depois matriz de cor; mode 0=NCS 1=NCCS 2=NCDS */\\n  nc(v, mode, sf, lm) {\\n    this.mulMat(this.ll, v, null, sf, lm);\\n    this.mulMat(this.lc, this.ir(), [this.c[45], this.c[46], this.c[47]], sf, lm);\\n    if (mode === 0) { this.pushColor(); return; }\\n    const rgb = this.rgb(), ir = this.ir();\\n    if (mode === 1) { for (let i = 0; i < 3; i++) this.setMacIr(i + 1, this.chk(i + 1, rgb[i] * ir[i] * 16), sf, lm); this.pushColor(); return; }\\n    this.interp([0, 1, 2].map(i => this.chk(i + 1, rgb[i] * ir[i] * 16)), sf, lm);\\n  }\\n  cdp(sf, lm) {\\n    this.mulMat(this.lc, this.ir(), [this.c[45], this.c[46], this.c[47]], sf, lm);\\n    const rgb = this.rgb(), ir = this.ir();\\n    this.interp([0, 1, 2].map(i => this.chk(i + 1, rgb[i] * ir[i] * 16)), sf, lm);\\n  }\\n  cc(sf, lm) {\\n    this.mulMat(this.lc, this.ir(), [this.c[45], this.c[46], this.c[47]], sf, lm);\\n    const rgb = this.rgb(), ir = this.ir();\\n    for (let i = 0; i < 3; i++) this.setMacIr(i + 1, this.chk(i + 1, rgb[i] * ir[i] * 16), sf, lm);\\n    this.pushColor();\\n  }\\n  dcpl(sf, lm) {\\n    const rgb = this.rgb(), ir = this.ir();\\n    this.interp([0, 1, 2].map(i => this.chk(i + 1, rgb[i] * ir[i] * 16)), sf, lm);\\n  }\\n  sqr(sf, lm) { const ir = this.ir(); for (let i = 0; i < 3; i++) this.setMacIr(i + 1, ir[i] * ir[i], sf, lm); }\\n  gpf(sf, lm) { const ir = this.ir(), ir0 = s16(this.d[8]); for (let i = 0; i < 3; i++) this.setMacIr(i + 1, this.chk(i + 1, ir[i] * ir0), sf, lm); this.pushColor(); }\\n  gpl(sf, lm) {\\n    const ir = this.ir(), ir0 = s16(this.d[8]);\\n    for (let i = 0; i < 3; i++) this.setMacIr(i + 1, this.chk(i + 1, (sf ? this.d[25 + i] * 4096 : this.d[25 + i]) + ir[i] * ir0), sf, lm);\\n    this.pushColor();\\n  }\\n  avsz(zsf, n) {\\n    const d = this.d, z = i => d[i] & 0xFFFF;\\n    const sum = n === 3 ? z(17) + z(18) + z(19) : z(16) + z(17) + z(18) + z(19);\\n    const m = this.chk0(zsf * sum); d[24] = trunc32(m);\\n    const o = Math.floor(m / 4096);                                                       // MAC0 sem truncar (hardware)\\n    if (o < 0) { d[7] = 0; this.flag |= 1 << 18; } else if (o > 0xFFFF) { d[7] = 0xFFFF; this.flag |= 1 << 18; } else d[7] = o;\\n  }\\n\\n  mvmva(cmd, sf, lm) {\\n    const mx = (cmd >> 17) & 3, vx = (cmd >> 15) & 3, tx = (cmd >> 13) & 3, c = this.c, d = this.d;\\n    const M = mx === 0 ? this.rt : mx === 1 ? this.ll : mx === 2 ? this.lc\\n      : Int16Array.from([-((d[6] & 255) << 4), (d[6] & 255) << 4, s16(d[8]), this.rt[2], this.rt[2], this.rt[2], this.rt[4], this.rt[4], this.rt[4]]);   // matriz \\\"lixo\\\"\\n    const v = vx === 3 ? this.ir() : this.vec(vx);\\n    if (tx === 2) {                                                                      // translation FC: bug do hardware\\n      for (let r = 0; r < 3; r++) {\\n        const part = this.chk(r + 1, c[53 + r] * 4096 + M[r * 3] * v[0]);                  // só levanta flags; resultado descartado\\n        const pv = sar(part, sf), lo = lm ? 0 : -0x8000;                                  // ...inclusive a de saturação de IR da soma parcial\\n        if (pv < lo || pv > 0x7FFF) this.flag |= 1 << (24 - r);\\n        const t = this.chk(r + 1, M[r * 3 + 1] * v[1] + M[r * 3 + 2] * v[2]);\\n        this.setMac(r + 1, t, sf); this.setIr(r + 1, d[25 + r], lm);\\n      }\\n      return;\\n    }\\n    const tr = tx === 0 ? [c[37], c[38], c[39]] : tx === 1 ? [c[45], c[46], c[47]] : null;\\n    this.mulMat(M, v, tr, sf, lm);\\n  }\\n}\\n\\nreturn { GTE };\\n})();\\nconst __src_cpu = (() => {\\n// ============================================================================\\n//  CPU MIPS R3000A (LSI LR33300) do PS1 - interpretador\\n// ============================================================================\\n//  Características emuladas:\\n//   - 32 registradores + HI/LO\\n//   - Branch delay slot (modelo pc / nextPc)\\n//   - Load delay slot (1 instrução, com cancelamento e forwarding p/ LWL/LWR)\\n//   - COP0: SR, CAUSE, EPC, BadVAddr, PRID, breakpoints (só armazenados)\\n//   - Exceções (IRQ, AdEL, AdES, SYSCALL, BREAK, RI, CpU, Overflow)\\n//   - Cache isolado (SR.IsC): escritas não chegam à memória\\n//   - COP2 (GTE): acesso aos registradores; comandos ainda em stub\\n//\\n//  NÃO emulado ainda: I-Cache (só importa p/ código auto-modificável),\\n//  timing real de MULT/DIV, bus error, write buffer, GTE.\\n// ============================================================================\\nconst { GTE } = __src_gte;\\nconst EXC = { INT: 0, ADEL: 4, ADES: 5, IBE: 6, DBE: 7, SYS: 8, BP: 9, RI: 10, CPU: 11, OV: 12 };\\n\\nconst REG_NAMES = [\\n  'zero', 'at', 'v0', 'v1', 'a0', 'a1', 'a2', 'a3',\\n  't0', 't1', 't2', 't3', 't4', 't5', 't6', 't7',\\n  's0', 's1', 's2', 's3', 's4', 's5', 's6', 's7',\\n  't8', 't9', 'k0', 'k1', 'gp', 'sp', 'fp', 'ra',\\n];\\n\\n// COP0 register indices\\nconst C0_BPC = 3, C0_BDA = 5, C0_JUMPDEST = 6, C0_DCIC = 7, C0_BADVADDR = 8,\\n      C0_BDAM = 9, C0_BPCM = 11, C0_SR = 12, C0_CAUSE = 13, C0_EPC = 14, C0_PRID = 15;\\n\\nconst SR_IEC = 0x1, SR_KUC = 0x2, SR_ISC = 0x10000, SR_BEV = 0x400000,\\n      SR_CU0 = 0x10000000, SR_CU2 = 0x40000000;\\nconst SR_WRITE_MASK = 0xF27FFF3F;\\n\\nconst RESET_VECTOR = 0xBFC00000;\\n\\n// custo extra (ciclos, além do 1 da instrução) de um load, por região e largura (1/2/4 bytes).\\n// Valores medidos no PS1 real com ps1-tests/cpu/access-time (ciclos por acesso - 1).\\nconst LD_RAM = 4;\\nfunction memCost(a, size = 4) {\\n  const p = a & 0x1FFFFFFF, k = size === 1 ? 0 : size === 2 ? 1 : 2;\\n  if (p < 0x800000) return LD_RAM;                                                    // RAM\\n  if (p >= 0x1FC00000) return [6, 12, 24][k];                                         // BIOS ROM (barramento de 8 bits)\\n  if (p >= 0x1FA00000) return [6, 5, 9][k];                                           // expansão 3\\n  if (p >= 0x1F800000) {\\n    if (p < 0x1F800400) return 0;                                                     // scratchpad\\n    if (p >= 0x1F802000) return [10, 25, 55][k];                                      // expansão 2\\n    if (p >= 0x1F801C00) return [17, 17, 38][k];                                      // SPU\\n    if (p >= 0x1F801800 && p < 0x1F801804) return [6, 13, 25][k];                     // CD-ROM\\n    return 2;                                                                         // registradores de I/O\\n  }\\n  if (p >= 0x1F000000) return [5, 12, 24][k];                                         // expansão 1\\n  return 3;\\n}\\n\\nclass CPU {\\n  constructor(bus) {\\n    this.bus = bus;\\n    this.gte = new GTE();\\n    this.r = new Uint32Array(32);\\n    this.cop0 = new Uint32Array(32);\\n    this.reset();\\n  }\\n\\n  reset() {\\n    this.r.fill(0);\\n    this.cop0.fill(0);\\n    this.hi = 0; this.lo = 0;\\n    this.pc = RESET_VECTOR;\\n    this.nextPc = RESET_VECTOR + 4;\\n    this.currentPc = this.pc;\\n    this.isBranch = false;     // a instrução atual é um branch/jump?\\n    this.inDelay = false;      // a instrução atual está num delay slot?\\n    // load delay: carga pendente vinda da instrução anterior\\n    this.pendReg = 0; this.pendVal = 0;\\n    // carga gerada pela instrução atual (vira pendente no próximo passo)\\n    this.nextLdReg = 0; this.nextLdVal = 0;\\n    this.wr = 0;               // registrador escrito pela instrução atual\\n    this.cop0[C0_SR] = SR_BEV; // BEV=1 após reset\\n    this.cop0[C0_PRID] = 0x00000002;\\n    this.cycles = 0;\\n    this.instrCount = 0;\\n  }\\n\\n  // -------------------------------------------------------------------------\\n  //  Helpers\\n  // -------------------------------------------------------------------------\\n  setR(i, v) { this.r[i] = v; this.wr = i; }\\n  setLoad(i, v) { this.nextLdReg = i; this.nextLdVal = v; }\\n\\n  jump(target) { this.nextPc = target >>> 0; this.isBranch = true; }\\n\\n  exception(code, cop = 0) {\\n    const c0 = this.cop0;\\n    const sr = c0[C0_SR];\\n    const handler = (sr & SR_BEV) ? 0xBFC00180 : 0x80000080;\\n    // empilha o modo: (KUo,IEo)<-(KUp,IEp)<-(KUc,IEc)<-0\\n    c0[C0_SR] = (sr & 0xFFFFFFC0) | ((sr << 2) & 0x3F);\\n    let cause = (c0[C0_CAUSE] & ~0x3000007C) | (code << 2) | (cop << 28);\\n    if (this.inDelay) {\\n      c0[C0_EPC] = (this.currentPc - 4) >>> 0;\\n      cause |= 0x80000000;                       // BD\\n    } else {\\n      c0[C0_EPC] = this.currentPc;\\n      cause &= 0x7FFFFFFF;\\n    }\\n    c0[C0_CAUSE] = cause;\\n    this.pc = handler;\\n    this.nextPc = (handler + 4) >>> 0;\\n    this.isBranch = false;\\n  }\\n\\n  addrError(addr, store) {\\n    this.cop0[C0_BADVADDR] = addr;\\n    this.exception(store ? EXC.ADES : EXC.ADEL);\\n  }\\n\\n  // leitura/escrita de memória com checagem de alinhamento, modo usuário e cache isolado\\n  rdMem(a, size) {\\n    if ((a & (size - 1)) !== 0 || ((a & 0x80000000) && (this.cop0[C0_SR] & SR_KUC))) {\\n      this.addrError(a, false); return null;\\n    }\\n    if (this.cop0[C0_SR] & SR_ISC) return 0;\\n    this.cycles += memCost(a, size);                 // custo de acesso por região/largura\\n    return this.bus.read(a, size);\\n  }\\n  wrMem(a, size, v) {\\n    if ((a & (size - 1)) !== 0 || ((a & 0x80000000) && (this.cop0[C0_SR] & SR_KUC))) {\\n      this.addrError(a, true); return false;\\n    }\\n    if (this.cop0[C0_SR] & SR_ISC) return true;   // cache isolado: escrita vai pra \\\"cache\\\" e some\\n    this.bus.write(a, size, v);\\n    return true;\\n  }\\n\\n  writeCop0(n, v) {\\n    const c0 = this.cop0;\\n    switch (n) {\\n      case C0_BPC: case C0_BDA: case C0_DCIC: case C0_BDAM: case C0_BPCM:\\n        c0[n] = v; break;\\n      case C0_SR: c0[C0_SR] = v & SR_WRITE_MASK; break;\\n      case C0_CAUSE: c0[C0_CAUSE] = (c0[C0_CAUSE] & ~0x300) | (v & 0x300); break;\\n      default: break;                              // BadVAddr/EPC/PRID/JUMPDEST: somente leitura\\n    }\\n  }\\n\\n  // multiplicação 32x32 -> 64 sem BigInt\\n  mul64(a, b, signed) {\\n    const a0 = a & 0xFFFF, a1 = a >>> 16, b0 = b & 0xFFFF, b1 = b >>> 16;\\n    const p00 = a0 * b0, p01 = a0 * b1, p10 = a1 * b0, p11 = a1 * b1;\\n    const mid = p01 + p10 + (p00 >>> 16);\\n    this.lo = (((mid & 0xFFFF) << 16) | (p00 & 0xFFFF)) >>> 0;\\n    let hi = p11 + Math.floor(mid / 65536);\\n    if (signed) hi -= (a >>> 31 ? b : 0) + (b >>> 31 ? a : 0);\\n    this.hi = hi >>> 0;\\n  }\\n\\n  div(a, b) {\\n    const n = a | 0, d = b | 0;\\n    if (d === 0) { this.hi = n >>> 0; this.lo = n >= 0 ? 0xFFFFFFFF : 1; }\\n    else if (n === -2147483648 && d === -1) { this.hi = 0; this.lo = 0x80000000; }\\n    else { this.lo = ((n / d) | 0) >>> 0; this.hi = (n % d) >>> 0; }\\n  }\\n  divu(n, d) {\\n    if (d === 0) { this.hi = n; this.lo = 0xFFFFFFFF; }\\n    else { this.lo = Math.floor(n / d) >>> 0; this.hi = n % d; }\\n  }\\n\\n  // -------------------------------------------------------------------------\\n  //  Um passo = uma instrução\\n  // -------------------------------------------------------------------------\\n  step() {\\n    const lr = this.pendReg, lv = this.pendVal;\\n    this.nextLdReg = 0; this.wr = 0;\\n\\n    this.execute();\\n\\n    // aplica a carga da instrução anterior, a menos que esta tenha escrito o mesmo reg\\n    if (lr !== 0 && lr !== this.wr) this.r[lr] = lv;\\n    this.pendReg = this.nextLdReg; this.pendVal = this.nextLdVal;\\n    this.r[0] = 0;\\n    this.cycles++; this.instrCount++;\\n  }\\n\\n  execute() {\\n    const bus = this.bus, r = this.r, c0 = this.cop0;\\n    const cur = this.pc;\\n    this.currentPc = cur;\\n    this.inDelay = this.isBranch;\\n    this.isBranch = false;\\n\\n    // ---- interrupções ----\\n    if (bus.irqPending()) c0[C0_CAUSE] |= 0x400; else c0[C0_CAUSE] &= ~0x400;\\n    const sr = c0[C0_SR];\\n    if ((sr & SR_IEC) && (c0[C0_CAUSE] & sr & 0xFF00)) { this.exception(EXC.INT); return; }\\n\\n    // ---- fetch ----\\n    if (cur & 3) { c0[C0_BADVADDR] = cur; this.exception(EXC.ADEL); return; }\\n    const w = bus.read(cur, 4);\\n    if (cur >= 0xA0000000 && cur < 0xC0000000) this.cycles += (cur & 0x1FFFFFFF) >= 0x1FC00000 ? 22 : 4;   // fetch sem cache\\n    this.pc = this.nextPc;\\n    this.nextPc = (this.nextPc + 4) >>> 0;\\n\\n    const op = w >>> 26, rs = (w >>> 21) & 31, rt = (w >>> 16) & 31, rd = (w >>> 11) & 31;\\n    const sh = (w >>> 6) & 31, imm = w & 0xFFFF, simm = (w << 16) >> 16;\\n\\n    switch (op) {\\n      // ======================= SPECIAL =======================\\n      case 0x00:\\n        switch (w & 0x3F) {\\n          case 0x00: this.setR(rd, r[rt] << sh); return;                    // SLL\\n          case 0x02: this.setR(rd, r[rt] >>> sh); return;                   // SRL\\n          case 0x03: this.setR(rd, (r[rt] | 0) >> sh); return;              // SRA\\n          case 0x04: this.setR(rd, r[rt] << (r[rs] & 31)); return;          // SLLV\\n          case 0x06: this.setR(rd, r[rt] >>> (r[rs] & 31)); return;         // SRLV\\n          case 0x07: this.setR(rd, (r[rt] | 0) >> (r[rs] & 31)); return;    // SRAV\\n          case 0x08: this.jump(r[rs]); return;                              // JR\\n          case 0x09: { const t = r[rs]; this.setR(rd, cur + 8); this.jump(t); return; } // JALR\\n          case 0x0C: this.exception(EXC.SYS); return;                       // SYSCALL\\n          case 0x0D: this.exception(EXC.BP); return;                        // BREAK\\n          case 0x10: this.setR(rd, this.hi); return;                        // MFHI\\n          case 0x11: this.hi = r[rs]; return;                               // MTHI\\n          case 0x12: this.setR(rd, this.lo); return;                        // MFLO\\n          case 0x13: this.lo = r[rs]; return;                               // MTLO\\n          case 0x18: this.mul64(r[rs], r[rt], true); return;                // MULT\\n          case 0x19: this.mul64(r[rs], r[rt], false); return;               // MULTU\\n          case 0x1A: this.div(r[rs], r[rt]); return;                        // DIV\\n          case 0x1B: this.divu(r[rs], r[rt]); return;                       // DIVU\\n          case 0x20: {                                                      // ADD\\n            const a = r[rs] | 0, b = r[rt] | 0, s = (a + b) | 0;\\n            if (((a ^ s) & (b ^ s)) < 0) { this.exception(EXC.OV); return; }\\n            this.setR(rd, s); return;\\n          }\\n          case 0x21: this.setR(rd, r[rs] + r[rt]); return;                  // ADDU\\n          case 0x22: {                                                      // SUB\\n            const a = r[rs] | 0, b = r[rt] | 0, s = (a - b) | 0;\\n            if (((a ^ b) & (a ^ s)) < 0) { this.exception(EXC.OV); return; }\\n            this.setR(rd, s); return;\\n          }\\n          case 0x23: this.setR(rd, r[rs] - r[rt]); return;                  // SUBU\\n          case 0x24: this.setR(rd, r[rs] & r[rt]); return;                  // AND\\n          case 0x25: this.setR(rd, r[rs] | r[rt]); return;                  // OR\\n          case 0x26: this.setR(rd, r[rs] ^ r[rt]); return;                  // XOR\\n          case 0x27: this.setR(rd, ~(r[rs] | r[rt])); return;               // NOR\\n          case 0x2A: this.setR(rd, (r[rs] | 0) < (r[rt] | 0) ? 1 : 0); return; // SLT\\n          case 0x2B: this.setR(rd, r[rs] < r[rt] ? 1 : 0); return;          // SLTU\\n          default: this.exception(EXC.RI); return;\\n        }\\n\\n      // ======================= REGIMM (BLTZ/BGEZ/BLTZAL/BGEZAL) =======================\\n      case 0x01: {\\n        const v = r[rs] | 0;\\n        const cond = (rt & 1) ? v >= 0 : v < 0;\\n        if ((rt & 0x1E) === 0x10) this.setR(31, cur + 8);      // link sempre, mesmo sem tomar o branch\\n        this.isBranch = true;\\n        if (cond) this.nextPc = (cur + 4 + (simm << 2)) >>> 0;\\n        return;\\n      }\\n\\n      // ======================= Jumps =======================\\n      case 0x02: this.nextPc = ((this.pc & 0xF0000000) | ((w & 0x3FFFFFF) << 2)) >>> 0; this.isBranch = true; return; // J\\n      case 0x03: this.setR(31, cur + 8);                                                                              // JAL\\n                 this.nextPc = ((this.pc & 0xF0000000) | ((w & 0x3FFFFFF) << 2)) >>> 0; this.isBranch = true; return;\\n\\n      // ======================= Branches =======================\\n      case 0x04: this.isBranch = true; if (r[rs] === r[rt]) this.nextPc = (cur + 4 + (simm << 2)) >>> 0; return;  // BEQ\\n      case 0x05: this.isBranch = true; if (r[rs] !== r[rt]) this.nextPc = (cur + 4 + (simm << 2)) >>> 0; return;  // BNE\\n      case 0x06: this.isBranch = true; if ((r[rs] | 0) <= 0) this.nextPc = (cur + 4 + (simm << 2)) >>> 0; return; // BLEZ\\n      case 0x07: this.isBranch = true; if ((r[rs] | 0) > 0)  this.nextPc = (cur + 4 + (simm << 2)) >>> 0; return; // BGTZ\\n\\n      // ======================= Imediatos =======================\\n      case 0x08: {                                                          // ADDI\\n        const a = r[rs] | 0, s = (a + simm) | 0;\\n        if (((a ^ s) & (simm ^ s)) < 0) { this.exception(EXC.OV); return; }\\n        this.setR(rt, s); return;\\n      }\\n      case 0x09: this.setR(rt, r[rs] + simm); return;                       // ADDIU\\n      case 0x0A: this.setR(rt, (r[rs] | 0) < simm ? 1 : 0); return;         // SLTI\\n      case 0x0B: this.setR(rt, r[rs] < (simm >>> 0) ? 1 : 0); return;       // SLTIU\\n      case 0x0C: this.setR(rt, r[rs] & imm); return;                        // ANDI\\n      case 0x0D: this.setR(rt, r[rs] | imm); return;                        // ORI\\n      case 0x0E: this.setR(rt, r[rs] ^ imm); return;                        // XORI\\n      case 0x0F: this.setR(rt, imm << 16); return;                          // LUI\\n\\n      // ======================= COP0 =======================\\n      case 0x10:\\n        if ((sr & SR_KUC) && !(sr & SR_CU0)) { this.exception(EXC.CPU, 0); return; }\\n        switch (rs) {\\n          case 0x00: this.setLoad(rt, c0[rd]); return;                      // MFC0 (tem load delay)\\n          case 0x04: this.writeCop0(rd, r[rt]); return;                     // MTC0\\n          case 0x10:\\n            if ((w & 0x3F) === 0x10) {                                      // RFE\\n              c0[C0_SR] = (sr & 0xFFFFFFF0) | ((sr >>> 2) & 0xF); return;\\n            }\\n            this.exception(EXC.RI); return;\\n          default: return;                                                  // cop0 com rs desconhecido: não gera exceção no console (ps1-tests/cpu/cop)\\n        }\\n\\n      // ======================= COP2 (GTE) =======================\\n      case 0x12:\\n        if (!(sr & SR_CU2)) { this.exception(EXC.CPU, 2); return; }\\n        if (w & 0x02000000) { this.gte.command(w & 0x1FFFFFF); return; }    // comando GTE\\n        switch (rs) {\\n          case 0x00: this.setLoad(rt, this.gte.readData(rd)); return;       // MFC2\\n          case 0x02: this.setLoad(rt, this.gte.readCtrl(rd)); return;       // CFC2\\n          case 0x04: this.gte.writeData(rd, r[rt]); return;                 // MTC2\\n          case 0x06: this.gte.writeCtrl(rd, r[rt]); return;                 // CTC2\\n          default: this.exception(EXC.RI); return;\\n        }\\n\\n      // COP1/COP3 e LWC/SWC 0,1,3 não existem no PS1 -> Coprocessor Unusable\\n      // só geram a exceção se o bit CU do coprocessador estiver desligado; ligado, são NOPs\\n      case 0x11: case 0x13: case 0x30: case 0x31: case 0x33: case 0x38: case 0x39: case 0x3B:\\n        if (!(sr & (0x10000000 << (op & 3)))) this.exception(EXC.CPU, op & 3);\\n        return;\\n\\n      // ======================= Loads =======================\\n      case 0x20: { const v = this.rdMem((r[rs] + simm) >>> 0, 1); if (v === null) return; this.setLoad(rt, (v << 24) >> 24); return; } // LB\\n      case 0x21: { const v = this.rdMem((r[rs] + simm) >>> 0, 2); if (v === null) return; this.setLoad(rt, (v << 16) >> 16); return; } // LH\\n      case 0x23: { const v = this.rdMem((r[rs] + simm) >>> 0, 4); if (v === null) return; this.setLoad(rt, v); return; }               // LW\\n      case 0x24: { const v = this.rdMem((r[rs] + simm) >>> 0, 1); if (v === null) return; this.setLoad(rt, v); return; }               // LBU\\n      case 0x25: { const v = this.rdMem((r[rs] + simm) >>> 0, 2); if (v === null) return; this.setLoad(rt, v); return; }               // LHU\\n      case 0x22: {                                                          // LWL\\n        const a = (r[rs] + simm) >>> 0;\\n        const m = this.rdMem((a & 0xFFFFFFFC) >>> 0, 4); if (m === null) return;\\n        const c = (this.pendReg === rt) ? this.pendVal : r[rt];             // enxerga a carga em andamento\\n        let v;\\n        switch (a & 3) {\\n          case 0: v = (c & 0x00FFFFFF) | (m << 24); break;\\n          case 1: v = (c & 0x0000FFFF) | (m << 16); break;\\n          case 2: v = (c & 0x000000FF) | (m << 8); break;\\n          default: v = m;\\n        }\\n        this.setLoad(rt, v); return;\\n      }\\n      case 0x26: {                                                          // LWR\\n        const a = (r[rs] + simm) >>> 0;\\n        const m = this.rdMem((a & 0xFFFFFFFC) >>> 0, 4); if (m === null) return;\\n        const c = (this.pendReg === rt) ? this.pendVal : r[rt];\\n        let v;\\n        switch (a & 3) {\\n          case 0: v = m; break;\\n          case 1: v = (c & 0xFF000000) | (m >>> 8); break;\\n          case 2: v = (c & 0xFFFF0000) | (m >>> 16); break;\\n          default: v = (c & 0xFFFFFF00) | (m >>> 24);\\n        }\\n        this.setLoad(rt, v); return;\\n      }\\n      case 0x32: { if (!(sr & SR_CU2)) { this.exception(EXC.CPU, 2); return; } const v = this.rdMem((r[rs] + simm) >>> 0, 4); if (v === null) return; this.gte.writeData(rt, v); return; } // LWC2\\n\\n      // ======================= Stores =======================\\n      case 0x28: this.wrMem((r[rs] + simm) >>> 0, 1, r[rt] & 0xFF); return;   // SB\\n      case 0x29: this.wrMem((r[rs] + simm) >>> 0, 2, r[rt] & 0xFFFF); return; // SH\\n      case 0x2B: this.wrMem((r[rs] + simm) >>> 0, 4, r[rt]); return;          // SW\\n      case 0x2A: {                                                          // SWL\\n        const a = (r[rs] + simm) >>> 0, al = (a & 0xFFFFFFFC) >>> 0;\\n        const m = this.rdMem(al, 4); if (m === null) return;\\n        const t = r[rt]; let v;\\n        switch (a & 3) {\\n          case 0: v = (m & 0xFFFFFF00) | (t >>> 24); break;\\n          case 1: v = (m & 0xFFFF0000) | (t >>> 16); break;\\n          case 2: v = (m & 0xFF000000) | (t >>> 8); break;\\n          default: v = t;\\n        }\\n        this.wrMem(al, 4, v >>> 0); return;\\n      }\\n      case 0x2E: {                                                          // SWR\\n        const a = (r[rs] + simm) >>> 0, al = (a & 0xFFFFFFFC) >>> 0;\\n        const m = this.rdMem(al, 4); if (m === null) return;\\n        const t = r[rt]; let v;\\n        switch (a & 3) {\\n          case 0: v = t; break;\\n          case 1: v = (m & 0x000000FF) | (t << 8); break;\\n          case 2: v = (m & 0x0000FFFF) | (t << 16); break;\\n          default: v = (m & 0x00FFFFFF) | (t << 24);\\n        }\\n        this.wrMem(al, 4, v >>> 0); return;\\n      }\\n      case 0x3A: if (!(sr & SR_CU2)) { this.exception(EXC.CPU, 2); return; } this.wrMem((r[rs] + simm) >>> 0, 4, this.gte.readData(rt)); return; // SWC2\\n\\n      default: this.exception(EXC.RI); return;\\n    }\\n  }\\n\\n  dump() {\\n    let s = `PC=${hex(this.pc)} NPC=${hex(this.nextPc)} HI=${hex(this.hi)} LO=${hex(this.lo)}\\\\n`;\\n    for (let i = 0; i < 32; i += 4) {\\n      s += [0, 1, 2, 3].map(j => `${REG_NAMES[i + j].padStart(4)}=${hex(this.r[i + j])}`).join('  ') + '\\\\n';\\n    }\\n    s += `SR=${hex(this.cop0[C0_SR])} CAUSE=${hex(this.cop0[C0_CAUSE])} EPC=${hex(this.cop0[C0_EPC])} BADV=${hex(this.cop0[C0_BADVADDR])}`;\\n    return s;\\n  }\\n}\\n\\nconst hex = (v, n = 8) => (v >>> 0).toString(16).toUpperCase().padStart(n, '0');\\n\\nreturn { EXC, REG_NAMES, RESET_VECTOR, LD_RAM, memCost, CPU, hex };\\n})();\\nconst __src_jit = (() => {\\n// ============================================================================\\n//  Recompilador dinâmico MIPS R3000A -> JavaScript\\n// ============================================================================\\n//  Cada \\\"bloco\\\" é uma sequência linear de instruções que começa num PC e termina\\n//  num branch/jump (incluindo o delay slot), SYSCALL/BREAK, MTC0 em SR/CAUSE, RFE\\n//  ou ao atingir MAX_BLOCK instruções. O bloco vira uma função JS (new Function).\\n//\\n//  Semântica preservada em relação ao interpretador (cpu.js):\\n//   - delay slot de branch e load delay slot são resolvidos ESTATICAMENTE na geração\\n//     (a carga pendente cruza o fim do bloco via cpu.pendReg/pendVal; se um bloco é\\n//     entrado com carga pendente, roda-se 1 passo no interpretador);\\n//   - exceções (AdEL/AdES/Overflow/SYSCALL/BREAK/RI/CpU) saem do bloco com o estado exato\\n//     (EPC, BD, BadVAddr, ciclos, instrCount);\\n//   - ciclos: 1/instrução + custo de fetch KSEG1 + 5 por load (corrigido no acesso lento),\\n//     descarregados em cpu.cycles antes de cada acesso à memória (I/O vê o relógio certo);\\n//   - interrupções são verificadas na ENTRADA de cada bloco (blocos curtos: ≤ MAX_BLOCK).\\n//  Blocos só são usados em modo kernel e sem cache isolado; senão cai no interpretador.\\n//\\n//  Invalidação: a RAM é dividida em linhas de 64 B; bus.codeFlags marca as que têm código.\\n//  Escritas da CPU (inline), do interpretador e de DMA chamam bus.onCodeWrite -> descarta os\\n//  blocos que tocam a linha.\\n// ============================================================================\\nconst { EXC, memCost, LD_RAM } = __src_cpu;\\nconst MAX_BLOCK = 48;\\nconst INTERP = function interp() {};            // sentinela: \\\"este PC é executado pelo interpretador\\\"\\n\\nconst isBranchWord = w => {\\n  const op = w >>> 26;\\n  return op === 1 || (op >= 2 && op <= 7) || (op === 0 && ((w & 0x3F) === 8 || (w & 0x3F) === 9));\\n};\\n\\nclass JIT {\\n  constructor(cpu, bus) {\\n    this.cpu = cpu; this.bus = bus; this.epoch = 0;\\n    this.gp = new Uint32Array(0x4000); this.gb = new Array(0x4000).fill(null); this.ge = new Int32Array(0x4000).fill(-1);\\n    this.cf = bus.codeFlags;\\n    this.lineBlocks = new Array(this.cf.length).fill(null);\\n    this.tables = [];\\n    this.stats = { compiled: 0, interp: 0, invalidations: 0, loops: 0, inlined: 0 };\\n    bus.onCodeWrite = o => this.invalidateLine(o >>> 6);\\n\\n    const ram = bus.ram;\\n    const self = this;\\n    this.H = {\\n      r: cpu.r, c0: cpu.cop0, gte: cpu.gte, bus, ps: { nextTick: 0 }, J: this,   // ps: o PSX (nextTick) para laços internos; J: este JIT (epoch)\\n      ram8: ram, ram16: new Uint16Array(ram.buffer, ram.byteOffset, ram.length >> 1), ram32: new Uint32Array(ram.buffer, ram.byteOffset, ram.length >> 2),\\n      cf: this.cf,\\n      inv: o => self.invalidateLine(o >>> 6),\\n      rd(a, size) { cpu.cycles += memCost(a, size) - LD_RAM; return bus.read(a, size); },\\n      lwl(a, c) {\\n        const m = this.rd((a & 0xFFFFFFFC) >>> 0, 4);\\n        switch (a & 3) { case 0: return (c & 0x00FFFFFF) | (m << 24); case 1: return (c & 0x0000FFFF) | (m << 16); case 2: return (c & 0x000000FF) | (m << 8); default: return m; }\\n      },\\n      lwr(a, c) {\\n        const m = this.rd((a & 0xFFFFFFFC) >>> 0, 4);\\n        switch (a & 3) { case 0: return m; case 1: return (c & 0xFF000000) | (m >>> 8); case 2: return (c & 0xFFFF0000) | (m >>> 16); default: return (c & 0xFFFFFF00) | (m >>> 24); }\\n      },\\n      swl(a, t) {\\n        const al = (a & 0xFFFFFFFC) >>> 0, m = this.rd(al, 4); let v;\\n        switch (a & 3) { case 0: v = (m & 0xFFFFFF00) | (t >>> 24); break; case 1: v = (m & 0xFFFF0000) | (t >>> 16); break; case 2: v = (m & 0xFF000000) | (t >>> 8); break; default: v = t; }\\n        bus.write(al, 4, v >>> 0);\\n      },\\n      swr(a, t) {\\n        const al = (a & 0xFFFFFFFC) >>> 0, m = this.rd(al, 4); let v;\\n        switch (a & 3) { case 0: v = t; break; case 1: v = (m & 0x000000FF) | (t << 8); break; case 2: v = (m & 0x0000FFFF) | (t << 16); break; default: v = (m & 0x00FFFFFF) | (t << 24); }\\n        bus.write(al, 4, v >>> 0);\\n      },\\n    };\\n  }\\n\\n  /** descarta tudo (após carregar código na RAM por fora, reset, etc.) */\\n  flush() {\\n    this.tables = []; this.cf.fill(0); this.lineBlocks.fill(null); this.epoch++;\\n  }\\n\\n  invalidateLine(l) {\\n    this.epoch++;\\n    const list = this.lineBlocks[l];\\n    if (list) { for (const e of list) e.t[e.i] = undefined; this.lineBlocks[l] = null; this.stats.invalidations++; }\\n    this.cf[l] = 0;\\n  }\\n\\n  table(key, size) {\\n    return this.tables[key] || (this.tables[key] = new Array(size).fill(undefined));\\n  }\\n\\n  /** executa um bloco (ou 1 instrução no interpretador, nos casos especiais) */\\n  exec() {\\n    const cpu = this.cpu, c0 = cpu.cop0, sr = c0[12], pc = cpu.pc;\\n    if (cpu.isBranch || cpu.pendReg !== 0 || (sr & 0x10002) !== 0 || (pc & 3) !== 0) { cpu.step(); return; }\\n    if (this.bus.irqPending()) c0[13] |= 0x400; else c0[13] &= ~0x400;\\n    if ((sr & 1) && (c0[13] & sr & 0xFF00)) { cpu.step(); return; }\\n\\n    const seg = pc >>> 29;\\n    if (seg >= 6) { cpu.step(); return; }\\n    const phys = seg < 4 ? pc : (seg === 4 ? pc & 0x7FFFFFFF : pc & 0x1FFFFFFF);\\n    let t, idx, isRam;\\n    if (phys < 0x800000) { t = this.table(seg * 2, 0x80000); idx = (phys & 0x1FFFFF) >>> 2; isRam = true; }\\n    else if (phys >= 0x1FC00000 && phys < 0x1FC80000) { t = this.table(seg * 2 + 1, 0x20000); idx = (phys - 0x1FC00000) >>> 2; isRam = false; }\\n    else { cpu.step(); return; }\\n\\n    let b = t[idx];\\n    if (b === undefined) b = t[idx] = this.compile(pc, isRam, t, idx);\\n    if (b === INTERP) { cpu.step(); return; }\\n    b();\\n  }\\n\\n  /** laço quente: executa blocos até cpu.cycles alcançar psx.nextTick (mesma lógica de exec(), sem a sobrecarga por chamada).\\n   *  Encadeamento: cada bloco lembra o último sucessor (b.lp = pc, b.lb = bloco, b.le = época); qualquer invalidação/flush muda a época. */\\n  runBlocks(psx) {\\n    const cpu = this.cpu, c0 = cpu.cop0, bus = this.bus, hook = psx.hookTTY;\\n    const gp = this.gp, gb = this.gb, ge = this.ge;                  // cache global direto-mapeado pc -> bloco (evita a busca nas tabelas)\\n    let prev = null;\\n    while (cpu.cycles < psx.nextTick) {\\n      const sr = c0[12], pc = cpu.pc;\\n      if (cpu.isBranch || cpu.pendReg !== 0 || (sr & 0x10002) !== 0 || (pc & 3) !== 0) { cpu.step(); prev = null; continue; }\\n      let cz = c0[13];\\n      if (bus.istat & bus.imask) { if ((cz & 0x400) === 0) c0[13] = cz |= 0x400; } else if ((cz & 0x400) !== 0) c0[13] = cz &= ~0x400;\\n      if ((sr & 1) && (cz & sr & 0xFF00)) { cpu.step(); prev = null; continue; }\\n      let b;\\n      if (prev !== null && prev.lp === pc && prev.le === this.epoch) b = prev.lb;\\n      else if (gp[(pc >>> 2) & 0x3FFF] === pc && ge[(pc >>> 2) & 0x3FFF] === this.epoch) {\\n        b = gb[(pc >>> 2) & 0x3FFF];\\n        if (prev !== null) { prev.lp = pc; prev.lb = b; prev.le = this.epoch; }\\n      } else {\\n        const seg = pc >>> 29;\\n        if (seg >= 6) { cpu.step(); prev = null; continue; }\\n        const phys = seg < 4 ? pc : (seg === 4 ? pc & 0x7FFFFFFF : pc & 0x1FFFFFFF);\\n        let t, idx, isRam;\\n        if (phys < 0x800000) {\\n          if (hook && (phys === 0xA0 || phys === 0xB0)) { psx.tty(); }\\n          t = this.tables[seg * 2] || this.table(seg * 2, 0x80000); idx = (phys & 0x1FFFFF) >>> 2; isRam = true;\\n        } else if (phys >= 0x1FC00000 && phys < 0x1FC80000) { t = this.tables[seg * 2 + 1] || this.table(seg * 2 + 1, 0x20000); idx = (phys - 0x1FC00000) >>> 2; isRam = false; }\\n        else { cpu.step(); prev = null; continue; }\\n        b = t[idx];\\n        if (b === undefined) b = t[idx] = this.compile(pc, isRam, t, idx);\\n        if (b === INTERP) { cpu.step(); prev = null; continue; }\\n        if (!(hook && phys < 0x100)) {\\n          if (prev !== null) { prev.lp = pc; prev.lb = b; prev.le = this.epoch; }\\n          const h = (pc >>> 2) & 0x3FFF; gp[h] = pc; gb[h] = b; ge[h] = this.epoch;\\n        }\\n      }\\n      b(); prev = b;\\n    }\\n  }\\n\\n  // -------------------------------------------------------------------------\\n  //  Geração de código\\n  // -------------------------------------------------------------------------\\n  compile(startPc, isRam, tbl, tidx) {\\n    const cpu = this.cpu, bus = this.bus;\\n    const code = [];\\n    let unf = 0, cnt = 0, k = 0, pend = null, ipc = startPc, delay = false;\\n    const tmp = () => 't' + (k++);\\n    const dirty = new Set();                                         // registradores MIPS escritos até aqui (vivem em variáveis locais r<N>; gravados em r[] nas saídas)\\n    const R = n => n === 0 ? '0' : `r${n}`;\\n    const flushSets = [];                                            // pontos de gravação dos registradores: marcador \\\\u0001<id>\\\\u0002, resolvido no fim\\n    const flushRegs = () => { let o = ''; for (const n of dirty) o += `r[${n}]=r${n};`; flushSets.push(o); return `\\\\u0001${flushSets.length - 1}\\\\u0002`; };\\n    let hasLoop = false, knownRa = null, segStart = startPc; const segs = [], vis = new Set();\\n    const fetchCost = a => (a >>> 29) === 5 ? (((a & 0x1FFFFFFF) >= 0x1FC00000) ? 22 : 4) : 0;\\n    const pendApply = () => pend ? `r[${pend.reg}]=${pend.tmp};` : '';\\n    const X = (c, cop = 0, bad = null, refund = 0) =>\\n      `{cpu.cycles+=${unf - refund};cpu.instrCount+=${cnt};${flushRegs()}${pendApply()}cpu.currentPc=${ipc};cpu.inDelay=${delay};${bad ? `c0[8]=${bad};` : ''}cpu.exception(${c},${cop});return;}`;\\n    const flushCyc = () => { if (unf) { code.push(`cpu.cycles+=${unf};`); unf = 0; } };\\n    const RAMFAST = a => `(${a}&0x1FFFFFFF)<0x800000`;\\n\\n    // finaliza o bloco: pc/nextPc, ciclos, carga pendente\\n    const finish = (pcExpr) => {\\n      let s = `cpu.cycles+=${unf};cpu.instrCount+=${cnt};${flushRegs()}`;\\n      if (pend) s += `cpu.pendReg=${pend.reg};cpu.pendVal=${pend.tmp};`;\\n      s += pcExpr;\\n      code.push(s);\\n    };\\n    const finishSeq = (next) => finish(`cpu.pc=${next >>> 0};cpu.nextPc=${(next + 4) >>> 0};`);\\n\\n    // aplica o efeito de \\\"fim de instrução\\\": carga anterior (se não cancelada) e nova carga\\n    let newLd = null;\\n    const post = (dest) => {\\n      if (dest === 31 || (newLd && newLd.reg === 31) || (pend && pend.reg === 31)) knownRa = null;\\n      if (pend && pend.reg !== dest) { code.push(`r${pend.reg}=${pend.tmp}>>>0;`); dirty.add(pend.reg); }\\n      pend = newLd; newLd = null;\\n    };\\n\\n    // emite UMA instrução não-branch. Devolve { dest, term }.\\n    const emit = (w, pcv) => {\\n      const op = w >>> 26, rs = (w >>> 21) & 31, rt = (w >>> 16) & 31, rd = (w >>> 11) & 31;\\n      const sh = (w >>> 6) & 31, imm = w & 0xFFFF, simm = (w << 16) >> 16;\\n      const RS = R(rs), RT = R(rt);\\n      const W = (d, e) => { if (d) { code.push(e.endsWith('?1:0') && !e.includes('?1:0)') ? `r${d}=${e};` : `r${d}=(${e})>>>0;`); dirty.add(d); } return d; };   // locais guardam uint32 (como o Uint32Array r[])\\n      let dest = 0, term = false;\\n      newLd = null;\\n\\n      const load = (size, conv) => {\\n        const a = tmp(), v = tmp();\\n        flushCyc();\\n        code.push(`const ${a}=(${RS}+${simm})>>>0;`);\\n        if (size > 1) code.push(`if(${a}&${size - 1})${X(EXC.ADEL, 0, a, LD_RAM)}`);\\n        const fast = size === 4 ? `ram32[(${a}&0x1FFFFF)>>>2]` : size === 2 ? `ram16[(${a}&0x1FFFFF)>>>1]` : `ram8[${a}&0x1FFFFF]`;\\n        code.push(`const ${v}=${conv(`(${RAMFAST(a)}?${fast}:rd(${a},${size}))`)};`);\\n        if (rt) newLd = { reg: rt, tmp: v };\\n      };\\n      const store = (size, valExpr) => {\\n        const a = tmp(), v = tmp();\\n        flushCyc();\\n        code.push(`const ${a}=(${RS}+${simm})>>>0;`);\\n        if (size > 1) code.push(`if(${a}&${size - 1})${X(EXC.ADES, 0, a)}`);\\n        code.push(`const ${v}=${valExpr};`);\\n        const arr = size === 4 ? `ram32[q>>>2]` : size === 2 ? `ram16[q>>>1]` : `ram8[q]`;\\n        code.push(`if(${RAMFAST(a)}){const q=${a}&0x1FFFFF;${arr}=${v};if(cf[q>>>6])inv(q);}else bus.write(${a},${size},${v});`);\\n      };\\n\\n      switch (op) {\\n        case 0x00:\\n          switch (w & 0x3F) {\\n            case 0x00: dest = W(rd, `${RT}<<${sh}`); break;\\n            case 0x02: dest = W(rd, `${RT}>>>${sh}`); break;\\n            case 0x03: dest = W(rd, `(${RT}|0)>>${sh}`); break;\\n            case 0x04: dest = W(rd, `${RT}<<(${RS}&31)`); break;\\n            case 0x06: dest = W(rd, `${RT}>>>(${RS}&31)`); break;\\n            case 0x07: dest = W(rd, `(${RT}|0)>>(${RS}&31)`); break;\\n            case 0x0C: code.push(X(EXC.SYS)); term = 'x'; break;\\n            case 0x0D: code.push(X(EXC.BP)); term = 'x'; break;\\n            case 0x10: dest = W(rd, 'cpu.hi'); break;\\n            case 0x11: code.push(`cpu.hi=${RS};`); break;\\n            case 0x12: dest = W(rd, 'cpu.lo'); break;\\n            case 0x13: code.push(`cpu.lo=${RS};`); break;\\n            case 0x18: code.push(`cpu.mul64(${RS},${RT},true);`); break;\\n            case 0x19: code.push(`cpu.mul64(${RS},${RT},false);`); break;\\n            case 0x1A: code.push(`cpu.div(${RS},${RT});`); break;\\n            case 0x1B: code.push(`cpu.divu(${RS},${RT});`); break;\\n            case 0x20: { const a = tmp(), b = tmp(), s = tmp();\\n              code.push(`const ${a}=${RS}|0,${b}=${RT}|0,${s}=(${a}+${b})|0;if(((${a}^${s})&(${b}^${s}))<0)${X(EXC.OV)}`);\\n              dest = W(rd, s); break; }\\n            case 0x21: dest = W(rd, `${RS}+${RT}`); break;\\n            case 0x22: { const a = tmp(), b = tmp(), s = tmp();\\n              code.push(`const ${a}=${RS}|0,${b}=${RT}|0,${s}=(${a}-${b})|0;if(((${a}^${b})&(${a}^${s}))<0)${X(EXC.OV)}`);\\n              dest = W(rd, s); break; }\\n            case 0x23: dest = W(rd, `${RS}-${RT}`); break;\\n            case 0x24: dest = W(rd, `${RS}&${RT}`); break;\\n            case 0x25: dest = W(rd, `${RS}|${RT}`); break;\\n            case 0x26: dest = W(rd, `${RS}^${RT}`); break;\\n            case 0x27: dest = W(rd, `~(${RS}|${RT})`); break;\\n            case 0x2A: dest = W(rd, `(${RS}|0)<(${RT}|0)?1:0`); break;\\n            case 0x2B: dest = W(rd, `${RS}<${RT}?1:0`); break;\\n            default: code.push(X(EXC.RI)); term = 'x';\\n          }\\n          break;\\n        case 0x08: { const a = tmp(), s = tmp();\\n          code.push(`const ${a}=${RS}|0,${s}=(${a}+${simm})|0;if(((${a}^${s})&(${simm}^${s}))<0)${X(EXC.OV)}`);\\n          dest = W(rt, s); break; }\\n        case 0x09: dest = W(rt, `${RS}+${simm}`); break;\\n        case 0x0A: dest = W(rt, `(${RS}|0)<${simm}?1:0`); break;\\n        case 0x0B: dest = W(rt, `${RS}<${simm >>> 0}?1:0`); break;\\n        case 0x0C: dest = W(rt, `${RS}&${imm}`); break;\\n        case 0x0D: dest = W(rt, `${RS}|${imm}`); break;\\n        case 0x0E: dest = W(rt, `${RS}^${imm}`); break;\\n        case 0x0F: dest = W(rt, `${(imm << 16) >>> 0}`); break;\\n\\n        case 0x10:                                                // COP0 (modo kernel garantido na entrada)\\n          if (rs === 0x00) { const v = tmp(); code.push(`const ${v}=c0[${rd}];`); if (rt) newLd = { reg: rt, tmp: v }; }\\n          else if (rs === 0x04) { code.push(`cpu.writeCop0(${rd},${RT});`); if (rd === 12 || rd === 13) term = 'seq'; }\\n          else if (rs === 0x10 && (w & 0x3F) === 0x10) { code.push('c0[12]=(c0[12]&0xFFFFFFF0)|((c0[12]>>>2)&0xF);'); term = 'seq'; }\\n          else if (rs === 0x10) { code.push(X(EXC.RI)); term = 'x'; }\\n          break;\\n\\n        case 0x12:                                                // COP2 / GTE\\n          code.push(`if(!(c0[12]&0x40000000))${X(EXC.CPU, 2)}`);\\n          if (w & 0x02000000) code.push(`gte.command(${w & 0x1FFFFFF});`);\\n          else if (rs === 0x00) { const v = tmp(); code.push(`const ${v}=gte.readData(${rd});`); if (rt) newLd = { reg: rt, tmp: v }; }\\n          else if (rs === 0x02) { const v = tmp(); code.push(`const ${v}=gte.readCtrl(${rd});`); if (rt) newLd = { reg: rt, tmp: v }; }\\n          else if (rs === 0x04) code.push(`gte.writeData(${rd},${RT});`);\\n          else if (rs === 0x06) code.push(`gte.writeCtrl(${rd},${RT});`);\\n          else { code.push(X(EXC.RI)); term = 'x'; }\\n          break;\\n\\n        case 0x11: case 0x13: case 0x30: case 0x31: case 0x33: case 0x38: case 0x39: case 0x3B:\\n          code.push(`if(!(c0[12]&${0x10000000 * (1 << (op & 3))}))${X(EXC.CPU, op & 3)}`); break;\\n\\n        case 0x20: load(1, e => `((${e}<<24)>>24)`); break;\\n        case 0x21: load(2, e => `((${e}<<16)>>16)`); break;\\n        case 0x23: load(4, e => e); break;\\n        case 0x24: load(1, e => e); break;\\n        case 0x25: load(2, e => e); break;\\n        case 0x22: case 0x26: {                                   // LWL / LWR\\n          const a = tmp(), v = tmp();\\n          flushCyc();\\n          const cur = (pend && pend.reg === rt) ? pend.tmp : R(rt);\\n          code.push(`const ${a}=(${RS}+${simm})>>>0;const ${v}=H.${op === 0x22 ? 'lwl' : 'lwr'}(${a},${cur});`);\\n          if (rt) newLd = { reg: rt, tmp: v };\\n          break;\\n        }\\n        case 0x32: {                                              // LWC2\\n          const a = tmp(), v = tmp();\\n          flushCyc();\\n          code.push(`if(!(c0[12]&0x40000000))${X(EXC.CPU, 2)}`);\\n          code.push(`const ${a}=(${RS}+${simm})>>>0;`);\\n          code.push(`if(${a}&3)${X(EXC.ADEL, 0, a, LD_RAM)}`);\\n          code.push(`const ${v}=(${RAMFAST(a)}?ram32[(${a}&0x1FFFFF)>>>2]:rd(${a},4));gte.writeData(${rt},${v});`);\\n          break;\\n        }\\n        case 0x28: store(1, `${RT}&0xFF`); break;\\n        case 0x29: store(2, `${RT}&0xFFFF`); break;\\n        case 0x2B: store(4, `${RT}`); break;\\n        case 0x2A: case 0x2E: {                                   // SWL / SWR\\n          const a = tmp();\\n          flushCyc();\\n          code.push(`const ${a}=(${RS}+${simm})>>>0;H.${op === 0x2A ? 'swl' : 'swr'}(${a},${RT});`);\\n          break;\\n        }\\n        case 0x3A: {                                              // SWC2\\n          const a = tmp(), v = tmp();\\n          flushCyc();\\n          code.push(`if(!(c0[12]&0x40000000))${X(EXC.CPU, 2)}`);\\n          code.push(`const ${a}=(${RS}+${simm})>>>0;`);\\n          code.push(`if(${a}&3)${X(EXC.ADES, 0, a)}`);\\n          code.push(`const ${v}=gte.readData(${rt});`);\\n          code.push(`if(${RAMFAST(a)}){const q=${a}&0x1FFFFF;ram32[q>>>2]=${v};if(cf[q>>>6])inv(q);}else bus.write(${a},4,${v}>>>0);`);\\n          break;\\n        }\\n        default: code.push(X(EXC.RI)); term = 'x';\\n      }\\n      return { dest, term };\\n    };\\n\\n    // custo estático de uma instrução (1 + fetch KSEG1 + 5 se faz acesso de leitura)\\n    const instCost = (w, a) => {\\n      const op = w >>> 26;\\n      const rdAccess = op === 0x20 || op === 0x21 || op === 0x22 || op === 0x23 || op === 0x24 || op === 0x25 || op === 0x26 || op === 0x32 || op === 0x2A || op === 0x2E;\\n      return 1 + fetchCost(a) + (rdAccess ? LD_RAM : 0);\\n    };\\n    const fetch = a => bus.read(a, 4);\\n\\n    // volta ao início do próprio bloco (laço): mantém os registradores em variáveis locais; sai para o despachante quando acabar o tempo\\n    // do tick, houver IRQ pendente ou o código for invalidado\\n    const backedge = () => { hasLoop = true; return `cpu.cycles+=${unf};cpu.instrCount+=${cnt};if(cpu.cycles>=ps.nextTick||(bus.istat&bus.imask)!==0||J.epoch!==E0){${flushRegs()}cpu.pc=${startPc};cpu.nextPc=${(startPc + 4) >>> 0};return;}continue;`; };\\n    const inlineOk = t => { const ph = t & 0x1FFFFFFF; return (t & 3) === 0 && ph >= 0x100 && !vis.has(t) && (isRam ? ph < 0x800000 : (ph >= 0x1FC00000 && ph < 0x1FC80000)); };\\n\\n    let done = false;\\n    while (!done) {\\n      const w = fetch(ipc); vis.add(ipc);\\n      if (isBranchWord(w)) {\\n        const dw = fetch((ipc + 4) >>> 0);\\n        if (isBranchWord(dw)) { // branch no delay slot: deixa para o interpretador\\n          if (cnt === 0) { this.stats.interp++; this.register(startPc, isRam, tbl, tidx, ipc); return INTERP; }\\n          finishSeq(ipc); done = true; break;\\n        }\\n        const op = w >>> 26, rs = (w >>> 21) & 31, rt = (w >>> 16) & 31, rd = (w >>> 11) & 31, simm = (w << 16) >> 16;\\n        const RS = R(rs), RT = R(rt);\\n        const tgt = (ipc + 4 + (simm << 2)) >>> 0;\\n        let target, cond = null, dest = 0, link = '', bkn = '';\\n        cnt++; unf += instCost(w, ipc); delay = false;\\n        let jt = -1, raNew = null, jrKnown = false, btn = 'bt';\\n        if (op === 0x02 || op === 0x03) {\\n          jt = (((ipc + 4) & 0xF0000000) | ((w & 0x3FFFFFF) << 2)) >>> 0; target = `${jt}`;\\n          if (op === 3) { link = `r31=${(ipc + 8) >>> 0};`; dest = 31; dirty.add(31); raNew = (ipc + 8) >>> 0; }\\n          btn = tmp(); code.push(`const ${btn}=${target};${link}`);\\n        } else if (op === 0 /* JR/JALR */) {\\n          if ((w & 0x3F) === 8 && rs === 31 && knownRa !== null && cnt < MAX_BLOCK - 8 && inlineOk(knownRa)) { jt = knownRa; jrKnown = true; }\\n          btn = tmp(); code.push(`const ${btn}=${RS}>>>0;`);\\n          if ((w & 0x3F) === 9 && rd) { code.push(`r${rd}=${(ipc + 8) >>> 0};`); dest = rd; dirty.add(rd); }\\n        } else {\\n          const cexp = op === 4 ? `${RS}===${RT}` : op === 5 ? `${RS}!==${RT}` : op === 6 ? `(${RS}|0)<=0` : op === 7 ? `(${RS}|0)>0`\\n            : ((rt & 1) ? `(${RS}|0)>=0` : `(${RS}|0)<0`);\\n          bkn = tmp(); code.push(`const ${bkn}=${cexp};`);\\n          if (op === 1 && (rt & 0x1E) === 0x10) { code.push('r31=' + ((ipc + 8) >>> 0) + ';'); dest = 31; dirty.add(31); }\\n          cond = true;\\n        }\\n        post(dest);\\n        // delay slot\\n        delay = true; cnt++; const dpc = (ipc + 4) >>> 0; ipc = dpc; unf += instCost(dw, dpc);\\n        const res = emit(dw, dpc);\\n        post(res.dest);\\n        const dualExit = res.term === 'x';           // exceção incondicional no delay slot: o resto é morto\\n        if (!dualExit) {\\n          if (!cond && jt >= 0 && !res.term) {\\n            if (jt === startPc && !pend) { code.push(backedge()); done = true; break; }          // salto incondicional para o próprio início: laço interno\\n            if (jt !== startPc && (jrKnown || cnt < MAX_BLOCK - 8) && inlineOk(jt)) {              // j/jal/jr $ra conhecido: embute o destino no mesmo bloco\\n              segs.push([segStart, dpc]); segStart = jt; ipc = jt; delay = false;\\n              if (raNew !== null) knownRa = raNew; else if (jrKnown) knownRa = null;\\n              continue;\\n            }\\n          }\\n          if (cond) {\\n            if (!res.term && cnt < MAX_BLOCK - 3) {   // superbloco: o desvio tomado vira saída lateral; o fluxo sequencial continua no mesmo bloco\\n              if (tgt === startPc && !pend) code.push(`if(${bkn}){${backedge()}}`);              // desvio para trás até o início: laço interno\\n              else {\\n                let s = `cpu.cycles+=${unf};cpu.instrCount+=${cnt};${flushRegs()}`;\\n                if (pend) s += `cpu.pendReg=${pend.reg};cpu.pendVal=${pend.tmp};`;\\n                code.push(`if(${bkn}){${s}cpu.pc=${tgt};cpu.nextPc=${(tgt + 4) >>> 0};return;}`);\\n              }\\n              ipc = (dpc + 4) >>> 0; delay = false; continue;\\n            }\\n            finish(`if(${bkn}){cpu.pc=${tgt};cpu.nextPc=${(tgt + 4) >>> 0};}else{cpu.pc=${(dpc + 4) >>> 0};cpu.nextPc=${(dpc + 8) >>> 0};}`);\\n          } else finish(`cpu.pc=${btn};cpu.nextPc=(${btn}+4)>>>0;`);\\n        }\\n        done = true; break;\\n      }\\n\\n      // instrução comum\\n      cnt++; unf += instCost(w, ipc); delay = false;\\n      const res = emit(w, ipc);\\n      post(res.dest);\\n      if (res.term === 'x') { done = true; break; }\\n      if (res.term === 'seq' || cnt >= MAX_BLOCK) { finishSeq((ipc + 4) >>> 0); done = true; break; }\\n      ipc = (ipc + 4) >>> 0;\\n    }\\n\\n    segs.push([segStart, ipc]);\\n    const fullFlush = [...dirty].map(n => `r[${n}]=r${n};`).join('');       // num laço, qualquer saída grava TODOS os registradores alterados no corpo\\n    let body = code.join('\\\\n').replace(/\\\\u0001(\\\\d+)\\\\u0002/g, (_, i) => hasLoop ? fullFlush : flushSets[+i]);\\n    const used = new Set(); for (const m of body.matchAll(/\\\\br(\\\\d{1,2})\\\\b/g)) used.add(+m[1]);\\n    const load = used.size ? 'let ' + [...used].map(n => `r${n}=r[${n}]`).join(',') + ';\\\\n' : '';\\n    if (hasLoop) body = `const E0=J.epoch;\\\\nfor(;;){\\\\n${body}\\\\nreturn;\\\\n}`;\\n    const src = `const {r,c0,gte,ram8,ram16,ram32,cf,inv,rd,bus,ps,J}=H;return function block(){\\\\n${load}${body}\\\\n}\\\\n//# sourceURL=jit_${startPc.toString(16)}`;\\n    let fn;\\n    try { fn = new Function('cpu', 'H', src)(cpu, this.H); }\\n    catch (e) { this.stats.interp++; for (const [a, b] of segs) this.register(a, isRam, tbl, tidx, b); return INTERP; }\\n    this.stats.compiled++; if (hasLoop) this.stats.loops++; this.stats.inlined += segs.length - 1;\\n    fn.lp = -1; fn.lb = null; fn.le = -1;                  // cache de sucessor (ver runBlocks)\\n    for (const [a, b] of segs) this.register(a, isRam, tbl, tidx, b);\\n    return fn;\\n  }\\n\\n  /** marca as linhas de RAM cobertas pelo bloco [start, endPc] para invalidação */\\n  register(startPc, isRam, tbl, tidx, endPc) {\\n    if (!isRam) return;\\n    const seg = startPc >>> 29;\\n    const p0 = (seg < 4 ? startPc : seg === 4 ? startPc & 0x7FFFFFFF : startPc & 0x1FFFFFFF) & 0x1FFFFF;\\n    const p1 = (p0 + ((endPc - startPc) >>> 0) + 3) & 0x1FFFFF;\\n    const l0 = p0 >>> 6, l1 = p1 >>> 6;\\n    for (let l = l0; ; l = (l + 1) & (this.cf.length - 1)) {\\n      (this.lineBlocks[l] ??= []).push({ t: tbl, i: tidx });\\n      this.cf[l] = 1;\\n      if (l === l1) break;\\n    }\\n  }\\n}\\n\\nreturn { JIT };\\n})();\\nconst __src_wasmbin = (() => {\\n// gerado por wasm/build.sh (não edite)\\nconst WASM_B64 = 'AGFzbQEAAAABOgpgAn9/AX9gA39/fwBgAABgAX8Bf2AAAX9gAn9/AGABfwBgA39/fwF/YAR/f39/AGAHf39/f39/fwACKQMDZW52Bm1lbW9yeQIBQEADZW52BWJyZWFkAAADZW52BmJ3cml0ZQABAxEQAgMEBQYDBQUHBgABAQgJCAQFAXABAQEGCQF/AUGAn6IBCwcpBQNwdHIAAwNydW4ABAdndGVfY21kAAsGZ3RlX3JkAAwGZ3RlX3dyAA0IAQIKoMUBEA8AQaAIQQBB1JagAfwLAAuQAQEBf0GgiICAACEBAkACQAJAAkACQAJAAkACQAJAAkACQAJAIAAOCwsAAQIDBAUGBwgJCgtBoImAgAAPC0GgioCAAA8LQeCKgIAADwtBgIuAgAAPC0GAi4CBAA8LQYCLoIEADwtBgJOggQAPC0GAlKCBAA8LQYCWoIEADwtBoJaggQAPC0HAlqCBACEBCyABC9ZEAg5/AXwjgICAgABBEGsiACSAgICAAEEAIQECQEEAKwPgioCAAEEAKwPwioCAAGNFDQADQEEAKAKoioCAACEBAkBBACgCwIqAgABFDQAgAUHv////AXFBoAFHDQACQEEAKALEioCAAA0AQQEhAQwDC0EAQQA2AsSKgIAAC0EAIAE2AsiKgIAAQQBBACgCsIqAgAAiAjYCzIqAgABBAEEAKAK8ioCAAEEAR0EKdEEAKALUiYCAAEH/d3FyIgM2AtSJgIAAQQBBADYC1JaggQBBAEEANgLYlqCBAEEAQQA2ArCKgIAAQQAoAriKgIAAIQRBACgCtIqAgAAhBQJAAkBBACgC0ImAgAAiBkEBcUUNACAGIANxQYD+A3FFDQBBACABQXxqIAEgAhs2AtiJgIAAQQBBgIOA/ntBgIGAgHggBkGAgIACcRsiATYCqIqAgABBACAGQQJ0QTxxIAZBQHFyNgLQiYCAAEEAIANBg////wRxIAJBAEdBH3RyNgLUiYCAAEEAIAFBBHI2AqyKgIAAQQBBADYCsIqAgAAMAQsCQCABQQNxRQ0AQQAgATYCwImAgABBACABQXxqIAEgAhs2AtiJgIAAQQAgA0GD////BHFBkICAgHhBECACG3I2AtSJgIAAQQBBgIOA/ntBgIGAgHggBkGAgIACcRsiATYCqIqAgABBACAGQQJ0QTxxIAZBQHFyNgLQiYCAAEEAIAFBBHI2AqyKgIAAQQBBADYCsIqAgAAMAQsCQAJAIAFB/P///wFxIAEgAUGAgICAfHFBgICAgHhGGyICQf///wNLDQAgAkH8//8AcUGAi4CAAGooAgAhAgwBCwJAIAJBgICAgn5qIgNB//8fSw0AIANBgIuAgQBqKAIAIQIMAQsCQCACQYCAgIR+aiICQf8HSw0AIAJBgIuggQBqKAIAIQIMAQsgAUEEEICAgIAAIQILAkAgAUGAgICAfnFBgICAgHpHDQBBAEEAKwPgioCAAEEWQQQgAUGAgID+AXFBgICA/gFGG7egOQPgioCAAAtBAEEAKAKsioCAACIDNgKoioCAAEEAIANBBGo2AqyKgIAAIAJBEHQhByACQf//A3EhCCACQQt2QR9xIQkgAkEQdkEfcSEKIAJBFXZBH3EhCyACwSEMAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAIAJBGnYiDQ48AAECAwQFBgcICQoLDA0ODxASERIhISEhISEhISEhISETFBgVFhcZIRscHh0hIR8hEhIaEiEhISESEiASIQsgAkEGdkEfcSEGAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQCACQT9xDiwAHAECAxwEBQYHHBwICRwcCgsMDRwcHBwODxARHBwcHBITFBUWFxgZHBwaGxwLQQAgCTYC2JaggQAgCUECdEGgiICAAGogCkECdEGgiICAAGooAgAgBnQ2AgAMPwtBACAJNgLYlqCBACAJQQJ0QaCIgIAAaiAKQQJ0QaCIgIAAaigCACAGdjYCAAw+C0EAIAk2AtiWoIEAIAlBAnRBoIiAgABqIApBAnRBoIiAgABqKAIAIAZ1NgIADD0LQQAgCTYC2JaggQAgCUECdEGgiICAAGogCkECdEGgiICAAGooAgAgC0ECdEGgiICAAGooAgB0NgIADDwLQQAgCTYC2JaggQAgCUECdEGgiICAAGogCkECdEGgiICAAGooAgAgC0ECdEGgiICAAGooAgB2NgIADDsLQQAgCTYC2JaggQAgCUECdEGgiICAAGogCkECdEGgiICAAGooAgAgC0ECdEGgiICA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dEGgiICAAGogBDYCAAtBACEBQQBBACgC1JaggQA2ArSKgIAAQQBBACgC3JaggQA2AriKgIAAQQBBACsD4IqAgABEAAAAAAAA8D+gIg45A+CKgIAAQQBBACsD6IqAgABEAAAAAAAA8D+gOQPoioCAAEEAQQA2AqCIgIAAIA5BACsD8IqAgABjDQALCyAAQRBqJICAgIAAIAELsAEBA39BAEEAKALIioCAACICQXxqIAJBACgCzIqAgAAiAxs2AtiJgIAAQQBBgIOA/ntBgIGAgHhBACgC0ImAgAAiAkGAgIACcRsiBDYCqIqAgABBACACQQJ0QTxxIAJBQHFyNgLQiYCAAEEAIAFBHHQgAEECdHJBACgC1ImAgABBg////wRxciADQQBHQR90cjYC1ImAgABBACAEQQRyNgKsioCAAEEAQQA2ArCKgIAAC+tHAwR/CX4EfyOAgICAAEHgAGsiASSAgICAAAJAQQAtAOCWoIEADQBBAEEBOgDglqCBAEHwlqCBACECQYECIQMDQCACQYCAECADQX9qbkEBakEBdiIEQYECIARBgQJKG0H/fWo2AgAgA0GBBEYNASACQQRqQYCAECADbkEBakEBdiIEQYECIARBgQJKG0H/fWo2AgAgAkEIaiECIANBAmohAwwACwtBAEEANgLQioCAACAAQQp2QQFxIQIgAEETdkEBcSEDAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQCAAQT9xQX9qDj8BHBwcHAMcHBwcHAQcHBwFBgcIDhwJHBwcHAoPHAwcDRwcHBwcHBwREAAcHBITHAIcHBwcHBwcHBwcHBwUFQscCyABQQAoAtCToIEAIgRBgID8B3GtNwNQIAEgBEEIdEGAgPwHca03A0ggASAEQRB0QYCA/AdxrTcDQCABQcAAaiADIAIQjoCAgAAgAUEAKALQk6CBACIEQYCA/AdxrTcDUCABIARBCHRBgID8B3GtNwNIIAEgBEEQdEGAgPwHca03A0AgAUHAAGogAyACEI6AgIAAIAFBACgC0JOggQAiBEGAgPwHca03A1AgASAEQQh0QYCA/AdxrTcDSCABIARBEHRBgID8B3GtNwNAIAFBwABqIAMgAhCOgICAAAwbC0EAQQEgAyACEI+AgIAADBoLQQBBACADIAIQj4CAgABBAUEAIAMgAhCPgICAAEECQQEgAyACEI+AgIAADBkLQYCABCEDAkACQEEAKAK0k6CBACICwawiBUEAKAK4k6CBACIEQRB1rCIGfkEAKAKwk6CBACIAwawiByACQRB1rCIIfnwgBMGsIgkgAEEQdawiCn58IAYgB34gBSAKfnwgCSAIfnx9IgVC/////wdVDQBBgIACIQMgBUL/////d1UNAQtBACADNgLQioCAAAtBACAFPgLgk6CBAAwYC0GAgICABCEAAkACQEEAMgGIlqCBACIJQQA0AqyToIEAIgp+QQAyAZCWoIEAIgtBADQCqJOggQAiDH59IgVC////////AVUNAEGAgIDAACEAQQAhBCAFQv///////31VDQELQQAgADYC0IqAgAAgACEEC0EAMgGAlqCBACEGQQA0AqSToIEAIQdBACAFQhSGQhSHIgVCDIggBSADGyINPgLkk6CBAEIAQoCAfiACGyIFIQgCQAJAIAUgDcQiDVUNAEL//wEhCCANQoCAAlkNACANIQgMAQtBACAEQYCAgAhyIgQ2AtCKgIAAC0EAIAg+AqSToIEAQYCAgIACIQICQAJAIAsgB34gBiAKfn0iCEL///////8BVQ0AQYCAgCAhAiAIQv///////31VDQELQQAgBCACciIENgLQioCAAAtBACAIQhSGQhSHIghCDIggCCADGyIKPgLok6CBACAFIQgCQAJAIAUgCsQiClUNAEL//wEhCCAKQoCAAlkNACAKIQgMAQtBACAEQYCAgARyIgQ2AtCKgIAAC0EAIAg+AqiToIEAQYCAgIABIQICQAJAIAYgDH4gCSAHfn0iBkL///////8BVQ0AQYCAgBAhAiAGQv///////31VDQELQQAgBCACciIENgLQioCAAAtBACAGQhSGQhSHIgZCDIggBiADGyIGPgLsk6CBAAJAAkAgBSAGxCIGVQ0AQv//ASEFIAZCgIACUw0BC0EAIARBgICAAnI2AtCKgIAAIAUhBgtBACAGPgKsk6CBAAwXCyABQQAoApiToIEAIgRBgID8B3GtNwNQIAEgBEEIdEGAgPwHca03A0ggASAEQRB0QYCA/AdxrTcDQCABQcAAaiADIAIQjoCAgAAMFgtBADQCpJOggQAhBUEANAKok6CBACEGIAFBADQCrJOggQBCDIY3A1AgASAGQgyGNwNIIAEgBUIMhjcDQCABQcAAaiADIAIQjoCAgAAMFQsgAEENdiEOIABBD3ZBA3EhDwJAAkAgAEERdkEDcSIEQQNHDQAgAUEAKAKgk6CBADsBFCABQQAvAYSWoIEAIgQ7ARogASAEOwEYIAEgBDsBFiABQQAvAYiWoIEAIgQ7ASAgASAEOwEeIAEgBDsBHCABQQAvAZiToIEAQQR0QfAfcSIEOwESIAFBACAEazsBECABQRBqIQQMAQsgBEECdEGUiICAAGooAgAhBAsgDkEDcSEAAkACQAJAAkACQAJAIA8OBAECAwADCyABQQAoAqSToIEAIg82AjQgAUEAKAKok6CBACIQNgI4QQAoAqyToIEAIQ4MBAsgAUEAKAKAk6CBACIOwSIPNgI0QYSToIEAIREMAgsgAUEAKAKIk6CBACIOwSIPNgI0QYyToIEAIREMAQsgAUEAKAKQk6CBACIOwSIPNgI0QZSToIEAIRELIAEgDkEQdSIQNgI4IBEuAQAhDgsgASAONgI8AkAgAEECRw0AQgBCgIB+IAIbIQVCIEIUIAMbIQZBACECQYCAgIAEIQACQAJAIAQyAQAgD6wiCn5BADQC1JWggQBCDIZ8IglC////////AVUNAEGAgIDAACEAIAlC////////fVUNAQtBACAANgLQioCAACAAIQILIA6sIQcgEKwhCAJAAkAgCUIUhiAGhyIJIAVTDQAgCUKAgAJTDQELQQAgAkGAgIAIciICNgLQioCAAAtBgICAgAQhAAJAAkAgBDIBBCAHfiAEMgECIAh+fCIJQv///////wFVDQBBgICAwAAhACAJQv///////31VDQELQQAgACACciICNgLQioCAAAtBACAJQgyIIAkgAxsiC6ciADYC5JOggQAgBSEJAkACQCAFIAvEIgtVDQBC//8BIQkgAEGAgAJODQAgCyEJDAELQQAgAkGAgIAIciICNgLQioCAAAtBACAJPgKkk6CBAEGAgICAAiEAAkACQCAEMgEGIAp+QQA0AtiVoIEAQgyGfCIJQv///////wFVDQBBgICAICEAIAlC////////fVUNAQtBACAAIAJyIgI2AtCKgIAACwJAAkAgCUIUhiAGhyIJIAVTDQAgCUKAgAJTDQELQQAgAkGAgIAEciICNgLQioCAAAtBgICAgAIhAAJAAkAgBDIBCiAHfiAEMgEIIAh+fCIJQv///////wFVDQBBgICAICEAIAlC////////fVUNAQtBACAAIAJyIgI2AtCKgIAAC0EAIAlCDIggCSADGyILpyIANgLok6CBACAFIQkCQAJAIAUgC8QiC1UNAEL//wEhCSAAQYCAAk4NACALIQkMAQtBACACQYCAgARyIgI2AtCKgIAAC0EAIAk+AqiToIEAQYCAgIABIQACQAJAIAQyAQwgCn5BADQC3JWggQBCDIZ8IglC////////AVUNAEGAgIAQIQAgCUL///////99VQ0BC0EAIAAgAnIiAjYC0IqAgAALAkACQCAJQhSGIAaHIgYgBVMNACAGQoCAAlMNAQtBACACQYCAgAJyIgI2AtCKgIAAC0GAgICAASEAAkACQCAEMgEQIAd+IAQyAQ4gCH58IgZC////////AVUNAEGAgIAQIQAgBkL///////99VQ0BC0EAIAAgAnIiAjYC0IqAgAALQQAgBkIMiCAGIAMbIganIgM2AuyToIEAAkACQCAFIAbEIgZVDQBC//8BIQUgA0GAgAJIDQELQQAgAkGAgIACcjYC0IqAgAAgBSEGC0EAIAY+AqyToIEADBULQZyVoIEAIQ9BmJWggQAhEEGUlaCBACERQQAhDgJAAkACQCAADgIBAAILQbyVoIEAIQ9BuJWggQAhEEG0laCBACERCyABIBEoAgA2AiggASAQKAIANgIsIAEgDygCADYCMCABQShqIQ4LIAQgAUE0aiAOIAMgAkEBIAFBwABqEJCAgIAADBQLIAFBAC4BhJOggQA2AgwgAUEAKAKAk6CBACIEQRB1NgIIIAEgBME2AgRBoJaggQAgAUEEakEAIAMgAkEBIAFBwABqEJCAgIAAIAFBACgCpJOggQA2AjQgAUEAKQOok6CBADcCOCABQQAoArSVoIEANgIoIAFBACkDuJWggQA3AixBwJaggQAgAUE0aiABQShqIAMgAkEBIAFBwABqEJCAgIAAIAFBADQCrJOggQBBACgCmJOggQAiBEEMdkHwH3GtfjcDICABIARBBHZB8B9xrUEANAKok6CBAH43AxggASAEQQR0QfAfca1BADQCpJOggQB+NwMQIAFBEGogAyACEI6AgIAADBMLIAFBAC4BhJOggQA2AgwgAUEAKAKAk6CBACIEQRB1NgIIIAEgBME2AgRBoJaggQAgAUEEakEAIAMgAkEBIAFBwABqEJCAgIAAIAFBACgCpJOggQA2AjQgAUEAKQOok6CBADcCOCABQQAoArSVoIEANgIoIAFBACkDuJWggQA3AixBwJaggQAgAUE0aiABQShqIAMgAkEBIAFBwABqEJCAgIAAIAFBADQCrJOggQBBACgCmJOggQAiBEEMdkHwH3GtfjcDICABIARBBHZB8B9xrUEANAKok6CBAH43AxggASAEQQR0QfAfca1BADQCpJOggQB+NwMQIAFBEGogAyACEI6AgIAAIAFBAC4BjJOggQA2AgwgAUEAKAKIk6CBACIEQRB1NgIIIAEgBME2AgRBoJaggQAgAUEEakEAIAMgAkEBIAFBwABqEJCAgIAAIAFBACgCpJOggQA2AjQgAUEAKQOok6CBADcCOCABQQAoArSVoIEANgIoIAFBACkDuJWggQA3AixBwJaggQAgAUE0aiABQShqIAMgAkEBIAFBwABqEJCAgIAAIAFBADQCrJOggQBBACgCmJOggQAiBEEMdkHwH3GtfjcDICABIARBBHZB8B9xrUEANAKok6CBAH43AxggASAEQQR0QfAfca1BADQCpJOggQB+NwMQIAFBEGogAyACEI6AgIAAIAFBAC4BlJOggQA2AgwgAUEAKAKQk6CBACIEQRB1NgIIIAEgBME2AgRBoJaggQAgAUEEakEAIAMgAkEBIAFBwABqEJCAgIAAIAFBACgCpJOggQA2AjQgAUEAKQOok6CBADcCOCABQQAoArSVoIEANgIoIAFBACkDuJWggQA3AixBwJaggQAgAUE0aiABQShqIAMgAkEBIAFBwABqEJCAgIAAIAFBADQCrJOggQBBACgCmJOggQAiBEEMdkHwH3GtfjcDICABIARBBHZB8B9xrUEANAKok6CBAH43AxggASAEQQR0QfAfca1BADQCpJOggQB+NwMQIAFBEGogAyACEI6AgIAADBILIAFBAC4BhJOggQA2AgwgAUEAKAKAk6CBACIEQRB1NgIIIAEgBME2AgQgAUEEakEBIAMgAhCRgICAAAwRCyABQQAuAYSToIEANgIMIAFBACgCgJOggQAiBEEQdTYCCCABIATBNgIEIAFBBGpBASADIAIQkYCAgAAgAUEALgGMk6CBADYCDCABQQAoAoiToIEA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IgY+AuyToIEAIAUgBsQiBlUNBkL//wEhBSAGQv//AVUNBgwHC0GAgAQhAwJAAkBBAC8BxJOggQBBAC8ByJOggQBqQQAvAcyToIEAaq1BADIB9JWggQB+IgVC/////wdVDQBBgIAQIQJBgIACIQMgBUL/////d1UNAQtBACADNgLQioCAACADQYCAEHIhAgtBACAFPgLgk6CBAAJAIAVCDIciBUJ/VQ0AQQAgAjYC0IqAgABBAEEANgKck6CBAAwKCwJAIAVCgIAEVA0AQQAgAjYC0IqAgABBAEH//wM2ApyToIEADAoLQQAgBT4CnJOggQAMCQtBgIAEIQMCQAJAQQAvAcSToIEAQQAvAcCToIEAakEALwHIk6CBAGpBAC8BzJOggQBqrUEAMgH4laCBAH4iBUL/////B1UNAEGAgBAhAkGAgAIhAyAFQv////93VQ0BC0EAIAM2AtCKgIAAIANBgIAQciECC0EAIAU+AuCToIEAAkAgBUIMhyIFQn9VDQBBACACNgLQioCAAEEAQQA2ApyToIEADAkLAkAgBUKAgARUDQBBACACNgLQioCAAEEAQf//AzYCnJOggQAMCQtBACAFPgKck6CBAAwIC0IAQoCAfiACGyEFQQAyAaCToIEAIgdBADQCpJOggQB+IQZBACgCrJOggQAhAkEAKAKok6CBACEEAkACQAJAIANFDQBBgICAgAQhAAJAAkAgBkL///////8BVQ0AQQAhA0GAgIDAACEAIAZC////////fVUNAQtBACAANgLQioCAACAAIQMLQQAgBkIMiKciADYC5JOggQAgBSEIIAUgBkIUhkIghyIGVQ0BQv//ASEIIAZCgIACWQ0BIAYhCAwCC0GAgICABCEAAkACQCAGQv///////wFVDQBBACEDQYCAgMAAIQAgBkL///////99VQ0BC0EAIAA2AtCKgIAAIAAhAwtBACAGpyIANgLkk6CBACAFIQgCQAJAIAUgBsQiBlUNAEL//wEhCCAGQoCAAlkNACAGIQgMAQtBACADQYCAgAhyIgM2AtCKgIAAC0EAIAg+AqSToIEAQYCAgIACIQ4CQAJAIAcgBKx+IgZC////////AVUNAEGAgIAgIQ4gBkL///////99VQ0BC0EAIA4gA3IiAzYC0IqAgAALQQAgBqciDjYC6JOggQAgBSEIAkACQCAFIAbEIgZVDQBC//8BIQggBkKAgAJZDQAgBiEIDAELQQAgA0GAgIAEciIDNgLQioCAAAtBACAIPgKok6CBAEGAgICAASEEAkACQCAHIAKsfiIGQv///////wFVDQBBgICAECEEIAZC////////fVUNAQtBACAEIANyIgM2AtCKgIAAC0EAIAanIgI2AuyToIEAIAUgBsQiBlUNA0L//wEhBSAGQoCAAlMNBAwDC0EAIANBgICACHIiAzYC0IqAgAALQQAgCD4CpJOggQBBgICAgAIhDgJAAkAgByAErH4iBkL///////8BVQ0AQYCAgCAhDiAGQv///////31VDQELQQAgDiADciIDNgLQioCAAAtBACAGQgyIpyIONgLok6CBACAFIQgCQAJAIAUgBkIUhkIghyIGVQ0AQv//ASEIIAZCgIACWQ0AIAYhCAwBC0EAIANBgICABHIiAzYC0IqAgAALQQAgCD4CqJOggQBBgICAgAEhBAJAAkAgByACrH4iBkL///////8BVQ0AQYCAgBAhBCAGQv///////31VDQELQQAgBCADciIDNgLQioCAAAtBACAGQgyIpyICNgLsk6CBACAFIAZCFIZCIIciBlUNAUL//wEhBSAGQv//AVUNAQwCC0IAQoCAfiACGyEFQQA0AuSToIEAIQdBADIBoJOggQAhBkEAKAKsk6CBACECQQAoAqiToIEAIQRBACgCpJOggQAhAAJAAkACQAJAAkAgA0UNAEGAgICABCEOAkACQCAGIACsfiAHQgyGfCIHQv///////wFVDQBBACEDQYCAgMAAIQ4gB0L///////99VQ0BC0EAIA42AtCKgIAAIA4hAwtBACAHQgyIpyIANgLkk6CBACAFIQggBSAHQhSGQiCHIgdVDQFC//8BIQggB0KAgAJZDQEgByEIDAILQYCAgIAEIQ4CQAJAIAYgAKx+IAd8IgdC////////AVUNAEEAIQNBgICAwAAhDiAHQv///////31VDQELQQAgDjYC0IqAgAAgDiEDC0EAIAenIgA2AuSToIEAIAUhCAJAAkAgBSAHxCIHVQ0AQv//ASEIIAdCgIACWQ0AIAchCAwBC0EAIANBgICACHIiAzYC0IqAgAALQQAgCD4CpJOggQBBgICAgAIhDgJAAkAgBiAErH5BADQC6JOggQB8IgdC////////AVUNAEGAgIAgIQ4gB0L///////99VQ0BC0EAIA4gA3IiAzYC0IqAgAALQQAgB6ciDjYC6JOggQAgBSEIAkACQCAFIAfEIgdVDQBC//8BIQggB0KAgAJZDQAgByEIDAELQQAgA0GAgIAEciIDNgLQioCAAAtBACAIPgKok6CBAEGAgICAASEEAkACQCAGIAKsfkEANALsk6CBAHwiBkL///////8BVQ0AQYCAgBAhBCAGQv///////31VDQELQQAgBCADciIDNgLQioCAAAtBACAGpyICNgLsk6CBACAFIAbEIgZVDQJC//8BIQUgBkKAgAJTDQMMAgtBACADQYCAgAhyIgM2AtCKgIAAC0EAIAg+AqSToIEAQYCAgIACIQ4CQAJAQQA0AuiToIEAQgyGIAYgBKx+fCIHQv///////wFVDQBBgICAICEOIAdC////////fVUNAQtBACAOIANyIgM2AtCKgIAAC0EAIAdCDIinIg42AuiToIEAIAUhCAJAAkAgBSAHQhSGQiCHIgdVDQBC//8BIQggB0KAgAJZDQAgByEIDAELQQAgA0GAgIAEciIDNgLQioCAAAtBACAIPgKok6CBAEGAgICAASEEAkACQEEANALsk6CBAEIMhiAGIAKsfnwiBkL///////8BVQ0AQYCAgBAhBCAGQv///////31VDQELQQAgBCADciIDNgLQioCAAAtBACAGQgyIpyICNgLsk6CBACAFIAZCFIZCIIciBlUNAEL//wEhBSAGQv//AVcNAQtBACADQYCAgAJyIgM2AtCKgIAAIAUhBgtBACAGPgKsk6CBAEEAIQQCQAJAIABBBHUiAEEASA0AQf8BIQQgAEGAAk8NACAAIQQMAQtBACADQYCAgAFyIgM2AtCKgIAAC0EAIQACQAJAIA5BBHUiDkEASA0AQf8BIQAgDkGAAk8NACAOIQAMAQtBACADQYCAwAByIgM2AtCKgIAAC0EAIQ4CQAJAIAJBBHUiAkEASA0AQf8BIQ4gAkGAAkkNAQtBACADQYCAIHI2AtCKgIAAIA4hAgtBAEEAKQLUk6CBADcD0JOggQBBACAAQQh0IARqIAJBEHRqQQAtAJuToIEAQRh0ajYC2JOggQAMBgtBACADQYCAgAJyIgM2AtCKgIAAIAUhBgtBACAGPgKsk6CBAEEAIQQCQAJAIABBBHUi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AyAAIABBgICAgHxxQYCAgIB4RhsiA0H///8DSw0AIANB////AHEhAwJAAkACQCABQX5qDgMBAgACCyADQYCLgIAAaigCACEDDAMLIANBgIuAgABqLwEAIQMMAgsgA0GAi4CAAGotAAAhAwwBCwJAIANBgICAgn5qIgVB//8fSw0AAkACQAJAIAFBfmoOAwECAAILIAVBgIuAgQBqKAIAIQMMAwsgBUGAi4CBAGovAQAhAwwCCyAFQYCLgIEAai0AACEDDAELAkAgA0GAgICEfmoiA0H/B0sNAAJAAkACQCABQX5qDgMBAgACCyADQYCLoIEAaigCACEDDAMLIANBgIuggQBqLwEAIQMMAgsgA0GAi6CBAGotAAAhAwwBCyAAIAEQgICAgAAhAwsgAiADNgIAQQELCgAgABCGgICAAAt2AAJAIAANACABEIeAgIAADwsgAUEgaiEAAkACQCABQR9LDQBBASABdEGQoMDgBnENASABQR9HDQBBACgC0IqAgAAiAUGAwJ/8B3FBAEdBH3QgAXIPCyAAQQJ0QYCUoIEAaigCAA8LIABBAnRBgJSggQBqLgEACx4AAkAgAA0AIAEgAhCIgICAAA8LIAEgAhCJgICAAAv2CQYBfgJ/A34BfwF+AX9CIEIUIAEbIQNBACgC0IqAgAAhBEGAgICABCEFAkACQEEANALUlaCBAEIMhiAAKQMAIgZ9IgdC////////AVUNAEGAgIDAACEFIAdC////////fVUNAQtBACAEIAVyIgQ2AtCKgIAAC0EALgGgk6CBACEFQoCAfiEIAkACQCAHQhSGIAOHxCIHQoCAflMNAEL//wEhCCAHQoCAAlkNACAHIQgMAQtBACAEQYCAgAhyIgQ2AtCKgIAAC0IAQoCAfiACGyEHQYCAgIAEIQICQAJAIAYgBSAIp2ysfCIIQv///////wFVDQBBgICAwAAhAiAIQv///////31VDQELQQAgBCACciIENgLQioCAAAtBACAIQhSGQhSHIghCDIggCCABGyIGpyIJNgLkk6CBACAHIQgCQAJAIAcgBsQiBlUNAEL//wEhCCAGQoCAAlkNACAGIQgMAQtBACAEQYCAgAhyIgQ2AtCKgIAAC0EAIAg+AqSToIEAQYCAgIACIQICQAJAQQA0AtiVoIEAQgyGIAApAwgiCn0iBkL///////8BVQ0AQYCAgCAhAiAGQv///////31VDQELQQAgBCACciIENgLQioCAAAtCgIB+IQgCQAJAIAZCFIYgA4fEIgZCgIB+Uw0AQv//ASEIIAZCgIACWQ0AIAYhCAwBC0EAIARBgICABHIiBDYC0IqAgAALQYCAgIACIQICQAJAIAogBSAIp2ysfCIIQv///////wFVDQBBgICAICECIAhC////////fVUNAQtBACAEIAJyIgQ2AtCKgIAAC0EAIAhCFIZCFIciCEIMiCAIIAEbIganIgs2AuiToIEAIAchCAJAAkAgByAGxCIGVQ0AQv//ASEIIAZCgIACWQ0AIAYhCAwBC0EAIARBgICABHIiBDYC0IqAgAALQQAgCD4CqJOggQBBgICAgAEhAgJAAkBBADQC3JWggQBCDIYgACkDECIKfSIGQv///////wFVDQBBgICAECECIAZC////////fVUNAQtBACAEIAJyIgQ2AtCKgIAAC0KAgH4hCAJAAkAgBkIUhiADh8QiA0KAgH5TDQBC//8BIQggA0KAgAJZDQAgAyEIDAELQQAgBEGAgIACciIENgLQioCAAAtBgICAgAEhAAJAAkAgCiAFIAinbKx8IgNC////////AVUNAEGAgIAQIQAgA0L///////99VQ0BC0EAIAQgAHIiBDYC0IqAgAALQQAgA0IUhkIUhyIDQgyIIAMgARsiA6ciATYC7JOggQACQAJAIAcgA8QiA1UNAEL//wEhByADQoCAAlkNACADIQcMAQtBACAEQYCAgAJyIgQ2AtCKgIAAC0EAIAc+AqyToIEAQQAhAAJAAkAgCUEEdSIFQQBIDQBB/wEhACAFQYACTw0AIAUhAAwBC0EAIARBgICAAXIiBDYC0IqAgAALQQAhBQJAAkAgC0EEdSICQQBIDQBB/wEhBSACQYACTw0AIAIhBQwBC0EAIARBgIDAAHIiBDYC0IqAgAALQQAhAgJAAkAgAUEEdSIBQQBIDQBB/wEhAiABQYACSQ0BC0EAIARBgIAgcjYC0IqAgAAgAiEBC0EAQQApAtSToIEANwPQk6CBAEEAQQAtAJuToIEAQRh0IAFBEHQgBUEIdCAAampqNgLYk6CBAAvrCQQCfwN+AX8BfiOAgICAAEEwayIEJICAgIAAIARBACgClJWggQA2AhggBEEAKQOYlaCBADcCHAJAAkACQAJAIAAOAgABAgsgBEEAKAKAk6CBACIAwTYCJEGEk6CBACEFDAILIARBACgCiJOggQAiAME2AiRBjJOggQAhBQwBCyAEQQAoApCToIEAIgDBNgIkQZSToIEAIQULIAQgAEEQdTYCKCAEIAUuAQA2AixBgJaggQAgBEEkaiAEQRhqIAIgA0EAIAQQkICAgABCAEKAgH4gAxsiBiEHAkACQCAGQQAoAuSToIEAIgOsVQ0AQv//ASEHIANBgIACSA0BC0EAQQAoAtCKgIAAQYCAgAhyNgLQioCAACAHpyEDC0EAIAM2AqSToIEAIAYhBwJAAkAgBkEAKALok6CBACIArFUNAEL//wEhByAAQYCAAkgNAQtBAEEAKALQioCAAEGAgIAEcjYC0IqAgAAgB6chAAtBACAANgKok6CBAAJAIAQpAxBCDIciB0KAgH58Qv//e1YNAEEAQQAoAtCKgIAAQYCAgAJyNgLQioCAAAtBACAGQQA0AuyToIEAIghC//8BIAhC//8BUxsgBiAIVRs+AqyToIEAQgAhBgJAAkAgB0IAUw0AQv//AyEGIAdCgIAEVA0BC0EAQQAoAtCKgIAAQYCAEHI2AtCKgIAAIAYhBwtBACkCxJOggQAhBkEAQQAoAsyToIEANgLIk6CBAEEAIAY3A8CToIEAQQAgB6ciAjYCzJOggQACQAJAIAJBAXRBAC8B6JWggQAiBUsNAEEAQQAoAtCKgIAAQYCACHI2AtCKgIAAQv//ByEHDAELIAIgAmdBcGoiCXQiAkHAgH5qQQd1QQJ0QfCWoIEAaigCAEGBAmqsIgZCgICAgIiAgAEgBiACrX5CGIZ9QiCHfkIYhkKAgICACHxCIIcgBa0gCa2GfkKAgAJ8QhCHIgZC//8HIAZC//8HUxshBwtBgIAEIQICQAJAIAcgA6x+QQA0AuCVoIEAfCIIQv////8HVQ0AQYCAAiECIAhC/////3dVDQELQQBBACgC0IqAgAAgAnI2AtCKgIAAC0GAgAQhAwJAAkAgByAArH5BADQC5JWggQB8IgZC/////wdVDQBBgIACIQMgBkL/////d1UNAQtBAEEAKALQioCAACADcjYC0IqAgAALQQAgBj4C4JOggQAgBkIQhyEGQoB4IQoCQAJAIAhCEIciCEKAeFMNAEL/ByEKIAhCgAhTDQELQQBBACgC0IqAgABBgIABcjYC0IqAgAAgCiEIC0KAeCEKAkACQCAGQoB4Uw0AQv8HIQogBkKACFMNAQtBAEEAKALQioCAAEGAwAByNgLQioCAACAKIQYLQQBBACkCtJOggQA3A7CToIEAQQAgBqdBEHQgCKdB//8DcXI2AriToIEAAkAgAUUNAEGAgAQhAwJAAkAgB0EAMgHslaCBAH5BADQC8JWggQB8IgZC/////wdVDQBBgIACIQMgBkL/////d1UNAQtBAEEAKALQioCAACADcjYC0IqAgAALQQAgBj4C4JOggQBBACAGQgyHIgZCgCAgBkKAIFMbIgdCACAHQgBVGz4CoJOggQAgBkKBIFQNAEEAQQAoAtCKgIAAQYAgcjYC0IqAgAALIARBMGokgICAgAAL2QkDAX4BfwJ+QgAhBwJAIAJFDQAgAjQCAEIMhiEHC0GAgICABCEIAkACQCABNAIAIAAyAQB+IAd8IgdC////////AVUNAEGAgIDAACEIIAdC////////fVUNAQtBAEEAKALQioCAACAIcjYC0IqAgAALQYCAgIAEIQgCQAJAIAE0AgQgAEECajIBAH4gB0IUhkIUh3wiB0L///////8BVQ0AQYCAgMAAIQggB0L///////99VQ0BC0EAQQAoAtCKgIAAIAhyNgLQioCAAAtBgICAgAQhCAJAAkAgATQCCCAAQQRqMgEAfiAHQhSGQhSHfCIJQv///////wFVDQBBgICAwAAhCCAJQv///////31VDQELQQBBACgC0IqAgAAgCHI2AtCKgIAAC0IAQoCAfiAEGyEHIAYgCUIUhkIUhzcDAEEAIAlCDIggCSADGyIJpyIINgLkk6CBAAJAIAVFDQAgByEKAkACQCAHIAnEIglVDQBC//8BIQogCEGAgAJIDQELQQBBACgC0IqAgABBgICACHI2AtCKgIAAIAohCQtBACAJPgKkk6CBAAsCQAJAIAINAEIAIQkMAQsgAjQCBEIMhiEJC0GAgICAAiEIAkACQCABNAIAIAAyAQZ+IAl8IglC////////AVUNAEGAgIAgIQggCUL///////99VQ0BC0EAQQAoAtCKgIAAIAhyNgLQioCAAAtBgICAgAIhCAJAAkAgATQCBCAAQQhqMgEAfiAJQhSGQhSHfCIJQv///////wFVDQBBgICAICEIIAlC////////fVUNAQtBAEEAKALQioCAACAIcjYC0IqAgAALQYCAgIACIQgCQAJAIAE0AgggAEEKajIBAH4gCUIUhkIUh3wiCUL///////8BVQ0AQYCAgCAhCCAJQv///////31VDQELQQBBACgC0IqAgAAgCHI2AtCKgIAACyAGIAlCFIZCFIc3AwhBACAJQgyIIAkgAxsiCaciCDYC6JOggQACQCAFRQ0AIAchCgJAAkAgByAJxCIJVQ0AQv//ASEKIAhBgIACSA0BC0EAQQAoAtCKgIAAQYCAgARyNgLQioCAACAKIQkLQQAgCT4CqJOggQALAkACQCACDQBCACEJDAELIAI0AghCDIYhCQtBgICAgAEhAgJAAkAgATQCACAAMgEMfiAJfCIJQv///////wFVDQBBgICAECECIAlC////////fVUNAQtBAEEAKALQioCAACACcjYC0IqAgAALQYCAgIABIQICQAJAIAE0AgQgAEEOajIBAH4gCUIUhkIUh3wiCUL///////8BVQ0AQYCAgBAhAiAJQv///////31VDQELQQBBACgC0IqAgAAgAnI2AtCKgIAAC0GAgICAASECAkACQCABNAIIIABBEGoyAQB+IAlCFIZCFId8IglC////////AVUNAEGAgIAQIQIgCUL///////99VQ0BC0EAQQAoAtCKgIAAIAJyNgLQioCAAAsgBiAJQhSGQhSHNwMQQQAgCUIMiCAJIAMbIgmnIgE2AuyToIEAAkAgBUUNAAJAAkAgByAJxCIJVQ0AQv//ASEHIAFBgIACSA0BC0EAQQAoAtCKgIAAQYCAgAJyNgLQioCAACAHIQkLQQAgCT4CrJOggQALC/YKBAJ/An4DfwF+I4CAgIAAQdAAayIEJICAgIAAQQAhBUGglqCBACAAQQAgAiADQQEgBEEwahCQgICAACAEQQAoAqSToIEANgIkIARBACkDqJOggQA3AiggBEEAKAK0laCBADYCGCAEQQApA7iVoIEANwIcQcCWoIEAIARBJGogBEEYaiACIANBASAEQTBqEJCAgIAAAkACQAJAAkACQAJAIAEOAgABAgtBACgC0IqAgAAhAwJAAkBBACgC5JOggQBBBHUiAkEASA0AQf8BIQUgAkGAAk8NACACIQUMAQtBACADQYCAgAFyIgM2AtCKgIAAC0EAIQACQAJAQQAoAuiToIEAQQR1IgJBAEgNAEH/ASEAIAJBgAJPDQAgAiEADAELQQAgA0GAgMAAciIDNgLQioCAAAtBACEBAkACQEEAKALsk6CBAEEEdSICQQBIDQBB/wEhASACQYACSQ0BC0EAIANBgIAgcjYC0IqAgAAgASECC0EAQQApAtSToIEANwPQk6CBAEEAQQAtAJuToIEAQRh0IAJBEHQgAEEIdCAFampqNgLYk6CBAAwEC0IAQoCAfiADGyEGQQAoApiToIEAIgBBEHZB/wFxIQEgAEEIdkH/AXEhBSAAQf8Bca0hB0EAKALQioCAACEDQQAoAqyToIEAIQhBACgCqJOggQAhCUEAKAKkk6CBACEKAkAgAg0AQQAgCq0gB34iC6dBBHQiAjYC5JOggQAgBiEHAkACQCAGIAtCJIZCIIciC1UNAEL//wEhByALQoCAAlkNACALIQcMAQtBACADQYCAgAhyIgM2AtCKgIAAC0EAIAc+AqSToIEAQQAgCa0gBa1+IgunQQR0Igk2AuiToIEAIAYhBwJAAkAgBiALQiSGQiCHIgtVDQBC//8BIQcgC0KAgAJZDQAgCyEHDAELQQAgA0GAgIAEciIDNgLQioCAAAtBACAHPgKok6CBAEEAIAitIAGtfiIHp0EEdCIKNgLsk6CBACAGIAdCJIZCIIciB1UNAkL//wEhBiAHQoCAAlMNAwwCC0EAIAqsIAd+QgiIIgunIgI2AuSToIEAIAYhBwJAAkAgBiALxCILVQ0AQv//ASEHIAtCgIACWQ0AIAshBwwBC0EAIANBgICACHIiAzYC0IqAgAALQQAgBz4CpJOggQBBACAJrCAFrX5CCIgiC6ciCTYC6JOggQAgBiEHAkACQCAGIAvEIgtVDQBC//8BIQcgC0KAgAJZDQAgCyEHDAELQQAgA0GAgIAEciIDNgLQioCAAAtBACAHPgKok6CBAEEAIAisIAGtfkIIiCIHpyIKNgLsk6CBACAGIAfEIgdVDQFC//8BIQYgB0L//wFVDQEMAgsgBEEAKAKYk6CBACIAQQx2QfAfca1BADQCrJOggQB+NwMQIAQgAEEEdkHwH3GtQQA0AqiToIEAfjcDCCAEIABBBHRB8B9xrUEANAKkk6CBAH43AwAgBCACIAMQjoCAgAAMAgtBACADQYCAgAJyIgM2AtCKgIAAIAYhBwtBACAHPgKsk6CBAEEAIQECQAJAIAJBBHUiAkEASA0AQf8BIQEgAkGAAk8NACACIQEMAQtBACADQYCAgAFyIgM2AtCKgIAAC0EAIQUCQAJAIAlBBHUiAkEASA0AQf8BIQUgAkGAAk8NACACIQUMAQtBACADQYCAwAByIgM2AtCKgIAAC0EAIQgCQAJAIApBBHUiAkEASA0AQf8BIQggAkGAAkkNAQtBACADQYCAIHI2AtCKgIAAIAghAgtBAEEAKQLUk6CBADcD0JOggQBBACAAQYCAgHhxIAJBEHQgBUEIdCABampqNgLYk6CBAAsgBEHQAGokgICAgAALCycBAEGACAsgBgwYBgUJChk3EREmBg0ZBQwYAAAACygAIAsoAEALKAA=';\\n\\nreturn { WASM_B64 };\\n})();\\nconst __src_wasmcpu = (() => {\\n// ============================================================================\\n//  CPU em WebAssembly (wasm/cpu.c): liga o núcleo compilado ao PSX.\\n//  RAM, BIOS e scratchpad passam a viver na memória linear do wasm (o JS enxerga como os mesmos Uint8Array de sempre);\\n//  os registradores da CPU também (cpu.r, cpu.cop0 e as propriedades pc/nextPc/cycles... viram janelas para essa memória).\\n//  Acessos a I/O e o GTE voltam ao JS por imports. Sem JIT: o núcleo é um interpretador compilado (sem aquecimento).\\n// ============================================================================\\nconst { WASM_B64 } = __src_wasmbin;\\nlet compiled = null;\\nfunction module_() {\\n  if (!compiled) {\\n    const bin = atob(WASM_B64), u8 = new Uint8Array(bin.length);\\n    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);\\n    compiled = new WebAssembly.Module(u8);\\n  }\\n  return compiled;\\n}\\n\\nfunction wasmAvailable() { return typeof WebAssembly === 'object' && typeof WebAssembly.Module === 'function'; }\\n\\n/** troca a CPU do `psx` pelo núcleo wasm. Pode ser chamado com a máquina em qualquer estado (copia o que já existe). */\\nfunction enableWasm(psx) {\\n  if (psx.wasm) return psx.wasm;\\n  const cpu = psx.cpu, bus = psx.bus, gte = cpu.gte;\\n  const memory = new WebAssembly.Memory({ initial: 64, maximum: 64 });\\n  const env = {\\n    memory,\\n    bread: (a, s) => { const v = bus.read(a >>> 0, s); S[7] = (bus.istat & bus.imask) !== 0 ? 1 : 0; return v | 0; },\\n    bwrite: (a, s, v) => { bus.write(a >>> 0, s, v >>> 0); S[7] = (bus.istat & bus.imask) !== 0 ? 1 : 0; },\\n  };\\n  const inst = new WebAssembly.Instance(module_(), { env });\\n  const x = inst.exports, buf = memory.buffer, P = i => x.ptr(i);\\n  const R = new Uint32Array(buf, P(0), 32), C0 = new Uint32Array(buf, P(1), 32), S = new Uint32Array(buf, P(2), 16), D = new Float64Array(buf, P(3), 4);\\n  const RAM = new Uint8Array(buf, P(4), 2 * 1024 * 1024), BIOS = new Uint8Array(buf, P(5), 512 * 1024), SCR = new Uint8Array(buf, P(6), 1024);\\n\\n  // GTE: registradores na memória do wasm (o GTE em C substitui o de JS)\\n  const gd = new Int32Array(buf, P(7), 32), gc = new Int32Array(buf, P(8), 64), grt = new Int16Array(buf, P(9), 9), gll = new Int16Array(buf, P(10), 9), glc = new Int16Array(buf, P(11), 9);\\n  gd.set(gte.d); gc.set(gte.c); grt.set(gte.rt); gll.set(gte.ll); glc.set(gte.lc); const gflag = gte.flag;\\n  gte.d = gd; gte.c = gc; gte.rt = grt; gte.ll = gll; gte.lc = glc;\\n  Object.defineProperty(gte, 'flag', { get: () => S[12], set: v => { S[12] = v >>> 0; }, enumerable: true, configurable: true }); gte.flag = gflag;\\n  // copia o estado atual para a memória do wasm\\n  R.set(cpu.r); C0.set(cpu.cop0); RAM.set(bus.ram); BIOS.set(bus.bios); SCR.set(bus.scratch);\\n  const cur = { hi: cpu.hi, lo: cpu.lo, pc: cpu.pc, nextPc: cpu.nextPc, isBranch: cpu.isBranch, pendReg: cpu.pendReg, pendVal: cpu.pendVal, cycles: cpu.cycles, instrCount: cpu.instrCount, nextTick: psx.nextTick };\\n  cpu.r = R; cpu.cop0 = C0;\\n  bus.ram = RAM; bus.ramView = new DataView(buf, P(4), RAM.length);\\n  bus.bios = BIOS; bus.biosView = new DataView(buf, P(5), BIOS.length);\\n  bus.scratch = SCR; bus.scratchView = new DataView(buf, P(6), SCR.length);\\n\\n  const u32 = (o, name, i) => Object.defineProperty(o, name, { get: () => S[i], set: v => { S[i] = v; }, enumerable: true, configurable: true });\\n  const bool = (o, name, i) => Object.defineProperty(o, name, { get: () => S[i] !== 0, set: v => { S[i] = v ? 1 : 0; }, enumerable: true, configurable: true });\\n  const f64 = (o, name, i) => Object.defineProperty(o, name, { get: () => D[i], set: v => { D[i] = v; }, enumerable: true, configurable: true });\\n  u32(cpu, 'hi', 0); u32(cpu, 'lo', 1); u32(cpu, 'pc', 2); u32(cpu, 'nextPc', 3); bool(cpu, 'isBranch', 4); u32(cpu, 'pendReg', 5); u32(cpu, 'pendVal', 6);\\n  f64(cpu, 'cycles', 0); f64(cpu, 'instrCount', 1); f64(psx, 'nextTick', 2);\\n  cpu.hi = cur.hi; cpu.lo = cur.lo; cpu.pc = cur.pc; cpu.nextPc = cur.nextPc; cpu.isBranch = cur.isBranch; cpu.pendReg = cur.pendReg; cpu.pendVal = cur.pendVal;\\n  cpu.cycles = cur.cycles; cpu.instrCount = cur.instrCount; psx.nextTick = cur.nextTick;\\n  S[8] = psx.hookTTY ? 1 : 0;\\n\\n  psx.useJit = false; psx.jit.flush();\\n  const w = psx.wasm = {\\n    memory, exports: x, S,\\n    /** roda até o próximo tick; devolve 1 se parou no vetor A0/B0 (TTY) */\\n    run() { S[7] = (bus.istat & bus.imask) !== 0 ? 1 : 0; S[8] = psx.hookTTY ? 1 : 0; return x.run(); },\\n    skipHook() { S[9] = 1; },\\n  };\\n  return w;\\n}\\n\\nreturn { wasmAvailable, enableWasm };\\n})();\\nconst __src_disasm = (() => {\\n// Disassembler MIPS I (R3000A) - usado para trace/debug\\nconst { REG_NAMES } = __src_cpu;\\nconst R = REG_NAMES.map(n => '$' + n);\\nconst h = (v, n = 8) => '0x' + (v >>> 0).toString(16).padStart(n, '0');\\n\\nfunction disasm(w, pc) {\\n  if (w === 0) return 'nop';\\n  const op = w >>> 26, rs = (w >>> 21) & 31, rt = (w >>> 16) & 31, rd = (w >>> 11) & 31;\\n  const sh = (w >>> 6) & 31, imm = w & 0xFFFF, simm = (w << 16) >> 16;\\n  const mem = n => `${n} ${R[rt]}, ${simm}(${R[rs]})`;\\n  const br = n => `${n} ${R[rs]}, ${R[rt]}, ${h(pc + 4 + (simm << 2))}`;\\n  switch (op) {\\n    case 0x00: {\\n      const f = w & 0x3F;\\n      const sh3 = { 0x00: 'sll', 0x02: 'srl', 0x03: 'sra' };\\n      const shv = { 0x04: 'sllv', 0x06: 'srlv', 0x07: 'srav' };\\n      const alu = { 0x20: 'add', 0x21: 'addu', 0x22: 'sub', 0x23: 'subu', 0x24: 'and', 0x25: 'or', 0x26: 'xor', 0x27: 'nor', 0x2A: 'slt', 0x2B: 'sltu' };\\n      if (sh3[f]) return `${sh3[f]} ${R[rd]}, ${R[rt]}, ${sh}`;\\n      if (shv[f]) return `${shv[f]} ${R[rd]}, ${R[rt]}, ${R[rs]}`;\\n      if (alu[f]) return `${alu[f]} ${R[rd]}, ${R[rs]}, ${R[rt]}`;\\n      switch (f) {\\n        case 0x08: return `jr ${R[rs]}`;\\n        case 0x09: return `jalr ${R[rd]}, ${R[rs]}`;\\n        case 0x0C: return 'syscall';\\n        case 0x0D: return 'break';\\n        case 0x10: return `mfhi ${R[rd]}`;\\n        case 0x11: return `mthi ${R[rs]}`;\\n        case 0x12: return `mflo ${R[rd]}`;\\n        case 0x13: return `mtlo ${R[rs]}`;\\n        case 0x18: return `mult ${R[rs]}, ${R[rt]}`;\\n        case 0x19: return `multu ${R[rs]}, ${R[rt]}`;\\n        case 0x1A: return `div ${R[rs]}, ${R[rt]}`;\\n        case 0x1B: return `divu ${R[rs]}, ${R[rt]}`;\\n      }\\n      return `.word ${h(w)}`;\\n    }\\n    case 0x01: {\\n      const n = ['bltz', 'bgez', 'bltzal', 'bgezal'][((rt >> 3) & 2) | (rt & 1)];\\n      return `${n} ${R[rs]}, ${h(pc + 4 + (simm << 2))}`;\\n    }\\n    case 0x02: return `j ${h(((pc + 4) & 0xF0000000) | ((w & 0x3FFFFFF) << 2))}`;\\n    case 0x03: return `jal ${h(((pc + 4) & 0xF0000000) | ((w & 0x3FFFFFF) << 2))}`;\\n    case 0x04: return br('beq');\\n    case 0x05: return br('bne');\\n    case 0x06: return `blez ${R[rs]}, ${h(pc + 4 + (simm << 2))}`;\\n    case 0x07: return `bgtz ${R[rs]}, ${h(pc + 4 + (simm << 2))}`;\\n    case 0x08: return `addi ${R[rt]}, ${R[rs]}, ${simm}`;\\n    case 0x09: return `addiu ${R[rt]}, ${R[rs]}, ${simm}`;\\n    case 0x0A: return `slti ${R[rt]}, ${R[rs]}, ${simm}`;\\n    case 0x0B: return `sltiu ${R[rt]}, ${R[rs]}, ${simm}`;\\n    case 0x0C: return `andi ${R[rt]}, ${R[rs]}, ${h(imm, 4)}`;\\n    case 0x0D: return `ori ${R[rt]}, ${R[rs]}, ${h(imm, 4)}`;\\n    case 0x0E: return `xori ${R[rt]}, ${R[rs]}, ${h(imm, 4)}`;\\n    case 0x0F: return `lui ${R[rt]}, ${h(imm, 4)}`;\\n    case 0x10:\\n      if (rs === 0) return `mfc0 ${R[rt]}, cop0r${rd}`;\\n      if (rs === 4) return `mtc0 ${R[rt]}, cop0r${rd}`;\\n      if (w === 0x42000010) return 'rfe';\\n      return `cop0 ${h(w & 0x1FFFFFF)}`;\\n    case 0x12:\\n      if (w & 0x02000000) return `cop2 ${h(w & 0x1FFFFFF, 7)}`;\\n      return `${{ 0: 'mfc2', 2: 'cfc2', 4: 'mtc2', 6: 'ctc2' }[rs] || 'cop2?'} ${R[rt]}, cop2r${rd}`;\\n    case 0x20: return mem('lb');\\n    case 0x21: return mem('lh');\\n    case 0x22: return mem('lwl');\\n    case 0x23: return mem('lw');\\n    case 0x24: return mem('lbu');\\n    case 0x25: return mem('lhu');\\n    case 0x26: return mem('lwr');\\n    case 0x28: return mem('sb');\\n    case 0x29: return mem('sh');\\n    case 0x2A: return mem('swl');\\n    case 0x2B: return mem('sw');\\n    case 0x2E: return mem('swr');\\n    case 0x32: return `lwc2 cop2r${rt}, ${simm}(${R[rs]})`;\\n    case 0x3A: return `swc2 cop2r${rt}, ${simm}(${R[rs]})`;\\n  }\\n  return `.word ${h(w)}`;\\n}\\n\\nreturn { disasm };\\n})();\\nconst __src_bus = (() => {\\n// ============================================================================\\n//  Bus / Memory map do PS1\\n// ============================================================================\\n//  Endereço virtual (KUSEG/KSEG0/KSEG1) -> físico removendo os 3 bits altos:\\n//    KUSEG 0x00000000-0x7FFFFFFF  (cacheado, máscara 0xFFFFFFFF)\\n//    KSEG0 0x80000000-0x9FFFFFFF  (cacheado, máscara 0x7FFFFFFF)\\n//    KSEG1 0xA0000000-0xBFFFFFFF  (NÃO cacheado, máscara 0x1FFFFFFF)\\n//    KSEG2 0xC0000000-0xFFFFFFFF  (só 0xFFFE0130 = Cache Control)\\n//\\n//  Mapa físico:\\n//    0x00000000-0x007FFFFF  RAM 2MB (espelhada 4x até 8MB)\\n//    0x1F000000-0x1F7FFFFF  Expansion 1 (cartucho / PIO) - sem nada = 0xFF\\n//    0x1F800000-0x1F8003FF  Scratchpad (D-Cache usado como RAM, 1KB)\\n//    0x1F801000-0x1F801FFF  I/O (memctrl, DMA, timers, CDROM, GPU, MDEC, SPU)\\n//    0x1F802000-0x1F803FFF  Expansion 2 (POST/DUART)\\n//    0x1FC00000-0x1FC7FFFF  BIOS ROM 512KB\\n// ============================================================================\\n\\nconst REGION_MASK = new Uint32Array([\\n  0xFFFFFFFF, 0xFFFFFFFF, 0xFFFFFFFF, 0xFFFFFFFF, // KUSEG\\n  0x7FFFFFFF,                                     // KSEG0\\n  0x1FFFFFFF,                                     // KSEG1\\n  0xFFFFFFFF, 0xFFFFFFFF,                         // KSEG2\\n]);\\nconst SIZE_MASK = [0, 0xFF, 0xFFFF, 0, 0xFFFFFFFF];\\n\\nconst RAM_SIZE = 2 * 1024 * 1024;\\nconst BIOS_SIZE = 512 * 1024;\\n\\nclass Bus {\\n  constructor() {\\n    this.pollOn = false; this.ioSeq = 0; this.psx = null; this.poll = { p: -1, v: -1, t: 0, d1: -1, d2: -2, n: 0, seq: 0, skipped: 0, jumps: 0 };\\n    this.ram = new Uint8Array(RAM_SIZE);\\n    this.ramView = new DataView(this.ram.buffer);\\n    this.scratch = new Uint8Array(1024);\\n    this.scratchView = new DataView(this.scratch.buffer);\\n    this.bios = new Uint8Array(BIOS_SIZE).fill(0xFF);\\n    this.biosView = new DataView(this.bios.buffer);\\n    this.io = new Uint8Array(0x2000);          // backing store dos registradores I/O ainda não emulados\\n    this.ioView = new DataView(this.io.buffer);\\n\\n    this.codeFlags = new Uint8Array(RAM_SIZE >> 6);   // linhas de 64 B da RAM que contêm código compilado (JIT)\\n    this.onCodeWrite = null;\\n    this.istat = 0;                            // 0x1F801070 I_STAT\\n    this.imask = 0;                            // 0x1F801074 I_MASK\\n    this.cacheCtrl = 0;                        // 0xFFFE0130\\n    this.gpuToggle = 0;\\n\\n    this.logIo = false;                        // contabiliza acessos a I/O (útil p/ mapear o que a BIOS usa)\\n    this.ioStats = new Map();\\n    this.unmapped = new Map();\\n    this.onPost = null;                        // callback(code) escrita em 0x1F802041\\n    this.gpu = null;                           // GPU  (0x1F801810 / 0x1F801814)\\n    this.spu = null;                           // SPU  (0x1F801C00-0x1F801FFF)\\n    this.dma = null; this.timers = null; this.sio = null; this.cdrom = null; this.mdec = null;   // dispositivos (ligados pelo PSX)\\n  }\\n\\n  loadBios(data) {\\n    if (data.length !== BIOS_SIZE) throw new Error(`BIOS deve ter ${BIOS_SIZE} bytes, recebeu ${data.length}`);\\n    this.bios.set(data);\\n  }\\n\\n  // ---- IRQ (I_STAT / I_MASK) ----\\n  irqPending() { return (this.istat & this.imask) !== 0; }\\n  raiseIrq(n) { this.istat |= (1 << n); }\\n\\n  // ---- Leitura ----\\n  read32(addr) { return this.read(addr, 4); }\\n  read16(addr) { return this.read(addr, 2); }\\n  read8(addr)  { return this.read(addr, 1); }\\n\\n  read(addr, size) {\\n    const p = (addr & REGION_MASK[addr >>> 29]) >>> 0;\\n    if (p < 0x00800000) {\\n      const o = p & 0x1FFFFF;\\n      return size === 4 ? this.ramView.getUint32(o, true)\\n           : size === 2 ? this.ramView.getUint16(o, true) : this.ram[o];\\n    }\\n    if (p >= 0x1FC00000 && p < 0x1FC80000) {\\n      const o = p - 0x1FC00000;\\n      return size === 4 ? this.biosView.getUint32(o, true)\\n           : size === 2 ? this.biosView.getUint16(o, true) : this.bios[o];\\n    }\\n    if (p >= 0x1F800000 && p < 0x1F800400) {\\n      const o = p - 0x1F800000;\\n      return size === 4 ? this.scratchView.getUint32(o, true)\\n           : size === 2 ? this.scratchView.getUint16(o, true) : this.scratch[o];\\n    }\\n    if (p >= 0x1F801000 && p < 0x1F802000) return this.ioRead(p, size);\\n    if (p >= 0x1F000000 && p < 0x1F800000) return SIZE_MASK[size];   // Expansion 1 vazio\\n    if (p >= 0x1F802000 && p < 0x1F804000) return 0;                 // Expansion 2\\n    if (p === 0xFFFE0130) return this.cacheCtrl;\\n    this.noteUnmapped('R', p, size);\\n    return SIZE_MASK[size];\\n  }\\n\\n  // ---- Escrita ----\\n  write32(addr, v) { this.write(addr, 4, v); }\\n  write16(addr, v) { this.write(addr, 2, v); }\\n  write8(addr, v)  { this.write(addr, 1, v); }\\n\\n  write(addr, size, v) {\\n    const p = (addr & REGION_MASK[addr >>> 29]) >>> 0;\\n    if (p < 0x00800000) {\\n      const o = p & 0x1FFFFF;\\n      if (size === 4) this.ramView.setUint32(o, v >>> 0, true);\\n      else if (size === 2) this.ramView.setUint16(o, v & 0xFFFF, true);\\n      else this.ram[o] = v;\\n      if (this.codeFlags[o >>> 6]) this.onCodeWrite(o);\\n      return;\\n    }\\n    if (p >= 0x1F800000 && p < 0x1F800400) {\\n      const o = p - 0x1F800000;\\n      if (size === 4) this.scratchView.setUint32(o, v >>> 0, true);\\n      else if (size === 2) this.scratchView.setUint16(o, v & 0xFFFF, true);\\n      else this.scratch[o] = v;\\n      return;\\n    }\\n    if (p >= 0x1F801000 && p < 0x1F802000) return this.ioWrite(p, size, v);\\n    if (p >= 0x1F802000 && p < 0x1F804000) {\\n      if (p === 0x1F802041 && this.onPost) this.onPost(v & 0xFF);\\n      return;\\n    }\\n    if (p >= 0x1FC00000 && p < 0x1FC80000) return;                   // ROM: ignora\\n    if (p >= 0x1F000000 && p < 0x1F800000) return;                   // Expansion 1\\n    if (p === 0xFFFE0130) { this.cacheCtrl = v >>> 0; return; }\\n    this.noteUnmapped('W', p, size);\\n  }\\n\\n  // ---- I/O ----\\n  /** leitura de I/O. Com pollOn (psx.pollSkip = true) reconhece laços de espera (\\\"lê o mesmo registrador, mesmo valor, período constante\\\")\\n   *  e avança o relógio até o próximo instante em que o valor pode mudar (fim da linha de vídeo, evento agendado, fim do \\\"ocupado\\\" da GPU). */\\n  ioRead(p, size) {\\n    if (!this.pollOn) return this.ioRead0(p, size);\\n    const q = p & ~3;\\n    if (!(q === 0x1F801814 || q === 0x1F801070 || (p >= 0x1F801100 && p < 0x1F801130 && (p & 0xF) === 0) || (p >= 0x1F801080 && p < 0x1F801100 && (p & 0xF) === 8))) { this.ioSeq = (this.ioSeq + 1) | 0; return this.ioRead0(p, size); }\\n    let v = this.ioRead0(p, size);\\n    const ps = this.poll, psx = this.psx, now = psx.cpu.cycles, d = now - ps.t;\\n    if (p === ps.p && v === ps.v && this.ioSeq === ps.seq && d === ps.d2) ps.n++; else ps.n = 0;\\n    ps.d2 = ps.d1; ps.d1 = d; ps.t = now; ps.p = p; ps.v = v; ps.seq = this.ioSeq;\\n    if (ps.n >= 8) {\\n      ps.n = 0;\\n      if (!(this.istat & this.imask)) {\\n        let end = psx.lastTick + (psx.gpu.pal ? 2157.2 : 2146.3) - psx.lineAcc; const ev = psx.sched.next; if (ev < end) end = ev;\\n        const bu = psx.gpu.busyUntil; if (bu > now && bu < end) end = bu;\\n        if (end - now > 4 * (d > 0 ? d : 1)) { psx.cpu.cycles = Math.ceil(end); ps.skipped += end - now; ps.jumps++; v = this.ioRead0(p, size); ps.v = v; ps.t = psx.cpu.cycles; }\\n      }\\n    }\\n    return v;\\n  }\\n  ioRead0(p, size) {\\n    if (this.logIo) this.countIo('R', p, size);\\n    const off = p - 0x1F801000;\\n    if (p >= 0x1F801810 && p < 0x1F801818 && this.gpu) { if ((p & ~3) === 0x1F801810) return this.gpu.readData() >>> ((p & 3) * 8); return this.gpu.readStatus() >>> ((p & 3) * 8); }   // GPU primeiro (é o registrador mais lido)\\n    if (this.spu && p >= 0x1F801C00) return this.spu.read(p, size);\\n    if (this.cdrom && p >= 0x1F801800 && p < 0x1F801804) return this.cdrom.read(p, size);\\n    if (this.mdec && (p & ~3) >= 0x1F801820 && (p & ~3) <= 0x1F801824) return this.mdec.read(p & ~3);\\n    if (p >= 0x1F801820 && p < 0x1F801828) return (p & ~3) === 0x1F801824 ? 0x80040000 >>> ((p & 3) * 8) : 0;   // sem MDEC: status \\\"FIFOs vazios\\\"\\n    if (this.dma && p >= 0x1F801080 && p < 0x1F801100) return this.dma.read(p, size);\\n    if (this.timers && p >= 0x1F801100 && p < 0x1F801130) return this.timers.read(p, size);\\n    if (this.sio && p >= 0x1F801040 && p < 0x1F801050) return this.sio.read(p, size);\\n    // SPUSTAT (0x1F801DAE) espelha os 6 bits baixos do SPUCNT (0x1F801DAA) - fallback sem SPU\\n    if (p === 0x1F801DAE && size === 2) return this.ioView.getUint16(0xDAA, true) & 0x3F;\\n\\n    const base = (p & ~3) >>> 0, shift = (p & 3) * 8;\\n    let v = null;\\n    switch (base) {\\n      case 0x1F801070: v = this.istat; break;\\n      case 0x1F801074: v = this.imask; break;\\n      case 0x1F801814:                                   // GPUSTAT (fallback sem GPU): pronto\\n        v = 0x1C000000; break;\\n    }\\n    if (v !== null) return ((v >>> shift) & SIZE_MASK[size]) >>> 0;\\n\\n    return size === 4 ? this.ioView.getUint32(off, true)\\n         : size === 2 ? this.ioView.getUint16(off, true) : this.io[off];\\n  }\\n\\n  ioWrite(p, size, v) {\\n    if (this.logIo) this.countIo('W', p, size);\\n    const off = p - 0x1F801000;\\n    if (this.spu && p >= 0x1F801C00) return this.spu.write(p, size, v);\\n    if (this.cdrom && p >= 0x1F801800 && p < 0x1F801804) return this.cdrom.write(p, size, v);\\n    if (this.dma && p >= 0x1F801080 && p < 0x1F801100) return this.dma.write(p, size, v);\\n    if (this.timers && p >= 0x1F801100 && p < 0x1F801130) return this.timers.write(p, size, v);\\n    if (this.sio && p >= 0x1F801040 && p < 0x1F801050) return this.sio.write(p, size, v);\\n    if (this.mdec && (p & ~3) >= 0x1F801820 && (p & ~3) <= 0x1F801824) return this.mdec.write(p & ~3, v);\\n    if (this.gpu && (p & ~3) === 0x1F801810) return this.gpu.writeGP0(v);\\n    if (this.gpu && (p & ~3) === 0x1F801814) return this.gpu.writeGP1(v);\\n    const base = (p & ~3) >>> 0, shift = (p & 3) * 8;\\n    const m = (SIZE_MASK[size] << shift);\\n    if (base === 0x1F801070) {                           // I_STAT: escrever 0 reconhece (limpa) o bit\\n      this.istat = (this.istat & (~m | (v << shift))) & 0x7FF; return;\\n    }\\n    if (base === 0x1F801074) {                           // I_MASK\\n      this.imask = ((this.imask & ~m) | ((v << shift) & m)) & 0x7FF; return;\\n    }\\n    if (size === 4) this.ioView.setUint32(off, v >>> 0, true);\\n    else if (size === 2) this.ioView.setUint16(off, v & 0xFFFF, true);\\n    else this.io[off] = v;\\n  }\\n\\n  countIo(rw, p, size) {\\n    const k = `${rw}${size} ${p.toString(16).toUpperCase().padStart(8, '0')}`;\\n    this.ioStats.set(k, (this.ioStats.get(k) || 0) + 1);\\n  }\\n  noteUnmapped(rw, p, size) {\\n    const k = `${rw}${size} ${p.toString(16).toUpperCase().padStart(8, '0')}`;\\n    this.unmapped.set(k, (this.unmapped.get(k) || 0) + 1);\\n  }\\n}\\n\\nreturn { RAM_SIZE, BIOS_SIZE, Bus };\\n})();\\nconst __src_gpu = (() => {\\n// ============================================================================\\n//  GPU do PS1 - rasterizador por software\\n// ============================================================================\\n//  Portas:  0x1F801810 GP0 (desenho/VRAM) / GPUREAD      0x1F801814 GP1 (controle) / GPUSTAT\\n//  VRAM:    1024x512 pixels de 16 bits (RGB555 + bit de máscara)\\n//\\n//  Implementado: fill, polígonos (flat/gouraud/texturizados 4/8/15 bits, semi-transparência\\n//  4 modos, dither, máscara), retângulos, linhas/polilinhas, cópias de VRAM (CPU<->VRAM,\\n//  VRAM->VRAM), janela de textura, area/offset de desenho, saída 15/24 bits.\\n//  Simplificações: sem timing real de GPU, interpolação em ponto flutuante (não bit-exata).\\n// ============================================================================\\n\\nconst PH_CMD = 0, PH_VRAM_WRITE = 1, PH_POLYLINE = 2;\\nconst LINE_EX = 1 / 4194304, LINE_EY = 0;                  // viés de arredondamento de x (medido no console real)\\nconst DITHER = [-4, 0, -3, 1, 2, -2, 3, -1, -3, 1, -4, 0, 3, -1, 2, -2];\\nconst sx11 = v => (v << 21) >> 21;                       // sinal 11 bits\\n\\n\\n// ---- scanline especializada (gerada por combinação de modos): mesma aritmética do plotNB/texel, sem ramos por pixel ----\\nconst QT = new Uint8Array(1024); for (let i = 0; i < 1024; i++) { const v = i - 8; QT[i] = (v < 0 ? 0 : v > 255 ? 255 : v) >> 3; }   // clamp8(v) >> 3, índice v+8\\nconst DITHER_T = new Int8Array(DITHER);\\nconst SPANS = new Map();\\nfunction spanFor(tex, td, gour, raw, semi, dd, chk, win) {\\n  const key = (tex ? td : 'n') + (gour ? 'G' : 'f') + (raw ? 'R' : 'm') + (semi ? 'S' : 'o') + (dd ? 'D' : 'n') + (chk ? 'C' : '-') + (win ? 'W' : '-');\\n  let f = SPANS.get(key); if (f) return f;\\n  let c = 'const rowI = y * 1024, dRow = (y & 3) << 2;\\\\nfor (let x = xl; x < xr; x++) {\\\\n';\\n  c += gour ? 'let r = ((cr | 0) >> 12) & 255, g = ((cg | 0) >> 12) & 255, bl = ((cb | 0) >> 12) & 255; cr += rGx; cg += gGx; cb += bGx;\\\\n' : 'let r = fr, g = fg, bl = fb;\\\\n';\\n  if (tex) {\\n    c += win ? 'const u = (((cu | 0) >> 12) & 255 & uAnd) | uOr, v = (((cv | 0) >> 12) & 255 & vAnd) | vOr;\\\\n' : 'const u = ((cu | 0) >> 12) & 255, v = ((cv | 0) >> 12) & 255;\\\\n';\\n    c += 'cu += uGx; cv += vGx;\\\\nconst row = ((tY + v) & 0x1FF) << 10;\\\\n';\\n    if (td === 0) c += 'const texel = clut[(vram[row + ((tBase + (u >> 2)) & 0x3FF)] >> ((u & 3) << 2)) & 15];\\\\n';\\n    else if (td === 1) c += 'const texel = clut[(vram[row + ((tBase + (u >> 1)) & 0x3FF)] >> ((u & 1) << 3)) & 255];\\\\n';\\n    else c += 'const texel = vram[row + ((tBase + u) & 0x3FF)];\\\\n';\\n    c += 'if (texel === 0) continue;\\\\n';\\n    if (semi) c += 'const sm = (texel & 0x8000) !== 0;\\\\n';\\n    c += 'const tr = texel & 31, tg = (texel >> 5) & 31, tb = (texel >> 10) & 31;\\\\n';\\n    c += raw ? 'r = tr << 3; g = tg << 3; bl = tb << 3;\\\\n' : 'r = (tr * r) >> 4; g = (tg * g) >> 4; bl = (tb * bl) >> 4;\\\\n';\\n  }\\n  c += 'const idx = rowI + x;\\\\n';\\n  if (chk || semi) c += 'const back = vram[idx];\\\\n';\\n  if (chk) c += 'if (back & 0x8000) continue;\\\\n';\\n  if (dd) c += 'const d = DITHER[dRow | (x & 3)]; r += d; g += d; bl += d;\\\\n';\\n  c += 'r = QT[r + 8]; g = QT[g + 8]; bl = QT[bl + 8];\\\\n';\\n  if (semi) {\\n    const blend = 'const br = back & 31, bg = (back >> 5) & 31, bb = (back >> 10) & 31;\\\\n' +\\n      'switch (smode) {\\\\ncase 0: r = (br + r) >> 1; g = (bg + g) >> 1; bl = (bb + bl) >> 1; break;\\\\n' +\\n      'case 1: r = br + r > 31 ? 31 : br + r; g = bg + g > 31 ? 31 : bg + g; bl = bb + bl > 31 ? 31 : bb + bl; break;\\\\n' +\\n      'case 2: r = br - r < 0 ? 0 : br - r; g = bg - g < 0 ? 0 : bg - g; bl = bb - bl < 0 ? 0 : bb - bl; break;\\\\n' +\\n      'default: r = Math.min(31, br + (r >> 2)); g = Math.min(31, bg + (g >> 2)); bl = Math.min(31, bb + (bl >> 2));\\\\n}\\\\n';\\n    c += tex ? 'if (sm) {\\\\n' + blend + '}\\\\n' : '{\\\\n' + blend + '}\\\\n';\\n  }\\n  c += 'vram[idx] = r | (g << 5) | (bl << 10) | setM;\\\\n}';\\n  f = new Function('vram', 'clut', 'QT', 'DITHER', 'y', 'xl', 'xr', 'cr', 'cg', 'cb', 'cu', 'cv', 'rGx', 'gGx', 'bGx', 'uGx', 'vGx', 'fr', 'fg', 'fb', 'tBase', 'tY', 'uAnd', 'uOr', 'vAnd', 'vOr', 'smode', 'setM', c);\\n  SPANS.set(key, f); return f;\\n}\\n\\nclass GPU {\\n  constructor() {\\n    this.vram = new Uint16Array(1024 * 512);\\n    this.pal = false;\\n    this.onIrq = null;\\n    this.hw = null;                                          // renderizador WebGL (glgpu.js); null = software\\n    this.remote = null;                                      // GpuStream: o desenho acontece num worker (esta instância só analisa os comandos e mantém o estado/temporização)\\n    this.line = 0; this.vblank = false; this.field = 0;      // temporização (atualizada pelo PSX)\\n    this.reset();\\n  }\\n\\n  reset() {\\n    this.phase = PH_CMD; this.buf = []; this.need = 1;\\n    // ---- estado de desenho (GP0 E1..E6) ----\\n    this.texX = 0; this.texY = 0; this.semiMode = 0; this.texDepth = 0; this.dither = false;\\n    this.drawToDisplay = false; this.texDisable = false; this.texDisAllow = false; this.busyUntil = 0; this.skipDraw = false; this.flipX = false; this.flipY = false;\\n    this.twMaskX = 0; this.twMaskY = 0; this.twOffX = 0; this.twOffY = 0;\\n    this.daX1 = 0; this.daY1 = 0; this.daX2 = 0; this.daY2 = 0;\\n    this.offX = 0; this.offY = 0;\\n    this.setMask = false; this.checkMask = false;\\n    this.clutValid = false; this.clutX = 0; this.clutY = 0; this.clutCount = 0; this.clut ??= new Uint16Array(256);   // cache de CLUT\\n    // ---- display (GP1) ----\\n    this.dispOn = false; this.dmaDir = 0; this.startX = 0; this.startY = 0;\\n    this.hx1 = 0x200; this.hx2 = 0xC00; this.vy1 = 0x10; this.vy2 = 0x100;\\n    this.hres1 = 0; this.hres2 = 0; this.vres = 0; this.rgb24 = false; this.interlace = false; this.reverse = false; this.deint = 1; this.snapPar = 0;\\n    this.irq1 = false;\\n    this.gpuRead = 0; this.infoSel = 0;\\n    // ---- transferências ----\\n    this.vw = null; this.vr = null;\\n    this.toggle = 0; this.line = 0; this.vblank = false; this.field = 0;\\n    this.frameCount = 0; this.snap = null; this.snapKey = '';\\n  }\\n\\n  // ===================== Registradores =====================\\n  readStatus() {\\n    let s = (this.texX & 15) | ((this.texY & 1) << 4) | (this.semiMode << 5) | (this.texDepth << 7) |\\n            ((this.dither ? 1 : 0) << 9) | ((this.drawToDisplay ? 1 : 0) << 10) | ((this.setMask ? 1 : 0) << 11) |\\n            ((this.checkMask ? 1 : 0) << 12) | (1 << 13) | ((this.reverse ? 1 : 0) << 14) | ((this.texDisable ? 1 : 0) << 15) |\\n            (this.hres2 << 16) | (this.hres1 << 17) | (this.vres << 19) | ((this.pal ? 1 : 0) << 20) |\\n            ((this.rgb24 ? 1 : 0) << 21) | ((this.interlace ? 1 : 0) << 22) | ((this.dispOn ? 0 : 1) << 23) |\\n            ((this.irq1 ? 1 : 0) << 24);\\n    const busy = !!this.clock && this.clock() < this.busyUntil;                 // GPU ainda desenhando o último comando\\n    const readyCmd = this.phase === PH_CMD && !this.vr && !busy;\\n    s |= (readyCmd ? 1 << 26 : 0) | (this.vr ? 1 << 27 : 0) | ((this.dmaDir === 0 || !busy ? 1 : 0) << 28) | (this.dmaDir << 29);\\n    // bit 25 = DMA data request, depende da direção\\n    const req = this.dmaDir === 0 ? 0 : this.dmaDir === 1 ? 1 : this.dmaDir === 2 ? (readyCmd ? 1 : 0) : (this.vr ? 1 : 0);\\n    s |= req << 25;\\n    // bit 31: campo par/ímpar - alterna (aproximação até existir timing de scanline)\\n    const odd = (this.interlace && this.vres) ? this.field : (this.vblank ? 0 : (this.line & 1));\\n    s |= (odd << 31);\\n    return s >>> 0;\\n  }\\n\\n  readData() {                                    // GPUREAD\\n    if (this.vr) return this.vramReadWord();\\n    return this.gpuRead >>> 0;\\n  }\\n\\n  // ===================== GP1 =====================\\n  writeGP1(w) {\\n    if (this.remote) this.remote.push(1, w >>> 0);\\n    const cmd = w >>> 24, p = w & 0xFFFFFF;\\n    switch (cmd) {\\n      case 0x00: this.reset(); break;\\n      case 0x01: this.phase = PH_CMD; this.buf = []; this.vw = null; this.vr = null; break;\\n      case 0x02: this.irq1 = false; break;\\n      case 0x03: this.dispOn = !(p & 1); break;\\n      case 0x04: this.dmaDir = p & 3; break;\\n      case 0x05: this.startX = p & 0x3FE; this.startY = (p >> 10) & 0x1FF; break;\\n      case 0x06: this.hx1 = p & 0xFFF; this.hx2 = (p >> 12) & 0xFFF; break;\\n      case 0x07: this.vy1 = p & 0x3FF; this.vy2 = (p >> 10) & 0x3FF; break;\\n      case 0x08:\\n        this.hres1 = p & 3; this.vres = (p >> 2) & 1; this.pal = !!((p >> 3) & 1);\\n        this.rgb24 = !!((p >> 4) & 1); this.interlace = !!((p >> 5) & 1); this.hres2 = (p >> 6) & 1; this.reverse = !!((p >> 7) & 1);\\n        break;\\n      case 0x09: this.texDisAllow = !!(p & 1); break;   // permite o bit \\\"texture disable\\\" (E1.11)\\n      default:\\n        if (cmd >= 0x10 && cmd <= 0x1F) {           // GET GPU INFO\\n          switch (p & 7) {\\n            case 2: this.gpuRead = this.twMaskX | (this.twMaskY << 5) | (this.twOffX << 10) | (this.twOffY << 15); break;\\n            case 3: this.gpuRead = this.daX1 | (this.daY1 << 10); break;\\n            case 4: this.gpuRead = this.daX2 | (this.daY2 << 10); break;\\n            case 5: this.gpuRead = (this.offX & 0x7FF) | ((this.offY & 0x7FF) << 11); break;\\n            case 7: this.gpuRead = 2; break;        // tipo de GPU\\n            default: break;\\n          }\\n        }\\n    }\\n  }\\n\\n  // ===================== GP0 =====================\\n  writeGP0(w) {\\n    w >>>= 0;\\n    const R = this.remote; if (R) { if (R.n >= R.q.length) R.flush(); R.q[R.n++] = 0; R.q[R.n++] = w; }\\n    if (this.phase === PH_VRAM_WRITE) { this.vramWriteWord(w); return; }\\n    if (this.phase === PH_POLYLINE) { this.polylineWord(w); return; }\\n    if (this.buf.length === 0) this.need = this.wordsFor(w >>> 24);\\n    this.buf.push(w);\\n    if (this.buf.length >= this.need) {\\n      const b = this.buf; this.buf = [];\\n      this.exec(b);\\n    }\\n  }\\n  /** Para DMA (canal 2): bloco de palavras em RAM */\\n  dmaWrite(words) { for (let i = 0; i < words.length; i++) this.writeGP0(words[i]); }\\n  dmaRead(n) { const o = new Uint32Array(n); for (let i = 0; i < n; i++) o[i] = this.readData(); return o; }\\n\\n  wordsFor(c) {\\n    if (c === 0x02) return 3;\\n    if (c >= 0x20 && c <= 0x3F) { const v = (c & 8) ? 4 : 3; return 1 + v + ((c & 4) ? v : 0) + ((c & 0x10) ? v - 1 : 0); }\\n    if (c >= 0x40 && c <= 0x5F) return (c & 0x10) ? 4 : 3;           // polilinha trata o resto\\n    if (c >= 0x60 && c <= 0x7F) return 2 + ((c & 4) ? 1 : 0) + (((c >> 3) & 3) === 0 ? 1 : 0);\\n    if (c >= 0x80 && c <= 0x9F) return 4;\\n    if (c >= 0xA0 && c <= 0xDF) return 3;\\n    return 1;\\n  }\\n\\n  exec(b) {\\n    const c = b[0] >>> 24;\\n    if (this.clock) this.chargeBusy(c, b);\\n    if (c === 0x02) return this.fillRect(b);\\n    if (c >= 0x20 && c <= 0x3F) return this.polygon(b, c);\\n    if (c >= 0x40 && c <= 0x5F) return this.lineCmd(b, c);\\n    if (c >= 0x60 && c <= 0x7F) return this.rect(b, c);\\n    if (c >= 0x80 && c <= 0x9F) return this.vramCopy(b);\\n    if (c >= 0xA0 && c <= 0xBF) return this.beginVramWrite(b);\\n    if (c >= 0xC0 && c <= 0xDF) return this.beginVramRead(b);\\n    switch (c) {\\n      case 0x01: this.clutValid = false; break;                  // limpa o cache de CLUT\\n      case 0x1F: this.irq1 = true; this.onIrq?.(); break;\\n      case 0xE1: {\\n        this.texX = b[0] & 15; this.texY = (b[0] >> 4) & 1; this.semiMode = (b[0] >> 5) & 3; this.texDepth = (b[0] >> 7) & 3;      // 3 é reservado: lido de volta como 3, tratado como 15 bits\\n        this.dither = !!((b[0] >> 9) & 1); this.drawToDisplay = !!((b[0] >> 10) & 1); this.texDisable = this.texDisAllow && !!((b[0] >> 11) & 1);\\n        this.flipX = !!((b[0] >> 12) & 1); this.flipY = !!((b[0] >> 13) & 1); break;\\n      }\\n      case 0xE2: this.twMaskX = b[0] & 31; this.twMaskY = (b[0] >> 5) & 31; this.twOffX = (b[0] >> 10) & 31; this.twOffY = (b[0] >> 15) & 31; break;\\n      case 0xE3: this.daX1 = b[0] & 0x3FF; this.daY1 = (b[0] >> 10) & 0x3FF; break;\\n      case 0xE4: this.daX2 = b[0] & 0x3FF; this.daY2 = (b[0] >> 10) & 0x3FF; break;\\n      case 0xE5: this.offX = sx11(b[0] & 0x7FF); this.offY = sx11((b[0] >> 11) & 0x7FF); break;\\n      case 0xE6: this.setMask = !!(b[0] & 1); this.checkMask = !!(b[0] & 2); break;\\n      default: break;                                // NOP / clear cache / etc.\\n    }\\n  }\\n\\n  // ===================== Tempo de desenho (GPUSTAT: pronto p/ comando / DMA) =====================\\n  /** estima quantos ciclos de CPU o comando mantém a GPU ocupada e soma em busyUntil */\\n  chargeBusy(c, b) {\\n    let cyc = 0;\\n    const semi = !!(c & 2), tex = !!(c & 4);\\n    // fatores calibrados com ps1-tests/gpu/bandwidth (PS1 real): ciclos de CPU por pixel\\n    if (c === 0x02) cyc = (((b[2] & 0x3FF) + 15) & ~15) * ((b[2] >>> 16) & 0x1FF) * 0.085 + 30;\\n    else if (c >= 0x20 && c <= 0x3F) {\\n      const n = (c & 8) ? 4 : 3, gour = !!(c & 0x10), tx = !!(c & 4);\\n      let p = 1, x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;\\n      for (let i = 0; i < n; i++) {\\n        if (i > 0 && gour) p++;\\n        const v = b[p++], x = ((v << 21) >> 21) + this.offX, y = ((v << 5) >> 21) + this.offY; if (tx) p++;\\n        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;\\n      }\\n      x0 = Math.max(x0, this.daX1); y0 = Math.max(y0, this.daY1); x1 = Math.min(x1, this.daX2); y1 = Math.min(y1, this.daY2);   // só conta a parte visível\\n      const area = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);\\n      cyc = area * (n === 4 ? 0.54 : 0.27) * (semi ? 1.5 : 1) * (tx ? 5.2 : 1) + 60;\\n    } else if (c >= 0x40 && c <= 0x5F) {\\n      const a = b[1], d = b[(c & 0x10) ? 3 : 2], dx = Math.abs(((a << 21) >> 21) - ((d << 21) >> 21)), dy = Math.abs(((a << 5) >> 21) - ((d << 5) >> 21));\\n      cyc = Math.max(dx, dy) * 1.2 + 40;\\n    } else if (c >= 0x60 && c <= 0x7F) {\\n      const sz = (c >> 3) & 3, w = sz === 0 ? b[b.length - 1] & 0x3FF : sz === 1 ? 1 : sz === 2 ? 8 : 16, h = sz === 0 ? (b[b.length - 1] >>> 16) & 0x1FF : sz === 1 ? 1 : sz === 2 ? 8 : 16;\\n      cyc = w * h * (tex ? 1.06 : semi ? 0.8 : 0.53) + 30;\\n    } else if (c >= 0x80 && c <= 0x9F) cyc = (((b[3] - 1) & 0x3FF) + 1) * ((((b[3] >>> 16) - 1) & 0x1FF) + 1) * 1.33 + 40;\\n    if (cyc > 0 && this.rowMask >= 0 && c !== 0x80 && !(c >= 0x80 && c <= 0x9F)) cyc *= 0.5;   // 480i: só metade das linhas é desenhada\\n    if (cyc > 0) { const now = this.clock(); this.busyUntil = Math.max(now, this.busyUntil) + cyc; }\\n  }\\n\\n  // ===================== Transferências VRAM =====================\\n  fillRect(b) {\\n    const col = rgb24to15(b[0]);\\n    const x0 = b[1] & 0x3F0, y0 = (b[1] >>> 16) & 0x1FF;\\n    const w = ((b[2] & 0x3FF) + 0xF) & ~0xF, h = (b[2] >>> 16) & 0x1FF;\\n    if (this.remote) return;\\n    if (this.hw) return this.hw.fill(x0, y0, w, h, b[0]);\\n    const mk = this.rowMask;\\n    for (let y = 0; y < h; y++) {\\n      if (mk >= 0 && ((y0 + y) & 1) === mk) continue;\\n      const row = ((y0 + y) & 0x1FF) * 1024;\\n      for (let x = 0; x < w; x++) this.vram[row + ((x0 + x) & 0x3FF)] = col;\\n    }\\n  }\\n\\n  beginVramWrite(b) {\\n    const x = b[1] & 0x3FF, y = (b[1] >>> 16) & 0x1FF;\\n    const w = ((b[2] - 1) & 0x3FF) + 1, h = (((b[2] >>> 16) - 1) & 0x1FF) + 1;\\n    if (this.hw && this.checkMask) this.hw.rects(x, y, w, h, (rx, ry, rw, rh) => this.hw.syncNative(rx, ry, rw, rh));\\n    this.vw = { x, y, w, h, i: 0, total: w * h };\\n    this.phase = PH_VRAM_WRITE;\\n  }\\n  vramWriteWord(word) {\\n    const t = this.vw;\\n    if (this.remote) { t.i += 2; if (t.i >= t.total) { this.phase = PH_CMD; this.vw = null; } return; }\\n    for (let k = 0; k < 2 && t.i < t.total; k++, t.i++) {\\n      const px = (word >>> (16 * k)) & 0xFFFF;\\n      const xx = (t.x + (t.i % t.w)) & 0x3FF, yy = (t.y + ((t.i / t.w) | 0)) & 0x1FF;\\n      const idx = yy * 1024 + xx;\\n      if (this.checkMask && (this.vram[idx] & 0x8000)) continue;\\n      this.vram[idx] = px | (this.setMask ? 0x8000 : 0);\\n    }\\n    if (t.i >= t.total) { this.phase = PH_CMD; this.vw = null; if (this.hw) this.hw.uploaded(t.x, t.y, t.w, t.h); }\\n  }\\n\\n  beginVramRead(b) {\\n    const x = b[1] & 0x3FF, y = (b[1] >>> 16) & 0x1FF;\\n    const w = ((b[2] - 1) & 0x3FF) + 1, h = (((b[2] >>> 16) - 1) & 0x1FF) + 1;\\n    if (this.remote) this.remote.onRead?.();                   // o jogo lê a VRAM de volta: o worker volta para esta thread (a leitura atual sai defasada)\\n    if (this.hw) this.hw.rects(x, y, w, h, (rx, ry, rw, rh) => this.hw.syncNative(rx, ry, rw, rh));\\n    this.vr = { x, y, w, h, i: 0, total: w * h };\\n  }\\n  vramReadWord() {\\n    const t = this.vr; let out = 0;\\n    for (let k = 0; k < 2; k++) {\\n      let px = 0;\\n      if (t.i < t.total) { px = this.vram[((t.y + ((t.i / t.w) | 0)) & 0x1FF) * 1024 + ((t.x + (t.i % t.w)) & 0x3FF)]; t.i++; }\\n      out |= px << (16 * k);\\n    }\\n    if (t.i >= t.total) this.vr = null;\\n    return out >>> 0;\\n  }\\n\\n  vramCopy(b) {\\n    const sx = b[1] & 0x3FF, sy = (b[1] >>> 16) & 0x1FF, dx = b[2] & 0x3FF, dy = (b[2] >>> 16) & 0x1FF;\\n    const w = ((b[3] - 1) & 0x3FF) + 1, h = (((b[3] >>> 16) - 1) & 0x1FF) + 1;\\n    if (this.remote) return;\\n    if (this.hw && this.hw.copy(sx, sy, dx, dy, w, h)) return;\\n    const CH = 16, buf = new Uint16Array(CH);          // o hardware lê/escreve em rajadas de 16 pixels (medido)\\n    for (let y = 0; y < h; y++) for (let x0 = 0; x0 < w; x0 += CH) {\\n      const n = Math.min(CH, w - x0);\\n      for (let k = 0; k < n; k++) buf[k] = this.vram[((sy + y) & 0x1FF) * 1024 + ((sx + x0 + k) & 0x3FF)];\\n      for (let k = 0; k < n; k++) {\\n        const di = ((dy + y) & 0x1FF) * 1024 + ((dx + x0 + k) & 0x3FF);\\n        if (this.checkMask && (this.vram[di] & 0x8000)) continue;\\n        this.vram[di] = buf[k] | (this.setMask ? 0x8000 : 0);\\n      }\\n    }\\n    if (this.hw) this.hw.uploaded(dx, dy, w, h);\\n  }\\n\\n  // ===================== Pixel =====================\\n  /** Escreve um pixel já com offset aplicado. r,g,b: 0..255. */\\n  plot(x, y, r, g, b, semi, dith) {\\n    if (x < this.daX1 || x > this.daX2 || y < this.daY1 || y > this.daY2 || x < 0 || x > 1023 || y < 0 || y > 511) return;\\n    this.plotNB(x, y, r, g, b, semi, dith);\\n  }\\n  /** plot sem checagem de limites (o chamador já recortou para a área de desenho e para a VRAM) */\\n  plotNB(x, y, r, g, b, semi, dith) {\\n    const idx = y * 1024 + x, back = this.vram[idx];\\n    if (this.checkMask && (back & 0x8000)) return;\\n    if (dith) { const d = DITHER[((y & 3) << 2) | (x & 3)]; r += d; g += d; b += d; }\\n    r = clamp8(r) >> 3; g = clamp8(g) >> 3; b = clamp8(b) >> 3;\\n    if (semi) {\\n      const br = back & 31, bg = (back >> 5) & 31, bb = (back >> 10) & 31;\\n      switch (this.semiMode) {\\n        case 0: r = (br + r) >> 1; g = (bg + g) >> 1; b = (bb + b) >> 1; break;\\n        case 1: r = Math.min(31, br + r); g = Math.min(31, bg + g); b = Math.min(31, bb + b); break;\\n        case 2: r = Math.max(0, br - r); g = Math.max(0, bg - g); b = Math.max(0, bb - b); break;\\n        default: r = Math.min(31, br + (r >> 2)); g = Math.min(31, bg + (g >> 2)); b = Math.min(31, bb + (b >> 2));\\n      }\\n    }\\n    this.vram[idx] = r | (g << 5) | (b << 10) | (this.setMask ? 0x8000 : 0);\\n  }\\n\\n  /** Cache de CLUT da GPU: carregado só ao desenhar com textura 4/8 bits; chave = posição; 4 bits carrega 16 entradas, 8 bits 256. */\\n  clutPrep(cx, cy) {\\n    if (this.texDepth > 1) return;\\n    const need = this.texDepth === 0 ? 16 : 256;\\n    if (this.clutValid && this.clutX === cx && this.clutY === cy && this.clutCount >= need) return;\\n    for (let i = 0; i < need; i++) this.clut[i] = this.vram[cy * 1024 + ((cx * 16 + i) & 0x3FF)];\\n    this.clutValid = true; this.clutX = cx; this.clutY = cy; this.clutCount = need;\\n  }\\n\\n  /** Busca um texel (devolve a palavra de 16 bits; 0 = transparente). */\\n  texel(u, v, clutX, clutY) {\\n    u &= 255; v &= 255;\\n    u = (u & ~(this.twMaskX << 3)) | ((this.twOffX & this.twMaskX) << 3);\\n    v = (v & ~(this.twMaskY << 3)) | ((this.twOffY & this.twMaskY) << 3);\\n    const base = this.texX * 64, row = ((this.texY * 256 + v) & 0x1FF) * 1024;\\n    if (this.texDepth === 0) {\\n      const w = this.vram[row + ((base + (u >> 2)) & 0x3FF)];\\n      return this.clut[(w >> ((u & 3) * 4)) & 15];\\n    }\\n    if (this.texDepth === 1) {\\n      const w = this.vram[row + ((base + (u >> 1)) & 0x3FF)];\\n      return this.clut[(w >> ((u & 1) * 8)) & 255];\\n    }\\n    return this.vram[row + ((base + u) & 0x3FF)];\\n  }\\n\\n  /** Aplica o texel + cor do vértice e plota. */\\n  shadeTexel(x, y, t, r, g, b, raw, semi, gour, clutX, clutY, u, v, noClip, dith) {\\n    const texel = this.texel(u, v, clutX, clutY);\\n    if (texel === 0) return;\\n    const tr = texel & 31, tg = (texel >> 5) & 31, tb = (texel >> 10) & 31;\\n    const s = semi && (texel & 0x8000);\\n    if (noClip) {\\n      if (raw) this.plotNB(x, y, tr << 3, tg << 3, tb << 3, s, false);\\n      else this.plotNB(x, y, (tr * r) >> 4, (tg * g) >> 4, (tb * b) >> 4, s, dith);\\n    } else if (raw) this.plot(x, y, tr << 3, tg << 3, tb << 3, s, false);\\n    else this.plot(x, y, (tr * r) >> 4, (tg * g) >> 4, (tb * b) >> 4, s, dith);\\n  }\\n\\n  // ===================== Polígonos =====================\\n  polygon(b, c) {\\n    const quad = !!(c & 8), tex = !!(c & 4), gour = !!(c & 0x10), semi = !!(c & 2), raw = !!(c & 1);\\n    const n = quad ? 4 : 3, V = []; let i = 1;\\n    let clutX = 0, clutY = 0;\\n    for (let k = 0; k < n; k++) {\\n      const col = (gour && k > 0) ? b[i++] : b[0];\\n      const pos = b[i++];\\n      let u = 0, v = 0;\\n      if (tex) {\\n        const t = b[i++]; u = t & 255; v = (t >> 8) & 255;\\n        if (k === 0) { clutX = (t >>> 16) & 63; clutY = (t >>> 22) & 511; }\\n        if (k === 1) {                                   // texpage atualiza o estado do GPU\\n          const tp = t >>> 16;\\n          this.texX = tp & 15; this.texY = (tp >> 4) & 1; this.semiMode = (tp >> 5) & 3; this.texDepth = (tp >> 7) & 3;\\n          this.texDisable = this.texDisAllow && !!((tp >> 11) & 1);\\n        }\\n      }\\n      V.push({ x: sx11(pos & 0x7FF) + this.offX, y: sx11((pos >>> 16) & 0x7FF) + this.offY,\\n               r: col & 255, g: (col >> 8) & 255, b: (col >> 16) & 255, u, v });\\n    }\\n    const o = { tex, gour, semi, raw, clutX, clutY };\\n    if (this.skipDraw || this.remote) return;                   // quadro descartado (frameskip): mantém o estado, não desenha\\n    if (this.hw) return this.hw.polygon(V, quad, o);\\n    if (tex) this.clutPrep(clutX, clutY);\\n    this.triangle(V[0], V[1], V[2], o);\\n    if (quad) this.triangle(V[1], V[2], V[3], o);\\n  }\\n\\n  /**\\n   * Triângulo estilo hardware: arestas exatas (regra de cobertura do PS1: linhas [yTopo, yBase), colunas [ceil(xE), ceil(xD)))\\n   * e atributos (cor, u, v) interpolados em ponto fixo com gradientes truncados a 12 bits fracionários, a partir do\\n   * primeiro vértice do comando (medido contra o console real; aritmética de 32 bits que \\\"dá a volta\\\").\\n   */\\n  triangle(a, b, c, o) {\\n    let A = a, B = b, C = c, t;\\n    if (C.y < B.y) { t = B; B = C; C = t; }\\n    if (B.y < A.y) { t = A; A = B; B = t; }\\n    if (C.y < B.y) { t = B; B = C; C = t; }\\n    if (C.y === A.y) return;\\n    const D = (B.x - A.x) * (C.y - A.y) - (C.x - A.x) * (B.y - A.y);\\n    if (D === 0) return;\\n    const minX = Math.min(A.x, B.x, C.x), maxX = Math.max(A.x, B.x, C.x);\\n    if (maxX - minX > 1023 || C.y - A.y > 511) return;          // limite do hardware\\n    const yS = Math.max(A.y, this.daY1, 0), yE = Math.min(C.y - 1, this.daY2, 511);\\n    if (yS > yE) return;\\n    const xMin = Math.max(this.daX1, 0), xMax = Math.min(this.daX2, 1023);\\n    const shortRight = D > 0;\\n    const dxL = C.x - A.x, dyL = C.y - A.y;\\n    const ceilDiv = (n, d) => Math.ceil(n / d);                  // d > 0; n/d exato o bastante (|n| < 2^31, d < 2^11)\\n    // gradientes (12 bits fracionários, truncados para zero)\\n    const tex = o.tex, gour = o.gour, raw = o.raw, semi = o.semi, clutX = o.clutX, clutY = o.clutY;\\n    const grad = (ca, cb, cc) => {\\n      const nx = (cb - ca) * (C.y - A.y) - (cc - ca) * (B.y - A.y);\\n      const ny = (cc - ca) * (B.x - A.x) - (cb - ca) * (C.x - A.x);\\n      return [Math.trunc(nx * 4096 / D), Math.trunc(ny * 4096 / D)];\\n    };\\n    let rGx = 0, rGy = 0, gGx = 0, gGy = 0, bGx = 0, bGy = 0, uGx = 0, uGy = 0, vGx = 0, vGy = 0;\\n    if (gour) { [rGx, rGy] = grad(A.r, B.r, C.r); [gGx, gGy] = grad(A.g, B.g, C.g); [bGx, bGy] = grad(A.b, B.b, C.b); }\\n    if (tex) { [uGx, uGy] = grad(A.u, B.u, C.u); [vGx, vGy] = grad(A.v, B.v, C.v); }\\n    const P = a;                                                 // o hardware parte do 1o vértice do comando\\n    const r0 = (P.r << 12) + 2048, g0 = (P.g << 12) + 2048, b0 = (P.b << 12) + 2048, u0 = (P.u << 12) + 2048, v0 = (P.v << 12) + 2048;\\n    const dith = this.dither && (gour || (tex && !raw));\\n    const vram = this.vram, chk = this.checkMask, setM = this.setMask ? 0x8000 : 0, smode = this.semiMode, dthrOn = !!this.dither;\\n    const clut = this.clut, td = this.texDepth, tBase = this.texX * 64, tY = this.texY * 256;\\n    const mx = this.twMaskX, my = this.twMaskY, uAnd = ~(mx << 3), uOr = (this.twOffX & mx) << 3, vAnd = ~(my << 3), vOr = (this.twOffY & my) << 3;\\n    const ddOn = tex ? (!raw && dthrOn) : dith;\\n    const span = spanFor(tex, tex ? td : 0, gour, raw && tex, semi && true, ddOn, chk, tex && (mx | my) !== 0);\\n    const mk = this.rowMask;                                     // 480i: o hardware não desenha as linhas do campo exibido\\n    for (let y = yS; y <= yE; y++) {\\n      if (mk >= 0 && (y & 1) === mk) continue;\\n      const nL = A.x * dyL + (y - A.y) * dxL;                      // aresta longa: x = nL / dyL\\n      let xl, xr;\\n      const lx = ceilDiv(nL, dyL);\\n      let sx;\\n      if (y < B.y) sx = ceilDiv(A.x * (B.y - A.y) + (y - A.y) * (B.x - A.x), B.y - A.y);\\n      else sx = ceilDiv(B.x * (C.y - B.y) + (y - B.y) * (C.x - B.x), C.y - B.y);\\n      if (shortRight) { xl = lx; xr = sx; } else { xl = sx; xr = lx; }\\n      if (xl < xMin) xl = xMin;\\n      if (xr > xMax + 1) xr = xMax + 1;\\n      if (xl >= xr) continue;\\n      const dy = y - P.y, dx = xl - P.x;\\n      let cr = r0 + rGy * dy + rGx * dx, cg = g0 + gGy * dy + gGx * dx, cb = b0 + bGy * dy + bGx * dx;\\n      let cu = u0 + uGy * dy + uGx * dx, cv = v0 + vGy * dy + vGx * dx;\\n      span(vram, clut, QT, DITHER_T, y, xl, xr, cr, cg, cb, cu, cv, rGx, gGx, bGx, uGx, vGx, A.r, A.g, A.b, tBase, tY, uAnd, uOr, vAnd, vOr, smode, setM);\\n    }\\n  }\\n\\n  // ===================== Retângulos =====================\\n  rect(b, c) {\\n    const tex = !!(c & 4), semi = !!(c & 2), raw = !!(c & 1), sz = (c >> 3) & 3;\\n    let i = 1;\\n    const col = b[0], r = col & 255, g = (col >> 8) & 255, bl = (col >> 16) & 255;\\n    const pos = b[i++];\\n    let u0 = 0, v0 = 0, clutX = 0, clutY = 0;\\n    if (tex) { const t = b[i++]; u0 = t & 255; v0 = (t >> 8) & 255; clutX = (t >>> 16) & 63; clutY = (t >>> 22) & 511; }\\n    let w, h;\\n    if (sz === 0) { const s = b[i++]; w = s & 0x3FF; h = (s >>> 16) & 0x1FF; }\\n    else if (sz === 1) { w = 1; h = 1; } else if (sz === 2) { w = 8; h = 8; } else { w = 16; h = 16; }\\n    const x0 = sx11(pos & 0x7FF) + this.offX, y0 = sx11((pos >>> 16) & 0x7FF) + this.offY;\\n    if (this.skipDraw || this.remote) return;\\n    if (this.hw) return this.hw.rect(x0, y0, w, h, { tex, semi, raw, r, g, b: bl, u0, v0, clutX, clutY, flipX: this.flipX, flipY: this.flipY });\\n    if (tex) this.clutPrep(clutX, clutY);\\n    const mk = this.rowMask;\\n    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {\\n      const px = x0 + x, py = y0 + y;\\n      if (mk >= 0 && (py & 1) === mk) continue;\\n      if (px < this.daX1 || px > this.daX2 || py < this.daY1 || py > this.daY2) continue;\\n      if (tex) {\\n        const u = this.flipX ? u0 + 1 - x : u0 + x, v = this.flipY ? v0 - y : v0 + y;   // flip X: o hardware começa em u0+1 (medido)\\n        this.shadeTexel(px, py, true, r, g, bl, raw, semi, false, clutX, clutY, u, v, false, false);\\n      } else this.plot(px, py, r, g, bl, semi, false);\\n    }\\n  }\\n\\n  // ===================== Linhas =====================\\n  lineCmd(b, c) {\\n    const gour = !!(c & 0x10), poly = !!(c & 8);\\n    this.line = { semi: !!(c & 2), gour, pts: [], cols: [] };\\n    const L = this.line;\\n    L.pts.push(b[1]); L.cols.push(b[0] & 0xFFFFFF);\\n    if (gour) { L.cols.push(b[2] & 0xFFFFFF); L.pts.push(b[3]); } else { L.cols.push(b[0] & 0xFFFFFF); L.pts.push(b[2]); }\\n    if (!poly) { this.drawSeg(L, 0); this.line = null; return; }\\n    this.drawSeg(L, 0); this.phase = PH_POLYLINE; this.polyExpectColor = gour;\\n  }\\n  polylineWord(w) {\\n    const L = this.line;\\n    if ((w & 0xF000F000) === 0x50005000) { this.phase = PH_CMD; this.line = null; return; }\\n    if (L.gour && this.polyExpectColor) { this.polyColor = w & 0xFFFFFF; this.polyExpectColor = false; return; }\\n    L.pts.push(w); L.cols.push(L.gour ? this.polyColor : L.cols[0]);\\n    this.drawSeg(L, L.pts.length - 2);\\n    if (L.gour) this.polyExpectColor = true;\\n  }\\n  drawSeg(L, i) {\\n    const p0 = L.pts[i], p1 = L.pts[i + 1], c0 = L.cols[i], c1 = L.cols[i + 1];\\n    const x0 = sx11(p0 & 0x7FF) + this.offX, y0 = sx11((p0 >>> 16) & 0x7FF) + this.offY;\\n    const x1 = sx11(p1 & 0x7FF) + this.offX, y1 = sx11((p1 >>> 16) & 0x7FF) + this.offY;\\n    if (this.skipDraw || this.remote) return;\\n    if (this.hw) return this.hw.line(x0, y0, x1, y1, c0, c1, L.semi, L.gour);\\n    // Algoritmo do hardware: passo em ponto fixo 32.32 (arredondado \\\"para longe do zero\\\"), pixel = floor(pos + 0.5 - eps)\\n    let ax = x0, ay = y0, bx = x1, by = y1, ca = c0, cb = c1;\\n    const adx = Math.abs(x1 - x0), ady = Math.abs(y1 - y0), k = Math.max(adx, ady);\\n    if (adx >= 1024 || ady >= 512) return;\\n    if (ax >= bx && k) { ax = x1; ay = y1; bx = x0; by = y0; ca = c1; cb = c0; }\\n    const div = d => { if (k === 0) return 0; const n = d * 4294967296, q = n / k; return (q < 0 ? Math.floor(q) : Math.ceil(q)) / 4294967296; };\\n    const sx = div(bx - ax), sy = div(by - ay);\\n    const EX = LINE_EX, EY = LINE_EY;\\n    let px = ax + 0.5 - EX, py = ay + 0.5 - EY;\\n    const gour = L.gour, dither = this.dither;                 // linhas flat também recebem dithering (medido)\\n    const r0 = ca & 255, g0 = (ca >> 8) & 255, b0 = (ca >> 16) & 255;\\n    const tr = (cb & 255) - r0, tg = ((cb >> 8) & 255) - g0, tb = ((cb >> 16) & 255) - b0;\\n    const kk = k || 1, mk = this.rowMask;\\n    const dr = Math.trunc((tr * 4096) / kk), dg = Math.trunc((tg * 4096) / kk), db = Math.trunc((tb * 4096) / kk);\\n    for (let i = 0; i <= k; i++, px += sx, py += sy) {\\n      const x = Math.floor(px), y = Math.floor(py);\\n      if (mk >= 0 && (y & 1) === mk) continue;\\n      let r = r0, g = g0, bl = b0;\\n      if (gour) { r = ((r0 << 12) + 2048 + dr * i) >> 12; g = ((g0 << 12) + 2048 + dg * i) >> 12; bl = ((b0 << 12) + 2048 + db * i) >> 12; }\\n      this.plot(x, y, r, g, bl, L.semi, dither);\\n    }\\n  }\\n\\n  // ===================== Saída de vídeo =====================\\n  /** paridade das linhas que NÃO podem ser desenhadas (campo exibido) em 480i com 'desenhar na área de display' proibido; -1 = sem restrição */\\n  get rowMask() { return (this.interlace && this.vres && !this.drawToDisplay) ? this.field : -1; }\\n\\n  /** Chamado a cada fim de quadro: guarda as linhas do campo exibido (completas) para tecer com o campo anterior na saída. */\\n  toggleField() { this.field ^= 1; if (this.remote) this.remote.push(6, this.field); }\\n  captureField() {\\n    if (this.remote) { this.remote.push(2, 0); return; }\\n    if (this.hw) return this.hw.captureField(this);\\n    this.captureFieldSW();\\n  }\\n  captureFieldSW() {\\n    if (!(this.interlace && this.vres) || !this.dispOn) { this.snapKey = ''; return; }\\n    const w = this.width, h = this.height, wv = this.rgb24 ? Math.ceil(w * 1.5) + 2 : w + 2;\\n    const key = this.startX + ',' + this.startY + ',' + w + ',' + h + ',' + (this.rgb24 ? 1 : 0);\\n    if (!this.snap) { this.snap = new Uint16Array(1024 * 512); this.mot = new Uint8Array(1024 * 512); }\\n    const vr = this.vram, sn = this.snap, mot = this.mot, par = this.field; this.snapPar = par;\\n    const full = key !== this.snapKey; this.snapKey = key;\\n    for (let y = 0; y < h; y++) {\\n      const ry = (this.startY + y) & 0x1FF;\\n      if (!full && (ry & 1) !== par) continue;\\n      const row = ry * 1024;\\n      for (let x = 0; x < wv; x++) {\\n        const i = row + ((this.startX + x) & 0x3FF), n = vr[i], o = sn[i];\\n        // movimento = este pixel mudou em relação ao MESMO campo de 2 quadros atrás (o campo velho é do instante t-1: usado no desentrelaçamento adaptativo)\\n        mot[i] = full || ((((n & 31) - (o & 31)) + 1) >>> 0) > 2 || (((((n >> 5) & 31) - ((o >> 5) & 31)) + 1) >>> 0) > 2 || (((((n >> 10) & 31) - ((o >> 10) & 31)) + 1) >>> 0) > 2 ? 1 : 0;\\n        sn[i] = n;\\n      }\\n    }\\n  }\\n\\n  get dotDiv() { return this.hres2 ? 7 : [10, 8, 5, 4][this.hres1]; }   // divisor do dot clock\\n  get width() { return this.hres2 ? 368 : [256, 320, 512, 640][this.hres1]; }\\n  get height() {\\n    const lines = Math.max(0, this.vy2 - this.vy1);\\n    const h = (lines > 0 && lines <= 288) ? lines * (this.vres ? 2 : 1) : (this.vres ? 480 : 240);\\n    return Math.min(h, 576);\\n  }\\n\\n  /** Converte a área de display da VRAM para RGBA (Uint8ClampedArray width*height*4). */\\n  renderRGBA(out) {\\n    const w = this.width, h = this.height;\\n    out = out ?? new Uint8ClampedArray(w * h * 4);\\n    if (!this.dispOn) { out.fill(0); for (let i = 3; i < out.length; i += 4) out[i] = 255; return { data: out, width: w, height: h }; }\\n    const vram = (this.snap && this.snapKey && this.interlace && this.vres) ? this.snap : this.vram;   // 480i: dois últimos campos completos\\n    const dmode = (vram === this.snap && !this.rgb24) ? this.deint : 0, spar = this.snapPar;\\n    for (let y = 0; y < h; y++) {\\n      const ry = (this.startY + y) & 0x1FF, row = ry * 1024;\\n      // 480i: as linhas do campo ANTIGO podem estar \\\"fantasmas\\\" onde algo se mexeu -> adaptativo troca pela média das vizinhas do campo atual\\n      const di = dmode !== 0 && (ry & 1) !== spar;\\n      const rA = di && y > 0 ? ((ry - 1) & 0x1FF) * 1024 : -1, rB = di && y < h - 1 ? ((ry + 1) & 0x1FF) * 1024 : -1;\\n      for (let x = 0; x < w; x++) {\\n        let r, g, b;\\n        if (this.rgb24) {\\n          const bx = ((this.startX * 2 + x * 3) >> 0);             // posição em bytes\\n          const wi = row + ((bx >> 1) & 0x3FF), lo = vram[wi], hi = vram[(wi & ~1023) + (((bx >> 1) + 1) & 0x3FF)];\\n          const bytes = (bx & 1) ? [lo >> 8, hi & 255, hi >> 8] : [lo & 255, lo >> 8, hi & 255];\\n          r = bytes[0]; g = bytes[1]; b = bytes[2];\\n        } else {\\n          const p = vram[row + ((this.startX + x) & 0x3FF)];\\n          r = (p & 31) << 3; g = ((p >> 5) & 31) << 3; b = ((p >> 10) & 31) << 3;\\n          r |= r >> 5; g |= g >> 5; b |= b >> 5;\\n          if (di && (rA >= 0 || rB >= 0)) {\\n            const xi = (this.startX + x) & 0x3FF, pa = vram[(rA >= 0 ? rA : rB) + xi], pb = vram[(rB >= 0 ? rB : rA) + xi];\\n            if (dmode === 1 && !(this.mot[(rA >= 0 ? rA : rB) + xi] | this.mot[(rB >= 0 ? rB : rA) + xi])) { /* sem movimento perto: mantém a linha do campo antigo (tecer) */ } else {\\n            let ar = (((pa & 31) + (pb & 31)) << 2) , ag = ((((pa >> 5) & 31) + ((pb >> 5) & 31)) << 2), ab = ((((pa >> 10) & 31) + ((pb >> 10) & 31)) << 2);\\n            ar |= ar >> 5; ag |= ag >> 5; ab |= ab >> 5;\\n            r = ar; g = ag; b = ab; }\\n          }\\n        }\\n        const o = (y * w + x) * 4; out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = 255;\\n      }\\n    }\\n    this.frameCount++;\\n    return { data: out, width: w, height: h };\\n  }\\n}\\n\\nconst DEINT_THR = 40;\\nfunction rgb24to15(c) { return (((c & 255) >> 3) | ((((c >> 8) & 255) >> 3) << 5) | ((((c >> 16) & 255) >> 3) << 10)); }\\nfunction clamp8(v) { return v < 0 ? 0 : v > 255 ? 255 : v; }\\n\\n/** Fluxo de comandos para o rasterizador em worker: pares [tipo, valor] (0=GP0, 1=GP1, 2=captura do campo, 3=apresentar, 6=campo atual). */\\nclass GpuStream {\\n  constructor(post) { this.post = post; this.q = new Uint32Array(1 << 16); this.n = 0; this.inflight = 0; this.onRead = null; }\\n  push(t, v) { if (this.n >= this.q.length) this.flush(); this.q[this.n++] = t; this.q[this.n++] = v; }\\n  flush() {\\n    if (!this.n) return;\\n    const o = this.q.slice(0, this.n); this.n = 0;\\n    this.post({ t: 'cmds', q: o }, [o.buffer]);\\n  }\\n}\\n\\nreturn { GPU, DEINT_THR, GpuStream };\\n})();\\nconst __src_gauss = (() => {\\n// Tabela de interpolação Gaussiana da SPU do PS1 (512 entradas, Int16).\\n// Dados de hardware (os mesmos de psx-spx / emuladores): g[i], i = 0..511.\\n// Verificação embutida no teste: para todo i, g[0xFF-i]+g[0x1FF-i]+g[0x100+i]+g[i] está em 32639..32641.\\nconst GAUSS = new Int16Array([\\n  -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,\\n  0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 3, 3,\\n  3, 4, 4, 5, 5, 6, 7, 7, 8, 9, 9, 10, 11, 12, 13, 14,\\n  15, 16, 17, 18, 19, 21, 22, 24, 25, 27, 28, 30, 32, 33, 35, 37,\\n  39, 41, 44, 46, 48, 51, 53, 56, 58, 61, 64, 67, 70, 73, 77, 80,\\n  84, 87, 91, 95, 99, 103, 107, 111, 116, 120, 125, 130, 135, 140, 145, 150,\\n  156, 161, 167, 173, 179, 186, 192, 199, 205, 212, 219, 227, 234, 242, 250, 257,\\n  266, 274, 283, 291, 300, 309, 319, 328, 338, 348, 358, 369, 379, 390, 401, 412,\\n  424, 436, 448, 460, 473, 485, 498, 512, 525, 539, 553, 567, 582, 597, 612, 627,\\n  643, 659, 675, 692, 708, 726, 743, 761, 779, 797, 816, 835, 854, 874, 894, 914,\\n  935, 956, 977, 999, 1020, 1043, 1066, 1089, 1112, 1136, 1160, 1184, 1209, 1234, 1260, 1286,\\n  1312, 1339, 1366, 1394, 1422, 1450, 1479, 1508, 1537, 1567, 1598, 1628, 1660, 1691, 1723, 1756,\\n  1789, 1822, 1856, 1890, 1924, 1959, 1995, 2031, 2067, 2104, 2141, 2179, 2217, 2256, 2295, 2334,\\n  2374, 2415, 2456, 2497, 2539, 2582, 2624, 2668, 2712, 2756, 2801, 2846, 2892, 2938, 2985, 3032,\\n  3079, 3128, 3176, 3225, 3275, 3325, 3376, 3427, 3479, 3531, 3584, 3637, 3691, 3745, 3799, 3855,\\n  3910, 3967, 4023, 4081, 4138, 4197, 4255, 4315, 4374, 4435, 4495, 4557, 4619, 4681, 4744, 4807,\\n  4871, 4935, 5000, 5065, 5131, 5197, 5264, 5332, 5399, 5468, 5536, 5606, 5676, 5746, 5817, 5888,\\n  5959, 6032, 6104, 6177, 6251, 6325, 6400, 6475, 6550, 6626, 6702, 6779, 6856, 6934, 7012, 7091,\\n  7170, 7249, 7329, 7409, 7490, 7571, 7653, 7735, 7817, 7900, 7983, 8066, 8150, 8234, 8319, 8404,\\n  8489, 8575, 8661, 8748, 8834, 8922, 9009, 9097, 9185, 9273, 9362, 9451, 9541, 9630, 9720, 9811,\\n  9901, 9992, 10083, 10174, 10266, 10358, 10450, 10542, 10635, 10727, 10820, 10913, 11007, 11100, 11194, 11288,\\n  11382, 11476, 11571, 11665, 11760, 11855, 11950, 12045, 12140, 12236, 12331, 12427, 12522, 12618, 12714, 12809,\\n  12905, 13001, 13097, 13193, 13289, 13385, 13481, 13577, 13673, 13769, 13865, 13961, 14056, 14152, 14248, 14343,\\n  14439, 14534, 14630, 14725, 14820, 14915, 15010, 15104, 15199, 15293, 15387, 15481, 15575, 15669, 15762, 15855,\\n  15948, 16041, 16133, 16226, 16317, 16409, 16500, 16592, 16682, 16773, 16863, 16953, 17042, 17131, 17220, 17308,\\n  17396, 17484, 17571, 17658, 17744, 17830, 17916, 18001, 18086, 18170, 18254, 18337, 18420, 18502, 18584, 18665,\\n  18746, 18826, 18905, 18985, 19063, 19141, 19219, 19295, 19372, 19447, 19522, 19597, 19671, 19744, 19816, 19888,\\n  19959, 20030, 20100, 20169, 20238, 20306, 20373, 20439, 20505, 20570, 20634, 20698, 20760, 20822, 20884, 20944,\\n  21004, 21063, 21121, 21178, 21235, 21290, 21345, 21399, 21452, 21505, 21556, 21607, 21657, 21706, 21754, 21801,\\n  21848, 21893, 21938, 21982, 22025, 22066, 22107, 22148, 22187, 22225, 22262, 22299, 22334, 22369, 22402, 22435,\\n  22467, 22498, 22527, 22556, 22584, 22611, 22637, 22662, 22686, 22709, 22731, 22752, 22772, 22791, 22809, 22826,\\n  22842, 22857, 22872, 22885, 22897, 22908, 22918, 22927, 22935, 22942, 22948, 22953, 22957, 22960, 22962, 22963\\n]);\\n\\nreturn { GAUSS };\\n})();\\nconst __src_spu = (() => {\\n// ============================================================================\\n//  SPU do PS1 - 24 vozes ADPCM, ADSR, modulação de pitch, ruído, reverb\\n// ============================================================================\\n//  Registradores: 0x1F801C00-0x1F801FFF (16 bits)\\n//    voz n (0..23): 0x1C00 + n*0x10\\n//      +0 volL  +2 volR  +4 pitch(0x1000=44100Hz)  +6 start(>>3)\\n//      +8 ADSR1 +A ADSR2 +C ADSR atual  +E repeat(>>3)\\n//    0x1D80 mainL, 0x1D82 mainR, 0x1D84 revL, 0x1D86 revR\\n//    0x1D88/8A KON, 0x1D8C/8E KOFF, 0x1D90/92 PMON, 0x1D94/96 NON, 0x1D98/9A EON\\n//    0x1D9C/9E ENDX, 0x1DA2 reverb base, 0x1DA4 IRQ addr, 0x1DA6 xfer addr, 0x1DA8 FIFO,\\n//    0x1DAA SPUCNT, 0x1DAC xfer ctrl, 0x1DAE SPUSTAT, 0x1DB0 CD vol, 0x1DC0.. regs de reverb\\n//  Amostragem de saída: 44100 Hz estéreo. Interpolação: Gaussiana de 4 taps (tabela de 512 entradas).\\n//  Volumes: modo fixo e SWEEP (linear/exponencial, crescente/decrescente, fase +/-) em cada volume de voz e no principal.\\n//  Ruído: LFSR de 16 bits com timer (shift/step do SPUCNT). Reverb: motor a 22,05 kHz com FIR de 39 taps\\n//  na entrada (decimação) e na saída (interpolação), escrita no buffer só com SPUCNT.7 ligado.\\n// ============================================================================\\nconst { GAUSS } = __src_gauss;\\nconst SPU_RAM_SIZE = 512 * 1024;\\nconst POS = [0, 60, 115, 98, 122], NEG = [0, 0, -52, -55, -60];\\nconst sat16 = v => v > 32767 ? 32767 : v < -32768 ? -32768 : v;\\nconst s16 = v => (v << 16) >> 16;\\n\\nconst R = { MAINL: 0x1D80, MAINR: 0x1D82, REVL: 0x1D84, REVR: 0x1D86, KONL: 0x1D88, KONH: 0x1D8A, KOFFL: 0x1D8C, KOFFH: 0x1D8E,\\n  PMONL: 0x1D90, PMONH: 0x1D92, NONL: 0x1D94, NONH: 0x1D96, EONL: 0x1D98, EONH: 0x1D9A, ENDXL: 0x1D9C, ENDXH: 0x1D9E,\\n  REVBASE: 0x1DA2, IRQADDR: 0x1DA4, XFERADDR: 0x1DA6, FIFO: 0x1DA8, CNT: 0x1DAA, XFERCTL: 0x1DAC, STAT: 0x1DAE, CDVOL: 0x1DB0, REVREGS: 0x1DC0 };\\n\\n// FIR de reamostragem do reverb (39 taps; soma = 0x7FFE ~ ganho 1,0 em >>15)\\nconst REV_FIR = new Int32Array([-1, 0, 2, 0, -10, 0, 35, 0, -103, 0, 266, 0, -616, 0, 1332, 0, -2960, 0, 10246, 0x4000,\\n  10246, 0, -2960, 0, 1332, 0, -616, 0, 266, 0, -103, 0, 35, 0, -10, 0, 2, 0, -1]);\\nconst FIR_K = [], FIR_C = []; for (let k = 0; k < 39; k++) if (REV_FIR[k]) { FIR_K.push(k); FIR_C.push(REV_FIR[k]); }   // só os coeficientes não nulos\\nconst FIR_N = FIR_K.length;\\n\\nconst ATTACK = 0, DECAY = 1, SUSTAIN = 2, RELEASE = 3, OFF = 4;\\n\\nclass Voice {\\n  constructor() { this.reset(); }\\n  reset() {\\n    this.addr = 0; this.counter = 0; this.phase = OFF; this.level = 0; this.envCnt = 0;\\n    this.samples = new Int16Array(28); this.idx = 28; this.old1 = 0; this.old2 = 0; this.prev = 0; this.cur = 0;\\n    this.repeat = 0; this.loopEnd = false; this.last = 0; this.h1 = 0; this.h2 = 0; this.h3 = 0;\\n  }\\n}\\n\\nclass SPU {\\n  constructor() {\\n    this.ram = new Uint8Array(SPU_RAM_SIZE);\\n    this.ramView = new DataView(this.ram.buffer);\\n    this.regs = new Uint16Array(0x200);            // 0x1F801C00 + i*2\\n    this.voices = Array.from({ length: 24 }, () => new Voice());\\n    this.xferAddr = 0; this.endx = 0; this.irqFlag = false; this.onIrq = null;\\n    this.revPos = 0; this.revToggle = 0; this.revOutL = 0; this.revOutR = 0;\\n    this.noise = 1; this.noiseTimer = 0;\\n    // volumes: 0..47 = voz n (L = 2n, R = 2n+1), 48/49 = principal L/R. level é o valor atual (com sinal).\\n    this.sw = Array.from({ length: 50 }, () => ({ reg: 0, level: 0, cnt: 0 }));\\n    this.revHL = new Int32Array(64); this.revHR = new Int32Array(64); this.revUL = new Int32Array(64); this.revUR = new Int32Array(64); this.revHead = 0;\\n    this.cdBufL = new Int16Array(65536); this.cdBufR = new Int16Array(65536); this.cdHead = 0; this.cdTail = 0;   // áudio do CD (XA/CDDA)\\n    this.sampleCount = 0;\\n  }\\n\\n  // ---------------- acesso aos registradores ----------------\\n  reg(addr) { return this.regs[(addr - 0x1C00) >> 1]; }\\n  setReg(addr, v) { this.regs[(addr - 0x1C00) >> 1] = v; }\\n\\n  read(addr, size) {\\n    addr &= 0xFFFF;                                  // 0x1F801C00 -> 0x1C00\\n    if (size === 4) return (this.read16(addr) | (this.read16(addr + 2) << 16)) >>> 0;\\n    if (size === 1) return (this.read16(addr & ~1) >> ((addr & 1) * 8)) & 0xFF;\\n    return this.read16(addr);\\n  }\\n  write(addr, size, v) {\\n    addr &= 0xFFFF;\\n    if (size === 4) { this.write16(addr, v & 0xFFFF); this.write16(addr + 2, v >>> 16); return; }\\n    if (size === 1) {                                         // byte: read-modify-write\\n      const a = addr & ~1, sh = (addr & 1) * 8, cur = this.reg(a);\\n      this.write16(a, (cur & ~(0xFF << sh)) | ((v & 0xFF) << sh)); return;\\n    }\\n    this.write16(addr, v & 0xFFFF);\\n  }\\n\\n  read16(a) {\\n    switch (a) {\\n      case R.ENDXL: return this.endx & 0xFFFF;\\n      case R.ENDXH: return (this.endx >>> 16) & 0xFF;\\n      case R.XFERADDR: return this.xferAddr >> 3;\\n      case R.STAT: return (this.reg(R.CNT) & 0x3F) | (this.irqFlag ? 0x40 : 0);\\n      case 0x1DB8: case 0x1DBA: return 0;\\n    }\\n    if (a >= 0x1E00 && a < 0x1E64) return this.sw[(a - 0x1E00) >> 1].level & 0xFFFF;     // volume atual (voz e principal)\\n    if (a < 0x1D80) {                                          // voz: ADSR atual (+0xC) = nível\\n      const n = (a - 0x1C00) >> 4;\\n      if ((a & 15) === 0xC) return this.voices[n].level & 0x7FFF;\\n    }\\n    return this.reg(a);\\n  }\\n\\n  /** escrita num registrador de volume (voz ou principal): fixo ou sweep */\\n  setVolReg(idx, v) {\\n    const s = this.sw[idx]; s.reg = v; s.cnt = 0;\\n    if (!(v & 0x8000)) s.level = s16((v & 0x7FFF) << 1);                // fixo: -0x8000..+0x7FFE\\n  }\\n  sweepTick(s) {\\n    const v = s.reg; if (!(v & 0x8000)) return;\\n    const exp = (v >> 14) & 1, dec = (v >> 13) & 1, shift = (v >> 2) & 31, stp = v & 3;\\n    let step = dec ? -8 + stp : 7 - stp, cycles = 1 << Math.max(0, shift - 11), m = Math.abs(s.level);\\n    step <<= Math.max(0, 11 - shift);\\n    if (exp && !dec && m > 0x6000) cycles *= 4;\\n    if (exp && dec) step = (step * m) >> 15;\\n    if (++s.cnt >= cycles) { s.cnt = 0; m = m + step; m = m < 0 ? 0 : m > 0x7FFF ? 0x7FFF : m; }\\n    s.level = (v & 0x1000) ? -m : m;                                     // fase negativa\\n  }\\n\\n  write16(a, v) {\\n    this.setReg(a, v);\\n    if (a < 0x1D80) { const k = a & 15; if (k < 4) this.setVolReg(((a - 0x1C00) >> 4) * 2 + (k >> 1), v); }\\n    else if (a === R.MAINL) this.setVolReg(48, v); else if (a === R.MAINR) this.setVolReg(49, v);\\n    switch (a) {\\n      case R.KONL: for (let i = 0; i < 16; i++) if (v & (1 << i)) this.keyOn(i); break;\\n      case R.KONH: for (let i = 0; i < 8; i++) if (v & (1 << i)) this.keyOn(16 + i); break;\\n      case R.KOFFL: for (let i = 0; i < 16; i++) if (v & (1 << i)) this.keyOff(i); break;\\n      case R.KOFFH: for (let i = 0; i < 8; i++) if (v & (1 << i)) this.keyOff(16 + i); break;\\n      case R.XFERADDR: this.xferAddr = (v << 3) & (SPU_RAM_SIZE - 1); break;\\n      case R.FIFO: this.ramWrite16(v); break;\\n      case R.CNT: if (!(v & 0x40)) this.irqFlag = false; break;         // desabilitar IRQ limpa o flag\\n      case R.REVBASE: this.revPos = (v << 3) & (SPU_RAM_SIZE - 1); break;\\n    }\\n  }\\n\\n  // ---------------- RAM do SPU / transferências ----------------\\n  ramWrite16(v) { this.ramView.setUint16(this.xferAddr, v & 0xFFFF, true); this.checkIrq(this.xferAddr); this.xferAddr = (this.xferAddr + 2) & (SPU_RAM_SIZE - 1); }\\n  ramRead16() { const v = this.ramView.getUint16(this.xferAddr, true); this.xferAddr = (this.xferAddr + 2) & (SPU_RAM_SIZE - 1); return v; }\\n  dmaWrite(words) { for (const w of words) { this.ramWrite16(w & 0xFFFF); this.ramWrite16(w >>> 16); } }     // DMA canal 4\\n  dmaRead(n) { const o = new Uint32Array(n); for (let i = 0; i < n; i++) o[i] = this.ramRead16() | (this.ramRead16() << 16); return o; }\\n  checkIrq(addr) {\\n    if ((this.reg(R.CNT) & 0x40) && (addr >> 3) === (this.reg(R.IRQADDR) & 0xFFFF)) this.raiseIrq();\\n  }\\n  raiseIrq() { if (!this.irqFlag) { this.irqFlag = true; this.onIrq?.(); } }\\n\\n  // ---------------- voz ----------------\\n  keyOn(n) {\\n    const v = this.voices[n], base = 0x1C00 + n * 16;\\n    v.addr = (this.reg(base + 6) << 3) & (SPU_RAM_SIZE - 1);\\n    v.repeat = v.addr; v.counter = 0; v.idx = 28; v.old1 = 0; v.old2 = 0; v.prev = 0; v.cur = 0;\\n    v.level = 0; v.envCnt = 0; v.h1 = v.h2 = v.h3 = 0; v.phase = ATTACK; this.endx &= ~(1 << n);\\n    this.decodeBlock(v);\\n    v.idx = 0; v.cur = v.samples[0];\\n  }\\n  keyOff(n) { const v = this.voices[n]; if (v.phase !== OFF) { v.phase = RELEASE; v.envCnt = 0; } }\\n\\n  /** Decodifica 1 bloco ADPCM de 16 bytes (28 amostras) */\\n  decodeBlock(v) {\\n    if (this.reg(R.CNT) & 0x40) {                               // IRQ se o endereço cair em qualquer ponto do bloco lido\\n      const ia = (this.reg(R.IRQADDR) << 3) & (SPU_RAM_SIZE - 1);\\n      if (ia >= v.addr && ia < v.addr + 16) this.raiseIrq();\\n    }\\n    const o = v.addr, head = this.ram[o], flags = this.ram[o + 1];\\n    const shift = head & 15, filter = Math.min((head >> 4) & 7, 4);\\n    if (flags & 4) v.repeat = v.addr;                          // loop start\\n    let o1 = v.old1, o2 = v.old2;\\n    for (let i = 0; i < 28; i++) {\\n      const byte = this.ram[o + 2 + (i >> 1)];\\n      let nib = (i & 1) ? byte >> 4 : byte & 15;\\n      let s = s16(nib << 12) >> (shift > 12 ? 9 : shift);\\n      s += (o1 * POS[filter] + o2 * NEG[filter] + 32) >> 6;\\n      s = sat16(s); o2 = o1; o1 = s; v.samples[i] = s;\\n    }\\n    v.old1 = o1; v.old2 = o2; v.flags = flags;\\n  }\\n\\n  /** Avança o envelope ADSR 1 amostra */\\n  envelope(v, n) {\\n    const base = 0x1C00 + n * 16, a1 = this.reg(base + 8), a2 = this.reg(base + 10);\\n    let mode, dec, shift, step;\\n    switch (v.phase) {\\n      case ATTACK: mode = a1 >> 15; dec = false; shift = (a1 >> 10) & 31; step = 7 - ((a1 >> 8) & 3); break;\\n      case DECAY: mode = 1; dec = true; shift = (a1 >> 4) & 15; step = -8; break;\\n      case SUSTAIN: mode = a2 >> 15; dec = !!((a2 >> 14) & 1); shift = (a2 >> 8) & 31; step = dec ? -8 + ((a2 >> 6) & 3) : 7 - ((a2 >> 6) & 3); break;\\n      case RELEASE: mode = (a2 >> 5) & 1; dec = true; shift = a2 & 31; step = -8; break;\\n      default: return;\\n    }\\n    let cycles = 1 << Math.max(0, shift - 11);\\n    step <<= Math.max(0, 11 - shift);\\n    if (mode && !dec && v.level > 0x6000) cycles *= 4;           // ataque exponencial desacelera\\n    if (mode && dec) step = (step * v.level) >> 15;               // decaimento exponencial\\n    if (++v.envCnt >= cycles) {\\n      v.envCnt = 0;\\n      v.level = Math.max(0, Math.min(0x7FFF, v.level + step));\\n    }\\n    // transições de fase\\n    if (v.phase === ATTACK && v.level >= 0x7FFF) { v.phase = DECAY; v.envCnt = 0; }\\n    else if (v.phase === DECAY && v.level <= (((a1 & 15) + 1) << 11)) { v.phase = SUSTAIN; v.envCnt = 0; }\\n    else if (v.phase === RELEASE && v.level <= 0) { v.phase = OFF; }\\n  }\\n\\n  // ---------------- gera 1 amostra estéreo (44.1kHz) ----------------\\n  tick() {\\n    let mixL = 0, mixR = 0, revInL = 0, revInR = 0;\\n    const cnt = this.reg(R.CNT), sw = this.sw;\\n    const eon = this.reg(R.EONL) | (this.reg(R.EONH) << 16), pmon = this.reg(R.PMONL) | (this.reg(R.PMONH) << 16),\\n          non = this.reg(R.NONL) | (this.reg(R.NONH) << 16);\\n\\n    // ruído: timer decrementa (4 + step) por amostra; no estouro recarrega (0x20000 >> shift) e avança o LFSR\\n    this.noiseTimer -= 4 + ((cnt >> 8) & 3);\\n    if (this.noiseTimer < 0) {\\n      this.noiseTimer += 0x20000 >> ((cnt >> 10) & 15); if (this.noiseTimer < 0) this.noiseTimer = 0;\\n      const nz = this.noise;\\n      this.noise = ((nz << 1) | (((nz >> 15) ^ (nz >> 12) ^ (nz >> 11) ^ (nz >> 10) ^ 1) & 1)) & 0xFFFF;\\n    }\\n    for (let i = 0; i < 50; i++) if (sw[i].reg & 0x8000) this.sweepTick(sw[i]);    // sweeps de volume\\n\\n    for (let n = 0; n < 24; n++) {\\n      const v = this.voices[n];\\n      if (v.phase === OFF) continue;\\n      const base = 0x1C00 + n * 16;\\n      // amostra atual: Gauss de 4 taps sobre as 4 últimas amostras decodificadas (ou ruído)\\n      let smp;\\n      if (non & (1 << n)) smp = s16(this.noise);\\n      else {\\n        const i = (v.counter >> 4) & 0xFF;\\n        smp = (GAUSS[0xFF - i] * v.h3 + GAUSS[0x1FF - i] * v.h2 + GAUSS[0x100 + i] * v.h1 + GAUSS[i] * v.cur) >> 15;\\n        smp = sat16(smp);\\n      }\\n      this.envelope(v, n);\\n      smp = (smp * v.level) >> 15;\\n      v.last = smp;\\n      const l = (smp * sw[n * 2].level) >> 15, r = (smp * sw[n * 2 + 1].level) >> 15;\\n      mixL += l; mixR += r;\\n      if (eon & (1 << n)) { revInL += l; revInR += r; }\\n\\n      // avanço do pitch\\n      let step = this.reg(base + 4) & 0x3FFF;\\n      if ((pmon & (1 << n)) && n > 0) step = (step * (this.voices[n - 1].last + 0x8000)) >> 15;\\n      v.counter += Math.min(step, 0x3FFF);\\n      while (v.counter >= 0x1000) {\\n        v.counter -= 0x1000; v.idx++;\\n        if (v.idx >= 28) {\\n          const f = v.flags;\\n          if (f & 1) {                                              // loop end\\n            this.endx |= (1 << n);\\n            if (f & 2) v.addr = v.repeat; else { v.phase = OFF; v.level = 0; break; }   // repeat ou silêncio\\n          } else v.addr = (v.addr + 16) & (SPU_RAM_SIZE - 1);\\n          this.decodeBlock(v); v.idx = 0;\\n        }\\n        v.h3 = v.h2; v.h2 = v.h1; v.h1 = v.cur; v.cur = v.samples[v.idx];\\n      }\\n    }\\n\\n    // CD audio (entra no mix principal; SPUCNT.2 também o envia ao reverb)\\n    if (this.cdHead !== this.cdTail) {\\n      const l = this.cdBufL[this.cdHead], r = this.cdBufR[this.cdHead]; this.cdHead = (this.cdHead + 1) & 0xFFFF;\\n      if (cnt & 1) {\\n        const cl = (l * this.volume(this.reg(R.CDVOL))) >> 15, cr = (r * this.volume(this.reg(R.CDVOL + 2))) >> 15;\\n        mixL += cl; mixR += cr;\\n        if (cnt & 4) { revInL += cl; revInR += cr; }\\n      }\\n    }\\n\\n    // reverb: entra a 44,1 kHz, o motor roda a 22,05 kHz (FIR de 39 taps para decimar/interpolar)\\n    const hd = this.revHead = (this.revHead + 1) & 63;\\n    this.revHL[hd] = sat16(revInL); this.revHR[hd] = sat16(revInR);\\n    this.revToggle ^= 1;\\n    let newL = 0, newR = 0;\\n    if (this.revToggle) {\\n      let aL = 0, aR = 0;\\n      if (cnt & 0x80) for (let q = 0; q < FIR_N; q++) { const c = FIR_C[q], j = (hd - FIR_K[q]) & 63; aL += c * this.revHL[j]; aR += c * this.revHR[j]; }\\n      if (cnt & 0x80) this.reverbStep(sat16(aL >> 15), sat16(aR >> 15)); else { this.revOutL = this.revOutR = 0; this.revAdvance(); }\\n      newL = this.revOutL; newR = this.revOutR;\\n    }\\n    this.revUL[hd] = newL; this.revUR[hd] = newR;                    // saída do reverb: zero-stuffing + FIR (ganho 2)\\n    if (cnt & 0x80) {\\n      let uL = 0, uR = 0;\\n      for (let q = 0; q < FIR_N; q++) { const c = FIR_C[q], j = (hd - FIR_K[q]) & 63; uL += c * this.revUL[j]; uR += c * this.revUR[j]; }\\n      mixL += sat16(uL >> 14); mixR += sat16(uR >> 14);\\n    }\\n\\n    if (!(cnt & 0x8000)) return [0, 0];                              // SPU desabilitado (mudo)\\n    const mL = (mixL * sw[48].level) >> 15, mR = (mixR * sw[49].level) >> 15;\\n    this.sampleCount++;\\n    return [sat16(cnt & 0x4000 ? mL : 0), sat16(cnt & 0x4000 ? mR : 0)];   // bit 14: 0 = mudo\\n  }\\n\\n  volume(v) {                                                        // modo fixo (bit15=0). Sweep: TODO\\n    return s16((v & 0x7FFF) << 1) ;\\n  }\\n\\n  // ---------------- reverb ----------------\\n  // Endereço do reverb = base + ((posição_atual - base + reg*8 + extra) mod tamanho). Roda a 22.05kHz.\\n  reverbStep(inL, inR) {\\n    const rg = i => this.reg(R.REVREGS + i * 2), g = i => s16(rg(i));\\n    const base = (this.reg(R.REVBASE) << 3) & (SPU_RAM_SIZE - 1), size = SPU_RAM_SIZE - base;\\n    if (size <= 0) return;\\n    const ad = (reg, extra = 0) => base + ((((this.revPos - base) + (reg << 3) + extra) % size) + size) % size & ~1;\\n    const wrEn = !!(this.reg(R.CNT) & 0x80);\\n    const rd = (reg, extra = 0) => { const a = ad(reg, extra); this.checkIrq(a); return this.ramView.getInt16(a, true); };\\n    const wr = (reg, v) => { const a = ad(reg); this.checkIrq(a); if (wrEn) this.ramView.setInt16(a, sat16(v), true); };\\n    const dAPF1 = rg(0), dAPF2 = rg(1), vIIR = g(2), vCOMB1 = g(3), vCOMB2 = g(4), vCOMB3 = g(5), vCOMB4 = g(6), vWALL = g(7), vAPF1 = g(8), vAPF2 = g(9);\\n    const mLSAME = rg(10), mRSAME = rg(11), mLCOMB1 = rg(12), mRCOMB1 = rg(13), mLCOMB2 = rg(14), mRCOMB2 = rg(15), dLSAME = rg(16), dRSAME = rg(17),\\n          mLDIFF = rg(18), mRDIFF = rg(19), mLCOMB3 = rg(20), mRCOMB3 = rg(21), mLCOMB4 = rg(22), mRCOMB4 = rg(23), dLDIFF = rg(24), dRDIFF = rg(25),\\n          mLAPF1 = rg(26), mRAPF1 = rg(27), mLAPF2 = rg(28), mRAPF2 = rg(29), vLIN = g(30), vRIN = g(31);\\n    const Lin = (sat16(inL) * vLIN) >> 15, Rin = (sat16(inR) * vRIN) >> 15;\\n    const iir = (x, prev, d) => ((((x + ((d * vWALL) >> 15) - prev) * vIIR) >> 15) + prev);\\n    // reflexão (mesmo lado e lado oposto) - \\\"prev\\\" é a amostra 2 bytes antes\\n    wr(mLSAME, iir(Lin, rd(mLSAME, -2), rd(dLSAME)));\\n    wr(mRSAME, iir(Rin, rd(mRSAME, -2), rd(dRSAME)));\\n    wr(mLDIFF, iir(Lin, rd(mLDIFF, -2), rd(dRDIFF)));\\n    wr(mRDIFF, iir(Rin, rd(mRDIFF, -2), rd(dLDIFF)));\\n    // eco inicial (4 combs)\\n    let L = (rd(mLCOMB1) * vCOMB1 + rd(mLCOMB2) * vCOMB2 + rd(mLCOMB3) * vCOMB3 + rd(mLCOMB4) * vCOMB4) >> 15;\\n    let Rr = (rd(mRCOMB1) * vCOMB1 + rd(mRCOMB2) * vCOMB2 + rd(mRCOMB3) * vCOMB3 + rd(mRCOMB4) * vCOMB4) >> 15;\\n    // all-pass 1 e 2\\n    const apf = (x, m, d, v) => { const t = rd(m - d); const y = x - ((t * v) >> 15); wr(m, y); return ((y * v) >> 15) + t; };\\n    L = apf(L, mLAPF1, dAPF1, vAPF1); Rr = apf(Rr, mRAPF1, dAPF1, vAPF1);\\n    L = apf(L, mLAPF2, dAPF2, vAPF2); Rr = apf(Rr, mRAPF2, dAPF2, vAPF2);\\n    this.revOutL = (sat16(L) * s16(this.reg(R.REVL))) >> 15;\\n    this.revOutR = (sat16(Rr) * s16(this.reg(R.REVR))) >> 15;\\n    this.revAdvance(base);\\n  }\\n  revAdvance(base = (this.reg(R.REVBASE) << 3) & (SPU_RAM_SIZE - 1)) { this.revPos += 2; if (this.revPos >= SPU_RAM_SIZE) this.revPos = base; }\\n\\n  /** Gera `frames` amostras estéreo intercaladas (Int16Array L,R,L,R...) */\\n  render(frames, out) {\\n    out = out ?? new Int16Array(frames * 2);\\n    for (let i = 0; i < frames; i++) { const [l, r] = this.tick(); out[2 * i] = l; out[2 * i + 1] = r; }\\n    return out;\\n  }\\n\\n  /** Entrada de áudio do CD (amostras estéreo já em 44.1kHz) */\\n  pushCd(l, r) {\\n    const n = (this.cdTail + 1) & 0xFFFF; if (n === this.cdHead) return;      // cheio\\n    this.cdBufL[this.cdTail] = sat16(l | 0); this.cdBufR[this.cdTail] = sat16(r | 0); this.cdTail = n;\\n  }\\n}\\n\\nreturn { SPU_RAM_SIZE, REV_FIR, SPU };\\n})();\\nconst __src_disc = (() => {\\n// ============================================================================\\n//  Imagem de disco (.bin crua 2352 bytes/setor, ou .iso 2048) + ISO9660 + PS-X EXE\\n// ============================================================================\\n//  Layout de um setor CD-ROM XA \\\"MODE 2\\\" (2352 bytes):\\n//    0x000  12  sync (00 FF*10 00)\\n//    0x00C   4  header: MM SS FF (BCD) + modo (2)\\n//    0x010   8  subheader: file, channel, submode, coding (x2)\\n//    0x018 2048 dados (Form 1)   [Form 2 = 2324 bytes, usado em XA-ADPCM/vídeo]\\n//    ...        EDC/ECC\\n//  LBA 0 == tempo absoluto 00:02:00 (pregap de 150 setores).\\n// ============================================================================\\n\\nconst SECTOR_RAW = 2352;\\nconst SECTOR_USER = 2048;\\nconst SYNC = [0x00, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0x00];\\n\\nconst bcd = v => ((v / 10 | 0) << 4) | (v % 10);\\nconst unbcd = v => (v >> 4) * 10 + (v & 15);\\nconst u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;\\n\\nconst lbaToMsf = lba => { lba += 150; return { m: bcd(lba / 4500 | 0), s: bcd((lba / 75 | 0) % 60), f: bcd(lba % 75) }; };\\nconst msfToLba = (m, s, f) => (unbcd(m) * 60 + unbcd(s)) * 75 + unbcd(f) - 150;\\n\\nclass PsxExe {\\n  constructor(bytes) {\\n    const magic = String.fromCharCode(...bytes.subarray(0, 8));\\n    if (magic !== 'PS-X EXE') throw new Error('Não é um PS-X EXE');\\n    this.pc = u32(bytes, 0x10);\\n    this.gp = u32(bytes, 0x14);\\n    this.textAddr = u32(bytes, 0x18);\\n    this.textSize = u32(bytes, 0x1C);\\n    this.sp = u32(bytes, 0x30) ? (u32(bytes, 0x30) + u32(bytes, 0x34)) >>> 0 : 0;\\n    this.region = String.fromCharCode(...bytes.subarray(0x4C, 0x80)).split('\\\\0')[0];\\n    this.data = bytes.slice(0x800, 0x800 + this.textSize);\\n  }\\n}\\n\\nconst cueTime = t => { const m = /^(\\\\d+):(\\\\d+):(\\\\d+)$/.exec(t); if (!m) throw new Error('Tempo inválido no CUE: ' + t); return (+m[1] * 60 + +m[2]) * 75 + +m[3]; };\\n\\n/**\\n * Fonte de bytes PREGUIÇOSA sobre um Blob/File: lê do arquivo só o que o emulador pede (blocos de 256 KB em cache LRU), em vez de\\n * carregar o disco inteiro na memória (um .bin de 700 MB estourava a memória da aba no celular). Só funciona dentro de um Web Worker\\n * (usa FileReaderSync). Mesma interface que o DiscImage usa de um Uint8Array: `length` e `subarray(a, b)`.\\n */\\nclass BlobSource {\\n  constructor(blob, reader = null, chunk = 262144, keep = 12) {\\n    this.blob = blob; this.length = blob.size; this.CH = chunk; this.keep = keep; this.lru = new Map();\\n    const frs = reader ? null : new FileReaderSync();\\n    this.read = reader || ((a, b) => new Uint8Array(frs.readAsArrayBuffer(blob.slice(a, b))));\\n  }\\n  chunk(i) {\\n    let c = this.lru.get(i);\\n    if (c) { this.lru.delete(i); this.lru.set(i, c); return c; }\\n    c = this.read(i * this.CH, Math.min(this.length, (i + 1) * this.CH));\\n    this.lru.set(i, c); if (this.lru.size > this.keep) this.lru.delete(this.lru.keys().next().value);\\n    return c;\\n  }\\n  subarray(a, b = this.length) {\\n    a = Math.max(0, a); b = Math.min(this.length, b); if (b <= a) return new Uint8Array(0);\\n    const ca = Math.floor(a / this.CH), cb = Math.floor((b - 1) / this.CH);\\n    if (ca === cb) return this.chunk(ca).subarray(a - ca * this.CH, b - ca * this.CH);\\n    const out = new Uint8Array(b - a);                                       // setor que cruza dois blocos: monta uma cópia\\n    for (let i = ca; i <= cb; i++) { const base = i * this.CH, c = this.chunk(i), lo = Math.max(a, base), hi = Math.min(b, base + c.length); out.set(c.subarray(lo - base, hi - base), lo - a); }\\n    return out;\\n  }\\n}\\n\\nclass DiscImage {\\n  /**\\n   * `bytes` = imagem de UMA trilha de dados (.bin 2352 cru ou .iso 2048).\\n   * `layout` (usado por fromCue) = { files:[{bytes,sectorSize,lba0,count}], tracks:[{n,type,start}] }.\\n   */\\n  constructor(bytes, layout = null) {\\n    if (layout) { this.files = layout.files; this.tracks = layout.tracks; }\\n    else {\\n      const head = bytes.subarray(0, 12), raw = bytes.length % SECTOR_RAW === 0 && SYNC.every((v, i) => head[i] === v), ss = raw ? SECTOR_RAW : SECTOR_USER;\\n      this.files = [{ bytes, sectorSize: ss, lba0: 0, count: Math.floor(bytes.length / ss) }];\\n      this.tracks = [{ n: 1, type: 'data', start: 0 }];\\n    }\\n    const f0 = this.files[0], last = this.files[this.files.length - 1];\\n    this.bytes = f0.bytes;\\n    this.sectorSize = f0.sectorSize;\\n    this.raw = f0.sectorSize === SECTOR_RAW;\\n    this.sectorCount = last.lba0 + last.count;\\n    this.tracks.forEach((t, i) => { const nx = this.tracks[i + 1]; t.end = nx ? (nx.pre ?? nx.start) : this.sectorCount; });\\n    this.silence = new Uint8Array(SECTOR_RAW);                            // PREGAP virtual (sem dados no arquivo)\\n    this.userOffset = this.raw ? (f0.bytes.subarray(15, 16)[0] === 2 ? 24 : 16) : 0;      // MODE2 -> 24, MODE1 -> 16\\n    this.pvd = this.readUser(16);\\n    if (!this.pvd || String.fromCharCode(...this.pvd.subarray(1, 6)) !== 'CD001') throw new Error('Volume ISO9660 não encontrado no LBA 16');\\n    this.volumeId = text(this.pvd, 40, 32);\\n    this.systemId = text(this.pvd, 8, 32);\\n    this.rootLba = u32(this.pvd, 158);\\n    this.rootLen = u32(this.pvd, 166);\\n    this.cache = new Map();\\n  }\\n\\n  /**\\n   * Monta um disco a partir de um .cue. `files` = { 'nome.bin': Uint8Array, ... } (ou Map).\\n   * Suporta várias trilhas por arquivo ou um arquivo por trilha, MODE1/2048, MODE1/2352,\\n   * MODE2/2352 e AUDIO (PCM 16-bit estéreo 44.1 kHz), INDEX 00/01 e PREGAP.\\n   */\\n  static fromCue(cueText, files) {\\n    const map = files instanceof Map ? files : new Map(Object.entries(files));\\n    const find = name => {\\n      if (map.has(name)) return map.get(name);\\n      const base = name.split(/[\\\\\\\\/]/).pop().toLowerCase();\\n      for (const [k, v] of map) if (k.split(/[\\\\\\\\/]/).pop().toLowerCase() === base) return v;\\n      throw new Error('Arquivo do CUE não fornecido: ' + name);\\n    };\\n    const fl = [], tracks = []; let cur = null, curTrack = null, running = 0;\\n    const closeFile = () => { if (cur) { cur.count = Math.floor(cur.bytes.length / cur.sectorSize); running = cur.lba0 + cur.count; } };\\n    for (const raw of cueText.split(/\\\\r?\\\\n/)) {\\n      const line = raw.trim(); let m;\\n      if ((m = /^FILE\\\\s+(?:\\\"([^\\\"]+)\\\"|(\\\\S+))\\\\s+(\\\\S+)/i.exec(line))) {\\n        closeFile();\\n        cur = { bytes: find(m[1] ?? m[2]), sectorSize: 0, lba0: running, count: 0, first: true };\\n        fl.push(cur);\\n      } else if ((m = /^TRACK\\\\s+(\\\\d+)\\\\s+(\\\\S+)/i.exec(line))) {\\n        if (!cur) throw new Error('TRACK antes de FILE no CUE');\\n        const mode = m[2].toUpperCase(), audio = mode === 'AUDIO';\\n        const ss = mode === 'MODE1/2048' ? SECTOR_USER : mode === 'MODE2/2336' ? 2336 : SECTOR_RAW;\\n        if (!cur.sectorSize) cur.sectorSize = ss;\\n        curTrack = { n: +m[1], type: audio ? 'audio' : 'data', start: 0, file: cur, firstInFile: cur.first };\\n        cur.first = false; tracks.push(curTrack);\\n      } else if ((m = /^PREGAP\\\\s+(\\\\S+)/i.exec(line)) && curTrack) {\\n        if (curTrack.firstInFile) { const g = cueTime(m[1]); cur.lba0 += g; }          // silêncio antes do arquivo\\n      } else if ((m = /^INDEX\\\\s+(\\\\d+)\\\\s+(\\\\S+)/i.exec(line)) && curTrack) {\\n        if (+m[1] === 1) curTrack.start = cur.lba0 + cueTime(m[2]);\\n        else if (+m[1] === 0) curTrack.pre = cur.lba0 + cueTime(m[2]);                  // início do pregap (INDEX 00)\\n      }\\n    }\\n    closeFile();\\n    if (!tracks.length) throw new Error('CUE sem trilhas');\\n    tracks.forEach(t => delete t.file);\\n    tracks[0].start = 0;                                                                // LBA 0 = início da trilha 1\\n    return new DiscImage(null, { files: fl.map(({ bytes, sectorSize, lba0, count }) => ({ bytes, sectorSize, lba0, count })), tracks: tracks.map(({ n, type, start, pre }) => (pre !== undefined && pre < start ? { n, type, start, pre } : { n, type, start })) });\\n  }\\n\\n  trackAt(lba) {\\n    for (let i = this.tracks.length - 1; i >= 0; i--) if (lba >= (this.tracks[i].pre ?? this.tracks[i].start)) return this.tracks[i];\\n    return this.tracks[0];\\n  }\\n\\n  /** Setor inteiro (2352 bytes se raw; 2048 se .iso) */\\n  readSector(lba) {\\n    if (lba < 0 || lba >= this.sectorCount) return null;\\n    for (const f of this.files) {\\n      if (lba >= f.lba0 && lba < f.lba0 + f.count) return f.bytes.subarray((lba - f.lba0) * f.sectorSize, (lba - f.lba0 + 1) * f.sectorSize);\\n    }\\n    return this.silence;\\n  }\\n  /** 2048 bytes de dados (Form 1) */\\n  readUser(lba) {\\n    const s = this.readSector(lba);\\n    return s && s.subarray(this.userOffset, this.userOffset + SECTOR_USER);\\n  }\\n  /** Cabeçalho/subheader XA: o controlador de CD-ROM usa isso (filtros XA, tipo de setor) */\\n  sectorInfo(lba) {\\n    const s = this.readSector(lba);\\n    if (!s || !this.raw || s.length !== SECTOR_RAW || this.trackAt(lba).type === 'audio') return null;\\n    const sm = s[18];\\n    return { mode: s[15], file: s[16], channel: s[17], submode: sm, coding: s[19],\\n             form2: !!(sm & 0x20), audio: !!(sm & 0x04), video: !!(sm & 0x02), data: !!(sm & 0x08), rt: !!(sm & 0x40), eof: !!(sm & 0x80) };\\n  }\\n\\n  // ---------------- ISO9660 ----------------\\n  readDir(lba, len) {\\n    const out = [];\\n    for (let blk = 0; blk < Math.ceil(len / 2048); blk++) {\\n      const d = this.readUser(lba + blk); let o = 0;\\n      while (o < 2048 && d[o]) {\\n        const l = d[o], nl = d[o + 32];\\n        const name = text(d, o + 33, nl);\\n        if (name !== '\\\\0' && name !== '\\\\x01')\\n          out.push({ name, lba: u32(d, o + 2), size: u32(d, o + 10), dir: !!(d[o + 25] & 2) });\\n        o += l;\\n      }\\n    }\\n    return out;\\n  }\\n  listRoot() { return this.cache.get('root') ?? (this.cache.set('root', this.readDir(this.rootLba, this.rootLen)), this.cache.get('root')); }\\n\\n  /** Procura \\\"DIR\\\\ARQ.EXT\\\" ignorando o \\\";1\\\" e maiúsc./minúsc. */\\n  findFile(path) {\\n    const parts = path.replace(/^cdrom:/i, '').split(/[\\\\\\\\/]/).filter(Boolean);\\n    let list = this.listRoot(), ent = null;\\n    for (const p of parts) {\\n      const want = p.toUpperCase().replace(/;\\\\d+$/, '');\\n      ent = list.find(e => e.name.toUpperCase().replace(/;\\\\d+$/, '') === want);\\n      if (!ent) return null;\\n      if (ent.dir) list = this.readDir(ent.lba, ent.size);\\n    }\\n    return ent;\\n  }\\n  readFile(path) {\\n    const e = this.findFile(path); if (!e) return null;\\n    const out = new Uint8Array(e.size);\\n    for (let i = 0; i * 2048 < e.size; i++) out.set(this.readUser(e.lba + i).subarray(0, Math.min(2048, e.size - i * 2048)), i * 2048);\\n    return out;\\n  }\\n\\n  systemCnf() {\\n    const f = this.readFile('SYSTEM.CNF'); if (!f) return null;\\n    const cnf = {};\\n    for (const line of String.fromCharCode(...f).split(/\\\\r?\\\\n/)) {\\n      const m = line.match(/^\\\\s*(\\\\w+)\\\\s*=\\\\s*(.*?)\\\\s*$/); if (m) cnf[m[1].toUpperCase()] = m[2];\\n    }\\n    return cnf;\\n  }\\n\\n  /** Região lida da área de licença (setores 4..): SCEI (JP), SCEA (US), SCEE (EU) */\\n  region() {\\n    let t = '';\\n    for (let i = 0; i < 12; i++) t += String.fromCharCode(...this.readUser(i));\\n    const c = t.replace(/[^A-Za-z]/g, '');\\n    if (/Entertainment(Euro)*pe/.test(c) || /Europe/.test(c)) return 'SCEE';\\n    if (/America|Amer/.test(c)) return 'SCEA';\\n    if (/LicensedbySonyComputerEntertainmentInc/.test(c)) return 'SCEI';\\n    return 'desconhecida';\\n  }\\n\\n  /** Executável de boot (BOOT= do SYSTEM.CNF; fallback PSX.EXE) */\\n  loadBootExe() {\\n    const cnf = this.systemCnf();\\n    const path = cnf?.BOOT?.replace(/^cdrom:\\\\\\\\?/i, '') ?? 'PSX.EXE';\\n    const bytes = this.readFile(path);\\n    if (!bytes) throw new Error('Executável de boot não encontrado: ' + path);\\n    const exe = new PsxExe(bytes);\\n    exe.path = path; exe.cnf = cnf ?? {};\\n    exe.stack = cnf?.STACK ? parseInt(cnf.STACK, 16) >>> 0 : 0x801FFF00;\\n    return exe;\\n  }\\n\\n  info() {\\n    const cnf = this.systemCnf();\\n    const secs = this.sectorCount, sec = secs / 75 | 0;\\n    return { formato: this.raw ? 'BIN cru 2352 (MODE2/XA)' : 'ISO 2048', setores: secs, trilhas: this.tracks.length, audio: this.tracks.filter(t => t.type === 'audio').length,\\n             duracao: `${sec / 60 | 0}:${String(sec % 60).padStart(2, '0')}`, volume: this.volumeId.trim(),\\n             regiao: this.region(), boot: cnf?.BOOT, stack: cnf?.STACK };\\n  }\\n}\\n\\nconst text = (b, o, n) => String.fromCharCode(...b.subarray(o, o + n));\\n\\nreturn { SECTOR_RAW, SECTOR_USER, lbaToMsf, msfToLba, PsxExe, BlobSource, DiscImage };\\n})();\\nconst __src_scheduler = (() => {\\n// Agendador de eventos em ciclos de CPU (usado por CD-ROM, SIO0, DMA...)\\n// Dois tipos de evento:\\n//   add(time, fn)                      closure (não entra em save states; só para testes/uso interno)\\n//   call(time, obj, método, args)      descritor serializável: chama reg[obj][método](...args)\\nclass Scheduler {\\n  constructor() { this.q = []; this.reg = {}; this.onEarly = null; }\\n  /** registra os objetos que podem receber eventos descritores (cdrom, dma, sio...) */\\n  register(name, obj) { this.reg[name] = obj; }\\n  _ins(e) { if (this.onEarly) this.onEarly(e.time); let i = this.q.length; while (i > 0 && this.q[i - 1].time > e.time) i--; this.q.splice(i, 0, e); return e; }\\n  /** agenda fn para o instante absoluto `time` (em ciclos) */\\n  add(time, fn) { return this._ins({ time, fn }); }\\n  call(time, o, m, a = []) { return this._ins({ time, o, m, a }); }\\n  cancel(e) { const i = this.q.indexOf(e); if (i >= 0) this.q.splice(i, 1); }\\n  run(now) {\\n    while (this.q.length && this.q[0].time <= now) {\\n      const e = this.q.shift();\\n      if (e.fn) e.fn(); else this.reg[e.o][e.m](...e.a);\\n    }\\n  }\\n  clear() { this.q.length = 0; }\\n  get next() { return this.q.length ? this.q[0].time : Infinity; }\\n  /** lista serializável (falha se houver closures) */\\n  snapshot() {\\n    return this.q.map(e => { if (e.fn) throw new Error('evento com closure não pode entrar no save state'); return { time: e.time, o: e.o, m: e.m, a: e.a }; });\\n  }\\n  restore(list) { this.q = list.map(e => ({ time: e.time, o: e.o, m: e.m, a: e.a })); }\\n  find(o, m) { return this.q.find(e => e.o === o && e.m === m) || null; }\\n}\\n\\nreturn { Scheduler };\\n})();\\nconst __src_timers = (() => {\\n// ============================================================================\\n//  Root counters (timers) 0x1F801100-0x1F80112F\\n//   +0 contador  +4 modo  +8 alvo\\n//   modo: b0 sync, b1-2 sync mode, b3 reset no alvo, b4 IRQ no alvo, b5 IRQ em 0xFFFF,\\n//         b6 IRQ repetido, b7 toggle, b8-9 clock, b10 IRQ flag (1=sem IRQ), b11 atingiu alvo, b12 atingiu FFFF\\n//   Timer0: sysclk | dotclock    Timer1: sysclk | hblank    Timer2: sysclk | sysclk/8\\n//  Modos de sincronização (mode bit0=1; bits 1-2):\\n//    Timer0 (hblank) / Timer1 (vblank):  0 = pausa durante o blank   1 = zera o contador ao entrar no blank\\n//        2 = zera ao entrar no blank e só conta DENTRO dele          3 = pausa até o 1º blank, depois roda livre\\n//    Timer2: 0 e 3 = parado   1 e 2 = livre.\\n//  O PSX informa o estado (hblank, vblank) por tick() via setBlank(); as bordas aplicam reset/liberação.\\n// ============================================================================\\nclass Timers {\\n  constructor(sys) {\\n    this.sys = sys; this.dotDiv = 10; this.hb = false; this.vb = false;\\n    this.t = [0, 1, 2].map(() => ({ counter: 0, mode: 0x400, target: 0, irqDone: false, frac: 0, free: false }));\\n  }\\n  reset() { for (const t of this.t) { t.counter = 0; t.mode = 0x400; t.target = 0; t.irqDone = false; t.frac = 0; t.free = false; } this.hb = false; this.vb = false; }\\n\\n  read(addr, size) {\\n    const n = (addr >> 4) & 3, r = addr & 0xC; if (n > 2) return 0;\\n    this.sys.syncTimers?.(); const t = this.t[n]; let v = 0;\\n    if (r === 0) v = t.counter; else if (r === 4) { v = t.mode; t.mode &= ~0x1800; } else if (r === 8) v = t.target;\\n    if (addr & 2) return 0;\\n    return size === 1 ? v & 0xFF : v >>> 0;\\n  }\\n  write(addr, size, v) {\\n    const n = (addr >> 4) & 3, r = addr & 0xC; if (n > 2 || (addr & 2)) return;\\n    this.sys.syncTimers?.(); const t = this.t[n];\\n    if (r === 0) t.counter = v & 0xFFFF;\\n    else if (r === 4) { t.mode = (v & 0x3FF) | 0x400; t.counter = 0; t.irqDone = false; t.frac = 0; t.free = false; }\\n    else if (r === 8) t.target = v & 0xFFFF;\\n    this.sys.retime?.();\\n  }\\n\\n  /** estado do blank horizontal/vertical no início do tick; as bordas aplicam os modos de sync */\\n  setBlank(hb, vb) {\\n    if (hb !== this.hb) { this.hb = hb; this.edge(0, hb); }\\n    if (vb !== this.vb) { this.vb = vb; this.edge(1, vb); }\\n  }\\n  edge(n, on) {\\n    const t = this.t[n]; if (!(t.mode & 1) || !on) return;\\n    const sm = (t.mode >> 1) & 3;\\n    if (sm === 1 || sm === 2) t.counter = 0; else if (sm === 3) t.free = true;\\n  }\\n  /** o contador n pode contar agora? (timers 0/1 conforme o blank; timer 2 conforme o modo) */\\n  gate(n) {\\n    const t = this.t[n]; if (!(t.mode & 1)) return true;\\n    const sm = (t.mode >> 1) & 3;\\n    if (n === 2) return sm === 1 || sm === 2;\\n    const blank = n === 0 ? this.hb : this.vb;\\n    return sm === 0 ? !blank : sm === 1 ? true : sm === 2 ? blank : t.free;\\n  }\\n\\n  /** avança `dt` ciclos de CPU */\\n  advance(dt) {\\n    for (let n = 0; n < 3; n++) {\\n      const t = this.t[n], src = (t.mode >> 8) & 3; let ticks = 0;\\n      if (n === 0) { if (src & 1) { t.frac += dt * 11 / (7 * this.dotDiv); ticks = t.frac | 0; t.frac -= ticks; } else ticks = dt; }\\n      else if (n === 1) { if (src & 1) continue; ticks = dt; }                 // hblank: via hblank()\\n      else if (src & 2) { t.frac += dt / 8; ticks = t.frac | 0; t.frac -= ticks; } else ticks = dt;\\n      if (ticks && this.gate(n)) this.add(n, t, ticks);\\n    }\\n  }\\n  /** ciclos de CPU (>= 1) até o próximo evento de IRQ de algum contador (alvo/0xFFFF); Infinity se nada pode disparar. Usado para limitar o tick adaptativo. */\\n  nextEvent() {\\n    let best = Infinity;\\n    for (let n = 0; n < 3; n++) {\\n      const t = this.t[n], m = t.mode; if (!(m & 0x30)) continue;                        // sem IRQ no alvo nem em 0xFFFF\\n      const src = (m >> 8) & 3; let rate;\\n      if (n === 0) rate = (src & 1) ? 11 / (7 * this.dotDiv) : 1; else if (n === 1) { if (src & 1) continue; rate = 1; } else rate = (src & 2) ? 1 / 8 : 1;\\n      if (!this.gate(n)) continue;\\n      const v = t.counter; let need = 0x10000 - v;                                       // 0xFFFF -> 0 (IRQ do estouro)\\n      if (!(m & 0x20)) need = Infinity;\\n      if (m & 0x10) { const a = v < t.target ? t.target - v : (0x10000 - v) + t.target; if (a < need) need = a; }\\n      const cyc = Math.floor((need - t.frac) / rate);\\n      if (cyc < best) best = cyc;\\n    }\\n    return best < 1 ? 1 : best;\\n  }\\n  hblank() { const t = this.t[1]; if (((t.mode >> 8) & 1) && this.gate(1)) this.add(1, t, 1); }\\n\\n  add(n, t, count) {\\n    const reset = !!(t.mode & 8); let v = t.counter, left = count;\\n    while (left > 0) {\\n      const limit = (reset && v <= t.target) ? t.target : 0xFFFF, room = limit - v;\\n      if (left <= room) { this.hit(n, t, v, v + left); v += left; left = 0; }\\n      else {\\n        this.hit(n, t, v, limit); left -= room + 1; v = 0;\\n        if (limit === 0xFFFF) { t.mode |= 0x1000; if (t.mode & 0x20) this.irq(n, t); }\\n      }\\n    }\\n    t.counter = v;\\n  }\\n  hit(n, t, a, b) { if (a < t.target && t.target <= b) { t.mode |= 0x800; if (t.mode & 0x10) this.irq(n, t); } }\\n  irq(n, t) {\\n    if (!(t.mode & 0x40) && t.irqDone) return;\\n    t.irqDone = true;\\n    if (t.mode & 0x80) { t.mode ^= 0x400; if (!(t.mode & 0x400)) this.sys.irq(4 + n); }   // toggle\\n    else this.sys.irq(4 + n);                                                           // pulso\\n  }\\n}\\n\\nreturn { Timers };\\n})();\\nconst __src_dma = (() => {\\n// ============================================================================\\n//  Controlador de DMA  0x1F801080-0x1F8010F7\\n//   canal n: +0 MADR, +4 BCR, +8 CHCR    0xF0 DPCR    0xF4 DICR\\n//   0 MDEC-in 1 MDEC-out 2 GPU 3 CD-ROM 4 SPU 5 PIO 6 OTC\\n//  A transferência é feita na hora; só a conclusão/IRQ é agendada (1 ciclo/palavra).\\n// ============================================================================\\nclass DMA {\\n  constructor(sys) {\\n    this.sys = sys; this.dev = {};                    // gpu, spu, cdrom, mdec (preenchido pelo PSX)\\n    this.madr = new Uint32Array(7); this.bcr = new Uint32Array(7); this.chcr = new Uint32Array(7);\\n    this.reset();\\n  }\\n  reset() { this.madr.fill(0); this.bcr.fill(0); this.chcr.fill(0); this.dpcr = 0x07654321; this.dicr = 0; this.prevIrq = false; this.deferred = null; }\\n\\n  read(addr, size) {\\n    const sh = (addr & 3) * 8, a = addr & ~3; let v = 0;\\n    if (a === 0x1F8010F0) v = this.dpcr; else if (a === 0x1F8010F4) v = this.dicr;\\n    else {\\n      const ch = (a - 0x1F801080) >> 4;\\n      if (ch >= 0 && ch < 7) { const r = a & 0xC; v = r === 0 ? this.madr[ch] : r === 4 ? this.bcr[ch] : r === 8 ? this.chcr[ch] : 0; }\\n    }\\n    return size === 4 ? v >>> 0 : ((v >>> sh) & (size === 2 ? 0xFFFF : 0xFF)) >>> 0;\\n  }\\n\\n  write(addr, size, v) {\\n    if (size !== 4) {                                   // sub-palavra: read-modify-write\\n      const a = addr & ~3, sh = (addr & 3) * 8, m = (size === 2 ? 0xFFFF : 0xFF) << sh;\\n      // no DICR os bits 24-30 são \\\"escreva 1 para limpar\\\": os bytes NÃO escritos devem valer 0 nas flags\\n      // (senão a flag atual seria remendada no valor e apagada por engano)\\n      const cur = a === 0x1F8010F4 ? (this.read(a, 4) & 0x80FFFFFF) : this.read(a, 4);\\n      v = ((cur & ~m) | ((v << sh) & m)) >>> 0; addr = a;\\n    }\\n    if (addr === 0x1F8010F0) { this.dpcr = v >>> 0; return; }\\n    if (addr === 0x1F8010F4) {\\n      const keep = this.dicr & 0x7F000000 & ~(v & 0x7F000000);\\n      this.dicr = ((v & 0x00FF803F) | keep) >>> 0; this.updateIrq(); return;\\n    }\\n    const ch = (addr - 0x1F801080) >> 4; if (ch < 0 || ch > 6) return;\\n    const r = addr & 0xC;\\n    if (r === 0) this.madr[ch] = v & 0xFFFFFF;\\n    else if (r === 4) this.bcr[ch] = v;\\n    else if (r === 8) {\\n      this.chcr[ch] = ch === 6 ? ((v & 0x51000000) | 2) >>> 0 : v >>> 0;\\n      this.maybeStart(ch);\\n    }\\n  }\\n\\n  maybeStart(ch) {\\n    const c = this.chcr[ch];\\n    if (!(c & 0x01000000)) return;                                   // start/busy\\n    if (!(this.dpcr & (8 << (ch * 4)))) return;                      // canal desabilitado no DPCR\\n    const sync = (c >> 9) & 3;\\n    // modo 0: só o OTC (sem linha DREQ) e o PIO precisam do bit de trigger; GPU/CD/SPU/MDEC iniciam sozinhos (medido em hardware)\\n    if (sync === 0 && !(c & 0x10000000) && (ch === 6 || ch === 5)) return;\\n    const words = this.run(ch);\\n    if (words < 0) return;                                           // adiado (aguardando dados do MDEC)\\n    this.sys.sched.call(this.sys.now() + this.duration(ch, words, c), 'dma', 'finish', [ch]);\\n  }\\n\\n  /** duração (ciclos de CPU) de uma transferência. Ajustado às medições do ps1-tests/dma/chopping:\\n   *  1 ciclo/palavra (CD 24, SPU 12), +~10 por bloco no sync 1, e chopping = janela de DMA + pausa da CPU a cada fatia */\\n  duration(ch, words, c) {\\n    const per = ch === 3 ? 24 : ch === 4 ? 12 : 1, sync = (c >> 9) & 3; let cyc = words * per + (ch === 2 ? 150 : 16);\\n    if (c & 0x100) {                                                 // chopping\\n      const win = 1 << ((c >> 16) & 7), cpu = Math.min(1 << ((c >> 20) & 7), 32 * win);\\n      cyc += Math.ceil(words / win) * (6 + cpu);\\n    } else if (sync === 1) cyc += (((this.bcr[ch] >>> 16) || 0x10000)) * 10;\\n    return Math.max(8, Math.round(cyc));\\n  }\\n\\n  finish(ch) {\\n    this.chcr[ch] &= ~0x11000000;\\n    if ((this.dicr >> (16 + ch)) & 1) {\\n      this.dicr |= (1 << (24 + ch));\\n      this.updateIrq();\\n      // cada conclusão de um canal habilitado reafirma a IRQ3 (não só na subida do bit 31):\\n      // evita que uma flag não reconhecida silencie todas as próximas interrupções de DMA\\n      if ((this.dicr >>> 31) & 1) this.sys.irq(3);\\n    } else this.updateIrq();\\n  }\\n  updateIrq() {\\n    const flags = (this.dicr >> 24) & 0x7F, en = (this.dicr >> 16) & 0x7F, master = (this.dicr >> 23) & 1, force = (this.dicr >> 15) & 1;\\n    const m = !!(force || (master && (flags & en)));\\n    this.dicr = ((this.dicr & 0x7FFFFFFF) | (m ? 0x80000000 : 0)) >>> 0;\\n    if (m && !this.prevIrq) this.sys.irq(3);\\n    this.prevIrq = m;\\n  }\\n\\n  /** o MDEC produziu dados: atende um DMA1 que estava esperando */\\n  mdecOutReady() {\\n    const m = this.dev.mdec, p = m && m.pendingOut; if (!p || m.outWords() < p.words) return;\\n    m.pendingOut = null; const rv = this.sys.bus.ramView, b = m.dmaRead(p.words); let a = p.addr;\\n    const bus = this.sys.bus; for (let i = 0; i < p.words; i++) { const o = a & 0x1FFFFC; rv.setUint32(o, b[i], true); if (bus.codeFlags[o >>> 6]) bus.onCodeWrite(o); a += p.step; }\\n    this.madr[1] = a & 0xFFFFFF;\\n    this.sys.sched.call(this.sys.now() + Math.max(8, p.words), 'dma', 'finish', [1]);\\n  }\\n\\n  /** executa a transferência; devolve o nº de palavras */\\n  run(ch) {\\n    const bus = this.sys.bus, rv = bus.ramView, c = this.chcr[ch];\\n    const dir = c & 1, step = (c & 2) ? -4 : 4, sync = (c >> 9) & 3;\\n    let addr = this.madr[ch] & 0x1FFFFC, bcr = this.bcr[ch];\\n    const words = sync === 1 ? ((bcr & 0xFFFF) * (bcr >>> 16)) || 0x10000 : ((bcr & 0xFFFF) || 0x10000);\\n    const rd = a => rv.getUint32(a & 0x1FFFFC, true), wr = (a, v) => { const o = a & 0x1FFFFC; rv.setUint32(o, v >>> 0, true); if (bus.codeFlags[o >>> 6]) bus.onCodeWrite(o); };\\n    const d = this.dev;\\n\\n    switch (ch) {\\n      case 6: {                                                      // OTC: lista encadeada reversa\\n        for (let i = 0; i < words; i++) { wr(addr, i === words - 1 ? 0x00FFFFFF : (addr - 4) & 0x1FFFFF); addr = (addr - 4) & 0x1FFFFC; }\\n        this.madr[6] = addr; return words;\\n      }\\n      case 2:                                                        // GPU\\n        if (sync === 2) {                                            // linked list\\n          let n = 0, a = addr;\\n          for (let g = 0; g < 0x100000; g++) {\\n            const hdr = rd(a), cnt = hdr >>> 24;\\n            for (let i = 1; i <= cnt; i++) d.gpu.writeGP0(rd(a + 4 * i));\\n            n += cnt + 1; if (hdr & 0x800000) break; a = hdr & 0x1FFFFC;\\n          }\\n          this.madr[2] = a; return n;\\n        }\\n        if (dir) { for (let i = 0; i < words; i++) { d.gpu.writeGP0(rd(addr)); addr += step; } }\\n        else { for (let i = 0; i < words; i++) { wr(addr, d.gpu.readData()); addr += step; } }\\n        this.madr[2] = addr & 0xFFFFFF; return words;\\n      case 4: {                                                      // SPU\\n        if (dir) { const b = new Uint32Array(words); for (let i = 0; i < words; i++) { b[i] = rd(addr); addr += step; } d.spu.dmaWrite(b); }\\n        else { const b = d.spu.dmaRead(words); for (let i = 0; i < words; i++) { wr(addr, b[i]); addr += step; } }\\n        this.madr[4] = addr & 0xFFFFFF; return words;\\n      }\\n      case 3: {                                                      // CD-ROM -> RAM\\n        const b = d.cdrom.dmaRead(words); for (let i = 0; i < words; i++) { wr(addr, b[i]); addr += step; }\\n        this.madr[3] = addr & 0xFFFFFF; return words;\\n      }\\n      case 0: {                                                      // MDEC in (RAM -> MDEC)\\n        if (d.mdec) { const b = new Uint32Array(words); for (let i = 0; i < words; i++) { b[i] = rd(addr); addr += step; } d.mdec.dmaWrite(b); }\\n        return words;\\n      }\\n      case 1: {                                                      // MDEC out (MDEC -> RAM)\\n        const m = d.mdec;\\n        if (m && m.outWords() < words) { m.pendingOut = { addr, step, words }; return -1; }          // espera o decodificador\\n        const b = m ? m.dmaRead(words) : new Uint32Array(words);\\n        for (let i = 0; i < words; i++) { wr(addr, b[i]); addr += step; }\\n        this.madr[1] = addr & 0xFFFFFF; return words;\\n      }\\n      default: return words;                                         // PIO: ignorado\\n    }\\n  }\\n}\\n\\nreturn { DMA };\\n})();\\nconst __src_mdec = (() => {\\n// ============================================================================\\n//  MDEC - decodificador de macroblocos (vídeo STR / imagens) 0x1F801820 / 0x1F801824\\n//   0x1F801820 W: comando/parâmetros   R: dados decodificados\\n//   0x1F801824 W: controle (b31 reset, b30 DMA0 on, b29 DMA1 on)   R: status\\n//  Comandos (bits 31-29 da palavra de comando):\\n//   1 = decodificar macroblocos (b28-27 profundidade: 0=4bit 1=8bit 2=24bit 3=15bit, b26 signed, b25 bit15, b15-0 = nº de palavras)\\n//   2 = tabelas de quantização (b0: 0 = só luma 64B, 1 = luma + croma 128B)\\n//   3 = tabela de escala do IDCT (64 halfwords)\\n//  Entrada: halfwords RLE: [qscale(6) | DC(10)] depois [run(6) | valor(10)] ... até 0xFE00 (fim de bloco)\\n//  Saída: macroblocos 16x16 (cores) na ordem do fluxo; cada um é decodificado de blocos Cr,Cb,Y1,Y2,Y3,Y4.\\n//  A decodificação é imediata (sem temporização); a conclusão do DMA é agendada pelo controlador de DMA.\\n// ============================================================================\\nconst ZIGZAG = [0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28,\\n                35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63];\\nconst IDLE = 0, DECODE = 1, QUANT = 2, SCALE = 3;\\nconst sx10 = v => (v << 22) >> 22;\\nconst clamp = (v, lo, hi) => v < lo ? lo : v > hi ? hi : v;\\n\\n/** tabela de cossenos padrão: T[k*8+n] = a_k * cos((2n+1)kπ/16) * 32768  (a_0 = 1/√2) */\\nfunction defaultScaleTable() {\\n  const t = new Int16Array(64);\\n  for (let k = 0; k < 8; k++) for (let n = 0; n < 8; n++) t[k * 8 + n] = Math.trunc((k === 0 ? Math.SQRT1_2 : 1) * Math.cos((2 * n + 1) * k * Math.PI / 16) * 32768);\\n  return t;\\n}\\n\\nclass MDEC {\\n  constructor() {\\n    this.out = new Uint8Array(1 << 22); this.onOutput = null; this.pendingOut = null;\\n    this.qtY = new Uint8Array(64).fill(2); this.qtC = new Uint8Array(64).fill(2); this.scale = defaultScaleTable();\\n    this.reset();\\n  }\\n\\n  reset() {\\n    this.state = IDLE; this.remaining = 0; this.depth = 0; this.signed = 0; this.bit15 = 0;\\n    this.hw = []; this.hwPos = 0; this.blocks = [0, 1, 2, 3, 4, 5].map(() => new Int32Array(64)); this.blk = 0;\\n    this.head = 0; this.tail = 0; this.dmaInEn = false; this.dmaOutEn = false; this.qbuf = []; this.sbuf = []; this.colorQ = false;\\n    this.coef = new Int32Array(64); this.tmp = new Int32Array(64); this.pendingOut = null; this.blocksDone = 0;\\n  }\\n\\n  outWords() { return (this.tail - this.head) >> 2; }\\n\\n  // ---------------- registradores ----------------\\n  read(addr) {\\n    if ((addr & 4) === 0) return this.dmaRead(1)[0];\\n    let s = 0;\\n    if (this.outWords() === 0) s |= 0x80000000;\\n    if (this.state !== IDLE) s |= 0x20000000;                       // comando em andamento (busy)\\n    if (this.dmaInEn) s |= 0x10000000;\\n    if (this.dmaOutEn && this.outWords() > 0) s |= 0x08000000;\\n    s |= (this.depth << 25) | (this.signed << 24) | (this.bit15 << 23) | ((this.blk < 6 ? (this.blk + 4) % 6 : 0) << 16);\\n    s |= this.state === IDLE ? 0 : ((this.remaining - 1) & 0xFFFF);\\n    return s >>> 0;\\n  }\\n  write(addr, v) {\\n    if ((addr & 4) === 0) { this.writeWord(v >>> 0); return; }\\n    if (v & 0x80000000) { const o = this.out; const e1 = this.onOutput; this.reset(); this.out = o; this.onOutput = e1; }\\n    this.dmaInEn = !!(v & 0x40000000); this.dmaOutEn = !!(v & 0x20000000);\\n  }\\n\\n  // palavra de comando ou de parâmetro (via CPU ou DMA0)\\n  writeWord(w) {\\n    if (this.state === IDLE) {\\n      const cmd = w >>> 29;\\n      if (cmd === 1) {\\n        this.depth = (w >>> 27) & 3; this.signed = (w >>> 26) & 1; this.bit15 = (w >>> 25) & 1; this.remaining = w & 0xFFFF;\\n        this.state = this.remaining ? DECODE : IDLE; this.blk = 0; this.hw = []; this.hwPos = 0;\\n      } else if (cmd === 2) { this.colorQ = !!(w & 1); this.remaining = this.colorQ ? 32 : 16; this.qbuf = []; this.state = QUANT; }\\n      else if (cmd === 3) { this.remaining = 32; this.sbuf = []; this.state = SCALE; }\\n      return;\\n    }\\n    if (this.state === QUANT) {\\n      this.qbuf.push(w & 255, (w >>> 8) & 255, (w >>> 16) & 255, w >>> 24);\\n      if (--this.remaining === 0) {\\n        this.qtY.set(this.qbuf.slice(0, 64));\\n        if (this.colorQ) this.qtC.set(this.qbuf.slice(64, 128)); else this.qtC.set(this.qtY);\\n        this.state = IDLE;\\n      }\\n    } else if (this.state === SCALE) {\\n      this.sbuf.push(((w & 0xFFFF) << 16) >> 16, (w >> 16));\\n      if (--this.remaining === 0) { this.scale.set(this.sbuf); this.state = IDLE; }\\n    } else {                                                          // DECODE\\n      this.hw.push(w & 0xFFFF, w >>> 16);\\n      if (this.hw.length > 8192) { this.hw = this.hw.slice(this.hwPos); this.hwPos = 0; }   // evita crescer sem limite\\n      this.decodeAvailable();\\n      if (--this.remaining === 0) {\\n        this.state = IDLE; this.hw = []; this.hwPos = 0;\\n        if (this.outWords() > 0) this.onOutput?.();\\n      }\\n    }\\n  }\\n\\n  dmaWrite(words) { for (let i = 0; i < words.length; i++) this.writeWord(words[i]); }\\n  /** retira n palavras da saída (as que faltarem vêm como zero) */\\n  dmaRead(n) {\\n    const o = new Uint32Array(n); let p = this.head;\\n    for (let i = 0; i < n && p + 4 <= this.tail; i++, p += 4) o[i] = (this.out[p] | (this.out[p + 1] << 8) | (this.out[p + 2] << 16) | (this.out[p + 3] << 24)) >>> 0;\\n    this.head = Math.min(this.tail, p); if (this.head === this.tail) this.head = this.tail = 0;\\n    return o;\\n  }\\n\\n  // ---------------- decodificação ----------------\\n  /** decodifica todos os blocos completos disponíveis na fila de halfwords */\\n  decodeAvailable() {\\n    const color = this.depth >= 2;\\n    for (;;) {\\n      const res = this.decodeBlock(color ? (this.blk < 2 ? this.qtC : this.qtY) : this.qtY, this.blocks[color ? this.blk : 0]);\\n      if (!res) return;\\n      if (!color) { this.emitMono(this.blocks[0]); continue; }\\n      if (++this.blk === 6) { this.blk = 0; this.emitColor(); }\\n    }\\n  }\\n\\n  /** lê 1 bloco (DC + ACs até EOB). Devolve false se faltarem halfwords (nada é consumido). */\\n  decodeBlock(qt, dst) {\\n    const hw = this.hw; let p = this.hwPos;\\n    while (p < hw.length && hw[p] === 0xFE00) p++;                   // preenchimento antes do bloco\\n    if (p >= hw.length) { this.hwPos = p; return false; }\\n    const first = hw[p++], qscale = first >>> 10, coef = this.coef; coef.fill(0);\\n    coef[0] = clamp(qscale === 0 ? sx10(first & 0x3FF) * 2 : sx10(first & 0x3FF) * qt[0], -1024, 1023);\\n    let k = 0, done = false;\\n    while (p < hw.length) {\\n      const h = hw[p++];\\n      if (h === 0xFE00) { done = true; break; }\\n      k += (h >>> 10) + 1;\\n      if (k > 63) { done = true; break; }\\n      { const n = sx10(h & 0x3FF), q = qscale === 0 ? n * 2 : (n * qt[k] * qscale + 4) >> 3; coef[ZIGZAG[k]] = q < -1024 ? -1024 : q > 1023 ? 1023 : q; }\\n      if (k === 63) { done = true; break; }\\n    }\\n    if (!done) return false;                                         // bloco incompleto: espera mais dados\\n    this.hwPos = p; this.idct(coef, dst); this.blocksDone++; return true;\\n  }\\n\\n  /** IDCT 2D inteira (2 passadas), resultado saturado em -128..127 */\\n  idct(src, dst) {\\n    const T = this.scale, tmp = this.tmp, nzz = this.nzz || (this.nzz = new Int32Array(8)), nzv = this.nzv || (this.nzv = new Int32Array(8));\\n    for (let pass = 0; pass < 2; pass++) {\\n      const s = pass === 0 ? src : tmp, d = pass === 0 ? tmp : dst;\\n      for (let y = 0; y < 8; y++) {\\n        let n = 0;                                                    // só os coeficientes não nulos da coluna entram na soma (resultado idêntico, bem menos multiplicações)\\n        for (let z = 0; z < 8; z++) { const v = s[y + z * 8]; if (v !== 0) { nzz[n] = z * 8; nzv[n++] = v; } }\\n        if (n === 0) { for (let x = 0; x < 8; x++) d[x + y * 8] = 0; continue; }\\n        for (let x = 0; x < 8; x++) {\\n          let sum = 0;\\n          for (let i = 0; i < n; i++) sum += nzv[i] * T[x + nzz[i]];\\n          d[x + y * 8] = pass === 0 ? sum >> 13 : Math.floor((sum + 0x4000) / 32768);   // medido contra o console real (ps1-tests/mdec/frame)\\n        }\\n      }\\n    }\\n    for (let i = 0; i < 64; i++) { const v = (dst[i] + 8) >> 4; dst[i] = v < -128 ? -128 : v > 127 ? 127 : v; }\\n  }\\n\\n  put(b) { if (this.tail < this.out.length) this.out[this.tail++] = b; }\\n\\n  emitMono(blk) {\\n    const off = this.signed ? 0 : 128;\\n    if (this.depth === 1) for (let i = 0; i < 64; i++) this.put((blk[i] + off) & 255);              // 8 bits\\n    else for (let i = 0; i < 64; i += 2) this.put((((blk[i] + off) & 255) >> 4) | ((((blk[i + 1] + off) & 255) >> 4) << 4));   // 4 bits\\n  }\\n\\n  emitColor() {\\n    const [cr, cb, y1, y2, y3, y4] = this.blocks, off = this.signed ? 0 : 128, b15 = this.bit15 << 15, ys = [y1, y2, y3, y4];\\n    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {\\n      const Y = ys[((y >> 3) << 1) | (x >> 3)][((y & 7) << 3) | (x & 7)], ci = ((y >> 1) << 3) | (x >> 1), Cr = cr[ci], Cb = cb[ci];\\n      const r = clamp(Y + ((359 * Cr + 128) >> 8), -128, 127), g = clamp(Y - ((88 * Cb + 183 * Cr + 128) >> 8), -128, 127), b = clamp(Y + ((454 * Cb + 128) >> 8), -128, 127);\\n      if (this.depth === 2) { this.put((r + off) & 255); this.put((g + off) & 255); this.put((b + off) & 255); }          // 24 bits\\n      else {                                                                                                          // 15 bits\\n        const q = v => Math.min(((v + off) & 255) + 4 >> 3, 31);   // 15 bits: arredonda (confirmado no console real)\\n        const px = q(r) | (q(g) << 5) | (q(b) << 10) | b15;\\n        this.put(px & 255); this.put(px >> 8);\\n      }\\n    }\\n  }\\n}\\n\\nreturn { defaultScaleTable, MDEC };\\n})();\\nconst __src_memcard = (() => {\\n// ============================================================================\\n//  Memory Card (128 KB = 1024 setores de 128 bytes = 16 blocos de 8 KB)\\n//   bloco 0 = diretório: frame 0 \\\"MC\\\" | frames 1..15 = entradas dos 15 blocos de dados |\\n//                        frames 16..35 = lista de setores ruins | 63 = cópia do frame 0\\n//  Formatos de arquivo aceitos: cru 128KB (.mcr/.mcd/.mc/.bin), VGS (+64 bytes \\\"VgsM\\\"),\\n//  DexDrive (+3904 bytes \\\"123-456-STD\\\"). Exporta sempre em formato cru (compatível com ePSXe/DuckStation).\\n// ============================================================================\\nconst CARD_SIZE = 131072, SECTOR = 128, SECTORS = 1024;\\n\\nconst xor127 = (b, o) => { let x = 0; for (let i = 0; i < 127; i++) x ^= b[o + i]; return x; };\\n\\nclass MemoryCard {\\n  constructor(bytes) {\\n    this.data = new Uint8Array(CARD_SIZE);\\n    this.flag = 0x08;                        // bit3 = \\\"diretório ainda não lido\\\" (cartão recém-inserido)\\n    this.dirty = false;                      // houve gravação desde o último export\\n    this.onWrite = null;                     // callback(sector) a cada setor gravado\\n    this.format();\\n    if (bytes) this.load(bytes);\\n  }\\n\\n  /** Cartão em branco, formatado como o hardware/BIOS faz */\\n  format() {\\n    const d = this.data; d.fill(0);\\n    d[0] = 0x4D; d[1] = 0x43; d[127] = xor127(d, 0);                       // frame 0: \\\"MC\\\"\\n    for (let i = 1; i <= 15; i++) {                                         // entradas livres\\n      const o = i * SECTOR; d[o] = 0xA0; d[o + 8] = 0xFF; d[o + 9] = 0xFF; d[o + 127] = xor127(d, o);\\n    }\\n    for (let i = 16; i <= 35; i++) {                                        // lista de setores ruins (vazia)\\n      const o = i * SECTOR; d.fill(0xFF, o, o + 4); d[o + 8] = 0xFF; d[o + 9] = 0xFF; d[o + 127] = xor127(d, o);\\n    }\\n    d.copyWithin(63 * SECTOR, 0, SECTOR);                                   // frame 63 = cópia do 0\\n    this.flag = 0x08; this.dirty = true;\\n  }\\n\\n  /** Carrega um arquivo de cartão (detecta o formato). Lança erro se inválido. */\\n  load(bytes) {\\n    let off = 0;\\n    const tag = String.fromCharCode(...bytes.subarray(0, 4));\\n    if (bytes.length === CARD_SIZE + 64 && tag === 'VgsM') off = 64;\\n    else if (bytes.length === CARD_SIZE + 3904 && String.fromCharCode(...bytes.subarray(0, 11)) === '123-456-STD') off = 3904;\\n    else if (bytes.length !== CARD_SIZE) throw new Error(`tamanho de cartão inválido: ${bytes.length} bytes (esperado ${CARD_SIZE})`);\\n    if (bytes[off] !== 0x4D || bytes[off + 1] !== 0x43) throw new Error('cartão sem assinatura \\\"MC\\\" (não formatado?)');\\n    this.data.set(bytes.subarray(off, off + CARD_SIZE));\\n    this.flag = 0x08; this.dirty = false;\\n    return this;\\n  }\\n\\n  /** Bytes crus para salvar em disco */\\n  export() { this.dirty = false; return this.data.slice(); }\\n\\n  // ---- acesso por setor (usado pelo protocolo) ----\\n  readSector(n) { return this.data.subarray(n * SECTOR, (n + 1) * SECTOR); }\\n  writeSector(n, buf) {\\n    this.data.set(buf.subarray(0, SECTOR), n * SECTOR);\\n    this.flag &= ~0x08; this.dirty = true; this.onWrite?.(n);\\n  }\\n\\n  /** Lista os saves do diretório (para a interface/depuração) */\\n  listSaves() {\\n    const d = this.data, out = [];\\n    const dec = (b) => { try { return new TextDecoder('shift_jis').decode(b).replace(/\\\\0.*$/s, '').trim(); } catch { return ''; } };\\n    for (let i = 1; i <= 15; i++) {\\n      const o = i * SECTOR, st = d[o];\\n      if (st !== 0x51) continue;                                           // 0x51 = primeiro bloco de um save\\n      const size = (d[o + 4] | (d[o + 5] << 8) | (d[o + 6] << 16)) >>> 0;\\n      const code = String.fromCharCode(...d.subarray(o + 10, o + 31)).replace(/\\\\0.*$/s, '');\\n      const blk = i * 8192, hdr = d.subarray(blk, blk + 128);\\n      out.push({ slot: i, code, blocks: Math.max(1, size / 8192 | 0), title: hdr[0] === 0x53 && hdr[1] === 0x43 ? dec(hdr.subarray(4, 68)) : '',\\n                 ok: xor127(d, o) === d[o + 127] });\\n    }\\n    return out;\\n  }\\n  freeBlocks() { let n = 0; for (let i = 1; i <= 15; i++) if (this.data[i * SECTOR] === 0xA0 || this.data[i * SECTOR] === 0xA1 ||\\n                                                              this.data[i * SECTOR] === 0xA2 || this.data[i * SECTOR] === 0xA3) n++; return n; }\\n}\\n\\nreturn { CARD_SIZE, MemoryCard };\\n})();\\nconst __src_sio = (() => {\\n// ============================================================================\\n//  SIO0 (porta de controles / memory cards)  0x1F801040-0x1F80104F\\n//   +0 DATA  +4 STAT  +8 MODE  +A CTRL  +E BAUD\\n//  Emula: controle digital (ID 0x41) na porta 1; porta 2 e memory cards desconectados.\\n// ============================================================================\\nconst BUTTONS = { select: 0, l3: 1, r3: 2, start: 3, up: 4, right: 5, down: 6, left: 7,\\n                         l2: 8, r2: 9, l1: 10, r1: 11, triangle: 12, circle: 13, cross: 14, square: 15 };\\n\\n//  Controles: 'digital' (ID 0x41) ou 'dualshock' (começa digital; o jogo entra em modo de configuração (0x43),\\n//  liga o modo analógico (0x44) e passa a receber ID 0x73 com os 4 eixos; vibração via mapeamento 0x4D).\\nconst STICKS = { rx: 0, ry: 1, lx: 2, ly: 3 };\\n\\nclass SIO {\\n  constructor(sys) {\\n    this.sys = sys; this.padConnected = [true, false]; this.cards = [null, null]; this.buttons = [0xFFFF, 0xFFFF];\\n    this.padType = ['digital', 'digital'];                                  // configuração (não faz parte do save state)\\n    this.sticks = [[0x80, 0x80, 0x80, 0x80], [0x80, 0x80, 0x80, 0x80]];     // rx, ry, lx, ly (0..255, centro 0x80)\\n    this.onRumble = null;                                                   // (porta, pequeno 0/1, grande 0..255)\\n    this.reset();\\n  }\\n  newPad() { return { analog: false, lock: false, config: false, map: [0x00, 0x01, 0xFF, 0xFF, 0xFF, 0xFF], small: 0, large: 0, cmd: 0, n: 0, pend: null }; }\\n  /** troca o tipo do controle da porta: 'digital' | 'dualshock' */\\n  setPadType(port, type) { this.padType[port] = type; this.pads[port] = this.newPad(); }\\n  /** eixo analógico 0..255 (0x80 = centro): 'lx' | 'ly' | 'rx' | 'ry' */\\n  setStick(name, value, port = 0) { this.sticks[port][STICKS[name]] = Math.max(0, Math.min(255, Math.round(value))); }\\n  /** botão ANALOG do controle: liga/desliga o modo (se o jogo não o travou) */\\n  toggleAnalog(port = 0) { const p = this.pads[port]; if (this.padType[port] === 'dualshock' && !p.lock) p.analog = !p.analog; return p.analog; }\\n  reset() {\\n    this.pads = [this.newPad(), this.newPad()];\\n    this.stat = 0x5; this.mode = 0; this.ctrl = 0; this.baud = 0; this.rx = 0xFF; this.rxValid = false;\\n    this.state = 0; this.dev = null; this.busyEvt = null; this.mc = null;\\n  }\\n  /** pressiona/solta um botão (bits em nível baixo = pressionado) */\\n  setButton(name, pressed, port = 0) {\\n    const b = 1 << BUTTONS[name]; this.buttons[port] = pressed ? (this.buttons[port] & ~b) : (this.buttons[port] | b);\\n  }\\n\\n  read(addr, size) {\\n    switch (addr & 0xF) {\\n      case 0: { const v = this.rx; this.rxValid = false; this.stat &= ~2; return v; }\\n      case 4: return this.stat >>> 0;\\n      case 8: return this.mode;\\n      case 0xA: return this.ctrl;\\n      case 0xE: return this.baud;\\n    }\\n    return 0;\\n  }\\n  write(addr, size, v) {\\n    switch (addr & 0xF) {\\n      case 0: this.tx(v & 0xFF); break;\\n      case 8: this.mode = v & 0xFFFF; break;\\n      case 0xA: {\\n        this.ctrl = v & 0xFFFF;\\n        if (v & 0x10) this.stat &= ~0x200;                           // ACK: limpa flag de IRQ\\n        if (v & 0x40) { const c = this.ctrl; this.reset(); this.ctrl = 0; }   // reset\\n        if (!(v & 2)) { this.state = 0; this.dev = null; this.mc = null; }   // /JOY desmarcado: fim da transação\\n        break;\\n      }\\n      case 0xE: this.baud = v & 0xFFFF; break;\\n    }\\n  }\\n\\n  tx(byte) {\\n    if (!(this.ctrl & 1)) return;                                    // TXEN desligado\\n    this.stat &= ~0x5;                                               // TX ocupado\\n    const factor = [1, 1, 16, 64][this.mode & 3], cyc = Math.max(8 * (this.baud || 0x88) * factor, 200);\\n    this.sys.sched.call(this.sys.now() + cyc, 'sio', 'txDone', [byte]);\\n  }\\n  txDone(byte) {\\n    const [resp, ack] = this.exchange(byte);\\n    this.rx = resp; this.rxValid = true; this.stat |= 0x2 | 0x5;\\n    if (ack) { this.stat |= 0x80; this.sys.sched.call(this.sys.now() + 100, 'sio', 'ackIrq', []); }   // DSR\\n  }\\n  ackIrq() {\\n    this.stat |= 0x200; if (this.ctrl & 0x1000) this.sys.irq(7);\\n    this.sys.sched.call(this.sys.now() + 60, 'sio', 'dsrOff', []);\\n  }\\n  dsrOff() { this.stat &= ~0x80; }\\n\\n  /** protocolo: devolve [byte de resposta, ack?] */\\n  exchange(b) {\\n    const port = (this.ctrl >> 13) & 1;\\n    if (this.state === 0) {                                          // 1º byte = endereço do dispositivo\\n      if (b === 0x01 && this.padConnected[port]) { this.dev = 'pad'; this.state = 1; return [0xFF, true]; }\\n      if (b === 0x81 && this.cards[port]) { this.dev = 'mc'; this.state = 1; this.mc = { k: 1, cmd: 0, msb: 0, lsb: 0, sector: 0, buf: new Uint8Array(128), chk: 0, bad: false }; return [0xFF, true]; }\\n      this.dev = null; this.state = -1; return [0xFF, false];        // porta vazia / memory card ausente: sem ACK\\n    }\\n    if (this.dev === 'pad') return this.exchangePad(b, port);\\n    if (this.dev === 'mc') return this.exchangeMC(b, this.cards[port]);\\n    return [0xFF, false];\\n  }\\n\\n  /** controle: byte 1 = comando, 2 = 0x5A, depois dados. Devolve [byte, ack] */\\n  exchangePad(b, port) {\\n    const pad = this.pads[port], btn = this.buttons[port], s = this.state++;\\n    const dual = this.padType[port] === 'dualshock';\\n    if (s === 1) {\\n      pad.cmd = dual ? b : 0x42; pad.n = 0; pad.pend = null;\\n      const id = !dual ? 0x41 : pad.config ? 0xF3 : pad.analog ? 0x73 : 0x41;\\n      pad.len = (id & 0xF) * 2; return [id, true];\\n    }\\n    if (s === 2) return [0x5A, true];\\n    const i = s - 3, last = i === pad.len - 1;\\n    if (i >= pad.len) return [0xFF, false];\\n    const sticks = this.sticks[port], withSticks = pad.analog || pad.config;\\n    let out = 0;\\n    switch (pad.cmd) {\\n      case 0x42: case 0x43: {\\n        out = i === 0 ? btn & 0xFF : i === 1 ? btn >> 8 : (withSticks ? sticks[i - 2] : 0xFF);\\n        if (pad.cmd === 0x42) {                                       // vibração: mapa 4D define que byte aciona qual motor\\n          if (pad.map[i] === 0) pad.small = b & 1; else if (pad.map[i] === 1) pad.large = b;\\n        } else if (i === 0) pad.pend = b === 1;                       // 0x43: 1 entra / 0 sai do modo de configuração\\n        break;\\n      }\\n      case 0x44: out = 0; if (i === 0) pad.pend = b === 1; else if (i === 1) pad.lock = b === 3; break;\\n      case 0x45: out = [0x01, 0x02, pad.analog ? 1 : 0, 0x02, 0x01, 0x00][i]; break;\\n      case 0x46: out = (b === 1 ? [0x00, 0x01, 0x01, 0x01, 0x14, 0x00] : [0x00, 0x01, 0x02, 0x00, 0x0A, 0x00])[i]; if (i === 0) pad.sel = b; break;\\n      case 0x47: out = [0x00, 0x00, 0x02, 0x00, 0x01, 0x00][i]; break;\\n      case 0x4C: out = [0x00, 0x00, 0x00, 0x04, 0x00, 0x00][i]; break;\\n      case 0x4D: out = pad.map[i]; if (!pad.pend) pad.pend = []; pad.pend[i] = b; break;\\n      default: out = 0;\\n    }\\n    if (pad.cmd === 0x46 && i > 0) out = ((pad.sel === 1) ? [0x00, 0x01, 0x01, 0x01, 0x14, 0x00] : [0x00, 0x01, 0x02, 0x00, 0x0A, 0x00])[i];\\n    if (last) this.padEnd(port, pad);\\n    return [out, !last];\\n  }\\n  /** fim da transação: efetiva mudanças de modo/mapa e avisa a vibração */\\n  padEnd(port, pad) {\\n    if (pad.cmd === 0x43 && typeof pad.pend === 'boolean') pad.config = pad.pend;\\n    else if (pad.cmd === 0x44 && typeof pad.pend === 'boolean') pad.analog = pad.pend;\\n    else if (pad.cmd === 0x4D && Array.isArray(pad.pend)) pad.map = [0, 1, 2, 3, 4, 5].map(k => pad.pend[k] ?? 0xFF);\\n    pad.pend = null;\\n    const key = pad.small | (pad.large << 1);\\n    if (key !== pad.sent) { pad.sent = key; this.onRumble?.(port, pad.small, pad.large); }\\n  }\\n\\n  /**\\n   * Protocolo do Memory Card (byte 0 = 0x81 já tratado). k = índice do byte na transação.\\n   *  Leitura 'R'(52): FLAG 5A 5D 00 MSB 5C 5D MSB LSB [128 dados] CHK 47\\n   *  Escrita 'W'(57): FLAG 5A 5D 00 MSB [eco...] CHK 5C 5D END(47 ok | 4E checksum | FF setor ruim)\\n   *  GetID   'S'(53): FLAG 5A 5D 5C 5D 04 00 00 80\\n   * Todos os bytes têm ACK, exceto o último da transação.\\n   */\\n  exchangeMC(b, card) {\\n    const m = this.mc, k = m.k++, A = true, END = false;\\n    if (k === 1) {\\n      m.cmd = b;\\n      if (b === 0x52 || b === 0x57 || b === 0x53) return [card.flag, A];\\n      this.dev = null; this.state = -1; return [0xFF, END];            // comando desconhecido\\n    }\\n    if (m.cmd === 0x53) {                                              // GetID\\n      const r = { 2: 0x5A, 3: 0x5D, 4: 0x5C, 5: 0x5D, 6: 0x04, 7: 0x00, 8: 0x00, 9: 0x80 }[k];\\n      return r === undefined ? [0xFF, END] : [r, k < 9];\\n    }\\n    if (k === 2) return [0x5A, A];\\n    if (k === 3) return [0x5D, A];\\n    if (k === 4) { m.msb = b; return [0x00, A]; }\\n    if (k === 5) { m.lsb = b; m.sector = (m.msb << 8) | m.lsb; m.bad = m.sector >= 1024; return [m.msb, A]; }\\n\\n    if (m.cmd === 0x52) {                                              // ---- leitura ----\\n      if (k === 6) return [0x5C, A];\\n      if (k === 7) return [0x5D, A];\\n      if (k === 8) return [m.bad ? 0xFF : m.msb, A];\\n      if (k === 9) return [m.bad ? 0xFF : m.lsb, !m.bad];             // setor inválido: encerra sem dados\\n      if (m.bad) return [0xFF, END];\\n      if (k === 10) { m.buf.set(card.readSector(m.sector)); m.chk = m.msb ^ m.lsb; }\\n      if (k >= 10 && k < 138) { const v = m.buf[k - 10]; m.chk ^= v; return [v, A]; }\\n      if (k === 138) return [m.chk, A];\\n      if (k === 139) return [0x47, END];\\n      return [0xFF, END];\\n    }\\n    // ---- escrita ----\\n    if (k >= 6 && k < 134) { const i = k - 6; m.buf[i] = b; return [i === 0 ? m.lsb : m.buf[i - 1], A]; }\\n    if (k === 134) { m.chk = b; return [m.buf[127], A]; }\\n    if (k === 135) return [0x5C, A];\\n    if (k === 136) return [0x5D, A];\\n    if (k === 137) {\\n      let want = m.msb ^ m.lsb; for (let i = 0; i < 128; i++) want ^= m.buf[i];\\n      let end = 0x47;\\n      if (m.bad) end = 0xFF; else if (want !== m.chk) end = 0x4E; else card.writeSector(m.sector, m.buf);\\n      return [end, END];\\n    }\\n    return [0xFF, END];\\n  }\\n}\\n\\nreturn { BUTTONS, STICKS, SIO };\\n})();\\nconst __src_cdrom = (() => {\\n// ============================================================================\\n//  Controlador de CD-ROM  0x1F801800-0x1F801803  (4 registradores com \\\"index\\\" 0..3)\\n//   0x1800 R: status   W: index\\n//   0x1801 R: resposta W: comando(idx0)\\n//   0x1802 R: dados    W: parâmetro(idx0) / enable de INT(idx1)\\n//   0x1803 R: enable(idx0,2) / flags(idx1,3)   W: request(idx0) / ack(idx1)\\n//  INT1 dado pronto | INT2 completo | INT3 ack | INT4 fim de dados | INT5 erro  -> IRQ2\\n//  Inclui decodificação XA-ADPCM (4 bits) enviada ao mixer do SPU.\\n// ============================================================================\\nconst { lbaToMsf, msfToLba } = __src_disc;\\nconst bcd = v => ((v / 10 | 0) << 4) | (v % 10);\\nconst CMD_DELAY = 25000;                    // ciclos até a 1ª resposta\\n// medidos no console real (ps1-tests/cdrom/timing; média de 'Remaining Sectors' em ciclos) — ~0,7% mais rápido que 33868800/75\\nconst SECTOR_1X = 448342, SECTOR_2X = 223825;\\nconst XA_POS = [0, 60, 115, 98], XA_NEG = [0, 0, -52, -55];\\nconst sat16 = v => v > 32767 ? 32767 : v < -32768 ? -32768 : v;\\n\\nclass CDROM {\\n  constructor(sys) { this.sys = sys; this.disc = null; this.spu = null; this.regionOverride = 'SCEA'; this.log = null; this.reset(); }\\n\\n  reset() {\\n    this.index = 0; this.param = []; this.resp = []; this.intEnable = 0; this.intFlag = 0; this.queue = [];\\n    this.mode = 0; this.busy = false; this.reading = false; this.seeking = false; this.playing = false;\\n    this.pos = 0; this.seekLba = 0; this.hasSetloc = false; this.filterFile = 0; this.filterChan = 0;\\n    this.data = null; this.dpos = 0; this.sector = null; this.readEvt = null; this.lastHdr = new Uint8Array(8);\\n    this.xaOld = [[0, 0], [0, 0]]; this.xaPhase = 0; this.motor = !!this.disc; this.sectorsRead = 0;\\n    this.muted = false; this.lid = false; this.shellFlag = false; this.playCount = 0; this.reportAlt = 0; this.peak = 0;\\n  }\\n  setDisc(d) { this.disc = d; this.motor = !!d; }\\n\\n  // ---------------- tampa / troca de disco ----------------\\n  /** abre a tampa: para tudo; Getstat passa a mostrar \\\"shell open\\\" (bit 4) */\\n  openLid() { this.stopRead(); this.lid = true; this.motor = false; }\\n  /** fecha a tampa com outro disco (ou nenhum); o 1º Getstat depois reporta o bit 4 uma vez, como o hardware */\\n  closeLid(disc) { this.disc = disc || null; this.lid = false; this.shellFlag = true; this.motor = !!disc; this.hasSetloc = false; this.pos = 0; }\\n\\n  // ---------------- trilhas / TOC ----------------\\n  tocTracks() { return (this.disc && this.disc.tracks) || [{ n: 1, type: 'data', start: 0 }]; }\\n  trackAt(lba) { const t = this.tocTracks(); for (let i = t.length - 1; i >= 0; i--) if (lba >= (t[i].pre ?? t[i].start)) return t[i]; return t[0]; }\\n  total() { return this.disc ? this.disc.sectorCount : 0; }\\n\\n  stat() {\\n    let s = 0;\\n    if (!this.disc || this.lid || this.shellFlag) s |= 0x10; if (this.disc && this.motor) s |= 0x02;\\n    if (this.reading) s |= 0x20; if (this.seeking) s |= 0x40; if (this.playing) s |= 0x80;\\n    return s;\\n  }\\n\\n  // ---------------- registradores ----------------\\n  read(addr, size) {\\n    switch (addr & 3) {\\n      case 0: return this.index | ((this.data && this.dpos < this.data.length) ? 0x40 : 0) | (this.param.length === 0 ? 0x08 : 0) |\\n                     (this.param.length < 16 ? 0x10 : 0) | (this.resp.length ? 0x20 : 0) | (this.busy ? 0x80 : 0);\\n      case 1: return this.resp.length ? this.resp.shift() : 0;\\n      case 2: { let v = 0; for (let i = 0; i < size; i++) v |= this.readData() << (8 * i); return v >>> 0; }\\n      case 3: return ((this.index & 1) ? this.intFlag : this.intEnable) | 0xE0;\\n    }\\n  }\\n  write(addr, size, v) {\\n    v &= 0xFF;\\n    switch (addr & 3) {\\n      case 0: this.index = v & 3; return;\\n      case 1: if (this.index === 0) this.command(v); return;\\n      case 2:\\n        if (this.index === 0) { if (this.param.length < 16) this.param.push(v); }\\n        else if (this.index === 1) { this.intEnable = v & 0x1F; if (this.intFlag & this.intEnable) this.sys.irq(2); }\\n        return;\\n      case 3:\\n        if (this.index === 0) { if (v & 0x80) { if (this.sector && !(this.data && this.dpos < this.data.length)) { this.data = this.sector; this.dpos = 0; } } else this.data = null; }\\n        else if (this.index === 1) this.ack(v);\\n        return;\\n    }\\n  }\\n\\n  readData() {\\n    if (!this.data || this.dpos >= this.data.length) return 0;\\n    const b = this.data[this.dpos++]; if (this.dpos >= this.data.length) this.data = null; return b;\\n  }\\n  dmaRead(words) {\\n    const o = new Uint32Array(words);\\n    for (let i = 0; i < words; i++) o[i] = (this.readData() | (this.readData() << 8) | (this.readData() << 16) | (this.readData() << 24)) >>> 0;\\n    return o;\\n  }\\n\\n  // ---------------- interrupções ----------------\\n  respond(type, resp, delay, clearBusy) {\\n    this.sys.sched.call(this.sys.now() + delay, 'cdrom', 'fire', [type, resp, !!clearBusy]);\\n  }\\n  /** resposta atrasada: `resp` é um vetor de bytes fixo ou uma especificação ['S', ...extras] / ['GS'] / ['PARAM'] / ['LOCL'] / ['MON'] / ['MOFF'] / ['SEEK'] resolvida na entrega */\\n  fire(type, resp, clearBusy) { if (clearBusy) this.busy = false; this.deliver(type, this.mkResp(resp)); }\\n  mkResp(r) {\\n    if (typeof r[0] === 'number' || r.length === 0) return r;\\n    switch (r[0]) {\\n      case 'S': return [this.stat(), ...r.slice(1)];\\n      case 'GS': { const st = this.stat(); this.shellFlag = false; return [st]; }\\n      case 'PARAM': return [this.stat(), this.mode, 0, this.filterFile, this.filterChan];\\n      case 'LOCL': return [...this.lastHdr];\\n      case 'MON': this.motor = !!this.disc; return [this.stat()];\\n      case 'MOFF': this.motor = false; return [this.stat()];\\n      case 'SEEK': if (this.hasSetloc) { this.pos = this.seekLba; this.hasSetloc = false; } return [this.stat()];\\n    }\\n    throw new Error('resposta CD desconhecida ' + r[0]);\\n  }\\n  deliver(type, resp) {\\n    if (this.intFlag !== 0) { this.queue.push({ type, resp }); return; }\\n    this.intFlag = type; this.resp = resp.slice();\\n    this.log?.(`INT${type} [${resp.map(b => b.toString(16)).join(' ')}]`);\\n    if (this.intEnable & type) this.sys.irq(2);\\n  }\\n  ack(v) {\\n    this.intFlag &= ~(v & 0x1F);\\n    if (v & 0x40) this.param.length = 0;\\n    if (this.intFlag === 0 && this.queue.length) {\\n      const q = this.queue.shift(); this.sys.sched.call(this.sys.now() + 500, 'cdrom', 'deliver', [q.type, q.resp]);\\n    }\\n  }\\n\\n  // ---------------- comandos ----------------\\n  command(c) {\\n    const p = this.param; this.param = []; this.busy = true; this.resp = [];\\n    this.log?.(`CMD ${c.toString(16)} (${p.map(b => b.toString(16)).join(' ')})`);\\n    const first = (resp, d = CMD_DELAY) => this.respond(3, resp, d, true);\\n    const second = (resp, d) => this.respond(2, resp, d, false);\\n    const err = (code, d = CMD_DELAY) => this.respond(5, [this.stat() | 1, code], d, true);\\n\\n    switch (c) {\\n      case 0x01: first(['GS']); break;   // Getstat\\n      case 0x02:                                                                       // Setloc\\n        if (p.length < 3) return err(0x20);\\n        this.seekLba = msfToLba(p[0], p[1], p[2]); this.hasSetloc = true; first(['S']); break;\\n      case 0x06: case 0x1B: {                                                          // ReadN / ReadS\\n        if (!this.disc) return err(0x80);\\n        this.stopRead(); this.reading = true; this.seeking = false;\\n        let delay = 0;\\n        if (this.hasSetloc) { this.pos = this.seekLba; this.hasSetloc = false; delay = (this.mode & 0x80) ? 667000 : 362000; }   // 1º setor medido no console: ~784k (1x) / ~865k (2x)\\n        first(['S']);\\n        this.readEvt = this.sys.sched.call(this.sys.now() + delay + this.interval(), 'cdrom', 'readSector');\\n        break;\\n      }\\n      case 0x07: first(['S']); second(['MON'], 100000); break;   // MotorOn\\n      case 0x08: { first(['S']); this.stopRead(); second(['MOFF'], 200000); break; }  // Stop\\n      case 0x09: { const s = this.stat(), was = this.reading || this.playing; this.stopRead(); first([s]); second(['S'], was ? ((this.mode & 0x80) ? 1062000 : 1038000) : 150000); break; }  // Pause (lendo: ~1,0M ciclos no console)\\n      case 0x0A: {                                                                      // Init\\n        this.stopRead(); this.mode = 0; this.hasSetloc = false;\\n        first(['S']); second(['MON'], 502000); break;                                 // Init completo: ~476k em média no console\\n      }\\n      case 0x0B: this.muted = true; first(['S']); break;                  // Mute\\n      case 0x0C: this.muted = false; first(['S']); break;                 // Demute\\n      case 0x0D: this.filterFile = p[0] | 0; this.filterChan = p[1] | 0; first(['S']); break;   // Setfilter\\n      case 0x0E: this.mode = p[0] | 0; first(['S']); break;               // Setmode\\n      case 0x0F: first(['PARAM']); break;           // Getparam\\n      case 0x10: first(['LOCL']); break;                                 // GetlocL\\n      case 0x11: {                                                                      // GetlocP\\n        const lba = Math.max(0, this.pos - (this.playing ? 0 : 1)), t = this.trackAt(lba), a = lbaToMsf(lba);\\n        const idx = lba >= t.start ? 1 : 0, rel = idx ? lba - t.start : t.start - lba;\\n        first([bcd(t.n), idx, bcd(rel / 4500 | 0), bcd((rel / 75 | 0) % 60), bcd(rel % 75), a.m, a.s, a.f]); break;\\n      }\\n      case 0x13: { const tr = this.tocTracks(); first(['S', bcd(tr[0].n), bcd(tr[tr.length - 1].n)]); break; }   // GetTN\\n      case 0x14: {                                                                      // GetTD\\n        const t = (p[0] >> 4) * 10 + (p[0] & 15), tr = this.tocTracks();\\n        if (t === 0) { const m = lbaToMsf(this.total()); first(['S', m.m, m.s]); }\\n        else { const e = tr.find(x => x.n === t); if (e) { const m = lbaToMsf(e.start); first(['S', m.m, m.s]); } else err(0x10); }\\n        break;\\n      }\\n      case 0x15: case 0x16: {                                                           // SeekL / SeekP\\n        first(['S']); second(['SEEK'], 100000); break;\\n      }\\n      case 0x19:                                                                        // Test\\n        if (p[0] === 0x20) first([0x94, 0x09, 0x19, 0xC0]); else first(['S']); break;\\n      case 0x1A:                                                                        // GetID\\n        first(['S']);\\n        if (!this.disc) this.respond(5, [0x08, 0x40, 0, 0, 0, 0, 0, 0], 50000, false);\\n        else {\\n          const reg = this.regionOverride || this.disc.region(), L = reg.charCodeAt(3) || 0x41;\\n          this.respond(2, ['S', 0x00, 0x20, 0x00, 0x53, 0x43, 0x45, L], 50000, false);\\n        }\\n        break;\\n      case 0x12: case 0x1E: case 0x1C: first(['S']); second(['S'], 400000); break;   // SetSession / ReadTOC / Reset\\n      case 0x03: {                                                                      // Play (CD-DA)\\n        if (!this.disc) return err(0x80);\\n        this.stopRead();\\n        const t = p.length && p[0] ? this.tocTracks().find(x => x.n === ((p[0] >> 4) * 10 + (p[0] & 15))) : null;\\n        let delay = 0;\\n        if (t) { this.pos = t.start; this.hasSetloc = false; delay = 100000; }\\n        else if (this.hasSetloc) { this.pos = this.seekLba; this.hasSetloc = false; delay = 100000; }\\n        this.playing = true; this.playCount = 0; this.reportAlt = 0;\\n        first(['S']);\\n        this.readEvt = this.sys.sched.call(this.sys.now() + delay + this.interval(), 'cdrom', 'playSector');\\n        break;\\n      }\\n      case 0x04: case 0x05: first(['S']); break;                          // Forward/Backward (busca rápida: ignorada)\\n      default: err(0x40);                                                               // comando inválido\\n    }\\n  }\\n\\n  interval() { return (this.mode & 0x80) ? SECTOR_2X : SECTOR_1X; }\\n  stopRead() { this.reading = false; this.seeking = false; this.playing = false; if (this.readEvt) { this.sys.sched.cancel(this.readEvt); this.readEvt = null; } }\\n\\n  readSector() {\\n    this.readEvt = null; if (!this.reading || !this.disc) return;\\n    // hardware: não avança p/ o próximo setor enquanto houver interrupção pendente (evita sobrescrever o buffer)\\n    if (this.intFlag !== 0 || this.queue.length) { this.readEvt = this.sys.sched.call(this.sys.now() + 1500, 'cdrom', 'readSector'); return; }\\n    const lba = this.pos, sec = this.disc.readSector(lba);\\n    if (!sec) { this.reading = false; this.deliver(4, [this.stat()]); return; }\\n    const raw = this.disc.raw, info = raw ? this.disc.sectorInfo(lba) : null;\\n    this.lastHdr = raw ? sec.slice(12, 20) : Uint8Array.from([...Object.values(lbaToMsf(lba)), 1, 0, 0, 0, 0]);\\n    this.sectorsRead++;\\n    if (info && (this.mode & 0x40) && info.audio && info.form2) {                     // XA-ADPCM: toca em vez de entregar\\n      if (!(this.mode & 0x08) || (info.file === this.filterFile && info.channel === this.filterChan)) this.decodeXA(sec, info.coding);\\n    } else {\\n      this.sector = raw ? ((this.mode & 0x20) ? sec.slice(12, 12 + 0x924) : sec.slice(24, 24 + 0x800)) : sec.slice(0);\\n      this.deliver(1, [this.stat()]);\\n    }\\n    this.pos++;\\n    this.readEvt = this.sys.sched.call(this.sys.now() + this.interval(), 'cdrom', 'readSector');\\n  }\\n\\n  // ---------------- CD-DA ----------------\\n  playSector() {\\n    this.readEvt = null; if (!this.playing || !this.disc) return;\\n    const lba = this.pos;\\n    if (lba >= this.total()) { this.playing = false; this.deliver(4, [this.stat()]); return; }\\n    const t = this.trackAt(lba), sec = this.disc.readSector(lba);\\n    let pk = 0;\\n    if (t.type === 'audio' && sec && sec.length >= 2352) {\\n      for (let i = 0; i < 588; i++) {\\n        const o = i * 4, l = (sec[o] | (sec[o + 1] << 8)) << 16 >> 16, r = (sec[o + 2] | (sec[o + 3] << 8)) << 16 >> 16;\\n        if (!this.muted && this.spu) this.spu.pushCd(l, r);\\n        const a = l < 0 ? -l : l, b = r < 0 ? -r : r; if (a > pk) pk = a; if (b > pk) pk = b;\\n      }\\n    }\\n    // relatório (mode bit 2): a cada 10 setores alterna tempo relativo/absoluto\\n    if ((this.mode & 0x04) && (this.playCount++ % 10) === 0 && this.intFlag === 0 && !this.queue.length) {\\n      const a = lbaToMsf(lba), idx = lba >= t.start ? 1 : 0, rel = idx ? lba - t.start : t.start - lba;\\n      this.reportAlt ^= 1;\\n      const mm = this.reportAlt ? bcd(rel / 4500 | 0) : a.m, ss = this.reportAlt ? (bcd((rel / 75 | 0) % 60) | 0x80) : a.s, ff = this.reportAlt ? bcd(rel % 75) : a.f;\\n      this.deliver(1, [this.stat(), bcd(t.n), idx, mm, ss, ff, pk & 0xFF, pk >> 8]);\\n    }\\n    this.pos++;\\n    if (((this.mode & 0x02) && this.pos >= t.end) || this.pos >= this.total()) {       // AutoPause / fim do disco\\n      this.playing = false; this.deliver(4, [this.stat()]); return;\\n    }\\n    this.readEvt = this.sys.sched.call(this.sys.now() + this.interval(), 'cdrom', 'playSector');\\n  }\\n\\n  // ---------------- XA-ADPCM ----------------\\n  decodeXA(sec, coding) {\\n    if (!this.spu || (coding & 0x10)) return;                                          // 8 bits: TODO\\n    const stereo = !!(coding & 1), ratio = ((coding & 4) ? 18900 : 37800) / 44100;\\n    const L = [], R = [];\\n    for (let g = 0; g < 18; g++) {\\n      const base = 24 + g * 128, units = [];\\n      for (let i = 0; i < 8; i++) {\\n        const hdr = sec[base + (i < 4 ? i : i + 4)], range = hdr & 15, filt = (hdr >> 4) & 3, shift = range > 12 ? 9 : range;\\n        const old = this.xaOld[stereo ? (i & 1) : 0], out = new Int16Array(28);\\n        for (let w = 0; w < 28; w++) {\\n          const byte = sec[base + 16 + w * 4 + (i >> 1)], nib = (i & 1) ? byte >> 4 : byte & 15;\\n          let s = (((nib << 12) << 16) >> 16) >> shift;\\n          s = sat16(s + ((old[0] * XA_POS[filt] + old[1] * XA_NEG[filt] + 32) >> 6));\\n          old[1] = old[0]; old[0] = s; out[w] = s;\\n        }\\n        units.push(out);\\n      }\\n      if (stereo) for (let q = 0; q < 4; q++) for (let k = 0; k < 28; k++) { L.push(units[2 * q][k]); R.push(units[2 * q + 1][k]); }\\n      else for (let i = 0; i < 8; i++) for (let k = 0; k < 28; k++) { L.push(units[i][k]); R.push(units[i][k]); }\\n    }\\n    const n = L.length; let t = this.xaPhase;                                           // reamostra p/ 44.1kHz (linear)\\n    while (t < n - 1) {\\n      const i = t | 0, f = t - i;\\n      if (!this.muted) this.spu.pushCd((L[i] + (L[i + 1] - L[i]) * f) | 0, (R[i] + (R[i + 1] - R[i]) * f) | 0);\\n      t += ratio;\\n    }\\n    this.xaPhase = t - (n - 1);\\n  }\\n}\\n\\nreturn { CDROM };\\n})();\\nconst __src_state = (() => {\\n// ============================================================================\\n//  Save states: serialização genérica do estado do PSX\\n//   Container: \\\"PS1S\\\" | versão u32 | tamanho do cabeçalho u32 | cabeçalho JSON | blobs binários\\n//   Os arrays tipados (RAM, VRAM, RAM do SPU...) vão no blob sem os zeros finais; o resto, em JSON.\\n//   Não entram: disco, BIOS, entradas (botões), memory cards (têm persistência própria), caches do JIT\\n//   e do renderizador (reconstruídos ao restaurar), áudio já gerado.\\n// ============================================================================\\nconst STATE_VERSION = 1;\\nconst MAGIC = 0x53315350;                                  // \\\"PS1S\\\" (little endian)\\nconst TYPES = { Int8Array, Uint8Array, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array };\\n\\n// propriedades que nunca são salvas (referências cruzadas, callbacks, configuração, entradas)\\nconst SKIP = new Set(['sys', 'bus', 'dev', 'disc', 'spu', 'gpu', 'dma', 'timers', 'sio', 'cdrom', 'mdec', 'hw', 'log', 'logIo', 'ioStats', 'unmapped',\\n  'cards', 'buttons', 'padConnected', 'padType', 'sticks', 'onRumble', 'clock', 'regionOverride', 'bios', 'biosView', 'codeFlags', 'jit', 'deint']);\\nconst COMPONENTS = ['cpu', 'bus', 'gpu', 'spu', 'dma', 'timers', 'sio', 'cdrom', 'mdec'];\\nconst PSX_FIELDS = ['audioLen', 'lastTick', 'timerAt', 'nextTick', 'lineAcc', 'line', 'audioAcc', 'frameDone', 'frames', 'useJit'];\\n\\nclass Writer { constructor() { this.bufs = []; this.size = 0; }\\n  add(u8) { let n = u8.length; while (n > 0 && u8[n - 1] === 0) n--; const off = this.size; this.bufs.push(u8.subarray(0, n)); this.size += n; return [off, n]; } }\\n\\nfunction enc(v, w, depth = 0) {\\n  if (depth > 12) throw new Error('estrutura profunda demais no save state');\\n  if (v === null || typeof v === 'boolean' || typeof v === 'string') return v;\\n  if (typeof v === 'number') return Number.isFinite(v) ? v : { $n: String(v) };\\n  if (v === undefined) return { $u: 1 };\\n  if (typeof v === 'function' || v instanceof Map || v instanceof DataView) return undefined;\\n  if (ArrayBuffer.isView(v)) {\\n    const name = v.constructor.name; if (!TYPES[name]) throw new Error('tipo não suportado: ' + name);\\n    const [off, n] = w.add(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));\\n    return { $a: name, len: v.length, off, n };\\n  }\\n  if (Array.isArray(v)) return v.map(x => { const e = enc(x, w, depth + 1); return e === undefined ? null : e; });\\n  const o = {};\\n  for (const k of Object.keys(v)) { if (SKIP.has(k)) continue; const e = enc(v[k], w, depth + 1); if (e !== undefined) o[k] = e; }\\n  return o;\\n}\\nconst isTyped = d => d && typeof d === 'object' && d.$a !== undefined;\\nfunction dec(d, blob) {\\n  if (d === null || typeof d !== 'object') return d;\\n  if (d.$n !== undefined) return Number(d.$n);\\n  if (d.$u) return undefined;\\n  if (isTyped(d)) { const T = TYPES[d.$a], a = new T(d.len); new Uint8Array(a.buffer).set(blob.subarray(d.off, d.off + d.n)); return a; }\\n  if (Array.isArray(d)) return d.map(x => dec(x, blob));\\n  const o = {}; for (const k of Object.keys(d)) o[k] = dec(d[k], blob); return o;\\n}\\n/** grava `d` em `target[key]` preservando arrays tipados, instâncias (Voice, GTE...) e protótipos */\\nfunction put(target, key, d, blob) {\\n  const cur = target[key];\\n  if (isTyped(d) && ArrayBuffer.isView(cur) && cur.constructor.name === d.$a && cur.length === d.len) {\\n    const u = new Uint8Array(cur.buffer, cur.byteOffset, cur.byteLength); u.fill(0); u.set(blob.subarray(d.off, d.off + d.n)); return;\\n  }\\n  if (Array.isArray(d) && Array.isArray(cur) && cur.length === d.length && d.every(x => x && typeof x === 'object' && !Array.isArray(x) && !isTyped(x) && x.$n === undefined && !x.$u)) {\\n    d.forEach((x, i) => apply(cur[i], x, blob)); return;\\n  }\\n  if (d && typeof d === 'object' && !Array.isArray(d) && !isTyped(d) && d.$n === undefined && !d.$u && cur && typeof cur === 'object' && !Array.isArray(cur) && !ArrayBuffer.isView(cur)) {\\n    apply(cur, d, blob); return;\\n  }\\n  target[key] = dec(d, blob);\\n}\\nfunction apply(target, data, blob) { for (const k of Object.keys(data)) { if (!SKIP.has(k)) put(target, k, data[k], blob); } }\\n\\n/** Snapshot de um PSX → Uint8Array */\\nfunction saveState(psx, meta = {}) {\\n  const w = new Writer(), st = {};\\n  for (const c of COMPONENTS) st[c] = enc(c === 'bus' ? pick(psx.bus, ['ram', 'scratch', 'io', 'istat', 'imask', 'cacheCtrl', 'gpuToggle']) : psx[c], w);\\n  st.psx = enc(pick(psx, PSX_FIELDS), w);\\n  st.sched = psx.sched.snapshot();\\n  const head = new TextEncoder().encode(JSON.stringify({ version: STATE_VERSION, meta: { ...meta, savedAt: Date.now(), frames: psx.frames, cycles: psx.cpu.cycles }, st }));\\n  const out = new Uint8Array(12 + head.length + w.size), dv = new DataView(out.buffer);\\n  dv.setUint32(0, MAGIC, true); dv.setUint32(4, STATE_VERSION, true); dv.setUint32(8, head.length, true);\\n  out.set(head, 12); let o = 12 + head.length; for (const b of w.bufs) { out.set(b, o); o += b.length; }\\n  return out;\\n}\\nfunction pick(o, keys) { const r = {}; for (const k of keys) r[k] = o[k]; return r; }\\n\\n/** lê só o cabeçalho (meta) sem restaurar */\\nfunction readStateMeta(bytes) { return parse(bytes).head.meta; }\\nfunction parse(bytes) {\\n  if (bytes.length < 12) throw new Error('arquivo de save state inválido');\\n  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);\\n  if (dv.getUint32(0, true) !== MAGIC) throw new Error('não é um save state do ps1emu');\\n  const ver = dv.getUint32(4, true); if (ver !== STATE_VERSION) throw new Error(`versão de save state incompatível (${ver}, esperada ${STATE_VERSION})`);\\n  const hl = dv.getUint32(8, true);\\n  if (12 + hl > bytes.length) throw new Error('save state truncado');\\n  return { head: JSON.parse(new TextDecoder().decode(bytes.subarray(12, 12 + hl))), blob: bytes.subarray(12 + hl) };\\n}\\n\\n/** Restaura um snapshot no PSX (o mesmo disco/BIOS devem estar carregados). Devolve o meta. */\\nfunction loadState(psx, bytes) {\\n  const { head, blob } = parse(bytes), st = head.st;\\n  for (const c of COMPONENTS) apply(psx[c], st[c], blob);\\n  apply(psx, st.psx, blob);\\n  if (!Number.isFinite(psx.timerAt)) psx.timerAt = psx.lastTick;           // estados antigos não tinham timerAt\\n  psx.sched.restore(st.sched);\\n  const cd = psx.cdrom;\\n  cd.readEvt = psx.sched.find('cdrom', 'readSector') || psx.sched.find('cdrom', 'playSector');\\n  if (cd.data && cd.data.length === 0) cd.data = null;\\n  psx.jit.flush(); psx.bus.codeFlags.fill(0);\\n  psx.audioLen = 0;\\n  if (psx.gpu.hw) psx.gpu.hw.attach(psx.gpu);               // renderizador GL: reenvia a VRAM restaurada\\n  return head.meta;\\n}\\n\\n// ---- compressão (CompressionStream: navegadores modernos e Node ≥ 18) ----\\nasync function pipe(u8, stream) { return new Uint8Array(await new Response(new Blob([u8]).stream().pipeThrough(stream)).arrayBuffer()); }\\nconst gzip = u8 => pipe(u8, new CompressionStream('gzip'));\\nconst gunzip = u8 => pipe(u8, new DecompressionStream('gzip'));\\nconst isGzip = u8 => u8.length > 2 && u8[0] === 0x1F && u8[1] === 0x8B;\\n\\nreturn { STATE_VERSION, saveState, readStateMeta, loadState, gzip, gunzip, isGzip };\\n})();\\nconst __src_psx = (() => {\\n// ============================================================================\\n//  Máquina PS1: Bus + CPU + GPU + SPU + DMA + Timers + SIO0 (controle/memory card) + CD-ROM + MDEC\\n//  Relógio central = cpu.cycles (1 ciclo por instrução). A cada 32 ciclos roda tick():\\n//  timers, scanlines/VBLANK, eventos agendados (CD-ROM, SIO, DMA) e geração de áudio.\\n// ============================================================================\\nconst { Bus } = __src_bus;\\nconst { CPU } = __src_cpu;\\nconst { JIT } = __src_jit;\\nconst { enableWasm, wasmAvailable } = __src_wasmcpu;\\nconst { GPU } = __src_gpu;\\nconst { SPU } = __src_spu;\\nconst { DiscImage } = __src_disc;\\nconst { Scheduler } = __src_scheduler;\\nconst { Timers } = __src_timers;\\nconst { DMA } = __src_dma;\\nconst { SIO } = __src_sio;\\nconst { CDROM } = __src_cdrom;\\nconst { MemoryCard } = __src_memcard;\\nconst { MDEC } = __src_mdec;\\nconst { saveState, loadState } = __src_state;\\nconst TICK = 32, TICK_MAX = +(globalThis.PS1_TICKMAX || (typeof process !== \\\"undefined\\\" && process.env && process.env.PS1_TICKMAX)) || 2000, SPU_PERIOD = 768;   // tick adaptativo: curto só quando algo está para acontecer (evento, borda de linha)\\n           // 33.8688MHz / 44100Hz = 768\\nconst REGIONS = { A: 'SCEA', E: 'SCEE', J: 'SCEI' };\\n\\nclass PSX {\\n  constructor() {\\n    this.bus = new Bus();\\n    this.cpu = new CPU(this.bus);\\n    this.jit = new JIT(this.cpu, this.bus); this.jit.H.ps = this; this.useJit = true;      // recompilador dinâmico (desligue com psx.useJit = false)\\n    this.gpu = new GPU();\\n    this.spu = new SPU();\\n    this.sched = new Scheduler();\\n    this.sys = { bus: this.bus, sched: this.sched, now: () => this.cpu.cycles, irq: n => this.bus.raiseIrq(n), syncTimers: () => this.syncTimers(), retime: () => this.retime() };\\n    this.sched.onEarly = t => { if (t < this.nextTick) this.nextTick = t; };\\n    this.timers = new Timers(this.sys);\\n    this.dma = new DMA(this.sys);\\n    this.sio = new SIO(this.sys);\\n    this.cdrom = new CDROM(this.sys);\\n    this.mdec = new MDEC();\\n    this.dma.dev = { gpu: this.gpu, spu: this.spu, cdrom: this.cdrom, mdec: this.mdec };\\n    this.mdec.onOutput = () => this.dma.mdecOutReady();\\n    this.cdrom.spu = this.spu; this.gpu.clock = () => this.cpu.cycles; this.bus.psx = this;\\n    for (const [k, o] of [['cdrom', this.cdrom], ['dma', this.dma], ['sio', this.sio]]) this.sched.register(k, o);\\n    Object.assign(this.bus, { gpu: this.gpu, spu: this.spu, dma: this.dma, timers: this.timers, sio: this.sio, cdrom: this.cdrom, mdec: this.mdec });\\n    this.spu.onIrq = () => this.bus.raiseIrq(9);\\n    this.gpu.onIrq = () => this.bus.raiseIrq(1);\\n\\n    this.disc = null;\\n    this.onTTY = null; this.onTrace = null; this.hookTTY = true; this.postCodes = [];\\n    this.bus.onPost = c => this.postCodes.push(c);\\n    this.audio = new Int16Array(16384 * 2); this.audioLen = 0;\\n    this.resetTiming();\\n    if ((globalThis.PS1_WASM || (typeof process !== \\\"undefined\\\" && process.env && process.env.PS1_WASM)) && wasmAvailable()) this.enableWasm();\\n  }\\n\\n  /** troca a CPU pelo núcleo WebAssembly (wasm/cpu.c); true se ativou */\\n  enableWasm() { try { enableWasm(this); return true; } catch (e) { return false; } }\\n\\n  resetTiming() {\\n    this.lastTick = this.timerAt = this.cpu.cycles; this.nextTick = this.cpu.cycles + TICK;\\n    this.lineAcc = 0; this.line = 0; this.audioAcc = 0; this.frameDone = false; this.frames = 0;\\n  }\\n\\n  loadBios(bytes) {\\n    this.bus.loadBios(bytes);\\n    const info = this.biosInfo();\\n    this.cdrom.regionOverride = REGIONS[info.trim().slice(-1)] || 'SCEA';   // GetID devolve a região da BIOS (pula a trava regional)\\n    return info;\\n  }\\n  // versão da BIOS: texto em 0x7FF32\\n  biosInfo() {\\n    const b = this.bus.bios; let s = '';\\n    for (let i = 0x7FF32; i < 0x7FF60 && b[i]; i++) s += String.fromCharCode(b[i]);\\n    return s;\\n  }\\n  /** Insere um cartão (bytes de .mcr/.mcd/VGS/DexDrive) no slot 0 ou 1; sem bytes, cria um cartão em branco. */\\n  loadMemoryCard(slot, bytes) {\\n    const card = new MemoryCard(bytes); this.sio.cards[slot] = card;\\n    return { slot, saves: card.listSaves(), livres: card.freeBlocks() };\\n  }\\n  ejectMemoryCard(slot) { this.sio.cards[slot] = null; }\\n\\n  loadDisc(bytes) { this.disc = new DiscImage(bytes); this.cdrom.setDisc(this.disc); return this.disc.info(); }\\n\\n  /** carrega .cue + arquivos de trilha ({ 'nome.bin': Uint8Array, ... }) */\\n  loadCue(cueText, files) { this.disc = DiscImage.fromCue(cueText, files); this.cdrom.setDisc(this.disc); return this.disc.info(); }\\n  /** troca de disco em execução: abre a tampa; fechar com closeDiscLid(disc) */\\n  openDiscLid() { this.cdrom.openLid(); }\\n  closeDiscLid(disc) { this.disc = disc; this.cdrom.closeLid(disc); }\\n\\n  reset() {\\n    this.cpu.reset(); this.gpu.reset(); this.timers.reset(); this.dma.reset(); this.sio.reset(); this.cdrom.reset(); this.mdec.reset();\\n    this.cdrom.setDisc(this.disc); this.jit.flush(); this.sched.clear(); this.bus.istat = 0; this.bus.imask = 0;\\n    this.postCodes.length = 0; this.audioLen = 0; this.resetTiming();\\n  }\\n\\n  // ---------------- save states ----------------\\n  /** estado completo (Uint8Array); chamar entre quadros/instruções, nunca dentro de um bloco do JIT */\\n  saveState(meta = {}) { return saveState(this, { disc: this.disc ? this.disc.info().volume || '' : '', ...meta }); }\\n  loadState(bytes) { return loadState(this, bytes); }\\n\\n  // ---------------- TTY da BIOS (A0/B0: putchar/puts) ----------------\\n  tty() {\\n    const cpu = this.cpu, r = cpu.r, pc = cpu.pc & 0x1FFFFFFF;\\n    if (pc !== 0xA0 && pc !== 0xB0) return;\\n    const fn = r[9];\\n    if ((pc === 0xA0 && fn === 0x3C) || (pc === 0xB0 && fn === 0x3D)) this.onTTY?.(String.fromCharCode(r[4] & 0xFF));\\n    else if ((pc === 0xA0 && fn === 0x3E) || (pc === 0xB0 && fn === 0x3F)) {\\n      let a = r[4], s = '';\\n      for (let i = 0; i < 1024; i++) { const c = this.bus.read8(a++); if (!c) break; s += String.fromCharCode(c); }\\n      this.onTTY?.(s);\\n    }\\n  }\\n\\n  /** liga/desliga o atalho para laços de espera (leitura repetida de status/contador); desligado por padrão */\\n  get pollSkip() { return this.bus.pollOn; }\\n  set pollSkip(v) { this.bus.pollOn = !!v; }\\n\\n  // ---------------- tempo ----------------\\n  tick() {\\n    const now = this.cpu.cycles, dt = now - this.lastTick; this.lastTick = now;\\n    const gpu = this.gpu;\\n    this.timers.dotDiv = gpu.dotDiv;\\n    {   // blank horizontal/vertical (início do tick): fora da faixa ativa [hx1, hx2] da linha = hblank; linhas >= vb = vblank\\n      const k = (gpu.pal ? 2157.2 / 3406 : 2146.3 / 3413), x = this.lineAcc;\\n      this.timers.setBlank(x < gpu.hx1 * k || x >= gpu.hx2 * k, this.line >= (gpu.pal ? 256 : 240));\\n    }\\n    this.timers.advance(now - this.timerAt); this.timerAt = now;\\n\\n    // linhas de vídeo: NTSC 263 x ~2146 ciclos, PAL 314 x ~2157\\n    const lc = gpu.pal ? 2157.2 : 2146.3, lines = gpu.pal ? 314 : 263, vb = gpu.pal ? 256 : 240;\\n    this.lineAcc += dt;\\n    while (this.lineAcc >= lc) {\\n      this.lineAcc -= lc; this.line++; gpu.line = this.line; this.timers.hblank();\\n      if (this.line === vb) { gpu.vblank = true; gpu.toggleField(); this.bus.raiseIrq(0); }   // o campo entrelaçado muda no início do vblank (os desenhos do jogo depois do IRQ vão todos para o mesmo campo)          // IRQ0 = VBLANK\\n      if (this.line >= lines) { this.line = 0; gpu.line = 0; gpu.vblank = false; gpu.captureField(); this.frameDone = true; this.frames++; }\\n    }\\n\\n    this.sched.run(now);\\n\\n    this.audioAcc += dt;                                                           // 1 amostra a cada 768 ciclos\\n    while (this.audioAcc >= SPU_PERIOD) {\\n      this.audioAcc -= SPU_PERIOD; const [l, r] = this.spu.tick();\\n      if (this.audioLen < 16384) { this.audio[this.audioLen * 2] = l; this.audio[this.audioLen * 2 + 1] = r; this.audioLen++; }\\n    }\\n    // próximo tick: no máximo TICK_MAX ciclos, antes se houver evento agendado ou fim de linha de vídeo\\n    let nt = now + TICK_MAX; const ev = this.sched.next; if (ev < nt) nt = ev;\\n    const ln = now + (lc - this.lineAcc); if (ln < nt) nt = ln;\\n    if (TICK_MAX > 128) {                                                          // tick longo: limita pelas bordas de hblank dentro da linha e pelo próximo IRQ de timer\\n      const k = gpu.pal ? 2157.2 / 3406 : 2146.3 / 3413, x = this.lineAcc, e1 = gpu.hx1 * k, e2 = gpu.hx2 * k;\\n      if (e1 > x && now + (e1 - x) < nt) nt = now + (e1 - x); if (e2 > x && now + (e2 - x) < nt) nt = now + (e2 - x);\\n      const te = now + this.timers.nextEvent(); if (te < nt) nt = te;\\n    }\\n    this.nextTick = nt > now ? nt : now + 1;\\n  }\\n  /** um registrador de timer mudou: o próximo tick pode ter que vir antes */\\n  retime() { if (TICK_MAX > 128) { const te = this.cpu.cycles + this.timers.nextEvent(); if (te < this.nextTick) this.nextTick = te; } }\\n  /** contadores exatos numa leitura/escrita de registrador (sem rodar eventos) */\\n  syncTimers() { const now = this.cpu.cycles; if (now > this.timerAt) { this.timers.advance(now - this.timerAt); this.timerAt = now; } }\\n  takeAudio() { const o = this.audio.slice(0, this.audioLen * 2); this.audioLen = 0; return o; }\\n\\n  step() {\\n    if (this.wasm && !this.onTrace) {                   // 1 passo = 1 instrução no núcleo wasm\\n      if (this.hookTTY) this.tty();\\n      const w = this.wasm, nt = this.nextTick; w.S[9] = 1; this.nextTick = this.cpu.cycles + 1; w.run(); this.nextTick = nt; w.S[9] = 0;\\n      if (this.cpu.cycles >= nt) this.tick();\\n      return;\\n    }\\n    if (this.useJit && !this.onTrace) {                 // 1 \\\"passo\\\" = 1 bloco recompilado\\n      if (this.hookTTY) this.tty();\\n      this.jit.exec();\\n      if (this.cpu.cycles >= this.nextTick) this.tick();\\n      return;\\n    }\\n    if (this.onTrace) this.onTrace(this.cpu.pc, this.bus.read32(this.cpu.pc));\\n    if (this.hookTTY) this.tty();\\n    this.cpu.step();\\n    if (this.cpu.cycles >= this.nextTick) this.tick();\\n  }\\n  run(n) { for (let i = 0; i < n; i++) this.step(); }\\n  /** roda pelo menos n instruções (conta instruções, não passos) */\\n  runInstr(n) { const end = this.cpu.instrCount + n; while (this.cpu.instrCount < end) this.step(); }\\n\\n  /** Roda até o fim do quadro de vídeo atual; devolve o áudio (Int16 estéreo) gerado nesse tempo. */\\n  runFrame() {\\n    this.frameDone = false;\\n    if (this.wasm && !this.onTrace) {                    // CPU em WebAssembly: roda até o tick; A0/B0 voltam ao JS (TTY da BIOS)\\n      const w = this.wasm;\\n      while (!this.frameDone) { if (w.run() === 1) { this.tty(); w.skipHook(); } else this.tick(); }\\n    } else if (this.useJit && !this.onTrace) { while (!this.frameDone) { this.jit.runBlocks(this); this.tick(); } }\\n    else for (let g = 0; !this.frameDone && g < 4_000_000; g++) this.step();\\n    return this.takeAudio();\\n  }\\n\\n  // ---------------- boot ----------------\\n  /**\\n   * Sideload: roda a BIOS SEM disco até o shell (0x80030000) e depois carrega o EXE do disco.\\n   * Alternativa ao boot normal (a região já é \\\"spoofada\\\", então o boot normal costuma funcionar).\\n   */\\n  bootToShell(maxSteps = 80_000_000) {\\n    const disc = this.disc; this.cdrom.setDisc(null);\\n    let ok = false;\\n    for (let i = 0; i < maxSteps; i++) { if ((this.cpu.pc & 0x1FFFFFFF) === 0x30000) { ok = true; break; } this.step(); }\\n    this.cdrom.setDisc(disc);\\n    return ok;\\n  }\\n  sideload(exe) {\\n    const cpu = this.cpu;\\n    this.bus.ram.set(exe.data, exe.textAddr & 0x1FFFFF); this.jit.flush();\\n    const sp = exe.sp || exe.stack || 0x801FFF00;\\n    cpu.r[28] = exe.gp; cpu.r[29] = sp; cpu.r[30] = sp;\\n    cpu.pc = exe.pc; cpu.nextPc = (exe.pc + 4) >>> 0; cpu.isBranch = false;\\n    cpu.cop0[12] = 0x40000401;      // CU2 on, IM2 on, IEc on, modo kernel, BEV=0\\n  }\\n  bootDiscExe() {\\n    if (!this.disc) throw new Error('nenhum disco carregado');\\n    const exe = this.disc.loadBootExe(); this.sideload(exe); return exe;\\n  }\\n}\\n\\nreturn { PSX };\\n})();\\nconst __src_input = (() => {\\n// ============================================================================\\n//  Entrada: teclado + Gamepad API -> controles do PSX (digital ou DualShock), remapeamento e vibração.\\n//  Sem dependência do DOM: recebe eventos/listas de gamepads (testável em Node).\\n// ============================================================================\\nconst { BUTTONS } = __src_sio;\\nconst DEFAULT_KEYS = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', KeyZ: 'cross', KeyX: 'circle', KeyA: 'square',\\n  KeyS: 'triangle', KeyQ: 'l1', KeyW: 'r1', KeyE: 'l2', KeyR: 'r2', KeyD: 'l3', KeyC: 'r3', Enter: 'start', ShiftRight: 'select', Backspace: 'select' };\\n/** layout \\\"standard\\\" do Gamepad API (índice do botão -> botão do PSX) */\\nconst DEFAULT_PAD = { 0: 'cross', 1: 'circle', 2: 'square', 3: 'triangle', 4: 'l1', 5: 'r1', 6: 'l2', 7: 'r2', 8: 'select', 9: 'start', 10: 'l3', 11: 'r3',\\n  12: 'up', 13: 'down', 14: 'left', 15: 'right' };\\nconst DEFAULT_HOTKEYS = { KeyP: 'pause', F5: 'save', F7: 'load', F11: 'fullscreen', F9: 'analog', KeyT: 'turbo' };\\nconst ACTIONS = ['pause', 'save', 'load', 'fullscreen', 'analog', 'turbo'];\\nconst ANALOG_BTN = 16;                                           // botão \\\"home/guide\\\" alterna o modo analógico\\n\\nclass InputManager {\\n  constructor(psx) {\\n    this.psx = psx; this.keys = { ...DEFAULT_KEYS }; this.padMap = { ...DEFAULT_PAD }; this.hotkeys = { ...DEFAULT_HOTKEYS };\\n    this.deadzone = 0.2; this.rumbleOn = true; this.onHotkey = null; this.getPads = null;   // getPads: () => lista de gamepads\\n    this.kb = new Set(); this.virt = new Set(); this.gp = [new Set(), new Set()]; this.stickDpad = [new Set(), new Set()];\\n    this.assigned = [-1, -1]; this.prevHome = [false, false]; this.lastRumble = [null, null];\\n    psx.sio.onRumble = (port, small, large) => this.rumble(port, small, large);\\n  }\\n\\n  // ---- teclado ----\\n  /** evento de teclado (code = KeyboardEvent.code); acompanha as teclas físicas para suportar 2 teclas no mesmo botão. true = tecla consumida */\\n  keyEvent(code, down) {\\n    const act = this.hotkeys[code]; if (act) { if (down && this.onHotkey) this.onHotkey(act); return true; }\\n    const b = this.keys[code]; if (!b) return false;\\n    this.held ??= new Set(); if (down) this.held.add(code); else this.held.delete(code);\\n    this.kb = new Set([...this.held].map(c => this.keys[c]).filter(Boolean)); this.apply(0); return true;\\n  }\\n  /** controle virtual (toque): conjunto de botões pressionados na porta 1 */\\n  setVirtual(names) { this.virt = new Set(names); this.apply(0); }\\n  /** analógico virtual: x,y em -1..1 (y positivo = para baixo); side = 'l' | 'r' */\\n  setVirtualStick(side, x, y) { const s = this.psx.sio; s.setStick(side + 'x', 0x80 + x * 127, 0); s.setStick(side + 'y', 0x80 + y * 127, 0); }\\n  releaseAll() { this.held = new Set(); this.kb = new Set(); this.virt = new Set(); this.gp = [new Set(), new Set()]; this.stickDpad = [new Set(), new Set()]; this.apply(0); this.apply(1); }\\n\\n  // ---- remapeamento ----\\n  bindKey(button, code) {\\n    if (!(button in BUTTONS)) throw new Error('botão desconhecido ' + button);\\n    delete this.hotkeys[code]; this.keys[code] = button;\\n  }\\n  unbindKey(code) { delete this.keys[code]; }\\n  bindHotkey(action, code) { if (!ACTIONS.includes(action)) throw new Error('ação desconhecida'); for (const c of Object.keys(this.hotkeys)) if (this.hotkeys[c] === action) delete this.hotkeys[c]; delete this.keys[code]; this.hotkeys[code] = action; }\\n  bindPad(button, index) { for (const i of Object.keys(this.padMap)) if (this.padMap[i] === button) delete this.padMap[i]; this.padMap[index] = button; }\\n  resetBindings() { this.keys = { ...DEFAULT_KEYS }; this.padMap = { ...DEFAULT_PAD }; this.hotkeys = { ...DEFAULT_HOTKEYS }; }\\n  exportConfig() { return JSON.stringify({ keys: this.keys, pad: this.padMap, hotkeys: this.hotkeys, deadzone: this.deadzone, rumble: this.rumbleOn }); }\\n  importConfig(text) {\\n    const c = JSON.parse(text), ok = o => o && typeof o === 'object';\\n    if (ok(c.keys)) this.keys = Object.fromEntries(Object.entries(c.keys).filter(([, b]) => b in BUTTONS));\\n    if (ok(c.pad)) this.padMap = Object.fromEntries(Object.entries(c.pad).filter(([, b]) => b in BUTTONS));\\n    if (ok(c.hotkeys)) this.hotkeys = Object.fromEntries(Object.entries(c.hotkeys).filter(([, a]) => ACTIONS.includes(a)));\\n    if (typeof c.deadzone === 'number') this.deadzone = Math.max(0, Math.min(0.9, c.deadzone));\\n    if (typeof c.rumble === 'boolean') this.rumbleOn = c.rumble;\\n  }\\n\\n  // ---- gamepads (chamar 1x por quadro) ----\\n  poll() {\\n    const list = (this.getPads ? this.getPads() : []) || [];\\n    const pads = [...list].filter(g => g && g.connected);\\n    // associa o 1º gamepad à porta 1 e o 2º à porta 2 (mantém a ordem de conexão)\\n    this.assigned = [0, 1].map(p => pads[p] ? pads[p].index : -1);\\n    for (let port = 0; port < 2; port++) {\\n      const g = pads[port]; const sio = this.psx.sio;\\n      if (!g) { if (this.gp[port].size || this.stickDpad[port].size) { this.gp[port].clear(); this.stickDpad[port].clear(); this.apply(port); this.centerSticks(port); } continue; }\\n      if (port === 1) sio.padConnected[1] = true;\\n      const pressed = new Set();\\n      for (const [i, name] of Object.entries(this.padMap)) { const b = g.buttons[i]; if (b && (b.pressed || b.value > 0.5)) pressed.add(name); }\\n      const ax = k => { const v = g.axes[k] || 0; return Math.abs(v) < this.deadzone ? 0 : v; }, lx = ax(0), ly = ax(1), rx = ax(2), ry = ax(3);\\n      const dual = sio.padType[port] === 'dualshock', ds = new Set();\\n      if (dual) {\\n        const to8 = v => 0x80 + Math.round(v * 127.5);\\n        sio.setStick('lx', to8(lx), port); sio.setStick('ly', to8(ly), port); sio.setStick('rx', to8(rx), port); sio.setStick('ry', to8(ry), port);\\n      } else {                                                         // controle digital: o analógico esquerdo vira direcional\\n        if (lx < -0.5) ds.add('left'); if (lx > 0.5) ds.add('right'); if (ly < -0.5) ds.add('up'); if (ly > 0.5) ds.add('down');\\n      }\\n      this.gp[port] = pressed; this.stickDpad[port] = ds;\\n      const home = !!(g.buttons[ANALOG_BTN] && g.buttons[ANALOG_BTN].pressed);\\n      if (home && !this.prevHome[port]) sio.toggleAnalog(port);\\n      this.prevHome[port] = home;\\n      this.apply(port);\\n    }\\n  }\\n  centerSticks(port) { for (const k of ['lx', 'ly', 'rx', 'ry']) this.psx.sio.setStick(k, 0x80, port); }\\n  /** combina todas as fontes (teclado só na porta 1) e escreve no SIO */\\n  apply(port) {\\n    const sio = this.psx.sio, want = new Set([...this.gp[port], ...this.stickDpad[port], ...(port === 0 ? this.kb : []), ...(port === 0 ? this.virt : [])]);\\n    for (const name of Object.keys(BUTTONS)) sio.setButton(name, want.has(name), port);\\n  }\\n\\n  // ---- vibração ----\\n  rumble(port, small, large) {\\n    this.lastRumble[port] = [small, large];\\n    if (!this.rumbleOn || !this.getPads) return;\\n    const g = [...(this.getPads() || [])].filter(x => x && x.connected)[port], act = g && g.vibrationActuator;\\n    if (!act) return;\\n    try {\\n      if (!small && !large) { act.reset?.(); return; }\\n      act.playEffect?.('dual-rumble', { startDelay: 0, duration: 1000, weakMagnitude: small ? 1 : 0, strongMagnitude: large / 255 });\\n    } catch { /* navegador sem suporte: ignora */ }\\n  }\\n}\\n\\nreturn { DEFAULT_KEYS, DEFAULT_PAD, DEFAULT_HOTKEYS, ACTIONS, InputManager };\\n})();\\nconst __src_debug = (() => {\\n// ============================================================================\\n//  Depurador / tracer: registradores, desmontagem, passo a passo, breakpoints, trace e relatório de falha.\\n//  Breakpoints e trace usam o interpretador (JIT desligado enquanto estiverem ativos): ficam mais lentos.\\n// ============================================================================\\nconst { disasm } = __src_disasm;\\nconst hex = (v, n = 8) => (v >>> 0).toString(16).padStart(n, '0');\\nconst RN = ['zr', 'at', 'v0', 'v1', 'a0', 'a1', 'a2', 'a3', 't0', 't1', 't2', 't3', 't4', 't5', 't6', 't7',\\n            's0', 's1', 's2', 's3', 's4', 's5', 's6', 's7', 't8', 't9', 'k0', 'k1', 'gp', 'sp', 'fp', 'ra'];\\n\\n// só lê memória sem efeito colateral (RAM, scratchpad, BIOS); registradores de I/O não são tocados\\nconst safe = a => { const p = a & 0x1FFFFFFF; return p < 0x800000 || (p >= 0x1FC00000 && p < 0x1FC80000) || (p >= 0x1F800000 && p < 0x1F800400); };\\n\\nclass Debugger {\\n  rd32(a) { return safe(a) ? this.psx.bus.read32(a & ~3) : 0; }\\n  rd8(a) { return safe(a) ? this.psx.bus.read8(a) : 0; }\\n  constructor(psx) { this.psx = psx; this.breaks = new Set(); this.ring = null; this.ringPos = 0; this.ringN = 0; }\\n\\n  /** registradores em texto (4 por linha) */\\n  regs() {\\n    const c = this.psx.cpu; let s = `pc=${hex(c.pc)}  hi=${hex(c.hi)}  lo=${hex(c.lo)}  ciclos=${c.cycles}  SR=${hex(c.cop0[12])}  CAUSE=${hex(c.cop0[13])}  EPC=${hex(c.cop0[14])}\\\\n`;\\n    for (let i = 0; i < 32; i += 4) s += [0, 1, 2, 3].map(k => `${RN[i + k].padEnd(2)}=${hex(c.r[i + k])}`).join('  ') + '\\\\n';\\n    return s;\\n  }\\n  /** `before`/`after` instruções ao redor de `pc` (marca a atual com \\\">\\\") */\\n  listing(pc = this.psx.cpu.pc, before = 4, after = 8) {\\n    const out = [], cur = this.psx.cpu.pc;\\n    for (let i = -before; i <= after; i++) {\\n      const a = (pc + i * 4) >>> 0; let w = 0, txt;\\n      try { w = this.rd32(a); txt = disasm(w, a); } catch { txt = '??'; }\\n      out.push(`${a === cur ? '>' : ' '} ${hex(a)}: ${hex(w)}  ${txt}`);\\n    }\\n    return out.join('\\\\n');\\n  }\\n  /** dump hexadecimal de `len` bytes */\\n  dump(addr, len = 64) {\\n    let s = '';\\n    for (let o = 0; o < len; o += 16) {\\n      const bytes = []; for (let i = 0; i < 16 && o + i < len; i++) { bytes.push(this.rd8((addr + o + i) >>> 0)); }\\n      s += `${hex(addr + o)}: ${bytes.map(b => hex(b, 2)).join(' ').padEnd(47)}  ${bytes.map(b => b >= 32 && b < 127 ? String.fromCharCode(b) : '.').join('')}\\\\n`;\\n    }\\n    return s;\\n  }\\n\\n  // ---- trace (anel com os últimos N PCs) ----\\n  startTrace(n = 256) { this.ring = new Uint32Array(n); this.ringPos = 0; this.ringN = 0; this.hook(); }\\n  stopTrace() { this.ring = null; this.hook(); }\\n  hook() {\\n    const need = this.ring || this.breaks.size;\\n    this.psx.onTrace = need ? (pc => { if (this.ring) { this.ring[this.ringPos] = pc; this.ringPos = (this.ringPos + 1) % this.ring.length; if (this.ringN < this.ring.length) this.ringN++; } }) : null;\\n  }\\n  /** últimas instruções executadas, da mais antiga para a mais recente */\\n  traceText() {\\n    if (!this.ring) return '(trace desligado)';\\n    const n = this.ringN, out = [];\\n    for (let i = 0; i < n; i++) {\\n      const a = this.ring[(this.ringPos - n + i + this.ring.length * 2) % this.ring.length]; let w = 0, t;\\n      try { w = this.rd32(a); t = disasm(w, a); } catch { t = '??'; }\\n      out.push(`${hex(a)}: ${hex(w)}  ${t}`);\\n    }\\n    return out.join('\\\\n');\\n  }\\n\\n  // ---- execução controlada ----\\n  addBreak(pc) { this.breaks.add(pc >>> 0); this.hook(); }\\n  delBreak(pc) { this.breaks.delete(pc >>> 0); this.hook(); }\\n  /** executa exatamente 1 instrução no interpretador */\\n  stepInstr() {\\n    const p = this.psx, prev = p.onTrace; if (!prev) p.onTrace = () => { };\\n    const n = p.cpu.instrCount; try { for (let g = 0; p.cpu.instrCount === n && g < 8; g++) p.step(); } finally { if (!prev) p.onTrace = null; }\\n  }\\n  /** roda até um breakpoint (ou `max` instruções). Devolve o PC do breakpoint atingido ou null */\\n  run(max = 5_000_000) {\\n    const p = this.psx, c = p.cpu; this.hook(); if (!p.onTrace) p.onTrace = () => { };\\n    const end = c.instrCount + max; let hit = null;\\n    try {\\n      while (c.instrCount < end) {\\n        p.step(); if (this.breaks.has(c.pc >>> 0)) { hit = c.pc >>> 0; break; }\\n      }\\n    } finally { this.hook(); }\\n    return hit;\\n  }\\n\\n  /** texto para diagnóstico quando algo dá errado (exceção do emulador, travamento...) */\\n  report(err) {\\n    const p = this.psx, cd = p.cdrom;\\n    return [`== Relatório do ps1emu ==`, err ? `Erro: ${err.stack || err.message || err}` : 'Sem erro (snapshot manual)',\\n      `quadros=${p.frames} ciclos=${p.cpu.cycles} jit=${p.useJit}`, `IRQ: istat=${hex(p.bus.istat)} imask=${hex(p.bus.imask)}`,\\n      `CD: lendo=${cd.reading} tocando=${cd.playing} pos=${cd.pos} intFlag=${cd.intFlag} modo=${hex(cd.mode, 2)}`,\\n      `GPU: ${p.gpu.width}x${p.gpu.height} display=${p.gpu.dispOn} dma=${p.gpu.dmaDir}`,\\n      '', this.regs(), this.listing(p.cpu.pc, 6, 6), '', this.ring ? 'Últimas instruções:\\\\n' + this.traceText() : ''].join('\\\\n');\\n  }\\n}\\n\\nreturn { Debugger };\\n})();\\nconst __src_glgpu = (() => {\\n// ============================================================================\\n//  Renderizador WebGL2 da GPU do PS1 com resolução interna escalável (1x..8x)\\n// ============================================================================\\n//  Modelo de dados:\\n//   H  = VRAM em alta resolução (textura RGBA8 de 1024*S x 512*S, + stencil). É a fonte da verdade:\\n//        rgb = cor RGB555 expandida, alpha = bit de máscara (bit 15), stencil = espelho do bit de máscara.\\n//   N  = VRAM nativa (gpu.vram, Uint16Array 1024x512) + textura R16UI usada para buscar texels\\n//        4/8/15 bits e CLUTs nos shaders. É um CACHE de H: só é atualizada quando a CPU escreve na VRAM\\n//        (uploads) ou quando algo precisa ler uma região que a GPU desenhou (\\\"tiles sujos\\\" de 16x16).\\n//  Com o renderizador ativo o rasterizador por software NÃO roda (gpu.hw != null).\\n//\\n//  Fidelidade: coordenadas de vértice somam +0.5 pixel (o PS1 amostra em inteiros), texels via\\n//  texelFetch (nearest), dither por pixel nativo, semi-transparência com os 4 modos (blend de hardware;\\n//  texels semi/opacos em 2 passes), máscara (set/check) via stencil, janela de textura, área de desenho\\n//  por scissor, cópias VRAM->VRAM na GPU, leitura de VRAM por readPixels + reamostragem.\\n// ============================================================================\\n\\nconst VW = 1024, VH = 512, TILE = 16, TX = VW / TILE, TY = VH / TILE;\\nconst STRIDE_W = 19;                                   // palavras por vértice (7 floats + 12 ints)\\nconst MAX_VERTS = 6 * 8192;\\n\\nconst VS_PRIM = `#version 300 es\\nlayout(location=0) in vec2 a_pos; layout(location=1) in vec3 a_col; layout(location=2) in vec2 a_uv;\\nlayout(location=3) in ivec4 a_tex; layout(location=4) in ivec4 a_flg; layout(location=5) in ivec4 a_tw;\\nout vec3 v_col; out vec2 v_uv; flat out ivec4 v_tex; flat out ivec4 v_flg; flat out ivec4 v_tw;\\nvoid main(){\\n  gl_Position = vec4(a_pos.x/512.0-1.0, a_pos.y/256.0-1.0, 0.0, 1.0);\\n  v_col=a_col; v_uv=a_uv; v_tex=a_tex; v_flg=a_flg; v_tw=a_tw;\\n}`;\\n\\nconst FS_PRIM = `#version 300 es\\nprecision highp float; precision highp int; precision highp usampler2D;\\nuniform usampler2D u_vram; uniform float u_scale; uniform int u_pass; uniform int u_setMask; uniform int u_rowMask;\\nin vec3 v_col; in vec2 v_uv; flat in ivec4 v_tex; flat in ivec4 v_flg; flat in ivec4 v_tw;\\nout vec4 o_color;\\nconst int DITHER[16] = int[16](-4,0,-3,1, 2,-2,3,-1, -3,1,-4,0, 3,-1,2,-2);\\nint vramAt(ivec2 p){ return int(texelFetch(u_vram, ivec2(p.x & 1023, p.y & 511), 0).r); }\\nvoid main(){\\n  if (u_rowMask >= 0 && (int(floor(gl_FragCoord.y / u_scale)) & 1) == u_rowMask) discard;   // 480i: não desenha as linhas do campo exibido\\n  ivec3 c = ivec3(floor(v_col + 0.002));\\n  bool textured = v_flg.x < 3;\\n  bool semiTexel = false;\\n  if (textured) {\\n    ivec2 uv = ivec2(floor(v_uv + vec2(0.0002)));\\n    int u = uv.x & 255, v = uv.y & 255;\\n    u = (u & ~(v_tw.x << 3)) | ((v_tw.z & v_tw.x) << 3);\\n    v = (v & ~(v_tw.y << 3)) | ((v_tw.w & v_tw.y) << 3);\\n    int depth = v_flg.x, texel;\\n    if (depth == 0) {\\n      int w = vramAt(ivec2(v_tex.x + (u >> 2), v_tex.y + v));\\n      texel = vramAt(ivec2(v_tex.z + ((w >> ((u & 3) * 4)) & 15), v_tex.w));\\n    } else if (depth == 1) {\\n      int w = vramAt(ivec2(v_tex.x + (u >> 1), v_tex.y + v));\\n      texel = vramAt(ivec2(v_tex.z + ((w >> ((u & 1) * 8)) & 255), v_tex.w));\\n    } else {\\n      texel = vramAt(ivec2(v_tex.x + u, v_tex.y + v));\\n    }\\n    if (texel == 0) discard;\\n    semiTexel = (texel & 0x8000) != 0;\\n    ivec3 t = ivec3(texel & 31, (texel >> 5) & 31, (texel >> 10) & 31);\\n    if (v_flg.y != 0) c = t * 8; else c = (t * c) >> 4;\\n  }\\n  if (u_pass == 1) { if (!textured || semiTexel) discard; }\\n  else if (u_pass == 2) { if (textured && !semiTexel) discard; }\\n  if (v_flg.z != 0) {\\n    ivec2 np = ivec2(floor(gl_FragCoord.xy / u_scale));\\n    c += DITHER[((np.y & 3) << 2) | (np.x & 3)];\\n  }\\n  c = clamp(c, 0, 255) >> 3;\\n  o_color = vec4(vec3(c) / 31.0, float(u_setMask));\\n}`;\\n\\nconst VS_QUAD = `#version 300 es\\nlayout(location=0) in vec2 a_pos; layout(location=1) in vec2 a_uv; out vec2 v_uv;\\nuniform int u_ndc;   // 1: a_pos já está em NDC (apresentação); 0: coordenadas nativas da VRAM\\nvoid main(){\\n  gl_Position = (u_ndc == 1) ? vec4(a_pos, 0.0, 1.0) : vec4(a_pos.x/512.0-1.0, a_pos.y/256.0-1.0, 0.0, 1.0);\\n  v_uv = a_uv;\\n}`;\\n\\nconst FS_BLIT_NATIVE = `#version 300 es\\nprecision highp float; precision highp int; precision highp usampler2D;\\nuniform usampler2D u_src; uniform float u_scale; uniform int u_pass;\\nout vec4 o_color;\\nvoid main(){\\n  ivec2 p = ivec2(floor(gl_FragCoord.xy / u_scale)) & ivec2(1023, 511);\\n  uint w = texelFetch(u_src, p, 0).r;\\n  int bit = int((w >> 15u) & 1u);\\n  if (bit != u_pass) discard;\\n  o_color = vec4(vec3(ivec3(int(w & 31u), int((w >> 5u) & 31u), int((w >> 10u) & 31u))) / 31.0, float(bit));\\n}`;\\n\\nconst FS_BLIT_RGBA = `#version 300 es\\nprecision highp float; precision highp int;\\nuniform sampler2D u_src; uniform ivec2 u_delta; uniform int u_pass; uniform int u_setMask;\\nout vec4 o_color;\\nvoid main(){\\n  vec4 t = texelFetch(u_src, ivec2(gl_FragCoord.xy) + u_delta, 0);\\n  int bit = (t.a > 0.5 || u_setMask != 0) ? 1 : 0;\\n  if (bit != u_pass) discard;\\n  o_color = vec4(t.rgb, float(bit));\\n}`;\\n\\nconst FS_PRESENT = `#version 300 es\\nprecision highp float;\\nuniform sampler2D u_tex; in vec2 v_uv; out vec4 o_color;\\nvoid main(){ o_color = vec4(texture(u_tex, v_uv).rgb, 1.0); }`;\\n\\nconst FS_FILL = `#version 300 es\\nprecision highp float;\\nuniform vec4 u_col; uniform float u_scale; uniform int u_row; out vec4 o_color;\\nvoid main(){ if ((int(floor(gl_FragCoord.y / u_scale)) & 1) == u_row) discard; o_color = u_col; }`;\\n\\nconst FS_FIELD = `#version 300 es\\nprecision highp float;\\nuniform sampler2D u_src; uniform sampler2D u_prev; uniform float u_scale; uniform int u_par; uniform float u_mt; out vec4 o_color;\\nvoid main(){\\n  if ((int(floor(gl_FragCoord.y / u_scale)) & 1) != u_par) discard;\\n  ivec2 p = ivec2(gl_FragCoord.xy); vec3 n = texelFetch(u_src, p, 0).rgb, o = texelFetch(u_prev, p, 0).rgb; vec3 d = abs(n - o);\\n  o_color = vec4(n, max(d.r, max(d.g, d.b)) > u_mt ? 1.0 : 0.0);          // alfa = movimento em relação ao mesmo campo de 2 quadros atrás\\n}`;\\n\\n// apresentação em 480i com desentrelaçamento: linhas do campo antigo viram a média das vizinhas (campo atual) onde houver movimento (adaptativo) ou sempre (modo 2)\\nconst FS_DEINT = `#version 300 es\\nprecision highp float;\\nuniform sampler2D u_tex; uniform int u_par; uniform int u_mode; uniform float u_thr; uniform float u_dv; in vec2 v_uv; out vec4 o_color;\\nvoid main(){\\n  vec3 c = texture(u_tex, v_uv).rgb;\\n  int line = int(floor(v_uv.y * 512.0));\\n  if ((line & 1) != u_par) {\\n    vec4 A = texture(u_tex, v_uv - vec2(0.0, u_dv)), B = texture(u_tex, v_uv + vec2(0.0, u_dv)); vec3 m = (A.rgb + B.rgb) * 0.5;\\n    if (u_mode == 2 || max(A.a, B.a) > 0.5) c = m;                          // adaptativo: só onde o campo atual mudou em relação ao de 2 quadros atrás\\n  }\\n  o_color = vec4(c, 1.0);\\n}`;\\n\\nconst DEINT_THR = 40;                                                     // diferença (0-255) acima da qual a linha do campo antigo é considerada \\\"em movimento\\\"\\nconst Q5 = new Uint8Array(256); for (let i = 0; i < 256; i++) Q5[i] = Math.round(i * 31 / 255);\\n\\nclass GLRenderer {\\n  /**\\n   * @param canvas  <canvas> (será usado com contexto webgl2)\\n   * @param scale   fator de resolução interna (1..8)\\n   * @param opts    { smooth: true -> filtro linear quando a saída é reduzida }\\n   */\\n  constructor(canvas, scale = 2, opts = {}) {\\n    const gl = this.gl = canvas.getContext('webgl2', { antialias: false, alpha: false, depth: false, stencil: false, preserveDrawingBuffer: !!opts.preserve, powerPreference: 'high-performance' });\\n    if (!gl) throw new Error('WebGL2 indisponível neste navegador');\\n    this.canvas = canvas; this.opts = opts; this.gpu = null;\\n    const maxTex = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE), gl.getParameter(gl.MAX_RENDERBUFFER_SIZE));\\n    let S = Math.max(1, Math.floor(scale)); while (S > 1 && VW * S > maxTex) S--;\\n    this.scale = S; this.W = VW * S; this.H = VH * S;\\n\\n    this.initGL();\\n    this.f32 = new Float32Array(MAX_VERTS * STRIDE_W); this.i32 = new Int32Array(this.f32.buffer);\\n    this.n = 0; this.pc = new Int32Array(12);\\n    this.batchKey = ''; this.batchKind = 0; this.batchSemi = 0;\\n    this.pb = [1e9, 1e9, -1, -1];                              // bbox pendente (nativo) do lote ainda não desenhado\\n    this.dirty = new Uint8Array(TX * TY);                      // tiles em que H é mais novo que N\\n    this.rb = null; this.rgba = null;\\n    this.outW = 0; this.outH = 0; this.dispKey = ''; this.texDisp = null; this.fboDisp = null;\\n  }\\n\\n  // ------------------------------------------------------------------ GL setup\\n  compile(vs, fs, bind) {\\n    const gl = this.gl, mk = (t, s) => { const sh = gl.createShader(t); gl.shaderSource(sh, s); gl.compileShader(sh); if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error('shader: ' + gl.getShaderInfoLog(sh)); return sh; };\\n    const p = gl.createProgram(); gl.attachShader(p, mk(gl.VERTEX_SHADER, vs)); gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs));\\n    gl.linkProgram(p); if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('link: ' + gl.getProgramInfoLog(p));\\n    const u = {}; const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);\\n    for (let i = 0; i < n; i++) { const info = gl.getActiveUniform(p, i); u[info.name] = gl.getUniformLocation(p, info.name); }\\n    return { p, u };\\n  }\\n\\n  initGL() {\\n    const gl = this.gl, S = this.scale;\\n    gl.getExtension('EXT_color_buffer_float');\\n    this.prim = this.compile(VS_PRIM, FS_PRIM);\\n    this.blitN = this.compile(VS_QUAD, FS_BLIT_NATIVE);\\n    this.blitC = this.compile(VS_QUAD, FS_BLIT_RGBA);\\n    this.pres = this.compile(VS_QUAD, FS_PRESENT);\\n    this.fillP = this.compile(VS_QUAD, FS_FILL);\\n    this.fieldP = this.compile(VS_QUAD, FS_FIELD);\\n    this.deintP = this.compile(VS_QUAD, FS_DEINT);\\n\\n    // H: textura + stencil\\n    this.texH = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, this.texH);\\n    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, this.W, this.H);\\n    this.setFilter(this.texH, gl.NEAREST);\\n    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);\\n    this.rbDS = gl.createRenderbuffer(); gl.bindRenderbuffer(gl.RENDERBUFFER, this.rbDS);\\n    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH24_STENCIL8, this.W, this.H);\\n    this.fboH = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboH);\\n    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.texH, 0);\\n    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_STENCIL_ATTACHMENT, gl.RENDERBUFFER, this.rbDS);\\n    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('FBO incompleto (memória de vídeo insuficiente para ' + S + 'x?)');\\n    gl.disable(gl.SCISSOR_TEST); gl.clearColor(0, 0, 0, 0); gl.clearStencil(0); gl.stencilMask(0xFF); gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);\\n\\n    // N: textura R16UI\\n    this.texN = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, this.texN);\\n    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R16UI, VW, VH);\\n    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);\\n    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);\\n\\n    this.texScratch = null;                                      // alocada na 1ª cópia VRAM->VRAM\\n    this.texVid = gl.createTexture();                            // imagem de display em 24 bits\\n\\n    // VBO/VAO dos primitivos\\n    this.vbo = gl.createBuffer(); this.vao = gl.createVertexArray();\\n    gl.bindVertexArray(this.vao); gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);\\n    gl.bufferData(gl.ARRAY_BUFFER, MAX_VERTS * STRIDE_W * 4, gl.STREAM_DRAW);\\n    const B = STRIDE_W * 4;\\n    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, B, 0);\\n    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, B, 8);\\n    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 2, gl.FLOAT, false, B, 20);\\n    gl.enableVertexAttribArray(3); gl.vertexAttribIPointer(3, 4, gl.INT, B, 28);\\n    gl.enableVertexAttribArray(4); gl.vertexAttribIPointer(4, 4, gl.INT, B, 44);\\n    gl.enableVertexAttribArray(5); gl.vertexAttribIPointer(5, 4, gl.INT, B, 60);\\n\\n    // quad (blits/apresentação): 6 vértices x (x,y,u,v)\\n    this.qbo = gl.createBuffer(); this.qvao = gl.createVertexArray();\\n    gl.bindVertexArray(this.qvao); gl.bindBuffer(gl.ARRAY_BUFFER, this.qbo);\\n    gl.bufferData(gl.ARRAY_BUFFER, 6 * 4 * 4, gl.STREAM_DRAW);\\n    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 16, 0);\\n    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 16, 8);\\n    this.qdata = new Float32Array(24);\\n    gl.bindVertexArray(null);\\n  }\\n\\n  setFilter(tex, f) {\\n    const gl = this.gl; gl.bindTexture(gl.TEXTURE_2D, tex);\\n    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, f); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, f);\\n  }\\n\\n  // ------------------------------------------------------------------ ciclo de vida\\n  /** liga o renderizador à GPU: envia a VRAM nativa atual para H e N */\\n  attach(gpu) {\\n    this.gpu = gpu; gpu.hw = this;\\n    this.dirty.fill(0); this.n = 0; this.pb = [1e9, 1e9, -1, -1];\\n    const cm = gpu.checkMask; gpu.checkMask = false;\\n    this.uploadNativeTex(0, 0, VW, VH);\\n    this.blitNativeToH(0, 0, VW, VH);\\n    gpu.checkMask = cm;\\n  }\\n  /** desliga: traz tudo de H para a VRAM nativa e devolve o controle ao software */\\n  detach() {\\n    if (!this.gpu) return;\\n    this.flush(); this.syncNative(0, 0, VW, VH, true);\\n    this.gpu.hw = null; this.gpu = null;\\n  }\\n\\n  // ------------------------------------------------------------------ helpers de região\\n  /** divide um retângulo (com wrap em 1024x512) em pedaços que não cruzam as bordas */\\n  rects(x, y, w, h, fn) {\\n    x &= 1023; y &= 511; w = Math.min(w, VW); h = Math.min(h, VH);\\n    const w1 = Math.min(w, VW - x), h1 = Math.min(h, VH - y);\\n    fn(x, y, w1, h1);\\n    if (w > w1) fn(0, y, w - w1, h1);\\n    if (h > h1) { fn(x, 0, w1, h - h1); if (w > w1) fn(0, 0, w - w1, h - h1); }\\n  }\\n  markDirty(x0, y0, x1, y1) {                                   // inclusivo, nativo\\n    x0 = Math.max(0, x0); y0 = Math.max(0, y0); x1 = Math.min(VW - 1, x1); y1 = Math.min(VH - 1, y1);\\n    if (x1 < x0 || y1 < y0) return;\\n    for (let ty = y0 >> 4; ty <= y1 >> 4; ty++) for (let tx = x0 >> 4; tx <= x1 >> 4; tx++) this.dirty[ty * TX + tx] = 1;\\n  }\\n  isDirty(x, y, w, h) {\\n    for (let ty = y >> 4; ty <= (y + h - 1) >> 4; ty++) for (let tx = x >> 4; tx <= (x + w - 1) >> 4; tx++) if (this.dirty[ty * TX + tx]) return true;\\n    return false;\\n  }\\n  pendingHits(x, y, w, h) {\\n    const p = this.pb; return p[2] >= 0 && !(x > p[2] || x + w - 1 < p[0] || y > p[3] || y + h - 1 < p[1]);\\n  }\\n\\n  // ------------------------------------------------------------------ N <-> H\\n  uploadNativeTex(x, y, w, h) {\\n    const gl = this.gl;\\n    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.texN);\\n    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, VW); gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, x); gl.pixelStorei(gl.UNPACK_SKIP_ROWS, y);\\n    gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, w, h, gl.RED_INTEGER, gl.UNSIGNED_SHORT, this.gpu.vram);\\n    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0); gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0); gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);\\n  }\\n\\n  applyMask(writeBit, check) {\\n    const gl = this.gl; gl.enable(gl.STENCIL_TEST); gl.stencilMask(0xFF);\\n    if (check) { gl.stencilFunc(gl.EQUAL, 0, 0xFF); gl.stencilOp(gl.KEEP, gl.KEEP, writeBit ? gl.INVERT : gl.KEEP); }\\n    else { gl.stencilFunc(gl.ALWAYS, writeBit, 0xFF); gl.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE); }\\n  }\\n\\n  drawQuad(x, y, w, h, u0 = 0, v0 = 0, u1 = 0, v1 = 0, ndc = false) {\\n    const gl = this.gl, q = this.qdata;\\n    const X0 = x, Y0 = y, X1 = x + w, Y1 = y + h;\\n    q.set([X0, Y0, u0, v0, X1, Y0, u1, v0, X0, Y1, u0, v1, X1, Y0, u1, v0, X1, Y1, u1, v1, X0, Y1, u0, v1]);\\n    gl.bindVertexArray(this.qvao); gl.bindBuffer(gl.ARRAY_BUFFER, this.qbo); gl.bufferSubData(gl.ARRAY_BUFFER, 0, q);\\n    gl.drawArrays(gl.TRIANGLES, 0, 6);\\n  }\\n\\n  /** copia a região da VRAM nativa (N) para H (2 passes por bit de máscara) */\\n  blitNativeToH(x0, y0, w0, h0) {\\n    const gl = this.gl, S = this.scale, g = this.gpu;\\n    this.rects(x0, y0, w0, h0, (x, y, w, h) => {\\n      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboH); gl.viewport(0, 0, this.W, this.H);\\n      gl.disable(gl.BLEND); gl.enable(gl.SCISSOR_TEST); gl.scissor(x * S, y * S, w * S, h * S); gl.colorMask(true, true, true, true);\\n      gl.useProgram(this.blitN.p); gl.uniform1f(this.blitN.u.u_scale, S); gl.uniform1i(this.blitN.u.u_ndc, 0); gl.uniform1i(this.blitN.u.u_src, 0);\\n      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.texN);\\n      for (let pass = 0; pass < 2; pass++) {\\n        this.applyMask(pass, g.checkMask); gl.uniform1i(this.blitN.u.u_pass, pass);\\n        this.drawQuad(x, y, w, h);\\n      }\\n      if (!g.checkMask) for (let ty = y >> 4; ty <= (y + h - 1) >> 4; ty++) for (let tx = x >> 4; tx <= (x + w - 1) >> 4; tx++) {\\n        if (tx * TILE >= x && ty * TILE >= y && (tx + 1) * TILE <= x + w && (ty + 1) * TILE <= y + h) this.dirty[ty * TX + tx] = 0;\\n      }\\n    });\\n  }\\n\\n  /** traz de H para a VRAM nativa os tiles sujos que tocam a região; atualiza também a textura N */\\n  syncNative(x0, y0, w0, h0, all = false) {\\n    this.flush();\\n    const gl = this.gl, S = this.scale, g = this.gpu;\\n    this.rects(x0, y0, w0, h0, (x, y, w, h) => {\\n      let bx0 = 1e9, by0 = 1e9, bx1 = -1, by1 = -1;\\n      for (let ty = y >> 4; ty <= (y + h - 1) >> 4; ty++) for (let tx = x >> 4; tx <= (x + w - 1) >> 4; tx++) {\\n        if (!all && !this.dirty[ty * TX + tx]) continue;\\n        if (tx * TILE < bx0) bx0 = tx * TILE; if (ty * TILE < by0) by0 = ty * TILE;\\n        if ((tx + 1) * TILE - 1 > bx1) bx1 = (tx + 1) * TILE - 1; if ((ty + 1) * TILE - 1 > by1) by1 = (ty + 1) * TILE - 1;\\n      }\\n      if (bx1 < 0) return;\\n      const bw = bx1 - bx0 + 1, bh = by1 - by0 + 1, pw = bw * S, ph = bh * S;\\n      if (!this.rb || this.rb.length < pw * ph * 4) this.rb = new Uint8Array(pw * ph * 4);\\n      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.fboH);\\n      gl.readPixels(bx0 * S, by0 * S, pw, ph, gl.RGBA, gl.UNSIGNED_BYTE, this.rb);\\n      const rb = this.rb, c = S >> 1, vram = g.vram;\\n      for (let ny = 0; ny < bh; ny++) {\\n        let o = ((ny * S + c) * pw + c) * 4, di = (by0 + ny) * VW + bx0;\\n        for (let nx = 0; nx < bw; nx++, o += S * 4, di++) {\\n          vram[di] = Q5[rb[o]] | (Q5[rb[o + 1]] << 5) | (Q5[rb[o + 2]] << 10) | (rb[o + 3] > 127 ? 0x8000 : 0);\\n        }\\n      }\\n      for (let ty = by0 >> 4; ty <= by1 >> 4; ty++) for (let tx = bx0 >> 4; tx <= bx1 >> 4; tx++) this.dirty[ty * TX + tx] = 0;\\n      this.uploadNativeTex(bx0, by0, bw, bh);\\n    });\\n  }\\n\\n  /** a CPU escreveu na VRAM nativa (upload / cópia por software): reflete em H e N */\\n  uploaded(x, y, w, h) {\\n    this.flush();\\n    this.rects(x, y, w, h, (rx, ry, rw, rh) => { this.uploadNativeTex(rx, ry, rw, rh); this.blitNativeToH(rx, ry, rw, rh); });\\n  }\\n\\n  // ------------------------------------------------------------------ comandos de VRAM\\n  fill(x0, y0, w, h, col) {\\n    this.flush();\\n    const gl = this.gl, S = this.scale, mk = this.gpu.rowMask;\\n    if (mk >= 0) return this.fillMasked(x0, y0, w, h, col, mk);\\n    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboH); gl.viewport(0, 0, this.W, this.H);\\n    gl.disable(gl.BLEND); gl.enable(gl.SCISSOR_TEST); gl.colorMask(true, true, true, true); gl.stencilMask(0xFF);\\n    gl.clearColor(((col & 255) >> 3) / 31, (((col >> 8) & 255) >> 3) / 31, (((col >> 16) & 255) >> 3) / 31, 0); gl.clearStencil(0);\\n    this.rects(x0, y0, w, h, (x, y, rw, rh) => {\\n      gl.scissor(x * S, y * S, rw * S, rh * S); gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);\\n      this.markDirty(x, y, x + rw - 1, y + rh - 1);\\n    });\\n  }\\n\\n  /** fill em 480i: só as linhas do campo que não está sendo exibido (via shader; o stencil é zerado junto) */\\n  fillMasked(x0, y0, w, h, col, mk) {\\n    const gl = this.gl, S = this.scale;\\n    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboH); gl.viewport(0, 0, this.W, this.H);\\n    gl.disable(gl.BLEND); gl.enable(gl.SCISSOR_TEST); gl.colorMask(true, true, true, true);\\n    gl.enable(gl.STENCIL_TEST); gl.stencilMask(0xFF); gl.stencilFunc(gl.ALWAYS, 0, 0xFF); gl.stencilOp(gl.REPLACE, gl.REPLACE, gl.REPLACE);\\n    gl.useProgram(this.fillP.p); gl.uniform1i(this.fillP.u.u_ndc, 0);\\n    gl.uniform4f(this.fillP.u.u_col, ((col & 255) >> 3) / 31, (((col >> 8) & 255) >> 3) / 31, (((col >> 16) & 255) >> 3) / 31, 0);\\n    gl.uniform1f(this.fillP.u.u_scale, S); gl.uniform1i(this.fillP.u.u_row, mk);\\n    this.rects(x0, y0, w, h, (x, y, rw, rh) => {\\n      gl.scissor(x * S, y * S, rw * S, rh * S);\\n      this.drawQuad(x, y, rw, rh);\\n      this.markDirty(x, y, x + rw - 1, y + rh - 1);\\n    });\\n    gl.bindVertexArray(null);\\n  }\\n\\n  /** fim de quadro em 480i: guarda as linhas do campo exibido (completas) numa textura de display; a saída tece com o campo anterior */\\n  captureField(g) {\\n    this.flush();\\n    if (!(g.interlace && g.vres) || !g.dispOn) { this.dispKey = ''; g.snapKey = ''; return; }\\n    const gl = this.gl, S = this.scale, w = g.width, h = g.height;\\n    if (g.rgb24) { this.dispKey = ''; this.rects(g.startX, g.startY, Math.ceil(w * 1.5) + 2, h, (x, y, rw, rh) => this.syncNative(x, y, rw, rh)); g.captureFieldSW(); return; }\\n    g.snapKey = ''; this.lastPar = g.field;\\n    if (!this.texDisp) {\\n      this.texDisp = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, this.texDisp);\\n      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, this.W, this.H);\\n      this.setFilter(this.texDisp, gl.NEAREST);\\n      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);\\n      this.fboDisp = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboDisp);\\n      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.texDisp, 0);\\n    }\\n    if (!this.texPrev) {                                          // cópia do campo anterior (para detectar movimento)\\n      this.texPrev = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, this.texPrev);\\n      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, this.W, this.H); this.setFilter(this.texPrev, gl.NEAREST);\\n      this.fboPrev = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboPrev);\\n      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.texPrev, 0);\\n    }\\n    const key = g.startX + ',' + g.startY + ',' + w + ',' + h, full = key !== this.dispKey; this.dispKey = key;\\n    if (full) {                                                  // 1º quadro (ou mudança de modo): copia a área toda\\n      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.fboH); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.fboDisp);\\n      this.rects(g.startX, g.startY, w, h, (x, y, rw, rh) => gl.blitFramebuffer(x * S, y * S, (x + rw) * S, (y + rh) * S, x * S, y * S, (x + rw) * S, (y + rh) * S, gl.COLOR_BUFFER_BIT, gl.NEAREST));\\n    }\\n    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.fboDisp); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.fboPrev);      // texDisp (campos t-1 e t-2) -> texPrev\\n    gl.disable(gl.SCISSOR_TEST);\\n    this.rects(g.startX, g.startY, w, h, (x, y, rw, rh) => gl.blitFramebuffer(x * S, y * S, (x + rw) * S, (y + rh) * S, x * S, y * S, (x + rw) * S, (y + rh) * S, gl.COLOR_BUFFER_BIT, gl.NEAREST));\\n    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboDisp); gl.viewport(0, 0, this.W, this.H);\\n    gl.disable(gl.BLEND); gl.disable(gl.STENCIL_TEST); gl.enable(gl.SCISSOR_TEST); gl.colorMask(true, true, true, true);\\n    gl.useProgram(this.fieldP.p); gl.uniform1i(this.fieldP.u.u_ndc, 0); gl.uniform1i(this.fieldP.u.u_src, 0);\\n    gl.uniform1f(this.fieldP.u.u_scale, S); gl.uniform1i(this.fieldP.u.u_par, g.field); gl.uniform1i(this.fieldP.u.u_prev, 5); gl.uniform1f(this.fieldP.u.u_mt, 12 / 255);\\n    gl.activeTexture(gl.TEXTURE5); gl.bindTexture(gl.TEXTURE_2D, this.texPrev);\\n    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.texH);\\n    this.rects(g.startX, g.startY, w, h, (x, y, rw, rh) => { gl.scissor(x * S, y * S, rw * S, rh * S); this.drawQuad(x, y, rw, rh); });\\n    gl.bindVertexArray(null);\\n  }\\n\\n  /** VRAM->VRAM dentro da GPU. Devolve false se o chamador deve fazer por software (após sincronizar). */\\n  copy(sx, sy, dx, dy, w, h) {\\n    const g = this.gpu;\\n    if (sx + w > VW || dx + w > VW || sy + h > VH || dy + h > VH) {          // com wrap: caminho por software\\n      this.rects(sx, sy, w, h, (x, y, rw, rh) => this.syncNative(x, y, rw, rh));\\n      if (g.checkMask) this.rects(dx, dy, w, h, (x, y, rw, rh) => this.syncNative(x, y, rw, rh));\\n      return false;\\n    }\\n    this.flush();\\n    const gl = this.gl, S = this.scale;\\n    if (!this.texScratch) {\\n      this.texScratch = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, this.texScratch);\\n      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, this.W, this.H); this.setFilter(this.texScratch, gl.NEAREST);\\n    }\\n    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.fboH);\\n    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, this.texScratch);\\n    gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, sx * S, sy * S, sx * S, sy * S, w * S, h * S);\\n    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboH); gl.viewport(0, 0, this.W, this.H);\\n    gl.disable(gl.BLEND); gl.enable(gl.SCISSOR_TEST); gl.scissor(dx * S, dy * S, w * S, h * S); gl.colorMask(true, true, true, true);\\n    gl.useProgram(this.blitC.p); gl.uniform1i(this.blitC.u.u_ndc, 0); gl.uniform1i(this.blitC.u.u_src, 2);\\n    gl.uniform2i(this.blitC.u.u_delta, (sx - dx) * S, (sy - dy) * S); gl.uniform1i(this.blitC.u.u_setMask, g.setMask ? 1 : 0);\\n    for (let pass = 0; pass < 2; pass++) { this.applyMask(pass, g.checkMask); gl.uniform1i(this.blitC.u.u_pass, pass); this.drawQuad(dx, dy, w, h); }\\n    gl.activeTexture(gl.TEXTURE0);\\n    this.markDirty(dx, dy, dx + w - 1, dy + h - 1);\\n    return true;\\n  }\\n\\n  // ------------------------------------------------------------------ primitivos\\n  pv(x, y, r, g, b, u, v) {\\n    const f = this.f32, i = this.i32, pc = this.pc; let o = this.n * STRIDE_W;\\n    f[o] = x; f[o + 1] = y; f[o + 2] = r; f[o + 3] = g; f[o + 4] = b; f[o + 5] = u; f[o + 6] = v;\\n    for (let k = 0; k < 12; k++) i[o + 7 + k] = pc[k];\\n    this.n++;\\n  }\\n\\n  /** prepara as constantes por primitivo + garante texturas atualizadas + gerencia o lote */\\n  begin(textured, semi, raw, dith, clutX, clutY, bx0, by0, bx1, by1, nverts) {\\n    const g = this.gpu, pc = this.pc;\\n    const depth = textured ? g.texDepth : 3;\\n    if (textured) {\\n      const pw = depth === 0 ? 64 : depth === 1 ? 128 : 256, px = g.texX * 64, py = g.texY * 256;\\n      const need = (x, y, w, h) => this.rects(x, y, w, h, (rx, ry, rw, rh) => {\\n        if (this.pendingHits(rx, ry, rw, rh)) this.flush();\\n        if (this.isDirty(rx, ry, rw, rh)) this.syncNative(rx, ry, rw, rh);\\n      });\\n      need(px, py, pw, 256);\\n      if (depth === 0) need(clutX * 16, clutY, 16, 1); else if (depth === 1) need(clutX * 16, clutY, 256, 1);\\n      pc[0] = px; pc[1] = py; pc[2] = clutX * 16; pc[3] = clutY;\\n    } else { pc[0] = pc[1] = pc[2] = pc[3] = 0; }\\n    pc[4] = depth; pc[5] = raw ? 1 : 0; pc[6] = dith ? 1 : 0; pc[7] = 0;\\n    pc[8] = g.twMaskX; pc[9] = g.twMaskY; pc[10] = g.twOffX; pc[11] = g.twOffY;\\n\\n    const kind = !semi ? 0 : (textured ? 2 : 1);\\n    const mk = g.rowMask, key = `${g.daX1},${g.daY1},${g.daX2},${g.daY2},${g.setMask ? 1 : 0},${g.checkMask ? 1 : 0},${kind},${semi ? g.semiMode : -1},${mk}`;\\n    if (this.n > 0 && (key !== this.batchKey || this.n + nverts > MAX_VERTS)) this.flush();\\n    this.batchKey = key; this.batchKind = kind; this.batchSemi = g.semiMode;\\n    this.bs = { x1: g.daX1, y1: g.daY1, x2: g.daX2, y2: g.daY2, set: g.setMask ? 1 : 0, check: g.checkMask, mk };     // estado do lote (a GPU pode mudar antes do flush)\\n    // bbox pendente (para dirty tiles e hazard de textura)\\n    const p = this.pb;\\n    p[0] = Math.min(p[0], Math.max(bx0, g.daX1, 0)); p[1] = Math.min(p[1], Math.max(by0, g.daY1, 0));\\n    p[2] = Math.max(p[2], Math.min(bx1, g.daX2, VW - 1)); p[3] = Math.max(p[3], Math.min(by1, g.daY2, VH - 1));\\n    return kind;\\n  }\\n  end(kind) { if (kind === 2) this.flush(); }\\n\\n  polygon(V, quad, o) {\\n    this.tri(V[0], V[1], V[2], o);\\n    if (quad) this.tri(V[1], V[2], V[3], o);\\n  }\\n\\n  tri(a, b, c, o) {\\n    const g = this.gpu, S = this.scale;\\n    const area = (b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y);\\n    if (area === 0) return;\\n    const minX = Math.min(a.x, b.x, c.x), maxX = Math.max(a.x, b.x, c.x), minY = Math.min(a.y, b.y, c.y), maxY = Math.max(a.y, b.y, c.y);\\n    if (maxX - minX > 1023 || maxY - minY > 511) return;\\n    if (maxX < g.daX1 || minX > g.daX2 || maxY < g.daY1 || minY > g.daY2) return;\\n    const dith = o.tex ? (!o.raw && g.dither) : (g.dither && o.gour);\\n    const kind = this.begin(o.tex, o.semi, o.raw, dith, o.clutX, o.clutY, minX, minY, maxX, maxY, 3);\\n    const s = 0.5 / S, vs = o.gour ? [a, b, c] : [a, a, a];\\n    const P = [a, b, c];\\n    // O hardware interpola com gradientes truncados a 12 bits fracionários a partir do 1º vértice (+0,5 de arredondamento).\\n    // Reproduz o mesmo plano ajustando o valor de cada vértice: a interpolação linear da GPU do PC dá exatamente esses valores.\\n    const trunc = Math.trunc, bx = b.x - a.x, by = b.y - a.y, cx = c.x - a.x, cy = c.y - a.y;\\n    const plane = (va, vb, vc) => {\\n      const nx = (vb - va) * cy - (vc - va) * by, ny = (vc - va) * bx - (vb - va) * cx;\\n      const gx = trunc(nx * 4096 / area) / 4096, gy = trunc(ny * 4096 / area) / 4096;\\n      return [va + 0.5, va + 0.5 + gx * bx + gy * by, va + 0.5 + gx * cx + gy * cy];\\n    };\\n    const U = o.tex ? plane(a.u, b.u, c.u) : [0, 0, 0], V = o.tex ? plane(a.v, b.v, c.v) : [0, 0, 0];\\n    const R = o.gour ? plane(a.r, b.r, c.r) : null, G = o.gour ? plane(a.g, b.g, c.g) : null, B = o.gour ? plane(a.b, b.b, c.b) : null;\\n    for (let k = 0; k < 3; k++) this.pv(P[k].x + s, P[k].y + s, R ? R[k] : a.r, G ? G[k] : a.g, B ? B[k] : a.b, U[k], V[k]);\\n    this.end(kind);\\n  }\\n\\n  rect(x0, y0, w, h, o) {\\n    const g = this.gpu;\\n    if (w <= 0 || h <= 0) return;\\n    if (x0 > g.daX2 || y0 > g.daY2 || x0 + w - 1 < g.daX1 || y0 + h - 1 < g.daY1) return;\\n    const kind = this.begin(o.tex, o.semi, o.raw, false, o.clutX, o.clutY, x0, y0, x0 + w - 1, y0 + h - 1, 6);\\n    let ul = o.u0, ur = o.u0 + w, vt = o.v0, vb = o.v0 + h;\\n    if (o.flipX) { ul = o.u0 + 1.5; ur = ul - w; }          // pixel x amostra u0+1-x (centro do pixel = x+0,5)\\n    if (o.flipY) { vt = o.v0 + 0.5; vb = vt - h; }          // flip Y: v0-y\\n    const x1 = x0 + w, y1 = y0 + h, r = o.r, gg = o.g, b = o.b;\\n    this.pv(x0, y0, r, gg, b, ul, vt); this.pv(x1, y0, r, gg, b, ur, vt); this.pv(x0, y1, r, gg, b, ul, vb);\\n    this.pv(x1, y0, r, gg, b, ur, vt); this.pv(x1, y1, r, gg, b, ur, vb); this.pv(x0, y1, r, gg, b, ul, vb);\\n    this.end(kind);\\n  }\\n\\n  /** linha: reproduz exatamente os pixels do rasterizador por software (DDA), 1 quad de 1 pixel nativo cada */\\n  line(x0, y0, x1, y1, c0, c1, semi, gour) {\\n    const g = this.gpu;\\n    const dith = g.dither;                                            // linhas flat também recebem dithering (medido)\\n    const minX = Math.min(x0, x1), maxX = Math.max(x0, x1), minY = Math.min(y0, y1), maxY = Math.max(y0, y1);\\n    if (maxX < g.daX1 || minX > g.daX2 || maxY < g.daY1 || minY > g.daY2) return;\\n    const adx = Math.abs(x1 - x0), ady = Math.abs(y1 - y0), k = Math.max(adx, ady);\\n    if (adx >= 1024 || ady >= 512) return;                            // fora do limite do hardware\\n    const kind = this.begin(false, semi, false, dith, 0, 0, minX, minY, maxX, maxY, (k + 1) * 6);\\n    // mesmo algoritmo do rasterizador por software (passo 32.32 arredondado para longe do zero, pixel = floor(pos + 0,5 - eps))\\n    let ax = x0, ay = y0, bx = x1, by = y1, ca = c0, cb = c1;\\n    if (ax >= bx && k) { ax = x1; ay = y1; bx = x0; by = y0; ca = c1; cb = c0; }\\n    const div = d => { if (k === 0) return 0; const q = d * 4294967296 / k; return (q < 0 ? Math.floor(q) : Math.ceil(q)) / 4294967296; };\\n    const sx = div(bx - ax), sy = div(by - ay);\\n    let px = ax + 0.5 - 1 / 4194304, py = ay + 0.5;\\n    const r0 = ca & 255, g0 = (ca >> 8) & 255, b0 = (ca >> 16) & 255;\\n    const kk = k || 1, dr = Math.trunc((((cb & 255) - r0) * 4096) / kk), dg = Math.trunc(((((cb >> 8) & 255) - g0) * 4096) / kk), db = Math.trunc(((((cb >> 16) & 255) - b0) * 4096) / kk);\\n    for (let i = 0; i <= k; i++, px += sx, py += sy) {\\n      const x = Math.floor(px), y = Math.floor(py);\\n      let r = r0, gg = g0, b = b0;\\n      if (gour) { r = ((r0 << 12) + 2048 + dr * i) >> 12; gg = ((g0 << 12) + 2048 + dg * i) >> 12; b = ((b0 << 12) + 2048 + db * i) >> 12; }\\n      this.pv(x, y, r, gg, b, 0, 0); this.pv(x + 1, y, r, gg, b, 0, 0); this.pv(x, y + 1, r, gg, b, 0, 0);\\n      this.pv(x + 1, y, r, gg, b, 0, 0); this.pv(x + 1, y + 1, r, gg, b, 0, 0); this.pv(x, y + 1, r, gg, b, 0, 0);\\n    }\\n    this.end(kind);\\n  }\\n\\n  // ------------------------------------------------------------------ desenho do lote\\n  setBlend(mode) {\\n    const gl = this.gl; gl.enable(gl.BLEND);\\n    switch (mode) {\\n      case 0: gl.blendColor(0, 0, 0, 0.5); gl.blendEquationSeparate(gl.FUNC_ADD, gl.FUNC_ADD); gl.blendFuncSeparate(gl.CONSTANT_ALPHA, gl.CONSTANT_ALPHA, gl.ONE, gl.ZERO); break;\\n      case 1: gl.blendEquationSeparate(gl.FUNC_ADD, gl.FUNC_ADD); gl.blendFuncSeparate(gl.ONE, gl.ONE, gl.ONE, gl.ZERO); break;\\n      case 2: gl.blendEquationSeparate(gl.FUNC_REVERSE_SUBTRACT, gl.FUNC_ADD); gl.blendFuncSeparate(gl.ONE, gl.ONE, gl.ONE, gl.ZERO); break;\\n      default: gl.blendColor(0, 0, 0, 0.25); gl.blendEquationSeparate(gl.FUNC_ADD, gl.FUNC_ADD); gl.blendFuncSeparate(gl.CONSTANT_ALPHA, gl.ONE, gl.ONE, gl.ZERO);\\n    }\\n  }\\n\\n  flush() {\\n    if (!this.n || !this.gpu) { this.n = 0; return; }\\n    const gl = this.gl, g = this.gpu, S = this.scale, n = this.n;\\n    const p = this.pb;\\n    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboH); gl.viewport(0, 0, this.W, this.H);\\n    gl.enable(gl.SCISSOR_TEST);\\n    const bs = this.bs, x1 = Math.min(bs.x2, VW - 1), y1 = Math.min(bs.y2, VH - 1);\\n    gl.scissor(bs.x1 * S, bs.y1 * S, Math.max(0, x1 - bs.x1 + 1) * S, Math.max(0, y1 - bs.y1 + 1) * S);\\n    gl.colorMask(true, true, true, true);\\n    this.applyMask(bs.set, bs.check);\\n    gl.useProgram(this.prim.p);\\n    gl.uniform1f(this.prim.u.u_scale, S); gl.uniform1i(this.prim.u.u_setMask, bs.set); gl.uniform1i(this.prim.u.u_rowMask, bs.mk); gl.uniform1i(this.prim.u.u_vram, 0);\\n    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.texN);\\n    gl.bindVertexArray(this.vao); gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);\\n    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.f32, 0, n * STRIDE_W);\\n    const kind = this.batchKind;\\n    if (kind === 0) { gl.disable(gl.BLEND); gl.uniform1i(this.prim.u.u_pass, 0); gl.drawArrays(gl.TRIANGLES, 0, n); }\\n    else if (kind === 1) { this.setBlend(this.batchSemi); gl.uniform1i(this.prim.u.u_pass, 0); gl.drawArrays(gl.TRIANGLES, 0, n); gl.disable(gl.BLEND); }\\n    else {\\n      gl.disable(gl.BLEND); gl.uniform1i(this.prim.u.u_pass, 1); gl.drawArrays(gl.TRIANGLES, 0, n);\\n      this.setBlend(this.batchSemi); gl.uniform1i(this.prim.u.u_pass, 2); gl.drawArrays(gl.TRIANGLES, 0, n); gl.disable(gl.BLEND);\\n    }\\n    gl.bindVertexArray(null);\\n    if (p[2] >= 0) this.markDirty(p[0], p[1], p[2], p[3]);\\n    this.pb = [1e9, 1e9, -1, -1]; this.n = 0;\\n  }\\n\\n  // ------------------------------------------------------------------ saída\\n  /** desenha a área de display no canvas */\\n  present(gpu) {\\n    this.flush();\\n    const gl = this.gl, S = this.scale, w = gpu.width, h = gpu.height;\\n    const outS = Math.max(1, Math.min(S, Math.floor(3840 / w)));\\n    const cw = w * outS, ch = h * outS;\\n    if (this.canvas.width !== cw || this.canvas.height !== ch) { this.canvas.width = cw; this.canvas.height = ch; }\\n    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, cw, ch);\\n    gl.disable(gl.SCISSOR_TEST); gl.disable(gl.BLEND); gl.disable(gl.STENCIL_TEST); gl.colorMask(true, true, true, true);\\n    if (!gpu.dispOn) { gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT); return; }\\n    gl.useProgram(this.pres.p); gl.uniform1i(this.pres.u.u_ndc, 1); gl.uniform1i(this.pres.u.u_tex, 1);\\n    gl.activeTexture(gl.TEXTURE1);\\n    if (gpu.rgb24) {\\n      const vw = Math.ceil(w * 1.5) + 1;\\n      this.rects(gpu.startX, gpu.startY, vw, h, (x, y, rw, rh) => this.syncNative(x, y, rw, rh));\\n      if (!this.rgba || this.rgba.length !== w * h * 4) this.rgba = new Uint8ClampedArray(w * h * 4);\\n      gpu.renderRGBA(this.rgba);\\n      gl.bindTexture(gl.TEXTURE_2D, this.texVid);\\n      if (this.vidW !== w || this.vidH !== h) { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null); this.vidW = w; this.vidH = h; }   // aloca 1x; depois só atualiza (menos custo no driver)\\n      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, this.rgba);\\n      this.setFilter(this.texVid, gl.NEAREST);\\n      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);\\n      this.drawQuad(-1, 1, 2, -2, 0, 0, 1, 1, true);\\n    } else {\\n      const dt = (g2 => g2.interlace && g2.vres && this.dispKey)(gpu) ? this.texDisp : this.texH;      // 480i: dois últimos campos completos\\n      gl.bindTexture(gl.TEXTURE_2D, dt);\\n      this.setFilter(dt, (outS === S || !this.opts.smooth) ? gl.NEAREST : gl.LINEAR);\\n      if (dt === this.texDisp && gpu.deint) {                                            // 480i: desentrelaça na apresentação\\n        const dp = this.deintP; gl.useProgram(dp.p); gl.uniform1i(dp.u.u_ndc, 1); gl.uniform1i(dp.u.u_tex, 1);\\n        gl.uniform1i(dp.u.u_par, this.lastPar | 0); gl.uniform1i(dp.u.u_mode, gpu.deint); gl.uniform1f(dp.u.u_thr, DEINT_THR / 255); gl.uniform1f(dp.u.u_dv, 1 / 512);\\n      }\\n      const u0 = gpu.startX / VW, v0 = gpu.startY / VH, u1 = (gpu.startX + w) / VW, v1 = (gpu.startY + h) / VH;\\n      this.drawQuad(-1, 1, 2, -2, u0, v0, u1, v1, true);\\n    }\\n    gl.activeTexture(gl.TEXTURE0);\\n    gpu.frameCount++;\\n  }\\n\\n  /** lê a área de display em RGBA8 (linhas de cima para baixo) na resolução interna - para testes/capturas */\\n  readDisplay(gpu) {\\n    this.flush();\\n    const gl = this.gl, S = this.scale, w = gpu.width, h = gpu.height;\\n    if (gpu.rgb24 || !gpu.dispOn) { this.syncNative(0, 0, VW, VH); const r = gpu.renderRGBA(); return { data: r.data, width: r.width, height: r.height, scale: 1 }; }\\n    const out = new Uint8ClampedArray(w * S * h * S * 4), tmp = new Uint8Array(w * S * h * S * 4);\\n    // lê em até 4 pedaços (wrap)\\n    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.fboH);\\n    this.rects(gpu.startX, gpu.startY, w, h, (x, y, rw, rh) => {\\n      const buf = new Uint8Array(rw * S * rh * S * 4);\\n      gl.readPixels(x * S, y * S, rw * S, rh * S, gl.RGBA, gl.UNSIGNED_BYTE, buf);\\n      const ox = ((x - gpu.startX) & 1023) * S, oy = ((y - gpu.startY) & 511) * S;\\n      for (let r = 0; r < rh * S; r++) tmp.set(buf.subarray(r * rw * S * 4, (r + 1) * rw * S * 4), ((oy + r) * w * S + ox) * 4);\\n    });\\n    for (let i = 0; i < tmp.length; i += 4) {\\n      const r5 = Q5[tmp[i]], g5 = Q5[tmp[i + 1]], b5 = Q5[tmp[i + 2]];\\n      let r = r5 << 3, gg = g5 << 3, b = b5 << 3; r |= r >> 5; gg |= gg >> 5; b |= b >> 5;\\n      out[i] = r; out[i + 1] = gg; out[i + 2] = b; out[i + 3] = 255;\\n    }\\n    return { data: out, width: w * S, height: h * S, scale: S };\\n  }\\n}\\n\\nreturn { GLRenderer };\\n})();\\nconst __web_video_out = (() => {\\nconst { GLRenderer } = __src_glgpu;\\n// Saída de vídeo: apresenta a área de display da VRAM num <canvas>\\nclass VideoOut {\\n  constructor(canvas) { this.canvas = canvas; this.ctx = canvas.getContext('2d'); this.img = null; }\\n  present(gpu) {\\n    const w = gpu.width, h = gpu.height;\\n    if (!this.img || this.img.width !== w || this.img.height !== h) {\\n      this.canvas.width = w; this.canvas.height = h; this.img = this.ctx.createImageData(w, h);\\n    }\\n    gpu.renderRGBA(this.img.data);\\n    this.ctx.putImageData(this.img, 0, 0);\\n  }\\n}\\n\\n/** Apresentação via WebGL2 com resolução interna escalável (usa GLRenderer; a GPU deixa de rasterizar por software) */\\nclass GLVideoOut {\\n  constructor(canvas, scale, psx, opts = {}) {\\n    this.psx = psx; this.r = new GLRenderer(canvas, scale, opts); this.scale = this.r.scale;\\n    this.r.attach(psx.gpu);\\n  }\\n  present(gpu) { this.r.present(gpu); }\\n  dispose() { this.r.detach(); }\\n}\\n\\nreturn { VideoOut, GLVideoOut };\\n})();\\nconst __web_audio_out = (() => {\\n// Saída de áudio: reprodução em taxa FIXA (44,1 kHz, sem reamostragem nem controle de velocidade), então o tom nunca muda.\\n// Fila de blocos com pré-buffer curto: se o emulador atrasa, há silêncio até a fila reabastecer (sem alterar o tom);\\n// se ele \\\"recupera\\\" em rajada, o excesso acima do limite de latência é descartado.\\nclass PCMPull {\\n  constructor() { this.q = []; this.cur = null; this.pos = 0; this.fill = 0; this.primeAt = 1764; this.maxFill = 8820; this.primed = false; this.under = 0; this.drops = 0; this.lastL = 0; this.lastR = 0; this.fadeIn = 0; this.fo = 64; this.fl = 0; this.fr = 0; }\\n  push(b) {\\n    this.q.push(b); this.fill += b.length >> 1;\\n    while (this.fill > this.maxFill && this.q.length > 1) { const d = this.q.shift(); this.fill -= d.length >> 1; this.drops++; }   // latência limitada (~200 ms)\\n  }\\n  /** preenche de `from` até o fim com silêncio, terminando a descida suave (64 amostras) que pode atravessar blocos */\\n  silence(L, R, from) {\\n    const n = L.length;\\n    for (let j = from; j < n; j++) {\\n      if (this.fo < 64) { const k = 1 - (this.fo + 1) / 64; L[j] = this.fl * k; R[j] = this.fr * k; this.fo++; } else { L[j] = R[j] = 0; }\\n    }\\n    this.lastL = this.lastR = 0;\\n  }\\n  pull(L, R) {\\n    const n = L.length;\\n    if (!this.primed) {\\n      if (this.fill >= this.primeAt) { this.primed = true; this.fadeIn = this.under > 0 ? 64 : 0; }\\n      else { this.silence(L, R, 0); return; }\\n    }\\n    for (let i = 0; i < n; i++) {\\n      if (!this.cur || this.pos >= this.cur.length) {\\n        this.cur = this.q.shift() || null; this.pos = 0;\\n        if (!this.cur) {                                                                              // esvaziou: some suavemente (sem estalo) e espera reabastecer\\n          this.primed = false; this.under++; this.fl = this.lastL; this.fr = this.lastR; this.fo = 0;\\n          this.silence(L, R, i); return;\\n        }\\n      }\\n      let l = this.cur[this.pos++] / 32768, r = this.cur[this.pos++] / 32768; this.fill--;\\n      if (this.fadeIn > 0) { const g = 1 - this.fadeIn / 64; l *= g; r *= g; this.fadeIn--; }          // entrada suave após esvaziar\\n      L[i] = this.lastL = l; R[i] = this.lastR = r;\\n    }\\n  }\\n}\\n\\nconst WORKLET = `${PCMPull.toString()}\\nclass PS1Out extends AudioWorkletProcessor {\\n  constructor() {\\n    super(); this.p = new PCMPull(); this.p.maxFill = 13230; this.ext = null; this.n = 0;      // teto de 300 ms: a meta adaptativa chega a 160 ms e uma rajada de 3 quadros soma ~50 ms\\n    // canal direto emulador(Worker) -> áudio: o áudio não passa pela thread principal (UI/GC não causam falhas) e volta o nível do buffer\\n    this.port.onmessage = e => { const d = e.data; if (d && d.ch) { this.ext = d.ch; this.ext.onmessage = ev => this.p.push(ev.data); } else this.p.push(d); };\\n  }\\n  process(_, outs) {\\n    const o = outs[0], n = o[0].length; this.p.pull(o[0], o[1]); this.n += n;\\n    if (this.ext && this.n >= 2205) { this.n = 0; this.ext.postMessage({ ms: this.p.fill / 44.1, under: this.p.under, drops: this.p.drops }); }\\n    return true;\\n  }\\n}\\nregisterProcessor('ps1-out', PS1Out);`;\\n\\nclass AudioOut {\\n  async start() {                                  // precisa de um gesto do usuário (clique)\\n    this.ctx = new AudioContext({ sampleRate: 44100 });\\n    this.pull = new PCMPull(); this.pull.maxFill = 13230;\\n    try {\\n      if (!this.ctx.audioWorklet) throw new Error('sem AudioWorklet');\\n      try { await this.ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }))); }\\n      catch { await this.ctx.audioWorklet.addModule('data:text/javascript,' + encodeURIComponent(WORKLET)); }      // file://: o Chrome recusa módulo por blob:, mas aceita data: (antes caía no ScriptProcessor, que roda na thread principal)\\n      this.node = new AudioWorkletNode(this.ctx, 'ps1-out', { outputChannelCount: [2] });\\n      this.node.connect(this.ctx.destination);\\n      this.mode = 'worklet';\\n    } catch (e) {                                  // fallback (ex.: file:// bloqueando o worklet)\\n      const sp = this.ctx.createScriptProcessor(2048, 0, 2);\\n      sp.onaudioprocess = ev => this.pull.pull(ev.outputBuffer.getChannelData(0), ev.outputBuffer.getChannelData(1));\\n      sp.connect(this.ctx.destination); this.node = sp; this.mode = 'scriptprocessor';\\n    }\\n    await this.ctx.resume();\\n  }\\n  /** cria o canal direto Worker -> AudioWorklet; devolve a porta para o Worker (ou null se não há worklet) */\\n  channel() {\\n    if (this.mode !== 'worklet') return null;\\n    const ch = new MessageChannel(); this.node.port.postMessage({ ch: ch.port1 }, [ch.port1]); return ch.port2;\\n  }\\n  push(int16) {                                    // int16 = L,R,L,R...\\n    if (this.mode === 'worklet') this.node.port.postMessage(int16);\\n    else this.pull.push(int16);\\n  }\\n}\\n\\nreturn { PCMPull, AudioOut };\\n})();\\nconst __web_remote = (() => {\\n// Lado da página do modo Worker: fala com web/worker.js. Expõe `sio` compatível com o InputManager (repassa botões/analógicos).\\nclass SioProxy {\\n  constructor(owner) {\\n    this.o = owner; this.padType = ['digital', 'digital']; this.onRumble = null; this.cards = [null, null]; this.cache = new Map();\\n    const self = this;\\n    this.padConnected = new Proxy([true, false], { set(t, k, v) { if (t[k] !== v) { t[k] = v; self.o.call_('padConnected', [+k, v]); } return true; } });\\n  }\\n  setButton(name, pressed, port = 0) { const k = 'b' + port + name; if (this.cache.get(k) === pressed) return; this.cache.set(k, pressed); this.o.call_('setButton', [name, pressed, port]); }\\n  setStick(name, value, port = 0) { const k = 's' + port + name, v = Math.max(0, Math.min(255, Math.round(value))); if (this.cache.get(k) === v) return; this.cache.set(k, v); this.o.call_('setStick', [name, v, port]); }\\n  setPadType(port, type) { this.padType[port] = type; this.cache.clear(); this.o.call_('setPadType', [port, type]); }\\n  toggleAnalog(port = 0) { this.o.post({ t: 'analog', port }); return null; }\\n}\\n\\nclass RemoteMachine {\\n  /** src = texto do worker (bundle + worker.js), gerado por build.js em PS1_WORKER_SRC */\\n  constructor(src) {\\n    this.url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));\\n    this.w = new Worker(this.url); this.pending = new Map(); this.nid = 0; this.calls = []; this.on = {};\\n    this.game = 'sem-disco'; this.cardInfo = ['', '']; this.haveCard = [false, false]; this.hasDisc = false;\\n    this.sio = new SioProxy(this);\\n    this.w.onmessage = e => { const m = e.data; if (m.t === 'res') { const p = this.pending.get(m.id); this.pending.delete(m.id); if (p) m.ok ? p.res(m.value) : p.rej(new Error(m.err)); } else this.on[m.t]?.(m); };\\n    this.w.onerror = e => this.on.crash?.({ msg: e.message || 'erro no Worker', report: `${e.message} (${e.filename || ''}:${e.lineno || ''})` });\\n  }\\n  post(m, tr) { this.w.postMessage(m, tr || []); }\\n  call_(f, a) { this.calls.push([f, a]); }\\n  flush() { if (this.calls.length) { this.post({ t: 'sio', calls: this.calls }); this.calls = []; } }\\n  req(op, data = {}, tr) { return new Promise((res, rej) => { const id = ++this.nid; this.pending.set(id, { res, rej }); this.post({ t: 'req', id, op, ...data }, tr); }); }\\n  terminate() { this.w.terminate(); URL.revokeObjectURL(this.url); }\\n}\\n\\nreturn { RemoteMachine };\\n})();\\nglobal.PS1 = Object.assign({}, __src_gte, __src_cpu, __src_jit, __src_wasmbin, __src_wasmcpu, __src_disasm, __src_bus, __src_gpu, __src_gauss, __src_spu, __src_disc, __src_scheduler, __src_timers, __src_dma, __src_mdec, __src_memcard, __src_sio, __src_cdrom, __src_state, __src_psx, __src_input, __src_debug, __src_glgpu, __web_video_out, __web_audio_out, __web_remote);\\n})(typeof window !== 'undefined' ? window : globalThis);\\n\\n// Rasterizador em Worker: recebe o fluxo GP0/GP1 do emulador (ver GpuStream em src/gpu.js), desenha numa VRAM própria\\n// e apresenta no canvas (OffscreenCanvas transferido). Concatenado ao bundle por build.js (PS1_GPUW_SRC).\\n(() => {\\n  'use strict';\\n  const { GPU, VideoOut, GLRenderer } = PS1;\\n  const g = new GPU(); g.deint = 1; let vid = null, ren = null;\\n  self.onmessage = e => {\\n    const m = e.data;\\n    try {\\n      switch (m.t) {\\n        case 'init':\\n          if (m.scale > 0) {                                              // WebGL2 aqui no worker: o desenho e a apresentação saem da thread do emulador\\n            try { ren = new GLRenderer(m.canvas, m.scale, { smooth: !!m.smooth }); ren.attach(g); vid = { present: gg => ren.present(gg) }; self.postMessage({ t: 'ginfo', scale: ren.scale }); }\\n            catch (err) { ren = null; self.postMessage({ t: 'initfail', msg: String(err && err.message || err) }); }\\n          } else { vid = new VideoOut(m.canvas); self.postMessage({ t: 'ginfo', scale: 0 }); }\\n          break;\\n        case 'deint': g.deint = m.v | 0; break;\\n        case 'smooth': if (ren) ren.opts.smooth = !!m.v; break;\\n        case 'sync': g.vram.set(m.vram); for (const k in m.f) g[k] = m.f[k]; g.clutValid = false; g.snapKey = ''; if (ren) ren.attach(g); break;\\n        case 'cmds': {\\n          const q = m.q;\\n          for (let i = 0; i < q.length; i += 2) {\\n            const t = q[i], v = q[i + 1];\\n            if (t === 0) g.writeGP0(v); else if (t === 1) g.writeGP1(v);\\n            else if (t === 6) g.field = v;\\n            else if (t === 2) g.captureField();\\n            else if (t === 3) { if (vid) vid.present(g); self.postMessage({ t: 'ack' }); }\\n          }\\n          break;\\n        }\\n        case 'dump': { if (ren) { ren.flush(); ren.syncNative(0, 0, 1024, 512, true); } const v = g.vram.slice(); self.postMessage({ t: 'vram', vram: v }, [v.buffer]); break; }\\n      }\\n    } catch (err) { self.postMessage({ t: 'err', msg: String(err && err.stack || err) }); }\\n  };\\n})();\\n\";\n// Executa o emulador numa thread separada (Web Worker). Este arquivo é concatenado ao bundle (dist/ps1emu.js define PS1)\n// por build.js e roda só dentro do Worker. A página (thread principal) cuida de UI, entrada, áudio (AudioWorklet) e IndexedDB.\n// Protocolo: ver web/remote.js (lado da página).\n(() => {\n  'use strict';\n  const { PSX, VideoOut, GLVideoOut, Debugger } = PS1;\n  const post = (m, t) => self.postMessage(m, t || []);\n  const log = s => post({ t: 'log', s });\n  let psx = null, video = null, running = false, paused = false, turbo = false, crashed = null;\n  let cfg = { mode: -1, smooth: false }, gameKey = 'sem-disco', lidOpen = false;\n  let sumEmu = 0, sumVid = 0, sumFrames = 0, acc = 0, lastT = 0, frameCount = 0, t0 = 0, canvasWait = null, applying = false;\n  let hidden = false, fskip = false, gw = null, R = null, dumpWait = null;\n  // ---- sincronia áudio/vídeo: o relógio do áudio é o mestre. O AudioWorklet devolve o nível do buffer; um servo proporcional ajusta o ritmo\n  //      da emulação em até ±0,5% (inaudível) para o buffer ficar em ~AUDIO_ALVO ms, sem estalos de falta/sobra por deriva entre os relógios. ----\n  let alvo = 70, lastUnder = 0, underT = 0;                                // meta de latência (ms): sobe após cada falta de áudio (travadas do aparelho) e desce devagar quando fica estável\n  let ap = null, aStat = null, aAvg = -1, aStatT = 0, lastPres = 0, jit = [], speedScale = 1;\n\n  // ---- GPU em 2ª thread: o rasterizador (software) roda num Worker aninhado com VRAM própria; aqui só fica a análise dos comandos e a temporização ----\n  const gpuFields = g => { const f = {}; for (const k of Object.keys(g)) { const v = g[k]; if (typeof v === 'number' || typeof v === 'boolean') f[k] = v; } return f; };\n  const syncRemote = () => { const v = psx.gpu.vram.slice(); gw.postMessage({ t: 'sync', vram: v, f: gpuFields(psx.gpu) }, [v.buffer]); };\n  const askDump = () => new Promise(res => { dumpWait = res; R.flush(); gw.postMessage({ t: 'dump' }); });\n  const pullVram = async () => { if (!R) return; const v = await askDump(); psx.gpu.vram.set(v); };      // VRAM do worker -> esta thread (savestate, saída da GPU em thread)\n  const leaveRemote = async () => {\n    if (!R) return; await pullVram();\n    psx.gpu.remote = null; R = null; if (gw) { gw.terminate(); gw = null; } video = null;\n  };\n  let initWait = null;\n  const enterRemote = async scale => {\n    const c = await getCanvas();\n    gw = new Worker(URL.createObjectURL(new Blob([PS1_GPUW_SRC], { type: 'text/javascript' })));\n    gw.onmessage = e => { const m = e.data; if (m.t === 'ack') { if (R) R.inflight = Math.max(0, R.inflight - 1); } else if (m.t === 'vram') { const r = dumpWait; dumpWait = null; if (r) r(m.vram); } else if (m.t === 'ginfo' || m.t === 'initfail') { const r = initWait; initWait = null; if (r) r(m); } else if (m.t === 'err') log('GPU thread: ' + m.msg); };\n    gw.onerror = e => crash(new Error('GPU em thread: ' + (e.message || 'erro')));\n    gw.postMessage({ t: 'init', canvas: c, scale, smooth: cfg.smooth }, [c]); gw.postMessage({ t: 'deint', v: psx.gpu.deint | 0 });\n    const info = await new Promise(res => { initWait = res; });\n    if (info.t === 'initfail') { log('GPU em thread: ' + info.msg + ' - usando uma thread só'); gw.terminate(); gw = null; return false; }\n    R = new PS1.GpuStream(m => gw.postMessage(m, m.q ? [m.q.buffer] : []));\n    syncRemote(); psx.gpu.remote = R;\n    R.onRead = () => { if (!R || R.fb) return; R.fb = true; smart.trial = null; smart.blocked = true; post({ t: 'gpuread' }); log('GPU em thread: o jogo lê a VRAM de volta - voltando para uma thread só'); cfg.gpuThread = false; fallback = true; };\n    video = { present: () => { R.push(3, 0); R.inflight++; R.flush(); }, dispose() {} };\n    const nome = info.scale ? `WebGL2 ${info.scale}x (${1024 * info.scale}x${512 * info.scale} VRAM)` : 'software';\n    post({ t: 'rinfo', s: `${auto.on ? 'Adaptativo: ' : ''}${nome} [GPU em thread separada]` }); log(`Renderizador: ${nome} [GPU em 2ª thread]`);\n    return true;\n  };\n  let fallback = false;\n  // modo inteligente: com o renderizador Adaptativo, se já está no software e o emulador não acompanha, TESTA a GPU em 2ª thread\n  // (mede quadros/s antes e depois; sem ganho de verdade, volta). O resultado é lembrado por jogo (pela página).\n  const smart = { ok: false, bad: false, blocked: false, trial: null };\n  const canThread = () => typeof PS1_GPUW_SRC !== 'undefined' && (self.navigator && navigator.hardwareConcurrency || 2) >= 4 && !smart.bad && !smart.blocked;\n\n  // ---- renderizador (adaptativo igual ao da thread principal; o probe do aparelho vem da página) ----\n  const auto = { on: false, scale: 2, max: 4, slow: 0, fast: 0, fail: {}, tries: {}, ran: 0, work: 0, t: 0 };\n  const getCanvas = () => new Promise(res => { canvasWait = res; post({ t: 'needCanvas' }); });\n  const applyRenderer = async () => {\n    if (applying) return; applying = true;\n    try {\n      await leaveRemote();\n      if (cfg.gpuThread) {                                               // GPU em 2ª thread: software ou WebGL (na escala do adaptativo / escolhida)\n        auto.on = cfg.mode < 0; const sc = auto.on ? auto.scale : Math.max(0, cfg.mode);\n        if (video && video.dispose) video.dispose(); if (psx.gpu.hw) psx.gpu.hw = null; video = null;      // traz a VRAM do WebGL local para a VRAM nativa antes de enviá-la ao worker\n        if (await enterRemote(sc)) return;\n        cfg.gpuThread = false; smart.trial = null; smart.bad = true;     // não deu: segue pelo caminho normal abaixo\n      }\n      let mode = cfg.mode; auto.on = mode < 0; if (auto.on) mode = auto.scale;\n      if (video && video.dispose) video.dispose();\n      if (psx.gpu.hw) psx.gpu.hw = null;\n      video = null;\n      let c = await getCanvas();\n      if (mode) {\n        try {\n          const v = new GLVideoOut(c, mode, psx, { smooth: cfg.smooth });\n          video = v; post({ t: 'rinfo', s: `${auto.on ? 'Adaptativo: ' : ''}WebGL2 ${v.scale}x (${1024 * v.scale}x${512 * v.scale} VRAM) [thread separada]` });\n          log(`Renderizador: WebGL2 ${v.scale}x${auto.on ? ' (adaptativo)' : ''} [Worker]`); return;\n        } catch (e) { log('WebGL indisponível no Worker (' + e.message + ') - usando software'); auto.scale = 0; auto.max = 0; c = await getCanvas(); }\n      }\n      video = new VideoOut(c); post({ t: 'rinfo', s: (auto.on ? 'Adaptativo: ' : '') + 'software [thread separada]' }); log('Renderizador: software [Worker]');\n    } finally { applying = false; }\n  };\n  const adapt = (ran, work, period, ms) => {\n    if (!auto.on || ms > 1600) return;\n    const want = ms / period, now = performance.now();\n    if (R && smart.trial) {                                              // GPU em thread no modo inteligente: confere se o teste valeu a pena\n      const t = smart.trial;\n      if (++t.n === 1) return;                                           // o 1º segundo inclui a troca\n      t.best = Math.max(t.best, ran / want);\n      if (t.n >= 4) {\n        smart.trial = null;\n        if (t.best >= t.before * 1.08 && t.best > t.before + 0.03) { smart.ok = true; post({ t: 'gpusmart', v: 'ok' }); log(`Inteligente: GPU em 2ª thread valeu (${(t.before * 100).toFixed(0)}% -> ${(t.best * 100).toFixed(0)}% da velocidade) - mantida`); }\n        else { smart.bad = true; cfg.gpuThread = false; post({ t: 'gpusmart', v: 'bad' }); log(`Inteligente: GPU em 2ª thread não ajudou (${(t.before * 100).toFixed(0)}% -> ${(t.best * 100).toFixed(0)}%) - voltando para uma thread`); applyRenderer(); }\n      }\n      return;\n    }\n    auto.peak = Math.max(work, (auto.peak || 0) * 0.985);              // pico recente de custo por quadro (cenas pesadas, ex.: luta 3D, mantêm o pico alto)\n    const behind = ran < want * 0.9, idle = ran >= want * 0.97 && work < period * 0.4 && auto.peak < period * 0.6;\n    auto.slow = behind ? auto.slow + 1 : 0; auto.fast = idle ? auto.fast + 1 : 0;\n    const move = ns => { auto.scale = ns; auto.slow = auto.fast = 0; applyRenderer(); };\n    if (auto.slow >= 2 && !R && canThread() && !smart.trial) {            // atrasado (em qualquer escala): antes de baixar a qualidade, testa a GPU em 2ª thread\n      smart.trial = { before: ran / want, n: 0, best: 0 }; cfg.gpuThread = true; auto.slow = auto.fast = 0;\n      log(`Inteligente: ${ran}/${want.toFixed(0)} quadros/s - testando a GPU em 2ª thread (${auto.scale ? auto.scale + 'x' : 'software'})`); applyRenderer();\n    } else if (auto.slow >= 2 && auto.scale > 0) {                       // não acompanha: desce um degrau (até o software) e lembra que esse degrau falhou\n      const from = auto.scale; auto.fail[from] = now; auto.tries[from] = (auto.tries[from] || 0) + 1; post({ t: 'afail', level: from });\n      log(`Adaptativo: ${ran}/${want.toFixed(0)} quadros/s → ${from}x para ${from - 1 ? from - 1 + 'x' : 'software'}`); move(from - 1);\n    } else if (auto.fast >= 10 && auto.scale < auto.max) {               // sobra folga de verdade e por bastante tempo: tenta subir (espera dobra a cada falha)\n      const to = auto.scale + 1, wait = 60000 * Math.pow(2, auto.tries[to - 1] || 0);\n      if (!auto.fail[to] || now - auto.fail[to] > wait) { log(`Adaptativo: folga de CPU → subindo para ${to}x`); auto.peak = work; move(to); } else auto.fast = 0;\n    }\n  };\n\n  // ---- laço principal (mesma lógica da thread principal: 50/59,94 Hz independente do monitor) ----\n  const crash = e => {\n    crashed = e; running = false; let rep = '';\n    try { rep = new Debugger(psx).report(e); } catch { rep = String(e && e.stack || e); }\n    post({ t: 'crash', msg: String(e && e.message || e), report: rep });\n  };\n  // laço por setTimeout (não por rAF): o ritmo vem do acumulador de tempo, então uma GPU/compositor lento não derruba a velocidade da emulação\n  let timer = 0;\n  const frame = () => {\n    clearTimeout(timer);\n    const period = psx.gpu.pal ? 20 : 16.6833;\n    run(); timer = setTimeout(frame, Math.max(1, Math.min(period, period - acc - 1)));\n  };\n  const syncInfo = () => {\n    let s = '';\n    if (aStat) s += ` · áudio ${aStat.ms.toFixed(0)}/${alvo} ms (falta ${aStat.under}, sobra ${aStat.drops}) · ritmo ${((speedScale - 1) * 100).toFixed(2)}%`;\n    if (jit.length > 20) { const a = jit.slice().sort((x, y) => x - y); s += ` · irregularidade p95 ${a[Math.floor(a.length * 0.95)].toFixed(1)} ms`; }\n    return s;\n  };\n  const run = () => {\n    if (!running || paused || hidden) { lastT = performance.now(); return; }\n    if (fallback && !applying) { fallback = false; applyRenderer(); }\n    if (R && (R.inflight >= 4 || dumpWait)) return;                       // o rasterizador está atrasado: espera (a emulação não corre à frente da imagem)\n    try {\n      const now = performance.now(); acc = Math.min(acc + Math.min(now - lastT, 100), 100); lastT = now;\n      const base = psx.gpu.pal ? 20 : 16.6833;\n      speedScale = 1;\n      if (ap && aStat && !turbo && now - aStatT < 600) speedScale = 1 + Math.max(-0.005, Math.min(0.005, (aAvg - alvo) / alvo * 0.01));   // buffer cheio: desacelera um pouco; vazio: acelera\n      const period = base * speedScale;\n      let n = 0;\n      if (turbo) n = 4; else { while (acc >= period - 0.5 && n < 3) { acc -= period; n++; } if (acc > period) acc = period; }\n      if (!n) return;\n      const w0 = performance.now();\n      for (let i = 0; i < n; i++) {\n        psx.gpu.skipDraw = fskip && i < n - (psx.gpu.rowMask >= 0 ? 3 : 2);   // desenha os 2 últimos (jogos com buffer duplo exibem o buffer do quadro anterior)\n        const pcm = psx.runFrame();\n        if (!turbo && pcm.length) { if (ap) ap.postMessage(pcm, [pcm.buffer]); else post({ t: 'audio', pcm }, [pcm.buffer]); }\n      }\n      const w1 = performance.now(); sumEmu += w1 - w0; sumFrames += n;\n      psx.gpu.skipDraw = false;\n      if (video) video.present(psx.gpu);\n      if (!turbo) { const pn = performance.now(); if (lastPres) { jit.push(Math.abs(pn - lastPres - base * n)); if (jit.length > 120) jit.shift(); } lastPres = pn; }\n      sumVid += performance.now() - w1;\n      if (auto.on && !turbo && video) {\n        const e = performance.now(); auto.ran += n; auto.work += e - w0;\n        if (!auto.t) auto.t = e; else if (e - auto.t >= 1000) { const ran = auto.ran, wk = auto.work / Math.max(1, ran), ms = e - auto.t; auto.ran = 0; auto.work = 0; auto.t = e; adapt(ran, wk, period, ms); }\n      }\n      frameCount += n; if (frameCount >= 60) { const t = performance.now(); post({ t: 'fps', s: (frameCount * 1000 / (t - t0)).toFixed(1) + ' fps' + (turbo ? ' (turbo)' : '') + ` · emu ${(sumEmu / sumFrames).toFixed(1)} ms (${psx.wasm ? 'wasm' : psx.useJit ? 'jit' : 'interp'}) · vídeo ${(sumVid / sumFrames).toFixed(1)} ms/quadro` + syncInfo() }); t0 = t; frameCount = 0; sumEmu = sumVid = sumFrames = 0; }\n    } catch (e) { crash(e); }\n  };\n\n  // ---- memory cards: avisa a página dos cartões alterados (ela grava no IndexedDB) e do texto de informação ----\n  const cardInfo = s => { const c = psx.sio.cards[s]; if (!c) return ''; const n = c.listSaves().length; return `${n} save(s), ${c.freeBlocks()} bloco(s) livre(s)`; };\n  setInterval(() => {\n    if (!psx) return;\n    for (const s of [0, 1]) { const c = psx.sio.cards[s]; if (c && c.dirty) { const b = c.export(); post({ t: 'cardData', slot: s, bytes: b }, [b.buffer]); } }\n    post({ t: 'cards', info: [cardInfo(0), cardInfo(1)], have: [!!psx.sio.cards[0], !!psx.sio.cards[1]], lid: !!(psx.disc || lidOpen) });\n  }, 1000);\n\n  // disco: File/Blob vindos da página (leitura preguiçosa por BlobSource) ou bytes já lidos (compatibilidade)\n  const makeDisc = d => d.blobs ? PS1.DiscImage.fromCue(d.cue, new Map(d.blobs.map(([n, f]) => [n, new PS1.BlobSource(f)])))\n    : d.cue ? PS1.DiscImage.fromCue(d.cue, new Map(d.map)) : d.blob ? new PS1.DiscImage(new PS1.BlobSource(d.blob)) : new PS1.DiscImage(d.bytes);\n  const setGame = () => { try { const i = psx.disc && psx.disc.info(); gameKey = i ? (i.volume || 'disco') + ':' + i.setores : 'sem-disco'; } catch { gameKey = 'disco'; } post({ t: 'game', key: gameKey }); };\n\n  const init = async m => {\n    psx = new PSX(); psx.onTTY = s => log(s.replace(/\\n$/, ''));\n    cfg = { mode: m.mode, smooth: !!m.smooth, gpuThread: !!m.gpuThread }; Object.assign(auto, m.probe || {});\n    smart.ok = m.gpuS === 'ok'; smart.bad = m.gpuS === 'bad'; smart.blocked = !!m.gptBlocked;\n    if (!cfg.gpuThread && cfg.mode < 0 && smart.ok && canThread()) { cfg.gpuThread = true; log('Inteligente: este jogo já se deu bem com a GPU em 2ª thread - ligando'); }\n    log('BIOS: ' + psx.loadBios(m.bios));\n    if (m.disc) { const d = makeDisc(m.disc); psx.disc = d; psx.cdrom.setDisc(d); log('Disco: ' + JSON.stringify(d.info())); }\n    for (const slot of [0, 1]) {\n      const c = m.cards[slot]; if (!c) continue;\n      try {\n        if (c.blank) { psx.loadMemoryCard(slot); psx.sio.cards[slot].dirty = true; log(`Cartão ${slot + 1}: em branco`); }\n        else { const r = psx.loadMemoryCard(slot, c.bytes); if (c.dirty) psx.sio.cards[slot].dirty = true; log(`Cartão ${slot + 1}: ${r.saves.map(s => s.code + ' \"' + s.title + '\"').join('; ') || 'vazio'} (${r.livres} livres)`); }\n      } catch (e) { log('Cartão ' + (slot + 1) + ' inválido: ' + e.message); }\n    }\n    psx.reset();\n    for (const p of [0, 1]) if (m.ptype[p]) psx.sio.setPadType(p, m.ptype[p]);\n    psx.sio.onRumble = (p, s, l) => post({ t: 'rumble', p, s, l });\n    psx.gpu.deint = m.deint === undefined ? 1 : m.deint | 0;\n    psx.useJit = m.jit !== false;\n    if (m.wasm !== false) log(psx.enableWasm() ? 'CPU: WebAssembly' : 'CPU: WebAssembly indisponível, usando JIT');\n    psx.pollSkip = m.poll !== false; fskip = m.fskip === true;\n    const side = () => {\n      if (m.side && psx.disc) {\n        log('Sideload: rodando BIOS até o shell...');\n        if (psx.bootToShell()) { const exe = psx.bootDiscExe(); log('EXE carregado: ' + exe.path); } else log('BIOS não chegou ao shell.');\n      }\n    };\n    if (cfg.gpuThread) side();                                              // GPU em thread: o boot do BIOS roda aqui e a VRAM resultante é copiada para o worker\n    await applyRenderer();\n    if (!cfg.gpuThread) side();\n    setGame(); running = true; paused = false; lastT = t0 = performance.now(); acc = 0; frameCount = 0; auto.t = 0;\n    post({ t: 'ready' }); frame();\n  };\n\n  // ---- pedidos com resposta ----\n  const ops = {\n    saveState: async m => { await pullVram(); const raw = psx.saveState({ game: m.game || gameKey }); return [raw, [raw.buffer]]; },\n    loadState: m => { psx.loadState(m.raw); acc = 0; if (R) syncRemote(); return [null]; },\n    cardExport: m => { const c = psx.sio.cards[m.slot]; if (!c) return [null]; const b = c.export(); return [b, [b.buffer]]; },\n    cardLoad: m => { const r = psx.loadMemoryCard(m.slot, m.bytes); psx.sio.cards[m.slot].dirty = true; return [r.saves.map(s => `${s.code} \"${s.title}\"`)]; },\n    lid: m => { if (m.open) { psx.openDiscLid(); lidOpen = true; } else { psx.closeDiscLid(psx.disc); lidOpen = false; } return [null]; },\n    disc: m => { const d = makeDisc(m.disc); psx.closeDiscLid(d); lidOpen = false; setGame(); return [d.info()]; },\n  };\n\n  self.onmessage = async e => {\n    const m = e.data;\n    try {\n      switch (m.t) {\n        case 'init': await init(m); break;\n        case 'audioPort': ap = m.port; ap.onmessage = ev => { aStat = ev.data; aStatT = performance.now(); aAvg = aAvg < 0 ? aStat.ms : aAvg + (aStat.ms - aAvg) * 0.05;\n      const tn = aStatT; if (aStat.under > lastUnder) { if (tn - underT > 2000) alvo = Math.min(160, alvo + 15); lastUnder = aStat.under; underT = tn; } else if (alvo > 70 && tn - underT > 20000) { alvo -= 5; underT = tn; } };   // média suave (~1 s): o nível oscila ±1 quadro entre um bloco e outro break;\n        case 'canvas': if (canvasWait) { const r = canvasWait; canvasWait = null; r(m.canvas); } break;\n        case 'sio': for (const [f, a] of m.calls) { if (f === 'padConnected') psx.sio.padConnected[a[0]] = a[1]; else psx.sio[f](...a); } break;\n        case 'pause': paused = !!m.v; if (!paused) { lastT = t0 = performance.now(); acc = 0; frameCount = 0; auto.t = 0; auto.ran = auto.work = 0; } break;\n        case 'hidden': hidden = !!m.v; if (!hidden) { lastT = performance.now(); acc = 0; } break;\n        case 'turbo': turbo = !!m.v; break;\n        case 'jit': if (!psx.wasm) psx.useJit = !!m.v; break;\n        case 'poll': psx.pollSkip = !!m.v; break;\n        case 'fskip': fskip = !!m.v; if (!fskip && psx) psx.gpu.skipDraw = false; break;\n        case 'deint': psx.gpu.deint = m.v | 0; if (R && gw) gw.postMessage({ t: 'deint', v: m.v | 0 }); break;\n        case 'smooth': cfg.smooth = !!m.v; if (video && video.r) video.r.opts.smooth = cfg.smooth; if (R && gw) gw.postMessage({ t: 'smooth', v: cfg.smooth }); break;\n        case 'gpuThread': cfg.gpuThread = !!m.v; if (psx) applyRenderer(); break;\n        case 'renderer': cfg.mode = m.mode; cfg.smooth = !!m.smooth; if (psx) applyRenderer(); break;\n        case 'analog': { const on = psx.sio.toggleAnalog(m.port || 0); log('Modo analógico: ' + (on ? 'ligado' : 'desligado (ou travado pelo jogo / controle é digital)')); break; }\n        case 'req': {\n          try { const [v, tr] = await ops[m.op](m); post({ t: 'res', id: m.id, ok: true, value: v }, tr || []); }\n          catch (err) { post({ t: 'res', id: m.id, ok: false, err: String(err && err.message || err) }); }\n          break;\n        }\n      }\n    } catch (err) { crash(err); }\n  };\n})();\n";
