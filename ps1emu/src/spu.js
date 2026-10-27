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
import { SPU_B64 } from './wasmspu.js';

export const SPU_RAM_SIZE = 512 * 1024;
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

let compiled = null;
function module_() {
  if (!compiled) { const bin = atob(SPU_B64), u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i); compiled = new WebAssembly.Module(u8); }
  return compiled;
}
const VS = 40, VF = ['addr', 'counter', 'phase', 'level', 'envCnt', 'idx', 'old1', 'old2', 'prev', 'cur', 'repeat', 'loopEnd', 'last', 'h1', 'h2', 'h3', 'flags'];
const acc = (o, name, arr, i, bool) => Object.defineProperty(o, name, bool ? { get: () => arr[i] !== 0, set: v => { arr[i] = v ? 1 : 0; }, enumerable: true } : { get: () => arr[i], set: v => { arr[i] = v; }, enumerable: true });

/** voz: os campos vivem na memória do wasm (V, 40 ints por voz; amostras decodificadas em int16 a partir do int 20) */
class Voice {
  constructor(V, n) {
    const v = V.subarray(n * VS, n * VS + VS);
    VF.forEach((f, i) => acc(this, f, v, i));
    this.samples = new Int16Array(V.buffer, V.byteOffset + (n * VS + 20) * 4, 28);
  }
}
class Sweep { constructor(SW, i) { const a = SW.subarray(i * 4, i * 4 + 4); acc(this, 'reg', a, 0); acc(this, 'level', a, 1); acc(this, 'cnt', a, 2); } }

export class SPU {
  constructor() {
    // todo o estado (RAM do SPU, registradores, vozes, reverb, buffer de CD) vive na memória do wasm (wasm/spu.c)
    const memory = new WebAssembly.Memory({ initial: 17, maximum: 17 });
    const x = new WebAssembly.Instance(module_(), { env: { memory } }).exports, buf = memory.buffer;
    const I32 = (i, n) => new Int32Array(buf, x.ptr(i), n), I16 = (i, n) => new Int16Array(buf, x.ptr(i), n);
    const G = I32(0, 32), V = I32(1, 24 * VS), SW = I32(2, 200), OUT = I16(11, 8192);
    I16(8, 512).set(GAUSS);
    Object.defineProperty(this, '_w', { value: { x, G, OUT, memory, SEC: new Uint8Array(buf, x.ptr(13), 2448), XOLD: I32(14, 4), XPH: new Float64Array(buf, x.ptr(15), 1) }, enumerable: false });
    this.ram = new Uint8Array(buf, x.ptr(12), SPU_RAM_SIZE);
    this.ramView = new DataView(buf, x.ptr(12), SPU_RAM_SIZE);
    this.regs = new Uint16Array(buf, x.ptr(3), 0x200);            // 0x1F801C00 + i*2
    this.voices = Array.from({ length: 24 }, (_, n) => new Voice(V, n));
    for (const v of this.voices) { v.phase = OFF; v.idx = 28; }
    this.xferAddr = 0; this.onIrq = null;
    acc(this, 'endx', G, 0); acc(this, 'irqFlag', G, 1, true); acc(this, 'revPos', G, 3); acc(this, 'revToggle', G, 4); acc(this, 'revOutL', G, 5);
    acc(this, 'revOutR', G, 6); acc(this, 'noise', G, 7); acc(this, 'noiseTimer', G, 8); acc(this, 'sampleCount', G, 9); acc(this, 'revHead', G, 10);
    acc(this, 'cdHead', G, 11); acc(this, 'cdTail', G, 12);
    this.noise = 1;
    // volumes: 0..47 = voz n (L = 2n, R = 2n+1), 48/49 = principal L/R. level é o valor atual (com sinal).
    this.sw = Array.from({ length: 50 }, (_, i) => new Sweep(SW, i));
    this.revHL = I32(4, 64); this.revHR = I32(5, 64); this.revUL = I32(6, 64); this.revUR = I32(7, 64);
    this.cdBufL = I16(9, 65536); this.cdBufR = I16(10, 65536);   // áudio do CD (XA/CDDA)
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
  keyOn(n) { this._w.x.key_on(n); this._irq(); }
  keyOff(n) { const v = this.voices[n]; if (v.phase !== OFF) { v.phase = RELEASE; v.envCnt = 0; } }
  _irq() { const G = this._w.G; if (G[2]) { G[2] = 0; this.onIrq?.(); } }

  /** gera 1 amostra estéreo (44.1kHz) */
  tick() { this._w.x.render(1); this._irq(); const o = this._w.OUT; return [o[0], o[1]]; }
  /** gera `frames` (<= 4096) amostras no buffer interno do wasm e devolve a view (L,R,L,R...) — válida até a próxima chamada */
  renderRaw(frames) { this._w.x.render(frames); this._irq(); return this._w.OUT; }

  volume(v) { return s16((v & 0x7FFF) << 1); }
  /** um passo do motor de reverb a 22,05 kHz (uso em testes) */
  reverbStep(inL, inR) { this._w.x.rev_step(inL, inR); this._irq(); }

  /** Gera `frames` amostras estéreo intercaladas (Int16Array L,R,L,R...) */
  render(frames, out) {
    out = out ?? new Int16Array(frames * 2);
    for (let i = 0; i < frames;) { const k = Math.min(4096, frames - i), o = this.renderRaw(k); out.set(o.subarray(0, k * 2), i * 2); i += k; }
    return out;
  }

  /** Entrada de áudio do CD (amostras estéreo já em 44.1kHz) */
  pushCd(l, r) {
    const G = this._w.G, t = G[12], n = (t + 1) & 0xFFFF; if (n === G[11]) return;      // cheio
    this.cdBufL[t] = sat16(l | 0); this.cdBufR[t] = sat16(r | 0); G[12] = n;
  }
}
