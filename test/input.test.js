// Entrada (teclado/gamepad/remapeamento/vibração) e depurador
import assert from 'node:assert/strict';
import { InputManager, DEFAULT_KEYS } from '../src/input.js';
import { Debugger } from '../src/debug.js';
import { PSX } from '../src/psx.js';

const tests = []; const test = (n, f) => tests.push([n, f]);
const mkPsx = () => new PSX();
const pressed = (psx, name, port = 0) => !(psx.sio.buttons[port] & (1 << { cross: 14, start: 3, up: 4, left: 7, l3: 1, circle: 13, square: 15 }[name]));
const gp = (index, buttons = {}, axes = [0, 0, 0, 0], extra = {}) => ({ index, connected: true, axes, buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: !!buttons[i], value: buttons[i] ? 1 : 0 })), ...extra });

test('teclado: pressiona/solta, hotkeys não vão para o controle', () => {
  const p = mkPsx(), im = new InputManager(p), hk = []; im.onHotkey = a => hk.push(a);
  assert.ok(im.keyEvent('KeyZ', true)); assert.ok(pressed(p, 'cross')); im.keyEvent('KeyZ', false); assert.ok(!pressed(p, 'cross'));
  assert.ok(im.keyEvent('F5', true)); assert.deepEqual(hk, ['save']); assert.equal(im.keyEvent('KeyY', true), false);
});
test('duas teclas no mesmo botão: só solta quando ambas soltas', () => {
  const p = mkPsx(), im = new InputManager(p); im.keyEvent('Enter', true); im.bindKey('start', 'Space'); im.keyEvent('Space', true);
  im.keyEvent('Enter', false); assert.ok(pressed(p, 'start')); im.keyEvent('Space', false); assert.ok(!pressed(p, 'start'));
});
test('remapear: tecla nova substitui, hotkey e botão não colidem; export/import preserva', () => {
  const p = mkPsx(), im = new InputManager(p); im.bindKey('circle', 'KeyP');                       // KeyP era hotkey de pausa
  assert.equal(im.hotkeys.KeyP, undefined); im.keyEvent('KeyP', true); assert.ok(pressed(p, 'circle'));
  im.bindHotkey('pause', 'KeyO'); assert.equal(im.hotkeys.KeyO, 'pause');
  const cfg = im.exportConfig(), im2 = new InputManager(mkPsx()); im2.importConfig(cfg); assert.equal(im2.keys.KeyP, 'circle'); assert.equal(im2.hotkeys.KeyO, 'pause');
  im2.importConfig(JSON.stringify({ keys: { KeyQ: 'nao-existe', KeyW: 'cross' } })); assert.deepEqual(im2.keys, { KeyW: 'cross' });
  assert.throws(() => im.bindKey('xyz', 'KeyK'));
});
test('gamepad: botões do layout standard; analógico esquerdo vira direcional no controle digital', () => {
  const p = mkPsx(), im = new InputManager(p); im.getPads = () => [gp(0, { 0: true, 9: true }, [-0.9, 0.1, 0, 0])]; im.poll();
  assert.ok(pressed(p, 'cross') && pressed(p, 'start') && pressed(p, 'left') && !pressed(p, 'up'));
  im.getPads = () => [gp(0)]; im.poll(); assert.ok(!pressed(p, 'cross') && !pressed(p, 'left'));
});
test('gamepad: teclado e gamepad combinam (OU)', () => {
  const p = mkPsx(), im = new InputManager(p); im.getPads = () => [gp(0, { 0: true })]; im.keyEvent('KeyX', true); im.poll();
  assert.ok(pressed(p, 'cross') && pressed(p, 'circle')); im.keyEvent('KeyX', false); im.poll(); assert.ok(pressed(p, 'cross') && !pressed(p, 'circle'));
});
test('DualShock: eixos analógicos 0..255 com zona morta; botão home alterna o modo', () => {
  const p = mkPsx(), im = new InputManager(p); p.sio.setPadType(0, 'dualshock');
  im.getPads = () => [gp(0, {}, [1, -1, 0.05, 0.5])]; im.poll();
  const [rx, ry, lx, ly] = p.sio.sticks[0]; assert.equal(lx, 0xFF); assert.equal(ly, 1); assert.equal(rx, 0x80); assert.ok(ry > 0xB0 && ry < 0xC4);
  assert.ok(!pressed(p, 'left'), 'sticks não viram direcional no DualShock');
  im.getPads = () => [gp(0, { 16: true })]; im.poll(); assert.equal(p.sio.pads[0].analog, true);
  im.poll(); assert.equal(p.sio.pads[0].analog, true, 'mantido pressionado não repete');
  im.getPads = () => [gp(0)]; im.poll(); im.getPads = () => [gp(0, { 16: true })]; im.poll(); assert.equal(p.sio.pads[0].analog, false);
});
test('2º gamepad liga a porta 2; desconectar solta tudo', () => {
  const p = mkPsx(), im = new InputManager(p); im.getPads = () => [gp(0), gp(1, { 0: true })]; im.poll();
  assert.equal(p.sio.padConnected[1], true); assert.ok(pressed(p, 'cross', 1));
  im.getPads = () => [gp(0)]; im.poll(); assert.ok(!pressed(p, 'cross', 1));
});
test('vibração: callback do SIO aciona playEffect/reset do gamepad', () => {
  const p = mkPsx(), im = new InputManager(p), ev = [];
  im.getPads = () => [gp(0, {}, [0, 0, 0, 0], { vibrationActuator: { playEffect: (t, o) => ev.push([t, o]), reset: () => ev.push('reset') } })];
  p.sio.onRumble(0, 1, 128); assert.equal(ev[0][0], 'dual-rumble'); assert.equal(ev[0][1].weakMagnitude, 1); assert.ok(Math.abs(ev[0][1].strongMagnitude - 128 / 255) < 1e-9);
  p.sio.onRumble(0, 0, 0); assert.equal(ev[1], 'reset'); im.rumbleOn = false; p.sio.onRumble(0, 1, 1); assert.equal(ev.length, 2);
});

