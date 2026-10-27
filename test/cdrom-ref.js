// ============================================================================
//  Controlador de CD-ROM  0x1F801800-0x1F801803  (4 registradores com "index" 0..3)
//   0x1800 R: status   W: index
//   0x1801 R: resposta W: comando(idx0)
//   0x1802 R: dados    W: parâmetro(idx0) / enable de INT(idx1)
//   0x1803 R: enable(idx0,2) / flags(idx1,3)   W: request(idx0) / ack(idx1)
//  INT1 dado pronto | INT2 completo | INT3 ack | INT4 fim de dados | INT5 erro  -> IRQ2
//  Inclui decodificação XA-ADPCM (4 bits) enviada ao mixer do SPU.
// ============================================================================
import { lbaToMsf, msfToLba } from '../src/disc.js';

const bcd = v => ((v / 10 | 0) << 4) | (v % 10);
const CMD_DELAY = 25000;                    // ciclos até a 1ª resposta
// medidos no console real (ps1-tests/cdrom/timing; média de 'Remaining Sectors' em ciclos) — ~0,7% mais rápido que 33868800/75
const SECTOR_1X = 448342, SECTOR_2X = 223825;
const XA_POS = [0, 60, 115, 98], XA_NEG = [0, 0, -52, -55];
const sat16 = v => v > 32767 ? 32767 : v < -32768 ? -32768 : v;

export class CDROM {
  constructor(sys) { this.sys = sys; this.disc = null; this.spu = null; this.regionOverride = 'SCEA'; this.log = null; this.reset(); }

  reset() {
    this.index = 0; this.param = []; this.resp = []; this.intEnable = 0; this.intFlag = 0; this.queue = [];
    this.mode = 0; this.busy = false; this.reading = false; this.seeking = false; this.playing = false;
    this.pos = 0; this.seekLba = 0; this.hasSetloc = false; this.filterFile = 0; this.filterChan = 0;
    this.data = null; this.dpos = 0; this.sector = null; this.readEvt = null; this.lastHdr = new Uint8Array(8);
    this.xaOld = [[0, 0], [0, 0]]; this.xaPhase = 0; this.motor = !!this.disc; this.sectorsRead = 0;
    this.muted = false; this.lid = false; this.shellFlag = false; this.playCount = 0; this.reportAlt = 0; this.peak = 0;
  }
  setDisc(d) { this.disc = d; this.motor = !!d; }

  // ---------------- tampa / troca de disco ----------------
  /** abre a tampa: para tudo; Getstat passa a mostrar "shell open" (bit 4) */
  openLid() { this.stopRead(); this.lid = true; this.motor = false; }
  /** fecha a tampa com outro disco (ou nenhum); o 1º Getstat depois reporta o bit 4 uma vez, como o hardware */
  closeLid(disc) { this.disc = disc || null; this.lid = false; this.shellFlag = true; this.motor = !!disc; this.hasSetloc = false; this.pos = 0; }

  // ---------------- trilhas / TOC ----------------
  tocTracks() { return (this.disc && this.disc.tracks) || [{ n: 1, type: 'data', start: 0 }]; }
  trackAt(lba) { const t = this.tocTracks(); for (let i = t.length - 1; i >= 0; i--) if (lba >= (t[i].pre ?? t[i].start)) return t[i]; return t[0]; }
  total() { return this.disc ? this.disc.sectorCount : 0; }

  stat() {
    let s = 0;
    if (!this.disc || this.lid || this.shellFlag) s |= 0x10; if (this.disc && this.motor) s |= 0x02;
    if (this.reading) s |= 0x20; if (this.seeking) s |= 0x40; if (this.playing) s |= 0x80;
    return s;
  }

  // ---------------- registradores ----------------
  read(addr, size) {
    switch (addr & 3) {
      case 0: return this.index | ((this.data && this.dpos < this.data.length) ? 0x40 : 0) | (this.param.length === 0 ? 0x08 : 0) |
                     (this.param.length < 16 ? 0x10 : 0) | (this.resp.length ? 0x20 : 0) | (this.busy ? 0x80 : 0);
      case 1: return this.resp.length ? this.resp.shift() : 0;
      case 2: { let v = 0; for (let i = 0; i < size; i++) v |= this.readData() << (8 * i); return v >>> 0; }
      case 3: return ((this.index & 1) ? this.intFlag : this.intEnable) | 0xE0;
    }
  }
  write(addr, size, v) {
    v &= 0xFF;
    switch (addr & 3) {
      case 0: this.index = v & 3; return;
      case 1: if (this.index === 0) this.command(v); return;
      case 2:
        if (this.index === 0) { if (this.param.length < 16) this.param.push(v); }
        else if (this.index === 1) { this.intEnable = v & 0x1F; if (this.intFlag & this.intEnable) this.sys.irq(2); }
        return;
      case 3:
        if (this.index === 0) { if (v & 0x80) { if (this.sector && !(this.data && this.dpos < this.data.length)) { this.data = this.sector; this.dpos = 0; } } else this.data = null; }
        else if (this.index === 1) this.ack(v);
        return;
    }
  }

