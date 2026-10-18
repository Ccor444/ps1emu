// ============================================================================
//  Entrada: teclado + Gamepad API -> controles do PSX (digital ou DualShock), remapeamento e vibração.
//  Sem dependência do DOM: recebe eventos/listas de gamepads (testável em Node).
// ============================================================================
import { BUTTONS } from './sio.js';

export const DEFAULT_KEYS = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', KeyZ: 'cross', KeyX: 'circle', KeyA: 'square',
  KeyS: 'triangle', KeyQ: 'l1', KeyW: 'r1', KeyE: 'l2', KeyR: 'r2', KeyD: 'l3', KeyC: 'r3', Enter: 'start', ShiftRight: 'select', Backspace: 'select' };
/** layout "standard" do Gamepad API (índice do botão -> botão do PSX) */
export const DEFAULT_PAD = { 0: 'cross', 1: 'circle', 2: 'square', 3: 'triangle', 4: 'l1', 5: 'r1', 6: 'l2', 7: 'r2', 8: 'select', 9: 'start', 10: 'l3', 11: 'r3',
  12: 'up', 13: 'down', 14: 'left', 15: 'right' };
export const DEFAULT_HOTKEYS = { KeyP: 'pause', F5: 'save', F7: 'load', F11: 'fullscreen', F9: 'analog', KeyT: 'turbo' };
export const ACTIONS = ['pause', 'save', 'load', 'fullscreen', 'analog', 'turbo'];
const ANALOG_BTN = 16;                                           // botão "home/guide" alterna o modo analógico

export class InputManager {
  constructor(psx) {
    this.psx = psx; this.keys = { ...DEFAULT_KEYS }; this.padMap = { ...DEFAULT_PAD }; this.hotkeys = { ...DEFAULT_HOTKEYS };
    this.deadzone = 0.2; this.rumbleOn = true; this.onHotkey = null; this.getPads = null;   // getPads: () => lista de gamepads
    this.kb = new Set(); this.virt = new Set(); this.gp = [new Set(), new Set()]; this.stickDpad = [new Set(), new Set()];
    this.assigned = [-1, -1]; this.prevHome = [false, false]; this.lastRumble = [null, null];
    psx.sio.onRumble = (port, small, large) => this.rumble(port, small, large);
  }

  // ---- teclado ----
  /** evento de teclado (code = KeyboardEvent.code); acompanha as teclas físicas para suportar 2 teclas no mesmo botão. true = tecla consumida */
  keyEvent(code, down) {
    const act = this.hotkeys[code]; if (act) { if (down && this.onHotkey) this.onHotkey(act); return true; }
    const b = this.keys[code]; if (!b) return false;
    this.held ??= new Set(); if (down) this.held.add(code); else this.held.delete(code);
    this.kb = new Set([...this.held].map(c => this.keys[c]).filter(Boolean)); this.apply(0); return true;
  }
  /** controle virtual (toque): conjunto de botões pressionados na porta 1 */
  setVirtual(names) { this.virt = new Set(names); this.apply(0); }
  /** analógico virtual: x,y em -1..1 (y positivo = para baixo); side = 'l' | 'r' */
  setVirtualStick(side, x, y) { const s = this.psx.sio; s.setStick(side + 'x', 0x80 + x * 127, 0); s.setStick(side + 'y', 0x80 + y * 127, 0); }
  releaseAll() { this.held = new Set(); this.kb = new Set(); this.virt = new Set(); this.gp = [new Set(), new Set()]; this.stickDpad = [new Set(), new Set()]; this.apply(0); this.apply(1); }

