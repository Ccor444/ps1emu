// ============================================================================
//  Máquina PS1: Bus + CPU + GPU + SPU + DMA + Timers + SIO0 (controle/memory card) + CD-ROM + MDEC
//  Relógio central = cpu.cycles (1 ciclo por instrução). A cada 32 ciclos roda tick():
//  timers, scanlines/VBLANK, eventos agendados (CD-ROM, SIO, DMA) e geração de áudio.
// ============================================================================
import { Bus } from './bus.js';
import { CPU } from './cpu.js';
import { JIT } from './jit.js';
import { enableWasm, wasmAvailable } from './wasmcpu.js';
import { GPU } from './gpu.js';
import { SPU } from './spu.js';
import { DiscImage } from './disc.js';
import { Scheduler } from './scheduler.js';
import { Timers } from './timers.js';
import { DMA } from './dma.js';
import { SIO } from './sio.js';
import { CDROM } from './cdrom.js';
import { MemoryCard } from './memcard.js';
import { MDEC } from './mdec.js';
import { saveState, loadState } from './state.js';

const TICK = 32, TICK_MAX = +(globalThis.PS1_TICKMAX || (typeof process !== "undefined" && process.env && process.env.PS1_TICKMAX)) || 2400, SPU_PERIOD = 768;   // tick adaptativo: curto só quando algo está para acontecer (evento, borda de linha)
           // 33.8688MHz / 44100Hz = 768
const REGIONS = { A: 'SCEA', E: 'SCEE', J: 'SCEI' };

export class PSX {
  constructor() {
    this.bus = new Bus();
    this.cpu = new CPU(this.bus);
    this.jit = new JIT(this.cpu, this.bus); this.jit.H.ps = this; this.useJit = true;      // recompilador dinâmico (desligue com psx.useJit = false)
    this.gpu = new GPU();
    this.spu = new SPU();
    this.sched = new Scheduler();
    this.sys = { bus: this.bus, sched: this.sched, now: () => this.cpu.cycles, irq: n => this.bus.raiseIrq(n), syncTimers: () => this.syncTimers(), retime: () => this.retime() };
    this.sched.onEarly = t => { if (t < this.nextTick) this.nextTick = t; };
    this.timers = new Timers(this.sys);
    this.dma = new DMA(this.sys);
    this.sio = new SIO(this.sys);
    this.cdrom = new CDROM(this.sys);
    this.mdec = new MDEC();
    this.dma.dev = { gpu: this.gpu, spu: this.spu, cdrom: this.cdrom, mdec: this.mdec };
    this.mdec.onOutput = () => this.dma.mdecOutReady();
    this.cdrom.spu = this.spu; this.gpu.clock = () => this.cpu.cycles; this.bus.psx = this;
    for (const [k, o] of [['cdrom', this.cdrom], ['dma', this.dma], ['sio', this.sio]]) this.sched.register(k, o);
    Object.assign(this.bus, { gpu: this.gpu, spu: this.spu, dma: this.dma, timers: this.timers, sio: this.sio, cdrom: this.cdrom, mdec: this.mdec });
    this.spu.onIrq = () => this.bus.raiseIrq(9);
    this.gpu.onIrq = () => this.bus.raiseIrq(1);

    this.disc = null;
    this.onTTY = null; this.onTrace = null; this.hookTTY = true; this.postCodes = [];
    this.bus.onPost = c => this.postCodes.push(c);
    this.audio = new Int16Array(16384 * 2); this.audioLen = 0;
    this.resetTiming();
    if ((globalThis.PS1_WASM || (typeof process !== "undefined" && process.env && process.env.PS1_WASM)) && wasmAvailable()) this.enableWasm();
  }

  /** troca a CPU pelo núcleo WebAssembly (wasm/cpu.c); true se ativou */
  enableWasm() { try { enableWasm(this); this.gpu.enableWasmRaster(); return true; } catch (e) { return false; } }

  resetTiming() {
    this.timerDue = 0; this.lastTick = this.timerAt = this.cpu.cycles; this.nextTick = this.cpu.cycles + TICK;
    this.lineAcc = 0; this.line = 0; this.audioAcc = 0; this.frameDone = false; this.frames = 0;
  }

