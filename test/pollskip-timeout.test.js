// Laço de espera COM contador de timeout (o do tratador de interrupção do BIOS: 81 leituras de I_STAT): o pulo de esperas não pode esticá-lo
// para quadros inteiros (uma versão assim deixou o Umihara Kawase ~80x mais lento). Também não pode pular com IRQ pendente.
import assert from 'node:assert/strict';
import { PSX } from '../src/psx.js';
const p = new PSX(); p.reset(); p.pollSkip = true; const b = p.bus;
b.imask = 0xD; b.istat = 0; p.timerDue = Infinity;
const t0 = p.cpu.cycles; for (let i = 0; i < 81; i++) { b.ioRead(0x1F801070, 4); p.cpu.cycles += 12; }
const dt = p.cpu.cycles - t0;
assert.ok(dt < 30 * 2200, `81 leituras levaram ${dt} ciclos (> 30 linhas)`);
assert.ok(b.poll.jumps > 0, 'o pulo continua agindo');
// com IRQ pendente e habilitado na máscara, não pula
b.istat = 1; const j = b.poll.jumps; for (let i = 0; i < 200; i++) { b.ioRead(0x1F801070, 4); p.cpu.cycles += 12; }
assert.equal(b.poll.jumps, j, 'sem pulo com IRQ pendente');
console.log('  ok   pollSkip: laço com timeout não é esticado (' + dt + ' ciclos para 81 leituras, ' + b.poll.jumps + ' pulos)');
