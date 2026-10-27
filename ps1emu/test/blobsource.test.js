// BlobSource: leitura preguiçosa em blocos tem que ser idêntica a ler o Uint8Array inteiro (inclusive setores que cruzam blocos e o fim do arquivo)
import assert from 'node:assert/strict';
import { BlobSource, DiscImage } from '../src/disc.js';
let seed = 7; const rnd = n => (seed = (seed * 1103515245 + 12345) >>> 0, (seed >>> 8) % n);
const data = new Uint8Array(1_000_003); for (let i = 0; i < data.length; i++) data[i] = rnd(256);
let reads = 0;
const bs = new BlobSource({ size: data.length }, (a, b) => { reads++; return data.slice(a, b); }, 4096, 4);
assert.equal(bs.length, data.length);
for (let k = 0; k < 2000; k++) {
  const a = rnd(data.length), n = 1 + rnd(9000), b = Math.min(data.length, a + n);
  assert.deepEqual(Buffer.from(bs.subarray(a, b)), Buffer.from(data.subarray(a, b)), `trecho ${a}..${b}`);
}
assert.equal(bs.subarray(data.length - 5).length, 5, 'fim do arquivo');
assert.equal(bs.subarray(data.length + 10, data.length + 20).length, 0, 'além do fim');
assert.ok(bs.lru.size <= 4, 'cache limitado');
bs.subarray(100000, 100100); const r0 = reads; for (let i = 0; i < 100; i++) bs.subarray(100000, 100100); assert.equal(reads, r0, 'leitura repetida usa o cache');
// um disco (ISO 2048) lido pela BlobSource dá o mesmo resultado que pela memória
const iso = new Uint8Array(2048 * 40); const pvd = 16 * 2048; iso[pvd] = 1; iso.set([0x43, 0x44, 0x30, 0x30, 0x31], pvd + 1); iso.set(new TextEncoder().encode('MEUJOGO'.padEnd(32)), pvd + 40);
const a = new DiscImage(iso), b = new DiscImage(new BlobSource({ size: iso.length }, (x, y) => iso.slice(x, y), 4096, 4));
assert.deepEqual(a.info(), b.info()); assert.equal(b.sectorCount, 40); assert.equal(b.volumeId.trim(), 'MEUJOGO');
console.log('ok - BlobSource: 2000 trechos idênticos, cache LRU, fim de arquivo, disco igual ao da memória');

// leitura antecipada assíncrona: o resultado continua idêntico à leitura direta, com ou sem blocos já pré-carregados
{
  const big = new Uint8Array(200000).map((_, i) => (i * 131 + (i >> 8)) & 255), blob = new Blob([big]);
  const pf = new BlobSource(blob, (a, b) => big.slice(a, b), 4096, 8, 4);
  for (let off = 0; off < big.length - 5000; off += 3333) assert.deepEqual(pf.subarray(off, off + 2352), big.subarray(off, off + 2352));
  await new Promise(r => setTimeout(r, 50));
  assert.ok(pf.pre > 0, 'blocos pré-carregados');
  for (let off = 0; off < big.length - 5000; off += 2352) assert.deepEqual(pf.subarray(off, off + 2352), big.subarray(off, off + 2352));
  console.log('  ok   leitura antecipada (' + pf.pre + ' blocos vieram do prefetch)');
}