  loadBios(bytes) {
    this.bus.loadBios(bytes);
    const info = this.biosInfo();
    this.cdrom.regionOverride = REGIONS[info.trim().slice(-1)] || 'SCEA';   // GetID devolve a região da BIOS (pula a trava regional)
    return info;
  }
  // versão da BIOS: texto em 0x7FF32
  biosInfo() {
    const b = this.bus.bios; let s = '';
    for (let i = 0x7FF32; i < 0x7FF60 && b[i]; i++) s += String.fromCharCode(b[i]);
    return s;
  }
  /** Insere um cartão (bytes de .mcr/.mcd/VGS/DexDrive) no slot 0 ou 1; sem bytes, cria um cartão em branco. */
  loadMemoryCard(slot, bytes) {
    const card = new MemoryCard(bytes); this.sio.cards[slot] = card;
    return { slot, saves: card.listSaves(), livres: card.freeBlocks() };
  }
  ejectMemoryCard(slot) { this.sio.cards[slot] = null; }

  loadDisc(bytes) { this.disc = new DiscImage(bytes); this.cdrom.setDisc(this.disc); return this.disc.info(); }

  /** carrega .cue + arquivos de trilha ({ 'nome.bin': Uint8Array, ... }) */
  loadCue(cueText, files) { this.disc = DiscImage.fromCue(cueText, files); this.cdrom.setDisc(this.disc); return this.disc.info(); }
  /** troca de disco em execução: abre a tampa; fechar com closeDiscLid(disc) */
  openDiscLid() { this.cdrom.openLid(); }
  closeDiscLid(disc) { this.disc = disc; this.cdrom.closeLid(disc); }

  reset() {
    this.cpu.reset(); this.gpu.reset(); this.timers.reset(); this.dma.reset(); this.sio.reset(); this.cdrom.reset(); this.mdec.reset();
    this.cdrom.setDisc(this.disc); this.jit.flush(); this.sched.clear(); this.bus.istat = 0; this.bus.imask = 0;
    this.postCodes.length = 0; this.audioLen = 0; this.resetTiming();
  }

  // ---------------- save states ----------------
  /** estado completo (Uint8Array); chamar entre quadros/instruções, nunca dentro de um bloco do JIT */
  saveState(meta = {}) { return saveState(this, { disc: this.disc ? this.disc.info().volume || '' : '', ...meta }); }
  loadState(bytes) { return loadState(this, bytes); }

  // ---------------- TTY da BIOS (A0/B0: putchar/puts) ----------------
  tty() {
    const cpu = this.cpu, r = cpu.r, pc = cpu.pc & 0x1FFFFFFF;
    if (pc !== 0xA0 && pc !== 0xB0) return;
    const fn = r[9];
    if ((pc === 0xA0 && fn === 0x3C) || (pc === 0xB0 && fn === 0x3D)) this.onTTY?.(String.fromCharCode(r[4] & 0xFF));
    else if ((pc === 0xA0 && fn === 0x3E) || (pc === 0xB0 && fn === 0x3F)) {
      let a = r[4], s = '';
      for (let i = 0; i < 1024; i++) { const c = this.bus.read8(a++); if (!c) break; s += String.fromCharCode(c); }
      this.onTTY?.(s);
    }
  }

  /** liga/desliga o atalho para laços de espera (leitura repetida de status/contador); desligado por padrão */
  get pollSkip() { return this.bus.pollOn; }
  set pollSkip(v) { this.bus.pollOn = !!v; }

