// Script clássico (sem import): usa o global PS1 criado por dist/ps1emu.js
const { PSX, VideoOut, GLVideoOut, AudioOut } = PS1;
const $ = id => document.getElementById(id);
const log = s => { const l = $('log'); l.textContent += s + '\n'; l.scrollTop = l.scrollHeight; };
const bytes = async f => new Uint8Array(await f.arrayBuffer());
const psx = new PSX(), audio = new AudioOut();
let video = null, R = null;                                           // R = RemoteMachine (modo Worker) ou null (tudo na thread principal)
const workerOK = typeof Worker !== 'undefined' && typeof OffscreenCanvas !== 'undefined' && typeof HTMLCanvasElement !== 'undefined' && !!HTMLCanvasElement.prototype.transferControlToOffscreen && typeof PS1_WORKER_SRC === 'string';
psx.onTTY = s => log(s.replace(/\n$/, ''));

// ---- entrada: teclado + gamepad (InputManager), remapeável; configuração guardada no localStorage ----
const ls = { get: k => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { } } };
const input = new PS1.InputManager(psx), dbg = new PS1.Debugger(psx);
input.getPads = () => (navigator.getGamepads ? navigator.getGamepads() : []);
{ const saved = ls.get('ps1emu.input'); if (saved) { try { input.importConfig(saved); } catch { } } }
const saveInput = () => ls.set('ps1emu.input', input.exportConfig());
let capture = null;                                                  // { kind: 'key'|'pad'|'hot', name } enquanto espera o próximo input
const typing = e => /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName);
addEventListener('keydown', e => {
  if (capture && capture.kind !== 'pad') {
    e.preventDefault(); if (e.code === 'Escape') { capture = null; return renderMap(); }
    if (capture.kind === 'key') input.bindKey(capture.name, e.code); else input.bindHotkey(capture.name, e.code);
    capture = null; saveInput(); return renderMap();
  }
  if (typing(e) && !input.hotkeys[e.code]) return;
  if (e.repeat && input.hotkeys[e.code]) { e.preventDefault(); return; }
  if (input.keyEvent(e.code, true)) e.preventDefault();
});
addEventListener('keyup', e => { if (input.keyEvent(e.code, false)) e.preventDefault(); });
addEventListener('blur', () => input.releaseAll());

