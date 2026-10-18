// Rasterizador em Worker: recebe o fluxo GP0/GP1 do emulador (ver GpuStream em src/gpu.js), desenha numa VRAM própria
// e apresenta no canvas (OffscreenCanvas transferido). Concatenado ao bundle por build.js (PS1_GPUW_SRC).
(() => {
  'use strict';
  const { GPU, VideoOut } = PS1;
  const g = new GPU(); let vid = null;
  self.onmessage = e => {
    const m = e.data;
    try {
      switch (m.t) {
        case 'init': vid = new VideoOut(m.canvas); break;
        case 'sync': g.vram.set(m.vram); for (const k in m.f) g[k] = m.f[k]; g.clutValid = false; g.snapKey = ''; break;
        case 'cmds': {
          const q = m.q;
          for (let i = 0; i < q.length; i += 2) {
            const t = q[i], v = q[i + 1];
            if (t === 0) g.writeGP0(v); else if (t === 1) g.writeGP1(v);
            else if (t === 6) g.field = v;
            else if (t === 2) g.captureFieldSW();
            else if (t === 3) { if (vid) vid.present(g); self.postMessage({ t: 'ack' }); }
          }
          break;
        }
        case 'dump': { const v = g.vram.slice(); self.postMessage({ t: 'vram', vram: v }, [v.buffer]); break; }
      }
    } catch (err) { self.postMessage({ t: 'err', msg: String(err && err.stack || err) }); }
  };
})();
