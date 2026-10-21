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
  let hidden = false, fskip = false, gw = null, R = null, dumpWait = null;
  // ---- sincronia áudio/vídeo: o relógio do áudio é o mestre. O AudioWorklet devolve o nível do buffer; um servo proporcional ajusta o ritmo
  //      da emulação em até ±0,5% (inaudível) para o buffer ficar em ~AUDIO_ALVO ms, sem estalos de falta/sobra por deriva entre os relógios. ----
  let alvo = 70, lastUnder = 0, underT = 0;                                // meta de latência (ms): sobe após cada falta de áudio (travadas do aparelho) e desce devagar quando fica estável
  let ap = null, aStat = null, aAvg = -1, aStatT = 0, lastPres = 0, jit = [], speedScale = 1;

  // ---- GPU em 2ª thread: o rasterizador (software) roda num Worker aninhado com VRAM própria; aqui só fica a análise dos comandos e a temporização ----
  const gpuFields = g => { const f = {}; for (const k of Object.keys(g)) { const v = g[k]; if (typeof v === 'number' || typeof v === 'boolean') f[k] = v; } return f; };
  const syncRemote = () => { const v = psx.gpu.vram.slice(); gw.postMessage({ t: 'sync', vram: v, f: gpuFields(psx.gpu) }, [v.buffer]); };
  const askDump = () => new Promise(res => { dumpWait = res; R.flush(); gw.postMessage({ t: 'dump' }); });
  const pullVram = async () => { if (!R) return; const v = await askDump(); psx.gpu.vram.set(v); };      // VRAM do worker -> esta thread (savestate, saída da GPU em thread)
  const leaveRemote = async () => {
    if (!R) return; await pullVram();
    psx.gpu.remote = null; R = null; if (gw) { gw.terminate(); gw = null; } video = null;
  };
  let initWait = null;
  const enterRemote = async scale => {
    const c = await getCanvas();
    gw = new Worker(URL.createObjectURL(new Blob([PS1_GPUW_SRC], { type: 'text/javascript' })));
    gw.onmessage = e => { const m = e.data; if (m.t === 'ack') { if (R) R.inflight = Math.max(0, R.inflight - 1); } else if (m.t === 'vram') { const r = dumpWait; dumpWait = null; if (r) r(m.vram); } else if (m.t === 'ginfo' || m.t === 'initfail') { const r = initWait; initWait = null; if (r) r(m); } else if (m.t === 'err') log('GPU thread: ' + m.msg); };
    gw.onerror = e => crash(new Error('GPU em thread: ' + (e.message || 'erro')));
    gw.postMessage({ t: 'init', canvas: c, scale, smooth: cfg.smooth }, [c]); gw.postMessage({ t: 'deint', v: psx.gpu.deint | 0 });
    const info = await new Promise(res => { initWait = res; });
    if (info.t === 'initfail') { log('GPU em thread: ' + info.msg + ' - usando uma thread só'); gw.terminate(); gw = null; return false; }
    R = new PS1.GpuStream(m => gw.postMessage(m, m.q ? [m.q.buffer] : []));
    syncRemote(); psx.gpu.remote = R;
    R.onRead = () => { if (!R || R.fb) return; R.fb = true; smart.trial = null; smart.blocked = true; post({ t: 'gpuread' }); log('GPU em thread: o jogo lê a VRAM de volta - voltando para uma thread só'); cfg.gpuThread = false; fallback = true; };
    video = { present: () => { R.push(3, 0); R.inflight++; R.flush(); }, dispose() {} };
    const nome = info.scale ? `WebGL2 ${info.scale}x (${1024 * info.scale}x${512 * info.scale} VRAM)` : 'software';
    post({ t: 'rinfo', s: `${auto.on ? 'Adaptativo: ' : ''}${nome} [GPU em thread separada]` }); log(`Renderizador: ${nome} [GPU em 2ª thread]`);
    return true;
  };
  let fallback = false;
  // modo inteligente: com o renderizador Adaptativo, se já está no software e o emulador não acompanha, TESTA a GPU em 2ª thread
  // (mede quadros/s antes e depois; sem ganho de verdade, volta). O resultado é lembrado por jogo (pela página).
  const smart = { ok: false, bad: false, blocked: false, trial: null };
  const canThread = () => typeof PS1_GPUW_SRC !== 'undefined' && (self.navigator && navigator.hardwareConcurrency || 2) >= 4 && !smart.bad && !smart.blocked;

  // ---- renderizador (adaptativo igual ao da thread principal; o probe do aparelho vem da página) ----
  const auto = { on: false, scale: 2, max: 4, slow: 0, fast: 0, fail: {}, tries: {}, ran: 0, work: 0, t: 0 };
  const getCanvas = () => new Promise(res => { canvasWait = res; post({ t: 'needCanvas' }); });
  const applyRenderer = async () => {
    if (applying) return; applying = true;
    try {
      await leaveRemote();
      if (cfg.gpuThread) {                                               // GPU em 2ª thread: software ou WebGL (na escala do adaptativo / escolhida)
        auto.on = cfg.mode < 0; const sc = auto.on ? auto.scale : Math.max(0, cfg.mode);
        if (video && video.dispose) video.dispose(); if (psx.gpu.hw) psx.gpu.hw = null; video = null;      // traz a VRAM do WebGL local para a VRAM nativa antes de enviá-la ao worker
        if (await enterRemote(sc)) return;
        cfg.gpuThread = false; smart.trial = null; smart.bad = true;     // não deu: segue pelo caminho normal abaixo
      }
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
    if (R && smart.trial) {                                              // GPU em thread no modo inteligente: confere se o teste valeu a pena
      const t = smart.trial;
      if (++t.n === 1) return;                                           // o 1º segundo inclui a troca
      t.best = Math.max(t.best, ran / want);
      if (t.n >= 4) {
        smart.trial = null;
        if (t.best >= t.before * 1.08 && t.best > t.before + 0.03) { smart.ok = true; post({ t: 'gpusmart', v: 'ok' }); log(`Inteligente: GPU em 2ª thread valeu (${(t.before * 100).toFixed(0)}% -> ${(t.best * 100).toFixed(0)}% da velocidade) - mantida`); }
        else { smart.bad = true; cfg.gpuThread = false; post({ t: 'gpusmart', v: 'bad' }); log(`Inteligente: GPU em 2ª thread não ajudou (${(t.before * 100).toFixed(0)}% -> ${(t.best * 100).toFixed(0)}%) - voltando para uma thread`); applyRenderer(); }
      }
      return;
    }
    auto.peak = Math.max(work, (auto.peak || 0) * 0.985);              // pico recente de custo por quadro (cenas pesadas, ex.: luta 3D, mantêm o pico alto)
    const behind = ran < want * 0.9, idle = ran >= want * 0.97 && work < period * 0.4 && auto.peak < period * 0.6;
    auto.slow = behind ? auto.slow + 1 : 0; auto.fast = idle ? auto.fast + 1 : 0;
    const move = ns => { auto.scale = ns; auto.slow = auto.fast = 0; applyRenderer(); };
    if (auto.slow >= 2 && !R && canThread() && !smart.trial) {            // atrasado (em qualquer escala): antes de baixar a qualidade, testa a GPU em 2ª thread
      smart.trial = { before: ran / want, n: 0, best: 0 }; cfg.gpuThread = true; auto.slow = auto.fast = 0;
      log(`Inteligente: ${ran}/${want.toFixed(0)} quadros/s - testando a GPU em 2ª thread (${auto.scale ? auto.scale + 'x' : 'software'})`); applyRenderer();
    } else if (auto.slow >= 2 && auto.scale > 0) {                       // não acompanha: desce um degrau (até o software) e lembra que esse degrau falhou
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
  const syncInfo = () => {
    let s = '';
    if (aStat) s += ` · áudio ${aStat.ms.toFixed(0)}/${alvo} ms (falta ${aStat.under}, sobra ${aStat.drops}) · ritmo ${((speedScale - 1) * 100).toFixed(2)}%`;
    if (jit.length > 20) { const a = jit.slice().sort((x, y) => x - y); s += ` · irregularidade p95 ${a[Math.floor(a.length * 0.95)].toFixed(1)} ms`; }
    return s;
  };
  const run = () => {
    if (!running || paused || hidden) { lastT = performance.now(); return; }
    if (fallback && !applying) { fallback = false; applyRenderer(); }
    if (R && (R.inflight >= 4 || dumpWait)) return;                       // o rasterizador está atrasado: espera (a emulação não corre à frente da imagem)
    try {
      const now = performance.now(); acc = Math.min(acc + Math.min(now - lastT, 100), 100); lastT = now;
      const base = psx.gpu.pal ? 20 : 16.6833;
      speedScale = 1;
      if (ap && aStat && !turbo && now - aStatT < 600) speedScale = 1 + Math.max(-0.005, Math.min(0.005, (aAvg - alvo) / alvo * 0.01));   // buffer cheio: desacelera um pouco; vazio: acelera
      const period = base * speedScale;
      let n = 0;
      if (turbo) n = 4; else { while (acc >= period - 0.5 && n < 3) { acc -= period; n++; } if (acc > period) acc = period; }
      if (!n) return;
      const w0 = performance.now();
      for (let i = 0; i < n; i++) {
        psx.gpu.skipDraw = fskip && i < n - (psx.gpu.rowMask >= 0 ? 3 : 2);   // desenha os 2 últimos (jogos com buffer duplo exibem o buffer do quadro anterior)
        const pcm = psx.runFrame();
        if (!turbo && pcm.length) { if (ap) ap.postMessage(pcm, [pcm.buffer]); else post({ t: 'audio', pcm }, [pcm.buffer]); }
      }
      const w1 = performance.now(); sumEmu += w1 - w0; sumFrames += n;
      psx.gpu.skipDraw = false;
      if (video) video.present(psx.gpu);
      if (!turbo) { const pn = performance.now(); if (lastPres) { jit.push(Math.abs(pn - lastPres - base * n)); if (jit.length > 120) jit.shift(); } lastPres = pn; }
      sumVid += performance.now() - w1;
      if (auto.on && !turbo && video) {
        const e = performance.now(); auto.ran += n; auto.work += e - w0;
        if (!auto.t) auto.t = e; else if (e - auto.t >= 1000) { const ran = auto.ran, wk = auto.work / Math.max(1, ran), ms = e - auto.t; auto.ran = 0; auto.work = 0; auto.t = e; adapt(ran, wk, period, ms); }
      }
      frameCount += n; if (frameCount >= 60) { const t = performance.now(); post({ t: 'fps', s: (frameCount * 1000 / (t - t0)).toFixed(1) + ' fps' + (turbo ? ' (turbo)' : '') + ` · emu ${(sumEmu / sumFrames).toFixed(1)} ms (${psx.wasm ? 'wasm' : psx.useJit ? 'jit' : 'interp'}) · vídeo ${(sumVid / sumFrames).toFixed(1)} ms/quadro` + syncInfo() }); t0 = t; frameCount = 0; sumEmu = sumVid = sumFrames = 0; }
    } catch (e) { crash(e); }
  };

  // ---- memory cards: avisa a página dos cartões alterados (ela grava no IndexedDB) e do texto de informação ----
  const cardInfo = s => { const c = psx.sio.cards[s]; if (!c) return ''; const n = c.listSaves().length; return `${n} save(s), ${c.freeBlocks()} bloco(s) livre(s)`; };
  setInterval(() => {
    if (!psx) return;
    for (const s of [0, 1]) { const c = psx.sio.cards[s]; if (c && c.dirty) { const b = c.export(); post({ t: 'cardData', slot: s, bytes: b }, [b.buffer]); } }
    post({ t: 'cards', info: [cardInfo(0), cardInfo(1)], have: [!!psx.sio.cards[0], !!psx.sio.cards[1]], lid: !!(psx.disc || lidOpen) });
  }, 1000);

  // disco: File/Blob vindos da página (leitura preguiçosa por BlobSource) ou bytes já lidos (compatibilidade)
  const makeDisc = d => d.blobs ? PS1.DiscImage.fromCue(d.cue, new Map(d.blobs.map(([n, f]) => [n, new PS1.BlobSource(f)])))
    : d.cue ? PS1.DiscImage.fromCue(d.cue, new Map(d.map)) : d.blob ? new PS1.DiscImage(new PS1.BlobSource(d.blob)) : new PS1.DiscImage(d.bytes);
  const setGame = () => { try { const i = psx.disc && psx.disc.info(); gameKey = i ? (i.volume || 'disco') + ':' + i.setores : 'sem-disco'; } catch { gameKey = 'disco'; } post({ t: 'game', key: gameKey }); };

  const init = async m => {
    psx = new PSX(); psx.onTTY = s => log(s.replace(/\n$/, ''));
    cfg = { mode: m.mode, smooth: !!m.smooth, gpuThread: !!m.gpuThread }; Object.assign(auto, m.probe || {});
    smart.ok = m.gpuS === 'ok'; smart.bad = m.gpuS === 'bad'; smart.blocked = !!m.gptBlocked;
    if (!cfg.gpuThread && cfg.mode < 0 && smart.ok && canThread()) { cfg.gpuThread = true; log('Inteligente: este jogo já se deu bem com a GPU em 2ª thread - ligando'); }
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
    psx.gpu.deint = m.deint === undefined ? 1 : m.deint | 0;
    psx.useJit = m.jit !== false;
    if (m.wasm !== false) log(psx.enableWasm() ? 'CPU: WebAssembly' : 'CPU: WebAssembly indisponível, usando JIT');
    psx.pollSkip = m.poll !== false; fskip = m.fskip === true;
    const side = () => {
      if (m.side && psx.disc) {
        log('Sideload: rodando BIOS até o shell...');
        if (psx.bootToShell()) { const exe = psx.bootDiscExe(); log('EXE carregado: ' + exe.path); } else log('BIOS não chegou ao shell.');
      }
    };
    if (cfg.gpuThread) side();                                              // GPU em thread: o boot do BIOS roda aqui e a VRAM resultante é copiada para o worker
    await applyRenderer();
    if (!cfg.gpuThread) side();
    setGame(); running = true; paused = false; lastT = t0 = performance.now(); acc = 0; frameCount = 0; auto.t = 0;
    post({ t: 'ready' }); frame();
  };

  // ---- pedidos com resposta ----
  const ops = {
    saveState: async m => { await pullVram(); const raw = psx.saveState({ game: m.game || gameKey }); return [raw, [raw.buffer]]; },
    loadState: m => { psx.loadState(m.raw); acc = 0; if (R) syncRemote(); return [null]; },
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
        case 'audioPort': ap = m.port; ap.onmessage = ev => { aStat = ev.data; aStatT = performance.now(); aAvg = aAvg < 0 ? aStat.ms : aAvg + (aStat.ms - aAvg) * 0.05;
      const tn = aStatT; if (aStat.under > lastUnder) { if (tn - underT > 2000) alvo = Math.min(160, alvo + 15); lastUnder = aStat.under; underT = tn; } else if (alvo > 70 && tn - underT > 20000) { alvo -= 5; underT = tn; } };   // média suave (~1 s): o nível oscila ±1 quadro entre um bloco e outro break;
        case 'canvas': if (canvasWait) { const r = canvasWait; canvasWait = null; r(m.canvas); } break;
        case 'sio': for (const [f, a] of m.calls) { if (f === 'padConnected') psx.sio.padConnected[a[0]] = a[1]; else psx.sio[f](...a); } break;
        case 'pause': paused = !!m.v; if (!paused) { lastT = t0 = performance.now(); acc = 0; frameCount = 0; auto.t = 0; auto.ran = auto.work = 0; } break;
        case 'hidden': hidden = !!m.v; if (!hidden) { lastT = performance.now(); acc = 0; } break;
        case 'turbo': turbo = !!m.v; break;
        case 'jit': if (!psx.wasm) psx.useJit = !!m.v; break;
        case 'poll': psx.pollSkip = !!m.v; break;
        case 'fskip': fskip = !!m.v; if (!fskip && psx) psx.gpu.skipDraw = false; break;
        case 'deint': psx.gpu.deint = m.v | 0; if (R && gw) gw.postMessage({ t: 'deint', v: m.v | 0 }); break;
        case 'smooth': cfg.smooth = !!m.v; if (video && video.r) video.r.opts.smooth = cfg.smooth; if (R && gw) gw.postMessage({ t: 'smooth', v: cfg.smooth }); break;
        case 'gpuThread': cfg.gpuThread = !!m.v; if (psx) applyRenderer(); break;
        case 'renderer': cfg.mode = m.mode; cfg.smooth = !!m.smooth; if (psx) applyRenderer(); break;
        case 'analog': { const on = psx.sio.toggleAnalog(m.port || 0); log('Modo analógico: ' + (on ? 'ligado' : 'desligado (ou travado pelo jogo / controle é digital)')); break; }
        case 'req': {
          try { const [v, tr] = await ops[m.op](m); post({ t: 'res', id: m.id, ok: true, value: v }, tr || []); }
          catch (err) { post({ t: 'res', id: m.id, ok: false, err: String(err && err.message || err) }); }
          break;
        }
      }
    } catch (err) { crash(err); }
  };
})();
