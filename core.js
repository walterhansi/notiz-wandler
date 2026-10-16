// core.js – plattformneutrale Kernlogik (läuft im Browser und in Node)
// Eingabe: RGBA-Pixel einer gerenderten PDF-Seite. Ausgabe: freigestellte Tinte,
// einzeln abgrenzbare Zeichnungen und eine Excalidraw-Szene.

export const DEFAULTS = {
  gridCut: 0.2,     // Alpha-Schwelle: alles darunter gilt als Raster (Punkte ~0,13)
  gap: 50,          // max. Abstand (px bei 1600 px Seitenbreite), bei dem Striche noch zusammengehören
  minSize: 20,      // kleinste Kantenlänge (px) einer Zeichnung
  minPixels: 60,    // mindestens so viele Tintenpixel
  pad: 8,           // Rand um jede ausgeschnittene Zeichnung (px)
  block: 8,         // Rastergröße der Gruppierung (px)
  photos: true,     // flächige Bilder (Fotos) erkennen und als Rechteck übernehmen
  drawings: true,   // übrige Striche/Zeichnungen/Text gruppieren und ausschneiden
  solid: 16,        // Fotos: Mindestdicke einer 'vollen' Fläche (px); dünne Striche zählen nicht
  minPhoto: 80,     // Fotos: kleinste Kantenlänge (px)
  photoFill: 0.85,  // Foto = volle Fläche; darunter (z. B. Person mit Hintergrund) gilt als Bild mit Kontur
  images: false,    // Modus 'Nur Bilder': Gruppen mit voller Kernfläche freigestellt übernehmen, Text ignorieren
  minCore: 1000,    // Bild: mindestens so viele Pixel in voller Kernfläche
};

/** Häufigste Farbe der Seite = Papier. */
export function estimateBackground(rgba) {
  const bins = new Uint32Array(4096);
  const sum = new Float64Array(4096 * 3);
  const n = rgba.length / 4;
  const step = Math.max(1, Math.floor(n / 400000));
  for (let p = 0; p < n; p += step) {
    const i = p * 4;
    const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
    const k = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    bins[k]++;
    sum[k * 3] += r; sum[k * 3 + 1] += g; sum[k * 3 + 2] += b;
  }
  let best = 0;
  for (let k = 1; k < 4096; k++) if (bins[k] > bins[best]) best = k;
  const c = bins[best] || 1;
  return [sum[best * 3] / c, sum[best * 3 + 1] / c, sum[best * 3 + 2] / c].map(Math.round);
}

function ca(c, b, light) { // color-to-alpha für einen Kanal; Richtung nach Papierhelligkeit
  // Helles Papier: nur Dunkleres ist Tinte (JPEG-Rauschen/leichtes Überweiß zählt nicht). Dunkles Papier: umgekehrt.
  if (light) return c < b ? (b - c) / b : 0;
  return c > b ? (c - b) / (255 - b) : 0;
}

/**
 * Entfernt Papier + Raster: Farbe-zu-Alpha gegen das Papier,
 * alles unter `cut` (die blassen Rasterpunkte) wird transparent.
 * Liefert { ink: RGBA mit Alpha, count: Anzahl Tintenpixel }.
 */
export function extractInk(rgba, bg, cut) {
  const out = new Uint8ClampedArray(rgba.length);
  const [br, bgg, bb] = bg;
  const light = (br + bgg + bb) / 3 > 127;
  let count = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
    const a = Math.max(ca(r, br, light), ca(g, bgg, light), ca(b, bb, light));
    if (a < cut) continue;
    out[i] = (r - br) / a + br;
    out[i + 1] = (g - bgg) / a + bgg;
    out[i + 2] = (b - bb) / a + bb;
    out[i + 3] = a * 255 + 0.5;
    count++;
  }
  return { ink: out, count };
}

