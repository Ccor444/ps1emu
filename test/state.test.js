// Save states: determinismo (salvar → continuar → restaurar → continuar = mesmo resultado)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { PSX } from '../src/psx.js';
import { saveState, loadState, readStateMeta, gzip, gunzip, isGzip } from '../src/state.js';

const BIOS = process.env.BIOS || '/mnt/user-data/uploads/SCPH1001.BIN', DISC = process.env.DISC || '/mnt/user-data/uploads/100__Star.bin';
const tests = []; const test = (n, f) => tests.push([n, f]);
const h = (...bufs) => { const x = crypto.createHash('sha1'); for (const b of bufs) x.update(b instanceof Uint8Array ? b : Buffer.from(String(b))); return x.digest('hex'); };
const fp = p => (p.syncTimers?.(), h(p.bus.ram, p.gpu.vram, p.spu.ram, p.cpu.r, p.cpu.cop0, `${p.cpu.pc},${p.cpu.cycles},${p.cpu.hi},${p.cpu.lo},${p.bus.istat},${p.bus.imask}`,
  JSON.stringify(p.timers.t), `${p.dma.dicr},${p.cdrom.pos},${p.cdrom.intFlag},${p.sio.stat},${p.gpu.line}`, p.sched.q.length, p.sched.q.map(e => e.time).join()));

function boot() {
  const p = new PSX(); p.loadBios(new Uint8Array(fs.readFileSync(BIOS)));
  if (fs.existsSync(DISC)) p.loadDisc(new Uint8Array(fs.readFileSync(DISC)));
  p.reset(); return p;
}
const haveGame = fs.existsSync(BIOS);

test('round trip imediato: salvar/restaurar não muda nada', () => {
  const p = boot(); for (let i = 0; i < 30; i++) p.runFrame();
  const a = fp(p), s = p.saveState(); p.loadState(s); assert.equal(fp(p), a);
});
test('determinismo: restaurar e reexecutar reproduz exatamente os mesmos quadros e áudio', () => {
  const p = boot(); for (let i = 0; i < 120; i++) p.runFrame();
  const s = p.saveState(), run = () => { const au = []; for (let i = 0; i < 40; i++) au.push(p.runFrame()); return h(fp(p), ...au.map(a => new Uint8Array(a.buffer, a.byteOffset, a.byteLength))); };
  const r1 = run(); p.loadState(s); const r2 = run(); assert.equal(r2, r1);
});
test('restaurar em OUTRA instância (JIT frio) continua idêntico', () => {
  const p = boot(); for (let i = 0; i < 200; i++) p.runFrame();
  const s = p.saveState(); const q = boot(); q.loadState(s);
  assert.equal(fp(q), fp(p));
  for (let i = 0; i < 30; i++) { p.runFrame(); q.runFrame(); } assert.equal(fp(q), fp(p));
});
test('com CD lendo (eventos de CD/DMA pendentes no agendador) o estado também é determinístico', () => {
  const p = boot(); let n = 0;
  for (let i = 0; i < 2500 && !(p.cdrom.reading && p.sched.q.length >= 1 && p.cdrom.sectorsRead > 20); i++, n++) p.runFrame();
  assert.ok(p.sched.q.length > 0, 'esperava eventos pendentes');
  const s = p.saveState(); const q = boot(); q.loadState(s);
  for (let i = 0; i < 40; i++) { p.runFrame(); q.runFrame(); } assert.equal(fp(q), fp(p));
});
test('formato: cabeçalho, versão, compressão gzip e erros claros', async () => {
  const p = boot(); for (let i = 0; i < 10; i++) p.runFrame();
  const s = p.saveState({ nome: 'x' }); assert.equal(readStateMeta(s).nome, 'x');
  const z = await gzip(s); assert.ok(isGzip(z) && z.length < s.length / 4, `compressão fraca ${z.length}/${s.length}`);
  assert.deepEqual(await gunzip(z), s);
  assert.throws(() => loadState(p, new Uint8Array(30)), /não é um save state/);
  const bad = s.slice(); bad[4] = 99; assert.throws(() => loadState(p, bad), /versão/);
  assert.throws(() => loadState(p, s.subarray(0, 40)), /truncado/);
});
test('entradas e memory cards não fazem parte do estado', () => {
  const p = boot(); p.sio.setButton('cross', true); const s = p.saveState(); p.sio.setButton('cross', false);
  p.loadState(s); assert.equal(p.sio.buttons[0] & (1 << 14), 1 << 14);
});

let ok = 0;
for (const [n, f] of tests) { if (!haveGame) { console.log('  pulado (sem BIOS):', n); continue; } try { await f(); console.log('  ok  ', n); ok++; } catch (e) { console.log('  FALHOU', n, '\n', e.stack || e); process.exitCode = 1; } }
console.log(`\n${ok} testes de save state ok`);