// ---- renderizador: software (2D) ou WebGL2 com resolução interna 1x..8x; pode trocar com o jogo rodando ----
const freshCanvas = () => { const old = $('screen'), c = document.createElement('canvas'); c.id = 'screen'; c.width = 320; c.height = 240; old.replaceWith(c); return c; };
// ---- modo ADAPTATIVO: escolhe o renderizador pelo aparelho e ajusta a resolução em tempo real conforme o desempenho ----
const auto = { on: false, scale: 0, max: 4, slow: 0, fast: 0, fail: {}, tries: {}, ran: 0, work: 0, t: 0, why: '' };
const probeDevice = () => {                                           // decide o ponto de partida (sem rodar nada pesado)
  const mobile = matchMedia('(pointer:coarse)').matches || /Android|iPhone|iPad|Mobi/i.test(navigator.userAgent);
  const cores = navigator.hardwareConcurrency || 4, mem = navigator.deviceMemory || (mobile ? 4 : 8);
  let gpuName = '', maxTex = 0, gl2 = false;
  try {
    const c = document.createElement('canvas'), gl = c.getContext('webgl2');
    if (gl) { gl2 = true; maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE); const x = gl.getExtension('WEBGL_debug_renderer_info'); gpuName = x ? String(gl.getParameter(x.UNMASKED_RENDERER_WEBGL)) : '';
      gl.getExtension('WEBGL_lose_context')?.loseContext(); }
  } catch { }
  const soft = /swiftshader|llvmpipe|softpipe|software|basic render/i.test(gpuName);      // WebGL emulado na CPU: o rasterizador por software é melhor
  let scale, max;
  if (!gl2 || soft) { scale = 0; max = 0; }
  else if (mobile) {                                                  // celular: começa SEMPRE em 1x (a CPU é o gargalo); só sobe se sobrar folga medida
    const lowGpu = /adreno[^0-9]*(5\d\d|60\d|61\d|62\d)\b|mali-(g[35]\d|t\d|4\d\d)|powervr|videocore/i.test(gpuName);
    const weak = lowGpu || mem <= 3 || cores <= 4;                   // GPU/CPU fracas: o renderizador por software costuma ser MAIS rápido (medido num Moto G15 / Mali-G52: WebGL pesa nos comandos)
    scale = weak ? 0 : 1; max = weak ? 1 : (mem >= 6 && cores >= 8 ? 3 : 2);
  }
  else { max = (cores >= 8 && mem >= 8) ? 4 : 3; scale = Math.min(max, cores >= 8 ? 3 : 2); }
  if (maxTex && maxTex < 4096) { max = Math.min(max, 2); scale = Math.min(scale, 2); }
  for (let L = scale + 1; L <= max; L++) { const t = +ls.get('ps1.afail.' + L) || 0; if (t && Date.now() - t < 3 * 864e5) { max = L - 1; break; } }   // já falhou neste aparelho nos últimos 3 dias: não tenta de novo
  return { scale, max, why: `${mobile ? 'celular/tablet' : 'computador'}, ${cores} núcleos, ${mem}GB, GPU: ${gpuName || '?'}${soft ? ' (WebGL por software → usando renderizador de CPU)' : ''}` };
};
const applyRenderer = () => {
  let mode = +$('renderer').value;
  auto.on = mode < 0;
  if (auto.on) { if (!auto.probed) { const d = probeDevice(); Object.assign(auto, { scale: d.scale, max: d.max, why: d.why, probed: true }); log('Adaptativo: ' + d.why + ' → ' + (d.scale ? 'WebGL ' + d.scale + 'x' : 'software')); } mode = auto.scale; }
  if (video && video.dispose) video.dispose();
  if (psx.gpu.hw) psx.gpu.hw = null;
  let c = freshCanvas();
  if (mode) {
    try {
      video = new GLVideoOut(c, mode, psx, { smooth: $('smooth').checked });
      c.style.imageRendering = 'auto';
      $('rinfo').textContent = `${auto.on ? 'Adaptativo: ' : ''}WebGL2 ${video.scale}x (${1024 * video.scale}x${512 * video.scale} VRAM)`;
      log(`Renderizador: WebGL2 ${video.scale}x${auto.on ? ' (adaptativo)' : ''}`); return;
    } catch (e) { log('WebGL indisponível (' + e.message + ') - usando software'); c = freshCanvas(); auto.scale = 0; auto.max = 0; }
  }
  video = new VideoOut(c); $('rinfo').textContent = (auto.on ? 'Adaptativo: ' : '') + 'software'; log('Renderizador: software' + (auto.on ? ' (adaptativo)' : ''));
};
// chamado a cada janela de ~1 s com quadros emulados, tempo de trabalho médio e o ritmo pedido
const adapt = (ran, work, period, ms) => {
  if (!auto.on || document.hidden || ms > 1600) return;
  const want = ms / period, now = performance.now();
  auto.peak = Math.max(work, (auto.peak || 0) * 0.985);              // pico recente de custo por quadro (cenas pesadas, ex.: luta 3D, mantêm o pico alto)
  const behind = ran < want * 0.9, idle = ran >= want * 0.97 && work < period * 0.4 && auto.peak < period * 0.6;
  auto.slow = behind ? auto.slow + 1 : 0; auto.fast = idle ? auto.fast + 1 : 0;
  const move = ns => { auto.scale = ns; auto.slow = auto.fast = 0; applyRenderer(); };
  if (auto.slow >= 2 && auto.scale > 0) {                              // não acompanha: desce um degrau (até o software) e lembra que esse degrau falhou
    const from = auto.scale; auto.fail[from] = now; auto.tries[from] = (auto.tries[from] || 0) + 1; ls.set('ps1.afail.' + from, String(Date.now()));
    log(`Adaptativo: ${ran}/${want.toFixed(0)} quadros/s → ${from}x para ${from - 1 ? from - 1 + 'x' : 'software'}`); move(from - 1);
  } else if (auto.fast >= 10 && auto.scale < auto.max) {               // sobra folga de verdade e por bastante tempo: tenta subir (espera dobra a cada falha)
    const to = auto.scale + 1, wait = 60000 * Math.pow(2, auto.tries[to - 1] || 0);
    if (!auto.fail[to] || now - auto.fail[to] > wait) { log(`Adaptativo: folga de CPU → subindo para ${to}x`); auto.peak = work; move(to); } else auto.fast = 0;
  }
};
$('renderer').onchange = () => { if (R) R.post({ t: 'renderer', mode: +$('renderer').value, smooth: $('smooth').checked }); else if (video) applyRenderer(); };
$('smooth').onchange = () => { if (R) R.post({ t: 'smooth', v: $('smooth').checked }); else if (video && video.r) { video.r.opts.smooth = $('smooth').checked; } };