// Quadratische Dilatation (Radius r) auf einer Bitmaske, getrennt in x und y.
function dilate(mask, w, h, r) {
  if (r <= 0) return mask.slice();
  const tmp = new Uint8Array(w * h);
  const out = new Uint8Array(w * h);
  const pre = new Int32Array(Math.max(w, h) + 1);
  for (let y = 0; y < h; y++) {
    pre[0] = 0;
    for (let x = 0; x < w; x++) pre[x + 1] = pre[x] + mask[y * w + x];
    for (let x = 0; x < w; x++) {
      const a = Math.max(0, x - r), b = Math.min(w, x + r + 1);
      tmp[y * w + x] = pre[b] - pre[a] > 0 ? 1 : 0;
    }
  }
  for (let x = 0; x < w; x++) {
    pre[0] = 0;
    for (let y = 0; y < h; y++) pre[y + 1] = pre[y] + tmp[y * w + x];
    for (let y = 0; y < h; y++) {
      const a = Math.max(0, y - r), b = Math.min(h, y + r + 1);
      out[y * w + x] = pre[b] - pre[a] > 0 ? 1 : 0;
    }
  }
  return out;
}

/**
 * Teilt die Tinte in einzeln abgrenzbare Zeichnungen.
 * Gruppiert über einen Blockraster + Dilatation, dann zusammenhängende Komponenten.
 */
export function segment(ink, w, h, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const B = o.block;
  const bw = Math.ceil(w / B), bh = Math.ceil(h / B);
  const mask = new Uint8Array(bw * bh);
  for (let y = 0; y < h; y++) {
    const by = (y / B) | 0;
    for (let x = 0; x < w; x++) {
      if (ink[(y * w + x) * 4 + 3]) mask[by * bw + ((x / B) | 0)] = 1;
    }
  }
  const r = Math.max(0, Math.round(o.gap / 2 / B));
  const dil = dilate(mask, bw, bh, r);

  // Komponenten (8er-Nachbarschaft) per BFS
  const label = new Int32Array(bw * bh);
  let n = 0;
  const queue = new Int32Array(bw * bh);
  for (let s = 0; s < dil.length; s++) {
    if (!dil[s] || label[s]) continue;
    n++;
    let qh = 0, qt = 0;
    queue[qt++] = s; label[s] = n;
    while (qh < qt) {
      const c = queue[qh++];
      const cx = c % bw, cy = (c / bw) | 0;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = cy + dy;
        if (ny < 0 || ny >= bh) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = cx + dx;
          if (nx < 0 || nx >= bw) continue;
          const k = ny * bw + nx;
          if (dil[k] && !label[k]) { label[k] = n; queue[qt++] = k; }
        }
      }
    }
  }

  // Tintenpixel -> Komponente, Bounding-Box und Pixelzahl
  const bx0 = new Int32Array(n + 1).fill(1 << 30), by0 = new Int32Array(n + 1).fill(1 << 30);
  const bx1 = new Int32Array(n + 1).fill(-1), by1 = new Int32Array(n + 1).fill(-1);
  const cnt = new Int32Array(n + 1);
  for (let y = 0; y < h; y++) {
    const by = (y / B) | 0;
    for (let x = 0; x < w; x++) {
      if (!ink[(y * w + x) * 4 + 3]) continue;
      const l = label[by * bw + ((x / B) | 0)];
      cnt[l]++;
      if (x < bx0[l]) bx0[l] = x;
      if (x > bx1[l]) bx1[l] = x;
      if (y < by0[l]) by0[l] = y;
      if (y > by1[l]) by1[l] = y;
    }
  }

  let items = [];
  for (let l = 1; l <= n; l++) {
    if (!cnt[l]) continue;
    const tw = bx1[l] - bx0[l] + 1, th = by1[l] - by0[l] + 1;
    if (cnt[l] < o.minPixels || Math.max(tw, th) < o.minSize) continue;
    const x0 = Math.max(0, bx0[l] - o.pad), y0 = Math.max(0, by0[l] - o.pad);
    const x1 = Math.min(w, bx1[l] + 1 + o.pad), y1 = Math.min(h, by1[l] + 1 + o.pad);
    items.push({ label: l, x: x0, y: y0, w: x1 - x0, h: y1 - y0, pixels: cnt[l] });
  }
  items = readingOrder(items);

  // Ausschnitte: nur Pixel, die zu dieser Zeichnung gehören
  for (const it of items) {
    const crop = new Uint8ClampedArray(it.w * it.h * 4);
    for (let y = 0; y < it.h; y++) {
      const sy = it.y + y, by = (sy / B) | 0;
      for (let x = 0; x < it.w; x++) {
        const sx = it.x + x;
        if (label[by * bw + ((sx / B) | 0)] !== it.label) continue;
        const si = (sy * w + sx) * 4, di = (y * it.w + x) * 4;
        crop[di] = ink[si]; crop[di + 1] = ink[si + 1]; crop[di + 2] = ink[si + 2]; crop[di + 3] = ink[si + 3];
      }
    }
    it.rgba = crop;
  }
  return items;
}


