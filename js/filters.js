/* RetroLens filters — port of FilterBank (Python/OpenCV) to plain JS.
 * Every filter takes an ImageData (RGBA) and returns an ImageData of the same size. */
(function (global) {
  "use strict";

  const clamp = (v, lo = 0, hi = 255) => (v < lo ? lo : v > hi ? hi : v);

  function gray(d) {
    const n = d.length >> 2;
    const g = new Uint8ClampedArray(n);
    for (let i = 0, p = 0; i < n; i++, p += 4) {
      g[i] = (d[p] * 299 + d[p + 1] * 587 + d[p + 2] * 114) / 1000;
    }
    return g;
  }

  // Separable box blur (running sum), edge-clamped. `src` is a single channel.
  function boxBlur(src, w, h, r, passes = 1) {
    let a = Float32Array.from(src);
    let b = new Float32Array(a.length);
    const win = 2 * r + 1;
    for (let k = 0; k < passes; k++) {
      for (let y = 0; y < h; y++) {
        const row = y * w;
        let sum = 0;
        for (let i = -r; i <= r; i++) sum += a[row + clamp(i, 0, w - 1)];
        for (let x = 0; x < w; x++) {
          b[row + x] = sum / win;
          sum += a[row + Math.min(w - 1, x + r + 1)] - a[row + Math.max(0, x - r)];
        }
      }
      for (let x = 0; x < w; x++) {
        let sum = 0;
        for (let i = -r; i <= r; i++) sum += b[clamp(i, 0, h - 1) * w + x];
        for (let y = 0; y < h; y++) {
          a[y * w + x] = sum / win;
          sum += b[Math.min(h - 1, y + r + 1) * w + x] - b[Math.max(0, y - r) * w + x];
        }
      }
    }
    return a;
  }

  // --- colormap LUTs (match OpenCV's JET / SUMMER / HSV closely) ---
  const JET = new Uint8Array(256 * 3);
  const SUMMER = new Uint8Array(256 * 3);
  const HSV = new Uint8Array(256 * 3);
  (function buildLuts() {
    for (let i = 0; i < 256; i++) {
      const v = i / 255;
      JET[i * 3] = clamp((1.5 - Math.abs(4 * v - 3)) * 255);
      JET[i * 3 + 1] = clamp((1.5 - Math.abs(4 * v - 2)) * 255);
      JET[i * 3 + 2] = clamp((1.5 - Math.abs(4 * v - 1)) * 255);
      SUMMER[i * 3] = i;
      SUMMER[i * 3 + 1] = 128 + i / 2;
      SUMMER[i * 3 + 2] = 102;
      // hue sweep 0..360, full saturation/value
      const hh = v * 6;
      const f = hh - Math.floor(hh);
      const q = 255 * (1 - f), t = 255 * f;
      const seg = Math.floor(hh) % 6;
      const rgb = [[255, t, 0], [q, 255, 0], [0, 255, t], [0, q, 255], [t, 0, 255], [255, 0, q]][seg];
      HSV.set(rgb, i * 3);
    }
  })();

  const Filters = {
    "dual-tone"(img) {
      const d = img.data, g = gray(d);
      for (let i = 0, p = 0; i < g.length; i++, p += 4) {
        if (g[i] > 110) { d[p] = 255; d[p + 1] = 140; d[p + 2] = 10; }
        else { d[p] = 220; d[p + 1] = 30; d[p + 2] = 180; }
        d[p + 3] = 255;
      }
      return img;
    },

    thermal(img) {
      const d = img.data, g = gray(d);
      for (let i = 0, p = 0; i < g.length; i++, p += 4) {
        const k = g[i] * 3;
        d[p] = JET[k]; d[p + 1] = JET[k + 1]; d[p + 2] = JET[k + 2]; d[p + 3] = 255;
      }
      return img;
    },

    sketch(img) {
      const d = img.data, w = img.width, h = img.height, g = gray(d);
      const inv = new Float32Array(g.length);
      for (let i = 0; i < g.length; i++) inv[i] = 255 - g[i];
      const blur = boxBlur(inv, w, h, 5, 2);
      for (let i = 0, p = 0; i < g.length; i++, p += 4) {
        const den = 255 - blur[i];
        const v = den <= 0 ? 255 : clamp((g[i] * 256) / den);
        d[p] = d[p + 1] = d[p + 2] = v; d[p + 3] = 255;
      }
      return img;
    },

    pixelate(img, block = 14) {
      const d = img.data, w = img.width, h = img.height;
      if (w < 2 || h < 2) return img;
      for (let by = 0; by < h; by += block) {
        for (let bx = 0; bx < w; bx += block) {
          const ex = Math.min(w, bx + block), ey = Math.min(h, by + block);
          let r = 0, g = 0, b = 0, n = 0;
          for (let y = by; y < ey; y++) for (let x = bx; x < ex; x++) {
            const p = (y * w + x) * 4; r += d[p]; g += d[p + 1]; b += d[p + 2]; n++;
          }
          r /= n; g /= n; b /= n;
          for (let y = by; y < ey; y++) for (let x = bx; x < ex; x++) {
            const p = (y * w + x) * 4; d[p] = r; d[p + 1] = g; d[p + 2] = b;
          }
        }
      }
      return img;
    },

    glitch(img) {
      const d = img.data, w = img.width, h = img.height;
      if (w < 2 || h < 2) return img;
      const src = new Uint8ClampedArray(d);
      const shift = 4 + Math.floor(Math.random() * 9);
      for (let y = 0; y < h; y++) {
        const row = y * w;
        for (let x = 0; x < w; x++) {
          const p = (row + x) * 4;
          d[p] = src[(row + ((x - shift + w) % w)) * 4];          // red rolled right
          d[p + 2] = src[(row + ((x + shift) % w)) * 4 + 2];      // blue rolled left
        }
      }
      for (let k = 0; k < 2; k++) {
        const y = Math.floor(Math.random() * h);
        for (let x = 0; x < w; x++) {
          const p = (y * w + x) * 4;
          d[p] = Math.random() * 255; d[p + 1] = Math.random() * 255; d[p + 2] = Math.random() * 255;
        }
      }
      return img;
    },

    invert(img) {
      const d = img.data;
      for (let p = 0; p < d.length; p += 4) { d[p] = 255 - d[p]; d[p + 1] = 255 - d[p + 1]; d[p + 2] = 255 - d[p + 2]; }
      return img;
    },

    "red-channel"(img) {
      const d = img.data;
      for (let p = 0; p < d.length; p += 4) { d[p + 1] = 0; d[p + 2] = 0; }
      return img;
    },

    edge(img) {
      const d = img.data, w = img.width, h = img.height;
      const g = boxBlur(gray(d), w, h, 1, 1);
      const out = new Uint8ClampedArray(d.length);
      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          const i = y * w + x;
          const gx = -g[i - w - 1] + g[i - w + 1] - 2 * g[i - 1] + 2 * g[i + 1] - g[i + w - 1] + g[i + w + 1];
          const gy = -g[i - w - 1] - 2 * g[i - w] - g[i - w + 1] + g[i + w - 1] + 2 * g[i + w] + g[i + w + 1];
          if (Math.abs(gx) + Math.abs(gy) > 150) {
            const p = i * 4;
            out[p] = SUMMER[255 * 3]; out[p + 1] = SUMMER[255 * 3 + 1]; out[p + 2] = SUMMER[255 * 3 + 2];
          }
        }
      }
      for (let p = 3; p < out.length; p += 4) out[p] = 255;
      d.set(out);
      return img;
    },

    blur(img) {
      const d = img.data, w = img.width, h = img.height, n = w * h;
      for (let c = 0; c < 3; c++) {
        const ch = new Float32Array(n);
        for (let i = 0; i < n; i++) ch[i] = d[i * 4 + c];
        const b = boxBlur(ch, w, h, 6, 3);
        for (let i = 0; i < n; i++) d[i * 4 + c] = b[i];
      }
      return img;
    },

    cartoon(img) {
      const d = img.data, w = img.width, h = img.height, n = w * h;
      const g = gray(d);
      const local = boxBlur(g, w, h, 4, 1); // 9x9 mean, like adaptiveThreshold(MEAN_C, 9, 9)
      const smooth = [];
      for (let c = 0; c < 3; c++) {
        const ch = new Float32Array(n);
        for (let i = 0; i < n; i++) ch[i] = d[i * 4 + c];
        smooth.push(boxBlur(ch, w, h, 2, 2));
      }
      const step = 255 / 7;
      for (let i = 0, p = 0; i < n; i++, p += 4) {
        const isLine = g[i] <= local[i] - 9;
        for (let c = 0; c < 3; c++) {
          d[p + c] = isLine ? 0 : Math.round(smooth[c][i] / step) * step;
        }
        d[p + 3] = 255;
      }
      return img;
    },

    "rainbow-wave"(img) {
      const d = img.data, w = img.width, h = img.height;
      const t = performance.now() / 1000 * 5.0;
      for (let y = 0, p = 0; y < h; y++) {
        for (let x = 0; x < w; x++, p += 4) {
          const v = Math.floor(Math.sin((x + y) * 0.05 + t) * 127 + 128) * 3;
          d[p] = d[p] * 0.3 + HSV[v] * 0.7;
          d[p + 1] = d[p + 1] * 0.3 + HSV[v + 1] * 0.7;
          d[p + 2] = d[p + 2] * 0.3 + HSV[v + 2] * 0.7;
        }
      }
      return img;
    },
  };

  global.RetroFilters = Filters;
})(typeof window !== "undefined" ? window : globalThis);
