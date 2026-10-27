// ============================================================================
//  SIO0 (porta de controles / memory cards)  0x1F801040-0x1F80104F
//   +0 DATA  +4 STAT  +8 MODE  +A CTRL  +E BAUD
//  Emula: controle digital (ID 0x41) na porta 1; porta 2 e memory cards desconectados.
// ============================================================================
export const BUTTONS = { select: 0, l3: 1, r3: 2, start: 3, up: 4, right: 5, down: 6, left: 7,
                         l2: 8, r2: 9, l1: 10, r1: 11, triangle: 12, circle: 13, cross: 14, square: 15 };

//  Controles: 'digital' (ID 0x41) ou 'dualshock' (começa digital; o jogo entra em modo de configuração (0x43),
//  liga o modo analógico (0x44) e passa a receber ID 0x73 com os 4 eixos; vibração via mapeamento 0x4D).
export const STICKS = { rx: 0, ry: 1, lx: 2, ly: 3 };

export class SIO {
  constructor(sys) {
    this.sys = sys; this.padConnected = [true, false]; this.cards = [null, null]; this.buttons = [0xFFFF, 0xFFFF];
    this.padType = ['digital', 'digital'];                                  // configuração (não faz parte do save state)
    this.sticks = [[0x80, 0x80, 0x80, 0x80], [0x80, 0x80, 0x80, 0x80]];     // rx, ry, lx, ly (0..255, centro 0x80)
    this.onRumble = null;                                                   // (porta, pequeno 0/1, grande 0..255)
    this.reset();
  }
  newPad() { return { analog: false, lock: false, config: false, map: [0x00, 0x01, 0xFF, 0xFF, 0xFF, 0xFF], small: 0, large: 0, cmd: 0, n: 0, pend: null }; }
  /** troca o tipo do controle da porta: 'digital' | 'dualshock' */
  setPadType(port, type) { this.padType[port] = type; this.pads[port] = this.newPad(); }
  /** eixo analógico 0..255 (0x80 = centro): 'lx' | 'ly' | 'rx' | 'ry' */
  setStick(name, value, port = 0) { this.sticks[port][STICKS[name]] = Math.max(0, Math.min(255, Math.round(value))); }
  /** botão ANALOG do controle: liga/desliga o modo (se o jogo não o travou) */
  toggleAnalog(port = 0) { const p = this.pads[port]; if (this.padType[port] === 'dualshock' && !p.lock) p.analog = !p.analog; return p.analog; }
  reset() {
    this.pads = [this.newPad(), this.newPad()];
    this.stat = 0x5; this.mode = 0; this.ctrl = 0; this.baud = 0; this.rx = 0xFF; this.rxValid = false;
    this.state = 0; this.dev = null; this.busyEvt = null; this.mc = null;
  }
  /** pressiona/solta um botão (bits em nível baixo = pressionado) */
  setButton(name, pressed, port = 0) {
    const b = 1 << BUTTONS[name]; this.buttons[port] = pressed ? (this.buttons[port] & ~b) : (this.buttons[port] | b);
  }

  read(addr, size) {
    switch (addr & 0xF) {
      case 0: { const v = this.rx; this.rxValid = false; this.stat &= ~2; return v; }
      case 4: return this.stat >>> 0;
      case 8: return this.mode;
      case 0xA: return this.ctrl;
      case 0xE: return this.baud;
    }
    return 0;
  }
  write(addr, size, v) {
    switch (addr & 0xF) {
      case 0: this.tx(v & 0xFF); break;
      case 8: this.mode = v & 0xFFFF; break;
      case 0xA: {
        this.ctrl = v & 0xFFFF;
        if (v & 0x10) this.stat &= ~0x200;                           // ACK: limpa flag de IRQ
        if (v & 0x40) { const c = this.ctrl; this.reset(); this.ctrl = 0; }   // reset
        if (!(v & 2)) { this.state = 0; this.dev = null; this.mc = null; }   // /JOY desmarcado: fim da transação
        break;
      }
      case 0xE: this.baud = v & 0xFFFF; break;
    }
  }

