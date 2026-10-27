// Blocos pré-decodificados ("tradução para micro-ops") para o interpretador da CPU — incluído por cpu.c.
// Um bloco = sequência linear de instruções que começa num PC e termina num branch/jump + delay slot, SYSCALL/BREAK/RI, MTC0 em SR/CAUSE, RFE
// ou MAXB instruções. Cada instrução vira 1 micro-op com os campos já extraídos; o executor roda o bloco num laço único, sem refazer
// fetch/decodificação/checagens a cada instrução. Semântica = interpretador (execute): delay slots, load delay, exceções e ciclos exatos.
//   - load delay: resolvido na tradução (a carga cancelada por escrita da instrução seguinte vira escrita no registrador "lixo" R[32]);
//     uma carga no fim do bloco cruza para PENDR/PENDV (o despachante só entra em blocos com PENDR == 0, senão interpreta);
//   - ciclos: custo estático por instrução (1 + fetch KSEG1 + 4 se lê memória) + correção dinâmica `dyn` (scratchpad/BIOS/E-S);
//     antes de cada acesso lento o relógio exato é gravado em CYC (a E/S do JS enxerga o mesmo tempo do interpretador);
//   - invalidação: linhas de 64 B da RAM com código marcadas em CF[]; escrita nelas (CPU/DMA) descarta os blocos da linha.
#define MAXB 48
#define POOL 49152
#define NNODE 32768
typedef struct { u8 op, a, b, c; i32 imm; u16 pre, idx; } Op;       // idx: bit 15 = delay slot
typedef struct { u32 first; u16 n, total; } Blk;
static Op OPS[POOL];
static Blk BLK[NBT];
static u16 LH[32768], NSL[NNODE], NNX[NNODE];                         // lista de blocos por linha de 64 B
static u32 opsUsed = 0, nodeUsed = 1;

enum { O_NOP, O_SLL, O_SRL, O_SRA, O_SLLV, O_SRLV, O_SRAV, O_JR, O_JALR, O_SYSCALL, O_BREAK, O_MFHI, O_MTHI, O_MFLO, O_MTLO, O_MULT, O_MULTU, O_DIV, O_DIVU,
  O_ADD, O_ADDU, O_SUB, O_SUBU, O_AND, O_OR, O_XOR, O_NOR, O_SLT, O_SLTU, O_BLTZ, O_BGEZ, O_BLTZAL, O_BGEZAL, O_J, O_JAL, O_BEQ, O_BNE, O_BLEZ, O_BGTZ,
  O_ADDI, O_ADDIU, O_SLTI, O_SLTIU, O_ANDI, O_ORI, O_XORI, O_LUI, O_MFC0, O_MTC0, O_RFE, O_GCMD, O_MFC2, O_CFC2, O_MTC2, O_CTC2, O_CPU, O_RI,
  O_LB, O_LH, O_LW, O_LBU, O_LHU, O_LWL, O_LWR, O_LWC2, O_SB, O_SH, O_SW, O_SWL, O_SWR, O_SWC2 };

static void blkFlush(void) {
  for (u32 i = 0; i < NBT; i++) BTK[i] = 1;
  for (u32 i = 0; i < 32768; i++) { LH[i] = 0; CF[i] = 0; }
  for (u32 i = 0; i < 65536; i++) HOT[i] = 0;
  opsUsed = 0; nodeUsed = 1;
}
__attribute__((export_name("blk_flush"))) void blk_flush(void) { blkFlush(); }
static void inval(u32 l) {
  for (u32 n = LH[l]; n; n = NNX[n]) { u32 sl = NSL[n]; BTK[sl] = 1; BLK[sl].n = 0; }
  LH[l] = 0; CF[l] = 0;
}
__attribute__((export_name("blk_inval"))) void blk_inval(u32 l) { inval(l); }

static inline int isIO(u32 a) { u32 p = a & 0x1FFFFFFFu; return p >= 0x1F000000u && p < 0x1FC00000u && (p - 0x1F800000u) >= 0x400u; }
static inline u32 fetchCost(u32 a) { return (a >> 29) == 5 ? (((a & 0x1FFFFFFFu) >= 0x1FC00000u) ? 22u : 4u) : 0u; }

