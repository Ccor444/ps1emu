// ============================================================================
//  Renderizador WebGL2 da GPU do PS1 com resolução interna escalável (1x..8x)
// ============================================================================
//  Modelo de dados:
//   H  = VRAM em alta resolução (textura RGBA8 de 1024*S x 512*S, + stencil). É a fonte da verdade:
//        rgb = cor RGB555 expandida, alpha = bit de máscara (bit 15), stencil = espelho do bit de máscara.
//   N  = VRAM nativa (gpu.vram, Uint16Array 1024x512) + textura R16UI usada para buscar texels
//        4/8/15 bits e CLUTs nos shaders. É um CACHE de H: só é atualizada quando a CPU escreve na VRAM
//        (uploads) ou quando algo precisa ler uma região que a GPU desenhou ("tiles sujos" de 16x16).
//  Com o renderizador ativo o rasterizador por software NÃO roda (gpu.hw != null).
//
//  Fidelidade: coordenadas de vértice somam +0.5 pixel (o PS1 amostra em inteiros), texels via
//  texelFetch (nearest), dither por pixel nativo, semi-transparência com os 4 modos (blend de hardware;
//  texels semi/opacos em 2 passes), máscara (set/check) via stencil, janela de textura, área de desenho
//  por scissor, cópias VRAM->VRAM na GPU, leitura de VRAM por readPixels + reamostragem.
// ============================================================================

const VW = 1024, VH = 512, TILE = 16, TX = VW / TILE, TY = VH / TILE;
const STRIDE_W = 19;                                   // palavras por vértice (7 floats + 12 ints)
const MAX_VERTS = 6 * 8192;

const VS_PRIM = `#version 300 es
layout(location=0) in vec2 a_pos; layout(location=1) in vec3 a_col; layout(location=2) in vec2 a_uv;
layout(location=3) in ivec4 a_tex; layout(location=4) in ivec4 a_flg; layout(location=5) in ivec4 a_tw;
out vec3 v_col; out vec2 v_uv; flat out ivec4 v_tex; flat out ivec4 v_flg; flat out ivec4 v_tw;
void main(){
  gl_Position = vec4(a_pos.x/512.0-1.0, a_pos.y/256.0-1.0, 0.0, 1.0);
  v_col=a_col; v_uv=a_uv; v_tex=a_tex; v_flg=a_flg; v_tw=a_tw;
}`;

const FS_PRIM = `#version 300 es
precision highp float; precision highp int; precision highp usampler2D;
uniform usampler2D u_vram; uniform float u_scale; uniform int u_pass; uniform int u_setMask;
in vec3 v_col; in vec2 v_uv; flat in ivec4 v_tex; flat in ivec4 v_flg; flat in ivec4 v_tw;
out vec4 o_color;
const int DITHER[16] = int[16](-4,0,-3,1, 2,-2,3,-1, -3,1,-4,0, 3,-1,2,-2);
int vramAt(ivec2 p){ return int(texelFetch(u_vram, ivec2(p.x & 1023, p.y & 511), 0).r); }
void main(){
  ivec3 c = ivec3(floor(v_col + 0.002));
  bool textured = v_flg.x < 3;
  bool semiTexel = false;
  if (textured) {
    ivec2 uv = ivec2(floor(v_uv + vec2(0.0002)));
    int u = uv.x & 255, v = uv.y & 255;
    u = (u & ~(v_tw.x << 3)) | ((v_tw.z & v_tw.x) << 3);
    v = (v & ~(v_tw.y << 3)) | ((v_tw.w & v_tw.y) << 3);
    int depth = v_flg.x, texel;
    if (depth == 0) {
      int w = vramAt(ivec2(v_tex.x + (u >> 2), v_tex.y + v));
      texel = vramAt(ivec2(v_tex.z + ((w >> ((u & 3) * 4)) & 15), v_tex.w));
    } else if (depth == 1) {
      int w = vramAt(ivec2(v_tex.x + (u >> 1), v_tex.y + v));
      texel = vramAt(ivec2(v_tex.z + ((w >> ((u & 1) * 8)) & 255), v_tex.w));
    } else {
      texel = vramAt(ivec2(v_tex.x + u, v_tex.y + v));
    }
    if (texel == 0) discard;
    semiTexel = (texel & 0x8000) != 0;
    ivec3 t = ivec3(texel & 31, (texel >> 5) & 31, (texel >> 10) & 31);
    if (v_flg.y != 0) c = t * 8; else c = (t * c) >> 4;
  }
  if (u_pass == 1) { if (!textured || semiTexel) discard; }
  else if (u_pass == 2) { if (textured && !semiTexel) discard; }
  if (v_flg.z != 0) {
    ivec2 np = ivec2(floor(gl_FragCoord.xy / u_scale));
    c += DITHER[((np.y & 3) << 2) | (np.x & 3)];
  }
  c = clamp(c, 0, 255) >> 3;
  o_color = vec4(vec3(c) / 31.0, float(u_setMask));
}`;

