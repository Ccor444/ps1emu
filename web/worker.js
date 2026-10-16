// Executa o emulador numa thread separada (Web Worker). Este arquivo é concatenado ao bundle (dist/ps1emu.js define PS1)
// por build.js e roda só dentro do Worker. A página (thread principal) cuida de UI, entrada, áudio (AudioWorklet) e IndexedDB.
// Protocolo: ver web/remote.js (lado da página).
(() => {
  'use strict';
  const { PSX, VideoOut, GLVideoOut, Debugger } = PS1;
  const post = (m, t) => self.postMessage(m, t || []);
  const log = s => post({ t: 'log', s });
  let psx = null, video = null, running = false, paused = false, turbo = false, crashed = null;
  let cfg = { mode: -1, smooth: false }, gameKey = 'sem-disco', lidOpen = false;
  let sumEmu = 0, sumVid = 0, sumFrames = 0, acc = 0, lastT = 0, frameCount = 0, t0 = 0, canvasWait = null, applying = false;
  let hidden = false;

  // ---- renderizador (adaptativo igual ao da thread principal; o probe do aparelho vem da página) ----
  const auto = { on: false, scale: 2, max: 4, slow: 0, fast: 0, fail: {}, tries: {}, ran: 0, work: 0, t: 0 };
  const getCanvas = () => new Promise(res => { canvasWait = res; post({ t: 'needCanvas' }); });
  const applyRenderer = async () => {
    if (applying) return; applying = true;
    try {
      let mode = cfg.mode; auto.on = mode < 0; if (auto.on) mode = auto.scale;
      if (video && video.dispose) video.dispose();
      if (psx.gpu.hw) psx.gpu.hw = null;
      video = null;
      let c = await getCanvas();
      if (mode) {
        try {
          const v = new GLVideoOut(c, mode, psx, { smooth: cfg.smooth });
          video = v; post({ t: 'rinfo', s: `${auto.on ? 'Adaptativo: ' : ''}WebGL2 ${v.scale}x (${1024 * v.scale}x${512 * v.scale} VRAM) [thread separada]` });
          log(`Renderizador: WebGL2 ${v.scale}x${auto.on ? ' (adaptativo)' : ''} [Worker]`); return;
        } catch (e) { log('WebGL indisponível no Worker (' + e.message + ') - usando software'); auto.scale = 0; auto.max = 0; c = await getCanvas(); }
      }
      video = new VideoOut(c); post({ t: 'rinfo', s: (auto.on ? 'Adaptativo: ' : '') + 'software [thread separada]' }); log('Renderizador: software [Worker]');
    } finally { applying = false; }
  };
  const adapt = (ran, work, period, ms) => {
    if (!auto.on || ms > 1600) return;
    const want = ms / period, now = performance.now();
    auto.peak = Math.max(work, (auto.peak || 0) * 0.985);              // pico recente de custo por quadro (cenas pesadas, ex.: luta 3D, mantêm o pico alto)
    const behind = ran < want * 0.9, idle = ran >= want * 0.97 && work < period * 0.4 && auto.peak < period * 0.6;
    auto.slow = behind ? auto.slow + 1 : 0; auto.fast = idle ? auto.fast + 1 : 0;
    const move = ns => { auto.scale = ns; auto.slow = auto.fast = 0; applyRenderer(); };
    if (auto.slow >= 2 && auto.scale > 0) {                              // não acompanha: desce um degrau (até o software) e lembra que esse degrau falhou
      const from = auto.scale; auto.fail[from] = now; auto.tries[from] = (auto.tries[from] || 0) + 1; post({ t: 'afail', level: from });
      log(`Adaptativo: ${ran}/${want.toFixed(0)} quadros/s → ${from}x para ${from - 1 ? from - 1 + 'x' : 'software'}`); move(from - 1);
    } else if (auto.fast >= 10 && auto.scale < auto.max) {               // sobra folga de verdade e por bastante tempo: tenta subir (espera dobra a cada falha)
      const to = auto.scale + 1, wait = 60000 * Math.pow(2, auto.tries[to - 1] || 0);
      if (!auto.fail[to] || now - auto.fail[to] > wait) { log(`Adaptativo: folga de CPU → subindo para ${to}x`); auto.peak = work; move(to); } else auto.fast = 0;
    }
  };

  // ---- laço principal (mesma lógica da thread principal: 50/59,94 Hz independente do monitor) ----
  const crash = e => {
    crashed = e; running = false; let rep = '';
    try { rep = new Debugger(psx).report(e); } catch { rep = String(e && e.stack || e); }
    post({ t: 'crash', msg: String(e && e.message || e), report: rep });
  };
  // laço por setTimeout (não por rAF): o ritmo vem do acumulador de tempo, então uma GPU/compositor lento não derruba a velocidade da emulação
  let timer = 0;
  const frame = () => {
    clearTimeout(timer);
    const period = psx.gpu.pal ? 20 : 16.6833;
    run(); timer = setTimeout(frame, Math.max(1, Math.min(period, period - acc - 1)));
  };
  const run = () => {
    if (!running || paused || hidden) { lastT = performance.now(); return; }
    try {
      const now = performance.now(); acc = Math.min(acc + Math.min(now - lastT, 100), 100); lastT = now;
      const period = psx.gpu.pal ? 20 : 16.6833;
      let n = 0;
      if (turbo) n = 4; else { while (acc >= period - 0.5 && n < 3) { acc -= period; n++; } if (acc > period) acc = period; }
      if (!n) return;
      const w0 = performance.now();
      for (let i = 0; i < n; i++) {
        const pcm = psx.runFrame();
        if (!turbo && pcm.length) post({ t: 'audio', pcm }, [pcm.buffer]);
      }
      const w1 = performance.now(); sumEmu += w1 - w0; sumFrames += n;
      if (video) video.present(psx.gpu);
      sumVid += performance.now() - w1;
      if (auto.on && !turbo && video) {
        const e = performance.now(); auto.ran += n; auto.work += e - w0;
        if (!auto.t) auto.t = e; else if (e - auto.t >= 1000) { const ran = auto.ran, wk = auto.work / Math.max(1, ran), ms = e - auto.t; auto.ran = 0; auto.work = 0; auto.t = e; adapt(ran, wk, period, ms); }
      }
      frameCount += n; if (frameCount >= 60) { const t = performance.now(); post({ t: 'fps', s: (frameCount * 1000 / (t - t0)).toFixed(1) + ' fps' + (turbo ? ' (turbo)' : '') + ` · emu ${(sumEmu / sumFrames).toFixed(1)} ms · vídeo ${(sumVid / sumFrames).toFixed(1)} ms/quadro` }); t0 = t; frameCount = 0; sumEmu = sumVid = sumFrames = 0; }
    } catch (e) { crash(e); }
  };

  // ---- memory cards: avisa a página dos cartões alterados (ela grava no IndexedDB) e do texto de informação ----
  const cardInfo = s => { const c = psx.sio.cards[s]; if (!c) return ''; const n = c.listSaves().length; return `${n} save(s), ${c.freeBlocks()} bloco(s) livre(s)`; };
  setInterval(() => {
    if (!psx) return;
    for (const s of [0, 1]) { const c = psx.sio.cards[s]; if (c && c.dirty) { const b = c.export(); post({ t: 'cardData', slot: s, bytes: b }, [b.buffer]); } }
    post({ t: 'cards', info: [cardInfo(0), cardInfo(1)], have: [!!psx.sio.cards[0], !!psx.sio.cards[1]], lid: !!(psx.disc || lidOpen) });
  }, 1000);

  const makeDisc = d => d.cue ? PS1.DiscImage.fromCue(d.cue, new Map(d.map)) : new PS1.DiscImage(d.bytes);
  const setGame = () => { try { const i = psx.disc && psx.disc.info(); gameKey = i ? (i.volume || 'disco') + ':' + i.setores : 'sem-disco'; } catch { gameKey = 'disco'; } post({ t: 'game', key: gameKey }); };

  const init = async m => {
    psx = new PSX(); psx.onTTY = s => log(s.replace(/\n$/, ''));
    cfg = { mode: m.mode, smooth: !!m.smooth }; Object.assign(auto, m.probe || {});
    log('BIOS: ' + psx.loadBios(m.bios));
    if (m.disc) { const d = makeDisc(m.disc); psx.disc = d; psx.cdrom.setDisc(d); log('Disco: ' + JSON.stringify(d.info())); }
    for (const slot of [0, 1]) {
      const c = m.cards[slot]; if (!c) continue;
      try {
        if (c.blank) { psx.loadMemoryCard(slot); psx.sio.cards[slot].dirty = true; log(`Cartão ${slot + 1}: em branco`); }
        else { const r = psx.loadMemoryCard(slot, c.bytes); if (c.dirty) psx.sio.cards[slot].dirty = true; log(`Cartão ${slot + 1}: ${r.saves.map(s => s.code + ' "' + s.title + '"').join('; ') || 'vazio'} (${r.livres} livres)`); }
      } catch (e) { log('Cartão ' + (slot + 1) + ' inválido: ' + e.message); }
    }
    psx.reset();
    for (const p of [0, 1]) if (m.ptype[p]) psx.sio.setPadType(p, m.ptype[p]);
    psx.sio.onRumble = (p, s, l) => post({ t: 'rumble', p, s, l });
    psx.useJit = m.jit !== false; psx.pollSkip = m.poll !== false;
    await applyRenderer();
    if (m.side && psx.disc) {
      log('Sideload: rodando BIOS até o shell...');
      if (psx.bootToShell()) { const exe = psx.bootDiscExe(); log('EXE carregado: ' + exe.path); } else log('BIOS não chegou ao shell.');
    }
    setGame(); running = true; paused = false; lastT = t0 = performance.now(); acc = 0; frameCount = 0; auto.t = 0;
    post({ t: 'ready' }); frame();
  };

  // ---- pedidos com resposta ----
  const ops = {
    saveState: m => { const raw = psx.saveState({ game: m.game || gameKey }); return [raw, [raw.buffer]]; },
    loadState: m => { psx.loadState(m.raw); acc = 0; return [null]; },
    cardExport: m => { const c = psx.sio.cards[m.slot]; if (!c) return [null]; const b = c.export(); return [b, [b.buffer]]; },
    cardLoad: m => { const r = psx.loadMemoryCard(m.slot, m.bytes); psx.sio.cards[m.slot].dirty = true; return [r.saves.map(s => `${s.code} "${s.title}"`)]; },
    lid: m => { if (m.open) { psx.openDiscLid(); lidOpen = true; } else { psx.closeDiscLid(psx.disc); lidOpen = false; } return [null]; },
    disc: m => { const d = makeDisc(m.disc); psx.closeDiscLid(d); lidOpen = false; setGame(); return [d.info()]; },
  };

  self.onmessage = async e => {
    const m = e.data;
    try {
      switch (m.t) {
        case 'init': await init(m); break;
        case 'canvas': if (canvasWait) { const r = canvasWait; canvasWait = null; r(m.canvas); } break;
        case 'sio': for (const [f, a] of m.calls) { if (f === 'padConnected') psx.sio.padConnected[a[0]] = a[1]; else psx.sio[f](...a); } break;
        case 'pause': paused = !!m.v; if (!paused) { lastT = t0 = performance.now(); acc = 0; frameCount = 0; auto.t = 0; auto.ran = auto.work = 0; } break;
        case 'hidden': hidden = !!m.v; if (!hidden) { lastT = performance.now(); acc = 0; } break;
        case 'turbo': turbo = !!m.v; break;
        case 'jit': psx.useJit = !!m.v; break;
        case 'poll': psx.pollSkip = !!m.v; break;
        case 'smooth': cfg.smooth = !!m.v; if (video && video.r) video.r.opts.smooth = cfg.smooth; break;
        case 'renderer': cfg.mode = m.mode; cfg.smooth = !!m.smooth; if (psx) applyRenderer(); break;
        case 'analog': { const on = psx.sio.toggleAnalog(m.port || 0); log('Modo analógico: ' + (on ? 'ligado' : 'desligado (ou travado pelo jogo / controle é digital)')); break; }
        case 'req': {
          try { const [v, tr] = ops[m.op](m); post({ t: 'res', id: m.id, ok: true, value: v }, tr || []); }
          catch (err) { post({ t: 'res', id: m.id, ok: false, err: String(err && err.message || err) }); }
          break;
        }
      }
    } catch (err) { crash(err); }
  };
})();