  tx(byte) {
    if (!(this.ctrl & 1)) return;                                    // TXEN desligado
    this.stat &= ~0x5;                                               // TX ocupado
    const factor = [1, 1, 16, 64][this.mode & 3], cyc = Math.max(8 * (this.baud || 0x88) * factor, 200);
    this.sys.sched.call(this.sys.now() + cyc, 'sio', 'txDone', [byte]);
  }
  txDone(byte) {
    const [resp, ack] = this.exchange(byte);
    this.rx = resp; this.rxValid = true; this.stat |= 0x2 | 0x5;
    if (ack) { this.stat |= 0x80; this.sys.sched.call(this.sys.now() + 100, 'sio', 'ackIrq', []); }   // DSR
  }
  ackIrq() {
    this.stat |= 0x200; if (this.ctrl & 0x1000) this.sys.irq(7);
    this.sys.sched.call(this.sys.now() + 60, 'sio', 'dsrOff', []);
  }
  dsrOff() { this.stat &= ~0x80; }

  /** protocolo: devolve [byte de resposta, ack?] */
  exchange(b) {
    const port = (this.ctrl >> 13) & 1;
    if (this.state === 0) {                                          // 1º byte = endereço do dispositivo
      if (b === 0x01 && this.padConnected[port]) { this.dev = 'pad'; this.state = 1; return [0xFF, true]; }
      if (b === 0x81 && this.cards[port]) { this.dev = 'mc'; this.state = 1; this.mc = { k: 1, cmd: 0, msb: 0, lsb: 0, sector: 0, buf: new Uint8Array(128), chk: 0, bad: false }; return [0xFF, true]; }
      this.dev = null; this.state = -1; return [0xFF, false];        // porta vazia / memory card ausente: sem ACK
    }
    if (this.dev === 'pad') return this.exchangePad(b, port);
    if (this.dev === 'mc') return this.exchangeMC(b, this.cards[port]);
    return [0xFF, false];
  }

  /** controle: byte 1 = comando, 2 = 0x5A, depois dados. Devolve [byte, ack] */
  exchangePad(b, port) {
    const pad = this.pads[port], btn = this.buttons[port], s = this.state++;
    const dual = this.padType[port] === 'dualshock';
    if (s === 1) {
      pad.cmd = dual ? b : 0x42; pad.n = 0; pad.pend = null;
      const id = !dual ? 0x41 : pad.config ? 0xF3 : pad.analog ? 0x73 : 0x41;
      pad.len = (id & 0xF) * 2; return [id, true];
    }
    if (s === 2) return [0x5A, true];
    const i = s - 3, last = i === pad.len - 1;
    if (i >= pad.len) return [0xFF, false];
    const sticks = this.sticks[port], withSticks = pad.analog || pad.config;
    let out = 0;
    switch (pad.cmd) {
      case 0x42: case 0x43: {
        out = i === 0 ? btn & 0xFF : i === 1 ? btn >> 8 : (withSticks ? sticks[i - 2] : 0xFF);
        if (pad.cmd === 0x42) {                                       // vibração: mapa 4D define que byte aciona qual motor
          if (pad.map[i] === 0) pad.small = b & 1; else if (pad.map[i] === 1) pad.large = b;
        } else if (i === 0) pad.pend = b === 1;                       // 0x43: 1 entra / 0 sai do modo de configuração
        break;
      }
      case 0x44: out = 0; if (i === 0) pad.pend = b === 1; else if (i === 1) pad.lock = b === 3; break;
      case 0x45: out = [0x01, 0x02, pad.analog ? 1 : 0, 0x02, 0x01, 0x00][i]; break;
      case 0x46: out = (b === 1 ? [0x00, 0x01, 0x01, 0x01, 0x14, 0x00] : [0x00, 0x01, 0x02, 0x00, 0x0A, 0x00])[i]; if (i === 0) pad.sel = b; break;
      case 0x47: out = [0x00, 0x00, 0x02, 0x00, 0x01, 0x00][i]; break;
      case 0x4C: out = [0x00, 0x00, 0x00, 0x04, 0x00, 0x00][i]; break;
      case 0x4D: out = pad.map[i]; if (!pad.pend) pad.pend = []; pad.pend[i] = b; break;
      default: out = 0;
    }
    if (pad.cmd === 0x46 && i > 0) out = ((pad.sel === 1) ? [0x00, 0x01, 0x01, 0x01, 0x14, 0x00] : [0x00, 0x01, 0x02, 0x00, 0x0A, 0x00])[i];
    if (last) this.padEnd(port, pad);
    return [out, !last];
  }
  /** fim da transação: efetiva mudanças de modo/mapa e avisa a vibração */
  padEnd(port, pad) {
    if (pad.cmd === 0x43 && typeof pad.pend === 'boolean') pad.config = pad.pend;
    else if (pad.cmd === 0x44 && typeof pad.pend === 'boolean') pad.analog = pad.pend;
    else if (pad.cmd === 0x4D && Array.isArray(pad.pend)) pad.map = [0, 1, 2, 3, 4, 5].map(k => pad.pend[k] ?? 0xFF);
    pad.pend = null;
    const key = pad.small | (pad.large << 1);
    if (key !== pad.sent) { pad.sent = key; this.onRumble?.(port, pad.small, pad.large); }
  }