// ---- disco: .bin/.iso único, ou .cue + arquivos das trilhas (CD-DA) ----
const readDisc = async list => {
  const files = [...list]; if (!files.length) return null;
  const cueFile = files.find(f => /\.cue$/i.test(f.name));
  if (!cueFile) return { bytes: await bytes(files[0]) };
  const map = new Map(); for (const f of files) if (f !== cueFile) map.set(f.name, await bytes(f));
  return { cue: await cueFile.text(), map };
};
const makeDisc = d => d.cue ? PS1.DiscImage.fromCue(d.cue, d.map) : new PS1.DiscImage(d.bytes);

// ---- memory cards: carregar (.mcr/.mcd/VGS/DexDrive), baixar (cru 128KB, compatível com ePSXe/DuckStation) e AUTOSAVE no navegador ----
let autosave = false;                                                // IndexedDB disponível?
const download = (name, data) => {
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([data], { type: 'application/octet-stream' }));
  a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
};
const cardInfo = slot => {
  if (R) return R.cardInfo[slot] ? R.cardInfo[slot] + (autosave ? ' — salvo automaticamente no navegador' : ' — ALTERADO (baixe para guardar)') : '';
  const c = psx.sio.cards[slot]; if (!c) return '';
  const n = c.listSaves().length; return `${n} save(s), ${c.freeBlocks()} bloco(s) livre(s)${autosave ? ' — salvo automaticamente no navegador' : c.dirty ? ' — ALTERADO (baixe para guardar)' : ''}`;
};
const persistCards = async () => {                                    // grava os cartões alterados (export() zera o "dirty")
  if (!autosave || R) return;
  for (const s of [0, 1]) {
    const c = psx.sio.cards[s]; if (!c || !c.dirty) continue;
    try { await Store.put('cards', 'slot' + s, c.export()); } catch (e) { autosave = false; log('Autosave desativado: ' + e.message); }
  }
};
for (const slot of [0, 1]) {
  $('mc' + slot + 'save').onclick = async () => { if (R) { const b = await R.req('cardExport', { slot }); if (b) download(`memcard${slot + 1}.mcr`, b); return; } const c = psx.sio.cards[slot]; if (c) download(`memcard${slot + 1}.mcr`, c.export()); };
  $('mc' + slot + 'clear').onclick = async () => {
    if (!confirm(`Apagar o cartão ${slot + 1} guardado no navegador? (o próximo início cria um novo)`)) return;
    try { await Store.del('cards', 'slot' + slot); log(`Cartão ${slot + 1} guardado foi apagado`); } catch (e) { log('Erro: ' + e.message); }
  };
  $('mc' + slot).onchange = async e => {                      // trocar o cartão com o jogo rodando também funciona
    const f = e.target.files[0]; if (!f) return;
    try { if (R) { const l = await R.req('cardLoad', { slot, bytes: await bytes(f) }); log(`Cartão ${slot + 1}: ` + (l.join('; ') || 'vazio')); return; } const r = psx.loadMemoryCard(slot, await bytes(f)); psx.sio.cards[slot].dirty = true; log(`Cartão ${slot + 1}: ` + r.saves.map(s => `${s.code} "${s.title}"`).join('; ') || 'vazio'); }
    catch (err) { log('Cartão inválido: ' + err.message); }
  };
}
setInterval(() => { persistCards(); for (const s of [0, 1]) { $('mc' + s + 'info').textContent = cardInfo(s); $('mc' + s + 'save').disabled = R ? !R.haveCard[s] : !psx.sio.cards[s]; } }, 1000);
addEventListener('pagehide', persistCards); document.addEventListener('visibilitychange', () => { if (document.hidden) persistCards(); });

