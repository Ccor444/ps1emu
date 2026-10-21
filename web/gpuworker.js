// Rasterizador em Worker: recebe o fluxo GP0/GP1 do emulador (ver GpuStream em src/gpu.js), desenha numa VRAM própria
// e apresenta no canvas (OffscreenCanvas transferido). Concatenado ao bundle por build.js (PS1_GPUW_SRC).
(() => {
  'use strict';
  const { GPU, VideoOut, GLRenderer } = PS1;
  const g = new GPU(); g.deint = 1; let vid = null, ren = null;
  self.onmessage = e => {
    const m = e.data;
    try {
      switch (m.t) {
        case 'init':
          if (m.scale > 0) {                                              // WebGL2 aqui no worker: o desenho e a apresentação saem da thread do emulador
            try { ren = new GLRenderer(m.canvas, m.scale, { smooth: !!m.smooth }); ren.attach(g); vid = { present: gg => ren.present(gg) }; self.postMessage({ t: 'ginfo', scale: ren.scale }); }
            catch (err) { ren = null; self.postMessage({ t: 'initfail', msg: String(err && err.message || err) }); }
          } else { vid = new VideoOut(m.canvas); self.postMessage({ t: 'ginfo', scale: 0 }); }
          break;
        case 'deint': g.deint = m.v | 0; break;
        case 'smooth': if (ren) ren.opts.smooth = !!m.v; break;
        case 'sync': g.vram.set(m.vram); for (const k in m.f) g[k] = m.f[k]; g.clutValid = false; g.snapKey = ''; if (ren) ren.attach(g); break;
        case 'cmds': {
          const q = m.q;
          for (let i = 0; i < q.length; i += 2) {
            const t = q[i], v = q[i + 1];
            if (t === 0) g.writeGP0(v); else if (t === 1) g.writeGP1(v);
            else if (t === 6) g.field = v;
            else if (t === 2) g.captureField();
            else if (t === 3) { if (vid) vid.present(g); self.postMessage({ t: 'ack' }); }
          }
          break;
        }
        case 'dump': { if (ren) { ren.flush(); ren.syncNative(0, 0, 1024, 512, true); } const v = g.vram.slice(); self.postMessage({ t: 'vram', vram: v }, [v.buffer]); break; }
      }
    } catch (err) { self.postMessage({ t: 'err', msg: String(err && err.stack || err) }); }
  };
})();
