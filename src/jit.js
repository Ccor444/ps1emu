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
import { EXC, memCost, LD_RAM } from './cpu.js';

const MAX_BLOCK = 48;
const INTERP = function interp() {};            // sentinela: "este PC é executado pelo interpretador"

const isBranchWord = w => {
  const op = w >>> 26;
  return op === 1 || (op >= 2 && op <= 7) || (op === 0 && ((w & 0x3F) === 8 || (w & 0x3F) === 9));
};

export class JIT {
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