// ---- loop principal, pausa, turbo e erros ----
let running = false, paused = false, turbo = false, crashed = null, pendingOps = [], rafId = 0, frameCount = 0, t0 = 0, acc = 0, lastT = performance.now();
const gameKey = () => { if (R) return R.game; try { const i = psx.disc && psx.disc.info(); return i ? (i.volume || 'disco') + ':' + i.setores : 'sem-disco'; } catch { return 'disco'; } };
const crash = e => {
  crashed = e; running = false; log('ERRO no emulador: ' + (e && e.message || e)); console.error(e);
  $('dbgout').textContent = dbg.report(e); $('dbg').open = true; $('report').disabled = false; $('pause').disabled = true;
};
const frame = () => {
  rafId = requestAnimationFrame(frame);
  if (!running) return;
  try {
    input.poll();
    while (pendingOps.length) pendingOps.shift()();                 // salvar/carregar estado acontecem entre quadros
    if (R) { R.flush(); return; }                                    // modo Worker: a thread do emulador cuida de quadros/vídeo/áudio
    if (paused) return;
    // ritmo: 50 Hz (PAL) / 59,94 Hz (NTSC) independente da taxa do monitor (60/120/144 Hz...)
    const now = performance.now(); acc = Math.min(acc + Math.min(now - lastT, 100), 100); lastT = now;
    const period = psx.gpu.pal ? 20 : 16.6833;
    let n = 0;
    if (turbo) n = 4;
    else { while (acc >= period - 0.5 && n < 3) { acc -= period; n++; } if (acc > period) acc = period; }
    if (!n) return;
    const w0 = performance.now();
    for (let i = 0; i < n; i++) {
      psx.gpu.skipDraw = fskip && i < n - (psx.gpu.rowMask >= 0 ? 3 : 2);                  // atrasado: só os 2 últimos quadros do lote são desenhados (o exibido é o buffer desenhado no quadro anterior: desenhar só o último causava piscadas)
      const pcm = psx.runFrame();
      if (!turbo && audio.node) audio.push(pcm);
    }
    psx.gpu.skipDraw = false;
    video.present(psx.gpu);
    if (auto.on && !turbo) {
      const e = performance.now(); auto.ran += n; auto.work += e - w0;
      if (!auto.t) auto.t = e; else if (e - auto.t >= 1000) { const ran = auto.ran, wk = auto.work / Math.max(1, ran), ms = e - auto.t; auto.ran = 0; auto.work = 0; auto.t = e; adapt(ran, wk, period, ms); }
    }
    frameCount += n; if (frameCount >= 60) { const t = performance.now(); $('fps').textContent = (frameCount * 1000 / (t - t0)).toFixed(1) + ' fps' + (turbo ? ' (turbo)' : ''); t0 = t; frameCount = 0; }
  } catch (e) { crash(e); }
};
const setPaused = p => { paused = p; if (R) R.post({ t: 'pause', v: p }); $('pause').textContent = p ? 'Continuar' : 'Pausar'; if (!p) { input.releaseAll(); t0 = lastT = performance.now(); acc = 0; frameCount = 0; auto.t = 0; auto.ran = auto.work = 0; } };
$('pause').onclick = () => setPaused(!paused);
addEventListener('error', e => log('Erro: ' + e.message));
addEventListener('unhandledrejection', e => log('Erro (promessa): ' + (e.reason && e.reason.message || e.reason)));

// ---- save states: 5 slots no IndexedDB (gzip) + exportar/importar arquivo ----
const SLOTS = 5, slotKey = n => gameKey() + '#' + n;
const fmtTime = t => new Date(t).toLocaleString();
const refreshSlots = async () => {
  const sel = $('slot'), cur = sel.value || '1'; sel.innerHTML = '';
  for (let n = 1; n <= SLOTS; n++) {
    let txt = 'vazio';
    if (autosave) { try { const r = await Store.get('states', slotKey(n)); if (r) txt = `${fmtTime(r.at)} — quadro ${r.meta.frames}`; } catch { } }
    const o = document.createElement('option'); o.value = n; o.textContent = `Slot ${n}: ${txt}`; sel.appendChild(o);
  }
  sel.value = cur;
};
const needGame = () => { if (!running) { log('Inicie o emulador primeiro'); return false; } return true; };
const saveSlot = n => needGame() && pendingOps.push(async () => {
  try {
    const raw = R ? await R.req('saveState', { game: gameKey() }) : psx.saveState({ game: gameKey() }), z = await PS1.gzip(raw), meta = PS1.readStateMeta(raw);
    if (!autosave) { download(`estado-${n}.ps1state`, z); log('Estado exportado como arquivo (sem IndexedDB)'); return; }
    await Store.put('states', slotKey(n), { bytes: z, meta, at: Date.now() });
    log(`Estado salvo no slot ${n} (${(z.length / 1024).toFixed(0)} KB)`); refreshSlots();
  } catch (e) { log('Falha ao salvar estado: ' + e.message); }
});
const applyState = async (z, label) => {
  try {
    const raw = PS1.isGzip(z) ? await PS1.gunzip(z) : z, meta = PS1.readStateMeta(raw);
    if (meta.game && meta.game !== gameKey() && !confirm(`O estado é de outro jogo (${meta.game}). Carregar mesmo assim?`)) return;
    pendingOps.push(() => {
      const done = () => { input.releaseAll(); log(`Estado carregado (${label}, quadro ${meta.frames})`); }, fail = e => log('Estado inválido: ' + e.message + ' — emulador mantido no estado anterior se possível; reinicie se algo estranho acontecer');
      if (R) { R.req('loadState', { raw }).then(done, fail); return; }
      try { psx.loadState(raw); done(); } catch (e) { fail(e); }
    });
  } catch (e) { log('Estado inválido: ' + e.message); }
};
const loadSlot = async n => {
  if (!needGame()) return;
  try { const r = autosave && await Store.get('states', slotKey(n)); if (!r) return log(`Slot ${n} está vazio`); await applyState(r.bytes, 'slot ' + n); } catch (e) { log('Falha ao ler o estado: ' + e.message); }
};
$('ssave').onclick = () => saveSlot(+$('slot').value); $('sload').onclick = () => loadSlot(+$('slot').value);
$('sdel').onclick = async () => { try { await Store.del('states', slotKey(+$('slot').value)); refreshSlots(); } catch (e) { log(e.message); } };
$('sexport').onclick = () => needGame() && pendingOps.push(async () => { const z = await PS1.gzip(R ? await R.req('saveState', { game: gameKey() }) : psx.saveState({ game: gameKey() })); download('estado.ps1state', z); });
$('simport').onchange = async e => { const f = e.target.files[0]; e.target.value = ''; if (f && needGame()) await applyState(await bytes(f), f.name); };

