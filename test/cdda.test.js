// CD-DA e imagens multi-trilha (.cue): disco sintético com 1 trilha de dados + 2 trilhas de áudio
import assert from 'node:assert/strict';
import { PSX } from '../src/psx.js';
import { DiscImage } from '../src/disc.js';

let n = 0; const T = (name, fn) => { fn(); n++; console.log('  ok  ', name); };

// ---------- imagens sintéticas ----------
const SYNC = [0, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 0];
function dataTrack(sectors) {                                       // MODE2/2352 com ISO9660 mínimo (PVD no LBA 16)
  const b = new Uint8Array(sectors * 2352);
  for (let i = 0; i < sectors; i++) { b.set(SYNC, i * 2352); b[i * 2352 + 15] = 2; b[i * 2352 + 18] = 8; }
  const pvd = 16 * 2352 + 24;
  b[pvd] = 1; b.set([0x43, 0x44, 0x30, 0x30, 0x31], pvd + 1); b.set(Buffer.from('TESTDISC'), pvd + 40);
  const dv = new DataView(b.buffer); dv.setUint32(pvd + 158, 20, true); dv.setUint32(pvd + 166, 2048, true);
  return b;
}
function audioTrack(sectors, amp) {                                // PCM 16-bit estéreo: L = +amp, R = -amp (constante)
  const b = new Uint8Array(sectors * 2352), dv = new DataView(b.buffer);
  for (let i = 0; i < sectors * 588; i++) { dv.setInt16(i * 4, amp, true); dv.setInt16(i * 4 + 2, -amp, true); }
  return b;
}
const DATA = dataTrack(300), A1 = audioTrack(150, 1000), A2 = audioTrack(100, 2000);

// ---------- CUE: um arquivo por trilha ----------
const cue = `FILE "game (Track 1).bin" BINARY
  TRACK 01 MODE2/2352
    INDEX 01 00:00:00
FILE "game (Track 2).bin" BINARY
  TRACK 02 AUDIO
    INDEX 00 00:00:00
    INDEX 01 00:00:02
FILE "game (Track 3).bin" BINARY
  TRACK 03 AUDIO
    INDEX 01 00:00:00
`;
const files = { 'game (Track 1).bin': DATA, 'game (Track 2).bin': A1, 'game (Track 3).bin': A2 };

T('CUE: trilhas, início de cada uma e total de setores', () => {
  const d = DiscImage.fromCue(cue, files);
  assert.equal(d.tracks.length, 3);
  assert.deepEqual(d.tracks.map(t => [t.n, t.type, t.start, t.end]), [[1, 'data', 0, 300], [2, 'audio', 302, 450], [3, 'audio', 450, 550]]);
  assert.equal(d.sectorCount, 550);
  assert.equal(d.info().audio, 2);
  assert.equal(d.volumeId.replace(/\0+/g, '').trim(), 'TESTDISC');
  assert.equal(d.sectorInfo(310), null, 'setor de áudio não tem subheader XA');
  assert.ok(d.sectorInfo(5), 'setor de dados tem');
  assert.equal(new DataView(d.readSector(450).buffer, d.readSector(450).byteOffset).getInt16(0, true), 2000, 'trilha 3 lê o 2º arquivo');
});
T('CUE: um único .bin com várias trilhas + PREGAP virtual', () => {
  const all = new Uint8Array(DATA.length + A1.length); all.set(DATA); all.set(A1, DATA.length);
  const d = DiscImage.fromCue(`FILE "x.bin" BINARY\nTRACK 01 MODE2/2352\nINDEX 01 00:00:00\nTRACK 02 AUDIO\nINDEX 01 00:04:00\n`, { 'x.bin': all });
  assert.deepEqual(d.tracks.map(t => t.start), [0, 300]);
  const g = DiscImage.fromCue(`FILE "a.bin" BINARY\nTRACK 01 MODE2/2352\nINDEX 01 00:00:00\nFILE "b.bin" BINARY\nTRACK 02 AUDIO\nPREGAP 00:00:02\nINDEX 01 00:00:00\n`, { 'a.bin': DATA, 'b.bin': A1 });
  assert.equal(g.tracks[1].start, 302, 'pregap de 2s antes da trilha 2');
  assert.equal(g.readSector(301).every(v => v === 0), true, 'pregap = silêncio');
  assert.throws(() => DiscImage.fromCue(`FILE "faltando.bin" BINARY\nTRACK 01 MODE2/2352\nINDEX 01 00:00:00\n`, {}), /não fornecido/);
});

// ---------- controlador ----------
const psx = new PSX(), cpu = psx.cpu, bus = psx.bus, cd = psx.cdrom;
psx.loadCue(cue, files); cd.regionOverride = 'SCEA';
const adv = c => { for (let i = 0; i < c; i += 32) { cpu.cycles += 32; psx.sched.run(cpu.cycles); } };
const w = (reg, idx, v) => { cd.write(0x1F801800, 1, idx); cd.write(0x1F801800 + reg, 1, v); };
const flag = () => { cd.write(0x1F801800, 1, 1); return cd.read(0x1F801803, 1) & 7; };
const resp = () => { const r = []; while (cd.read(0x1F801800, 1) & 0x20) r.push(cd.read(0x1F801801, 1)); return r; };
const cmd = (c, ...p) => { w(2, 1, 0x1F); for (const x of p) w(2, 0, x); w(1, 0, c); adv(40000); const r = resp(); w(3, 1, 7); return r; };
const cdAvail = () => (cd.spu.cdTail - cd.spu.cdHead) & 0xFFFF;