  // ---------------- tempo ----------------
  tick() {
    this.gpu.touch();                                                              // linha/vblank/campo mudam o GPUSTAT (bit 31)
    const now = this.cpu.cycles, dt = now - this.lastTick; this.lastTick = now;
    const gpu = this.gpu;
    this.timers.dotDiv = gpu.dotDiv;
    {   // blank horizontal/vertical (início do tick): fora da faixa ativa [hx1, hx2] da linha = hblank; linhas >= vb = vblank
      const k = (gpu.pal ? 2157.2 / 3406 : 2146.3 / 3413), x = this.lineAcc;
      this.timers.setBlank(x < gpu.hx1 * k || x >= gpu.hx2 * k, this.line >= (gpu.pal ? 256 : 240));
    }
    if (((this.timers.t[0].mode | this.timers.t[1].mode) & 1) || now >= this.timerDue) this.advanceTimers(now);   // contadores sob demanda: só avançam aqui se algum depende do blank ou se um IRQ de timer venceu

    // linhas de vídeo: NTSC 263 x ~2146 ciclos, PAL 314 x ~2157
    const lc = gpu.pal ? 2157.2 : 2146.3, lines = gpu.pal ? 314 : 263, vb = gpu.pal ? 256 : 240;
    this.lineAcc += dt;
    while (this.lineAcc >= lc) {
      this.lineAcc -= lc; this.line++; gpu.line = this.line; this.timers.hblank();
      if (this.line === vb) { gpu.vblank = true; gpu.toggleField(); this.bus.raiseIrq(0); }   // o campo entrelaçado muda no início do vblank (os desenhos do jogo depois do IRQ vão todos para o mesmo campo)          // IRQ0 = VBLANK
      if (this.line >= lines) { this.line = 0; gpu.line = 0; gpu.vblank = false; gpu.captureField(); this.frameDone = true; this.frames++; }
    }

    this.sched.run(now);

    this.audioAcc += dt;                                                           // 1 amostra a cada 768 ciclos
    let na = 0; while (this.audioAcc >= SPU_PERIOD) { this.audioAcc -= SPU_PERIOD; na++; }
    const ts = this.sched.prof ? performance.now() : 0;
    while (na > 0) {                                                               // lote de amostras gerado no wasm
      const k = na < 4096 ? na : 4096, o = this.spu.renderRaw(k), c = Math.min(k, 16384 - this.audioLen);
      if (c > 0) { this.audio.set(o.subarray(0, c * 2), this.audioLen * 2); this.audioLen += c; }
      na -= k;
    }
    if (ts) { const pr = this.sched.prof; pr.spu = (pr.spu || 0) + performance.now() - ts; }
    // próximo tick: no máximo TICK_MAX ciclos, antes se houver evento agendado ou fim de linha de vídeo
    let nt = now + TICK_MAX; const ev = this.sched.next; if (ev < nt) nt = ev;
    const ln = now + (lc - this.lineAcc); if (ln < nt) nt = ln;
    if (TICK_MAX > 128) {                                                          // tick longo: limita pelas bordas de hblank dentro da linha e pelo próximo IRQ de timer
      if (this.timers.t[0].mode & 1) {                                             // as bordas de hblank só importam se o timer 0 sincroniza com o blank
        const k = gpu.pal ? 2157.2 / 3406 : 2146.3 / 3413, x = this.lineAcc, e1 = gpu.hx1 * k, e2 = gpu.hx2 * k;
        if (e1 > x && now + (e1 - x) < nt) nt = now + (e1 - x); if (e2 > x && now + (e2 - x) < nt) nt = now + (e2 - x);
      }
      if (this.timerDue < nt) nt = this.timerDue;
    }
    this.nextTick = nt > now ? nt : now + 1;
  }
  /** até quando um laço de espera pode ser pulado sem perder nada: fim da linha de vídeo se algum timer depende das linhas/bordas (sync com hblank, fonte hblank com IRQ);
   *  senão o próximo vblank (IRQ 0) ou o próximo IRQ de timer, o que vier primeiro (o tick seguinte processa todas as linhas puladas) */
  pollHorizon(now) {
    const gpu = this.gpu, lc = gpu.pal ? 2157.2 : 2146.3, t = this.timers.t, lineEnd = this.lastTick + (lc - this.lineAcc);
    if ((t[0].mode & 1) || (((t[1].mode >> 8) & 1) && (t[1].mode & 0x30))) return lineEnd;
    const lines = gpu.pal ? 314 : 263, vb = gpu.pal ? 256 : 240, n = this.line < vb ? vb - this.line - 1 : lines - this.line + vb - 1;
    let end = lineEnd + n * lc;
    this.syncTimers(); const te = this.cpu.cycles + this.timers.nextEvent(); if (te < end) end = te;
    return end;
  }
  /** um registrador de timer mudou: o próximo tick pode ter que vir antes */
  retime() {
    if (TICK_MAX > 128) {
      const now = this.cpu.cycles; this.timerDue = now + this.timers.nextEvent(); if (this.timerDue < this.nextTick) this.nextTick = this.timerDue;
      if (this.timers.t[0].mode & 1) {                                              // timer 0 passou a sincronizar com o hblank: atualiza o estado do blank agora e agenda as bordas
        const gpu = this.gpu, k = gpu.pal ? 2157.2 / 3406 : 2146.3 / 3413, x = this.lineAcc + (now - this.lastTick), e1 = gpu.hx1 * k, e2 = gpu.hx2 * k;
        this.timers.setBlank(x < e1 || x >= e2, this.timers.vb);
        for (const e of [e1, e2]) if (e > x && now + (e - x) < this.nextTick) this.nextTick = now + (e - x);
      }
    }
  }
  /** contadores exatos numa leitura/escrita de registrador (sem rodar eventos) */
  syncTimers() { const now = this.cpu.cycles; if (now > this.timerAt) this.advanceTimers(now); }
  /** avança os contadores até `now` e recalcula o instante do próximo IRQ de timer (timerDue); tick() não precisa avançá-los antes disso (o tick já para nesse instante) */
  advanceTimers(now) { this.timers.advance(now - this.timerAt); this.timerAt = now; this.timerDue = TICK_MAX > 128 ? now + this.timers.nextEvent() : 0; }
  takeAudio() { const o = this.audio.slice(0, this.audioLen * 2); this.audioLen = 0; return o; }

