// Saída de áudio: reprodução em taxa FIXA (44,1 kHz, sem reamostragem nem controle de velocidade), então o tom nunca muda.
// Fila de blocos com pré-buffer curto: se o emulador atrasa, há silêncio até a fila reabastecer (sem alterar o tom);
// se ele "recupera" em rajada, o excesso acima do limite de latência é descartado.
export class PCMPull {
  constructor() { this.q = []; this.cur = null; this.pos = 0; this.fill = 0; this.primeAt = 1764; this.maxFill = 8820; this.primed = false; }
  push(b) {
    this.q.push(b); this.fill += b.length >> 1;
    while (this.fill > this.maxFill && this.q.length > 1) { const d = this.q.shift(); this.fill -= d.length >> 1; }   // latência limitada (~200 ms)
  }
  pull(L, R) {
    const n = L.length;
    if (!this.primed) { if (this.fill >= this.primeAt) this.primed = true; else { L.fill(0); R.fill(0); return; } }
    for (let i = 0; i < n; i++) {
      if (!this.cur || this.pos >= this.cur.length) {
        this.cur = this.q.shift() || null; this.pos = 0;
        if (!this.cur) { this.primed = false; for (let j = i; j < n; j++) L[j] = R[j] = 0; return; }      // esvaziou: espera reabastecer
      }
      L[i] = this.cur[this.pos++] / 32768; R[i] = this.cur[this.pos++] / 32768; this.fill--;
    }
  }
}

const WORKLET = `${PCMPull.toString()}
class PS1Out extends AudioWorkletProcessor {
  constructor() { super(); this.p = new PCMPull(); this.port.onmessage = e => this.p.push(e.data); }
  process(_, outs) { this.p.pull(outs[0][0], outs[0][1]); return true; }
}
registerProcessor('ps1-out', PS1Out);`;

export class AudioOut {
  async start() {                                  // precisa de um gesto do usuário (clique)
    this.ctx = new AudioContext({ sampleRate: 44100 });
    this.pull = new PCMPull();
    try {
      if (!this.ctx.audioWorklet) throw new Error('sem AudioWorklet');
      const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
      await this.ctx.audioWorklet.addModule(url);
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
  push(int16) {                                    // int16 = L,R,L,R...
    if (this.mode === 'worklet') this.node.port.postMessage(int16);
    else this.pull.push(int16);
  }
}
