// ============================================================================
//  Save states: serialização genérica do estado do PSX
//   Container: "PS1S" | versão u32 | tamanho do cabeçalho u32 | cabeçalho JSON | blobs binários
//   Os arrays tipados (RAM, VRAM, RAM do SPU...) vão no blob sem os zeros finais; o resto, em JSON.
//   Não entram: disco, BIOS, entradas (botões), memory cards (têm persistência própria), caches do JIT
//   e do renderizador (reconstruídos ao restaurar), áudio já gerado.
// ============================================================================
export const STATE_VERSION = 1;
const MAGIC = 0x53315350;                                  // "PS1S" (little endian)
const TYPES = { Int8Array, Uint8Array, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array };

// propriedades que nunca são salvas (referências cruzadas, callbacks, configuração, entradas)
const SKIP = new Set(['sys', 'bus', 'dev', 'disc', 'spu', 'gpu', 'dma', 'timers', 'sio', 'cdrom', 'mdec', 'hw', 'log', 'logIo', 'ioStats', 'unmapped',
  'cards', 'buttons', 'padConnected', 'padType', 'sticks', 'onRumble', 'clock', 'regionOverride', 'bios', 'biosView', 'codeFlags', 'jit', 'deint']);
const COMPONENTS = ['cpu', 'bus', 'gpu', 'spu', 'dma', 'timers', 'sio', 'cdrom', 'mdec'];
const PSX_FIELDS = ['audioLen', 'lastTick', 'timerAt', 'nextTick', 'lineAcc', 'line', 'audioAcc', 'frameDone', 'frames', 'useJit'];

class Writer { constructor() { this.bufs = []; this.size = 0; }
  add(u8) { let n = u8.length; while (n > 0 && u8[n - 1] === 0) n--; const off = this.size; this.bufs.push(u8.subarray(0, n)); this.size += n; return [off, n]; } }