T('GetTN / GetTD usam a TOC real', () => {
  cd.reset(); cd.setDisc(psx.disc);
  assert.deepEqual(cmd(0x13), [0x02, 0x01, 0x03]);
  assert.deepEqual(cmd(0x14, 0x02), [0x02, 0x00, 0x06], 'trilha 2 em LBA 302 = 00:06:02');
  assert.deepEqual(cmd(0x14, 0x03), [0x02, 0x00, 0x08], 'trilha 3 em LBA 450 = 00:08:00');
  assert.deepEqual(cmd(0x14, 0x00), [0x02, 0x00, 0x09], 'lead-out em LBA 550 = 00:09:xx');
  assert.equal(cmd(0x14, 0x09)[0] & 1, 1, 'trilha inexistente = erro');
});
const SEC = 451584;
const sample = () => [cd.spu.cdBufL[cd.spu.cdHead], cd.spu.cdBufR[cd.spu.cdHead]];
T('Play da trilha 2 empurra PCM para a SPU a 75 setores/s', () => {
  cd.reset(); cd.setDisc(psx.disc); cd.spu.cdHead = cd.spu.cdTail = 0;
  assert.deepEqual(cmd(0x03, 0x02), [0x82], 'stat: motor + play');
  adv(SEC * 10);
  assert.deepEqual(sample(), [1000, -1000]);
  const n = cdAvail(); assert.ok(n >= 588 * 9 && n <= 588 * 12, 'amostras ~ 588/setor, tinha ' + n);
  const g = cmd(0x11);                                                // GetlocP
  assert.equal(g.length, 8); assert.equal(g[0], 0x02, 'trilha 2'); assert.equal(g[1], 1, 'index 1');
  assert.ok(cd.stat() & 0x80);
  cmd(0x09); adv(SEC * 2); assert.equal(cd.playing, false, 'Pause para o play');
  const parado = cdAvail(); adv(SEC * 3); assert.equal(cdAvail(), parado, 'não gera mais áudio');
});
T('Mute silencia o CD-DA; Demute volta', () => {
  cd.reset(); cd.setDisc(psx.disc); cd.spu.cdHead = cd.spu.cdTail = 0;
  cmd(0x0B); cmd(0x03, 0x03); adv(SEC * 4); assert.equal(cdAvail(), 0, 'mudo: nada vai para a SPU');
  cmd(0x09); adv(SEC); cmd(0x0C); cmd(0x03, 0x03); adv(SEC * 3); assert.ok(cdAvail() > 0);
  assert.deepEqual(sample(), [2000, -2000], 'trilha 3 tem amplitude 2000');
});
T('Setloc + Play sem parâmetro começa naquela posição', () => {
  cd.reset(); cd.setDisc(psx.disc); cd.spu.cdHead = cd.spu.cdTail = 0;
  cmd(0x02, 0x00, 0x08, 0x00);                                       // 00:08:00 = LBA 450 = trilha 3
  cmd(0x03); adv(SEC * 2); assert.deepEqual(sample(), [2000, -2000]);
  assert.equal(cmd(0x11)[0], 0x03, 'GetlocP vê a trilha 3');
});
T('AutoPause no fim da trilha gera INT4; fim do disco também', () => {
  cd.reset(); cd.setDisc(psx.disc);
  cmd(0x0E, 0x02);                                                   // Setmode: AutoPause
  cmd(0x03, 0x03); adv(SEC * 102);
  assert.equal(cd.playing, false); assert.equal(flag(), 4, 'INT4'); w(3, 1, 7);
  cd.reset(); cd.setDisc(psx.disc);
  cmd(0x03, 0x03); adv(SEC * 102); assert.equal(flag(), 4, 'INT4 ao chegar no fim do disco'); w(3, 1, 7);
});
T('Modo relatório (mode bit 2): INT1 com track/index/tempo/pico', () => {
  cd.reset(); cd.setDisc(psx.disc);
  cmd(0x0E, 0x04); cmd(0x03, 0x02); adv(SEC * 2);
  assert.equal(flag(), 1, 'INT1');
  const r = resp(); assert.equal(r.length, 8);
  assert.equal(r[1], 2, 'trilha'); assert.equal(r[2], 1, 'index'); assert.equal(r[6] | (r[7] << 8), 1000, 'pico = amplitude');
});
T('Troca de disco: tampa aberta -> Getstat com bit 4; após fechar, 1x só', () => {
  cd.reset(); cd.setDisc(psx.disc); cmd(0x03, 0x02); adv(SEC * 2);
  psx.openDiscLid(); assert.equal(cd.playing, false, 'abrir a tampa para a leitura');
  assert.ok(cmd(0x01)[0] & 0x10, 'shell open');
  psx.closeDiscLid(psx.disc);
  assert.ok(cmd(0x01)[0] & 0x10, '1º Getstat depois de fechar ainda mostra bit 4');
  assert.equal(cmd(0x01)[0] & 0x10, 0, '2º já não mostra');
  assert.equal(cd.disc, psx.disc);
});
T('Leitura de dados (ISO9660) continua funcionando na trilha 1 do CUE', () => {
  assert.equal(psx.disc.readUser(16)[1], 0x43);
  assert.equal(psx.disc.readFile ? true : false, true);
});
console.log(`\n${n} testes de CD-DA ok`);
