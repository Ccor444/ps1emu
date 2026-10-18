// ============================================================================
//  Root counters (timers) 0x1F801100-0x1F80112F
//   +0 contador  +4 modo  +8 alvo
//   modo: b0 sync, b1-2 sync mode, b3 reset no alvo, b4 IRQ no alvo, b5 IRQ em 0xFFFF,
//         b6 IRQ repetido, b7 toggle, b8-9 clock, b10 IRQ flag (1=sem IRQ), b11 atingiu alvo, b12 atingiu FFFF
//   Timer0: sysclk | dotclock    Timer1: sysclk | hblank    Timer2: sysclk | sysclk/8
//  Modos de sincronização (mode bit0=1; bits 1-2):
//    Timer0 (hblank) / Timer1 (vblank):  0 = pausa durante o blank   1 = zera o contador ao entrar no blank
//        2 = zera ao entrar no blank e só conta DENTRO dele          3 = pausa até o 1º blank, depois roda livre
//    Timer2: 0 e 3 = parado   1 e 2 = livre.
//  O PSX informa o estado (hblank, vblank) por tick() via setBlank(); as bordas aplicam reset/liberação.
// ============================================================================
export class Timers {
  constructor(sys) {
    this.sys = sys; this.dotDiv = 10; this.hb = false; this.vb = false;
    this.t = [0, 1, 2].map(() => ({ counter: 0, mode: 0x400, target: 0, irqDone: false, frac: 0, free: false }));
  }
  reset() { for (const t of this.t) { t.counter = 0; t.mode = 0x400; t.target = 0; t.irqDone = false; t.frac = 0; t.free = false; } this.hb = false; this.vb = false; }

  read(addr, size) {
    const n = (addr >> 4) & 3, r = addr & 0xC; if (n > 2) return 0;
    this.sys.syncTimers?.(); const t = this.t[n]; let v = 0;
    if (r === 0) v = t.counter; else if (r === 4) { v = t.mode; t.mode &= ~0x1800; } else if (r === 8) v = t.target;
    if (addr & 2) return 0;
    return size === 1 ? v & 0xFF : v >>> 0;
  }
  write(addr, size, v) {
    const n = (addr >> 4) & 3, r = addr & 0xC; if (n > 2 || (addr & 2)) return;
    this.sys.syncTimers?.(); const t = this.t[n];
    if (r === 0) t.counter = v & 0xFFFF;
    else if (r === 4) { t.mode = (v & 0x3FF) | 0x400; t.counter = 0; t.irqDone = false; t.frac = 0; t.free = false; }
    else if (r === 8) t.target = v & 0xFFFF;
  }

  /** estado do blank horizontal/vertical no início do tick; as bordas aplicam os modos de sync */
  setBlank(hb, vb) {
    if (hb !== this.hb) { this.hb = hb; this.edge(0, hb); }
    if (vb !== this.vb) { this.vb = vb; this.edge(1, vb); }
  }
  edge(n, on) {
    const t = this.t[n]; if (!(t.mode & 1) || !on) return;
    const sm = (t.mode >> 1) & 3;
    if (sm === 1 || sm === 2) t.counter = 0; else if (sm === 3) t.free = true;
  }
  /** o contador n pode contar agora? (timers 0/1 conforme o blank; timer 2 conforme o modo) */
  gate(n) {
    const t = this.t[n]; if (!(t.mode & 1)) return true;
    const sm = (t.mode >> 1) & 3;
    if (n === 2) return sm === 1 || sm === 2;
    const blank = n === 0 ? this.hb : this.vb;
    return sm === 0 ? !blank : sm === 1 ? true : sm === 2 ? blank : t.free;
  }

  /** avança `dt` ciclos de CPU */
  advance(dt) {
    for (let n = 0; n < 3; n++) {
      const t = this.t[n], src = (t.mode >> 8) & 3; let ticks = 0;
      if (n === 0) { if (src & 1) { t.frac += dt * 11 / (7 * this.dotDiv); ticks = t.frac | 0; t.frac -= ticks; } else ticks = dt; }
      else if (n === 1) { if (src & 1) continue; ticks = dt; }                 // hblank: via hblank()
      else if (src & 2) { t.frac += dt / 8; ticks = t.frac | 0; t.frac -= ticks; } else ticks = dt;
      if (ticks && this.gate(n)) this.add(n, t, ticks);
    }
  }
  hblank() { const t = this.t[1]; if (((t.mode >> 8) & 1) && this.gate(1)) this.add(1, t, 1); }

  add(n, t, count) {
    const reset = !!(t.mode & 8); let v = t.counter, left = count;
    while (left > 0) {
      const limit = (reset && v <= t.target) ? t.target : 0xFFFF, room = limit - v;
      if (left <= room) { this.hit(n, t, v, v + left); v += left; left = 0; }
      else {
        this.hit(n, t, v, limit); left -= room + 1; v = 0;
        if (limit === 0xFFFF) { t.mode |= 0x1000; if (t.mode & 0x20) this.irq(n, t); }
      }
    }
    t.counter = v;
  }
  hit(n, t, a, b) { if (a < t.target && t.target <= b) { t.mode |= 0x800; if (t.mode & 0x10) this.irq(n, t); } }
  irq(n, t) {
    if (!(t.mode & 0x40) && t.irqDone) return;
    t.irqDone = true;
    if (t.mode & 0x80) { t.mode ^= 0x400; if (!(t.mode & 0x400)) this.sys.irq(4 + n); }   // toggle
    else this.sys.irq(4 + n);                                                           // pulso
  }
}
