import { GLRenderer } from '../src/glgpu.js';

// Saída de vídeo: apresenta a área de display da VRAM num <canvas>
export class VideoOut {
  constructor(canvas) { this.canvas = canvas; this.ctx = canvas.getContext('2d'); this.img = null; }
  present(gpu) {
    const w = gpu.width, h = gpu.height;
    if (!this.img || this.img.width !== w || this.img.height !== h) {
      this.canvas.width = w; this.canvas.height = h; this.img = this.ctx.createImageData(w, h);
    }
    gpu.renderRGBA(this.img.data);
    this.ctx.putImageData(this.img, 0, 0);
  }
}

/** Apresentação via WebGL2 com resolução interna escalável (usa GLRenderer; a GPU deixa de rasterizar por software) */
export class GLVideoOut {
  constructor(canvas, scale, psx, opts = {}) {
    this.psx = psx; this.r = new GLRenderer(canvas, scale, opts); this.scale = this.r.scale;
    this.r.attach(psx.gpu);
  }
  present(gpu) { this.r.present(gpu); }
  dispose() { this.r.detach(); }
}
