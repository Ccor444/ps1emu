// ============================================================================
//  Memory Card (128 KB = 1024 setores de 128 bytes = 16 blocos de 8 KB)
//   bloco 0 = diretório: frame 0 "MC" | frames 1..15 = entradas dos 15 blocos de dados |
//                        frames 16..35 = lista de setores ruins | 63 = cópia do frame 0
//  Formatos de arquivo aceitos: cru 128KB (.mcr/.mcd/.mc/.bin), VGS (+64 bytes "VgsM"),
//  DexDrive (+3904 bytes "123-456-STD"). Exporta sempre em formato cru (compatível com ePSXe/DuckStation).
// ============================================================================
export const CARD_SIZE = 131072, SECTOR = 128, SECTORS = 1024;

const xor127 = (b, o) => { let x = 0; for (let i = 0; i < 127; i++) x ^= b[o + i]; return x; };

export class MemoryCard {
  constructor(bytes) {
    this.data = new Uint8Array(CARD_SIZE);
    this.flag = 0x08;                        // bit3 = "diretório ainda não lido" (cartão recém-inserido)
    this.dirty = false;                      // houve gravação desde o último export
    this.onWrite = null;                     // callback(sector) a cada setor gravado
    this.format();
    if (bytes) this.load(bytes);
  }

  /** Cartão em branco, formatado como o hardware/BIOS faz */
  format() {
    const d = this.data; d.fill(0);
    d[0] = 0x4D; d[1] = 0x43; d[127] = xor127(d, 0);                       // frame 0: "MC"
    for (let i = 1; i <= 15; i++) {                                         // entradas livres
      const o = i * SECTOR; d[o] = 0xA0; d[o + 8] = 0xFF; d[o + 9] = 0xFF; d[o + 127] = xor127(d, o);
    }
    for (let i = 16; i <= 35; i++) {                                        // lista de setores ruins (vazia)
      const o = i * SECTOR; d.fill(0xFF, o, o + 4); d[o + 8] = 0xFF; d[o + 9] = 0xFF; d[o + 127] = xor127(d, o);
    }
    d.copyWithin(63 * SECTOR, 0, SECTOR);                                   // frame 63 = cópia do 0
    this.flag = 0x08; this.dirty = true;
  }

  /** Carrega um arquivo de cartão (detecta o formato). Lança erro se inválido. */
  load(bytes) {
    let off = 0;
    const tag = String.fromCharCode(...bytes.subarray(0, 4));
    if (bytes.length === CARD_SIZE + 64 && tag === 'VgsM') off = 64;
    else if (bytes.length === CARD_SIZE + 3904 && String.fromCharCode(...bytes.subarray(0, 11)) === '123-456-STD') off = 3904;
    else if (bytes.length !== CARD_SIZE) throw new Error(`tamanho de cartão inválido: ${bytes.length} bytes (esperado ${CARD_SIZE})`);
    if (bytes[off] !== 0x4D || bytes[off + 1] !== 0x43) throw new Error('cartão sem assinatura "MC" (não formatado?)');
    this.data.set(bytes.subarray(off, off + CARD_SIZE));
    this.flag = 0x08; this.dirty = false;
    return this;
  }

  /** Bytes crus para salvar em disco */
  export() { this.dirty = false; return this.data.slice(); }

  // ---- acesso por setor (usado pelo protocolo) ----
  readSector(n) { return this.data.subarray(n * SECTOR, (n + 1) * SECTOR); }
  writeSector(n, buf) {
    this.data.set(buf.subarray(0, SECTOR), n * SECTOR);
    this.flag &= ~0x08; this.dirty = true; this.onWrite?.(n);
  }

  /** Lista os saves do diretório (para a interface/depuração) */
  listSaves() {
    const d = this.data, out = [];
    const dec = (b) => { try { return new TextDecoder('shift_jis').decode(b).replace(/\0.*$/s, '').trim(); } catch { return ''; } };
    for (let i = 1; i <= 15; i++) {
      const o = i * SECTOR, st = d[o];
      if (st !== 0x51) continue;                                           // 0x51 = primeiro bloco de um save
      const size = (d[o + 4] | (d[o + 5] << 8) | (d[o + 6] << 16)) >>> 0;
      const code = String.fromCharCode(...d.subarray(o + 10, o + 31)).replace(/\0.*$/s, '');
      const blk = i * 8192, hdr = d.subarray(blk, blk + 128);
      out.push({ slot: i, code, blocks: Math.max(1, size / 8192 | 0), title: hdr[0] === 0x53 && hdr[1] === 0x43 ? dec(hdr.subarray(4, 68)) : '',
                 ok: xor127(d, o) === d[o + 127] });
    }
    return out;
  }
  freeBlocks() { let n = 0; for (let i = 1; i <= 15; i++) if (this.data[i * SECTOR] === 0xA0 || this.data[i * SECTOR] === 0xA1 ||
                                                              this.data[i * SECTOR] === 0xA2 || this.data[i * SECTOR] === 0xA3) n++; return n; }
}