// ---- ações das teclas de atalho ----
input.onHotkey = act => {
  if (act === 'pause') setPaused(!paused);
  else if (act === 'save') saveSlot(+$('slot').value);
  else if (act === 'load') loadSlot(+$('slot').value);
  else if (act === 'fullscreen') toggleFullscreen();
  else if (act === 'analog' && R) R.post({ t: 'analog', port: 0 });
  else if (act === 'analog') { const on = psx.sio.toggleAnalog(0); log('Modo analógico: ' + (on ? 'ligado' : 'desligado (ou travado pelo jogo / controle é digital)')); }
  else if (act === 'turbo') { turbo = !turbo; if (R) R.post({ t: 'turbo', v: turbo }); log('Turbo ' + (turbo ? 'ligado' : 'desligado')); }
};
const toggleFullscreen = () => {
  if (document.fullscreenElement) document.exitFullscreen(); else { const s = $('stage'); (s.requestFullscreen || s.webkitRequestFullscreen)?.call(s); }
};
$('fs').onclick = toggleFullscreen;

// ---- tela de controles: tipo de controle, remapeamento (teclado e gamepad), zona morta, vibração ----
const BTN_NAMES = ['up', 'down', 'left', 'right', 'cross', 'circle', 'square', 'triangle', 'l1', 'r1', 'l2', 'r2', 'l3', 'r3', 'start', 'select'];
const ACT_NAMES = { pause: 'Pausar', save: 'Salvar estado', load: 'Carregar estado', fullscreen: 'Tela cheia', analog: 'Alternar analógico', turbo: 'Turbo' };
const keyOf = b => Object.keys(input.keys).filter(k => input.keys[k] === b).join(' / ') || '—';
const padOf = b => Object.keys(input.padMap).filter(i => input.padMap[i] === b).join(', ') || '—';
const hotOf = a => Object.keys(input.hotkeys).filter(k => input.hotkeys[k] === a).join(' / ') || '—';
function renderMap() {
  const t = $('map'); t.innerHTML = '<tr><th>Botão</th><th>Teclado</th><th>Gamepad</th></tr>';
  const cell = (txt, kind, name) => { const td = document.createElement('td'), b = document.createElement('button'); b.textContent = capture && capture.kind === kind && capture.name === name ? 'pressione… (Esc cancela)' : txt;
    b.onclick = () => { capture = { kind, name }; renderMap(); }; td.appendChild(b); return td; };
  for (const b of BTN_NAMES) { const tr = document.createElement('tr'), th = document.createElement('td'); th.textContent = b; tr.appendChild(th); tr.appendChild(cell(keyOf(b), 'key', b)); tr.appendChild(cell('botão ' + padOf(b), 'pad', b)); t.appendChild(tr); }
  for (const a of Object.keys(ACT_NAMES)) { const tr = document.createElement('tr'), th = document.createElement('td'); th.textContent = ACT_NAMES[a]; tr.appendChild(th); tr.appendChild(cell(hotOf(a), 'hot', a)); tr.appendChild(document.createElement('td')); t.appendChild(tr); }
}
const origPoll = input.poll.bind(input);
input.poll = () => {                                                  // captura de botão de gamepad durante o remapeamento
  if (capture && capture.kind === 'pad') {
    const g = [...(input.getPads() || [])].find(x => x && x.connected);
    if (g) { const i = g.buttons.findIndex(b => b.pressed); if (i >= 0) { input.bindPad(capture.name, i); capture = null; saveInput(); renderMap(); } }
    return;
  }
  origPoll();
};
$('map').addEventListener('click', e => { if (e.target.textContent.startsWith('botão')) capture = { kind: 'pad', name: BTN_NAMES.find(b => e.target.closest('tr').firstChild.textContent === b) }, renderMap(); });
for (const p of [0, 1]) $('ptype' + p).onchange = () => { (R || psx).sio.setPadType(p, $('ptype' + p).value); ls.set('ps1emu.ptype' + p, $('ptype' + p).value); if (p === 1 && $('ptype1').value !== 'none') (R || psx).sio.padConnected[1] = true; };
$('deadzone').oninput = () => { input.deadzone = $('deadzone').value / 100; saveInput(); };
$('rumble').onchange = () => { input.rumbleOn = $('rumble').checked; saveInput(); };
$('mapreset').onclick = () => { input.resetBindings(); saveInput(); renderMap(); };
setInterval(() => {
  const pads = [...(navigator.getGamepads ? navigator.getGamepads() : [])].filter(g => g && g.connected);
  $('padinfo').textContent = pads.length ? pads.map((g, i) => `P${i + 1}: ${g.id.slice(0, 40)}`).join(' | ') : 'nenhum gamepad detectado (aperte um botão nele)';
}, 1000);
$('deadzone').value = Math.round(input.deadzone * 100); $('rumble').checked = input.rumbleOn; renderMap();
for (const p of [0, 1]) { const v = ls.get('ps1emu.ptype' + p); if (v) { $('ptype' + p).value = v; if (v !== 'none') psx.sio.setPadType(p, v); } }

