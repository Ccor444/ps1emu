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
import { GTE } from './gte.js';

export const EXC = { INT: 0, ADEL: 4, ADES: 5, IBE: 6, DBE: 7, SYS: 8, BP: 9, RI: 10, CPU: 11, OV: 12 };

export const REG_NAMES = [
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

export const RESET_VECTOR = 0xBFC00000;

// custo extra (ciclos, além do 1 da instrução) de um load, por região e largura (1/2/4 bytes).
// Valores medidos no PS1 real com ps1-tests/cpu/access-time (ciclos por acesso - 1).
export const LD_RAM = 4;
export function memCost(a, size = 4) {
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

export class CPU {
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

export const hex = (v, n = 8) => (v >>> 0).toString(16).toUpperCase().padStart(n, '0');