// ---------- Fotos / flächige Bilder ----------

function label8(mask, w, h) {
  const label = new Int32Array(w * h);
  const queue = new Int32Array(w * h);
  let n = 0;
  for (let s = 0; s < mask.length; s++) {
    if (!mask[s] || label[s]) continue;
    n++;
    let qh = 0, qt = 0;
    queue[qt++] = s; label[s] = n;
    while (qh < qt) {
      const c = queue[qh++];
      const cx = c % w, cy = (c / w) | 0;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = cy + dy; if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = cx + dx; if (nx < 0 || nx >= w) continue;
          const k = ny * w + nx;
          if (mask[k] && !label[k]) { label[k] = n; queue[qt++] = k; }
        }
      }
    }
  }
  return { label, n };
}

/**
 * Findet flächige Bilder: Zellen, die zu >= 50 % mit Farbe gefüllt sind, werden um `solid` px
 * geöffnet (Erosion + Dilatation) – dünne Striche und Text verschwinden, Fotos bleiben.
 * Liefert die Fotos (Rechtecke) und die Tinte ohne diese Fotos.
 */
export function findPhotos(ink, w, h, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const C = 4;
  const cw = Math.ceil(w / C), ch = Math.ceil(h / C);
  const cnt = new Uint16Array(cw * ch);
  for (let y = 0; y < h; y++) {
    const cy = (y / C) | 0;
    for (let x = 0; x < w; x++) if (ink[(y * w + x) * 4 + 3]) cnt[cy * cw + ((x / C) | 0)]++;
  }
  const solid = new Uint8Array(cw * ch);
  for (let i = 0; i < solid.length; i++) solid[i] = cnt[i] >= (C * C) / 2 ? 1 : 0;
  const r = Math.max(1, Math.round(o.solid / C));
  const inv = solid.map((v) => 1 - v);
  const eroded = dilate(inv, cw, ch, r).map((v) => 1 - v);
  const opened = dilate(eroded, cw, ch, r);
  // nicht über die ursprüngliche Fläche hinaus
  for (let i = 0; i < opened.length; i++) if (!solid[i]) opened[i] = 0;
  const { label, n } = label8(opened, cw, ch);
  const x0 = new Int32Array(n + 1).fill(1 << 30), y0 = new Int32Array(n + 1).fill(1 << 30);
  const x1 = new Int32Array(n + 1).fill(-1), y1 = new Int32Array(n + 1).fill(-1);
  const px = new Int32Array(n + 1);
  for (let y = 0; y < h; y++) {
    const cy = (y / C) | 0;
    for (let x = 0; x < w; x++) {
      if (!ink[(y * w + x) * 4 + 3]) continue;
      const l = label[cy * cw + ((x / C) | 0)];
      if (!l) continue;
      px[l]++;
      if (x < x0[l]) x0[l] = x; if (x > x1[l]) x1[l] = x;
      if (y < y0[l]) y0[l] = y; if (y > y1[l]) y1[l] = y;
    }
  }
  const keep = new Uint8Array(n + 1);
  const photos = [];
  for (let l = 1; l <= n; l++) {
    if (!px[l]) continue;
    const bw = x1[l] - x0[l] + 1, bh = y1[l] - y0[l] + 1;
    if (Math.min(bw, bh) < o.minPhoto || px[l] < o.photoFill * bw * bh) continue;
    keep[l] = 1;
    photos.push({ kind: 'photo', x: x0[l], y: y0[l], w: bw, h: bh, pixels: px[l] });
  }
  let rest = ink;
  if (photos.length) {
    rest = ink.slice();
    const m = C + 2; // Randreste (Zellraster, Kantenglättung) mit entfernen
    for (const p of photos) {
      const ya = Math.max(0, p.y - m), yb = Math.min(h, p.y + p.h + m);
      const xa = Math.max(0, p.x - m), xb = Math.min(w, p.x + p.w + m);
      for (let y = ya; y < yb; y++) for (let x = xa; x < xb; x++) rest[(y * w + x) * 4 + 3] = 0;
    }
  }
  // Kernflächen der übrigen (nicht rechteckigen) Bilder, Zellraster
  const core = new Uint8Array(cw * ch);
  for (let i = 0; i < core.length; i++) { const l = label[i]; if (l && !keep[l]) core[i] = 1; }
  return { photos, rest, core, C, cw };
}

