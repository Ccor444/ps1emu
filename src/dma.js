// ============================================================================
//  Controlador de DMA  0x1F801080-0x1F8010F7
//   canal n: +0 MADR, +4 BCR, +8 CHCR    0xF0 DPCR    0xF4 DICR
//   0 MDEC-in 1 MDEC-out 2 GPU 3 CD-ROM 4 SPU 5 PIO 6 OTC
//  A transferência é feita na hora; só a conclusão/IRQ é agendada (1 ciclo/palavra).
// ============================================================================
export class DMA {
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