  readData() {
    if (!this.data || this.dpos >= this.data.length) return 0;
    const b = this.data[this.dpos++]; if (this.dpos >= this.data.length) this.data = null; return b;
  }
  dmaRead(words) {
    const o = new Uint32Array(words);
    for (let i = 0; i < words; i++) o[i] = (this.readData() | (this.readData() << 8) | (this.readData() << 16) | (this.readData() << 24)) >>> 0;
    return o;
  }

  // ---------------- interrupções ----------------
  respond(type, resp, delay, clearBusy) {
    this.sys.sched.call(this.sys.now() + delay, 'cdrom', 'fire', [type, resp, !!clearBusy]);
  }
  /** resposta atrasada: `resp` é um vetor de bytes fixo ou uma especificação ['S', ...extras] / ['GS'] / ['PARAM'] / ['LOCL'] / ['MON'] / ['MOFF'] / ['SEEK'] resolvida na entrega */
  fire(type, resp, clearBusy) { if (clearBusy) this.busy = false; this.deliver(type, this.mkResp(resp)); }
  mkResp(r) {
    if (typeof r[0] === 'number' || r.length === 0) return r;
    switch (r[0]) {
      case 'S': return [this.stat(), ...r.slice(1)];
      case 'GS': { const st = this.stat(); this.shellFlag = false; return [st]; }
      case 'PARAM': return [this.stat(), this.mode, 0, this.filterFile, this.filterChan];
      case 'LOCL': return [...this.lastHdr];
      case 'MON': this.motor = !!this.disc; return [this.stat()];
      case 'MOFF': this.motor = false; return [this.stat()];
      case 'SEEK': if (this.hasSetloc) { this.pos = this.seekLba; this.hasSetloc = false; } return [this.stat()];
    }
    throw new Error('resposta CD desconhecida ' + r[0]);
  }
  deliver(type, resp) {
    if (this.intFlag !== 0) { this.queue.push({ type, resp }); return; }
    this.intFlag = type; this.resp = resp.slice();
    this.log?.(`INT${type} [${resp.map(b => b.toString(16)).join(' ')}]`);
    if (this.intEnable & type) this.sys.irq(2);
  }
  ack(v) {
    this.intFlag &= ~(v & 0x1F);
    if (v & 0x40) this.param.length = 0;
    if (this.intFlag === 0 && this.queue.length) {
      const q = this.queue.shift(); this.sys.sched.call(this.sys.now() + 500, 'cdrom', 'deliver', [q.type, q.resp]);
    }
  }