const VS_QUAD = `#version 300 es
layout(location=0) in vec2 a_pos; layout(location=1) in vec2 a_uv; out vec2 v_uv;
uniform int u_ndc;   // 1: a_pos já está em NDC (apresentação); 0: coordenadas nativas da VRAM
void main(){
  gl_Position = (u_ndc == 1) ? vec4(a_pos, 0.0, 1.0) : vec4(a_pos.x/512.0-1.0, a_pos.y/256.0-1.0, 0.0, 1.0);
  v_uv = a_uv;
}`;

const FS_BLIT_NATIVE = `#version 300 es
precision highp float; precision highp int; precision highp usampler2D;
uniform usampler2D u_src; uniform float u_scale; uniform int u_pass;
out vec4 o_color;
void main(){
  ivec2 p = ivec2(floor(gl_FragCoord.xy / u_scale)) & ivec2(1023, 511);
  uint w = texelFetch(u_src, p, 0).r;
  int bit = int((w >> 15u) & 1u);
  if (bit != u_pass) discard;
  o_color = vec4(vec3(ivec3(int(w & 31u), int((w >> 5u) & 31u), int((w >> 10u) & 31u))) / 31.0, float(bit));
}`;

const FS_BLIT_RGBA = `#version 300 es
precision highp float; precision highp int;
uniform sampler2D u_src; uniform ivec2 u_delta; uniform int u_pass; uniform int u_setMask;
out vec4 o_color;
void main(){
  vec4 t = texelFetch(u_src, ivec2(gl_FragCoord.xy) + u_delta, 0);
  int bit = (t.a > 0.5 || u_setMask != 0) ? 1 : 0;
  if (bit != u_pass) discard;
  o_color = vec4(t.rgb, float(bit));
}`;

const FS_PRESENT = `#version 300 es
precision highp float;
uniform sampler2D u_tex; in vec2 v_uv; out vec4 o_color;
void main(){ o_color = vec4(texture(u_tex, v_uv).rgb, 1.0); }`;

const Q5 = new Uint8Array(256); for (let i = 0; i < 256; i++) Q5[i] = Math.round(i * 31 / 255);

