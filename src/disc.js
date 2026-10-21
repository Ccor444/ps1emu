// ============================================================================
//  Imagem de disco (.bin crua 2352 bytes/setor, ou .iso 2048) + ISO9660 + PS-X EXE
// ============================================================================
//  Layout de um setor CD-ROM XA "MODE 2" (2352 bytes):
//    0x000  12  sync (00 FF*10 00)
//    0x00C   4  header: MM SS FF (BCD) + modo (2)
//    0x010   8  subheader: file, channel, submode, coding (x2)
//    0x018 2048 dados (Form 1)   [Form 2 = 2324 bytes, usado em XA-ADPCM/vídeo]
//    ...        EDC/ECC
//  LBA 0 == tempo absoluto 00:02:00 (pregap de 150 setores).
// ============================================================================

export const SECTOR_RAW = 2352;
export const SECTOR_USER = 2048;
const SYNC = [0x00, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0x00];

const bcd = v => ((v / 10 | 0) << 4) | (v % 10);
const unbcd = v => (v >> 4) * 10 + (v & 15);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

export const lbaToMsf = lba => { lba += 150; return { m: bcd(lba / 4500 | 0), s: bcd((lba / 75 | 0) % 60), f: bcd(lba % 75) }; };
export const msfToLba = (m, s, f) => (unbcd(m) * 60 + unbcd(s)) * 75 + unbcd(f) - 150;

export class PsxExe {
  constructor(bytes) {
    const magic = String.fromCharCode(...bytes.subarray(0, 8));
    if (magic !== 'PS-X EXE') throw new Error('Não é um PS-X EXE');
    this.pc = u32(bytes, 0x10);
    this.gp = u32(bytes, 0x14);
    this.textAddr = u32(bytes, 0x18);
    this.textSize = u32(bytes, 0x1C);
    this.sp = u32(bytes, 0x30) ? (u32(bytes, 0x30) + u32(bytes, 0x34)) >>> 0 : 0;
    this.region = String.fromCharCode(...bytes.subarray(0x4C, 0x80)).split('\0')[0];
    this.data = bytes.slice(0x800, 0x800 + this.textSize);
  }
}

const cueTime = t => { const m = /^(\d+):(\d+):(\d+)$/.exec(t); if (!m) throw new Error('Tempo inválido no CUE: ' + t); return (+m[1] * 60 + +m[2]) * 75 + +m[3]; };

/**
 * Fonte de bytes PREGUIÇOSA sobre um Blob/File: lê do arquivo só o que o emulador pede (blocos de 256 KB em cache LRU), em vez de
 * carregar o disco inteiro na memória (um .bin de 700 MB estourava a memória da aba no celular). Só funciona dentro de um Web Worker
 * (usa FileReaderSync). Mesma interface que o DiscImage usa de um Uint8Array: `length` e `subarray(a, b)`.
 */
export class BlobSource {
  constructor(blob, reader = null, chunk = 262144, keep = 12) {
    this.blob = blob; this.length = blob.size; this.CH = chunk; this.keep = keep; this.lru = new Map();
    const frs = reader ? null : new FileReaderSync();
    this.read = reader || ((a, b) => new Uint8Array(frs.readAsArrayBuffer(blob.slice(a, b))));
  }
  chunk(i) {
    let c = this.lru.get(i);
    if (c) { this.lru.delete(i); this.lru.set(i, c); return c; }
    c = this.read(i * this.CH, Math.min(this.length, (i + 1) * this.CH));
    this.lru.set(i, c); if (this.lru.size > this.keep) this.lru.delete(this.lru.keys().next().value);
    return c;
  }
  subarray(a, b = this.length) {
    a = Math.max(0, a); b = Math.min(this.length, b); if (b <= a) return new Uint8Array(0);
    const ca = Math.floor(a / this.CH), cb = Math.floor((b - 1) / this.CH);
    if (ca === cb) return this.chunk(ca).subarray(a - ca * this.CH, b - ca * this.CH);
    const out = new Uint8Array(b - a);                                       // setor que cruza dois blocos: monta uma cópia
    for (let i = ca; i <= cb; i++) { const base = i * this.CH, c = this.chunk(i), lo = Math.max(a, base), hi = Math.min(b, base + c.length); out.set(c.subarray(lo - base, hi - base), lo - a); }
    return out;
  }
}