function enc(v, w, depth = 0) {
  if (depth > 12) throw new Error('estrutura profunda demais no save state');
  if (v === null || typeof v === 'boolean' || typeof v === 'string') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : { $n: String(v) };
  if (v === undefined) return { $u: 1 };
  if (typeof v === 'function' || v instanceof Map || v instanceof DataView) return undefined;
  if (ArrayBuffer.isView(v)) {
    const name = v.constructor.name; if (!TYPES[name]) throw new Error('tipo não suportado: ' + name);
    const [off, n] = w.add(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
    return { $a: name, len: v.length, off, n };
  }
  if (Array.isArray(v)) return v.map(x => { const e = enc(x, w, depth + 1); return e === undefined ? null : e; });
  const o = {};
  for (const k of Object.keys(v)) { if (SKIP.has(k)) continue; const e = enc(v[k], w, depth + 1); if (e !== undefined) o[k] = e; }
  return o;
}
const isTyped = d => d && typeof d === 'object' && d.$a !== undefined;
function dec(d, blob) {
  if (d === null || typeof d !== 'object') return d;
  if (d.$n !== undefined) return Number(d.$n);
  if (d.$u) return undefined;
  if (isTyped(d)) { const T = TYPES[d.$a], a = new T(d.len); new Uint8Array(a.buffer).set(blob.subarray(d.off, d.off + d.n)); return a; }
  if (Array.isArray(d)) return d.map(x => dec(x, blob));
  const o = {}; for (const k of Object.keys(d)) o[k] = dec(d[k], blob); return o;
}
/** grava `d` em `target[key]` preservando arrays tipados, instâncias (Voice, GTE...) e protótipos */
function put(target, key, d, blob) {
  const cur = target[key];
  if (isTyped(d) && ArrayBuffer.isView(cur) && cur.constructor.name === d.$a && cur.length === d.len) {
    const u = new Uint8Array(cur.buffer, cur.byteOffset, cur.byteLength); u.fill(0); u.set(blob.subarray(d.off, d.off + d.n)); return;
  }
  if (Array.isArray(d) && Array.isArray(cur) && cur.length === d.length && d.every(x => x && typeof x === 'object' && !Array.isArray(x) && !isTyped(x) && x.$n === undefined && !x.$u)) {
    d.forEach((x, i) => apply(cur[i], x, blob)); return;
  }
  if (d && typeof d === 'object' && !Array.isArray(d) && !isTyped(d) && d.$n === undefined && !d.$u && cur && typeof cur === 'object' && !Array.isArray(cur) && !ArrayBuffer.isView(cur)) {
    apply(cur, d, blob); return;
  }
  target[key] = dec(d, blob);
}
function apply(target, data, blob) { for (const k of Object.keys(data)) { if (!SKIP.has(k)) put(target, k, data[k], blob); } }

/** Snapshot de um PSX → Uint8Array */
export function saveState(psx, meta = {}) {
  const w = new Writer(), st = {};
  for (const c of COMPONENTS) st[c] = enc(c === 'bus' ? pick(psx.bus, ['ram', 'scratch', 'io', 'istat', 'imask', 'cacheCtrl', 'gpuToggle']) : psx[c], w);
  st.psx = enc(pick(psx, PSX_FIELDS), w);
  st.sched = psx.sched.snapshot();
  const head = new TextEncoder().encode(JSON.stringify({ version: STATE_VERSION, meta: { ...meta, savedAt: Date.now(), frames: psx.frames, cycles: psx.cpu.cycles }, st }));
  const out = new Uint8Array(12 + head.length + w.size), dv = new DataView(out.buffer);
  dv.setUint32(0, MAGIC, true); dv.setUint32(4, STATE_VERSION, true); dv.setUint32(8, head.length, true);
  out.set(head, 12); let o = 12 + head.length; for (const b of w.bufs) { out.set(b, o); o += b.length; }
  return out;
}
function pick(o, keys) { const r = {}; for (const k of keys) r[k] = o[k]; return r; }

/** lê só o cabeçalho (meta) sem restaurar */
export function readStateMeta(bytes) { return parse(bytes).head.meta; }
function parse(bytes) {
  if (bytes.length < 12) throw new Error('arquivo de save state inválido');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(0, true) !== MAGIC) throw new Error('não é um save state do ps1emu');
  const ver = dv.getUint32(4, true); if (ver !== STATE_VERSION) throw new Error(`versão de save state incompatível (${ver}, esperada ${STATE_VERSION})`);
  const hl = dv.getUint32(8, true);
  if (12 + hl > bytes.length) throw new Error('save state truncado');
  return { head: JSON.parse(new TextDecoder().decode(bytes.subarray(12, 12 + hl))), blob: bytes.subarray(12 + hl) };
}

/** Restaura um snapshot no PSX (o mesmo disco/BIOS devem estar carregados). Devolve o meta. */
export function loadState(psx, bytes) {
  const { head, blob } = parse(bytes), st = head.st;
  for (const c of COMPONENTS) apply(psx[c], st[c], blob);
  apply(psx, st.psx, blob);
  if (!Number.isFinite(psx.timerAt)) psx.timerAt = psx.lastTick;           // estados antigos não tinham timerAt
  psx.sched.restore(st.sched);
  const cd = psx.cdrom;
  cd.readEvt = psx.sched.find('cdrom', 'readSector') || psx.sched.find('cdrom', 'playSector');
  if (cd.data && cd.data.length === 0) cd.data = null;
  psx.jit.flush(); psx.bus.codeFlags.fill(0);
  psx.audioLen = 0;
  if (psx.gpu.hw) psx.gpu.hw.attach(psx.gpu);               // renderizador GL: reenvia a VRAM restaurada
  return head.meta;
}

// ---- compressão (CompressionStream: navegadores modernos e Node ≥ 18) ----
async function pipe(u8, stream) { return new Uint8Array(await new Response(new Blob([u8]).stream().pipeThrough(stream)).arrayBuffer()); }
export const gzip = u8 => pipe(u8, new CompressionStream('gzip'));
export const gunzip = u8 => pipe(u8, new DecompressionStream('gzip'));
export const isGzip = u8 => u8.length > 2 && u8[0] === 0x1F && u8[1] === 0x8B;