test('depurador: registradores, listagem, passo, breakpoint, trace, relatório', () => {
  const p = mkPsx(), d = new Debugger(p), A = 0x80010000;
  // programa: addiu t0,zero,1 ; addiu t0,t0,1 ; addiu t0,t0,1 ; j A ; nop
  const prog = [0x24080001, 0x25080001, 0x25080001, 0x08000000 | ((A >>> 2) & 0x3FFFFFF), 0];
  prog.forEach((w, i) => p.bus.write32(A + i * 4, w)); p.cpu.pc = A; p.cpu.nextPc = A + 4;
  assert.match(d.regs(), /pc=80010000/); assert.match(d.listing(A, 0, 2), />.*80010000.*addiu/);
  d.stepInstr(); assert.equal(p.cpu.r[8], 1); assert.equal(p.cpu.pc >>> 0, A + 4);
  d.addBreak(A + 12); assert.equal(d.run(1000), A + 12); assert.equal(p.cpu.r[8], 3);
  d.delBreak(A + 12); d.startTrace(8); d.stepInstr(); d.stepInstr();
  assert.ok(d.traceText().split('\n').length >= 2); assert.match(d.report(new Error('boom')), /boom[\s\S]*Últimas instruções/);
  d.stopTrace(); assert.equal(p.onTrace, null);
  assert.match(d.dump(A, 16), /^80010000: 01 00 08 24/);
});
test('depurador: não toca registradores de I/O ao desmontar/despejar', () => {
  const p = mkPsx(), d = new Debugger(p); assert.equal(d.rd32(0x1F801810), 0); assert.equal(d.rd8(0x1F801800), 0);
});

let ok = 0;
for (const [n, f] of tests) { try { f(); console.log('  ok  ', n); ok++; } catch (e) { console.log('  FALHOU', n, '\n', e.stack); process.exitCode = 1; } }
console.log(`\n${ok} testes de entrada/depurador ok`);