  /**
   * Protocolo do Memory Card (byte 0 = 0x81 já tratado). k = índice do byte na transação.
   *  Leitura 'R'(52): FLAG 5A 5D 00 MSB 5C 5D MSB LSB [128 dados] CHK 47
   *  Escrita 'W'(57): FLAG 5A 5D 00 MSB [eco...] CHK 5C 5D END(47 ok | 4E checksum | FF setor ruim)
   *  GetID   'S'(53): FLAG 5A 5D 5C 5D 04 00 00 80
   * Todos os bytes têm ACK, exceto o último da transação.
   */
  exchangeMC(b, card) {
    const m = this.mc, k = m.k++, A = true, END = false;
    if (k === 1) {
      m.cmd = b;
      if (b === 0x52 || b === 0x57 || b === 0x53) return [card.flag, A];
      this.dev = null; this.state = -1; return [0xFF, END];            // comando desconhecido
    }
    if (m.cmd === 0x53) {                                              // GetID
      const r = { 2: 0x5A, 3: 0x5D, 4: 0x5C, 5: 0x5D, 6: 0x04, 7: 0x00, 8: 0x00, 9: 0x80 }[k];
      return r === undefined ? [0xFF, END] : [r, k < 9];
    }
    if (k === 2) return [0x5A, A];
    if (k === 3) return [0x5D, A];
    if (k === 4) { m.msb = b; return [0x00, A]; }
    if (k === 5) { m.lsb = b; m.sector = (m.msb << 8) | m.lsb; m.bad = m.sector >= 1024; return [m.msb, A]; }

    if (m.cmd === 0x52) {                                              // ---- leitura ----
      if (k === 6) return [0x5C, A];
      if (k === 7) return [0x5D, A];
      if (k === 8) return [m.bad ? 0xFF : m.msb, A];
      if (k === 9) return [m.bad ? 0xFF : m.lsb, !m.bad];             // setor inválido: encerra sem dados
      if (m.bad) return [0xFF, END];
      if (k === 10) { m.buf.set(card.readSector(m.sector)); m.chk = m.msb ^ m.lsb; }
      if (k >= 10 && k < 138) { const v = m.buf[k - 10]; m.chk ^= v; return [v, A]; }
      if (k === 138) return [m.chk, A];
      if (k === 139) return [0x47, END];
      return [0xFF, END];
    }
    // ---- escrita ----
    if (k >= 6 && k < 134) { const i = k - 6; m.buf[i] = b; return [i === 0 ? m.lsb : m.buf[i - 1], A]; }
    if (k === 134) { m.chk = b; return [m.buf[127], A]; }
    if (k === 135) return [0x5C, A];
    if (k === 136) return [0x5D, A];
    if (k === 137) {
      let want = m.msb ^ m.lsb; for (let i = 0; i < 128; i++) want ^= m.buf[i];
      let end = 0x47;
      if (m.bad) end = 0xFF; else if (want !== m.chk) end = 0x4E; else card.writeSector(m.sector, m.buf);
      return [end, END];
    }
    return [0xFF, END];
  }
}
