// Tick adaptativo: leituras de timer exatas mesmo entre ticks; eventos agendados disparam no instante certo
import assert from 'node:assert/strict';
import { PSX } from '../src/psx.js';
const psx = new PSX(); psx.resetTiming?.();
const t = psx.timers; t.write(0x1F801120 & 0xFF, 4, 0);            // timer 2, modo 0 (sysclk), contador 0
const c0 = psx.cpu.cycles; psx.timerAt = c0; psx.cpu.cycles += 1000;
const v = t.read(0x20, 4);
assert.equal(v, 1000, 'contador do timer deve refletir os ciclos decorridos mesmo sem tick');
psx.cpu.cycles += 500; assert.equal(t.read(0x20, 4), 1500);
let fired = 0, when = 0; const base = psx.cpu.cycles;
psx.tick(); psx.sched.add(base + 40, () => { fired++; when = psx.cpu.cycles; });
assert.ok(psx.nextTick <= base + 40, 'evento novo antecipa o próximo tick');
for (let i = 0; i < 100 && !fired; i++) { psx.cpu.cycles += 8; if (psx.cpu.cycles >= psx.nextTick) psx.tick(); }
assert.equal(fired, 1); assert.ok(when - base < 48, 'evento atrasou mais que um passo de CPU: ' + (when - base));
console.log('tick ok');