// ---- depurador ----
const dshow = s => { $('dbgout').textContent = s; };
const noDbg = () => { if (!R) return false; dshow('Depurador indisponível no modo Worker (desmarque "Thread separada" e reinicie o emulador).'); return true; };
$('dregs').onclick = () => noDbg() || dshow(dbg.regs() + '\n' + dbg.listing(psx.cpu.pc, 4, 10));
$('dstep').onclick = () => { if (noDbg()) return; try { dbg.stepInstr(); dshow(dbg.regs() + '\n' + dbg.listing(psx.cpu.pc, 4, 10)); } catch (e) { dshow(String(e)); } };
$('drun').onclick = () => { if (noDbg()) return;
  const bp = parseInt($('dbp').value.replace(/^0x/i, ''), 16);
  if (!Number.isNaN(bp)) dbg.addBreak(bp);
  setPaused(true); const hit = dbg.run(20_000_000); dshow((hit === null ? 'nenhum breakpoint em 20M instruções\n' : `breakpoint em ${hit.toString(16)}\n`) + dbg.regs() + '\n' + dbg.listing(psx.cpu.pc, 4, 10));
};
$('dclr').onclick = () => { for (const b of [...dbg.breaks]) dbg.delBreak(b); dshow('breakpoints removidos'); };
$('dtrace').onclick = () => { if (noDbg()) return; if (dbg.ring) { dbg.stopTrace(); dshow('trace desligado'); $('dtrace').textContent = 'Ligar trace'; } else { dbg.startTrace(512); dshow('trace ligado (usa o interpretador; mais lento)'); $('dtrace').textContent = 'Desligar trace'; } };
$('dshowtrace').onclick = () => noDbg() || dshow(dbg.traceText());
$('ddump').onclick = () => { if (noDbg()) return; const a = parseInt($('dbp').value.replace(/^0x/i, ''), 16); dshow(Number.isNaN(a) ? 'informe um endereço hex' : dbg.dump(a, 256)); };
$('report').onclick = () => download('relatorio-ps1emu.txt', R && R.report ? R.report : dbg.report(crashed));
$('jit').onchange = () => { psx.useJit = $('jit').checked; if (R) R.post({ t: 'jit', v: $('jit').checked }); };
psx.pollSkip = $('poll').checked;
// "Pular quadros" é lembrado POR JOGO (chave = nome + tamanho do arquivo do disco): seguro no Tekken 3, mas faz jogos que desenham aos poucos piscarem
const fskipKey = () => { const f = [...$('disc').files]; if (!f.length) return ''; const m = f.find(x => /\.cue$/i.test(x.name)) || f[0]; return 'ps1emu.fskip.' + m.name + ':' + m.size; };
let fskip = false;
const fskipLoad = () => { const k = fskipKey(); $('fskip').checked = !!k && ls.get(k) === '1'; fskip = $('fskip').checked; if (R) R.post({ t: 'fskip', v: fskip }); };
$('fskip').onchange = () => { fskip = $('fskip').checked; const k = fskipKey(); if (k) ls.set(k, fskip ? '1' : '0'); if (R) R.post({ t: 'fskip', v: fskip }); };
$('disc').addEventListener('change', fskipLoad); fskipLoad();
// GPU em 2ª thread (rasterizador em worker): lembrada por jogo; '0' = o jogo lê a VRAM de volta (não funciona), nunca liga sozinho
const gptKey = () => { const k = fskipKey(); return k ? k.replace('fskip', 'gpuT') : ''; };
const gpsKey = () => { const k = fskipKey(); return k ? k.replace('fskip', 'gpuS') : ''; };
const gptLoad = () => { const k = gptKey(); $('gpuT').checked = !!k && ls.get(k) === '1'; if (R) R.post({ t: 'gpuThread', v: $('gpuT').checked }); };
$('gpuT').onchange = () => { const k = gptKey(); if (k) ls.set(k, $('gpuT').checked ? '1' : '0'); if (R) R.post({ t: 'gpuThread', v: $('gpuT').checked }); };
$('disc').addEventListener('change', gptLoad); gptLoad();
$('poll').onchange = () => { psx.pollSkip = $('poll').checked; if (R) R.post({ t: 'poll', v: $('poll').checked }); };