// registrador escrito por setR (cancela uma carga pendente do mesmo registrador); 0 = nenhum
static u32 writesReg(u32 w) {
  u32 op = w >> 26, rt = (w >> 16) & 31, rd = (w >> 11) & 31;
  switch (op) {
    case 0: switch (w & 0x3F) { case 0x00: case 0x02: case 0x03: case 0x04: case 0x06: case 0x07: case 0x09: case 0x10: case 0x12: case 0x20: case 0x21: case 0x22: case 0x23:
        case 0x24: case 0x25: case 0x26: case 0x27: case 0x2A: case 0x2B: return rd; default: return 0; }
    case 1: return ((rt & 0x1E) == 0x10) ? 31 : 0;
    case 3: return 31;
    case 8: case 9: case 10: case 11: case 12: case 13: case 14: case 15: return rt;
    default: return 0;
  }
}
// registradores lidos pela instrução (bitmask); LWL/LWR não contam o rt (o interpretador encaminha o valor da carga pendente: escrever direto dá o mesmo)
static u32 srcMask(u32 w) {
  u32 op = w >> 26, rs = (w >> 21) & 31, rt = (w >> 16) & 31, m = 0;
  switch (op) {
    case 0: switch (w & 0x3F) { case 0x00: case 0x02: case 0x03: m = 1u << rt; break; case 0x08: case 0x09: case 0x11: case 0x13: m = 1u << rs; break;
        case 0x0C: case 0x0D: case 0x10: case 0x12: m = 0; break; default: m = (1u << rs) | (1u << rt); } break;
    case 1: case 6: case 7: m = 1u << rs; break;
    case 2: case 3: m = 0; break;
    case 4: case 5: m = (1u << rs) | (1u << rt); break;
    case 0x0F: m = 0; break;
    case 0x10: m = (rs == 4) ? (1u << rt) : 0; break;
    case 0x12: m = (!(w & 0x02000000u) && (rs == 4 || rs == 6)) ? (1u << rt) : 0; break;
    case 0x28: case 0x29: case 0x2A: case 0x2B: case 0x2E: m = (1u << rs) | (1u << rt); break;
    default: m = 1u << rs;                               // ALU imediato, cargas, LWC2/SWC2
  }
  return m & ~1u;
}
static inline int isBranchW(u32 w) { u32 op = w >> 26; return op == 1 || (op >= 2 && op <= 7) || (op == 0 && ((w & 0x3F) == 8 || (w & 0x3F) == 9)); }
static inline u32 memWord(u32 phys) {   // palavra da RAM ou da BIOS
  if (phys < 0x800000u) return *(u32 *)(RAM + (phys & 0x1FFFFFu));
  return *(u32 *)(BIOS + (phys - 0x1FC00000u));
}