// Löcher im Bild (helle Stellen, die als transparent galten) mit Originalfarbe füllen: Freistellung ohne Löcher.
function fillHoles(it, src, w) {
  const { w: cw, h: ch, rgba } = it;
  const out = new Uint8Array(cw * ch);
  const stack = [];
  const push = (x, y) => { const k = y * cw + x; if (!out[k] && !rgba[k * 4 + 3]) { out[k] = 1; stack.push(k); } };
  for (let x = 0; x < cw; x++) { push(x, 0); push(x, ch - 1); }
  for (let y = 0; y < ch; y++) { push(0, y); push(cw - 1, y); }
  while (stack.length) {
    const k = stack.pop(); const x = k % cw, y = (k / cw) | 0;
    if (x > 0) push(x - 1, y); if (x < cw - 1) push(x + 1, y);
    if (y > 0) push(x, y - 1); if (y < ch - 1) push(x, y + 1);
  }
  for (let k = 0; k < cw * ch; k++) {
    if (out[k] || rgba[k * 4 + 3]) continue;
    const si = ((it.y + ((k / cw) | 0)) * w + it.x + (k % cw)) * 4;
    rgba[k * 4] = src[si]; rgba[k * 4 + 1] = src[si + 1]; rgba[k * 4 + 2] = src[si + 2]; rgba[k * 4 + 3] = 255;
  }
}

function cropOpaque(src, w, x, y, cwid, chei) {
  const out = new Uint8ClampedArray(cwid * chei * 4);
  for (let j = 0; j < chei; j++) {
    const si = ((y + j) * w + x) * 4;
    out.set(src.subarray(si, si + cwid * 4), j * cwid * 4);
  }
  for (let i = 3; i < out.length; i += 4) out[i] = 255;
  return out;
}

/** Fotos als Rechtecke (Originalfarben) + übrige Zeichnungen/Text gruppiert, gemeinsame Lesereihenfolge. */
export function segmentAll(src, ink, w, h, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  let photos = [], rest = ink, core = null, C = 4, ccw = 0;
  if (o.photos || o.images) ({ photos, rest, core, C, cw: ccw } = findPhotos(ink, w, h, o));
  if (!o.photos) { photos = []; rest = ink; }
  for (const p of photos) p.rgba = cropOpaque(src, w, p.x, p.y, p.w, p.h);
  let others = [];
  if (o.drawings) others = segment(rest, w, h, o).map((d) => ({ ...d, kind: 'drawing' }));
  else if (o.images && core) {
    for (const d of segment(rest, w, h, o)) {
      let n = 0;
      for (let y = 0; y < d.h; y++) for (let x = 0; x < d.w; x++) {
        if (d.rgba[(y * d.w + x) * 4 + 3] && core[(((d.y + y) / C) | 0) * ccw + (((d.x + x) / C) | 0)]) n++;
      }
      if (n < o.minCore) continue;
      fillHoles(d, src, w);
      others.push({ ...d, kind: 'image' });
    }
  }
  return readingOrder([...photos, ...others]);
}

