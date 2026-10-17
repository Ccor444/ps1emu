// Agendador de eventos em ciclos de CPU (usado por CD-ROM, SIO0, DMA...)
// Dois tipos de evento:
//   add(time, fn)                      closure (não entra em save states; só para testes/uso interno)
//   call(time, obj, método, args)      descritor serializável: chama reg[obj][método](...args)
export class Scheduler {
  constructor() { this.q = []; this.reg = {}; this.onEarly = null; }
  /** registra os objetos que podem receber eventos descritores (cdrom, dma, sio...) */
  register(name, obj) { this.reg[name] = obj; }
  _ins(e) { if (this.onEarly) this.onEarly(e.time); let i = this.q.length; while (i > 0 && this.q[i - 1].time > e.time) i--; this.q.splice(i, 0, e); return e; }
  /** agenda fn para o instante absoluto `time` (em ciclos) */
  add(time, fn) { return this._ins({ time, fn }); }
  call(time, o, m, a = []) { return this._ins({ time, o, m, a }); }
  cancel(e) { const i = this.q.indexOf(e); if (i >= 0) this.q.splice(i, 1); }
  run(now) {
    while (this.q.length && this.q[0].time <= now) {
      const e = this.q.shift();
      if (e.fn) e.fn(); else this.reg[e.o][e.m](...e.a);
    }
  }
  clear() { this.q.length = 0; }
  get next() { return this.q.length ? this.q[0].time : Infinity; }
  /** lista serializável (falha se houver closures) */
  snapshot() {
    return this.q.map(e => { if (e.fn) throw new Error('evento com closure não pode entrar no save state'); return { time: e.time, o: e.o, m: e.m, a: e.a }; });
  }
  restore(list) { this.q = list.map(e => ({ time: e.time, o: e.o, m: e.m, a: e.a })); }
  find(o, m) { return this.q.find(e => e.o === o && e.m === m) || null; }
}
