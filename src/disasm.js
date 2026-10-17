// Disassembler MIPS I (R3000A) - usado para trace/debug
import { REG_NAMES } from './cpu.js';
const R = REG_NAMES.map(n => '$' + n);
const h = (v, n = 8) => '0x' + (v >>> 0).toString(16).padStart(n, '0');

export function disasm(w, pc) {
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