  // ---- remapeamento ----
  bindKey(button, code) {
    if (!(button in BUTTONS)) throw new Error('botão desconhecido ' + button);
    delete this.hotkeys[code]; this.keys[code] = button;
  }
  unbindKey(code) { delete this.keys[code]; }
  bindHotkey(action, code) { if (!ACTIONS.includes(action)) throw new Error('ação desconhecida'); for (const c of Object.keys(this.hotkeys)) if (this.hotkeys[c] === action) delete this.hotkeys[c]; delete this.keys[code]; this.hotkeys[code] = action; }
  bindPad(button, index) { for (const i of Object.keys(this.padMap)) if (this.padMap[i] === button) delete this.padMap[i]; this.padMap[index] = button; }
  resetBindings() { this.keys = { ...DEFAULT_KEYS }; this.padMap = { ...DEFAULT_PAD }; this.hotkeys = { ...DEFAULT_HOTKEYS }; }
  exportConfig() { return JSON.stringify({ keys: this.keys, pad: this.padMap, hotkeys: this.hotkeys, deadzone: this.deadzone, rumble: this.rumbleOn }); }
  importConfig(text) {
    const c = JSON.parse(text), ok = o => o && typeof o === 'object';
    if (ok(c.keys)) this.keys = Object.fromEntries(Object.entries(c.keys).filter(([, b]) => b in BUTTONS));
    if (ok(c.pad)) this.padMap = Object.fromEntries(Object.entries(c.pad).filter(([, b]) => b in BUTTONS));
    if (ok(c.hotkeys)) this.hotkeys = Object.fromEntries(Object.entries(c.hotkeys).filter(([, a]) => ACTIONS.includes(a)));
    if (typeof c.deadzone === 'number') this.deadzone = Math.max(0, Math.min(0.9, c.deadzone));
    if (typeof c.rumble === 'boolean') this.rumbleOn = c.rumble;
  }

  // ---- gamepads (chamar 1x por quadro) ----
  poll() {
    const list = (this.getPads ? this.getPads() : []) || [];
    const pads = [...list].filter(g => g && g.connected);
    // associa o 1º gamepad à porta 1 e o 2º à porta 2 (mantém a ordem de conexão)
    this.assigned = [0, 1].map(p => pads[p] ? pads[p].index : -1);
    for (let port = 0; port < 2; port++) {
      const g = pads[port]; const sio = this.psx.sio;
      if (!g) { if (this.gp[port].size || this.stickDpad[port].size) { this.gp[port].clear(); this.stickDpad[port].clear(); this.apply(port); this.centerSticks(port); } continue; }
      if (port === 1) sio.padConnected[1] = true;
      const pressed = new Set();
      for (const [i, name] of Object.entries(this.padMap)) { const b = g.buttons[i]; if (b && (b.pressed || b.value > 0.5)) pressed.add(name); }
      const ax = k => { const v = g.axes[k] || 0; return Math.abs(v) < this.deadzone ? 0 : v; }, lx = ax(0), ly = ax(1), rx = ax(2), ry = ax(3);
      const dual = sio.padType[port] === 'dualshock', ds = new Set();
      if (dual) {
        const to8 = v => 0x80 + Math.round(v * 127.5);
        sio.setStick('lx', to8(lx), port); sio.setStick('ly', to8(ly), port); sio.setStick('rx', to8(rx), port); sio.setStick('ry', to8(ry), port);
      } else {                                                         // controle digital: o analógico esquerdo vira direcional
        if (lx < -0.5) ds.add('left'); if (lx > 0.5) ds.add('right'); if (ly < -0.5) ds.add('up'); if (ly > 0.5) ds.add('down');
      }
      this.gp[port] = pressed; this.stickDpad[port] = ds;
      const home = !!(g.buttons[ANALOG_BTN] && g.buttons[ANALOG_BTN].pressed);
      if (home && !this.prevHome[port]) sio.toggleAnalog(port);
      this.prevHome[port] = home;
      this.apply(port);
    }
  }
  centerSticks(port) { for (const k of ['lx', 'ly', 'rx', 'ry']) this.psx.sio.setStick(k, 0x80, port); }
  /** combina todas as fontes (teclado só na porta 1) e escreve no SIO */
  apply(port) {
    const sio = this.psx.sio, want = new Set([...this.gp[port], ...this.stickDpad[port], ...(port === 0 ? this.kb : []), ...(port === 0 ? this.virt : [])]);
    for (const name of Object.keys(BUTTONS)) sio.setButton(name, want.has(name), port);
  }

  // ---- vibração ----
  rumble(port, small, large) {
    this.lastRumble[port] = [small, large];
    if (!this.rumbleOn || !this.getPads) return;
    const g = [...(this.getPads() || [])].filter(x => x && x.connected)[port], act = g && g.vibrationActuator;
    if (!act) return;
    try {
      if (!small && !large) { act.reset?.(); return; }
      act.playEffect?.('dual-rumble', { startDelay: 0, duration: 1000, weakMagnitude: small ? 1 : 0, strongMagnitude: large / 255 });
    } catch { /* navegador sem suporte: ignora */ }
  }
}
