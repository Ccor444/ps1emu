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

  // o FPS só aparece com o jogo rodando e some quando está vazio
  // ---------------- controle virtual ----------------
  const coarse = matchMedia('(pointer:coarse)').matches || navigator.maxTouchPoints > 0;
  let cfg = { on: coarse, sticks: false, op: 70 };
  try { Object.assign(cfg, JSON.parse(ls.get('ps1emu.vpad') || '{}')); } catch { }
  const save = () => ls.set('ps1emu.vpad', JSON.stringify(cfg));
  const vpad = $('vpad');
  const apply = () => {
    body.classList.toggle('vpad-on', !!cfg.on); body.classList.toggle('vsticks', !!cfg.on && !!cfg.sticks);
    vpad.style.setProperty('--vop', (cfg.op / 100).toFixed(2));
    $('vpadOn').checked = !!cfg.on; $('vpadSticks').checked = !!cfg.sticks; $('vpadOp').value = cfg.op;
    layout(); if (!cfg.on) { held.clear(); push(); }
  };
  // em retrato os gatilhos ficam logo abaixo da imagem; em paisagem ficam nos cantos (CSS)
  const layout = () => vpad.style.setProperty('--vtop', (innerWidth * 0.75 + (parseFloat(getComputedStyle(body).getPropertyValue('--sat')) || 0)).toFixed(0) + 'px');
  addEventListener('resize', layout); addEventListener('orientationchange', layout);
  $('vpadOn').onchange = e => { cfg.on = e.target.checked; save(); apply(); };
  $('vpadSticks').onchange = e => {
    cfg.sticks = e.target.checked; save(); apply();
    if (cfg.sticks && $('ptype0').value !== 'dualshock') { $('ptype0').value = 'dualshock'; $('ptype0').onchange(); log('Porta 1 trocada para DualShock (analógicos virtuais)'); }
  };
  $('vpadOp').oninput = e => { cfg.op = +e.target.value; save(); apply(); };

  // multitoque: cada dedo (pointerId) mapeia para os botões sob ele; o conjunto final é a união
  const held = new Set(), fingers = new Map(), sticks = new Map();
  const push = () => input.setVirtual(held);
  const press = (el, on) => el.classList.toggle('on', on);
  const dirOf = (el, x, y) => {
    const r = el.getBoundingClientRect(), dx = (x - r.left) / r.width - 0.5, dy = (y - r.top) / r.height - 0.5, out = new Set();
    if (Math.hypot(dx, dy) < 0.12) return out;
    const a = Math.atan2(dy, dx) * 180 / Math.PI;                       // 0 = direita, 90 = baixo
    if (a > -157.5 && a < -22.5) out.add('up'); if (a > 22.5 && a < 157.5) out.add('down');
    if (a > 112.5 || a < -112.5) out.add('left'); if (a > -67.5 && a < 67.5) out.add('right');
    return out;
  };
  const hits = (x, y) => {
    const names = new Set(), els = [];
    for (const el of document.elementsFromPoint(x, y)) {
      if (el.dataset?.dpad !== undefined) { for (const d of dirOf(el, x, y)) names.add(d); els.push(el); }
      else if (el.dataset?.b) { names.add(el.dataset.b); els.push(el); }
    }
    return { names, els };
  };
  const refresh = () => {
    held.clear(); for (const f of fingers.values()) for (const n of f.names) held.add(n);
    document.querySelectorAll('#vpad [data-b]').forEach(el => press(el, held.has(el.dataset.b)));
    const dp = vpad.querySelector('[data-dpad]');
    for (const [k, c] of [['up', 'u'], ['down', 'd'], ['left', 'l'], ['right', 'r']]) dp.querySelector('.' + c).classList.toggle('on', held.has(k));
    push();
  };
  const buzz = () => { try { navigator.vibrate?.(8); } catch { } };
  vpad.addEventListener('pointerdown', e => {
    const t = e.target.closest('[data-stick]'); if (t) { startStick(e, t); return; }
    const act = e.target.closest('[data-act]'); if (act) { e.preventDefault(); buzz(); input.onHotkey?.('analog'); press(act, true); setTimeout(() => press(act, false), 150); return; }
    const h = hits(e.clientX, e.clientY); if (!h.names.size) return;
    e.preventDefault(); vpad.setPointerCapture?.(e.pointerId);
    fingers.set(e.pointerId, { names: h.names }); buzz(); refresh();
  });
  vpad.addEventListener('pointermove', e => {
    const s = sticks.get(e.pointerId); if (s) { moveStick(e, s); return; }
    const f = fingers.get(e.pointerId); if (!f) return;
    const n = hits(e.clientX, e.clientY).names; let changed = n.size !== f.names.size; for (const x of n) if (!f.names.has(x)) changed = true;
    if (changed) { f.names = n; refresh(); }
  });
  const up = e => {
    if (sticks.has(e.pointerId)) { endStick(e); return; }
    if (fingers.delete(e.pointerId)) refresh();
  };
  vpad.addEventListener('pointerup', up); vpad.addEventListener('pointercancel', up); vpad.addEventListener('lostpointercapture', up);
  vpad.addEventListener('contextmenu', e => e.preventDefault());

  // analógicos virtuais
  function startStick(e, el) { e.preventDefault(); el.setPointerCapture?.(e.pointerId); const s = { el, side: el.dataset.stick }; sticks.set(e.pointerId, s); moveStick(e, s); buzz(); }
  function moveStick(e, s) {
    const r = s.el.getBoundingClientRect(), R = r.width / 2;
    let x = (e.clientX - (r.left + R)) / R, y = (e.clientY - (r.top + R)) / R; const m = Math.hypot(x, y); if (m > 1) { x /= m; y /= m; }
    s.el.firstElementChild.style.transform = `translate(${x * R * 0.55}px,${y * R * 0.55}px)`; input.setVirtualStick(s.side, x, y);
  }
  function endStick(e) { const s = sticks.get(e.pointerId); sticks.delete(e.pointerId); s.el.firstElementChild.style.transform = ''; input.setVirtualStick(s.side, 0, 0); }

  // sem rolagem/zoom acidental na página inteira
  document.addEventListener('gesturestart', e => e.preventDefault());
  document.addEventListener('touchmove', e => { if (!e.target.closest('#menu')) e.preventDefault(); }, { passive: false });

  apply();
})();
