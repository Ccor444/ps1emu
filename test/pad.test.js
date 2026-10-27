// Controles: digital, DualShock (modo analógico, configuração, vibração)
import assert from 'node:assert/strict';
import { SIO } from '../src/sio.js';

const sys = { sched: { call() {}, add() {} }, now: () => 0, irq() {} };
const tests = []; const test = (n, f) => tests.push([n, f]);
const hex = a => a.map(x => x.toString(16).padStart(2, '0')).join(' ');
function xfer(sio, tx, port = 0) {
  sio.ctrl = port << 13; sio.state = 0; sio.dev = null;
  const rx = []; for (const b of tx) rx.push(sio.exchange(b)[0]); return rx;
}
const mk = type => { const s = new SIO(sys); s.setPadType(0, type); return s; };

test('digital: 01 42 00 00 00 -> FF 41 5A lo hi', () => {
  const s = mk('digital'); s.setButton('cross', true); s.setButton('start', true);
  assert.equal(hex(xfer(s, [1, 0x42, 0, 0, 0])), 'ff 41 5a f7 bf');
});
test('digital: ignora sticks e comandos de configuração', () => {
  const s = mk('digital'); assert.equal(hex(xfer(s, [1, 0x43, 0, 1, 0])), 'ff 41 5a ff ff');
  assert.equal(s.pads[0].config, false);
});
test('porta 2 desconectada: sem ACK', () => { const s = new SIO(sys); assert.deepEqual(s.exchange(1), [0xFF, true]); s.state = 0; s.ctrl = 1 << 13; assert.deepEqual(s.exchange(1), [0xFF, false]); });
test('DualShock começa em modo digital (ID 41)', () => { assert.equal(hex(xfer(mk('dualshock'), [1, 0x42, 0, 0, 0])), 'ff 41 5a ff ff'); });
test('DualShock: entra em config, liga analógico, sai; poll devolve ID 73 e os 4 eixos', () => {
  const s = mk('dualshock'); s.setStick('rx', 0x10); s.setStick('ry', 0x20); s.setStick('lx', 0xF0); s.setStick('ly', 0xFF);
  assert.equal(hex(xfer(s, [1, 0x43, 0, 1, 0, 0, 0, 0, 0])), 'ff 41 5a ff ff ff ff ff ff');
  assert.equal(s.pads[0].config, true);
  const st = xfer(s, [1, 0x45, 0, 0, 0, 0, 0, 0, 0]);                     // status em config: ID F3
  assert.equal(hex(st), 'ff f3 5a 01 02 00 02 01 00');
  assert.equal(hex(xfer(s, [1, 0x44, 0, 1, 3, 0, 0, 0, 0])), 'ff f3 5a 00 00 00 00 00 00');
  assert.equal(s.pads[0].analog, true); assert.equal(s.pads[0].lock, true);
  xfer(s, [1, 0x43, 0, 0, 0, 0, 0, 0, 0]); assert.equal(s.pads[0].config, false);
  assert.equal(hex(xfer(s, [1, 0x42, 0, 0, 0, 0, 0, 0, 0])), 'ff 73 5a ff ff 10 20 f0 ff');
});
test('DualShock: botões e L3/R3 aparecem em modo analógico', () => {
  const s = mk('dualshock'); s.pads[0].analog = true; s.setButton('l3', true); s.setButton('r3', true);
  assert.equal(hex(xfer(s, [1, 0x42, 0, 0, 0, 0, 0, 0, 0]).slice(0, 5)), 'ff 73 5a f9 ff');
});
test('DualShock: botão ANALOG alterna o modo, exceto quando o jogo travou', () => {
  const s = mk('dualshock'); assert.equal(s.toggleAnalog(), true); assert.equal(s.toggleAnalog(), false);
  s.pads[0].lock = true; assert.equal(s.toggleAnalog(), false);
});
test('DualShock: mapeamento de vibração 4D e poll aciona motores (callback)', () => {
  const s = mk('dualshock'); const ev = []; s.onRumble = (p, sm, lg) => ev.push([p, sm, lg]);
  s.pads[0].analog = true;
  xfer(s, [1, 0x43, 0, 1, 0, 0, 0, 0, 0]);
  assert.equal(hex(xfer(s, [1, 0x4D, 0, 0, 1, 0xFF, 0xFF, 0xFF, 0xFF])), 'ff f3 5a 00 01 ff ff ff ff');
  xfer(s, [1, 0x43, 0, 0, 0, 0, 0, 0, 0]);
  ev.length = 0;
  xfer(s, [1, 0x42, 0, 1, 0xC0, 0, 0, 0, 0]);
  assert.deepEqual(ev.at(-1), [0, 1, 0xC0]);
  xfer(s, [1, 0x42, 0, 1, 0xC0, 0, 0, 0, 0]); assert.equal(ev.length, 1, 'sem repetir o mesmo valor');
  xfer(s, [1, 0x42, 0, 0, 0, 0, 0, 0, 0]); assert.deepEqual(ev.at(-1), [0, 0, 0]);
});
test('DualShock sem mapa 4D: byte de vibração fica desligado por padrão', () => {
  const s = mk('dualshock'); const ev = []; s.onRumble = (p, sm, lg) => ev.push([sm, lg]);
  s.pads[0].map = [0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF]; xfer(s, [1, 0x42, 0, 1, 0xFF, 0, 0, 0, 0]);
  assert.ok(ev.every(([a, b]) => !a && !b));
});
test('DualShock: consultas 46/47/4C devolvem constantes de identificação', () => {
  const s = mk('dualshock'); xfer(s, [1, 0x43, 0, 1, 0, 0, 0, 0, 0]);
  assert.equal(hex(xfer(s, [1, 0x46, 0, 0, 0, 0, 0, 0, 0])), 'ff f3 5a 00 01 02 00 0a 00');
  assert.equal(hex(xfer(s, [1, 0x46, 0, 1, 0, 0, 0, 0, 0])), 'ff f3 5a 00 01 01 01 14 00');
  assert.equal(hex(xfer(s, [1, 0x47, 0, 0, 0, 0, 0, 0, 0])), 'ff f3 5a 00 00 02 00 01 00');
  assert.equal(hex(xfer(s, [1, 0x4C, 0, 0, 0, 0, 0, 0, 0])), 'ff f3 5a 00 00 00 04 00 00');
});
test('último byte da transação não tem ACK; os anteriores têm', () => {
  const s = mk('dualshock'); s.pads[0].analog = true; s.ctrl = 0; s.state = 0;
  const acks = [1, 0x42, 0, 0, 0, 0, 0, 0, 0].map(b => s.exchange(b)[1]); assert.deepEqual(acks, [true, true, true, true, true, true, true, true, false]);
});

let ok = 0;
for (const [n, f] of tests) { try { f(); console.log('  ok  ', n); ok++; } catch (e) { console.log('  FALHOU', n, '\n', e.message); process.exitCode = 1; } }
console.log(`\n${ok} testes de controle ok`);
