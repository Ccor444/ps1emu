import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PSX } from '../src/psx.js';
import { MemoryCard, CARD_SIZE } from '../src/memcard.js';

let n = 0; const T = (name, fn) => { fn(); n++; console.log('  ok  ', name); };
const hex = a => a.map(x => x.toString(16).padStart(2, '0')).join(' ');
const xor = (...a) => a.reduce((x, y) => x ^ y, 0);

// ---- utilitário: transação completa via exchange() (nível de protocolo) ----
function session(psx, slot = 0) {
  const sio = psx.sio; sio.ctrl = slot << 13; sio.state = 0; sio.dev = null; sio.mc = null;
  const replies = [], acks = [];
  return { send(b) { const [r, a] = sio.exchange(b); replies.push(r); acks.push(a); return r; }, replies, acks };
}
const psx = new PSX();

T('cartão em branco: assinatura MC, 15 entradas livres, checksums válidos', () => {
  const c = new MemoryCard(); const d = c.data;
  assert.equal(d.length, CARD_SIZE); assert.equal(String.fromCharCode(d[0], d[1]), 'MC');
  for (let i = 0; i < 64; i++) { if (i === 0 || (i >= 1 && i <= 35)) { let x = 0; for (let j = 0; j < 127; j++) x ^= d[i * 128 + j]; assert.equal(x, d[i * 128 + 127], 'frame ' + i); } }
  assert.equal(c.freeBlocks(), 15); assert.deepEqual(c.listSaves(), []);
  assert.deepEqual([...d.subarray(63 * 128, 64 * 128)], [...d.subarray(0, 128)]);
});

T('GetID (S): FLAG 5A 5D 5C 5D 04 00 00 80, sem ACK no último byte', () => {
  psx.sio.cards[0] = new MemoryCard(); const s = session(psx);
  s.send(0x81); for (const b of [0x53, 0, 0, 0, 0, 0, 0, 0, 0]) s.send(b);
  assert.equal(hex(s.replies), 'ff 08 5a 5d 5c 5d 04 00 00 80');
  assert.equal(s.acks.at(-1), false); assert.ok(s.acks.slice(0, -1).every(Boolean));
});

T('Leitura (R) do setor 0: FLAG, IDs, eco do endereço, 128 dados, checksum, 47', () => {
  const c = psx.sio.cards[0] = new MemoryCard(); const s = session(psx);
  s.send(0x81); s.send(0x52); s.send(0); s.send(0); s.send(0x00); s.send(0x00);
  for (let i = 0; i < 4; i++) s.send(0);                      // 5C 5D MSB LSB
  for (let i = 0; i < 128; i++) s.send(0);                    // dados
  s.send(0); s.send(0);                                        // CHK, 47
  assert.equal(hex(s.replies.slice(0, 10)), 'ff 08 5a 5d 00 00 5c 5d 00 00');
  assert.deepEqual(s.replies.slice(10, 138), [...c.readSector(0)]);
  assert.equal(s.replies[138], xor(0, 0, ...c.readSector(0))); assert.equal(s.replies[139], 0x47);
  assert.equal(s.acks[139], false);
});

T('Escrita (W) + leitura de volta; flag "cartão novo" (08) vira 00', () => {
  const c = psx.sio.cards[0] = new MemoryCard(); let wrote = -1; c.onWrite = sc => { wrote = sc; };
  const data = Uint8Array.from({ length: 128 }, (_, i) => (i * 7 + 3) & 0xFF), sec = 0x0123, msb = sec >> 8, lsb = sec & 0xFF;
  let s = session(psx); s.send(0x81); s.send(0x57); s.send(0); s.send(0); s.send(msb); s.send(lsb);
  for (const v of data) s.send(v); s.send(xor(msb, lsb, ...data)); s.send(0); s.send(0); s.send(0);
  assert.equal(s.replies[1], 0x08); assert.equal(s.replies.at(-3), 0x5C); assert.equal(s.replies.at(-2), 0x5D); assert.equal(s.replies.at(-1), 0x47);
  assert.equal(wrote, sec); assert.deepEqual([...c.readSector(sec)], [...data]); assert.equal(c.flag, 0x00); assert.ok(c.dirty);
  s = session(psx); s.send(0x81); s.send(0x53);                 // agora FLAG = 00
  assert.equal(s.replies[1], 0x00);
});

T('Escrita com checksum errado -> 4E e nada é gravado; setor ruim -> FF', () => {
  const c = psx.sio.cards[0] = new MemoryCard(); const data = new Uint8Array(128).fill(0xAA);
  let s = session(psx); s.send(0x81); s.send(0x57); s.send(0); s.send(0); s.send(0); s.send(200);
  for (const v of data) s.send(v); s.send(0x00); s.send(0); s.send(0); s.send(0);
  assert.equal(s.replies.at(-1), 0x4E); assert.equal(c.readSector(200)[0], 0); assert.equal(c.flag, 0x08);
  s = session(psx); s.send(0x81); s.send(0x57); s.send(0); s.send(0); s.send(0x04); s.send(0x00);   // setor 0x400
  for (const v of data) s.send(v); s.send(xor(4, 0, ...data)); s.send(0); s.send(0); s.send(0);
  assert.equal(s.replies.at(-1), 0xFF);
});

