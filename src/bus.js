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

export const RAM_SIZE = 2 * 1024 * 1024;
export const BIOS_SIZE = 512 * 1024;

export class Bus {
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
    if (!(q === 0x1F801814 || q === 0x1F801070 || q === 0x1F801044 || (p >= 0x1F801100 && p < 0x1F801130 && (p & 0xF) === 0) || (p >= 0x1F801080 && p < 0x1F801100))) { this.ioSeq = (this.ioSeq + 1) | 0; return this.ioRead0(p, size); }
    let v = this.ioRead0(p, size);
    const ps = this.poll, psx = this.psx, now = psx.cpu.cycles, d = now - ps.t;
    if (p === ps.p && v === ps.v && this.ioSeq === ps.seq && d === ps.d2) ps.n++; else ps.n = 0;
    ps.d2 = ps.d1; ps.d1 = d; ps.t = now; ps.p = p; ps.v = v; ps.seq = this.ioSeq;
    if (ps.n >= 8) {
      ps.n = 0;
      if (!(this.istat & this.imask)) {                                          // sem IRQ pendente (dentro de um handler com IE=0 há laços de espera COM contador de timeout: pular aí esticaria o timeout)
        let end = psx.lastTick + (psx.gpu.pal ? 2157.2 : 2146.3) - psx.lineAcc; const ev = psx.sched.next; if (ev < end) end = ev;      // no máximo até o fim da linha de vídeo: laços com timeout por software ficam próximos do tempo real
        if (psx.timerDue < end) end = psx.timerDue;                              // e antes do próximo IRQ de timer
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