  // ---------------- comandos ----------------
  command(c) {
    const p = this.param; this.param = []; this.busy = true; this.resp = [];
    this.log?.(`CMD ${c.toString(16)} (${p.map(b => b.toString(16)).join(' ')})`);
    const first = (resp, d = CMD_DELAY) => this.respond(3, resp, d, true);
    const second = (resp, d) => this.respond(2, resp, d, false);
    const err = (code, d = CMD_DELAY) => this.respond(5, [this.stat() | 1, code], d, true);

    switch (c) {
      case 0x01: first(['GS']); break;   // Getstat
      case 0x02:                                                                       // Setloc
        if (p.length < 3) return err(0x20);
        this.seekLba = msfToLba(p[0], p[1], p[2]); this.hasSetloc = true; first(['S']); break;
      case 0x06: case 0x1B: {                                                          // ReadN / ReadS
        if (!this.disc) return err(0x80);
        this.stopRead(); this.reading = true; this.seeking = false;
        let delay = 0;
        if (this.hasSetloc) { this.pos = this.seekLba; this.hasSetloc = false; delay = (this.mode & 0x80) ? 667000 : 362000; }   // 1º setor medido no console: ~784k (1x) / ~865k (2x)
        first(['S']);
        this.readEvt = this.sys.sched.call(this.sys.now() + delay + this.interval(), 'cdrom', 'readSector');
        break;
      }
      case 0x07: first(['S']); second(['MON'], 100000); break;   // MotorOn
      case 0x08: { first(['S']); this.stopRead(); second(['MOFF'], 200000); break; }  // Stop
      case 0x09: { const s = this.stat(), was = this.reading || this.playing; this.stopRead(); first([s]); second(['S'], was ? ((this.mode & 0x80) ? 1062000 : 1038000) : 150000); break; }  // Pause (lendo: ~1,0M ciclos no console)
      case 0x0A: {                                                                      // Init
        this.stopRead(); this.mode = 0; this.hasSetloc = false;
        first(['S']); second(['MON'], 502000); break;                                 // Init completo: ~476k em média no console
      }
      case 0x0B: this.muted = true; first(['S']); break;                  // Mute
      case 0x0C: this.muted = false; first(['S']); break;                 // Demute
      case 0x0D: this.filterFile = p[0] | 0; this.filterChan = p[1] | 0; first(['S']); break;   // Setfilter
      case 0x0E: this.mode = p[0] | 0; first(['S']); break;               // Setmode
      case 0x0F: first(['PARAM']); break;           // Getparam
      case 0x10: first(['LOCL']); break;                                 // GetlocL
      case 0x11: {                                                                      // GetlocP
        const lba = Math.max(0, this.pos - (this.playing ? 0 : 1)), t = this.trackAt(lba), a = lbaToMsf(lba);
        const idx = lba >= t.start ? 1 : 0, rel = idx ? lba - t.start : t.start - lba;
        first([bcd(t.n), idx, bcd(rel / 4500 | 0), bcd((rel / 75 | 0) % 60), bcd(rel % 75), a.m, a.s, a.f]); break;
      }
      case 0x13: { const tr = this.tocTracks(); first(['S', bcd(tr[0].n), bcd(tr[tr.length - 1].n)]); break; }   // GetTN
      case 0x14: {                                                                      // GetTD
        const t = (p[0] >> 4) * 10 + (p[0] & 15), tr = this.tocTracks();
        if (t === 0) { const m = lbaToMsf(this.total()); first(['S', m.m, m.s]); }
        else { const e = tr.find(x => x.n === t); if (e) { const m = lbaToMsf(e.start); first(['S', m.m, m.s]); } else err(0x10); }
        break;
      }
      case 0x15: case 0x16: {                                                           // SeekL / SeekP
        first(['S']); second(['SEEK'], 100000); break;
      }
      case 0x19:                                                                        // Test
        if (p[0] === 0x20) first([0x94, 0x09, 0x19, 0xC0]); else first(['S']); break;
      case 0x1A:                                                                        // GetID
        first(['S']);
        if (!this.disc) this.respond(5, [0x08, 0x40, 0, 0, 0, 0, 0, 0], 50000, false);
        else {
          const reg = this.regionOverride || this.disc.region(), L = reg.charCodeAt(3) || 0x41;
          this.respond(2, ['S', 0x00, 0x20, 0x00, 0x53, 0x43, 0x45, L], 50000, false);
        }
        break;
      case 0x12: case 0x1E: case 0x1C: first(['S']); second(['S'], 400000); break;   // SetSession / ReadTOC / Reset
      case 0x03: {                                                                      // Play (CD-DA)
        if (!this.disc) return err(0x80);
        this.stopRead();
        const t = p.length && p[0] ? this.tocTracks().find(x => x.n === ((p[0] >> 4) * 10 + (p[0] & 15))) : null;
        let delay = 0;
        if (t) { this.pos = t.start; this.hasSetloc = false; delay = 100000; }
        else if (this.hasSetloc) { this.pos = this.seekLba; this.hasSetloc = false; delay = 100000; }
        this.playing = true; this.playCount = 0; this.reportAlt = 0;
        first(['S']);
        this.readEvt = this.sys.sched.call(this.sys.now() + delay + this.interval(), 'cdrom', 'playSector');
        break;
      }
      case 0x04: case 0x05: first(['S']); break;                          // Forward/Backward (busca rápida: ignorada)
      default: err(0x40);                                                               // comando inválido
    }
  }

  interval() { return (this.mode & 0x80) ? SECTOR_2X : SECTOR_1X; }
  stopRead() { this.reading = false; this.seeking = false; this.playing = false; if (this.readEvt) { this.sys.sched.cancel(this.readEvt); this.readEvt = null; } }

  readSector() {
    this.readEvt = null; if (!this.reading || !this.disc) return;
    // hardware: não avança p/ o próximo setor enquanto houver interrupção pendente (evita sobrescrever o buffer)
    if (this.intFlag !== 0 || this.queue.length) { this.readEvt = this.sys.sched.call(this.sys.now() + 1500, 'cdrom', 'readSector'); return; }
    const lba = this.pos, sec = this.disc.readSector(lba);
    if (!sec) { this.reading = false; this.deliver(4, [this.stat()]); return; }
    const raw = this.disc.raw, info = raw ? this.disc.sectorInfo(lba) : null;
    this.lastHdr = raw ? sec.slice(12, 20) : Uint8Array.from([...Object.values(lbaToMsf(lba)), 1, 0, 0, 0, 0]);
    this.sectorsRead++;
    if (info && (this.mode & 0x40) && info.audio && info.form2) {                     // XA-ADPCM: toca em vez de entregar
      if (!(this.mode & 0x08) || (info.file === this.filterFile && info.channel === this.filterChan)) this.decodeXA(sec, info.coding);
    } else {
      this.sector = raw ? ((this.mode & 0x20) ? sec.slice(12, 12 + 0x924) : sec.slice(24, 24 + 0x800)) : sec.slice(0);
      this.deliver(1, [this.stat()]);
    }
    this.pos++;
    this.readEvt = this.sys.sched.call(this.sys.now() + this.interval(), 'cdrom', 'readSector');
  }