// ---- modo Worker: o emulador roda em outra thread; aqui ficam UI, entrada, áudio e IndexedDB ----
const startRemote = async (biosFile, disc) => {
  try { await audio.start(); log('Áudio: ' + audio.mode); } catch (e) { log('Sem áudio: ' + e.message); }
  log(autosave ? 'Autosave: IndexedDB ativo' : 'Autosave indisponível neste navegador (use Baixar)');
  R = new PS1.RemoteMachine(PS1_WORKER_SRC); const r = R;
  input.psx = r; r.sio.onRumble = (p, sm, lg) => input.rumble(p, sm, lg);
  r.on.log = m => log(m.s); r.on.rinfo = m => { $('rinfo').textContent = m.s; };
  r.on.fps = m => { $('fps').textContent = m.s; };
  r.on.gpuread = () => { $('gpuT').checked = false; const k = gptKey(); if (k) ls.set(k, '0'); };
  r.on.gpusmart = m => { const k = gpsKey(); if (k) ls.set(k, m.v); };
  r.on.afail = m => ls.set('ps1.afail.' + m.level, String(Date.now()));
  r.on.audio = m => { if (audio.node) audio.push(m.pcm); };
  r.on.game = m => { r.game = m.key; refreshSlots(); };
  r.on.rumble = m => input.rumble(m.p, m.s, m.l);
  r.on.cards = m => { r.cardInfo = m.info; r.haveCard = m.have; r.hasDisc = m.lid; };
  r.on.cardData = async m => { if (!autosave) return; try { await Store.put('cards', 'slot' + m.slot, m.bytes); } catch (e) { autosave = false; log('Autosave desativado: ' + e.message); } };
  r.on.needCanvas = () => { const c = freshCanvas(); c.style.imageRendering = 'auto'; const oc = c.transferControlToOffscreen(); r.post({ t: 'canvas', canvas: oc }, [oc]); };
  r.on.crash = m => { crashed = new Error(m.msg); r.report = m.report; running = false; log('ERRO no emulador: ' + m.msg); $('dbgout').textContent = m.report; $('dbg').open = true; $('report').disabled = false; $('pause').disabled = true; };
  const ready = new Promise(res => { r.on.ready = res; });
  const cards = [];
  for (const slot of [0, 1]) {
    const f = $('mc' + slot).files[0]; let stored = null;
    if (!f && autosave) { try { stored = await Store.get('cards', 'slot' + slot); } catch { } }
    cards[slot] = f ? { bytes: await bytes(f), dirty: true } : stored ? { bytes: stored } : $('mcblank').checked ? { blank: true } : null;
  }
  const ptype = [0, 1].map(p => { const v = ls.get('ps1emu.ptype' + p); return v && v !== 'none' ? v : null; });
  const d = disc && (disc.cue ? { cue: disc.cue, map: [...disc.map] } : { bytes: disc.bytes });
  r.post({ t: 'init', bios: await bytes(biosFile), disc: d, cards, ptype, side: $('side').checked, jit: $('jit').checked, poll: $('poll').checked, fskip: fskip, gpuThread: $('gpuT').checked, gpuS: ls.get(gpsKey()) || '', gptBlocked: ls.get(gptKey()) === '0', mode: +$('renderer').value, smooth: $('smooth').checked, probe: (() => { const p = probeDevice(); auto.probed = true; log('Adaptativo: ' + p.why); return { scale: p.scale, max: p.max }; })() });
  await ready;
  running = true; crashed = null; $('pause').disabled = false; refreshSlots();
  document.addEventListener('visibilitychange', () => r.post({ t: 'hidden', v: document.hidden }));   // aba escondida: pausa a emulação (como o rAF fazia)
  log('Emulador rodando em thread separada (Worker)');
  cancelAnimationFrame(rafId); frame();
};