export class DiscImage {
  /**
   * `bytes` = imagem de UMA trilha de dados (.bin 2352 cru ou .iso 2048).
   * `layout` (usado por fromCue) = { files:[{bytes,sectorSize,lba0,count}], tracks:[{n,type,start}] }.
   */
  constructor(bytes, layout = null) {
    if (layout) { this.files = layout.files; this.tracks = layout.tracks; }
    else {
      const head = bytes.subarray(0, 12), raw = bytes.length % SECTOR_RAW === 0 && SYNC.every((v, i) => head[i] === v), ss = raw ? SECTOR_RAW : SECTOR_USER;
      this.files = [{ bytes, sectorSize: ss, lba0: 0, count: Math.floor(bytes.length / ss) }];
      this.tracks = [{ n: 1, type: 'data', start: 0 }];
    }
    const f0 = this.files[0], last = this.files[this.files.length - 1];
    this.bytes = f0.bytes;
    this.sectorSize = f0.sectorSize;
    this.raw = f0.sectorSize === SECTOR_RAW;
    this.sectorCount = last.lba0 + last.count;
    this.tracks.forEach((t, i) => { const nx = this.tracks[i + 1]; t.end = nx ? (nx.pre ?? nx.start) : this.sectorCount; });
    this.silence = new Uint8Array(SECTOR_RAW);                            // PREGAP virtual (sem dados no arquivo)
    this.userOffset = this.raw ? (f0.bytes.subarray(15, 16)[0] === 2 ? 24 : 16) : 0;      // MODE2 -> 24, MODE1 -> 16
    this.pvd = this.readUser(16);
    if (!this.pvd || String.fromCharCode(...this.pvd.subarray(1, 6)) !== 'CD001') throw new Error('Volume ISO9660 não encontrado no LBA 16');
    this.volumeId = text(this.pvd, 40, 32);
    this.systemId = text(this.pvd, 8, 32);
    this.rootLba = u32(this.pvd, 158);
    this.rootLen = u32(this.pvd, 166);
    this.cache = new Map();
  }

  /**
   * Monta um disco a partir de um .cue. `files` = { 'nome.bin': Uint8Array, ... } (ou Map).
   * Suporta várias trilhas por arquivo ou um arquivo por trilha, MODE1/2048, MODE1/2352,
   * MODE2/2352 e AUDIO (PCM 16-bit estéreo 44.1 kHz), INDEX 00/01 e PREGAP.
   */
  static fromCue(cueText, files) {
    const map = files instanceof Map ? files : new Map(Object.entries(files));
    const find = name => {
      if (map.has(name)) return map.get(name);
      const base = name.split(/[\\/]/).pop().toLowerCase();
      for (const [k, v] of map) if (k.split(/[\\/]/).pop().toLowerCase() === base) return v;
      throw new Error('Arquivo do CUE não fornecido: ' + name);
    };
    const fl = [], tracks = []; let cur = null, curTrack = null, running = 0;
    const closeFile = () => { if (cur) { cur.count = Math.floor(cur.bytes.length / cur.sectorSize); running = cur.lba0 + cur.count; } };
    for (const raw of cueText.split(/\r?\n/)) {
      const line = raw.trim(); let m;
      if ((m = /^FILE\s+(?:"([^"]+)"|(\S+))\s+(\S+)/i.exec(line))) {
        closeFile();
        cur = { bytes: find(m[1] ?? m[2]), sectorSize: 0, lba0: running, count: 0, first: true };
        fl.push(cur);
      } else if ((m = /^TRACK\s+(\d+)\s+(\S+)/i.exec(line))) {
        if (!cur) throw new Error('TRACK antes de FILE no CUE');
        const mode = m[2].toUpperCase(), audio = mode === 'AUDIO';
        const ss = mode === 'MODE1/2048' ? SECTOR_USER : mode === 'MODE2/2336' ? 2336 : SECTOR_RAW;
        if (!cur.sectorSize) cur.sectorSize = ss;
        curTrack = { n: +m[1], type: audio ? 'audio' : 'data', start: 0, file: cur, firstInFile: cur.first };
        cur.first = false; tracks.push(curTrack);
      } else if ((m = /^PREGAP\s+(\S+)/i.exec(line)) && curTrack) {
        if (curTrack.firstInFile) { const g = cueTime(m[1]); cur.lba0 += g; }          // silêncio antes do arquivo
      } else if ((m = /^INDEX\s+(\d+)\s+(\S+)/i.exec(line)) && curTrack) {
        if (+m[1] === 1) curTrack.start = cur.lba0 + cueTime(m[2]);
        else if (+m[1] === 0) curTrack.pre = cur.lba0 + cueTime(m[2]);                  // início do pregap (INDEX 00)
      }
    }
    closeFile();
    if (!tracks.length) throw new Error('CUE sem trilhas');
    tracks.forEach(t => delete t.file);
    tracks[0].start = 0;                                                                // LBA 0 = início da trilha 1
    return new DiscImage(null, { files: fl.map(({ bytes, sectorSize, lba0, count }) => ({ bytes, sectorSize, lba0, count })), tracks: tracks.map(({ n, type, start, pre }) => (pre !== undefined && pre < start ? { n, type, start, pre } : { n, type, start })) });
  }

  trackAt(lba) {
    for (let i = this.tracks.length - 1; i >= 0; i--) if (lba >= (this.tracks[i].pre ?? this.tracks[i].start)) return this.tracks[i];
    return this.tracks[0];
  }

