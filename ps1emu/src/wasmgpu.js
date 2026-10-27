// ============================================================================
//  Rasterizador da GPU em WebAssembly (wasm/raster.c): a VRAM passa a viver na memória do wasm e o desenho
//  (polígonos, retângulos, linhas, fill, cópia VRAM->VRAM) roda compilado, sem aquecimento. O resto da GPU
//  (comandos GP0/GP1, estado, temporização, saída de vídeo) continua em gpu.js.
// ============================================================================
import { RASTER_B64 } from './wasmraster.js';

let compiled = null;
function module_() {
  if (!compiled) {
    const bin = atob(RASTER_B64), u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    compiled = new WebAssembly.Module(u8);
  }
  return compiled;
}

/** liga o rasterizador wasm ao `gpu` (software). Devolve true se ativou. */
export function enableWasmRaster(gpu) {
  if (gpu.wr) return true;
  const memory = new WebAssembly.Memory({ initial: 80, maximum: 80 });
  const x = new WebAssembly.Instance(module_(), { env: { memory } }).exports;
  const vram = new Uint16Array(memory.buffer, x.ptr_vram(), 1024 * 512); vram.set(gpu.vram); gpu.vram = vram;
  const P = new Int32Array(memory.buffer, x.ptr_p(), 256);
  const OUT = new Uint8ClampedArray(memory.buffer, x.ptr_out(), 640 * 576 * 4);
  gpu.wr = {
    x, P, memory, OUT, snapReady: false,
    /** copia o estado de desenho atual (E1..E6) para o bloco de parâmetros */
    sync(g) {
      P[0] = g.daX1; P[1] = g.daY1; P[2] = g.daX2; P[3] = g.daY2; P[4] = g.texX; P[5] = g.texY; P[6] = g.semiMode; P[7] = g.texDepth > 2 ? 2 : g.texDepth;
      P[8] = g.dither ? 1 : 0; P[9] = g.twMaskX; P[10] = g.twMaskY; P[11] = g.twOffX; P[12] = g.twOffY; P[13] = g.setMask ? 1 : 0; P[14] = g.checkMask ? 1 : 0;
      P[15] = g.rowMask; P[16] = g.flipX ? 1 : 0; P[17] = g.flipY ? 1 : 0;
    },
  };
  Object.defineProperty(gpu, 'clutValid', { get: () => false, set: v => { if (!v) x.inv_clut(); }, enumerable: false, configurable: true });
  return true;
}