// 1 = tradução ok (BTK/BLK preenchidos); 0 = não traduzível (slot marcado: n = 0 -> interpretar)
static int translate(u32 pc) {
  const u32 h = (pc >> 2) & (NBT - 1), seg = pc >> 29;
  u32 phys = seg < 4 ? pc : seg == 4 ? (pc & 0x7FFFFFFFu) : (pc & 0x1FFFFFFFu);
  BTK[h] = pc; BLK[h].n = 0;
  if (seg >= 6 || (pc & 3) || phys < 0x100u) return 0;
  const int ram = phys < 0x800000u;
  if (!ram && !(phys >= 0x1FC00000u && phys < 0x1FC80000u)) return 0;
  if (opsUsed + MAXB + 2 > POOL || nodeUsed + 8 > NNODE) { blkFlush(); BTK[h] = pc; BLK[h].n = 0; }
  const u32 first = opsUsed; u32 n = 0, cost = 0, prevLoad = 0; int inDelay = 0, ended = 0;
  while (!ended && n < MAXB) {
    const u32 ia = pc + 4 * n, ip = phys + 4 * n;
    if (ram ? ip >= 0x800000u : ip >= 0x1FC80000u) break;
    const u32 w = memWord(ip), op = w >> 26, rs = (w >> 21) & 31, rt = (w >> 16) & 31, rd = (w >> 11) & 31, sh = (w >> 6) & 31;
    const i32 simm = (i32)(w << 16) >> 16; const u32 imm = w & 0xFFFF;
    if (prevLoad && (srcMask(w) & (1u << prevLoad))) { n--; cost = OPS[first + n].pre; break; }       // lê o valor ANTIGO do destino da carga: o bloco termina antes dela (o interpretador resolve o par)
    Op *o = &OPS[first + n]; o->op = O_NOP; o->a = o->b = o->c = 0; o->imm = 0; o->pre = (u16)cost; o->idx = (u16)(n | (inDelay ? 0x8000 : 0));
    u32 c = 1 + fetchCost(ia); int load = 0, term = 0, br = 0;
    const u32 d = rd ? rd : 32, dt = rt ? rt : 32;                 // destino "lixo" para $0
    if (isBranchW(w)) {
      if (inDelay) break;                                           // branch no delay slot: o bloco termina antes (nunca acontece: ver abaixo)
      br = 1;
    }
    if (inDelay && isBranchW(w)) break;
    switch (op) {
      case 0x00:
        switch (w & 0x3F) {
          case 0x00: if (w == 0) { o->op = O_NOP; } else { o->op = O_SLL; o->a = d; o->c = rt; o->imm = sh; } break;
          case 0x02: o->op = O_SRL; o->a = d; o->c = rt; o->imm = sh; break;
          case 0x03: o->op = O_SRA; o->a = d; o->c = rt; o->imm = sh; break;
          case 0x04: o->op = O_SLLV; o->a = d; o->b = rs; o->c = rt; break;
          case 0x06: o->op = O_SRLV; o->a = d; o->b = rs; o->c = rt; break;
          case 0x07: o->op = O_SRAV; o->a = d; o->b = rs; o->c = rt; break;
          case 0x08: o->op = O_JR; o->b = rs; break;
          case 0x09: o->op = O_JALR; o->a = d; o->b = rs; break;
          case 0x0C: o->op = O_SYSCALL; term = 1; break;
          case 0x0D: o->op = O_BREAK; term = 1; break;
          case 0x10: o->op = O_MFHI; o->a = d; break;
          case 0x11: o->op = O_MTHI; o->b = rs; break;
          case 0x12: o->op = O_MFLO; o->a = d; break;
          case 0x13: o->op = O_MTLO; o->b = rs; break;
          case 0x18: o->op = O_MULT; o->b = rs; o->c = rt; break;
          case 0x19: o->op = O_MULTU; o->b = rs; o->c = rt; break;
          case 0x1A: o->op = O_DIV; o->b = rs; o->c = rt; break;
          case 0x1B: o->op = O_DIVU; o->b = rs; o->c = rt; break;
          case 0x20: o->op = O_ADD; o->a = d; o->b = rs; o->c = rt; break;
          case 0x21: o->op = O_ADDU; o->a = d; o->b = rs; o->c = rt; break;
          case 0x22: o->op = O_SUB; o->a = d; o->b = rs; o->c = rt; break;
          case 0x23: o->op = O_SUBU; o->a = d; o->b = rs; o->c = rt; break;
          case 0x24: o->op = O_AND; o->a = d; o->b = rs; o->c = rt; break;
          case 0x25: o->op = O_OR; o->a = d; o->b = rs; o->c = rt; break;
          case 0x26: o->op = O_XOR; o->a = d; o->b = rs; o->c = rt; break;
          case 0x27: o->op = O_NOR; o->a = d; o->b = rs; o->c = rt; break;
          case 0x2A: o->op = O_SLT; o->a = d; o->b = rs; o->c = rt; break;
          case 0x2B: o->op = O_SLTU; o->a = d; o->b = rs; o->c = rt; break;
          default: o->op = O_RI; term = 1;
        }
        break;
      case 0x01: o->op = (rt & 1) ? ((rt & 0x1E) == 0x10 ? O_BGEZAL : O_BGEZ) : ((rt & 0x1E) == 0x10 ? O_BLTZAL : O_BLTZ); o->b = rs; o->imm = (i32)(ia + 4 + ((u32)simm << 2)); break;
      case 0x02: o->op = O_J; o->imm = (i32)(((ia + 4) & 0xF0000000u) | ((w & 0x3FFFFFFu) << 2)); break;
      case 0x03: o->op = O_JAL; o->imm = (i32)(((ia + 4) & 0xF0000000u) | ((w & 0x3FFFFFFu) << 2)); break;
      case 0x04: o->op = O_BEQ; o->b = rs; o->c = rt; o->imm = (i32)(ia + 4 + ((u32)simm << 2)); break;
      case 0x05: o->op = O_BNE; o->b = rs; o->c = rt; o->imm = (i32)(ia + 4 + ((u32)simm << 2)); break;
      case 0x06: o->op = O_BLEZ; o->b = rs; o->imm = (i32)(ia + 4 + ((u32)simm << 2)); break;
      case 0x07: o->op = O_BGTZ; o->b = rs; o->imm = (i32)(ia + 4 + ((u32)simm << 2)); break;
      case 0x08: o->op = O_ADDI; o->a = dt; o->b = rs; o->imm = simm; break;
      case 0x09: o->op = O_ADDIU; o->a = dt; o->b = rs; o->imm = simm; break;
      case 0x0A: o->op = O_SLTI; o->a = dt; o->b = rs; o->imm = simm; break;
      case 0x0B: o->op = O_SLTIU; o->a = dt; o->b = rs; o->imm = simm; break;
      case 0x0C: o->op = O_ANDI; o->a = dt; o->b = rs; o->imm = (i32)imm; break;
      case 0x0D: o->op = O_ORI; o->a = dt; o->b = rs; o->imm = (i32)imm; break;
      case 0x0E: o->op = O_XORI; o->a = dt; o->b = rs; o->imm = (i32)imm; break;
      case 0x0F: o->op = O_LUI; o->a = dt; o->imm = (i32)(imm << 16); break;
      case 0x10:
        if (rs == 0x00) { o->op = O_MFC0; o->a = rt; o->imm = rd; load = 2; }
        else if (rs == 0x04) { o->op = O_MTC0; o->c = rt; o->imm = rd; if (rd == 12 || rd == 13) term = 1; }
        else if (rs == 0x10) { if ((w & 0x3F) == 0x10) { o->op = O_RFE; term = 1; } else { o->op = O_RI; term = 1; } }
        else o->op = O_NOP;
        break;
      case 0x12:
        if (w & 0x02000000u) { o->op = O_GCMD; o->imm = (i32)(w & 0x1FFFFFFu); }
        else if (rs == 0x00) { o->op = O_MFC2; o->a = rt; o->imm = rd; load = 2; }
        else if (rs == 0x02) { o->op = O_CFC2; o->a = rt; o->imm = rd; load = 2; }
        else if (rs == 0x04) { o->op = O_MTC2; o->c = rt; o->imm = rd; }
        else if (rs == 0x06) { o->op = O_CTC2; o->c = rt; o->imm = rd; }
        else { o->op = O_RI; term = 1; }
        break;
      case 0x11: case 0x13: case 0x30: case 0x31: case 0x33: case 0x38: case 0x39: case 0x3B: o->op = O_CPU; o->imm = (i32)(op & 3); break;
      case 0x20: o->op = O_LB; o->a = rt; o->b = rs; o->imm = simm; load = 1; break;
      case 0x21: o->op = O_LH; o->a = rt; o->b = rs; o->imm = simm; load = 1; break;
      case 0x23: o->op = O_LW; o->a = rt; o->b = rs; o->imm = simm; load = 1; break;
      case 0x24: o->op = O_LBU; o->a = rt; o->b = rs; o->imm = simm; load = 1; break;
      case 0x25: o->op = O_LHU; o->a = rt; o->b = rs; o->imm = simm; load = 1; break;
      case 0x22: o->op = O_LWL; o->a = rt; o->b = rs; o->c = rt; o->imm = simm; load = 1; break;
      case 0x26: o->op = O_LWR; o->a = rt; o->b = rs; o->c = rt; o->imm = simm; load = 1; break;
      case 0x32: o->op = O_LWC2; o->b = rs; o->c = rt; o->imm = simm; c += 4; break;
      case 0x28: o->op = O_SB; o->b = rs; o->c = rt; o->imm = simm; break;
      case 0x29: o->op = O_SH; o->b = rs; o->c = rt; o->imm = simm; break;
      case 0x2B: o->op = O_SW; o->b = rs; o->c = rt; o->imm = simm; break;
      case 0x2A: o->op = O_SWL; o->b = rs; o->c = rt; o->imm = simm; c += 4; break;
      case 0x2E: o->op = O_SWR; o->b = rs; o->c = rt; o->imm = simm; c += 4; break;
      case 0x3A: o->op = O_SWC2; o->b = rs; o->c = rt; o->imm = simm; break;
      default: o->op = O_RI; term = 1;
    }
    if (load == 1) c += 4;
    // carga cancelada pela instrução seguinte (setR no mesmo registrador) ou destino $0 -> escreve no registrador "lixo"
    if (load) {
      u32 dst = o->a;
      if (dst == 0) o->a = 32;
      else if (!inDelay && n + 1 < MAXB) {
        const u32 np = ip + 4;
        if (!(ram ? np >= 0x800000u : np >= 0x1FC80000u) && writesReg(memWord(np)) == dst) o->a = 32;
      }
    }
    prevLoad = (load && o->a != 32) ? o->a : 0;
    cost += c; n++;
    if (term) ended = 1;
    if (inDelay) ended = 1;
    else if (br) inDelay = 1;
    (void)rd;
  }
  if (inDelay && !ended && n) {}                                       // (bloco cortado por MAXB entre branch e delay slot: tratado abaixo)
  if (n == 0) return 0;
  // se o último é um branch sem delay slot dentro do limite, descarta o branch (o interpretador o executa)
  if (inDelay && !ended) { n--; if (n == 0) return 0; cost = OPS[first + n].pre; }
  if (cost > 0xFFFF) return 0;
  // marca as linhas da RAM
  if (ram) {
    u32 p0 = phys & 0x1FFFFFu, p1 = (phys + 4 * n - 1) & 0x1FFFFFu;
    for (u32 l = p0 >> 6; ; l = (l + 1) & 32767) {
      u32 nd = nodeUsed++; NSL[nd] = (u16)h; NNX[nd] = LH[l]; LH[l] = (u16)nd; CF[l] = 1;
      if (l == (p1 >> 6)) break;
    }
  }
  opsUsed = first + n; BLK[h].first = first; BLK[h].n = (u16)n; BLK[h].total = (u16)cost;
  return 1;
}