  // ---------------- CD-DA ----------------
  playSector() {
    this.readEvt = null; if (!this.playing || !this.disc) return;
    const lba = this.pos;
    if (lba >= this.total()) { this.playing = false; this.deliver(4, [this.stat()]); return; }
    const t = this.trackAt(lba), sec = this.disc.readSector(lba);
    let pk = 0;
    if (t.type === 'audio' && sec && sec.length >= 2352) {
      for (let i = 0; i < 588; i++) {
        const o = i * 4, l = (sec[o] | (sec[o + 1] << 8)) << 16 >> 16, r = (sec[o + 2] | (sec[o + 3] << 8)) << 16 >> 16;
        if (!this.muted && this.spu) this.spu.pushCd(l, r);
        const a = l < 0 ? -l : l, b = r < 0 ? -r : r; if (a > pk) pk = a; if (b > pk) pk = b;
      }
    }
    // relatório (mode bit 2): a cada 10 setores alterna tempo relativo/absoluto
    if ((this.mode & 0x04) && (this.playCount++ % 10) === 0 && this.intFlag === 0 && !this.queue.length) {
      const a = lbaToMsf(lba), idx = lba >= t.start ? 1 : 0, rel = idx ? lba - t.start : t.start - lba;
      this.reportAlt ^= 1;
      const mm = this.reportAlt ? bcd(rel / 4500 | 0) : a.m, ss = this.reportAlt ? (bcd((rel / 75 | 0) % 60) | 0x80) : a.s, ff = this.reportAlt ? bcd(rel % 75) : a.f;
      this.deliver(1, [this.stat(), bcd(t.n), idx, mm, ss, ff, pk & 0xFF, pk >> 8]);
    }
    this.pos++;
    if (((this.mode & 0x02) && this.pos >= t.end) || this.pos >= this.total()) {       // AutoPause / fim do disco
      this.playing = false; this.deliver(4, [this.stat()]); return;
    }
    this.readEvt = this.sys.sched.call(this.sys.now() + this.interval(), 'cdrom', 'playSector');
  }

  // ---------------- XA-ADPCM ----------------
  decodeXA(sec, coding) {
    if (!this.spu || (coding & 0x10)) return;                                          // 8 bits: TODO
    const stereo = !!(coding & 1), ratio = ((coding & 4) ? 18900 : 37800) / 44100;
    const L = [], R = [];
    for (let g = 0; g < 18; g++) {
      const base = 24 + g * 128, units = [];
      for (let i = 0; i < 8; i++) {
        const hdr = sec[base + (i < 4 ? i : i + 4)], range = hdr & 15, filt = (hdr >> 4) & 3, shift = range > 12 ? 9 : range;
        const old = this.xaOld[stereo ? (i & 1) : 0], out = new Int16Array(28);
        for (let w = 0; w < 28; w++) {
          const byte = sec[base + 16 + w * 4 + (i >> 1)], nib = (i & 1) ? byte >> 4 : byte & 15;
          let s = (((nib << 12) << 16) >> 16) >> shift;
          s = sat16(s + ((old[0] * XA_POS[filt] + old[1] * XA_NEG[filt] + 32) >> 6));
          old[1] = old[0]; old[0] = s; out[w] = s;
        }
        units.push(out);
      }
      if (stereo) for (let q = 0; q < 4; q++) for (let k = 0; k < 28; k++) { L.push(units[2 * q][k]); R.push(units[2 * q + 1][k]); }
      else for (let i = 0; i < 8; i++) for (let k = 0; k < 28; k++) { L.push(units[i][k]); R.push(units[i][k]); }
    }
    const n = L.length; let t = this.xaPhase;                                           // reamostra p/ 44.1kHz (linear)
    while (t < n - 1) {
      const i = t | 0, f = t - i;
      if (!this.muted) this.spu.pushCd((L[i] + (L[i + 1] - L[i]) * f) | 0, (R[i] + (R[i + 1] - R[i]) * f) | 0);
      t += ratio;
    }
    this.xaPhase = t - (n - 1);
  }
}
