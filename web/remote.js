// Lado da página do modo Worker: fala com web/worker.js. Expõe `sio` compatível com o InputManager (repassa botões/analógicos).
class SioProxy {
  constructor(owner) {
    this.o = owner; this.padType = ['digital', 'digital']; this.onRumble = null; this.cards = [null, null]; this.cache = new Map();
    const self = this;
    this.padConnected = new Proxy([true, false], { set(t, k, v) { if (t[k] !== v) { t[k] = v; self.o.call_('padConnected', [+k, v]); } return true; } });
  }
  setButton(name, pressed, port = 0) { const k = 'b' + port + name; if (this.cache.get(k) === pressed) return; this.cache.set(k, pressed); this.o.call_('setButton', [name, pressed, port]); }
  setStick(name, value, port = 0) { const k = 's' + port + name, v = Math.max(0, Math.min(255, Math.round(value))); if (this.cache.get(k) === v) return; this.cache.set(k, v); this.o.call_('setStick', [name, v, port]); }
  setPadType(port, type) { this.padType[port] = type; this.cache.clear(); this.o.call_('setPadType', [port, type]); }
  toggleAnalog(port = 0) { this.o.post({ t: 'analog', port }); return null; }
}

export class RemoteMachine {
  /** src = texto do worker (bundle + worker.js), gerado por build.js em PS1_WORKER_SRC */
  constructor(src) {
    this.url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
    this.w = new Worker(this.url); this.pending = new Map(); this.nid = 0; this.calls = []; this.on = {};
    this.game = 'sem-disco'; this.cardInfo = ['', '']; this.haveCard = [false, false]; this.hasDisc = false;
    this.sio = new SioProxy(this);
    this.w.onmessage = e => { const m = e.data; if (m.t === 'res') { const p = this.pending.get(m.id); this.pending.delete(m.id); if (p) m.ok ? p.res(m.value) : p.rej(new Error(m.err)); } else this.on[m.t]?.(m); };
    this.w.onerror = e => this.on.crash?.({ msg: e.message || 'erro no Worker', report: `${e.message} (${e.filename || ''}:${e.lineno || ''})` });
  }
  post(m, tr) { this.w.postMessage(m, tr || []); }
  call_(f, a) { this.calls.push([f, a]); }
  flush() { if (this.calls.length) { this.post({ t: 'sio', calls: this.calls }); this.calls = []; } }
  req(op, data = {}, tr) { return new Promise((res, rej) => { const id = ++this.nid; this.pending.set(id, { res, rej }); this.post({ t: 'req', id, op, ...data }, tr); }); }
  terminate() { this.w.terminate(); URL.revokeObjectURL(this.url); }
}
