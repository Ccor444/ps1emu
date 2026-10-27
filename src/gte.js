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

export class GTE {
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
