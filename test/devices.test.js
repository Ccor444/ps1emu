import assert from 'node:assert/strict';
import { PSX } from '../src/psx.js';

let n = 0; const T = (name, fn) => { fn(); n++; console.log('  ok  ', name); };
const psx = new PSX(), cpu = psx.cpu, bus = psx.bus;
const adv = c => { cpu.cycles += c; psx.sched.run(cpu.cycles); };

// ---------------- Timers ----------------
T('Timer: reset no alvo + IRQ', () => {
  psx.timers.write(0x1F801108, 4, 100);                 // alvo (timer 0)... usa timer 2 abaixo
  psx.timers.reset(); bus.istat = 0;
  psx.timers.write(0x1F801120, 4, 0); psx.timers.write(0x1F801128, 4, 100); psx.timers.write(0x1F801124, 4, 0x18);   // reset no alvo + IRQ no alvo
  psx.timers.advance(250);
  assert.equal(psx.timers.read(0x1F801120, 2), 250 % 101);
  assert.ok(bus.istat & (1 << 6), 'IRQ6 (timer2)');
  assert.ok(psx.timers.read(0x1F801124, 4) & 0x800, 'flag "atingiu alvo"');
  assert.equal(psx.timers.read(0x1F801124, 4) & 0x800, 0, 'ler o modo limpa o flag');
});
T('Timer: overflow 0xFFFF', () => {
  psx.timers.reset(); psx.timers.write(0x1F801124, 4, 0x20); psx.timers.advance(70000);
  assert.equal(psx.timers.read(0x1F801120, 2), 70000 % 65536);
});
T('Timer 1 conta HBlank', () => {
  psx.timers.reset(); psx.timers.write(0x1F801114, 4, 0x100); for (let i = 0; i < 5; i++) psx.timers.hblank();
  assert.equal(psx.timers.read(0x1F801110, 2), 5);
});

// ---------------- DMA ----------------
T('DMA6 (OTC) monta a lista encadeada reversa', () => {
  psx.dma.reset(); psx.dma.dpcr = 0x0FFFFFFF;
  psx.dma.write(0x1F8010E0, 4, 0x1010); psx.dma.write(0x1F8010E4, 4, 4); psx.dma.write(0x1F8010E8, 4, 0x11000002);
  const rv = bus.ramView; assert.equal(rv.getUint32(0x1010, true), 0x100C); assert.equal(rv.getUint32(0x1008, true), 0x1004); assert.equal(rv.getUint32(0x1004, true), 0x00FFFFFF);
  assert.ok(psx.dma.read(0x1F8010E8, 4) & 0x01000000, 'ocupado até concluir');
  adv(100); assert.equal(psx.dma.read(0x1F8010E8, 4) & 0x11000000, 0, 'concluiu');
});
T('DMA2 (GPU) linked list executa comandos GP0', () => {
  const rv = bus.ramView;
  rv.setUint32(0x2000, (3 << 24) | 0x2010, true); rv.setUint32(0x2004, 0x02FF0000, true); rv.setUint32(0x2008, (5 << 16) | 8, true); rv.setUint32(0x200C, (4 << 16) | 16, true);
  rv.setUint32(0x2010, 0x00FFFFFF, true);
  psx.dma.write(0x1F8010A0, 4, 0x2000); psx.dma.write(0x1F8010A8, 4, 0x01000401);
  assert.equal(psx.gpu.vram[5 * 1024 + 8], 31 << 10); assert.equal(psx.gpu.vram[8 * 1024 + 15], 31 << 10);
});
T('DMA4 (SPU) grava na RAM do SPU e gera IRQ3 via DICR', () => {
  psx.dma.write(0x1F8010F4, 4, (1 << 23) | (1 << 20)); bus.istat = 0;
  psx.spu.write(0x1F801DA6, 2, 0x4000 >> 3);
  bus.ramView.setUint32(0x3000, 0xCAFEBABE, true); bus.ramView.setUint32(0x3004, 0x12345678, true);
  psx.dma.write(0x1F8010C0, 4, 0x3000); psx.dma.write(0x1F8010C4, 4, 0x00010002); psx.dma.write(0x1F8010C8, 4, 0x01000201);
  assert.equal(psx.spu.ramView.getUint16(0x4000, true), 0xBABE); assert.equal(psx.spu.ramView.getUint16(0x4006, true), 0x1234);
  adv(100); assert.ok(bus.istat & 8, 'IRQ3 do DMA'); assert.ok(psx.dma.read(0x1F8010F4, 4) >>> 31, 'bit 31 do DICR');
});

// ---------------- SIO0 ----------------
T('SIO0: protocolo do controle digital (0x01,0x42,...)', () => {
  const sio = psx.sio; sio.reset(); sio.setButton('cross', true);
  sio.write(0x1F80104A, 2, 0x1003);
  const xfer = b => { sio.write(0x1F801040, 1, b); adv(3000); assert.ok(sio.read(0x1F801044, 4) & 2, 'RX pronto'); return sio.read(0x1F801040, 1); };
  assert.equal(xfer(0x01), 0xFF); assert.equal(xfer(0x42), 0x41); assert.equal(xfer(0x00), 0x5A);
  assert.equal(xfer(0x00), 0xFF); assert.equal(xfer(0x00), 0xBF, 'cross pressionado = bit 6 zerado');
  sio.write(0x1F80104A, 2, 0x0000);
  assert.equal(xfer.length, 1);
});
T('SIO0: memory card ausente não dá ACK', () => {
  const sio = psx.sio; sio.reset(); sio.write(0x1F80104A, 2, 0x1003); bus.istat = 0;
  sio.write(0x1F801040, 1, 0x81); adv(3000); assert.equal(sio.read(0x1F801040, 1), 0xFF); assert.equal(sio.read(0x1F801044, 4) & 0x80, 0);
});

