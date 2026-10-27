// Interface: menu lateral (engrenagem) + controle virtual por toque. Script clássico; usa $, ls, input, psx, setPaused de main.js.
(() => {
  const body = document.body, gear = $('gear'), scrim = $('scrim');

  // ---------------- menu ----------------
  const setMenu = open => { body.classList.toggle('menu-open', open); gear.setAttribute('aria-expanded', String(open)); if (!open) document.activeElement?.blur?.(); };
  const toggleMenu = () => setMenu(!body.classList.contains('menu-open'));
  gear.onclick = toggleMenu; scrim.onclick = () => setMenu(false);
  addEventListener('keydown', e => { if (e.code === 'Escape' && !typingTarget(e)) { setMenu(!body.classList.contains('menu-open')); e.preventDefault(); } });
  function typingTarget(e) { return /^(INPUT|TEXTAREA)$/.test(e.target.tagName) && e.target.type !== 'checkbox' && e.target.type !== 'range'; }
  setMenu(true);                                                       // começa aberto (precisa escolher a BIOS); fecha ao iniciar
  $('start').addEventListener('click', () => { let n = 0; const t = setInterval(() => { if ($('start').disabled) { clearInterval(t); setMenu(false); } else if (++n > 100) clearInterval(t); }, 200); });   // jogo iniciou: libera a tela toda

  // ---------------- botão "Iniciar" no meio da tela ----------------
  // Aparece assim que a BIOS é escolhida e o menu fecha; ao escolher BIOS + jogo o menu fecha sozinho para ele aparecer.
  // Com jogo: inicia o jogo (BIOS + disco). Só com BIOS: inicia a BIOS (tela do console / memory cards).
  const big = $('bigstart'), startBtn = $('start');
  const discName = () => { const f = [...$('disc').files]; return f.length ? (f.find(x => /\.cue$/i.test(x.name)) || f[0]).name : ''; };
  const syncBig = () => {
    const bios = $('bios').files.length > 0, disc = $('disc').files.length > 0, started = startBtn.disabled;
    body.classList.toggle('can-start', bios && !started);
    $('bigstartTxt').textContent = disc ? '▶ Iniciar jogo' : '▶ Iniciar BIOS';
    $('bigstartSub').textContent = disc ? discName() : 'sem disco: abre a tela da BIOS';
  };
  let closedFor = '';                                                  // fecha o menu uma vez por combinação BIOS+jogo escolhida
  const picked = () => {
    syncBig();
    const bios = $('bios').files.length > 0, disc = $('disc').files.length > 0, key = bios && disc ? $('bios').files[0].name + '|' + discName() : '';
    if (key && key !== closedFor && !startBtn.disabled) { closedFor = key; setMenu(false); }
  };
  $('bios').addEventListener('change', picked); $('disc').addEventListener('change', picked);
  new MutationObserver(syncBig).observe(startBtn, { attributes: true, attributeFilter: ['disabled'] });
  big.onclick = () => { if (startBtn.disabled) return; body.classList.remove('can-start'); startBtn.click(); };
  syncBig();
  // BIOS lembrada neste aparelho (IndexedDB do site): escolhe uma vez e nas próximas visitas ela já vem preenchida. O jogo continua sendo escolhido a cada vez.
  { const saved = $('biosSaved'); let restoring = false;
    const mark = on => { saved.style.display = on ? '' : 'none'; };
    $('bios').addEventListener('change', async () => {
      const f = $('bios').files[0]; if (restoring || !f) return;
      if (f.size !== 524288) return;                                     // só BIOS de 512 KB (SCPH-xxxx); outros tamanhos não são guardados
      try { await Store.put('bios', 'bios', { name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) }); mark(true); } catch { }
    });
    $('biosForget').onclick = async () => { try { await Store.del('bios', 'bios'); } catch { } mark(false); try { $('bios').value = ''; } catch { } $('bios').dispatchEvent(new Event('change')); };
    (async () => {
      try {
        if (!await Store.check()) return;
        const r = await Store.get('bios', 'bios'); if (!r || !r.bytes || $('bios').files.length) return;
        const dt = new DataTransfer(); dt.items.add(new File([r.bytes], r.name || 'BIOS.BIN'));
        restoring = true; $('bios').files = dt.files; $('bios').dispatchEvent(new Event('change')); restoring = false; mark(true);
      } catch { restoring = false; }
    })();
  }

  // o FPS só aparece com o jogo rodando e some quando está vazio
  // ---------------- controle virtual (só digital) ----------------
  // Desempenho: nenhuma consulta ao DOM durante o toque. As zonas dos botões são medidas uma vez (layout) e o teste de
  // acerto é só aritmética; as classes visuais só mudam quando o estado do botão muda.
  const coarse = matchMedia('(pointer:coarse)').matches || navigator.maxTouchPoints > 0;
  let cfg = { on: coarse, op: 70, size: 100, haptic: true };
  try { Object.assign(cfg, JSON.parse(ls.get('ps1emu.vpad') || '{}')); } catch { }
  if (cfg.sticks) {                                                   // analógicos virtuais foram removidos (derrubavam o fps): volta a porta 1 para digital
    if ($('ptype0').value === 'dualshock') { $('ptype0').value = 'digital'; $('ptype0').onchange(); log('Analógicos virtuais removidos: porta 1 voltou para Digital'); }
    delete cfg.sticks; ls.set('ps1emu.vpad', JSON.stringify(cfg));
  }
  const save = () => ls.set('ps1emu.vpad', JSON.stringify(cfg));
  const vpad = $('vpad');
  let zones = null;                                                   // zonas de toque em coordenadas da tela; null = remedir
  const apply = () => {
    body.classList.toggle('vpad-on', !!cfg.on); body.classList.remove('vsticks');
    vpad.style.setProperty('--vop', (cfg.op / 100).toFixed(2)); vpad.style.setProperty('--k', (cfg.size / 100).toFixed(2));
    $('vpadOn').checked = !!cfg.on; $('vpadOp').value = cfg.op; $('vpadSize').value = cfg.size; $('vpadHaptic').checked = !!cfg.haptic;
    layout(); if (!cfg.on) { fingers.clear(); refresh(); }
  };
  // em retrato os gatilhos ficam logo abaixo da imagem; em paisagem ficam nos cantos (CSS)
  const layout = () => { vpad.style.setProperty('--vtop', (innerWidth * 0.75 + (parseFloat(getComputedStyle(body).getPropertyValue('--sat')) || 0)).toFixed(0) + 'px'); zones = null; };
  addEventListener('resize', layout); addEventListener('orientationchange', layout);
  $('vpadOn').onchange = e => { cfg.on = e.target.checked; save(); apply(); };
  $('vpadHaptic').onchange = e => { cfg.haptic = e.target.checked; save(); };
  $('vpadOp').oninput = e => { cfg.op = +e.target.value; save(); apply(); };
  $('vpadSize').oninput = e => { cfg.size = +e.target.value; save(); apply(); };

  // mede as zonas: botões redondos/retangulares (com folga para o dedo) e o direcional (8 direções por ângulo)
  const measure = () => {
    const z = { btn: [], dpad: null, els: new Map() };
    for (const el of vpad.querySelectorAll('[data-b]')) {
      const r = el.getBoundingClientRect(); if (!r.width) continue;
      const round = el.classList.contains('btn'), pad = round ? r.width * 0.18 : 7;
      z.btn.push({ n: el.dataset.b, cx: r.left + r.width / 2, cy: r.top + r.height / 2, hw: r.width / 2 + pad, hh: r.height / 2 + pad, round });
      z.els.set(el.dataset.b, el);
    }
    const d = vpad.querySelector('[data-dpad]'), r = d.getBoundingClientRect();
    if (r.width) z.dpad = { cx: r.left + r.width / 2, cy: r.top + r.height / 2, R: r.width / 2 * 1.12, dead: r.width * 0.09, els: { up: d.querySelector('.u'), down: d.querySelector('.d'), left: d.querySelector('.l'), right: d.querySelector('.r') } };
    return z;
  };
  const hit = (x, y) => {
    const names = new Set(); zones ??= measure();
    const dp = zones.dpad;
    if (dp) {
      const dx = x - dp.cx, dy = y - dp.cy, m = Math.hypot(dx, dy);
      if (m <= dp.R && m >= dp.dead) {
        const a = Math.atan2(dy, dx) * 57.29578;                      // 0 = direita, 90 = baixo
        if (a > -157.5 && a < -22.5) names.add('up'); if (a > 22.5 && a < 157.5) names.add('down');
        if (a > 112.5 || a < -112.5) names.add('left'); if (a > -67.5 && a < 67.5) names.add('right');
      }
    }
    for (const b of zones.btn) {
      const dx = x - b.cx, dy = y - b.cy;
      if (b.round ? dx * dx + dy * dy <= b.hw * b.hw : (Math.abs(dx) <= b.hw && Math.abs(dy) <= b.hh)) names.add(b.n);
    }
    return names;
  };

  // multitoque: cada dedo (pointerId) mapeia para os botões sob ele; o conjunto final é a união
  const held = new Set(), fingers = new Map(), shown = new Set();
  const buzz = () => { if (cfg.haptic) try { navigator.vibrate?.(8); } catch { } };
  const refresh = () => {
    const next = new Set(); for (const f of fingers.values()) for (const n of f) next.add(n);
    let added = false, changed = next.size !== held.size;
    for (const n of next) if (!held.has(n)) { added = true; changed = true; }
    if (!changed) return;
    held.clear(); for (const n of next) held.add(n);
    zones ??= measure();
    for (const n of new Set([...shown, ...held])) {                   // só mexe nas classes que mudaram
      const on = held.has(n); if (on === shown.has(n)) continue; on ? shown.add(n) : shown.delete(n);
      const el = zones.els.get(n) || zones.dpad?.els[n]; el?.classList.toggle('on', on);
    }
    input.setVirtual(held); if (added) buzz();
  };
  const same = (a, b) => { if (a.size !== b.size) return false; for (const x of a) if (!b.has(x)) return false; return true; };
  vpad.addEventListener('pointerdown', e => {
    const names = hit(e.clientX, e.clientY); if (!names.size) return;
    e.preventDefault(); vpad.setPointerCapture?.(e.pointerId);
    fingers.set(e.pointerId, names); refresh();
  });
  vpad.addEventListener('pointermove', e => {
    const f = fingers.get(e.pointerId); if (!f) return;
    const n = hit(e.clientX, e.clientY); if (same(n, f)) return;       // sem mudança: não faz nada
    fingers.set(e.pointerId, n); refresh();
  });
  const up = e => { if (fingers.delete(e.pointerId)) refresh(); };
  vpad.addEventListener('pointerup', up); vpad.addEventListener('pointercancel', up); vpad.addEventListener('lostpointercapture', up);
  vpad.addEventListener('contextmenu', e => e.preventDefault());

  // sem rolagem/zoom acidental na página inteira
  document.addEventListener('gesturestart', e => e.preventDefault());
  document.addEventListener('touchmove', e => { if (!e.target.closest('#menu')) e.preventDefault(); }, { passive: false });
  // o menu abrindo/fechando e a troca de tela cheia mudam as medidas
  new MutationObserver(() => { zones = null; }).observe(body, { attributes: true, attributeFilter: ['class'] });
  document.addEventListener('fullscreenchange', () => { zones = null; });

  apply();
})();