// ---- iniciar ----
$('start').onclick = async () => {
  if (running) return;
  try {
    const bios = $('bios').files[0], disc = $('disc').files.length ? await readDisc($('disc').files) : null;
    if (!bios) return alert('Selecione a BIOS (SCPH1001.BIN)');
    $('start').disabled = true;
    autosave = await Store.check();
    if ($('useworker') && $('useworker').checked && workerOK) return await startRemote(bios, disc);
    log(autosave ? 'Autosave: IndexedDB ativo' : 'Autosave indisponível neste navegador (use Baixar)');
    try { await audio.start(); log('Áudio: ' + audio.mode); } catch (e) { log('Sem áudio: ' + e.message); }
    log('BIOS: ' + psx.loadBios(await bytes(bios)));
    if (disc) log('Disco: ' + JSON.stringify(disc.cue ? psx.loadCue(disc.cue, disc.map) : psx.loadDisc(disc.bytes)));
    for (const slot of [0, 1]) {                                // arquivo escolhido > cartão guardado no navegador > em branco
      const f = $('mc' + slot).files[0];
      try {
        let stored = null; if (!f && autosave) { try { stored = await Store.get('cards', 'slot' + slot); } catch { } }
        if (f) { const r = psx.loadMemoryCard(slot, await bytes(f)); psx.sio.cards[slot].dirty = true; log(`Cartão ${slot + 1}: ${r.saves.map(s => s.code + ' "' + s.title + '"').join('; ') || 'vazio'} (${r.livres} livres)`); }
        else if (stored) { const r = psx.loadMemoryCard(slot, stored); log(`Cartão ${slot + 1}: restaurado do navegador (${r.saves.length} save(s))`); }
        else if ($('mcblank').checked) { psx.loadMemoryCard(slot); psx.sio.cards[slot].dirty = true; log(`Cartão ${slot + 1}: em branco`); }
      } catch (err) { log('Cartão ' + (slot + 1) + ' inválido: ' + err.message); }
    }
    psx.reset();
    applyRenderer();
    if ($('side').checked && psx.disc) {
      log('Sideload: rodando BIOS até o shell...');
      if (psx.bootToShell()) { const exe = psx.bootDiscExe(); log('EXE carregado: ' + exe.path); } else log('BIOS não chegou ao shell.');
    }
    running = true; crashed = null; t0 = performance.now(); frameCount = 0;
    $('pause').disabled = false; refreshSlots();
    cancelAnimationFrame(rafId); frame();
  } catch (e) { log('ERRO: ' + e.message); console.error(e); $('start').disabled = false; }
};

// ---- troca de disco com o jogo rodando ----
let lidOpen = false;
$('lid').onclick = () => {
  if (!lidOpen) { if (R) R.req('lid', { open: true }); else psx.openDiscLid(); lidOpen = true; $('lid').textContent = 'Fechar tampa'; $('lidinfo').textContent = 'tampa aberta — escolha outro disco acima (ou feche para manter o atual)'; }
  else { if (R) R.req('lid', { open: false }); else psx.closeDiscLid(psx.disc); lidOpen = false; $('lid').textContent = 'Abrir tampa'; $('lidinfo').textContent = ''; }
};
$('disc').addEventListener('change', async () => {
  if (!lidOpen || !$('disc').files.length) return;
  try {
    if (R) { const rd = await readDisc($('disc').files); log('Disco trocado: ' + JSON.stringify(await R.req('disc', { disc: rd.cue ? { cue: rd.cue, map: [...rd.map] } : { bytes: rd.bytes } }))); }
    else { const d = makeDisc(await readDisc($('disc').files)); psx.closeDiscLid(d); log('Disco trocado: ' + JSON.stringify(d.info())); refreshSlots(); }
  }
  catch (e) { log('Disco inválido: ' + e.message); return; }
  lidOpen = false; $('lid').textContent = 'Abrir tampa'; $('lidinfo').textContent = '';
});
setInterval(() => { $('lid').disabled = !(R ? R.hasDisc : psx.disc) && !lidOpen; }, 500);