  step() {
    if (this.wasm && !this.onTrace) {                   // 1 passo = 1 instrução no núcleo wasm
      if (this.hookTTY) this.tty();
      const w = this.wasm, nt = this.nextTick; w.S[9] = 1; w.S[14] = 1; this.nextTick = this.cpu.cycles + 1; w.run(); this.nextTick = nt; w.S[9] = 0; w.S[14] = 0;
      if (this.cpu.cycles >= nt) this.tick();
      return;
    }
    if (this.useJit && !this.onTrace) {                 // 1 "passo" = 1 bloco recompilado
      if (this.hookTTY) this.tty();
      this.jit.exec();
      if (this.cpu.cycles >= this.nextTick) this.tick();
      return;
    }
    if (this.onTrace) this.onTrace(this.cpu.pc, this.bus.read32(this.cpu.pc));
    if (this.hookTTY) this.tty();
    this.cpu.step();
    if (this.cpu.cycles >= this.nextTick) this.tick();
  }
  run(n) { for (let i = 0; i < n; i++) this.step(); }
  /** roda pelo menos n instruções (conta instruções, não passos) */
  runInstr(n) { const end = this.cpu.instrCount + n; while (this.cpu.instrCount < end) this.step(); }

  /** Roda até o fim do quadro de vídeo atual; devolve o áudio (Int16 estéreo) gerado nesse tempo. */
  runFrame() {
    this.frameDone = false;
    if (this.wasm && !this.onTrace) {                    // CPU em WebAssembly: roda até o tick; A0/B0 voltam ao JS (TTY da BIOS)
      const w = this.wasm;
      const st = w.st; while (!this.frameDone) { const t0 = performance.now(); const c = w.run(); const t1 = performance.now(); st.run += t1 - t0; if (c === 1) { this.tty(); w.skipHook(); } else { this.tick(); st.tick += performance.now() - t1; } }
    } else if (this.useJit && !this.onTrace) { while (!this.frameDone) { this.jit.runBlocks(this); this.tick(); } }
    else for (let g = 0; !this.frameDone && g < 4_000_000; g++) this.step();
    return this.takeAudio();
  }

  // ---------------- boot ----------------
  /**
   * Sideload: roda a BIOS SEM disco até o shell (0x80030000) e depois carrega o EXE do disco.
   * Alternativa ao boot normal (a região já é "spoofada", então o boot normal costuma funcionar).
   */
  bootToShell(maxSteps = 80_000_000) {
    const disc = this.disc; this.cdrom.setDisc(null);
    let ok = false;
    for (let i = 0; i < maxSteps; i++) { if ((this.cpu.pc & 0x1FFFFFFF) === 0x30000) { ok = true; break; } this.step(); }
    this.cdrom.setDisc(disc);
    return ok;
  }
  sideload(exe) {
    const cpu = this.cpu;
    this.bus.ram.set(exe.data, exe.textAddr & 0x1FFFFF); this.jit.flush();
    const sp = exe.sp || exe.stack || 0x801FFF00;
    cpu.r[28] = exe.gp; cpu.r[29] = sp; cpu.r[30] = sp;
    cpu.pc = exe.pc; cpu.nextPc = (exe.pc + 4) >>> 0; cpu.isBranch = false;
    cpu.cop0[12] = 0x40000401;      // CU2 on, IM2 on, IEc on, modo kernel, BEV=0
  }
  bootDiscExe() {
    if (!this.disc) throw new Error('nenhum disco carregado');
    const exe = this.disc.loadBootExe(); this.sideload(exe); return exe;
  }
}