export class GLRenderer {
  /**
   * @param canvas  <canvas> (será usado com contexto webgl2)
   * @param scale   fator de resolução interna (1..8)
   * @param opts    { smooth: true -> filtro linear quando a saída é reduzida }
   */
  constructor(canvas, scale = 2, opts = {}) {
    const gl = this.gl = canvas.getContext('webgl2', { antialias: false, alpha: false, depth: false, stencil: false, preserveDrawingBuffer: !!opts.preserve, powerPreference: 'high-performance' });
    if (!gl) throw new Error('WebGL2 indisponível neste navegador');
    this.canvas = canvas; this.opts = opts; this.gpu = null;
    const maxTex = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE), gl.getParameter(gl.MAX_RENDERBUFFER_SIZE));
    let S = Math.max(1, Math.floor(scale)); while (S > 1 && VW * S > maxTex) S--;
    this.scale = S; this.W = VW * S; this.H = VH * S;

    this.initGL();
    this.f32 = new Float32Array(MAX_VERTS * STRIDE_W); this.i32 = new Int32Array(this.f32.buffer);
    this.n = 0; this.pc = new Int32Array(12);
    this.batchKey = ''; this.batchKind = 0; this.batchSemi = 0;
    this.pb = [1e9, 1e9, -1, -1];                              // bbox pendente (nativo) do lote ainda não desenhado
    this.dirty = new Uint8Array(TX * TY);                      // tiles em que H é mais novo que N
    this.rb = null; this.rgba = null;
    this.outW = 0; this.outH = 0;
  }

  // ------------------------------------------------------------------ GL setup
  compile(vs, fs, bind) {
    const gl = this.gl, mk = (t, s) => { const sh = gl.createShader(t); gl.shaderSource(sh, s); gl.compileShader(sh); if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error('shader: ' + gl.getShaderInfoLog(sh)); return sh; };
    const p = gl.createProgram(); gl.attachShader(p, mk(gl.VERTEX_SHADER, vs)); gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p); if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('link: ' + gl.getProgramInfoLog(p));
    const u = {}; const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) { const info = gl.getActiveUniform(p, i); u[info.name] = gl.getUniformLocation(p, info.name); }
    return { p, u };
  }

  initGL() {
    const gl = this.gl, S = this.scale;
    gl.getExtension('EXT_color_buffer_float');
    this.prim = this.compile(VS_PRIM, FS_PRIM);
    this.blitN = this.compile(VS_QUAD, FS_BLIT_NATIVE);
    this.blitC = this.compile(VS_QUAD, FS_BLIT_RGBA);
    this.pres = this.compile(VS_QUAD, FS_PRESENT);

    // H: textura + stencil
    this.texH = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, this.texH);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, this.W, this.H);
    this.setFilter(this.texH, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    this.rbDS = gl.createRenderbuffer(); gl.bindRenderbuffer(gl.RENDERBUFFER, this.rbDS);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH24_STENCIL8, this.W, this.H);
    this.fboH = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboH);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.texH, 0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_STENCIL_ATTACHMENT, gl.RENDERBUFFER, this.rbDS);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('FBO incompleto (memória de vídeo insuficiente para ' + S + 'x?)');
    gl.disable(gl.SCISSOR_TEST); gl.clearColor(0, 0, 0, 0); gl.clearStencil(0); gl.stencilMask(0xFF); gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);

    // N: textura R16UI
    this.texN = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, this.texN);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R16UI, VW, VH);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    this.texScratch = null;                                      // alocada na 1ª cópia VRAM->VRAM
    this.texVid = gl.createTexture();                            // imagem de display em 24 bits

    // VBO/VAO dos primitivos
    this.vbo = gl.createBuffer(); this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao); gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, MAX_VERTS * STRIDE_W * 4, gl.STREAM_DRAW);
    const B = STRIDE_W * 4;
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, B, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, B, 8);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 2, gl.FLOAT, false, B, 20);
    gl.enableVertexAttribArray(3); gl.vertexAttribIPointer(3, 4, gl.INT, B, 28);
    gl.enableVertexAttribArray(4); gl.vertexAttribIPointer(4, 4, gl.INT, B, 44);
    gl.enableVertexAttribArray(5); gl.vertexAttribIPointer(5, 4, gl.INT, B, 60);

    // quad (blits/apresentação): 6 vértices x (x,y,u,v)
    this.qbo = gl.createBuffer(); this.qvao = gl.createVertexArray();
    gl.bindVertexArray(this.qvao); gl.bindBuffer(gl.ARRAY_BUFFER, this.qbo);
    gl.bufferData(gl.ARRAY_BUFFER, 6 * 4 * 4, gl.STREAM_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 16, 8);
    this.qdata = new Float32Array(24);
    gl.bindVertexArray(null);
  }

  setFilter(tex, f) {
    const gl = this.gl; gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, f); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, f);
  }

  // ------------------------------------------------------------------ ciclo de vida
  /** liga o renderizador à GPU: envia a VRAM nativa atual para H e N */
  attach(gpu) {
    this.gpu = gpu; gpu.hw = this;
    this.dirty.fill(0); this.n = 0; this.pb = [1e9, 1e9, -1, -1];
    const cm = gpu.checkMask; gpu.checkMask = false;
    this.uploadNativeTex(0, 0, VW, VH);
    this.blitNativeToH(0, 0, VW, VH);
    gpu.checkMask = cm;
  }
  /** desliga: traz tudo de H para a VRAM nativa e devolve o controle ao software */
  detach() {
    if (!this.gpu) return;
    this.flush(); this.syncNative(0, 0, VW, VH, true);
    this.gpu.hw = null; this.gpu = null;
  }

  // ------------------------------------------------------------------ helpers de região
  /** divide um retângulo (com wrap em 1024x512) em pedaços que não cruzam as bordas */
  rects(x, y, w, h, fn) {
    x &= 1023; y &= 511; w = Math.min(w, VW); h = Math.min(h, VH);
    const w1 = Math.min(w, VW - x), h1 = Math.min(h, VH - y);
    fn(x, y, w1, h1);
    if (w > w1) fn(0, y, w - w1, h1);
    if (h > h1) { fn(x, 0, w1, h - h1); if (w > w1) fn(0, 0, w - w1, h - h1); }
  }
  markDirty(x0, y0, x1, y1) {                                   // inclusivo, nativo
    x0 = Math.max(0, x0); y0 = Math.max(0, y0); x1 = Math.min(VW - 1, x1); y1 = Math.min(VH - 1, y1);
    if (x1 < x0 || y1 < y0) return;
    for (let ty = y0 >> 4; ty <= y1 >> 4; ty++) for (let tx = x0 >> 4; tx <= x1 >> 4; tx++) this.dirty[ty * TX + tx] = 1;
  }
  isDirty(x, y, w, h) {
    for (let ty = y >> 4; ty <= (y + h - 1) >> 4; ty++) for (let tx = x >> 4; tx <= (x + w - 1) >> 4; tx++) if (this.dirty[ty * TX + tx]) return true;
    return false;
  }
  pendingHits(x, y, w, h) {
    const p = this.pb; return p[2] >= 0 && !(x > p[2] || x + w - 1 < p[0] || y > p[3] || y + h - 1 < p[1]);
  }

  // ------------------------------------------------------------------ N <-> H
  uploadNativeTex(x, y, w, h) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.texN);
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, VW); gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, x); gl.pixelStorei(gl.UNPACK_SKIP_ROWS, y);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, w, h, gl.RED_INTEGER, gl.UNSIGNED_SHORT, this.gpu.vram);
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0); gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0); gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
  }

  applyMask(writeBit, check) {
    const gl = this.gl; gl.enable(gl.STENCIL_TEST); gl.stencilMask(0xFF);
    if (check) { gl.stencilFunc(gl.EQUAL, 0, 0xFF); gl.stencilOp(gl.KEEP, gl.KEEP, writeBit ? gl.INVERT : gl.KEEP); }
    else { gl.stencilFunc(gl.ALWAYS, writeBit, 0xFF); gl.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE); }
  }

  drawQuad(x, y, w, h, u0 = 0, v0 = 0, u1 = 0, v1 = 0, ndc = false) {
    const gl = this.gl, q = this.qdata;
    const X0 = x, Y0 = y, X1 = x + w, Y1 = y + h;
    q.set([X0, Y0, u0, v0, X1, Y0, u1, v0, X0, Y1, u0, v1, X1, Y0, u1, v0, X1, Y1, u1, v1, X0, Y1, u0, v1]);
    gl.bindVertexArray(this.qvao); gl.bindBuffer(gl.ARRAY_BUFFER, this.qbo); gl.bufferSubData(gl.ARRAY_BUFFER, 0, q);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  /** copia a região da VRAM nativa (N) para H (2 passes por bit de máscara) */
  blitNativeToH(x0, y0, w0, h0) {
    const gl = this.gl, S = this.scale, g = this.gpu;
    this.rects(x0, y0, w0, h0, (x, y, w, h) => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboH); gl.viewport(0, 0, this.W, this.H);
      gl.disable(gl.BLEND); gl.enable(gl.SCISSOR_TEST); gl.scissor(x * S, y * S, w * S, h * S); gl.colorMask(true, true, true, true);
      gl.useProgram(this.blitN.p); gl.uniform1f(this.blitN.u.u_scale, S); gl.uniform1i(this.blitN.u.u_ndc, 0); gl.uniform1i(this.blitN.u.u_src, 0);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.texN);
      for (let pass = 0; pass < 2; pass++) {
        this.applyMask(pass, g.checkMask); gl.uniform1i(this.blitN.u.u_pass, pass);
        this.drawQuad(x, y, w, h);
      }
      if (!g.checkMask) for (let ty = y >> 4; ty <= (y + h - 1) >> 4; ty++) for (let tx = x >> 4; tx <= (x + w - 1) >> 4; tx++) {
        if (tx * TILE >= x && ty * TILE >= y && (tx + 1) * TILE <= x + w && (ty + 1) * TILE <= y + h) this.dirty[ty * TX + tx] = 0;
      }
    });
  }

  /** traz de H para a VRAM nativa os tiles sujos que tocam a região; atualiza também a textura N */
  syncNative(x0, y0, w0, h0, all = false) {
    this.flush();
    const gl = this.gl, S = this.scale, g = this.gpu;
    this.rects(x0, y0, w0, h0, (x, y, w, h) => {
      let bx0 = 1e9, by0 = 1e9, bx1 = -1, by1 = -1;
      for (let ty = y >> 4; ty <= (y + h - 1) >> 4; ty++) for (let tx = x >> 4; tx <= (x + w - 1) >> 4; tx++) {
        if (!all && !this.dirty[ty * TX + tx]) continue;
        if (tx * TILE < bx0) bx0 = tx * TILE; if (ty * TILE < by0) by0 = ty * TILE;
        if ((tx + 1) * TILE - 1 > bx1) bx1 = (tx + 1) * TILE - 1; if ((ty + 1) * TILE - 1 > by1) by1 = (ty + 1) * TILE - 1;
      }
      if (bx1 < 0) return;
      const bw = bx1 - bx0 + 1, bh = by1 - by0 + 1, pw = bw * S, ph = bh * S;
      if (!this.rb || this.rb.length < pw * ph * 4) this.rb = new Uint8Array(pw * ph * 4);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.fboH);
      gl.readPixels(bx0 * S, by0 * S, pw, ph, gl.RGBA, gl.UNSIGNED_BYTE, this.rb);
      const rb = this.rb, c = S >> 1, vram = g.vram;
      for (let ny = 0; ny < bh; ny++) {
        let o = ((ny * S + c) * pw + c) * 4, di = (by0 + ny) * VW + bx0;
        for (let nx = 0; nx < bw; nx++, o += S * 4, di++) {
          vram[di] = Q5[rb[o]] | (Q5[rb[o + 1]] << 5) | (Q5[rb[o + 2]] << 10) | (rb[o + 3] > 127 ? 0x8000 : 0);
        }
      }
      for (let ty = by0 >> 4; ty <= by1 >> 4; ty++) for (let tx = bx0 >> 4; tx <= bx1 >> 4; tx++) this.dirty[ty * TX + tx] = 0;
      this.uploadNativeTex(bx0, by0, bw, bh);
    });
  }

  /** a CPU escreveu na VRAM nativa (upload / cópia por software): reflete em H e N */
  uploaded(x, y, w, h) {
    this.flush();
    this.rects(x, y, w, h, (rx, ry, rw, rh) => { this.uploadNativeTex(rx, ry, rw, rh); this.blitNativeToH(rx, ry, rw, rh); });
  }

  // ------------------------------------------------------------------ comandos de VRAM
  fill(x0, y0, w, h, col) {
    this.flush();
    const gl = this.gl, S = this.scale;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboH); gl.viewport(0, 0, this.W, this.H);
    gl.disable(gl.BLEND); gl.enable(gl.SCISSOR_TEST); gl.colorMask(true, true, true, true); gl.stencilMask(0xFF);
    gl.clearColor(((col & 255) >> 3) / 31, (((col >> 8) & 255) >> 3) / 31, (((col >> 16) & 255) >> 3) / 31, 0); gl.clearStencil(0);
    this.rects(x0, y0, w, h, (x, y, rw, rh) => {
      gl.scissor(x * S, y * S, rw * S, rh * S); gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
      this.markDirty(x, y, x + rw - 1, y + rh - 1);
    });
  }

  /** VRAM->VRAM dentro da GPU. Devolve false se o chamador deve fazer por software (após sincronizar). */
  copy(sx, sy, dx, dy, w, h) {
    const g = this.gpu;
    if (sx + w > VW || dx + w > VW || sy + h > VH || dy + h > VH) {          // com wrap: caminho por software
      this.rects(sx, sy, w, h, (x, y, rw, rh) => this.syncNative(x, y, rw, rh));
      if (g.checkMask) this.rects(dx, dy, w, h, (x, y, rw, rh) => this.syncNative(x, y, rw, rh));
      return false;
    }
    this.flush();
    const gl = this.gl, S = this.scale;
    if (!this.texScratch) {
      this.texScratch = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, this.texScratch);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, this.W, this.H); this.setFilter(this.texScratch, gl.NEAREST);
    }
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.fboH);
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, this.texScratch);
    gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, sx * S, sy * S, sx * S, sy * S, w * S, h * S);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboH); gl.viewport(0, 0, this.W, this.H);
    gl.disable(gl.BLEND); gl.enable(gl.SCISSOR_TEST); gl.scissor(dx * S, dy * S, w * S, h * S); gl.colorMask(true, true, true, true);
    gl.useProgram(this.blitC.p); gl.uniform1i(this.blitC.u.u_ndc, 0); gl.uniform1i(this.blitC.u.u_src, 2);
    gl.uniform2i(this.blitC.u.u_delta, (sx - dx) * S, (sy - dy) * S); gl.uniform1i(this.blitC.u.u_setMask, g.setMask ? 1 : 0);
    for (let pass = 0; pass < 2; pass++) { this.applyMask(pass, g.checkMask); gl.uniform1i(this.blitC.u.u_pass, pass); this.drawQuad(dx, dy, w, h); }
    gl.activeTexture(gl.TEXTURE0);
    this.markDirty(dx, dy, dx + w - 1, dy + h - 1);
    return true;
  }

  // ------------------------------------------------------------------ primitivos
  pv(x, y, r, g, b, u, v) {
    const f = this.f32, i = this.i32, pc = this.pc; let o = this.n * STRIDE_W;
    f[o] = x; f[o + 1] = y; f[o + 2] = r; f[o + 3] = g; f[o + 4] = b; f[o + 5] = u; f[o + 6] = v;
    for (let k = 0; k < 12; k++) i[o + 7 + k] = pc[k];
    this.n++;
  }

  /** prepara as constantes por primitivo + garante texturas atualizadas + gerencia o lote */
  begin(textured, semi, raw, dith, clutX, clutY, bx0, by0, bx1, by1, nverts) {
    const g = this.gpu, pc = this.pc;
    const depth = textured ? g.texDepth : 3;
    if (textured) {
      const pw = depth === 0 ? 64 : depth === 1 ? 128 : 256, px = g.texX * 64, py = g.texY * 256;
      const need = (x, y, w, h) => this.rects(x, y, w, h, (rx, ry, rw, rh) => {
        if (this.pendingHits(rx, ry, rw, rh)) this.flush();
        if (this.isDirty(rx, ry, rw, rh)) this.syncNative(rx, ry, rw, rh);
      });
      need(px, py, pw, 256);
      if (depth === 0) need(clutX * 16, clutY, 16, 1); else if (depth === 1) need(clutX * 16, clutY, 256, 1);
      pc[0] = px; pc[1] = py; pc[2] = clutX * 16; pc[3] = clutY;
    } else { pc[0] = pc[1] = pc[2] = pc[3] = 0; }
    pc[4] = depth; pc[5] = raw ? 1 : 0; pc[6] = dith ? 1 : 0; pc[7] = 0;
    pc[8] = g.twMaskX; pc[9] = g.twMaskY; pc[10] = g.twOffX; pc[11] = g.twOffY;

    const kind = !semi ? 0 : (textured ? 2 : 1);
    const key = `${g.daX1},${g.daY1},${g.daX2},${g.daY2},${g.setMask ? 1 : 0},${g.checkMask ? 1 : 0},${kind},${semi ? g.semiMode : -1}`;
    if (this.n > 0 && (key !== this.batchKey || this.n + nverts > MAX_VERTS)) this.flush();
    this.batchKey = key; this.batchKind = kind; this.batchSemi = g.semiMode;
    this.bs = { x1: g.daX1, y1: g.daY1, x2: g.daX2, y2: g.daY2, set: g.setMask ? 1 : 0, check: g.checkMask };     // estado do lote (a GPU pode mudar antes do flush)
    // bbox pendente (para dirty tiles e hazard de textura)
    const p = this.pb;
    p[0] = Math.min(p[0], Math.max(bx0, g.daX1, 0)); p[1] = Math.min(p[1], Math.max(by0, g.daY1, 0));
    p[2] = Math.max(p[2], Math.min(bx1, g.daX2, VW - 1)); p[3] = Math.max(p[3], Math.min(by1, g.daY2, VH - 1));
    return kind;
  }
  end(kind) { if (kind === 2) this.flush(); }

  polygon(V, quad, o) {
    this.tri(V[0], V[1], V[2], o);
    if (quad) this.tri(V[1], V[2], V[3], o);
  }

  tri(a, b, c, o) {
    const g = this.gpu, S = this.scale;
    const area = (b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y);
    if (area === 0) return;
    const minX = Math.min(a.x, b.x, c.x), maxX = Math.max(a.x, b.x, c.x), minY = Math.min(a.y, b.y, c.y), maxY = Math.max(a.y, b.y, c.y);
    if (maxX - minX > 1023 || maxY - minY > 511) return;
    if (maxX < g.daX1 || minX > g.daX2 || maxY < g.daY1 || minY > g.daY2) return;
    const dith = o.tex ? (!o.raw && g.dither) : (g.dither && o.gour);
    const kind = this.begin(o.tex, o.semi, o.raw, dith, o.clutX, o.clutY, minX, minY, maxX, maxY, 3);
    const s = 0.5 / S, vs = o.gour ? [a, b, c] : [a, a, a];
    const P = [a, b, c];
    // O hardware interpola com gradientes truncados a 12 bits fracionários a partir do 1º vértice (+0,5 de arredondamento).
    // Reproduz o mesmo plano ajustando o valor de cada vértice: a interpolação linear da GPU do PC dá exatamente esses valores.
    const trunc = Math.trunc, bx = b.x - a.x, by = b.y - a.y, cx = c.x - a.x, cy = c.y - a.y;
    const plane = (va, vb, vc) => {
      const nx = (vb - va) * cy - (vc - va) * by, ny = (vc - va) * bx - (vb - va) * cx;
      const gx = trunc(nx * 4096 / area) / 4096, gy = trunc(ny * 4096 / area) / 4096;
      return [va + 0.5, va + 0.5 + gx * bx + gy * by, va + 0.5 + gx * cx + gy * cy];
    };
    const U = o.tex ? plane(a.u, b.u, c.u) : [0, 0, 0], V = o.tex ? plane(a.v, b.v, c.v) : [0, 0, 0];
    const R = o.gour ? plane(a.r, b.r, c.r) : null, G = o.gour ? plane(a.g, b.g, c.g) : null, B = o.gour ? plane(a.b, b.b, c.b) : null;
    for (let k = 0; k < 3; k++) this.pv(P[k].x + s, P[k].y + s, R ? R[k] : a.r, G ? G[k] : a.g, B ? B[k] : a.b, U[k], V[k]);
    this.end(kind);
  }

  rect(x0, y0, w, h, o) {
    const g = this.gpu;
    if (w <= 0 || h <= 0) return;
    if (x0 > g.daX2 || y0 > g.daY2 || x0 + w - 1 < g.daX1 || y0 + h - 1 < g.daY1) return;
    const kind = this.begin(o.tex, o.semi, o.raw, false, o.clutX, o.clutY, x0, y0, x0 + w - 1, y0 + h - 1, 6);
    let ul = o.u0, ur = o.u0 + w, vt = o.v0, vb = o.v0 + h;
    if (o.flipX) { ul = o.u0 + 1.5; ur = ul - w; }          // pixel x amostra u0+1-x (centro do pixel = x+0,5)
    if (o.flipY) { vt = o.v0 + 0.5; vb = vt - h; }          // flip Y: v0-y
    const x1 = x0 + w, y1 = y0 + h, r = o.r, gg = o.g, b = o.b;
    this.pv(x0, y0, r, gg, b, ul, vt); this.pv(x1, y0, r, gg, b, ur, vt); this.pv(x0, y1, r, gg, b, ul, vb);
    this.pv(x1, y0, r, gg, b, ur, vt); this.pv(x1, y1, r, gg, b, ur, vb); this.pv(x0, y1, r, gg, b, ul, vb);
    this.end(kind);
  }

  /** linha: reproduz exatamente os pixels do rasterizador por software (DDA), 1 quad de 1 pixel nativo cada */
  line(x0, y0, x1, y1, c0, c1, semi, gour) {
    const g = this.gpu;
    const dith = g.dither;                                            // linhas flat também recebem dithering (medido)
    const minX = Math.min(x0, x1), maxX = Math.max(x0, x1), minY = Math.min(y0, y1), maxY = Math.max(y0, y1);
    if (maxX < g.daX1 || minX > g.daX2 || maxY < g.daY1 || minY > g.daY2) return;
    const adx = Math.abs(x1 - x0), ady = Math.abs(y1 - y0), k = Math.max(adx, ady);
    if (adx >= 1024 || ady >= 512) return;                            // fora do limite do hardware
    const kind = this.begin(false, semi, false, dith, 0, 0, minX, minY, maxX, maxY, (k + 1) * 6);
    // mesmo algoritmo do rasterizador por software (passo 32.32 arredondado para longe do zero, pixel = floor(pos + 0,5 - eps))
    let ax = x0, ay = y0, bx = x1, by = y1, ca = c0, cb = c1;
    if (ax >= bx && k) { ax = x1; ay = y1; bx = x0; by = y0; ca = c1; cb = c0; }
    const div = d => { if (k === 0) return 0; const q = d * 4294967296 / k; return (q < 0 ? Math.floor(q) : Math.ceil(q)) / 4294967296; };
    const sx = div(bx - ax), sy = div(by - ay);
    let px = ax + 0.5 - 1 / 4194304, py = ay + 0.5;
    const r0 = ca & 255, g0 = (ca >> 8) & 255, b0 = (ca >> 16) & 255;
    const kk = k || 1, dr = Math.trunc((((cb & 255) - r0) * 4096) / kk), dg = Math.trunc(((((cb >> 8) & 255) - g0) * 4096) / kk), db = Math.trunc(((((cb >> 16) & 255) - b0) * 4096) / kk);
    for (let i = 0; i <= k; i++, px += sx, py += sy) {
      const x = Math.floor(px), y = Math.floor(py);
      let r = r0, gg = g0, b = b0;
      if (gour) { r = ((r0 << 12) + 2048 + dr * i) >> 12; gg = ((g0 << 12) + 2048 + dg * i) >> 12; b = ((b0 << 12) + 2048 + db * i) >> 12; }
      this.pv(x, y, r, gg, b, 0, 0); this.pv(x + 1, y, r, gg, b, 0, 0); this.pv(x, y + 1, r, gg, b, 0, 0);
      this.pv(x + 1, y, r, gg, b, 0, 0); this.pv(x + 1, y + 1, r, gg, b, 0, 0); this.pv(x, y + 1, r, gg, b, 0, 0);
    }
    this.end(kind);
  }

  // ------------------------------------------------------------------ desenho do lote
  setBlend(mode) {
    const gl = this.gl; gl.enable(gl.BLEND);
    switch (mode) {
      case 0: gl.blendColor(0, 0, 0, 0.5); gl.blendEquationSeparate(gl.FUNC_ADD, gl.FUNC_ADD); gl.blendFuncSeparate(gl.CONSTANT_ALPHA, gl.CONSTANT_ALPHA, gl.ONE, gl.ZERO); break;
      case 1: gl.blendEquationSeparate(gl.FUNC_ADD, gl.FUNC_ADD); gl.blendFuncSeparate(gl.ONE, gl.ONE, gl.ONE, gl.ZERO); break;
      case 2: gl.blendEquationSeparate(gl.FUNC_REVERSE_SUBTRACT, gl.FUNC_ADD); gl.blendFuncSeparate(gl.ONE, gl.ONE, gl.ONE, gl.ZERO); break;
      default: gl.blendColor(0, 0, 0, 0.25); gl.blendEquationSeparate(gl.FUNC_ADD, gl.FUNC_ADD); gl.blendFuncSeparate(gl.CONSTANT_ALPHA, gl.ONE, gl.ONE, gl.ZERO);
    }
  }

  flush() {
    if (!this.n || !this.gpu) { this.n = 0; return; }
    const gl = this.gl, g = this.gpu, S = this.scale, n = this.n;
    const p = this.pb;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboH); gl.viewport(0, 0, this.W, this.H);
    gl.enable(gl.SCISSOR_TEST);
    const bs = this.bs, x1 = Math.min(bs.x2, VW - 1), y1 = Math.min(bs.y2, VH - 1);
    gl.scissor(bs.x1 * S, bs.y1 * S, Math.max(0, x1 - bs.x1 + 1) * S, Math.max(0, y1 - bs.y1 + 1) * S);
    gl.colorMask(true, true, true, true);
    this.applyMask(bs.set, bs.check);
    gl.useProgram(this.prim.p);
    gl.uniform1f(this.prim.u.u_scale, S); gl.uniform1i(this.prim.u.u_setMask, bs.set); gl.uniform1i(this.prim.u.u_vram, 0);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.texN);
    gl.bindVertexArray(this.vao); gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.f32, 0, n * STRIDE_W);
    const kind = this.batchKind;
    if (kind === 0) { gl.disable(gl.BLEND); gl.uniform1i(this.prim.u.u_pass, 0); gl.drawArrays(gl.TRIANGLES, 0, n); }
    else if (kind === 1) { this.setBlend(this.batchSemi); gl.uniform1i(this.prim.u.u_pass, 0); gl.drawArrays(gl.TRIANGLES, 0, n); gl.disable(gl.BLEND); }
    else {
      gl.disable(gl.BLEND); gl.uniform1i(this.prim.u.u_pass, 1); gl.drawArrays(gl.TRIANGLES, 0, n);
      this.setBlend(this.batchSemi); gl.uniform1i(this.prim.u.u_pass, 2); gl.drawArrays(gl.TRIANGLES, 0, n); gl.disable(gl.BLEND);
    }
    gl.bindVertexArray(null);
    if (p[2] >= 0) this.markDirty(p[0], p[1], p[2], p[3]);
    this.pb = [1e9, 1e9, -1, -1]; this.n = 0;
  }

  // ------------------------------------------------------------------ saída
  /** desenha a área de display no canvas */
  present(gpu) {
    this.flush();
    const gl = this.gl, S = this.scale, w = gpu.width, h = gpu.height;
    const outS = Math.max(1, Math.min(S, Math.floor(3840 / w)));
    const cw = w * outS, ch = h * outS;
    if (this.canvas.width !== cw || this.canvas.height !== ch) { this.canvas.width = cw; this.canvas.height = ch; }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, cw, ch);
    gl.disable(gl.SCISSOR_TEST); gl.disable(gl.BLEND); gl.disable(gl.STENCIL_TEST); gl.colorMask(true, true, true, true);
    if (!gpu.dispOn) { gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT); return; }
    gl.useProgram(this.pres.p); gl.uniform1i(this.pres.u.u_ndc, 1); gl.uniform1i(this.pres.u.u_tex, 1);
    gl.activeTexture(gl.TEXTURE1);
    if (gpu.rgb24) {
      const vw = Math.ceil(w * 1.5) + 1;
      this.rects(gpu.startX, gpu.startY, vw, h, (x, y, rw, rh) => this.syncNative(x, y, rw, rh));
      if (!this.rgba || this.rgba.length !== w * h * 4) this.rgba = new Uint8ClampedArray(w * h * 4);
      gpu.renderRGBA(this.rgba);
      gl.bindTexture(gl.TEXTURE_2D, this.texVid);
      if (this.vidW !== w || this.vidH !== h) { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null); this.vidW = w; this.vidH = h; }   // aloca 1x; depois só atualiza (menos custo no driver)
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, this.rgba);
      this.setFilter(this.texVid, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.drawQuad(-1, 1, 2, -2, 0, 0, 1, 1, true);
    } else {
      gl.bindTexture(gl.TEXTURE_2D, this.texH);
      this.setFilter(this.texH, (outS === S || !this.opts.smooth) ? gl.NEAREST : gl.LINEAR);
      const u0 = gpu.startX / VW, v0 = gpu.startY / VH, u1 = (gpu.startX + w) / VW, v1 = (gpu.startY + h) / VH;
      this.drawQuad(-1, 1, 2, -2, u0, v0, u1, v1, true);
    }
    gl.activeTexture(gl.TEXTURE0);
    gpu.frameCount++;
  }

  /** lê a área de display em RGBA8 (linhas de cima para baixo) na resolução interna - para testes/capturas */
  readDisplay(gpu) {
    this.flush();
    const gl = this.gl, S = this.scale, w = gpu.width, h = gpu.height;
    if (gpu.rgb24 || !gpu.dispOn) { this.syncNative(0, 0, VW, VH); const r = gpu.renderRGBA(); return { data: r.data, width: r.width, height: r.height, scale: 1 }; }
    const out = new Uint8ClampedArray(w * S * h * S * 4), tmp = new Uint8Array(w * S * h * S * 4);
    // lê em até 4 pedaços (wrap)
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.fboH);
    this.rects(gpu.startX, gpu.startY, w, h, (x, y, rw, rh) => {
      const buf = new Uint8Array(rw * S * rh * S * 4);
      gl.readPixels(x * S, y * S, rw * S, rh * S, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      const ox = ((x - gpu.startX) & 1023) * S, oy = ((y - gpu.startY) & 511) * S;
      for (let r = 0; r < rh * S; r++) tmp.set(buf.subarray(r * rw * S * 4, (r + 1) * rw * S * 4), ((oy + r) * w * S + ox) * 4);
    });
    for (let i = 0; i < tmp.length; i += 4) {
      const r5 = Q5[tmp[i]], g5 = Q5[tmp[i + 1]], b5 = Q5[tmp[i + 2]];
      let r = r5 << 3, gg = g5 << 3, b = b5 << 3; r |= r >> 5; gg |= gg >> 5; b |= b >> 5;
      out[i] = r; out[i + 1] = gg; out[i + 2] = b; out[i + 3] = 255;
    }
    return { data: out, width: w * S, height: h * S, scale: S };
  }
}
