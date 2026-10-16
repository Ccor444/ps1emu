// Saída de áudio: taxa fixa (tom nunca muda), sem silêncio quando o emulador acompanha, latência limitada quando ele recupera em rajada
import assert from 'node:assert/strict';
import { PCMPull } from '../web/audio-out.js';

// 1) fidelidade: o que sai é exatamente o que entrou, na ordem e sem reamostragem
{
  const p = new PCMPull(), L = new Float32Array(100), R = new Float32Array(100), inp = [];
  for (let k = 0; k < 6; k++) { const b = new Int16Array(882 * 2); for (let i = 0; i < b.length; i++) b[i] = (k * 1000 + i) % 30000; inp.push(...b); p.push(b); }
  const out = [];
  for (let t = 0; t < 8; t++) { p.pull(L, R); for (let i = 0; i < 100; i++) out.push(Math.round(L[i] * 32768), Math.round(R[i] * 32768)); }
  for (let i = 0; i < out.length; i++) assert.equal(out[i], inp[i], 'amostra ' + i + ' alterada (reamostragem?)');
}
// 2) emulador em tempo real (1x): sem silêncio depois do pré-buffer; emulador mais rápido (rajadas): latência limitada
for (const speed of [1, 1.5, 3]) {
  const p = new PCMPull(), L = new Float32Array(128), R = new Float32Array(128); let gaps = 0, frames = 0, acc = 0, maxFill = 0;
  for (let t = 0; t < 44100 * 6; t += 128) {
    acc += 128 * speed;
    while (acc >= 882) { acc -= 882; const b = new Int16Array(1764); b.fill(8000); p.push(b); }
    p.pull(L, R); maxFill = Math.max(maxFill, p.fill);
    if (t > 44100) { frames += 128; for (let i = 0; i < 128; i++) if (L[i] === 0) gaps++; }
  }
  assert.ok(gaps / frames < 0.01, `velocidade ${speed}: ${(gaps / frames * 100).toFixed(1)}% de silêncio`);
  assert.ok(maxFill <= 8820 + 882, `velocidade ${speed}: fila passou do limite (${maxFill})`);
}
// 3) emulador mais lento que o tempo real: silêncio e recuperação, mas o tom (taxa) continua exato
{
  const p = new PCMPull(), L = new Float32Array(128), R = new Float32Array(128); let acc = 0, consumed = 0, produced = 0;
  for (let t = 0; t < 44100 * 4; t += 128) {
    acc += 128 * 0.5; while (acc >= 882) { acc -= 882; p.push(new Int16Array(1764).fill(8000)); produced += 882; }
    p.pull(L, R); for (let i = 0; i < 128; i++) if (L[i] !== 0) consumed++;
  }
  assert.ok(consumed <= produced, 'consumiu mais do que foi produzido');
}
console.log('audio-out ok');
