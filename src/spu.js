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
import { GAUSS } from './gauss.js';

export const SPU_RAM_SIZE = 512 * 1024;
const POS = [0, 60, 115, 98, 122], NEG = [0, 0, -52, -55, -60];
const sat16 = v => v > 32767 ? 32767 : v < -32768 ? -32768 : v;
const s16 = v => (v << 16) >> 16;

const R = { MAINL: 0x1D80, MAINR: 0x1D82, REVL: 0x1D84, REVR: 0x1D86, KONL: 0x1D88, KONH: 0x1D8A, KOFFL: 0x1D8C, KOFFH: 0x1D8E,
  PMONL: 0x1D90, PMONH: 0x1D92, NONL: 0x1D94, NONH: 0x1D96, EONL: 0x1D98, EONH: 0x1D9A, ENDXL: 0x1D9C, ENDXH: 0x1D9E,
  REVBASE: 0x1DA2, IRQADDR: 0x1DA4, XFERADDR: 0x1DA6, FIFO: 0x1DA8, CNT: 0x1DAA, XFERCTL: 0x1DAC, STAT: 0x1DAE, CDVOL: 0x1DB0, REVREGS: 0x1DC0 };

// FIR de reamostragem do reverb (39 taps; soma = 0x7FFE ~ ganho 1,0 em >>15)
export const REV_FIR = new Int32Array([-1, 0, 2, 0, -10, 0, 35, 0, -103, 0, 266, 0, -616, 0, 1332, 0, -2960, 0, 10246, 0x4000,
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

export class SPU {
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