// carga: escreve direto; só a última operação do bloco deixa a carga pendente (cruza para o próximo bloco/interpretador)
#define LDW(val) do { const u32 v_ = (val); if (op + 1 == end) { pr = op->a; pv = v_; } else R[op->a] = v_; } while (0)
#define RAMOK(a) ((((a) & 0x1F800000u) == 0) && ((0x31u >> ((a) >> 29)) & 1))
// executa o bloco `h` (PC == chave). O estado (hi/lo/pc/npc/ciclos...) fica em `s`.
static void runBlock(St *s, u32 h) {
  const Blk *b = &BLK[h]; const u32 pcb = BTK[h]; const Op *op = &OPS[b->first], *end = op + b->n;
  double base = CYC; i32 dyn = 0; u32 pr = 0, pv = 0, tgt = 0, taken = 0, ecode = 0, ecop = 0, ebad = 0, ehas = 0, stop = 0;
  for (; op != end; op++) {
    switch (op->op) {
      case O_NOP: break;
      case O_SLL: R[op->a] = R[op->c] << op->imm; break;
      case O_SRL: R[op->a] = R[op->c] >> op->imm; break;
      case O_SRA: R[op->a] = (u32)((i32)R[op->c] >> op->imm); break;
      case O_SLLV: R[op->a] = R[op->c] << (R[op->b] & 31); break;
      case O_SRLV: R[op->a] = R[op->c] >> (R[op->b] & 31); break;
      case O_SRAV: R[op->a] = (u32)((i32)R[op->c] >> (R[op->b] & 31)); break;
      case O_JR: tgt = R[op->b]; taken = 1; break;
      case O_JALR: { u32 t = R[op->b]; R[op->a] = pcb + 4 * (op->idx & 0x7FFF) + 8; tgt = t; taken = 1; break; }
      case O_SYSCALL: ecode = X_SYS; goto EXC;
      case O_BREAK: ecode = X_BP; goto EXC;
      case O_RI: ecode = X_RI; goto EXC;
      case O_MFHI: R[op->a] = HI; break;
      case O_MTHI: HI = R[op->b]; break;
      case O_MFLO: R[op->a] = LO; break;
      case O_MTLO: LO = R[op->b]; break;
      case O_MULT: { i64 p = (i64)(i32)R[op->b] * (i64)(i32)R[op->c]; LO = (u32)p; HI = (u32)((u64)p >> 32); break; }
      case O_MULTU: { u64 p = (u64)R[op->b] * (u64)R[op->c]; LO = (u32)p; HI = (u32)(p >> 32); break; }
      case O_DIV: { i32 n = (i32)R[op->b], d = (i32)R[op->c];
        if (d == 0) { HI = (u32)n; LO = n >= 0 ? 0xFFFFFFFFu : 1u; } else if (n == (i32)0x80000000 && d == -1) { HI = 0; LO = 0x80000000u; } else { LO = (u32)(n / d); HI = (u32)(n % d); } break; }
      case O_DIVU: { u32 n = R[op->b], d = R[op->c]; if (d == 0) { HI = n; LO = 0xFFFFFFFFu; } else { LO = n / d; HI = n % d; } break; }
      case O_ADD: { i32 x = (i32)R[op->b], y = (i32)R[op->c]; i32 sm = (i32)((u32)x + (u32)y); if (((x ^ sm) & (y ^ sm)) < 0) { ecode = X_OV; goto EXC; } R[op->a] = (u32)sm; break; }
      case O_ADDU: R[op->a] = R[op->b] + R[op->c]; break;
      case O_SUB: { i32 x = (i32)R[op->b], y = (i32)R[op->c]; i32 sm = (i32)((u32)x - (u32)y); if (((x ^ y) & (x ^ sm)) < 0) { ecode = X_OV; goto EXC; } R[op->a] = (u32)sm; break; }
      case O_SUBU: R[op->a] = R[op->b] - R[op->c]; break;
      case O_AND: R[op->a] = R[op->b] & R[op->c]; break;
      case O_OR: R[op->a] = R[op->b] | R[op->c]; break;
      case O_XOR: R[op->a] = R[op->b] ^ R[op->c]; break;
      case O_NOR: R[op->a] = ~(R[op->b] | R[op->c]); break;
      case O_SLT: R[op->a] = (i32)R[op->b] < (i32)R[op->c]; break;
      case O_SLTU: R[op->a] = R[op->b] < R[op->c]; break;
      case O_BLTZ: tgt = (u32)op->imm; taken = (i32)R[op->b] < 0; break;
      case O_BGEZ: tgt = (u32)op->imm; taken = (i32)R[op->b] >= 0; break;
      case O_BLTZAL: { i32 v = (i32)R[op->b]; R[31] = pcb + 4 * (op->idx & 0x7FFF) + 8; tgt = (u32)op->imm; taken = v < 0; break; }
      case O_BGEZAL: { i32 v = (i32)R[op->b]; R[31] = pcb + 4 * (op->idx & 0x7FFF) + 8; tgt = (u32)op->imm; taken = v >= 0; break; }
      case O_J: tgt = (u32)op->imm; taken = 1; break;
      case O_JAL: R[31] = pcb + 4 * (op->idx & 0x7FFF) + 8; tgt = (u32)op->imm; taken = 1; break;
      case O_BEQ: tgt = (u32)op->imm; taken = R[op->b] == R[op->c]; break;
      case O_BNE: tgt = (u32)op->imm; taken = R[op->b] != R[op->c]; break;
      case O_BLEZ: tgt = (u32)op->imm; taken = (i32)R[op->b] <= 0; break;
      case O_BGTZ: tgt = (u32)op->imm; taken = (i32)R[op->b] > 0; break;
      case O_ADDI: { i32 x = (i32)R[op->b], sm = (i32)((u32)x + (u32)op->imm); if (((x ^ sm) & (op->imm ^ sm)) < 0) { ecode = X_OV; goto EXC; } R[op->a] = (u32)sm; break; }
      case O_ADDIU: R[op->a] = R[op->b] + (u32)op->imm; break;
      case O_SLTI: R[op->a] = (i32)R[op->b] < op->imm; break;
      case O_SLTIU: R[op->a] = R[op->b] < (u32)op->imm; break;
      case O_ANDI: R[op->a] = R[op->b] & (u32)op->imm; break;
      case O_ORI: R[op->a] = R[op->b] | (u32)op->imm; break;
      case O_XORI: R[op->a] = R[op->b] ^ (u32)op->imm; break;
      case O_LUI: R[op->a] = (u32)op->imm; break;
      case O_MFC0: LDW(C0[op->imm]); break;
      case O_MTC0: writeCop0((u32)op->imm, R[op->c]); break;
      case O_RFE: { u32 sr = C0[12]; C0[12] = (sr & 0xFFFFFFF0u) | ((sr >> 2) & 0xFu); break; }
      case O_GCMD: if (!(C0[12] & SR_CU2)) { ecode = X_CPU; ecop = 2; goto EXC; } gcmd((u32)op->imm); break;
      case O_MFC2: if (!(C0[12] & SR_CU2)) { ecode = X_CPU; ecop = 2; goto EXC; } LDW(gteReadData((u32)op->imm)); break;
      case O_CFC2: if (!(C0[12] & SR_CU2)) { ecode = X_CPU; ecop = 2; goto EXC; } LDW(gteReadCtrl((u32)op->imm)); break;
      case O_MTC2: if (!(C0[12] & SR_CU2)) { ecode = X_CPU; ecop = 2; goto EXC; } gteWriteData((u32)op->imm, R[op->c]); break;
      case O_CTC2: if (!(C0[12] & SR_CU2)) { ecode = X_CPU; ecop = 2; goto EXC; } gteWriteCtrl((u32)op->imm, R[op->c]); break;
      case O_CPU: if (!(C0[12] & (0x10000000u << op->imm))) { ecode = X_CPU; ecop = (u32)op->imm; goto EXC; } break;

#define LD_ADDR(size) u32 ad = R[op->b] + (u32)op->imm; if (ad & ((size) - 1)) { ecode = X_ADEL; ebad = ad; ehas = 1; goto EXC; }
// leitura de `size` bytes em `ad` -> v (RAM direto; resto: custo dinâmico + relógio exato + barramento)
#define READMEM(size, v) do { \
        if (RAMOK(ad)) { const u32 o_ = ad & 0x1FFFFFu; v = (size) == 4 ? *(u32 *)(RAM + o_) : (size) == 2 ? *(u16 *)(RAM + o_) : RAM[o_]; } \
        else { u32 mc_ = memCost(ad, (size)); double ck_ = base + op->pre + fetchCost(pcb + 4 * (op->idx & 0x7FFF)) + dyn + mc_; dyn += (i32)mc_ - 4; \
          CYC = ck_; v = busRead(s, ad, (size)); base += CYC - ck_; if (g_js) stop = 1; } } while (0)
      case O_LB: { LD_ADDR(1) u32 v; READMEM(1, v); LDW((u32)((i32)(v << 24) >> 24)); break; }
      case O_LH: { LD_ADDR(2) u32 v; READMEM(2, v); LDW((u32)((i32)(v << 16) >> 16)); break; }
      case O_LW: { LD_ADDR(4) u32 v; READMEM(4, v); LDW(v); break; }
      case O_LBU: { LD_ADDR(1) u32 v; READMEM(1, v); LDW(v); break; }
      case O_LHU: { LD_ADDR(2) u32 v; READMEM(2, v); LDW(v); break; }
      case O_LWL: case O_LWR: {
        u32 a = R[op->b] + (u32)op->imm, ad = a & ~3u, m; READMEM(4, m);
        u32 c = R[op->c], v;
        if (op->op == O_LWL) { switch (a & 3) { case 0: v = (c & 0x00FFFFFFu) | (m << 24); break; case 1: v = (c & 0x0000FFFFu) | (m << 16); break; case 2: v = (c & 0x000000FFu) | (m << 8); break; default: v = m; } }
        else { switch (a & 3) { case 0: v = m; break; case 1: v = (c & 0xFF000000u) | (m >> 8); break; case 2: v = (c & 0xFFFF0000u) | (m >> 16); break; default: v = (c & 0xFFFFFF00u) | (m >> 24); } }
        LDW(v); break; }
      case O_LWC2: { if (!(C0[12] & SR_CU2)) { ecode = X_CPU; ecop = 2; goto EXC; } LD_ADDR(4) u32 v; READMEM(4, v); gteWriteData(op->c, v); break; }
#define WRITEMEM(size, val) do { \
        if (RAMOK(ad)) { const u32 o_ = ad & 0x1FFFFFu; if ((size) == 4) *(u32 *)(RAM + o_) = (val); else if ((size) == 2) *(u16 *)(RAM + o_) = (u16)(val); else RAM[o_] = (u8)(val); if (CF[o_ >> 6]) inval(o_ >> 6); } \
        else { double ck_ = base + op->pre + fetchCost(pcb + 4 * (op->idx & 0x7FFF)) + dyn; CYC = ck_; busWrite(s, ad, (size), (val)); base += CYC - ck_; if (g_js) stop = 1; } } while (0)
#define ST_ADDR(size) u32 ad = R[op->b] + (u32)op->imm; if (ad & ((size) - 1)) { ecode = X_ADES; ebad = ad; ehas = 1; goto EXC; }
      case O_SB: { ST_ADDR(1) WRITEMEM(1, R[op->c] & 0xFF); break; }
      case O_SH: { ST_ADDR(2) WRITEMEM(2, R[op->c] & 0xFFFF); break; }
      case O_SW: { ST_ADDR(4) WRITEMEM(4, R[op->c]); break; }
      case O_SWL: case O_SWR: {
        u32 a = R[op->b] + (u32)op->imm, ad = a & ~3u, m, v, t = R[op->c]; READMEM(4, m);
        if (op->op == O_SWL) { switch (a & 3) { case 0: v = (m & 0xFFFFFF00u) | (t >> 24); break; case 1: v = (m & 0xFFFF0000u) | (t >> 16); break; case 2: v = (m & 0xFF000000u) | (t >> 8); break; default: v = t; } }
        else { switch (a & 3) { case 0: v = t; break; case 1: v = (m & 0x000000FFu) | (t << 8); break; case 2: v = (m & 0x0000FFFFu) | (t << 16); break; default: v = (m & 0x00FFFFFFu) | (t << 24); } }
        WRITEMEM(4, v); break; }
      case O_SWC2: { if (!(C0[12] & SR_CU2)) { ecode = X_CPU; ecop = 2; goto EXC; } ST_ADDR(4) WRITEMEM(4, gteReadData(op->c)); break; }
      default: ecode = X_RI; goto EXC;
    }
    if (__builtin_expect(stop, 0)) { op++; break; }
    continue;
  EXC: {
      const u32 i = op->idx & 0x7FFF, cur = pcb + 4 * i;
      CYC = base + op->pre + 1 + fetchCost(cur) + dyn; ICNT += i + 1;
      s->cur = cur; s->indelay = (op->idx & 0x8000) != 0;
      if (ehas) C0[8] = ebad;
      exc(s, ecode, ecop);
      PENDR = 0; PENDV = 0; R[0] = 0;
      return;
    }
  }
  { const u32 k = (u32)(op - &OPS[b->first]), full = (op == end);
    CYC = base + (full ? (u32)b->total : (u32)op->pre) + dyn; ICNT += k;
    const u32 np = (full && taken) ? tgt : pcb + 4 * k; PC = np; NPC = np + 4; ISBR = 0; }
  PENDR = pr; PENDV = pv; R[0] = 0;
}
