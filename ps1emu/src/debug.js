// ============================================================================
//  Depurador / tracer: registradores, desmontagem, passo a passo, breakpoints, trace e relatório de falha.
//  Breakpoints e trace usam o interpretador (JIT desligado enquanto estiverem ativos): ficam mais lentos.
// ============================================================================
import { disasm } from './disasm.js';

const hex = (v, n = 8) => (v >>> 0).toString(16).padStart(n, '0');
const RN = ['zr', 'at', 'v0', 'v1', 'a0', 'a1', 'a2', 'a3', 't0', 't1', 't2', 't3', 't4', 't5', 't6', 't7',
            's0', 's1', 's2', 's3', 's4', 's5', 's6', 's7', 't8', 't9', 'k0', 'k1', 'gp', 'sp', 'fp', 'ra'];

// só lê memória sem efeito colateral (RAM, scratchpad, BIOS); registradores de I/O não são tocados
const safe = a => { const p = a & 0x1FFFFFFF; return p < 0x800000 || (p >= 0x1FC00000 && p < 0x1FC80000) || (p >= 0x1F800000 && p < 0x1F800400); };

export class Debugger {
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
