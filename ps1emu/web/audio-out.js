// Saída de áudio: reprodução em taxa FIXA (44,1 kHz, sem reamostragem nem controle de velocidade), então o tom nunca muda.
// Fila de blocos com pré-buffer curto: se o emulador atrasa, há silêncio até a fila reabastecer (sem alterar o tom);
// se ele "recupera" em rajada, o excesso acima do limite de latência é descartado.
export class PCMPull {
  constructor() { this.q = []; this.cur = null; this.pos = 0; this.fill = 0; this.primeAt = 1764; this.maxFill = 8820; this.primed = false; this.under = 0; this.drops = 0; this.lastL = 0; this.lastR = 0; this.fadeIn = 0; this.fo = 64; this.fl = 0; this.fr = 0; }
  push(b) {
    this.q.push(b); this.fill += b.length >> 1;
    while (this.fill > this.maxFill && this.q.length > 1) { const d = this.q.shift(); this.fill -= d.length >> 1; this.drops++; }   // latência limitada (~200 ms)
  }
  /** preenche de `from` até o fim com silêncio, terminando a descida suave (64 amostras) que pode atravessar blocos */
  silence(L, R, from) {
    const n = L.length;
    for (let j = from; j < n; j++) {
      if (this.fo < 64) { const k = 1 - (this.fo + 1) / 64; L[j] = this.fl * k; R[j] = this.fr * k; this.fo++; } else { L[j] = R[j] = 0; }
    }
    this.lastL = this.lastR = 0;
  }
  pull(L, R) {
    const n = L.length;
    if (!this.primed) {
      if (this.fill >= this.primeAt) { this.primed = true; this.fadeIn = this.under > 0 ? 64 : 0; }
      else { this.silence(L, R, 0); return; }
    }
    for (let i = 0; i < n; i++) {
      if (!this.cur || this.pos >= this.cur.length) {
        this.cur = this.q.shift() || null; this.pos = 0;
        if (!this.cur) {                                                                              // esvaziou: some suavemente (sem estalo) e espera reabastecer
          this.primed = false; this.under++; this.fl = this.lastL; this.fr = this.lastR; this.fo = 0;
          this.silence(L, R, i); return;
        }
      }
      let l = this.cur[this.pos++] / 32768, r = this.cur[this.pos++] / 32768; this.fill--;
      if (this.fadeIn > 0) { const g = 1 - this.fadeIn / 64; l *= g; r *= g; this.fadeIn--; }          // entrada suave após esvaziar
      L[i] = this.lastL = l; R[i] = this.lastR = r;
    }
  }
}

const WORKLET = `const PCMPull = ${PCMPull.toString()};
class PS1Out extends AudioWorkletProcessor {
  constructor() {
    super(); this.p = new PCMPull(); this.p.maxFill = 13230; this.ext = null; this.n = 0;      // teto de 300 ms: a meta adaptativa chega a 160 ms e uma rajada de 3 quadros soma ~50 ms
    // canal direto emulador(Worker) -> áudio: o áudio não passa pela thread principal (UI/GC não causam falhas) e volta o nível do buffer
    this.port.onmessage = e => { const d = e.data; if (d && d.ch) { this.ext = d.ch; this.ext.onmessage = ev => this.p.push(ev.data); } else this.p.push(d); };
  }
  process(_, outs) {
    const o = outs[0], n = o[0].length; this.p.pull(o[0], o[1]); this.n += n;
    if (this.ext && this.n >= 2205) { this.n = 0; this.ext.postMessage({ ms: this.p.fill / 44.1, under: this.p.under, drops: this.p.drops }); }
    return true;
  }
}
registerProcessor('ps1-out', PS1Out);`;

export class AudioOut {
  async start() {                                  // precisa de um gesto do usuário (clique)
    this.ctx = new AudioContext({ sampleRate: 44100 });
    this.pull = new PCMPull(); this.pull.maxFill = 13230;
    try {
      if (!this.ctx.audioWorklet) throw new Error('sem AudioWorklet');
      try { await this.ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }))); }
      catch { await this.ctx.audioWorklet.addModule('data:text/javascript,' + encodeURIComponent(WORKLET)); }      // file://: o Chrome recusa módulo por blob:, mas aceita data: (antes caía no ScriptProcessor, que roda na thread principal)
      this.node = new AudioWorkletNode(this.ctx, 'ps1-out', { outputChannelCount: [2] });
      this.node.connect(this.ctx.destination);
      this.mode = 'worklet';
    } catch (e) {                                  // fallback (ex.: file:// bloqueando o worklet)
      const sp = this.ctx.createScriptProcessor(2048, 0, 2);
      sp.onaudioprocess = ev => this.pull.pull(ev.outputBuffer.getChannelData(0), ev.outputBuffer.getChannelData(1));
      sp.connect(this.ctx.destination); this.node = sp; this.mode = 'scriptprocessor';
    }
    await this.ctx.resume();
  }
  /** cria o canal direto Worker -> AudioWorklet; devolve a porta para o Worker (ou null se não há worklet) */
  channel() {
    if (this.mode !== 'worklet') return null;
    const ch = new MessageChannel(); this.node.port.postMessage({ ch: ch.port1 }, [ch.port1]); return ch.port2;
  }
  push(int16) {                                    // int16 = L,R,L,R...
    if (this.mode === 'worklet') this.node.port.postMessage(int16);
    else this.pull.push(int16);
  }
}