// ---------------- CD-ROM (disco sintético) ----------------
const fakeDisc = {
  raw: true, sectorCount: 1000,
  readSector(lba) { const s = new Uint8Array(2352); s[12] = 0; s[15] = 2; for (let i = 0; i < 2048; i++) s[24 + i] = (lba + i) & 0xFF; return s; },
  sectorInfo() { return { mode: 2, file: 0, channel: 0, submode: 8, coding: 0, form2: false, audio: false, video: false, data: true, rt: false, eof: false }; },
  region() { return 'SCEE' },
};
const cd = psx.cdrom;
const cdw = (reg, idx, v) => { cd.write(0x1F801800, 1, idx); cd.write(0x1F801800 + reg, 1, v); };
const cdFlag = () => { cd.write(0x1F801800, 1, 1); return cd.read(0x1F801803, 1) & 7; };
const cdResp = () => { const r = []; while (cd.read(0x1F801800, 1) & 0x20) r.push(cd.read(0x1F801801, 1)); return r; };
T('CD-ROM: Getstat / Test / GetID com região spoofada', () => {
  cd.reset(); cd.setDisc(fakeDisc); cd.regionOverride = 'SCEA'; bus.istat = 0;
  cdw(2, 1, 0x1F);                                                   // INT enable
  cdw(1, 0, 0x01); assert.ok(cd.read(0x1F801800, 1) & 0x80, 'busy'); adv(30000);
  assert.equal(cdFlag(), 3); assert.deepEqual(cdResp(), [0x02]); assert.ok(bus.istat & 4, 'IRQ2');
  cdw(3, 1, 0x07);                                                   // ACK
  cdw(2, 0, 0x20); cdw(1, 0, 0x19); adv(30000); assert.deepEqual(cdResp(), [0x94, 0x09, 0x19, 0xC0]); cdw(3, 1, 7);
  cdw(1, 0, 0x1A); adv(30000); assert.deepEqual(cdResp(), [0x02]); cdw(3, 1, 7); adv(60000);
  assert.equal(cdFlag(), 2); assert.equal(String.fromCharCode(...cdResp().slice(4)), 'SCEA'); cdw(3, 1, 7);
});
T('CD-ROM: Setloc + ReadN entrega setor via DMA e respeita BFRD', () => {
  cdw(2, 0, 0x00); cdw(2, 0, 0x02); cdw(2, 0, 0x05); cdw(1, 0, 0x02); adv(30000); cdResp(); cdw(3, 1, 7);   // setloc 00:02:05 -> LBA 5
  cdw(1, 0, 0x06); adv(30000); cdResp(); cdw(3, 1, 7);                                                       // ReadN
  adv(900000); assert.equal(cdFlag(), 1, 'INT1');
  assert.equal(cd.read(0x1F801800, 1) & 0x40, 0, 'FIFO ainda vazia');
  cdw(3, 0, 0x80); assert.ok(cd.read(0x1F801800, 1) & 0x40, 'BFRD carrega a FIFO');
  const w = cd.dmaRead(2); assert.equal(w[0] & 0xFF, 5); assert.equal((w[0] >> 8) & 0xFF, 6);
  cdw(3, 0, 0x80);                                                   // não recarrega com FIFO não vazia
  assert.equal(cd.read(0x1F801802, 1), 13, 'continua do byte 8 (5+8)');
  cdw(3, 1, 7); cdw(1, 0, 0x09); adv(30000); cdw(3, 1, 7); adv(200000);                                      // Pause
  assert.equal(cd.reading, false);
});

// ---------------- regressões do DICR (descobertas rodando 100% Star) ----------------
T('DICR: escrita de byte em 0x1F8010F6 não apaga as flags (bits 24-30)', () => {
  psx.dma.reset(); psx.dma.dicr = (0x04 << 24) | 0x00840000;                 // flag ch2 + enable ch2 + master
  psx.dma.write(0x1F8010F6, 1, 0x84); psx.dma.write(0x1F8010F4, 2, 0x0000);
  assert.equal((psx.dma.dicr >>> 24) & 0x7F, 0x04, 'flag preservada');
  psx.dma.write(0x1F8010F4, 4, 0x04000000 | 0x00840000);                      // escrever 1 limpa
  assert.equal((psx.dma.dicr >>> 24) & 0x7F, 0, 'flag limpa ao escrever 1');
});
T('DMA: cada conclusão habilitada reafirma IRQ3 mesmo com flag antiga presa', () => {
  psx.dma.reset(); bus.istat = 0; psx.dma.dicr = ((0x04 << 24) | 0x00840000 | 0x80000000) >>> 0;   // flag ch2 antiga, bit31=1
  psx.dma.finish(2); assert.ok(bus.istat & 8, 'IRQ3 reafirmada');
});
console.log(`${n} testes de dispositivos passaram`);