T('Leitura de setor inválido encerra com FF FF (sem dados)', () => {
  psx.sio.cards[0] = new MemoryCard(); const s = session(psx);
  s.send(0x81); s.send(0x52); s.send(0); s.send(0); s.send(0x04); s.send(0x00); s.send(0); s.send(0); s.send(0); s.send(0);
  assert.equal(hex(s.replies.slice(8, 10)), 'ff ff'); assert.equal(s.acks[9], false);
});

T('porta 2 usa o cartão 2; slot vazio não responde (sem ACK)', () => {
  psx.sio.cards[0] = new MemoryCard(); psx.sio.cards[1] = null;
  const s0 = session(psx, 0); assert.equal(s0.send(0x81), 0xFF); assert.equal(s0.acks[0], true);
  const s1 = session(psx, 1); s1.send(0x81); assert.equal(s1.acks[0], false);
});

T('formatos: VGS e DexDrive têm o cabeçalho removido; tamanho/assinatura inválidos falham', () => {
  const raw = new MemoryCard().data;
  const vgs = new Uint8Array(CARD_SIZE + 64); vgs.set([0x56, 0x67, 0x73, 0x4D]); vgs.set(raw, 64);
  assert.deepEqual([...new MemoryCard(vgs).data], [...raw]);
  const dex = new Uint8Array(CARD_SIZE + 3904); dex.set(new TextEncoder().encode('123-456-STD')); dex.set(raw, 3904);
  assert.deepEqual([...new MemoryCard(dex).data], [...raw]);
  assert.throws(() => new MemoryCard(new Uint8Array(1000)), /tamanho/);
  assert.throws(() => new MemoryCard(new Uint8Array(CARD_SIZE)), /MC/);
});

T('ponta a ponta pelos REGISTRADORES da SIO0 (CTRL/DATA/STAT, agendador, IRQ7)', () => {
  const p = new PSX(); p.loadMemoryCard(0); p.bus.imask = 0x80; let irqs = 0;
  const xfer = (b) => { p.sio.write(0x1F801040, 1, b); p.cpu.cycles += 4000; p.sched.run(p.cpu.cycles);
                        const st = p.sio.read(0x1F801044, 4); assert.ok(st & 2, 'RX pronto'); const r = p.sio.read(0x1F801040, 1);
                        if (p.bus.istat & 0x80) { irqs++; p.bus.istat &= ~0x80; p.sio.write(0x1F80104A, 2, 0x1013); } return r; };
  p.sio.write(0x1F80104A, 2, 0x1003);                          // TXEN | /JOY select | ACK IRQ enable
  const out = [0x81, 0x53, 0, 0, 0, 0, 0, 0, 0, 0].map(xfer);
  assert.equal(hex(out), 'ff 08 5a 5d 5c 5d 04 00 00 80'); assert.ok(irqs >= 8, 'IRQ7 a cada ACK: ' + irqs);
});

const S0 = new URL('../samples/epsxe000.mcr', import.meta.url), S1 = new URL('../samples/epsxe001.mcr', import.meta.url);
if (fs.existsSync(S0)) {
  T('cartão real epsxe000.mcr: 1 save (BASLUS-01251, FF9) e diretório íntegro', () => {
    const c = new MemoryCard(new Uint8Array(fs.readFileSync(S0))), l = c.listSaves();
    assert.equal(l.length, 1); assert.equal(l[0].code, 'BASLUS-0125100000-00'); assert.equal(l[0].blocks, 1); assert.ok(l[0].ok);
    assert.match(l[0].title, /FF.*FILE01|ＦＦ９/); assert.equal(c.freeBlocks(), 14);
  });
  T('cartão real: ler setor do bloco do save pelo protocolo devolve os mesmos bytes do arquivo', () => {
    const file = new Uint8Array(fs.readFileSync(S0)); const p = new PSX(); p.loadMemoryCard(0, file);
    const sec = 64, s = session(p); s.send(0x81); s.send(0x52); s.send(0); s.send(0); s.send(sec >> 8); s.send(sec & 255);
    for (let i = 0; i < 4 + 128 + 2; i++) s.send(0);
    assert.deepEqual(Uint8Array.from(s.replies.slice(10, 138)), file.subarray(sec * 128, sec * 128 + 128));
  });
  T('cartão real: gravar e exportar preserva o formato cru de 131072 bytes', () => {
    const c = new MemoryCard(new Uint8Array(fs.readFileSync(S0))); c.writeSector(70, new Uint8Array(128).fill(1));
    const out = c.export(); assert.equal(out.length, CARD_SIZE); assert.equal(out[70 * 128], 1); assert.equal(c.dirty, false);
  });
}
if (fs.existsSync(S1)) T('cartão real epsxe001.mcr: vazio (15 livres)', () => {
  const c = new MemoryCard(new Uint8Array(fs.readFileSync(S1))); assert.equal(c.freeBlocks(), 15); assert.equal(c.listSaves().length, 0);
});
console.log(`${n} testes de memory card passaram`);
