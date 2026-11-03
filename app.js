/* Pea Booth: one photo, one hidden message, one butterfly pea postcard. */
(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];

  const state = {
    tone: 'cyano',
    source: null,      // <video> or <img> we read pixels from
    stream: null,
    mirror: true,
    print: null,       // canvas: the brushed cyanotype print (transparent margins)
    no: String(Math.floor(Math.random() * 9000) + 1000),
    files: {},         // rendered postcard canvases
  };

  /* ───────────── tones ───────────── */
  // shadows stay butterfly-pea blue (neutral pH); highlights go pale pink, as if touched by acid
  const TONES = {
    cyano: { name: 'cyanotype', stops: [[0, '#0b1d55'], [0.32, '#1b3f96'], [0.55, '#5866b6'], [0.76, '#c7a9d4'], [0.9, '#f1d3df'], [1, '#fcf2f3']] },
    pea:   { name: 'pea blue',  stops: [[0, '#1c0f50'], [0.3, '#3b2a8c'], [0.55, '#7a5fb8'], [0.78, '#dcb5d6'], [0.92, '#f5dce5'], [1, '#fdf2f4']] },
    bloom: { name: 'acid bloom', stops: [[0, '#2e0d4a'], [0.3, '#76206e'], [0.55, '#c04a93'], [0.8, '#efbcd3'], [1, '#fff4f5']] },
  };
  const hex = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
  const LUTS = {};
  for (const [k, t] of Object.entries(TONES)) {
    const lut = new Uint8ClampedArray(256 * 3);
    for (let i = 0; i < 256; i++) {
      const v = i / 255;
      let j = 0;
      while (j < t.stops.length - 2 && v > t.stops[j + 1][0]) j++;
      const [a, ca] = t.stops[j], [b, cb] = t.stops[j + 1];
      const f = Math.min(1, Math.max(0, (v - a) / (b - a)));
      const A = hex(ca), B = hex(cb);
      for (let c = 0; c < 3; c++) lut[i * 3 + c] = A[c] + (B[c] - A[c]) * f;
    }
    LUTS[k] = lut;
  }
  const toneColor = (tone, v) => { const l = LUTS[tone], i = Math.round(v * 255) * 3; return `rgb(${l[i]},${l[i + 1]},${l[i + 2]})`; };

  /* ───────────── canvas helpers ───────────── */
  const mk = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
  const rand = (a, b) => a + Math.random() * (b - a);

  // soft low-frequency blotches, like uneven brushed chemistry
  function blotField(w, h, sw = 9, sh = 11) {
    const small = mk(sw, sh), sc = small.getContext('2d');
    const id = sc.createImageData(sw, sh);
    for (let i = 0; i < sw * sh; i++) { const v = Math.random() * 255; id.data.set([v, v, v, 255], i * 4); }
    sc.putImageData(id, 0, 0);
    const big = mk(w, h), bc = big.getContext('2d', { willReadFrequently: true });
    bc.imageSmoothingQuality = 'high';
    bc.drawImage(small, 0, 0, w, h);
    const d = bc.getImageData(0, 0, w, h).data, out = new Float32Array(w * h);
    for (let i = 0; i < out.length; i++) out[i] = d[i * 4] / 255 - 0.5;
    return out;
  }

  function drawCover(ctx, src, w, h, mirror) {
    const sw = src.videoWidth || src.naturalWidth, sh = src.videoHeight || src.naturalHeight;
    if (!sw || !sh) return false;
    const s = Math.max(w / sw, h / sh), dw = sw * s, dh = sh * s;
    ctx.save();
    if (mirror) { ctx.translate(w, 0); ctx.scale(-1, 1); }
    ctx.drawImage(src, (w - dw) / 2, (h - dh) / 2, dw, dh);
    ctx.restore();
    return true;
  }

  // running-sum box blur, horizontal then vertical; three in a row ≈ a gaussian
  function boxBlur(a, w, h, r, t = new Float32Array(a.length), o = new Float32Array(a.length)) {
    const k = 1 / (r * 2 + 1);
    for (let y = 0; y < h; y++) {
      const row = y * w; let s = 0;
      for (let x = -r; x <= r; x++) s += a[row + Math.min(w - 1, Math.max(0, x))];
      for (let x = 0; x < w; x++) {
        t[row + x] = s * k;
        s += a[row + Math.min(w - 1, x + r + 1)] - a[row + Math.max(0, x - r)];
      }
    }
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let y = -r; y <= r; y++) s += t[Math.min(h - 1, Math.max(0, y)) * w + x];
      for (let y = 0; y < h; y++) {
        o[y * w + x] = s * k;
        s += t[Math.min(h - 1, y + r + 1) * w + x] - t[Math.max(0, y - r) * w + x];
      }
    }
    return o;
  }
  const gauss = (a, w, h, r) => boxBlur(boxBlur(boxBlur(a, w, h, r), w, h, r), w, h, r);

  // live beauty pass: blur luminance, then blend it back only where the change is small
  // (skin texture) and not across edges (eyes, lips, hair line). Tuning knobs:
  const BEAUTY = {
    strength: 0.8,  // 0 = off, 1 = full blur on skin
    radius: 4,      // blur radius in live-canvas pixels (480 × 600)
    edge: 0.06,     // luminance step that counts as an edge; smaller keeps more detail
    offSkin: 0.35,  // how much of the smoothing also reaches non-skin areas
  };
  const bufs = {};
  const buf = (k, n) => (bufs[k]?.length === n ? bufs[k] : (bufs[k] = new Float32Array(n)));

  function tonePixels(ctx, w, h, tone, blot, grain = 0.06, smooth = 0) {
    const img = ctx.getImageData(0, 0, w, h), d = img.data, lut = LUTS[tone], n = w * h;
    const L = buf('L', n), S = buf('S', n);
    for (let p = 0, i = 0; p < n; p++, i += 4) {
      const r = d[i], g = d[i + 1], b = d[i + 2];
      L[p] = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
      S[p] = r > 95 && g > 40 && b > 20 && r > g && r > b && r - g > 15 ? 1 : BEAUTY.offSkin;
    }
    if (smooth > 0) {
      const t = buf('t', n);
      const blur = boxBlur(boxBlur(L, w, h, BEAUTY.radius, t, buf('a', n)), w, h, BEAUTY.radius, t, buf('b', n));
      const skin = boxBlur(S, w, h, 6, t, buf('c', n));
      const k = 1 / (2 * BEAUTY.edge * BEAUTY.edge);
      for (let p = 0; p < n; p++) {
        const diff = blur[p] - L[p];
        L[p] += diff * smooth * skin[p] * Math.exp(-diff * diff * k);
      }
    }
    for (let p = 0, i = 0; i < d.length; i += 4, p++) {
      let g = L[p];
      g = (g - 0.5) * 1.35 + 0.56 + blot[p] * 0.2 + (Math.random() - 0.5) * grain;
      const k = (g <= 0 ? 0 : g >= 1 ? 255 : (g * 255) | 0) * 3;
      d[i] = lut[k]; d[i + 1] = lut[k + 1]; d[i + 2] = lut[k + 2];
    }
    ctx.putImageData(img, 0, 0);
  }

  /* ───────────── stencil: a clean two-tone print you could laser-cut ───────────── */
  // dark (blue / black) is the stencil sheet, held together by the frame; light (pink / white) is
  // cut away, and that is where the acid goes on, so it blooms pink in the tea
  const STENCIL = {
    work: 720,        // working width; all sizes below are in these pixels
    blur: 1,          // pre-threshold blur (3 box passes); bigger = rounder, simpler shapes
    detail: 2.4,      // local contrast boost; higher pulls eyes, brows, lips out of the skin
    local: 13,        // neighborhood radius for that boost (≈ the size of an eye socket)
    fine: 2.2,        // second, fine-scale boost for eye detail: lids, iris, catchlight
    fineR: 3,         // neighborhood radius for the fine boost (≈ an iris)
    bias: -0.05,      // added to the auto (Otsu) threshold, -0.15…0.15; + = more blue
    majority: 1,      // radius of the majority filter that cleans ragged edges
    cleanPasses: 1,   // how many times it runs; more = smoother but loses thin lid lines
    minArea: 0.00013, // holes smaller than this share of the image are filled in (≈ 0.7 mm; keeps eye whites)
    minPiece: 0.0003, // loose dark bits smaller than this are dropped; bigger ones get a bridge
    bridgeMm: 0.8,    // bridge width that ties loose pieces back to the sheet
    alongAxis: 4,     // how strongly bridges leave elongated shapes (lips, eyes) along their length
    skinCost: 12,     // extra cost for bridging across lit skin, so bridges keep to hair and shadow
    photoMm: 64,      // printed width of the photo on the 6 × 4 in card, to convert mm → px
    edge: 1,          // contour smoothing when scaling up, in working pixels
  };

  // threshold that best splits the histogram into two groups
  function otsu(hist, total) {
    let sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i];
    let sumB = 0, wB = 0, best = 0, t = 128;
    for (let i = 0; i < 256; i++) {
      wB += hist[i]; if (!wB) continue;
      const wF = total - wB; if (!wF) break;
      sumB += i * hist[i];
      const mB = sumB / wB, mF = (sum - sumB) / wF, v = wB * wF * (mB - mF) ** 2;
      if (v > best) { best = v; t = i; }
    }
    return t / 255;
  }

  // flip every 4-connected region of `val` smaller than `min` pixels
  function dropIslands(m, w, h, val, min) {
    const seen = new Uint8Array(m.length), stack = new Int32Array(m.length), region = [];
    for (let s = 0; s < m.length; s++) {
      if (seen[s] || m[s] !== val) continue;
      let top = 0; stack[top++] = s; seen[s] = 1; region.length = 0;
      while (top) {
        const p = stack[--top], x = p % w; region.push(p);
        for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, p - w, p + w]) {
          if (q >= 0 && q < m.length && !seen[q] && m[q] === val) { seen[q] = 1; stack[top++] = q; }
        }
      }
      if (region.length < min) for (const p of region) m[p] = 1 - val;
    }
  }

  // keep the stencil in one piece. The dark material is held together by the frame round the photo;
  // every dark island floating in a light area (pupils, nostrils, lips) is tied to it by a bridge.
  // Each island gets its own cheapest-path search (Dijkstra) to dark that is already held:
  //  - light pixels cost more the lighter they are, and lit skin costs extra, so bridges keep to
  //    shadows and hair instead of crossing cheeks or chin;
  //  - leaving across an elongated island's long axis costs extra, so lips continue out of the
  //    mouth corners and eyes out of their corners, rather than hanging down like a moustache.
  function bridgeIslands(m, w, h, tone, t, skin, bw) {
    const n = m.length, comp = new Int32Array(n).fill(-1), stack = new Int32Array(n), held = [], isles = [];
    for (let s = 0; s < n; s++) {
      if (!m[s] || comp[s] >= 0) continue;
      const id = held.length, px = []; let top = 0, edge = false;
      stack[top++] = s; comp[s] = id;
      while (top) {
        const p = stack[--top], x = p % w, y = (p / w) | 0; px.push(p);
        if (!x || !y || x === w - 1 || y === h - 1) edge = true;
        for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, p - w, p + w]) if (q >= 0 && q < n && m[q] && comp[q] < 0) { comp[q] = id; stack[top++] = q; }
      }
      held.push(edge ? 1 : 0);
      if (!edge) isles.push({ id, px });
    }
    if (!isles.length) return;
    // binary heap of (cost, pixel)
    let hk = new Float32Array(1 << 16), hv = new Int32Array(1 << 16), hn = 0;
    const push = (k, v) => {
      if (hn === hk.length) { const a = new Float32Array(hn * 2), b = new Int32Array(hn * 2); a.set(hk); b.set(hv); hk = a; hv = b; }
      let i = hn++;
      while (i) { const pa = (i - 1) >> 1; if (hk[pa] <= k) break; hk[i] = hk[pa]; hv[i] = hv[pa]; i = pa; }
      hk[i] = k; hv[i] = v;
    };
    const pop = () => {
      const v = hv[0], k = hk[--hn], last = hv[hn]; let i = 0;
      for (;;) { let c = i * 2 + 1; if (c >= hn) break; if (c + 1 < hn && hk[c + 1] < hk[c]) c++; if (hk[c] >= k) break; hk[i] = hk[c]; hv[i] = hv[c]; i = c; }
      hk[i] = k; hv[i] = last; return v;
    };
    const dist = new Float32Array(n), from = new Int32Array(n), gen = new Int32Array(n);
    const paths = [];
    isles.sort((a, b) => b.px.length - a.px.length);
    isles.forEach((isle, g) => {
      if (held[isle.id]) return;
      g += 1;
      // shape of the island: centre and long axis (principal component)
      let cx = 0, cy = 0, sxx = 0, syy = 0, sxy = 0;
      for (const p of isle.px) { cx += p % w; cy += (p / w) | 0; }
      cx /= isle.px.length; cy /= isle.px.length;
      for (const p of isle.px) { const dx = p % w - cx, dy = ((p / w) | 0) - cy; sxx += dx * dx; syy += dy * dy; sxy += dx * dy; }
      const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy), ax = Math.cos(ang), ay = Math.sin(ang);
      const tr = sxx + syy, det = sxx * syy - sxy * sxy, l1 = tr / 2 + Math.sqrt(Math.max(0, tr * tr / 4 - det)), l2 = tr - l1;
      const aniso = STENCIL.alongAxis * Math.min(1, Math.max(0, (Math.sqrt(l1 / Math.max(l2, 1e-6)) - 1.2) / 1.5));
      hn = 0;
      for (const p of isle.px) { gen[p] = g; dist[p] = 0; from[p] = -1; push(0, p); }
      let end = -1;
      while (hn) {
        const p = pop(), dp = dist[p];
        if (m[p] && comp[p] >= 0 && held[comp[p]]) { end = p; break; }
        const x = p % w, y = (p / w) | 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          if ((!dx && !dy) || x + dx < 0 || x + dx >= w || y + dy < 0 || y + dy >= h) continue;
          const q = p + dy * w + dx, len = dx && dy ? 1.414 : 1;
          let c = 0;
          if (!m[q]) {
            const u = Math.max(0, tone[q] - t) / (1 - t);
            const vx = x + dx - cx, vy = y + dy - cy, r = Math.hypot(vx, vy) || 1;
            const across = Math.abs(vx * ay - vy * ax) / r;   // 0 = along the long axis, 1 = straight across
            c = len * (0.15 + 10 * u * u + STENCIL.skinCost * skin[q] * u) * (1 + aniso * across);
          }
          const nd = dp + c;
          if (gen[q] !== g || nd < dist[q]) { gen[q] = g; dist[q] = nd; from[q] = p; push(nd, q); }
        }
      }
      if (end < 0) return;
      const path = [];
      for (let k = end; k >= 0; k = from[k]) {
        if (!m[k]) path.push(k);
        else if (comp[k] >= 0) held[comp[k]] = 1;   // islands the path ran through are held now too
      }
      held[isle.id] = 1;
      paths.push(path);
    });
    // draw each bridge as a smoothed curve of disks
    const r = Math.max(1, bw / 2), R = Math.ceil(r);
    for (const path of paths) {
      let pts = path.map(p => [p % w, (p / w) | 0]);
      for (let k = 0; k < 3; k++) pts = pts.map((pt, i) => {
        if (!i || i === pts.length - 1) return pt;
        const a = pts[Math.max(0, i - 2)], b = pts[i - 1], c = pts[i + 1], d = pts[Math.min(pts.length - 1, i + 2)];
        return [(a[0] + b[0] + pt[0] + c[0] + d[0]) / 5, (a[1] + b[1] + pt[1] + c[1] + d[1]) / 5];
      });
      for (const [cx, cy] of pts) for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
        const x = Math.round(cx + dx), y = Math.round(cy + dy);
        if (x >= 0 && y >= 0 && x < w && y < h && (x - cx) ** 2 + (y - cy) ** 2 <= r * r) m[y * w + x] = 1;
      }
    }
  }

  // photo canvas → binary mask (1 = dark / blue / cut), at working resolution
  function stencilMask(photo) {
    const w = STENCIL.work, h = Math.round(w * photo.height / photo.width), n = w * h;
    const c = mk(w, h), cx = c.getContext('2d', { willReadFrequently: true });
    cx.imageSmoothingQuality = 'high'; cx.drawImage(photo, 0, 0, w, h);
    const d = cx.getImageData(0, 0, w, h).data, L = new Float32Array(n), S = new Float32Array(n);
    for (let p = 0, i = 0; p < n; p++, i += 4) {
      const r = d[i], g = d[i + 1], b = d[i + 2];
      L[p] = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
      S[p] = r > 95 && g > 40 && b > 20 && r > g && r > b && r - g > 15 ? 1 : 0;
    }
    // stretch contrast between the 1st and 99th percentile, then blur
    const raw = new Uint32Array(256); for (let p = 0; p < n; p++) raw[(L[p] * 255) | 0]++;
    let lo = 0, hi = 255, acc = 0;
    while (lo < 255 && (acc += raw[lo]) < n * 0.01) lo++;
    acc = 0; while (hi > 0 && (acc += raw[hi]) < n * 0.01) hi--;
    const span = Math.max(1, hi - lo) / 255, base = lo / 255;
    for (let p = 0; p < n; p++) L[p] = Math.min(1, Math.max(0, (L[p] - base) / span));
    const B = gauss(L, w, h, STENCIL.blur), M = gauss(B, w, h, STENCIL.local), F = gauss(B, w, h, STENCIL.fineR), hist = new Uint32Array(256);
    // local contrast: push each pixel away from its neighborhood so features survive the threshold.
    // Two scales: eye sockets, brows and lips, then the fine pass for lids, irises and catchlights.
    for (let p = 0; p < n; p++) B[p] = Math.min(1, Math.max(0, B[p] + (B[p] - M[p]) * STENCIL.detail + (B[p] - F[p]) * STENCIL.fine));
    for (let p = 0; p < n; p++) hist[Math.min(255, (B[p] * 255) | 0)]++;
    const t = otsu(hist, n) + STENCIL.bias;
    let m = new Uint8Array(n);
    for (let p = 0; p < n; p++) m[p] = B[p] < t ? 1 : 0;
    // a dark frame round the edge: the stencil's border, which holds every piece that reaches it
    for (let x = 0; x < w; x++) for (let k = 0; k < 3; k++) m[k * w + x] = m[(h - 1 - k) * w + x] = 1;
    for (let y = 0; y < h; y++) for (let k = 0; k < 3; k++) m[y * w + k] = m[y * w + w - 1 - k] = 1;
    // majority filter: smooths ragged contours and kills specks
    for (let k = 0; k < STENCIL.cleanPasses; k++) {
      const f = boxBlur(Float32Array.from(m), w, h, STENCIL.majority);
      for (let p = 0; p < n; p++) m[p] = f[p] > 0.5 ? 1 : 0;
    }
    dropIslands(m, w, h, 0, Math.round(n * STENCIL.minArea));
    dropIslands(m, w, h, 1, Math.round(n * STENCIL.minPiece));
    bridgeIslands(m, w, h, B, t, gauss(S, w, h, 2), STENCIL.bridgeMm * w / STENCIL.photoMm);
    return { m, w, h };
  }

  // mask → W × H canvas in two colours. Scaled up smoothly, blurred and re-thresholded so
  // the contours are round curves rather than stair steps. aa = soft edge (screen) or hard (cutter).
  function renderStencil({ m, w, h }, W, H, dark, light, aa) {
    const small = mk(w, h), sc = small.getContext('2d'), id = sc.createImageData(w, h);
    for (let p = 0; p < m.length; p++) { const v = m[p] ? 0 : 255; id.data[p * 4] = id.data[p * 4 + 1] = id.data[p * 4 + 2] = v; id.data[p * 4 + 3] = 255; }
    sc.putImageData(id, 0, 0);
    const out = mk(W, H), oc = out.getContext('2d', { willReadFrequently: true });
    oc.imageSmoothingQuality = 'high'; oc.drawImage(small, 0, 0, W, H);
    const img = oc.getImageData(0, 0, W, H), d = img.data, f = new Float32Array(W * H);
    for (let p = 0; p < f.length; p++) f[p] = d[p * 4] / 255;
    const F = gauss(f, W, H, Math.max(1, Math.round(STENCIL.edge * W / w)));
    const e = aa ? 0.08 : 0;
    if (!aa) {   // hard edge for the cutter: clear the odd pixel speck the scaling leaves behind
      const bin = new Uint8Array(F.length);
      for (let p = 0; p < F.length; p++) bin[p] = F[p] >= 0.5 ? 0 : 1;
      dropIslands(bin, W, H, 0, 64); dropIslands(bin, W, H, 1, 64);
      for (let p = 0; p < F.length; p++) F[p] = 1 - bin[p];
    }
    for (let p = 0, i = 0; p < F.length; p++, i += 4) {
      const a = aa ? Math.min(1, Math.max(0, (F[p] - 0.5 + e) / (2 * e))) : F[p] >= 0.5 ? 1 : 0;   // 1 = light
      for (let c = 0; c < 4; c++) d[i + c] = (dark[c] ?? 255) + ((light[c] ?? 255) - (dark[c] ?? 255)) * a;
    }
    oc.putImageData(img, 0, 0);
    return out;
  }
  const lutAt = (tone, v) => { const l = LUTS[tone], i = Math.round(v * 255) * 3; return [l[i], l[i + 1], l[i + 2]]; };

  // an uneven, hand-brushed rectangle with streaks off its edges
  function brushMask(w, h, inset, amp, streaks) {
    const sc = 1 / 3, mw = Math.round(w * sc), mh = Math.round(h * sc);
    const m = mk(mw, mh), c = m.getContext('2d');
    c.scale(sc, sc);
    c.fillStyle = c.strokeStyle = '#000';
    const x0 = inset, y0 = inset, x1 = w - inset, y1 = h - inset;
    const ph = [rand(0, 9), rand(0, 9), rand(0, 9)];
    const n = t => amp * (Math.sin(t * 0.021 + ph[0]) * 0.55 + Math.sin(t * 0.063 + ph[1]) * 0.3 + Math.sin(t * 0.17 + ph[2]) * 0.15 + rand(-0.25, 0.25));
    const pts = [];
    const step = 10;
    for (let x = x0; x <= x1; x += step) pts.push([x, y0 + n(x)]);
    for (let y = y0; y <= y1; y += step) pts.push([x1 + n(y + 900), y]);
    for (let x = x1; x >= x0; x -= step) pts.push([x, y1 + n(x + 1900)]);
    for (let y = y1; y >= y0; y -= step) pts.push([x0 + n(y + 2900), y]);
    c.beginPath(); pts.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y))); c.closePath(); c.fill();
    if (streaks) {
      c.lineCap = 'round';
      const brush = (ax, ay, bx, by) => { c.globalAlpha = rand(0.25, 0.9); c.lineWidth = rand(2, 9); c.beginPath(); c.moveTo(ax, ay); c.lineTo(bx, by); c.stroke(); };
      for (let i = 0; i < 46; i++) { const y = rand(y0, y1); brush(x0 - rand(0, inset * 0.9), y + rand(-3, 3), x0 + 30, y); }
      for (let i = 0; i < 46; i++) { const y = rand(y0, y1); brush(x1 + rand(0, inset * 0.9), y + rand(-3, 3), x1 - 30, y); }
      for (let i = 0; i < 18; i++) { const x = rand(x0, x1); brush(x, y0 - rand(0, inset * 0.6), x, y0 + 20); }
      for (let i = 0; i < 18; i++) { const x = rand(x0, x1); brush(x, y1 + rand(0, inset * 0.6), x, y1 - 20); }
      c.globalAlpha = 1;
    }
    const out = mk(w, h), oc = out.getContext('2d');
    oc.imageSmoothingQuality = 'high';
    oc.drawImage(m, 0, 0, w, h);
    return out;
  }

  // turn a toned photo into a brushed print with a deep-blue chemistry border
  function makePrint(photo, tone, rough = 1, margin = 0.085) {
    const pw = photo.width, ph = photo.height, mg = Math.round(pw * margin);
    const W = pw + mg * 2, H = ph + mg * 2;
    const out = mk(W, H), o = out.getContext('2d');

    o.drawImage(brushMask(W, H, mg * 0.35, mg * 0.12 * rough, true), 0, 0);
    o.globalCompositeOperation = 'source-in';
    o.fillStyle = toneColor(tone, 0.1);
    o.fillRect(0, 0, W, H);
    // a little mottling in the border
    o.globalCompositeOperation = 'source-atop';
    for (let i = 0; i < 40; i++) {
      o.globalAlpha = rand(0.04, 0.12);
      o.fillStyle = toneColor(tone, rand(0.25, 0.6));
      o.beginPath(); o.ellipse(rand(0, W), rand(0, H), rand(20, 120), rand(10, 60), rand(0, 3), 0, 7); o.fill();
    }
    o.globalAlpha = 1;

    const p = mk(W, H), pc = p.getContext('2d');
    pc.drawImage(photo, mg, mg);
    pc.globalCompositeOperation = 'destination-in';
    pc.drawImage(brushMask(W, H, mg * 1.05, mg * 0.16 * rough, false), 0, 0);
    o.globalCompositeOperation = 'source-over';
    o.drawImage(p, 0, 0);
    return out;
  }

  /* ───────────── scenes ───────────── */
  const wipe = $('#wipe');
  // tile the velvet as photo + mirror so the repeat has no visible seam
  (() => {
    const tex = new Image();
    tex.onload = () => {
      const c = mk(tex.width * 2, tex.height), x = c.getContext('2d');
      x.drawImage(tex, 0, 0);
      x.translate(tex.width * 2, 0); x.scale(-1, 1); x.drawImage(tex, 0, 0);
      document.documentElement.style.setProperty('--curtain-tex', `url(${c.toDataURL('image/jpeg', 0.9)})`);
    };
    tex.src = 'img/curtain.jpg';
    // the booth's painted metal, mirrored 2 × 2 so it tiles without seams
    const metal = new Image();
    metal.onload = () => {
      const w = metal.width, h = metal.height, c = mk(w * 2, h * 2), x = c.getContext('2d');
      for (const [sx, sy] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
        x.save(); x.translate(sx < 0 ? w * 2 : 0, sy < 0 ? h * 2 : 0); x.scale(sx, sy); x.drawImage(metal, 0, 0); x.restore();
      }
      document.documentElement.style.setProperty('--metal', `url(${c.toDataURL('image/jpeg', 0.9)})`);
    };
    metal.src = 'img/panel-metal.jpg';
    // the postcard's paper surface: a photo of woven paper, turned to neutral grey so it can be
    // blended over the card. Mid grey changes nothing; darker and lighter carry the grain.
    const weave = new Image();
    weave.onload = () => {
      const sx = 22, sy = 40, sw = 692, sh = 461;   // the top panel, clear of the frame and the seam
      const c = mk(sw, sh), x = c.getContext('2d', { willReadFrequently: true });
      x.drawImage(weave, sx, sy, sw, sh, 0, 0, sw, sh);
      const img = x.getImageData(0, 0, sw, sh), d = img.data;
      let mean = 0;
      for (let i = 0; i < d.length; i += 4) mean += 0.3 * d[i] + 0.59 * d[i + 1] + 0.11 * d[i + 2];
      mean /= sw * sh;
      for (let i = 0; i < d.length; i += 4) d[i] = d[i + 1] = d[i + 2] = 128 + (0.3 * d[i] + 0.59 * d[i + 1] + 0.11 * d[i + 2] - mean) * 1.4;
      x.putImageData(img, 0, 0);
      document.documentElement.style.setProperty('--paper-weave', `url(${c.toDataURL('image/jpeg', 0.92)})`);
    };
    weave.src = 'img/tex/paper-weave.webp';
  })();
  function show(id) {
    $$('.scene').forEach(s => s.classList.toggle('active', s.id === id));
    document.body.dataset.scene = id;
    window.scrollTo(0, 0);
    if (id === 'inside') startCamera(); else stopCamera();
  }
  function curtainTo(id) {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return show(id);
    wipe.classList.add('closed');
    setTimeout(() => { show(id); requestAnimationFrame(() => setTimeout(() => wipe.classList.remove('closed'), 350)); }, 950);
  }
  $$('[data-go]').forEach(el => el.addEventListener('click', e => { e.preventDefault(); curtainTo(el.dataset.go); }));
  $('#enterBtn').addEventListener('click', () => curtainTo('inside'));

  /* ───────────── camera ───────────── */
  const live = $('#live'), lctx = live.getContext('2d', { willReadFrequently: true });
  const liveBlot = blotField(live.width, live.height);
  const screenMsg = $('#screenMsg'), snapBtn = $('#snapBtn'), led = $('#led');
  let raf = 0;

  function setMsg(html) { screenMsg.innerHTML = html; screenMsg.classList.toggle('hide', !html); }

  async function startCamera() {
    if (state.source && state.source.tagName === 'IMG') { loop(); return; }
    if (state.stream) { loop(); return; }
    if (!navigator.mediaDevices?.getUserMedia) {
      setMsg('<p class="hand big">this browser can\'t reach a camera</p><p class="small">open the booth on localhost or https, or use a photo instead ↓</p>');
      return;
    }
    setMsg('<p class="hand big">waking the camera…</p><p class="small">allow camera access when your browser asks</p>');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 960 }, facingMode: 'user' }, audio: false });
      if (!$('#inside').classList.contains('active')) { stream.getTracks().forEach(t => t.stop()); return; }
      const v = document.createElement('video');
      v.muted = true; v.playsInline = true; v.srcObject = stream;
      await v.play();
      state.stream = stream; state.source = v; state.mirror = true;
      setMsg('');
      snapBtn.disabled = false; led.classList.add('on');
      loop();
    } catch (err) {
      const denied = err && (err.name === 'NotAllowedError' || err.name === 'SecurityError');
      setMsg(`<p class="hand big">${denied ? 'the camera is shy' : 'no camera found'}</p>
        <p class="small">${denied ? 'camera access was blocked. allow it in your browser settings, or' : 'we couldn\'t find a camera, so'} use a photo instead ↓</p>
        <button class="btn ghost" type="button" id="retryCam">try again</button>`);
      $('#retryCam')?.addEventListener('click', startCamera);
    }
  }
  function stopCamera() {
    cancelAnimationFrame(raf); raf = 0;
    if (state.stream) { state.stream.getTracks().forEach(t => t.stop()); state.stream = null; if (state.source?.tagName === 'VIDEO') state.source = null; }
    led.classList.remove('on');
    if (!state.source) snapBtn.disabled = true;
  }
  function loop() {
    cancelAnimationFrame(raf);
    const tick = () => {
      if (state.source && drawCover(lctx, state.source, live.width, live.height, state.mirror)) {
        tonePixels(lctx, live.width, live.height, state.tone, liveBlot, 0.035, BEAUTY.strength);
      }
      raf = requestAnimationFrame(tick);
    };
    tick();
  }

  $('#uploadInput').addEventListener('change', e => {
    const f = e.target.files?.[0]; if (!f) return;
    const img = new Image();
    img.onload = () => {
      if (state.stream) { state.stream.getTracks().forEach(t => t.stop()); state.stream = null; }
      state.source = img; state.mirror = false;
      setMsg(''); snapBtn.disabled = false; led.classList.add('on'); loop();
    };
    img.src = URL.createObjectURL(f);
  });

  $$('input[name="tone"]').forEach(r => r.addEventListener('change', () => { state.tone = r.value; }));

  /* ───────────── snap ───────────── */
  const count = $('#count'), flash = $('#flash'), tray = $('#tray'), printImg = $('#printImg'), printActions = $('#printActions');
  const wait = ms => new Promise(r => setTimeout(r, ms));
  let busy = false;

  snapBtn.addEventListener('click', async () => {
    if (busy || !state.source) return;
    busy = true; snapBtn.disabled = true;
    resetTray();
    for (const n of [3, 2, 1]) { count.innerHTML = `<span>${n}</span>`; await wait(1000); }
    count.innerHTML = '';
    flash.classList.remove('go'); void flash.offsetWidth; flash.classList.add('go');

    const W = 960, H = 1200, cap = mk(W, H), cc = cap.getContext('2d', { willReadFrequently: true });
    drawCover(cc, state.source, W, H, state.mirror);
    state.mask = stencilMask(cap);
    state.print = makePrint(renderStencil(state.mask, W, H, lutAt(state.tone, 0.12), lutAt(state.tone, 0.9), true), state.tone);
    state.printTone = state.tone;

    await wait(500);
    printImg.src = state.print.toDataURL('image/png');
    await printImg.decode().catch(() => {});
    tray.classList.add('out');
    await wait(2800);
    printActions.classList.add('show');
    busy = false; snapBtn.disabled = false;
  });

  function resetTray() { tray.classList.remove('out'); printActions.classList.remove('show'); }
  $('#retakeBtn').addEventListener('click', () => { resetTray(); state.print = null; });
  $('#toWriteBtn').addEventListener('click', () => { curtainTo('write'); setTimeout(() => $('#toInput').focus({ preventScroll: true }), 1100); });

  /* ───────────── write ───────────── */
  const toI = $('#toInput'), msgI = $('#msgInput'), fromI = $('#fromInput'), back = $('#backPreview');
  const fontOf = () => $('input[name="font"]:checked').value;

  function fitText(card) {
    const box = $('.cb-msg', card);
    card.style.removeProperty('--msg-size');
    let size = parseFloat(getComputedStyle(card).getPropertyValue('--msg-size')) || 4.2;
    let guard = 0;
    while (box.scrollHeight > box.clientHeight + 1 && guard++ < 40) {
      size *= 0.94;
      card.style.setProperty('--msg-size', size + 'cqw');
    }
  }
  function fillBack(card, { msg, to, from, font }) {
    card.classList.remove('f-hand', 'f-type', 'f-serif'); card.classList.add('f-' + font);
    ($('#cbText', card) || $('.t', card)).textContent = msg;
    ($('#cbFrom', card) || $('.f', card)).textContent = from;
    ($('#cbTo', card) || $('.to', card)).textContent = to;
    fitText(card);
  }
  function syncWrite() {
    $('#counter').textContent = `${msgI.value.length} / ${msgI.maxLength}`;
    fillBack(back, { msg: msgI.value || 'your message will sit here, invisible until it is soaked.', to: toI.value, from: fromI.value, font: fontOf() });
  }
  [toI, msgI, fromI].forEach(i => i.addEventListener('input', syncWrite));
  $$('input[name="font"]').forEach(i => i.addEventListener('change', syncWrite));
  new ResizeObserver(() => { fitText(back); fitText($('#backFinal')); }).observe(back);

  function soak(card) {
    card.classList.remove('soaked', 'ink-hidden');
    card.classList.add('ink-hidden');
    clearTimeout(card._soak);
    card._soak = setTimeout(() => card.classList.add('soaked'), 700);
  }
  $$('.ink-toggle .pill').forEach(b => b.addEventListener('click', () => {
    $$('.ink-toggle .pill').forEach(x => x.classList.toggle('on', x === b));
    clearTimeout(back._soak); back.classList.remove('soaked', 'ink-hidden');
    if (b.dataset.ink === 'hidden') back.classList.add('ink-hidden');
    if (b.dataset.ink === 'soak') soak(back);
  }));

  $('#msgForm').addEventListener('submit', async e => {
    e.preventDefault();
    if (!msgI.value.trim()) { msgI.focus(); msgI.placeholder = 'write something first ✶'; return; }
    if (!state.print) { curtainTo('inside'); return; }
    await buildKeepsake();
    curtainTo('keep');
  });

  /* ───────────── postcard rendering (6 × 4 in @ 300 dpi) ───────────── */
  const PW = 1800, PH = 1200;
  const FONTS = { hand: ['', 'Caveat', 1], type: ['', '"Courier Prime"', 0.74], serif: ['italic ', '"Cormorant Garamond"', 0.92] };
  let grainPattern = null;

  function paper(c, plain) {
    c.fillStyle = plain ? '#ffffff' : '#f3efe4';
    c.fillRect(0, 0, PW, PH);
    if (plain) return;
    if (!grainPattern) {
      const g = mk(256, 256), gc = g.getContext('2d'), id = gc.createImageData(256, 256);
      for (let i = 0; i < 256 * 256; i++) { const v = 90 + Math.random() * 60; id.data.set([v, v * 0.95, v * 0.8, Math.random() < 0.5 ? 14 : 0], i * 4); }
      gc.putImageData(id, 0, 0);
      grainPattern = c.createPattern(g, 'repeat');
    }
    c.fillStyle = grainPattern; c.fillRect(0, 0, PW, PH);
  }
  function regMarks(c) {
    c.save(); c.strokeStyle = '#000'; c.globalAlpha = 0.5; c.lineWidth = 2;
    for (const [x, y] of [[30, 30], [PW - 30, 30], [30, PH - 30], [PW - 30, PH - 30]]) {
      c.beginPath(); c.moveTo(x - 14, y); c.lineTo(x + 14, y); c.moveTo(x, y - 14); c.lineTo(x, y + 14); c.stroke();
      c.beginPath(); c.arc(x, y, 7, 0, 7); c.stroke();
    }
    c.restore();
  }
  function wobblyLine(c, x0, y0, x1, y1) {
    c.beginPath(); c.moveTo(x0, y0);
    const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 30);
    for (let i = 1; i <= n; i++) { const t = i / n; c.lineTo(x0 + (x1 - x0) * t + rand(-1.2, 1.2), y0 + (y1 - y0) * t + rand(-1.2, 1.2)); }
    c.stroke();
  }
  const FLOWER = {
    petal: new Path2D('M50 92 C20 88 6 62 10 40 C14 18 32 6 50 14 C68 6 86 18 90 40 C94 62 80 88 50 92Z'),
    eye: new Path2D('M50 84 C41 74 38 56 44 43 C47 37 53 37 56 43 C62 56 59 74 50 84Z'),
    stem: new Path2D('M50 92 C51 102 48 112 42 122'),
  };
  function flower(c, x, y, s, petal, eye) {
    c.save(); c.translate(x, y); c.scale(s, s);
    c.fillStyle = petal; c.fill(FLOWER.petal);
    c.fillStyle = eye; c.fill(FLOWER.eye);
    c.strokeStyle = petal; c.lineWidth = 2.4; c.lineCap = 'round'; c.stroke(FLOWER.stem);
    c.restore();
  }
  function wrapLines(c, text, maxW) {
    const lines = [];
    for (const para of text.split('\n')) {
      let line = '';
      for (const word of para.split(/\s+/)) {
        const test = line ? line + ' ' + word : word;
        if (c.measureText(test).width > maxW && line) { lines.push(line); line = word; }
        else line = test;
      }
      lines.push(line);
    }
    return lines;
  }
  function messageBlock(c, { msg, from, font }, color) {
    const [style, fam, scale] = FONTS[font];
    const x = 118, y = 160, maxW = 860, maxH = 860;
    let size = 92 * scale, lines;
    for (; size > 22; size -= 2) {
      c.font = `${style}${size}px ${fam}`;
      lines = wrapLines(c, msg, maxW);
      if (from) lines.push('', '— ' + from);
      if (lines.length * size * 1.22 <= maxH) break;
    }
    c.fillStyle = color; c.textBaseline = 'top';
    lines.forEach((l, i) => c.fillText(l, x, y + i * size * 1.22));
  }

  // where the photo sits on the front (the print's photo area, without its brushed frame)
  function photoRect() {
    const pr = state.print, s = 1080 / pr.height, mg = (pr.width - 960) / 2 * s;
    return { x: Math.round(70 + mg), y: Math.round((PH - 1080) / 2 + mg), w: Math.round(960 * s), h: Math.round(1200 * s), pw: 1080 * pr.width / pr.height };
  }
  // the card after a soak: butterfly pea tea stains the paper blue
  function teaWash(c) {
    c.fillStyle = '#3352a6'; c.fillRect(0, 0, PW, PH);
    for (const [x, y, rr, col] of [[0.25, 0.3, 0.45, 'rgba(255,255,255,.14)'], [0.8, 0.75, 0.55, 'rgba(10,20,60,.3)'], [0.15, 0.85, 0.4, 'rgba(75,58,166,.3)']]) {
      const g = c.createRadialGradient(x * PW, y * PH, 0, x * PW, y * PH, rr * PW);
      g.addColorStop(0, col); g.addColorStop(1, 'rgba(0,0,0,0)');
      c.fillStyle = g; c.fillRect(0, 0, PW, PH);
    }
    for (let i = 0; i < 40; i++) {
      c.globalAlpha = rand(0.03, 0.08); c.fillStyle = Math.random() < 0.5 ? '#1b3f96' : '#5866b6';
      c.beginPath(); c.ellipse(rand(0, PW), rand(0, PH), rand(40, 220), rand(20, 120), rand(0, 3), 0, 7); c.fill();
    }
    c.globalAlpha = 1;
  }
  // the acid portrait as it blooms: uneven watercolor pink that pools deeper at the edges and
  // thins to translucent in places, where the tea shows through as violet
  function watercolorStencil(mask, W, H) {
    const cv = renderStencil(mask, W, H, [0, 0, 0, 0], [255, 255, 255, 255], true), c = cv.getContext('2d', { willReadFrequently: true });
    const img = c.getImageData(0, 0, W, H), d = img.data, n = W * H, cov = new Float32Array(n);
    for (let p = 0; p < n; p++) cov[p] = d[p * 4 + 3] / 255;
    // one pink, laid on at varying opacity so the indigo tea softly shows through where it's thin;
    // the noise is blurred so the wash drifts gently instead of breaking into spots
    const soft = gauss(cov, W, H, 5), wash = gauss(blotField(W, H, 6, 8), W, H, 24), glow = gauss(blotField(W, H, 5, 7), W, H, 28);
    const pink = [224, 134, 182], pool = [212, 112, 166], light = [240, 162, 202];
    for (let p = 0, i = 0; p < n; p++, i += 4) {
      if (!cov[p]) continue;
      const edge = Math.min(1, Math.max(0, cov[p] - soft[p]) * 1.4);
      const v = Math.min(1, Math.max(0, 0.6 + wash[p] * 1.6 + (Math.random() - 0.5) * 0.04));
      const lift = Math.min(0.55, Math.max(0, glow[p] * 2.4));   // a few softly brighter pools
      for (let k = 0; k < 3; k++) { const c = pink[k] + (light[k] - pink[k]) * lift; d[i + k] = c + (pool[k] - c) * edge * 0.6; }
      d[i + 3] = 255 * cov[p] * Math.min(1, 0.6 + 0.34 * v + edge * 0.12 + lift * 0.1);
    }
    c.putImageData(img, 0, 0);
    return cv;
  }
  // look: 'ink' = the regular-ink print file, 'ghost' = the card before soaking (the clear acid
  // portrait barely shows), 'wash' = tea-stained before the acid reacts, 'soaked' = bloomed pink
  function renderFront(d, look = 'ink') {
    const cv = mk(PW, PH), c = cv.getContext('2d'), wet = look === 'wash' || look === 'soaked';
    if (wet) teaWash(c); else paper(c);
    const r = photoRect();
    const acid = { ghost: [[0, 0, 0, 0], [190, 178, 146, 20]], wash: [[0, 0, 0, 0], [120, 146, 214, 26]] }[look];
    if (acid) c.drawImage(renderStencil(state.mask, r.w, r.h, acid[0], acid[1], true), r.x, r.y);
    if (look === 'soaked') c.drawImage(watercolorStencil(state.mask, r.w, r.h), r.x, r.y);
    const tone = state.printTone, ink = wet ? '#dfe7f5' : toneColor(tone, 0.22), soft = wet ? '#b9c8e8' : toneColor(tone, 0.45);
    const rx = 70 + r.pw + 70;
    flower(c, PW - 250, 120, 1.8, wet ? '#dfe7f5' : toneColor(tone, 0.3), wet ? '#3352a6' : '#f3efe4');
    c.fillStyle = ink; c.textBaseline = 'alphabetic';
    c.font = 'italic 92px "Cormorant Garamond"'; c.fillText('pea booth', rx, 520);
    c.font = '34px "Courier Prime"'; c.fillStyle = soft;
    [`print no. ${state.no}`, `exposed ${d.date}`, `tone — ${TONES[tone].name}`, 'clitoria ternatea'].forEach((t, i) => c.fillText(t, rx, 610 + i * 50));
    if (d.to) { c.font = '76px Caveat'; c.fillStyle = ink; c.fillText(`for ${d.to}`, rx, PH - 150); }
    if (look === 'ink') regMarks(c);
    return cv;
  }
  // the portrait's light areas, printed (or brushed through the stencil) in acidic ink
  function renderFrontAcid() {
    const cv = mk(PW, PH), c = cv.getContext('2d'); paper(c, true);
    const r = photoRect();
    c.drawImage(renderStencil(state.mask, r.w, r.h, [255, 255, 255], [0, 0, 0], false), r.x, r.y);
    regMarks(c);
    return cv;
  }
  function renderBack(d) {
    const cv = mk(PW, PH), c = cv.getContext('2d'); paper(c);
    const ink = '#1a4396';
    c.strokeStyle = ink; c.lineWidth = 3; c.globalAlpha = 0.75;
    wobblyLine(c, 1010, 120, 1010, PH - 120);
    [610, 740, 870, 1000].forEach(y => wobblyLine(c, 1100, y, PW - 110, y));
    c.globalAlpha = 1;
    // stamp
    const sx = PW - 340, sy = 96, sw = 230, sh = 288;
    c.fillStyle = '#2a59ad'; c.fillRect(sx, sy, sw, sh);
    c.fillStyle = ink;
    for (let x = sx - 14; x <= sx + sw + 14; x += 18) { c.beginPath(); c.arc(x, sy - 14, 3.2, 0, 7); c.arc(x, sy + sh + 14, 3.2, 0, 7); c.fill(); }
    for (let y = sy; y <= sy + sh; y += 18) { c.beginPath(); c.arc(sx - 14, y, 3.2, 0, 7); c.arc(sx + sw + 14, y, 3.2, 0, 7); c.fill(); }
    flower(c, sx + 20, sy + 22, 1.9, '#f3efe4', '#2a59ad');
    c.textBaseline = 'alphabetic';
    c.font = '30px "Courier Prime"'; c.fillStyle = '#56658a'; c.fillText('to', 1100, 590);
    if (d.to) { c.font = '84px Caveat'; c.fillStyle = '#0c2457'; c.fillText(d.to, 1160, 592); }
    c.font = '28px "Courier Prime"'; c.fillStyle = '#56658a';
    c.fillText('soak me in butterfly pea tea ↓', 118, PH - 70);
    c.font = 'italic 38px "Cormorant Garamond"'; c.fillStyle = '#56658a';
    c.fillText('there is a message here. you just can\'t see it yet.', 118, 110);
    regMarks(c);
    return cv;
  }
  // the laser-cut stencil, card-sized: black is the sheet that stays, white is cut away. Lay it on
  // the front, edges flush, and brush the acid through the holes.
  function renderCut() {
    const cv = mk(PW, PH), c = cv.getContext('2d'), r = photoRect();
    c.fillStyle = '#000'; c.fillRect(0, 0, PW, PH);
    c.drawImage(renderStencil(state.mask, r.w, r.h, [0, 0, 0], [255, 255, 255], false), r.x, r.y);
    return cv;
  }
  function renderAcid(d) {
    const cv = mk(PW, PH), c = cv.getContext('2d'); paper(c, true);
    messageBlock(c, d, '#000');
    regMarks(c);
    return cv;
  }

  async function buildKeepsake() {
    await Promise.all(['92px Caveat', '34px "Courier Prime"', 'italic 92px "Cormorant Garamond"'].map(f => document.fonts.load(f)));
    const d = {
      msg: msgI.value.trim(), to: toI.value.trim(), from: fromI.value.trim(), font: fontOf(),
      date: new Date().toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' }).toLowerCase(),
    };
    state.files = { front: renderFront(d), frontAcid: renderFrontAcid(), back: renderBack(d), acid: renderAcid(d), stencil: renderCut() };
    $('#frontImg').src = renderFront(d, 'ghost').toDataURL('image/png');
    $('#frontWash').src = renderFront(d, 'wash').toDataURL('image/png');
    $('#frontBloom').src = renderFront(d, 'soaked').toDataURL('image/png');
    frontFace.classList.remove('soaked');
    const fin = $('#backFinal');
    clearTimeout(fin._soak); fin.classList.remove('soaked'); fin.classList.add('ink-hidden');
    $('#card3d').classList.remove('flipped');
    requestAnimationFrame(() => fillBack(fin, d));
    $('#printSheet').innerHTML = ['front', 'frontAcid', 'back', 'acid'].map(k => `<img src="${state.files[k].toDataURL('image/png')}" alt="">`).join('');
  }

  /* ───────────── keepsake ───────────── */
  const card3d = $('#card3d'), frontFace = $('.face.front', card3d);
  const flip = () => card3d.classList.toggle('flipped');
  card3d.addEventListener('click', flip);
  card3d.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); flip(); } });
  $('#flipBtn').addEventListener('click', flip);
  $('#soakBtn').addEventListener('click', () => {
    // soak whichever side is facing up
    if (card3d.classList.contains('flipped')) { soak($('#backFinal')); return; }
    frontFace.classList.remove('soaked'); void frontFace.offsetWidth; frontFace.classList.add('soaked');
  });
  $$('[data-dl]').forEach(b => b.addEventListener('click', () => {
    const k = b.dataset.dl, cv = state.files[k]; if (!cv) return;
    const names = { front: 'front', frontAcid: 'front-acid-layer', back: 'back', acid: 'message-acid-layer', stencil: 'stencil-cut' };
    cv.toBlob(blob => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = `pea-booth-${state.no}-${names[k]}.png`;
      a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    }, 'image/png');
  }));
  $('#printBtn').addEventListener('click', () => window.print());
  $('#againBtn').addEventListener('click', () => {
    state.print = null; state.no = String(Math.floor(Math.random() * 9000) + 1000);
    resetTray(); msgI.value = ''; syncWrite();
    curtainTo('inside');
  });

  /* ───────────── how it works ───────────── */
  $('#toTop').addEventListener('click', e => { e.preventDefault(); window.scrollTo({ top: 0, behavior: 'smooth' }); });

  /* ───────────── featured keepsakes on the line ───────────── */
  const KEEPSAKES = [
    ['01', 1080, 1350, 'cyanotype · lace'],
    ['02', 1382, 2000, 'cyanotype · petals'],
    ['03', 1080, 1256, 'anthotype · beet'],
    ['04', 1500, 1921, 'anthotype · violet'],
    ['05', 462, 750, 'cyanotype · cornflower'],
    ['06', 800, 1117, 'anthotype · portrait'],
    ['07', 1191, 884, 'cyanotype · coral'],
    ['08', 1440, 1901, 'cyanotype · portrait'],
  ];
  $('#samples').innerHTML = KEEPSAKES.map(([n, w, h, cap], i) => `
    <li style="--tilt:${[-1.6, 1.2, -0.8, 1.8, -1.2, 0.9, -1.8, 1.4][i]}deg">
      <span class="pin"></span>
      <figure>
        <img src="img/keepsakes/${n}.webp" width="${w}" height="${h}" loading="lazy" alt="Featured keepsake: ${cap}">
        <figcaption>No. ${n}</figcaption>
      </figure>
    </li>`).join('');

  /* ───────────── the booth photograph (full-screen room) ───────────── */
  // regions in the source photo (img/booth-wide.webp, 2000 × 848)
  const BOOTH = {
    src: 'img/booth-wide.webp',
    door: { x: 995, y: 226, w: 144, h: 491 },
    rodY: 235,
    tag: { x: 1040, y: 345 },
    sign: { x: 892, y: 158, w: 228, h: 42 },
    card: { x: 937, y: 446, w: 42, h: 61 },
    price: { x: 1159, y: 326, w: 22, h: 62 },
  };
  async function renderBooth() {
    const wrap = $('#photoBooth'), out = $('#boothCanvas');
    const img = new Image(); img.src = BOOTH.src;
    await Promise.all([img.decode(), document.fonts.load('800 40px Archivo'), document.fonts.load('700 8px Archivo')]);
    const w = img.naturalWidth, h = img.naturalHeight, src = mk(w, h), c = src.getContext('2d', { willReadFrequently: true });
    c.drawImage(img, 0, 0);

    // replace the AI's garbled lettering with real type
    const { sign, card, price } = BOOTH;
    c.save();
    c.globalCompositeOperation = 'multiply'; c.fillStyle = 'rgba(28, 34, 48, .85)';
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.font = '800 34px Archivo'; c.fontStretch = 'condensed';
    c.fillText('PEA BOOTH', sign.x + sign.w / 2, sign.y + sign.h / 2 + 2);
    c.restore();

    c.fillStyle = '#e2ded2'; c.fillRect(card.x, card.y, card.w, card.h);
    for (let i = 0; i < 80; i++) { c.fillStyle = `rgba(${rand(90, 140) | 0},${rand(70, 100) | 0},50,${rand(.03, .14)})`; c.fillRect(card.x + rand(0, card.w), card.y + rand(0, card.h), rand(.6, 2), rand(.6, 2)); }
    c.fillStyle = '#262b36'; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.font = '700 6.6px Archivo';
    ['THIS IS AN', 'ORIGINAL', 'BUTTERFLY', 'PEA', 'PHOTOBOOTH'].forEach((t, i) => c.fillText(t, card.x + card.w / 2, card.y + 13 + i * 9));

    c.fillStyle = '#1c212c'; c.fillRect(price.x, price.y, price.w, price.h);
    c.fillStyle = '#e9e7df'; c.font = '700 5px Archivo'; c.fillText('PHOTO', price.x + price.w / 2, price.y + 8);
    c.font = '800 30px Archivo'; c.fillText('1', price.x + price.w / 2, price.y + price.h / 2 + 5);

    out.width = w; out.height = h;
    out.getContext('2d').drawImage(src, 0, 0);

    // place the doorway hotspot and the enter tag over the photo
    const d = BOOTH.door, pct = (v, total) => (v / total * 100) + '%';
    wrap.style.setProperty('--x', pct(d.x, w));
    wrap.style.setProperty('--y', pct(d.y, h));
    wrap.style.setProperty('--w', pct(d.w, w));
    wrap.style.setProperty('--h', pct(d.h, h));
    wrap.style.setProperty('--tx', pct(BOOTH.tag.x, w));
    wrap.style.setProperty('--ty', pct(BOOTH.tag.y, h));
    const fitString = () => {
      const tag = $('#enterBtn'), k = out.clientHeight / h;
      wrap.style.setProperty('--string', Math.max(8, (BOOTH.tag.y - BOOTH.rodY) * k - tag.offsetHeight / 2) + 'px');
    };
    fitString(); new ResizeObserver(fitString).observe(out);
    wrap.classList.remove('loading');
  }
  renderBooth().catch(err => console.error('booth photo failed to load', err));
  $('#curtainBtn').addEventListener('click', () => curtainTo('inside'));

  syncWrite();
})();