/** Zeilenweise von oben nach unten, innerhalb der Zeile von links nach rechts. */
export function readingOrder(items) {
  const s = [...items].sort((a, b) => a.y - b.y || a.x - b.x);
  const rows = [];
  for (const it of s) {
    const cy = it.y + it.h / 2;
    const row = rows.find((r) => cy >= r.top && cy <= r.bottom);
    if (row) {
      row.items.push(it);
      row.top = Math.min(row.top, it.y);
      row.bottom = Math.max(row.bottom, it.y + it.h);
    } else {
      rows.push({ top: it.y, bottom: it.y + it.h, items: [it] });
    }
  }
  rows.sort((a, b) => a.top - b.top);
  return rows.flatMap((r) => r.items.sort((a, b) => a.x - b.x));
}

// ---------- Excalidraw ----------

const B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
/** Aufsteigende Sortierschlüssel im Stil von fractional-indexing: a0..az, b00, b01, … */
export function orderKey(i) {
  if (i < 62) return 'a' + B62[i];
  const j = i - 62;
  return 'b' + B62[Math.floor(j / 62) % 62] + B62[j % 62];
}

export async function sha1Hex(str) {
  const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function bytesToDataURL(bytes, mime = 'image/png') {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return `data:${mime};base64,${btoa(bin)}`;
}

const rnd = () => Math.floor(Math.random() * 2 ** 31);

function baseEl(type, i, x, y, width, height, now) {
  return {
    id: 'ao' + Math.random().toString(36).slice(2, 10) + i.toString(36),
    type, x, y, width, height, angle: 0,
    strokeColor: 'transparent', backgroundColor: 'transparent',
    fillStyle: 'solid', strokeWidth: 1, strokeStyle: 'solid', roughness: 0, opacity: 100,
    groupIds: [], frameId: null, index: orderKey(i), roundness: null,
    seed: rnd(), version: 1, versionNonce: rnd(), isDeleted: false,
    boundElements: null, updated: now, link: null, locked: false,
  };
}

/**
 * pages: [{ width, height, figures: [{x,y,w,h,dataURL,fileId}] }]
 * Jede Zeichnung wird ein eigenes, einzeln anklickbares Bildelement.
 */
export function buildScene(pages, { outline = false, source = 'ao-notiz-wandler', pageGap = 160 } = {}) {
  const now = Date.now();
  const elements = [];
  const files = {};
  let oy = 0, idx = 0;
  for (const p of pages) {
    if (outline) {
      const r = baseEl('rectangle', idx++, 0, oy, p.width, p.height, now);
      r.strokeColor = '#9aa0a6'; r.strokeStyle = 'dashed'; r.locked = true;
      elements.push(r);
    }
    for (const f of p.figures) {
      const el = baseEl('image', idx++, f.x, oy + f.y, f.w, f.h, now);
      el.status = 'saved';
      el.fileId = f.fileId;
      el.scale = [1, 1];
      el.crop = null;
      elements.push(el);
      files[f.fileId] = { mimeType: f.mime || 'image/png', id: f.fileId, dataURL: f.dataURL, created: now, lastRetrieved: now };
    }
    oy += p.height + pageGap;
  }
  return {
    type: 'excalidraw', version: 2, source,
    elements,
    appState: { gridSize: null, viewBackgroundColor: '#ffffff' },
    files,
  };
}

// ---------- Text & Namen ----------

export function buildTxt(sourceName, lang, pages) {
  const out = [`Quelle: ${sourceName}`, `OCR: Tesseract (${lang})`, ''];
  for (const p of pages) {
    out.push(`=== Seite ${p.n} ===`);
    out.push(p.text && p.text.trim() ? p.text.trim() : '(kein Text erkannt)');
    out.push('');
  }
  return out.join('\n');
}

export function baseName(name) { return name.replace(/\.pdf$/i, ''); }

/** "name.ext" bzw. "name (2).ext", falls schon vergeben. `exists` darf async sein. */
export async function uniqueName(base, ext, exists) {
  let n = 1, cand = `${base}.${ext}`;
  while (await exists(cand)) { n++; cand = `${base} (${n}).${ext}`; }
  return cand;
}