  /** Setor inteiro (2352 bytes se raw; 2048 se .iso) */
  readSector(lba) {
    if (lba < 0 || lba >= this.sectorCount) return null;
    for (const f of this.files) {
      if (lba >= f.lba0 && lba < f.lba0 + f.count) return f.bytes.subarray((lba - f.lba0) * f.sectorSize, (lba - f.lba0 + 1) * f.sectorSize);
    }
    return this.silence;
  }
  /** 2048 bytes de dados (Form 1) */
  readUser(lba) {
    const s = this.readSector(lba);
    return s && s.subarray(this.userOffset, this.userOffset + SECTOR_USER);
  }
  /** Cabeçalho/subheader XA: o controlador de CD-ROM usa isso (filtros XA, tipo de setor) */
  sectorInfo(lba) {
    const s = this.readSector(lba);
    if (!s || !this.raw || s.length !== SECTOR_RAW || this.trackAt(lba).type === 'audio') return null;
    const sm = s[18];
    return { mode: s[15], file: s[16], channel: s[17], submode: sm, coding: s[19],
             form2: !!(sm & 0x20), audio: !!(sm & 0x04), video: !!(sm & 0x02), data: !!(sm & 0x08), rt: !!(sm & 0x40), eof: !!(sm & 0x80) };
  }

  // ---------------- ISO9660 ----------------
  readDir(lba, len) {
    const out = [];
    for (let blk = 0; blk < Math.ceil(len / 2048); blk++) {
      const d = this.readUser(lba + blk); let o = 0;
      while (o < 2048 && d[o]) {
        const l = d[o], nl = d[o + 32];
        const name = text(d, o + 33, nl);
        if (name !== '\0' && name !== '\x01')
          out.push({ name, lba: u32(d, o + 2), size: u32(d, o + 10), dir: !!(d[o + 25] & 2) });
        o += l;
      }
    }
    return out;
  }
  listRoot() { return this.cache.get('root') ?? (this.cache.set('root', this.readDir(this.rootLba, this.rootLen)), this.cache.get('root')); }

  /** Procura "DIR\ARQ.EXT" ignorando o ";1" e maiúsc./minúsc. */
  findFile(path) {
    const parts = path.replace(/^cdrom:/i, '').split(/[\\/]/).filter(Boolean);
    let list = this.listRoot(), ent = null;
    for (const p of parts) {
      const want = p.toUpperCase().replace(/;\d+$/, '');
      ent = list.find(e => e.name.toUpperCase().replace(/;\d+$/, '') === want);
      if (!ent) return null;
      if (ent.dir) list = this.readDir(ent.lba, ent.size);
    }
    return ent;
  }
  readFile(path) {
    const e = this.findFile(path); if (!e) return null;
    const out = new Uint8Array(e.size);
    for (let i = 0; i * 2048 < e.size; i++) out.set(this.readUser(e.lba + i).subarray(0, Math.min(2048, e.size - i * 2048)), i * 2048);
    return out;
  }

  systemCnf() {
    const f = this.readFile('SYSTEM.CNF'); if (!f) return null;
    const cnf = {};
    for (const line of String.fromCharCode(...f).split(/\r?\n/)) {
      const m = line.match(/^\s*(\w+)\s*=\s*(.*?)\s*$/); if (m) cnf[m[1].toUpperCase()] = m[2];
    }
    return cnf;
  }

  /** Região lida da área de licença (setores 4..): SCEI (JP), SCEA (US), SCEE (EU) */
  region() {
    let t = '';
    for (let i = 0; i < 12; i++) t += String.fromCharCode(...this.readUser(i));
    const c = t.replace(/[^A-Za-z]/g, '');
    if (/Entertainment(Euro)*pe/.test(c) || /Europe/.test(c)) return 'SCEE';
    if (/America|Amer/.test(c)) return 'SCEA';
    if (/LicensedbySonyComputerEntertainmentInc/.test(c)) return 'SCEI';
    return 'desconhecida';
  }

  /** Executável de boot (BOOT= do SYSTEM.CNF; fallback PSX.EXE) */
  loadBootExe() {
    const cnf = this.systemCnf();
    const path = cnf?.BOOT?.replace(/^cdrom:\\?/i, '') ?? 'PSX.EXE';
    const bytes = this.readFile(path);
    if (!bytes) throw new Error('Executável de boot não encontrado: ' + path);
    const exe = new PsxExe(bytes);
    exe.path = path; exe.cnf = cnf ?? {};
    exe.stack = cnf?.STACK ? parseInt(cnf.STACK, 16) >>> 0 : 0x801FFF00;
    return exe;
  }

  info() {
    const cnf = this.systemCnf();
    const secs = this.sectorCount, sec = secs / 75 | 0;
    return { formato: this.raw ? 'BIN cru 2352 (MODE2/XA)' : 'ISO 2048', setores: secs, trilhas: this.tracks.length, audio: this.tracks.filter(t => t.type === 'audio').length,
             duracao: `${sec / 60 | 0}:${String(sec % 60).padStart(2, '0')}`, volume: this.volumeId.trim(),
             regiao: this.region(), boot: cnf?.BOOT, stack: cnf?.STACK };
  }
}

const text = (b, o, n) => String.fromCharCode(...b.subarray(o, o + n));
