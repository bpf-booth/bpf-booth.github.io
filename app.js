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
  let colAcc = new Float64Array(0);
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
    // vertical pass row by row (one running sum per column), which keeps memory access in order
    const acc = colAcc.length >= w ? colAcc : (colAcc = new Float64Array(w));
    acc.fill(0, 0, w);
    for (let y = -r; y <= r; y++) { const row = Math.min(h - 1, Math.max(0, y)) * w; for (let x = 0; x < w; x++) acc[x] += t[row + x]; }
    for (let y = 0; y < h; y++) {
      const orow = y * w, add = Math.min(h - 1, y + r + 1) * w, sub = Math.max(0, y - r) * w;
      for (let x = 0; x < w; x++) { o[orow + x] = acc[x] * k; acc[x] += t[add + x] - t[sub + x]; }
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
  // dark features (eyes, brows, nostrils, lips, hair) are cut out of one card-stock sheet; the acid is
  // brushed through those holes, so in the tea they bloom pink while the rest of the card turns blue
  const STENCIL = {
    work: 720,        // working width; all sizes below are in these pixels
    blur: 1,          // pre-threshold blur (3 box passes); bigger = rounder, simpler shapes
    detail: 1.4,      // local contrast boost; higher pulls eyes, brows, lips out of the skin
    local: 40,        // neighborhood radius for that boost (≈ a cheek; small values give line drawings)
    fine: 2.2,        // second, fine-scale boost for eye detail: lids, iris, catchlight
    fineR: 3,         // neighborhood radius for the fine boost (≈ an iris)
    bias: -0.05,      // added to the auto (Otsu) threshold, -0.15…0.15; + = more blue
    adapt: 0.7,       // 0 = one global threshold, 1 = fully local; mixes in shading inside the face
    adaptR: 50,       // neighborhood radius for the local part (≈ a cheek)
    adaptOffset: 0.035,// how much darker than its surroundings a patch must be to turn blue
    majority: 1,      // radius of the majority filter that cleans ragged edges
    cleanPasses: 1,   // how many times it runs; more = smoother but loses thin lid lines
    minArea: 0.00013, // holes smaller than this share of the image are filled in (≈ 0.7 mm; keeps eye whites)
    minPiece: 0.0002, // loose dark bits smaller than this are dropped (≈ 1 mm²)
    looseMax: 0.0012, // small accents up to this size (nose shadow, nostrils) stay as separate
                      // little pieces instead of getting a bridge across the face; bigger ones are bridged
    bridgeMm: 1,      // bridge width that ties loose pieces back to the sheet
    maxBridgeMm: 3,   // longest bridge allowed; a piece that can't reach the sheet that quickly stays loose
    bridgeTone: 0.3,  // bridges may only cross shading this close to the threshold (0 = only near-dark)
    scratchMm: 4,     // thin strokes on light skin longer than this are removed (stray hairs, creases)
    minGapMm: 0.5,    // light gaps narrower than this are never closed by thickening (eye whites)
    minLineMm: 0.9,   // thinnest stencil material allowed; thinner lines are thickened so card
                      // stock holds its shape and doesn't tear when laser cut
    alongAxis: 4,     // how strongly bridges leave elongated shapes (lips, eyes) along their length
    skinCost: 12,     // extra cost for bridging across lit skin, so bridges keep to hair and shadow
    photoMm: 64,      // printed width of the photo on the 6 × 4 in card, to convert mm → px
    edge: 1,          // contour smoothing when scaling up, in working pixels
    // with face landmarks
    skinShrink: 0.9,  // the clean-skin zone is the face oval scaled by this toward its centre
    skinDark: 0.6,    // on skin only pixels darker than Otsu × this are cut (hair across the face)
    eyeBias: 0,       // per-feature threshold shifts; + cuts more of that feature
    browBias: 0.02,
    noseBias: -0.12,  // only the darkest part of the nose: nostrils and the shadow under the tip
    lipBias: 0,
    lipRed: 2.5,      // how much a lip's redness counts as darkness (lips are colour, not shadow)
    bridgeGrow: 0.35, // big sheet islands (the face inside the hair) may use longer bridges
    bridgeWiden: 4,   // ...and wider ones, up to this × bridgeMm, so the face hangs on a broad band
    massBlur: 3,      // outside the face: blur before the single threshold (bigger = calmer shapes)
    bodyR: 24,        // body (person mask, outside the face): shading is measured against this neighborhood
    bodyShade: 0.1,   // ...and cut where it is this much darker: neck shadow, collar, folds. Lower = more
    outlineMm: 1.1,   // width of the outline along the body's silhouette (0 = none)
    massBias: 0,      // outside the face: + cuts more. Only the darkest of three tones is cut, so a
                      // mid-grey wall stays sheet while hair and dark clothes become holes
    sheetLooseMin: 0.003, // sheet islands this small that can't be bridged are cut away instead
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

  // two thresholds that best split the histogram into three groups (dark / mid / light)
  function otsu3(hist, total) {
    const P = new Float64Array(257), S = new Float64Array(257);
    for (let i = 0; i < 256; i++) { P[i + 1] = P[i] + hist[i]; S[i + 1] = S[i] + i * hist[i]; }
    const cls = (a, b) => { const w = P[b] - P[a]; return w ? (S[b] - S[a]) ** 2 / w : 0; };
    let best = -1, t1 = 85, t2 = 170;
    for (let a = 1; a < 255; a++) for (let b = a + 1; b < 256; b++) {
      const v = cls(0, a) + cls(a, b) + cls(b, 256);
      if (v > best) { best = v; t1 = a; t2 = b; }
    }
    return [t1 / 255, t2 / 255];
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
  function bridgeIslands(m, w, h, tone, t, skin, bw, opt = {}) {
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
    if (!isles.length) return [];
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
    const dist = new Float32Array(n), glen = new Float32Array(n), from = new Int32Array(n), gen = new Int32Array(n);
    const baseLen = STENCIL.maxBridgeMm * w / STENCIL.photoMm, limit = opt.limit ?? STENCIL.bridgeTone;
    const looseMax = opt.looseMax ?? STENCIL.looseMax, grow = opt.growLen ?? 0;
    const costBase = opt.costBase ?? 0.15, costTone = opt.costTone ?? 10;
    const paths = [];
    isles.sort((a, b) => b.px.length - a.px.length);
    isles.forEach((isle, g) => {
      if (held[isle.id] || isle.px.length < looseMax * n) return;
      const maxLen = baseLen + grow * Math.sqrt(isle.px.length);   // bigger pieces may reach further
      g += 1;
      // shape of the island: centre and long axis (principal component)
      let cx = 0, cy = 0, sxx = 0, syy = 0, sxy = 0;
      for (const p of isle.px) { cx += p % w; cy += (p / w) | 0; }
      cx /= isle.px.length; cy /= isle.px.length;
      for (const p of isle.px) { const dx = p % w - cx, dy = ((p / w) | 0) - cy; sxx += dx * dx; syy += dy * dy; sxy += dx * dy; }
      const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy), ax = Math.cos(ang), ay = Math.sin(ang);
      const tr = sxx + syy, det = sxx * syy - sxy * sxy, l1 = tr / 2 + Math.sqrt(Math.max(0, tr * tr / 4 - det)), l2 = tr - l1;
      const aniso = STENCIL.alongAxis * Math.min(1, Math.max(0, (Math.sqrt(l1 / Math.max(l2, 1e-6)) - 1.2) / 1.5));
      // the long-axis rule only holds close to the shape: leave from a corner, then go the short way
      const near = Math.sqrt(3 * l1 / isle.px.length) + 12;
      hn = 0;
      for (const p of isle.px) { gen[p] = g; dist[p] = 0; glen[p] = 0; from[p] = -1; push(0, p); }
      let end = -1;
      while (hn) {
        const p = pop(), dp = dist[p];
        if (m[p] && comp[p] >= 0 && held[comp[p]]) { end = p; break; }
        const x = p % w, y = (p / w) | 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          if ((!dx && !dy) || x + dx < 0 || x + dx >= w || y + dy < 0 || y + dy >= h) continue;
          const q = p + dy * w + dx, len = dx && dy ? 1.414 : 1;
          let c = 0, gl = glen[p];
          if (!m[q]) {
            const u = Math.max(0, tone[q] - t) / (1 - t);
            // bridges only run through shadow, and only a short way; otherwise the piece stays loose
            if (u > limit || (gl += len) > maxLen) continue;
            const vx = x + dx - cx, vy = y + dy - cy, r = Math.hypot(vx, vy) || 1;
            const across = r < near ? Math.abs(vx * ay - vy * ax) / r : 0;   // 0 = along the long axis, 1 = straight across
            c = len * (costBase + costTone * u * u + STENCIL.skinCost * skin[q] * u) * (1 + aniso * across);
          }
          const nd = dp + c;
          if (gen[q] !== g || nd < dist[q]) { gen[q] = g; dist[q] = nd; glen[q] = gl; from[q] = p; push(nd, q); }
        }
      }
      if (end < 0) return;
      const path = [];
      for (let k = end; k >= 0; k = from[k]) {
        if (!m[k]) path.push(k);
        else if (comp[k] >= 0) held[comp[k]] = 1;   // islands the path ran through are held now too
      }
      held[isle.id] = 1;
      paths.push({ path, bw: bw * Math.min(opt.widen ?? 1, Math.max(1, Math.sqrt(isle.px.length) / 60)) });
    });
    // draw each bridge as a smoothed curve of disks
    for (const { path, bw: pw } of paths) {
      const r = Math.max(1, pw / 2), R = Math.ceil(r);
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
    return isles.filter(isle => !held[isle.id]);
  }

  // chamfer (3-4) distance from every pixel where m[p] === val to the nearest pixel that isn't; ×3 px
  function chamfer(m, w, h, val) {
    const n = m.length, d = new Float32Array(n);
    for (let p = 0; p < n; p++) d[p] = m[p] === val ? 1e9 : 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const p = y * w + x; if (!d[p]) continue;
      let v = d[p];
      if (x > 0) v = Math.min(v, d[p - 1] + 3);
      if (y > 0) { v = Math.min(v, d[p - w] + 3); if (x > 0) v = Math.min(v, d[p - w - 1] + 4); if (x < w - 1) v = Math.min(v, d[p - w + 1] + 4); }
      d[p] = v;
    }
    for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) {
      const p = y * w + x; if (!d[p]) continue;
      let v = d[p];
      if (x < w - 1) v = Math.min(v, d[p + 1] + 3);
      if (y < h - 1) { v = Math.min(v, d[p + w] + 3); if (x < w - 1) v = Math.min(v, d[p + w + 1] + 4); if (x > 0) v = Math.min(v, d[p + w - 1] + 4); }
      d[p] = v;
    }
    return d;
  }

  // dark strokes thinner than `width` px: find them as what a disk of that width can't reach
  function thinParts(m, w, h, width) {
    const n = m.length, d = chamfer(m, w, h, 1), r = width / 2, R = Math.ceil(r), covered = new Uint8Array(n);
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const p = y * w + x;
      if (d[p] / 3 < r) continue;
      // only the rim of the thick part needs stamping; its inside is covered anyway
      if (d[p - 1] / 3 >= r && d[p + 1] / 3 >= r && d[p - w] / 3 >= r && d[p + w] / 3 >= r) { covered[p] = 1; continue; }
      for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx >= 0 && yy >= 0 && xx < w && yy < h && dx * dx + dy * dy <= r * r) covered[yy * w + xx] = 1;
      }
    }
    const thin = new Uint8Array(n);
    for (let p = 0; p < n; p++) thin[p] = m[p] && !covered[p] ? 1 : 0;
    return { thin, d };
  }

  // long thin strokes lying on light skin (a stray hair across the cheek, a crease) read as
  // scratches once cut, so they go; short ones (lash lines, nostril edges) stay and are thickened
  function dropScratches(m, w, h, width, maxLen, keep) {
    const n = m.length, { thin, d } = thinParts(m, w, h, width), around = boxBlur(Float32Array.from(m), w, h, 8);
    const seen = new Uint8Array(n), stack = new Int32Array(n), px = [];
    for (let s = 0; s < n; s++) {
      if (!thin[s] || seen[s]) continue;
      let top = 0; stack[top++] = s; seen[s] = 1; px.length = 0;
      let dsum = 0, dark = 0;
      while (top) {
        const p = stack[--top], x = p % w; px.push(p); dsum += d[p] / 3; dark += around[p];
        for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, p - w, p + w, x > 0 ? p - w - 1 : -1, x < w - 1 ? p - w + 1 : -1, x > 0 ? p + w - 1 : -1, x < w - 1 ? p + w + 1 : -1]) {
          if (q >= 0 && q < n && thin[q] && !seen[q]) { seen[q] = 1; stack[top++] = q; }
        }
      }
      const len = px.length / Math.max(1, 2 * dsum / px.length);
      if (len > maxLen && dark / px.length < 0.4 && !(keep && px.some(p => keep[p]))) for (const p of px) m[p] = 0;
    }
  }

  // no part of the stencil thinner than `width` px: redraw the centre line of each thin stroke at
  // that width, but never close a light gap narrower than `gap` px (eye whites, lid creases)
  function thicken(m, w, h, width, gap) {
    const n = m.length, d = chamfer(m, w, h, 1), L = chamfer(m, w, h, 0), r = width / 2, R = Math.ceil(r);
    const G = Math.ceil(gap / 2) + 1, narrow = new Int8Array(n);   // 0 unknown, 1 narrow, -1 wide
    const isNarrow = q => {
      if (!narrow[q]) {
        const qx = q % w, qy = (q / w) | 0; let mx = 0;
        for (let dy = -G; dy <= G; dy++) for (let dx = -G; dx <= G; dx++) {
          const x = qx + dx, y = qy + dy;
          if (x >= 0 && y >= 0 && x < w && y < h) mx = Math.max(mx, L[y * w + x]);
        }
        narrow[q] = (2 * mx / 3) < gap ? 1 : -1;
      }
      return narrow[q] === 1;
    };
    const ridge = [];
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const p = y * w + x, v = d[p];
      if (!v || v / 3 >= r) continue;
      if (v >= d[p - 1] && v >= d[p + 1] && v >= d[p - w] && v >= d[p + w] && v >= d[p - w - 1] && v >= d[p - w + 1] && v >= d[p + w - 1] && v >= d[p + w + 1]) ridge.push(p);
    }
    const add = [];
    for (const p of ridge) {
      const cx = p % w, cy = (p / w) | 0;
      for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
        const x = cx + dx, y = cy + dy, q = y * w + x;
        if (x >= 0 && y >= 0 && x < w && y < h && dx * dx + dy * dy <= r * r && !m[q] && !isNarrow(q)) add.push(q);
      }
    }
    for (const q of add) m[q] = 1;
  }

  /* ───────────── face landmarks (MediaPipe, loaded on demand; the booth works without it) ───────────── */
  const MP = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
  const MP_MODEL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
  const MP_SEG = 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/1/selfie_segmenter.tflite';
  let faceModel = null;
  function loadFaceModel() {
    if (!faceModel) faceModel = (async () => {
      const { FaceLandmarker, ImageSegmenter, FilesetResolver } = await import(`${MP}/vision_bundle.mjs`);
      const files = await FilesetResolver.forVisionTasks(`${MP}/wasm`);
      const [landmarks, person] = await Promise.all([
        FaceLandmarker.createFromOptions(files, { baseOptions: { modelAssetPath: MP_MODEL, delegate: 'CPU' }, runningMode: 'IMAGE', numFaces: 1 }),
        ImageSegmenter.createFromOptions(files, { baseOptions: { modelAssetPath: MP_SEG, delegate: 'CPU' }, runningMode: 'IMAGE', outputCategoryMask: false, outputConfidenceMasks: true }).catch(() => null),
      ]);
      return { landmarks, person };
    })().catch(err => { console.warn('face landmarks unavailable, using the plain stencil', err); return null; });
    return faceModel;
  }
  // face landmarks plus a person mask (how likely each pixel is the sitter, not the background)
  async function detectFace(canvas) {
    const mp = await Promise.race([loadFaceModel(), wait(6000).then(() => null)]);
    if (!mp) return null;
    let face = null, person = null;
    try { face = mp.landmarks.detect(canvas).faceLandmarks?.[0] || null; } catch { /* no face */ }
    try {
      const r = mp.person?.segment(canvas), mk0 = r?.confidenceMasks?.[r.confidenceMasks.length - 1];
      if (mk0) person = { data: Float32Array.from(mk0.getAsFloat32Array()), w: mk0.width, h: mk0.height };
      r?.close?.();
    } catch { /* no mask */ }
    return face ? Object.assign(face, { person }) : null;
  }
  // MediaPipe face-mesh indices for each feature outline
  const FACE = {
    oval: [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109],
    eyeR: [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246],
    eyeL: [263, 249, 390, 373, 374, 380, 381, 382, 362, 398, 384, 385, 386, 387, 388, 466],
    browR: [46, 53, 52, 65, 55, 70, 63, 105, 66, 107],
    browL: [276, 283, 282, 295, 285, 300, 293, 334, 296, 336],
    nose: [2, 97, 98, 64, 48, 115, 220, 45, 4, 275, 440, 344, 278, 294, 327, 326],
    lips: [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 409, 270, 269, 267, 0, 37, 39, 40, 185],
  };
  // fill a polygon (grown by `grow` px) into a w × h mask
  function polyMask(pts, w, h, grow) {
    const c = mk(w, h), x = c.getContext('2d', { willReadFrequently: true });
    x.fillStyle = x.strokeStyle = '#fff'; x.lineJoin = 'round'; x.lineWidth = grow * 2;
    x.beginPath(); pts.forEach(([px, py], i) => (i ? x.lineTo(px, py) : x.moveTo(px, py))); x.closePath(); x.fill();
    if (grow > 0) x.stroke();
    const d = x.getImageData(0, 0, w, h).data, m = new Uint8Array(w * h);
    for (let p = 0; p < m.length; p++) m[p] = d[p * 4 + 3] > 127 ? 1 : 0;
    return m;
  }
  const hull = pts => {   // convex hull (monotone chain)
    const P = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]), cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lo = [], up = [];
    for (const p of P) { while (lo.length > 1 && cr(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
    for (const p of P.reverse()) { while (up.length > 1 && cr(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop(); up.push(p); }
    return lo.slice(0, -1).concat(up.slice(0, -1));
  };

  // photo canvas (+ optional face landmarks) → binary mask at working resolution.
  // 1 = hole: cut out of the sheet, acid is brushed through it, it blooms pink.
  // 0 = sheet: the card stock that stays, held together as one piece.
  // With landmarks, the skin is left clean and only the features are cut, each with its own
  // threshold: eyes (iris, lash line), brows, nostrils, lips. Hair and dark background are cut too.
  function stencilMask(photo, face) {
    const w = STENCIL.work, h = Math.round(w * photo.height / photo.width), n = w * h;
    const c = mk(w, h), cx = c.getContext('2d', { willReadFrequently: true });
    cx.imageSmoothingQuality = 'high'; cx.drawImage(photo, 0, 0, w, h);
    const d = cx.getImageData(0, 0, w, h).data, L = new Float32Array(n), Red = new Float32Array(n);
    for (let p = 0, i = 0; p < n; p++, i += 4) {
      L[p] = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) / 255;
      Red[p] = Math.max(0, d[i] - (d[i + 1] + d[i + 2]) / 2) / 255;   // lips are redder than skin
    }
    // stretch contrast between the 1st and 99th percentile
    const raw = new Uint32Array(256); for (let p = 0; p < n; p++) raw[(L[p] * 255) | 0]++;
    let lo = 0, hi = 255, acc = 0;
    while (lo < 255 && (acc += raw[lo]) < n * 0.01) lo++;
    acc = 0; while (hi > 0 && (acc += raw[hi]) < n * 0.01) hi--;
    const span = Math.max(1, hi - lo) / 255, base = lo / 255;
    for (let p = 0; p < n; p++) L[p] = Math.min(1, Math.max(0, (L[p] - base) / span));
    const B = gauss(L, w, h, STENCIL.blur), Fn = gauss(B, w, h, STENCIL.fineR), M = gauss(B, w, h, STENCIL.local);
    const E = new Float32Array(n), T = new Float32Array(n);
    for (let p = 0; p < n; p++) {
      E[p] = Math.min(1, Math.max(0, B[p] + (B[p] - Fn[p]) * STENCIL.fine));   // fine detail, for features
      T[p] = Math.min(1, Math.max(0, E[p] + (B[p] - M[p]) * STENCIL.detail));  // + cheek-scale shading
    }
    const histOf = (arr, sel) => { const hh = new Uint32Array(256); let k = 0; for (let p = 0; p < n; p++) if (!sel || sel[p]) { hh[Math.min(255, (arr[p] * 255) | 0)]++; k++; } return [hh, k]; };
    const t = otsu(...histOf(T)) + STENCIL.bias;
    const A = gauss(T, w, h, STENCIL.adaptR), a = STENCIL.adapt;
    let m = new Uint8Array(n);
    for (let p = 0; p < n; p++) m[p] = T[p] < (1 - a) * t + a * (A[p] - STENCIL.adaptOffset) ? 1 : 0;

    let keep = null;
    if (face) {
      const P = i => [face[i].x * w, face[i].y * h], pts = ids => ids.map(P);
      const eyeW = Math.hypot(P(33)[0] - P(133)[0], P(33)[1] - P(133)[1]) || w * 0.06;
      // skin: the face oval shrunk toward its centre, so the jaw and hairline keep their edge
      const oval = pts(FACE.oval), ocx = oval.reduce((s, q) => s + q[0], 0) / oval.length, ocy = oval.reduce((s, q) => s + q[1], 0) / oval.length;
      const skin = polyMask(oval.map(([x, y]) => [ocx + (x - ocx) * STENCIL.skinShrink, ocy + (y - ocy) * STENCIL.skinShrink]), w, h, 0);
      const feats = [
        [pts(FACE.eyeR), eyeW * 0.28, STENCIL.eyeBias], [pts(FACE.eyeL), eyeW * 0.28, STENCIL.eyeBias],
        [hull(pts(FACE.browR)), eyeW * 0.12, STENCIL.browBias], [hull(pts(FACE.browL)), eyeW * 0.12, STENCIL.browBias],
        [hull(pts(FACE.nose)), eyeW * 0.06, STENCIL.noseBias], [pts(FACE.lips), eyeW * 0.08, STENCIL.lipBias, true],
      ].map(([poly, grow, bias, lips]) => ({ sel: polyMask(poly, w, h, grow), bias, lips }));
      keep = new Uint8Array(n);
      for (const f of feats) for (let p = 0; p < n; p++) keep[p] |= f.sel[p];
      // skin stays sheet unless it is really dark (hair across the face); everything outside the
      // face (hair, clothes, background) is one smooth threshold, so it cuts as large calm shapes
      const tg = otsu(...histOf(B)), G = gauss(L, w, h, STENCIL.massBlur);
      const out = new Uint8Array(n); for (let p = 0; p < n; p++) out[p] = skin[p] ? 0 : 1;
      const tm = otsu3(...histOf(G, out))[0] + STENCIL.massBias;
      // the person mask, at working resolution (1 everywhere if the segmenter didn't load)
      const body = new Float32Array(n).fill(1), pm = face.person;
      if (pm) for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) body[y * w + x] = pm.data[Math.min(pm.h - 1, (y * pm.h / h) | 0) * pm.w + Math.min(pm.w - 1, (x * pm.w / w) | 0)];
      const A2 = gauss(T, w, h, STENCIL.bodyR);
      for (let p = 0; p < n; p++) {
        if (keep[p]) continue;
        if (skin[p]) m[p] = B[p] < tg * STENCIL.skinDark ? 1 : 0;
        else if (body[p] > 0.5) m[p] = G[p] < tm || T[p] < A2[p] - STENCIL.bodyShade ? 1 : 0;   // neck shadow, collar, folds
        else m[p] = G[p] < tm ? 1 : 0;                                                     // background stays sheet
      }
      // a soft outline where the body meets the background, so light clothes on a light wall still read
      if (pm && STENCIL.outlineMm > 0) {
        const half = STENCIL.outlineMm * w / STENCIL.photoMm / 2, bm = new Uint8Array(n);
        for (let p = 0; p < n; p++) bm[p] = body[p] > 0.5 ? 1 : 0;
        const din = chamfer(bm, w, h, 1), dout = chamfer(bm, w, h, 0);
        for (let p = 0; p < n; p++) if (!skin[p] && !keep[p] && (din[p] / 3 <= half && din[p] > 0 || dout[p] / 3 <= half && dout[p] > 0)) { m[p] = 1; keep[p] = 1; }
      }
      // each feature splits its own pixels into dark and light
      for (const f of feats) {
        let V = E;
        if (f.lips) { V = new Float32Array(n); for (let p = 0; p < n; p++) V[p] = Math.max(0, E[p] - Red[p] * STENCIL.lipRed); }
        const tf = otsu(...histOf(V, f.sel)) + f.bias;
        for (let p = 0; p < n; p++) if (f.sel[p]) m[p] = V[p] < tf ? 1 : 0;
      }
    }
    // a sheet border round the edge holds everything together
    for (let x = 0; x < w; x++) for (let k = 0; k < 4; k++) m[k * w + x] = m[(h - 1 - k) * w + x] = 0;
    for (let y = 0; y < h; y++) for (let k = 0; k < 4; k++) m[y * w + k] = m[y * w + w - 1 - k] = 0;
    // majority filter: smooths ragged contours and kills specks
    for (let k = 0; k < STENCIL.cleanPasses; k++) {
      const f = boxBlur(Float32Array.from(m), w, h, STENCIL.majority);
      for (let p = 0; p < n; p++) m[p] = f[p] > 0.5 ? 1 : 0;
    }
    const mm = w / STENCIL.photoMm;
    dropIslands(m, w, h, 1, Math.round(n * STENCIL.minPiece));             // tiny holes: leave as sheet
    dropScratches(m, w, h, STENCIL.minLineMm * mm, STENCIL.scratchMm * mm, keep);   // creases, stray hairs
    dropIslands(m, w, h, 0, Math.round(n * STENCIL.minArea));              // tiny sheet specks: cut away
    // sheet islands inside holes (eye whites, hair highlights, the face inside the hair) get bridges
    // through the holes' lightest parts, so the sheet stays one piece
    const inv = new Uint8Array(n), tone = new Float32Array(n), zero = new Float32Array(n);
    for (let p = 0; p < n; p++) { inv[p] = 1 - m[p]; tone[p] = 1 - B[p]; }
    const tB = otsu(...histOf(B));
    const loose = bridgeIslands(inv, w, h, tone, 1 - tB, zero, STENCIL.bridgeMm * mm, { limit: 1, looseMax: 0, growLen: STENCIL.bridgeGrow, costBase: 1, costTone: 1.5, widen: STENCIL.bridgeWiden });
    for (const isle of loose) if (isle.px.length < n * STENCIL.sheetLooseMin) for (const p of isle.px) inv[p] = 0;
    // sheet at least minLine wide; holes narrower than minGap (lash lines) are never closed
    thicken(inv, w, h, STENCIL.minLineMm * mm, STENCIL.minGapMm * mm);
    for (let p = 0; p < n; p++) m[p] = 1 - inv[p];
    return { m, w, h, face: !!face };
  }

  // mask → W × H canvas in two colours. Scaled up smoothly, blurred and re-thresholded so
  // the contours are round curves rather than stair steps. aa = soft edge (screen) or hard (cutter).
  function stencilField({ m, w, h }, W, H, aa) {
    const small = mk(w, h), sc = small.getContext('2d'), id = sc.createImageData(w, h);
    for (let p = 0; p < m.length; p++) { const v = m[p] ? 0 : 255; id.data[p * 4] = id.data[p * 4 + 1] = id.data[p * 4 + 2] = v; id.data[p * 4 + 3] = 255; }
    sc.putImageData(id, 0, 0);
    const out = mk(W, H), oc = out.getContext('2d', { willReadFrequently: true });
    oc.imageSmoothingQuality = 'high'; oc.drawImage(small, 0, 0, W, H);
    const img = oc.getImageData(0, 0, W, H), d = img.data, f = new Float32Array(W * H);
    for (let p = 0; p < f.length; p++) f[p] = d[p * 4] / 255;
    const F = gauss(f, W, H, Math.max(1, Math.round(STENCIL.edge * W / w)));
    if (!aa) {   // hard edge for the cutter: clear the odd pixel speck the scaling leaves behind
      const bin = new Uint8Array(F.length);
      for (let p = 0; p < F.length; p++) bin[p] = F[p] >= 0.5 ? 0 : 1;
      dropIslands(bin, W, H, 0, 64); dropIslands(bin, W, H, 1, 64);
      // keep the smooth value at the edges, so traced contours stay round
      for (let p = 0; p < F.length; p++) if ((F[p] >= 0.5 ? 0 : 1) !== bin[p]) F[p] = 1 - bin[p];
    }
    return F;
  }
  function renderStencil(mask, W, H, dark, light, aa) {
    const F = stencilField(mask, W, H, aa), out = mk(W, H), oc = out.getContext('2d');
    const img = oc.createImageData(W, H), d = img.data, e = aa ? 0.08 : 0;
    for (let p = 0, i = 0; p < F.length; p++, i += 4) {
      const a = aa ? Math.min(1, Math.max(0, (F[p] - 0.5 + e) / (2 * e))) : F[p] >= 0.5 ? 1 : 0;   // 1 = light
      for (let c = 0; c < 4; c++) d[i + c] = (dark[c] ?? 255) + ((light[c] ?? 255) - (dark[c] ?? 255)) * a;
    }
    oc.putImageData(img, 0, 0);
    return out;
  }
  /* ───────────── laser file: the cut lines as vectors ───────────── */
  // trace every edge between sheet and hole (marching squares on the same field as the PNG)
  function traceField(F, W, H) {
    const id = (x, y, side) => (y * W + x) * 2 + side;   // side 0 = top edge of a cell, 1 = left edge
    const a1 = new Int32Array(W * H * 2).fill(-1), a2 = new Int32Array(W * H * 2).fill(-1), px = new Float32Array(W * H * 4);
    const pt = (e, x0, y0, x1, y1) => {
      const v0 = F[y0 * W + x0], v1 = F[y1 * W + x1], f = (0.5 - v0) / ((v1 - v0) || 1e-6);
      px[e * 2] = x0 + (x1 - x0) * f; px[e * 2 + 1] = y0 + (y1 - y0) * f;
    };
    const seg = (e1, e2) => { (a1[e1] < 0 ? a1 : a2)[e1] = e2; (a1[e2] < 0 ? a1 : a2)[e2] = e1; };
    for (let y = 0; y < H - 1; y++) for (let x = 0; x < W - 1; x++) {
      const a = F[y * W + x] < 0.5, b = F[y * W + x + 1] < 0.5, c = F[(y + 1) * W + x + 1] < 0.5, d = F[(y + 1) * W + x] < 0.5;
      const k = a | b << 1 | c << 2 | d << 3; if (!k || k === 15) continue;
      const T = id(x, y, 0), Lf = id(x, y, 1), Bm = id(x, y + 1, 0), R = id(x + 1, y, 1);
      if (a !== b) pt(T, x, y, x + 1, y);
      if (a !== d) pt(Lf, x, y, x, y + 1);
      if (d !== c) pt(Bm, x, y + 1, x + 1, y + 1);
      if (b !== c) pt(R, x + 1, y, x + 1, y + 1);
      const mid = (F[y * W + x] + F[y * W + x + 1] + F[(y + 1) * W + x + 1] + F[(y + 1) * W + x]) / 4 < 0.5;
      switch (k) {
        case 1: case 14: seg(Lf, T); break;
        case 2: case 13: seg(T, R); break;
        case 3: case 12: seg(Lf, R); break;
        case 4: case 11: seg(R, Bm); break;
        case 6: case 9: seg(T, Bm); break;
        case 7: case 8: seg(Lf, Bm); break;
        case 5: if (mid) { seg(T, R); seg(Bm, Lf); } else { seg(Lf, T); seg(R, Bm); } break;
        case 10: if (mid) { seg(Lf, T); seg(R, Bm); } else { seg(T, R); seg(Bm, Lf); } break;
      }
    }
    const seen = new Uint8Array(a1.length), loops = [];
    for (let s0 = 0; s0 < a1.length; s0++) {
      if (a1[s0] < 0 || seen[s0]) continue;
      const loop = []; let prev = -1, cur = s0;
      while (!seen[cur]) {
        seen[cur] = 1; loop.push([px[cur * 2], px[cur * 2 + 1]]);
        const nx = a1[cur] !== prev ? a1[cur] : a2[cur]; prev = cur; cur = nx;
        if (cur < 0) break;
      }
      if (loop.length > 3) loops.push(loop);
    }
    return loops;
  }
  // Douglas–Peucker on a closed loop
  function simplify(pts, tol) {
    if (pts.length < 8) return pts;
    const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
    const st = [[0, pts.length - 1]];
    while (st.length) {
      const [i0, i1] = st.pop(), [x0, y0] = pts[i0], [x1, y1] = pts[i1], dx = x1 - x0, dy = y1 - y0, l = Math.hypot(dx, dy) || 1;
      let best = -1, bd = tol;
      for (let i = i0 + 1; i < i1; i++) { const dd = Math.abs(dy * (pts[i][0] - x0) - dx * (pts[i][1] - y0)) / l; if (dd > bd) { bd = dd; best = i; } }
      if (best > 0) { keep[best] = 1; st.push([i0, best], [best, i1]); }
    }
    return pts.filter((_, i) => keep[i]);
  }
  // cut paths in points (72 per inch) on the 6 × 4 in card: the card outline plus every hole edge
  function cutPaths() {
    const r = photoRect(), F = stencilField(state.mask, r.w, r.h, false), k = 72 / 300;
    const loops = traceField(F, r.w, r.h).map(l => simplify(l, 0.35)).filter(l => {
      let a = 0; for (let i = 0; i < l.length; i++) { const [x0, y0] = l[i], [x1, y1] = l[(i + 1) % l.length]; a += x0 * y1 - x1 * y0; }
      return Math.abs(a) / 2 > 40;   // skip specks under ~0.1 mm²
    });
    return { W: PW * k, H: PH * k, loops: loops.map(l => l.map(([x, y]) => [(x + r.x) * k, (y + r.y) * k])) };
  }
  // Illustrator opens both. Stroke: pure RGB red, 0.001 in (0.072 pt), no fill: the usual laser cut line.
  function cutSVG() {
    const { W, H, loops } = cutPaths(), f = v => +v.toFixed(3);
    const d = loops.map(l => 'M' + l.map(([x, y]) => `${f(x)} ${f(y)}`).join('L') + 'Z');
    return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="6in" height="4in" viewBox="0 0 ${W} ${H}">
  <title>Pea Booth stencil ${state.no}: cut lines</title>
  <g id="cut" fill="none" stroke="#FF0000" stroke-width="0.072" stroke-linejoin="round">
    <rect x="0" y="0" width="${W}" height="${H}"/>
${d.map(p => `    <path d="${p}"/>`).join('\n')}
  </g>
</svg>
`;
  }
  function cutPDF() {
    const { W, H, loops } = cutPaths(), f = v => v.toFixed(3);
    let ops = `1 0 0 RG 0.072 w 1 j\n0 0 ${W} ${H} re\n`;
    for (const l of loops) ops += l.map(([x, y], i) => `${f(x)} ${f(H - y)} ${i ? 'l' : 'm'}`).join('\n') + '\nh\n';
    ops += 'S\n';
    const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << >> /Contents 4 0 R >>`,
      `<< /Length ${ops.length} >>\nstream\n${ops}endstream`];
    let out = '%PDF-1.4\n', offs = [];
    objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
    const xref = out.length;
    out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('');
    out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return out;
  }

  const BLOOM_PINK = [224, 134, 182];   // where the acid went, as it reads after the soak
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
    loadFaceModel();   // warm up the face landmarks while the camera starts
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
    state.mask = stencilMask(cap, await detectFace(cap));
    state.print = makePrint(renderStencil(state.mask, W, H, BLOOM_PINK, lutAt(state.tone, 0.16), true), state.tone);
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
    const cv = renderStencil(mask, W, H, [255, 255, 255, 255], [0, 0, 0, 0], true), c = cv.getContext('2d', { willReadFrequently: true });
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
    const acid = { ghost: [[190, 178, 146, 12], [0, 0, 0, 0]], wash: [[120, 146, 214, 26], [0, 0, 0, 0]] }[look];
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
  // the portrait's features, printed (or brushed through the stencil) in acidic ink
  function renderFrontAcid() {
    const cv = mk(PW, PH), c = cv.getContext('2d'); paper(c, true);
    const r = photoRect();
    c.drawImage(renderStencil(state.mask, r.w, r.h, [0, 0, 0], [255, 255, 255], false), r.x, r.y);
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
  // the laser-cut stencil, card-sized: white is the sheet that stays, black is cut away. Lay it on
  // the front, edges flush, and brush the acid through the holes. (Vectors: cutSVG / cutPDF.)
  function renderCut() {
    const cv = mk(PW, PH), c = cv.getContext('2d'), r = photoRect();
    c.fillStyle = '#fff'; c.fillRect(0, 0, PW, PH);
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
  $$('[data-vec]').forEach(b => b.addEventListener('click', () => {
    if (!state.mask) return;
    const svg = b.dataset.vec === 'svg', blob = new Blob([svg ? cutSVG() : cutPDF()], { type: svg ? 'image/svg+xml' : 'application/pdf' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = `pea-booth-${state.no}-stencil-cut.${svg ? 'svg' : 'pdf'}`;
    a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
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
