// MDEC contra capturas do console real (ps1-tests/mdec/frame): imagem 320x240 decodificada em 15 e 24 bits.
// A decodificação ainda não é bit-exata (resíduo de ±1 em parte dos pixels); o teste trava o nível atual para evitar regressões.
import fs from 'node:fs';
import zlib from 'node:zlib';
import assert from 'node:assert/strict';
import { MDEC } from '../src/mdec.js';
const F = n => new URL('./fixtures/mdec/' + n, import.meta.url);
const tab = JSON.parse(fs.readFileSync(F('tables.json'), 'utf8'));
const stream = fs.readFileSync(F('sunset.mdec')), words = new Uint32Array(stream.buffer.slice(stream.byteOffset, stream.byteOffset + stream.length));
const ref = n => { const b = zlib.gunzipSync(fs.readFileSync(F(n))); return new Uint16Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length)); };
function decode(depth) {
  const m = new MDEC();
  m.writeWord(0x40000001); for (let i = 0; i < 32; i++) m.writeWord((tab.quant[i * 4] | tab.quant[i * 4 + 1] << 8 | tab.quant[i * 4 + 2] << 16 | tab.quant[i * 4 + 3] << 24) >>> 0);
  m.writeWord(0x60000000); for (let i = 0; i < 32; i++) m.writeWord(((tab.idct[i * 2] & 0xFFFF) | tab.idct[i * 2 + 1] << 16) >>> 0);
  m.writeWord(((1 << 29) | (depth << 27) | words.length) >>> 0);
  for (const w of words) m.writeWord(w);
  return m.out.slice(0, m.tail);
}
{ // 15 bits: macroblocos 16x16 em ordem de colunas (20 x 15)
  const out = decode(3), r = ref('sunset15.ref.gz'); let bad = 0;
  for (let mb = 0; mb < 300; mb++) for (let n = 0; n < 256; n++) {
    const o = mb * 512 + n * 2, px = (out[o] | out[o + 1] << 8) & 0x7FFF, x = (mb / 15 | 0) * 16 + (n & 15), y = (mb % 15) * 16 + (n >> 4);
    if (px !== r[y * 320 + x]) bad++;
  }
  assert.ok(bad < 0.22 * 76800, `15 bits: ${bad} pixels diferentes`);
  console.log(`  ok   MDEC 15 bits: ${(100 - bad / 768).toFixed(1)}% dos pixels idênticos ao console real`);
}
{ // 24 bits: a referência é a VRAM vista como 15 bits (perde o bit 7 dos bytes ímpares)
  const out = decode(2), r = ref('sunset24.ref.gz'); let bad = 0, tot = 0;
  for (let mb = 0; mb < 300; mb++) for (let n = 0; n < 256; n++) for (let c = 0; c < 3; c++) {
    const x = (mb / 15 | 0) * 16 + (n & 15), y = (mb % 15) * 16 + (n >> 4), bo = (n & 15) * 3 + c, hw = r[y * 480 + (mb / 15 | 0) * 24 + (bo >> 1)];
    const real = bo & 1 ? (hw >> 8) & 127 : hw & 255, mask = bo & 1 ? 127 : 255;
    tot++; if ((out[mb * 768 + n * 3 + c] & mask) !== real) bad++;
  }
  assert.ok(bad < 0.32 * tot, `24 bits: ${bad}/${tot} bytes diferentes`);
  console.log(`  ok   MDEC 24 bits: ${(100 - 100 * bad / tot).toFixed(1)}% dos bytes idênticos ao console real`);
}
