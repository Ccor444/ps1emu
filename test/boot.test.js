// Teste de fumaça: BIOS real + disco real. Pula sozinho se os arquivos não existirem.
// Uso: BIOS=SCPH1001.BIN DISC=jogo.bin node test/boot.test.js
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { PSX } from '../src/psx.js';
const bios = process.env.BIOS || 'SCPH1001.BIN', disc = process.env.DISC || process.argv[2];
if (!fs.existsSync(bios) || !disc || !fs.existsSync(disc)) { console.log('boot.test: BIOS/disco ausentes - pulado (defina BIOS= e DISC=)'); process.exit(0); }
const psx = new PSX(); let tty = ''; psx.onTTY = s => { tty += s; };
psx.loadBios(new Uint8Array(fs.readFileSync(bios))); psx.loadDisc(new Uint8Array(fs.readFileSync(disc)));
for (let f = 0; f < 1100 && !/Execute !/.test(tty); f++) psx.runFrame();
assert.match(tty, /KERNEL SETUP!/); assert.match(tty, /BOOTSTRAP LOADER/); assert.match(tty, /boot file\s+: cdrom:/); assert.match(tty, /Execute !/);
// o jogo precisa passar da inicialização sem destruir o vetor de exceção (regressão: flags de DMA presas)
const vec = psx.bus.read32(0x80); assert.notEqual(vec, 0, 'vetor de exceção 0x80 existe');
for (let f = 0; f < 800; f++) psx.runFrame();
assert.notEqual(psx.bus.read32(0x80), 0, 'vetor 0x80 intacto após 800 quadros do jogo');
assert.ok(psx.gpu.dispOn, 'jogo ligou o vídeo');
assert.ok(psx.mdec.blocksDone > 1000, 'MDEC decodificou o vídeo da intro (blocos: ' + psx.mdec.blocksDone + ')');
console.log('  ok   BIOS leu SYSTEM.CNF e executou o EXE do disco via CD-ROM emulado');
