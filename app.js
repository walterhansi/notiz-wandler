import * as pdfjs from './lib/pdf.min.mjs';
import {
  DEFAULTS, estimateBackground, extractInk, segmentAll, buildScene,
  bytesToDataURL, sha1Hex, buildTxt, uniqueName, cleanOcrLines, cropManual,
} from './core.js';

pdfjs.GlobalWorkerOptions.workerSrc = new URL('./lib/pdf.worker.min.mjs', import.meta.url).href;
const PDF_OPTS = {
  wasmUrl: new URL('./lib/wasm/', import.meta.url).href,
  standardFontDataUrl: new URL('./lib/standard_fonts/', import.meta.url).href,
  isEvalSupported: false,
};
const TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
const APP_VERSION = '1.7';
const PAGE_W = 1600; // Zielbreite beim Rendern (px)

const $ = (id) => document.getElementById(id);
let entries = [];       // {id, name, size, modified, getFile, checked}
let dirHandle = null;   // gesetzt, wenn ein Ordner mit Schreibzugriff gewählt wurde
let running = false;
const IMG_RE = /\.(png|jpe?g|bmp|gif|webp)$/i;
const isImageName = (n) => IMG_RE.test(n);
const isSource = (n) => /\.pdf$/i.test(n) || isImageName(n);

let nextId = 1;
const cache = new Map();   // entry.id -> { sig, res }  (Analyse ohne Speichern)
const saved = new Map();   // entry.id -> Ergebnis des Speicherns
let mode = 'bilder';       // 'bilder' | 'alles'
let gapTouched = false;
let analyzing = false, saving = false, token = 0, chain = Promise.resolve(), timer = null;

// ---------- Quelle ----------
function setEntries(list, dir, checkedFn = () => true) {
  entries = list.map((e, i) => ({ ...e, id: nextId++, checked: checkedFn(i) }));
  dirHandle = dir || null;
  cache.clear(); saved.clear();
  renderList(); updateHint(); scheduleAnalyze();
}

function updateHint() {
  $('outHint').textContent = dirHandle
    ? `Speichern in: Ordner „${dirHandle.name}“, neben den Quelldateien.`
    : 'Speichern im Download-Ordner des Browsers (Chrome fragt beim ersten Mal evtl. nach „Mehrere Downloads“ – bitte erlauben). Mit „Ordner öffnen“ landen die Ergebnisse direkt neben den Dateien.';
}

function fmtSize(b) { return b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB'; }

function renderList() {
  const ul = $('fileList');
  ul.textContent = '';
  for (const e of entries) {
    const li = document.createElement('li');
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.checked = e.checked; cb.id = 'f' + e.id;
    cb.onchange = () => { e.checked = cb.checked; saved.delete(e.id); scheduleAnalyze(); };
    const nm = document.createElement('label'); nm.className = 'nm'; nm.htmlFor = cb.id; nm.textContent = e.name;
    const meta = document.createElement('span'); meta.className = 'meta';
    meta.textContent = `${fmtSize(e.size)}${e.modified ? ' · ' + new Date(e.modified).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' }) : ''}`;
    li.append(cb, nm, meta);
    ul.append(li);
  }
  const has = entries.length > 0;
  // Bei einer einzelnen Datei braucht es keine Liste
  $('listCard').hidden = entries.length < 2;
  $('setCard').hidden = !has; $('resultsWrap').hidden = !has;
}

const pdfTypes = [{ description: 'PDF und Bilder', accept: { 'application/pdf': ['.pdf'], 'image/*': ['.png', '.jpg', '.jpeg', '.bmp', '.gif', '.webp'] } }];
const entryOf = (f) => ({ name: f.name, size: f.size, modified: f.lastModified, getFile: async () => f });

async function pickFiles() {
  if (!window.showOpenFilePicker) { $('fileInput').click(); return; }
  try {
    const hs = await window.showOpenFilePicker({ multiple: true, id: 'ao-pdf', startIn: 'downloads', types: pdfTypes });
    const files = await Promise.all(hs.map((h) => h.getFile()));
    setEntries(files.map(entryOf), null);
  } catch (err) {
    if (err && err.name === 'AbortError') return;
    $('fileInput').click();
  }
}
$('btnFiles').onclick = pickFiles;
$('fileInput').onchange = (ev) => {
  const files = [...ev.target.files].filter((f) => isSource(f.name));
  ev.target.value = '';
  if (files.length) setEntries(files.map(entryOf), null);
};

if (!window.showDirectoryPicker) $('btnDir').hidden = true;
$('btnDir').onclick = async () => {
  try {
    const dir = await window.showDirectoryPicker({ id: 'ao-dir', mode: 'readwrite', startIn: 'downloads' });
    const list = [];
    for await (const [name, h] of dir.entries()) {
      if (h.kind !== 'file' || !isSource(name)) continue;
      const f = await h.getFile();
      list.push({ name, size: f.size, modified: f.lastModified, getFile: async () => h.getFile() });
    }
    list.sort((a, b) => b.modified - a.modified);
    if (!list.length) { $('outHint').textContent = `Im Ordner „${dir.name}“ liegen keine PDFs oder Bilder.`; return; }
    // Nur die neueste Datei ist vorgewählt (typisch: der gerade aufgenommene Screenshot)
    setEntries(list, dir, (i) => i === 0);
  } catch (err) {
    if (err && err.name === 'AbortError') return;
    $('outHint').textContent = 'Der Browser erlaubt diesen Ordner nicht (Chrome sperrt z. B. den Download-Ordner selbst als Ordnerauswahl). Nutze „Dateien wählen“ – die Ergebnisse landen dann im Download-Ordner.';
  }
};

// ---------- Zwischenablage und Drag & Drop ----------
function stamp() {
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  return `Zwischenablage ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}
function addClipboardImage(blob) {
  const ext = (blob.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
  const f = new File([blob], `${stamp()}.${ext}`, { type: blob.type, lastModified: Date.now() });
  entries.forEach((e) => (e.checked = false));
  entries.push({ ...entryOf(f), id: nextId++, checked: true });
  saved.clear();
  renderList(); updateHint(); scheduleAnalyze();
}
document.addEventListener('paste', (ev) => {
  const items = [...(ev.clipboardData?.items || [])].filter((i) => i.kind === 'file' && i.type.startsWith('image/'));
  if (!items.length) return;
  ev.preventDefault();
  for (const it of items) { const f = it.getAsFile(); if (f) addClipboardImage(f); }
});
$('btnPaste').onclick = async () => {
  try {
    for (const item of await navigator.clipboard.read()) {
      const type = item.types.find((t) => t.startsWith('image/'));
      if (type) { addClipboardImage(await item.getType(type)); return; }
    }
    $('outHint').textContent = 'In der Zwischenablage liegt kein Bild.';
  } catch {
    $('outHint').textContent = 'Zugriff auf die Zwischenablage nicht erlaubt – drücke stattdessen Strg+V in diesem Fenster.';
  }
};
addEventListener('dragover', (ev) => ev.preventDefault());
addEventListener('drop', (ev) => {
  ev.preventDefault();
  const files = [...(ev.dataTransfer?.files || [])].filter((f) => isSource(f.name));
  if (files.length) setEntries(files.map(entryOf), null);
});

// ---------- Einstellungen ----------
function settings() {
  return {
    gridCut: +$('gridCut').value, gap: +$('gap').value, minSize: +$('minSize').value, mode,
    photos: true, drawings: mode === 'alles', images: mode === 'bilder',
    ocr: $('optOcr').checked, lang: $('ocrLang').value, outline: $('optOutline').checked, clean: $('optClean').checked,
  };
}
const geomSig = (st) => [st.gridCut, st.gap, st.minSize, st.mode].join('|');
function syncOut() {
  $('oCut').textContent = (+$('gridCut').value).toFixed(2);
  $('oGap').textContent = $('gap').value + ' px';
  $('oMin').textContent = $('minSize').value + ' px';
  $('modeHint').textContent = mode === 'bilder'
    ? 'Fotos und Illustrationen werden freigestellt, Text bleibt Text (OCR).'
    : 'Auch Handschrift, Striche und Textblöcke werden als Bilder übernommen – für Notizen.';
}
['gridCut', 'gap', 'minSize'].forEach((id) => $(id).addEventListener('input', () => {
  if (id === 'gap') gapTouched = true;
  syncOut(); resetEdits(); scheduleAnalyze(450);
}));
function resetEdits() { for (const e of entries) { delete e.edits; delete e.sel; } saved.clear(); }
function setMode(m) {
  mode = m;
  $('modeBilder').setAttribute('aria-pressed', String(m === 'bilder'));
  $('modeAlles').setAttribute('aria-pressed', String(m === 'alles'));
  // Passender Zusammenfass-Abstand, solange der Regler nicht von Hand verstellt wurde
  if (!gapTouched) $('gap').value = m === 'bilder' ? 12 : 50;
  syncOut(); resetEdits(); scheduleAnalyze();
}
$('modeBilder').onclick = () => setMode('bilder');
$('modeAlles').onclick = () => setMode('alles');
['optOcr', 'ocrLang', 'optOutline', 'optClean'].forEach((id) => $(id).addEventListener('change', () => { saved.clear(); renderResults(); }));
syncOut();

// ---------- Hilfsfunktionen: Canvas / Speichern ----------
const mkCanvas = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
const toBytes = (canvas, mime = 'image/png') => new Promise((res, rej) => canvas.toBlob(async (b) => {
  if (!b) return rej(new Error('Bilderzeugung fehlgeschlagen'));
  res(new Uint8Array(await b.arrayBuffer()));
}, mime, 0.92));

async function saveBlob(base, ext, blob) {
  if (dirHandle) {
    const name = await uniqueName(base, ext, async (n) => {
      try { await dirHandle.getFileHandle(n); return true; } catch { return false; }
    });
    const fh = await dirHandle.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    await w.write(blob); await w.close();
    return name;
  }
  const name = `${base}.${ext}`;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
  await new Promise((r) => setTimeout(r, 400)); // Chrome mag keine Download-Salven
  return name;
}

// ---------- OCR ----------
let tess = null, ocrWorker = null, ocrLang = null;
function loadTesseract() {
  if (window.Tesseract) return Promise.resolve(window.Tesseract);
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = TESSERACT_URL; s.crossOrigin = 'anonymous';
    s.onload = () => (window.Tesseract ? res(window.Tesseract) : rej(new Error('Tesseract.js nicht verfügbar')));
    s.onerror = () => rej(new Error('Tesseract.js konnte nicht geladen werden (Internetverbindung?)'));
    document.head.append(s);
  });
}
async function closeOcr() { if (ocrWorker) { try { await ocrWorker.terminate(); } catch {} } ocrWorker = null; ocrLang = null; }

function linesOf(data) {
  let lines = data.lines;
  if (!Array.isArray(lines) && Array.isArray(data.blocks)) lines = data.blocks.flatMap((b) => b.paragraphs || []).flatMap((p) => p.lines || []);
  if (Array.isArray(lines) && lines.length) return lines.map((l) => ({ text: (l.text || '').replace(/\s+$/, ''), conf: l.confidence ?? 100 }));
  return String(data.text || '').split('\n').map((t) => ({ text: t, conf: 100 }));
}

async function recognize(canvas, st, status) {
  let data;
  if (window.__aoOcr) data = await window.__aoOcr(canvas, st.lang); // Testhaken
  else {
    tess = tess || (await loadTesseract());
    if (!ocrWorker || ocrLang !== st.lang) {
      await closeOcr();
      ocrWorker = await tess.createWorker(st.lang, 1, {
        logger: (m) => m && m.status && status(`OCR: ${m.status} ${Math.round((m.progress || 0) * 100)} %`),
      });
      ocrLang = st.lang;
    }
    data = (await ocrWorker.recognize(canvas)).data;
  }
  const lines = linesOf(data);
  return (st.clean ? cleanOcrLines(lines) : lines.map((l) => l.text).filter((t) => t.trim())).join('\n');
}

// ---------- Verarbeitung ----------
// Elemente einer Seite = Gruppen von Basis-Figuren. Ohne manuelle Änderung ist jede Figur ihre eigene Gruppe.
const groupsOf = (entry, n, baseLen) => entry.edits?.[n] ?? Array.from({ length: baseLen }, (_, i) => [i]);
const unionBox = (base, g) => {
  const x0 = Math.min(...g.map((i) => base[i].x)), y0 = Math.min(...g.map((i) => base[i].y));
  const x1 = Math.max(...g.map((i) => base[i].x + base[i].w)), y1 = Math.max(...g.map((i) => base[i].y + base[i].h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
};

// save=false: nur analysieren (Vorschau). save=true: erneut rechnen, manuelle Auswahl anwenden, OCR und Dateien schreiben.
async function processFile(entry, st, { save, status }) {
  const file = await entry.getFile();
  const isImg = isImageName(entry.name);
  let task = null, doc = null, total = 1;
  if (!isImg) {
    task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()), ...PDF_OPTS });
    doc = await task.promise;
    total = doc.numPages;
  }
  const pagesOut = [], ocrPages = [], pageRes = [], warnings = [];
  let elTotal = 0, ocrError = null;
  try {
    for (let n = 1; n <= total; n++) {
      status(`${entry.name}: Seite ${n}/${total} …`);
      let page = null, canvas, w, h, k = 1;
      if (isImg) {
        // Bilddatei (Screenshot): Originalauflösung, Größen-Regler auf die Bildbreite umrechnen
        const bmp = await createImageBitmap(file);
        const sc = Math.min(1, Math.sqrt(28e6 / (bmp.width * bmp.height)));
        w = Math.max(1, Math.round(bmp.width * sc)); h = Math.max(1, Math.round(bmp.height * sc));
        canvas = mkCanvas(w, h);
        const c0 = canvas.getContext('2d');
        c0.fillStyle = '#fff'; c0.fillRect(0, 0, w, h); c0.drawImage(bmp, 0, 0, w, h);
        bmp.close();
        k = Math.min(2.5, Math.max(0.4, w / PAGE_W));
      } else {
        page = await doc.getPage(n);
        const v1 = page.getViewport({ scale: 1 });
        let scale = Math.min(4, Math.max(0.5, PAGE_W / v1.width));
        if (v1.width * v1.height * scale * scale > 28e6) scale = Math.sqrt(28e6 / (v1.width * v1.height));
        const vp = page.getViewport({ scale });
        w = Math.ceil(vp.width); h = Math.ceil(vp.height);
        canvas = mkCanvas(w, h);
        await page.render({ canvas, viewport: vp, background: '#ffffff' }).promise;
      }
      const rgba = canvas.getContext('2d').getImageData(0, 0, w, h).data;
      await new Promise((r) => setTimeout(r)); // UI atmen lassen
      const bg = estimateBackground(rgba);
      const { ink, count } = extractInk(rgba, bg, st.gridCut);
      const figs = segmentAll(rgba, ink, w, h, {
        gap: st.gap * k, minSize: st.minSize * k, minPixels: DEFAULTS.minPixels * k * k, pad: Math.round(DEFAULTS.pad * k),
        solid: DEFAULTS.solid * k, minPhoto: DEFAULTS.minPhoto * k, minCore: DEFAULTS.minCore * k * k,
        photos: st.photos, drawings: st.drawings, images: st.images,
      });
      // Basis-Figuren als Canvas halten (für Zusammenfügen); rgba freigeben
      const base = figs.map((f) => {
        const c = mkCanvas(f.w, f.h);
        c.getContext('2d').putImageData(new ImageData(f.rgba, f.w, f.h), 0, 0);
        f.rgba = null;
        return { x: f.x, y: f.y, w: f.w, h: f.h, kind: f.kind, canvas: c };
      });
      // Von Hand aufgezogene Elemente (Rahmen in Seitenkoordinaten) hängen sich hinter die erkannten Figuren
      const nMan = entry.manual?.[n]?.length || 0;
      if (save) {
        for (const r of entry.manual?.[n] || []) {
          const m = cropManual(rgba, ink, w, h, r);
          if (!m) { base.push({ x: r.x, y: r.y, w: 1, h: 1, kind: 'image', empty: true, canvas: mkCanvas(1, 1) }); continue; }
          const c = mkCanvas(m.w, m.h);
          c.getContext('2d').putImageData(new ImageData(m.rgba, m.w, m.h), 0, 0);
          base.push({ x: m.x, y: m.y, w: m.w, h: m.h, kind: 'image', manual: true, canvas: c });
        }
      }
      const groups = groupsOf(entry, n, base.length + (save ? 0 : nMan))
        .map((g) => g.filter((i) => !base[i]?.empty)).filter((g) => g.length || !save);
      if (!save) elTotal += groups.length;

      // Seite ohne Raster, weiß hinterlegt (inkl. Bilder in Originalfarben)
      const inkCanvas = mkCanvas(w, h);
      inkCanvas.getContext('2d').putImageData(new ImageData(ink, w, h), 0, 0);
      const flat = mkCanvas(w, h);
      const fctx = flat.getContext('2d');
      fctx.fillStyle = '#fff'; fctx.fillRect(0, 0, w, h); fctx.drawImage(inkCanvas, 0, 0);

      if (save) {
        const figsOut = [];
        for (const g of groups) {
          let c, box, mime = 'image/png';
          if (g.length === 1) { const f = base[g[0]]; c = f.canvas; box = f; if (f.kind === 'photo') mime = 'image/jpeg'; }
          else { // zusammengefügt: Bounding-Box aller Teile, übrige Fläche transparent
            box = unionBox(base, g); c = mkCanvas(box.w, box.h);
            const cx = c.getContext('2d');
            for (const i of g) cx.drawImage(base[i].canvas, base[i].x - box.x, base[i].y - box.y);
          }
          const dataURL = bytesToDataURL(await toBytes(c, mime), mime);
          figsOut.push({ x: box.x, y: box.y, w: box.w, h: box.h, dataURL, mime, fileId: await sha1Hex(dataURL) });
        }
        pagesOut.push({ width: w, height: h, figures: figsOut });
        elTotal += figsOut.length;

        if (st.ocr && !ocrError) {
          // Bilder für die OCR weißen (sonst entsteht Zeichenmüll aus dem Bildinhalt)
          const ocrCanvas = mkCanvas(w, h);
          const octx = ocrCanvas.getContext('2d');
          octx.drawImage(flat, 0, 0);
          octx.fillStyle = '#fff';
          const used = new Set(groups.flat());
          base.forEach((f, i) => { if (f.kind !== 'drawing' && !f.empty && (!f.manual || used.has(i))) octx.fillRect(f.x, f.y, f.w, f.h); });
          if (count >= 200) {
            status(`${entry.name}: Seite ${n}/${total}: Text erkennen …`);
            try { ocrPages.push({ n, text: await recognize(ocrCanvas, st, status) }); }
            catch (e) { ocrError = e.message || String(e); }
          } else ocrPages.push({ n, text: '' });
          ocrCanvas.width = ocrCanvas.height = 0;
        }
      } else {
        // Vorschau-Hintergrund: Seite ohne Raster, Bilder in Originalfarben
        const tw = Math.min(w, 900), tk = tw / w;
        const th = mkCanvas(tw, Math.round(h * tk));
        const tctx = th.getContext('2d');
        tctx.fillStyle = '#fff'; tctx.fillRect(0, 0, th.width, th.height);
        tctx.drawImage(flat, 0, 0, th.width, th.height);
        for (const f of base) if (f.kind !== 'drawing') tctx.drawImage(f.canvas, f.x * tk, f.y * tk, f.w * tk, f.h * tk);
        pageRes.push({ n, w, h, tk, thumb: th, base: base.map((f) => ({ x: f.x, y: f.y, w: f.w, h: f.h, kind: f.kind })) });
        // Basis-Canvas werden beim Speichern neu erzeugt – hier freigeben
        for (const f of base) f.canvas.width = f.canvas.height = 0;
      }
      canvas.width = canvas.height = inkCanvas.width = inkCanvas.height = flat.width = flat.height = 0;
      if (!save) base.length = 0;
      if (page) page.cleanup();
    }
  } finally { if (task) await task.destroy(); }

  const res = { elTotal, pages: total, pageRes, saved: [], text: '', warnings };
  if (!save) return res;

  const base = entry.name.replace(/\.(pdf|png|jpe?g|bmp|gif|webp)$/i, '');
  if (elTotal > 0) {
    const scene = buildScene(pagesOut, { outline: st.outline });
    const name = await saveBlob(base, 'excalidraw', new Blob([JSON.stringify(scene)], { type: 'application/json' }));
    res.saved.push(`${name} – ${elTotal} Element${elTotal === 1 ? '' : 'e'}, einzeln anklickbar`);
  }
  if (st.ocr) {
    if (ocrError) warnings.push(`Text konnte nicht erkannt werden (${ocrError}). Die Bilder wurden trotzdem gespeichert.`);
    else {
      res.text = buildTxt(entry.name, st.lang, ocrPages);
      const name = await saveBlob(base, 'txt', new Blob([res.text], { type: 'text/plain;charset=utf-8' }));
      res.saved.push(`${name} – Text`);
    }
  }
  return res;
}

// ---------- Ablauf: automatisch analysieren, dann speichern ----------
function scheduleAnalyze(delay = 0) {
  clearTimeout(timer);
  const my = ++token;
  analyzing = true;
  renderResults();
  timer = setTimeout(() => { chain = chain.then(() => runAnalyze(my)); }, delay);
}

async function runAnalyze(my) {
  const st = settings();
  for (const e of entries.filter((x) => x.checked)) {
    if (my !== token) return;
    const c = cache.get(e.id);
    if (c && c.sig === geomSig(st)) continue;
    e.busy = true; e.error = null; renderResults();
    try {
      const res = await processFile(e, st, { save: false, status: (t) => { $('runState').textContent = t; } });
      if (my !== token) { e.busy = false; return; }
      cache.set(e.id, { sig: geomSig(st), res });
    } catch (err) { console.error(err); e.error = err.message || String(err); cache.delete(e.id); }
    e.busy = false;
    renderResults();
  }
  if (my === token) { analyzing = false; $('runState').textContent = ''; renderResults(); }
}

$('btnSave').onclick = async () => {
  if (saving || analyzing) return;
  saving = true; renderResults();
  const st = settings();
  for (const e of entries.filter((x) => x.checked && cache.has(x.id))) {
    e.busy = true; renderResults();
    try { saved.set(e.id, await processFile(e, st, { save: true, status: (t) => { $('runState').textContent = t; } })); }
    catch (err) { console.error(err); saved.set(e.id, { error: err.message || String(err), saved: [], warnings: [] }); }
    e.busy = false;
  }
  await closeOcr();
  saving = false; $('runState').textContent = '';
  renderResults();
  window.__aoDone = true;
};

// ---------- Manuelle Auswahl: anklicken oder aufziehen, zusammenfügen, entfernen ----------
function elementTotal(e, res) {
  return res.pageRes.reduce((s, p) => s + groupsOf(e, p.n, p.base.length + (e.manual?.[p.n]?.length || 0)).length, 0);
}

function buildEditor(entry, p) {
  const wrap = document.createElement('div'); wrap.className = 'editor';
  const sel = (entry.sel ||= {})[p.n] ||= new Set();
  const all = () => p.base.concat((entry.manual?.[p.n] || []).map((r) => ({ ...r, kind: 'image' })));
  const groups = () => groupsOf(entry, p.n, all().length);
  const boxes = () => { const a = all(); return groups().map((g) => unionBox(a, g)); };
  const dmState = (entry.dm ||= {});
  const isDraw = () => !!dmState[p.n];
  const cv = document.createElement('canvas');
  cv.width = p.thumb.width; cv.height = p.thumb.height; cv.className = 'edcanvas';
  const bar = document.createElement('div'); bar.className = 'edbar';
  const info = document.createElement('span'); info.className = 'muted';
  const btn = (txt, fn, cls = 'ghost') => { const b = document.createElement('button'); b.textContent = txt; b.className = cls + ' small'; b.onclick = fn; bar.append(b); return b; };
  let rubber = null;

  function draw() {
    const ctx = cv.getContext('2d');
    ctx.drawImage(p.thumb, 0, 0);
    const bs = boxes(), tk = p.tk, many = bs.length > 80, a = all();
    ctx.font = 'bold 13px system-ui';
    bs.forEach((b, i) => {
      const photo = groups()[i].some((j) => a[j].kind !== 'drawing');
      const col = photo ? '#f9a73b' : '#00b5a6', on = sel.has(i);
      if (on) { ctx.fillStyle = 'rgba(0,181,166,.28)'; ctx.fillRect(b.x * tk, b.y * tk, b.w * tk, b.h * tk); }
      ctx.lineWidth = on ? 3 : 1.5; ctx.strokeStyle = on ? '#131419' : col;
      ctx.strokeRect(b.x * tk, b.y * tk, b.w * tk, b.h * tk);
      if (on) { ctx.lineWidth = 1.5; ctx.strokeStyle = '#00b5a6'; ctx.strokeRect(b.x * tk + 2, b.y * tk + 2, b.w * tk - 4, b.h * tk - 4); }
      if (!many) { ctx.fillStyle = col; ctx.fillRect(b.x * tk, b.y * tk, 22, 18); ctx.fillStyle = '#04110f'; ctx.fillText(String(i + 1), b.x * tk + 5, b.y * tk + 14); }
    });
    if (rubber) {
      const r = rect(rubber);
      const rc = isDraw() ? '#f9a73b' : '#00b5a6';
      ctx.fillStyle = isDraw() ? 'rgba(249,167,59,.18)' : 'rgba(0,181,166,.15)'; ctx.fillRect(r.x, r.y, r.w, r.h);
      ctx.lineWidth = 1.5; ctx.strokeStyle = rc; ctx.setLineDash([6, 4]); ctx.strokeRect(r.x, r.y, r.w, r.h); ctx.setLineDash([]);
    }
    const n = sel.size;
    info.textContent = isDraw() ? 'Rahmen um das fehlende Element ziehen' : n ? `${n} ausgewählt` : `${bs.length} Element${bs.length === 1 ? '' : 'e'} – anklicken oder mit der Maus aufziehen`;
    merge.disabled = n < 2; remove.disabled = n < 1; none.disabled = n < 1; reset.disabled = !entry.edits?.[p.n] && !entry.manual?.[p.n]?.length;
    draw_.className = (isDraw() ? 'primary' : 'ghost') + ' small'; draw_.textContent = isDraw() ? 'Element aufziehen: an' : 'Element aufziehen';
    cv.style.cursor = 'crosshair'; cv.classList.toggle('drawing', isDraw());
  }
  const rect = (r) => ({ x: Math.min(r.x0, r.x1), y: Math.min(r.y0, r.y1), w: Math.abs(r.x1 - r.x0), h: Math.abs(r.y1 - r.y0) });
  const pos = (ev) => { const r = cv.getBoundingClientRect(); return { x: (ev.clientX - r.left) * cv.width / r.width, y: (ev.clientY - r.top) * cv.height / r.height }; };
  const changed = () => { saved.delete(entry.id); renderResults(); };

  const merge = btn('Zusammenfügen', () => {
    const g = groups(), pick = [...sel].sort((a, b) => a - b);
    const merged = pick.flatMap((i) => g[i]);
    const next = g.filter((_, i) => !sel.has(i)); next.splice(pick[0] - 0 > next.length ? next.length : pick[0], 0, merged);
    (entry.edits ||= {})[p.n] = next; sel.clear(); sel.add(next.indexOf(merged)); changed();
  }, 'primary');
  const remove = btn('Entfernen', () => { (entry.edits ||= {})[p.n] = groups().filter((_, i) => !sel.has(i)); sel.clear(); changed(); });
  const none = btn('Auswahl aufheben', () => { sel.clear(); draw(); });
  const reset = btn('Zurücksetzen', () => { delete entry.edits?.[p.n]; delete entry.manual?.[p.n]; sel.clear(); changed(); });
  const draw_ = btn('Element aufziehen', () => { dmState[p.n] = !isDraw(); draw(); });
  bar.append(info);

  cv.addEventListener('pointerdown', (ev) => { cv.setPointerCapture(ev.pointerId); const q = pos(ev); rubber = { x0: q.x, y0: q.y, x1: q.x, y1: q.y }; });
  cv.addEventListener('pointermove', (ev) => { if (!rubber) return; const q = pos(ev); rubber.x1 = q.x; rubber.y1 = q.y; draw(); });
  cv.addEventListener('pointerup', (ev) => {
    if (!rubber) return;
    const r = rect(rubber); rubber = null;
    const bs = boxes(), tk = p.tk;
    if (isDraw()) { // neues Element aus dem aufgezogenen Rahmen
      if (r.w < 8 || r.h < 8) { draw(); return; }
      const man = ((entry.manual ||= {})[p.n] ||= []);
      const had = groups(); // vor dem Hinzufügen sichern (bei Standard-Gruppen wächst die Liste von selbst)
      man.push({ x: Math.round(r.x / tk), y: Math.round(r.y / tk), w: Math.round(r.w / tk), h: Math.round(r.h / tk) });
      if (entry.edits?.[p.n]) entry.edits[p.n] = [...had, [all().length - 1]];
      sel.clear(); sel.add(groups().length - 1); changed(); return;
    }
    if (r.w < 5 && r.h < 5) { // Klick: kleinstes Element unter dem Zeiger umschalten
      let hit = -1, area = Infinity;
      bs.forEach((b, i) => { const x = r.x / tk, y = r.y / tk; if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h && b.w * b.h < area) { hit = i; area = b.w * b.h; } });
      if (hit < 0) sel.clear(); else if (sel.has(hit)) sel.delete(hit); else sel.add(hit);
    } else { // Aufziehen: alle Elemente, deren Mitte im Rahmen liegt, zur Auswahl hinzufügen
      bs.forEach((b, i) => { const cx = (b.x + b.w / 2) * tk, cy = (b.y + b.h / 2) * tk; if (cx >= r.x && cx <= r.x + r.w && cy >= r.y && cy <= r.y + r.h) sel.add(i); });
    }
    draw();
  });
  wrap.append(cv, bar);
  draw();
  return wrap;
}

function renderResults() {
  const box = $('results');
  box.textContent = '';
  const sel = entries.filter((e) => e.checked);
  let ready = 0, done = 0;
  for (const e of sel) {
    const c = cache.get(e.id), s = saved.get(e.id);
    if (c) ready++;
    if (s && !s.error) done++;
    const card = document.createElement('div'); card.className = 'card res';
    const h = document.createElement('h3'); h.textContent = e.name; card.append(h);
    const p = document.createElement('div'); card.append(p);
    if (e.error) { p.className = 'err'; p.textContent = 'Fehler: ' + e.error; }
    else if (e.busy && !c) { p.className = 'muted'; p.textContent = 'Wird analysiert …'; }
    else if (c) {
      const r = c.res, n = elementTotal(e, r);
      p.className = n ? 'ok' : 'muted';
      p.textContent = n
        ? `${n} Element${n === 1 ? '' : 'e'} erkannt${r.pages > 1 ? ` auf ${r.pages} Seiten` : ''}`
        : 'Nichts Ausschneidbares gefunden – unter „Erweitert“ lässt sich das anpassen.';
      if (s) {
        const ul = document.createElement('ul');
        for (const t of s.saved || []) { const li = document.createElement('li'); li.textContent = '✓ ' + t; ul.append(li); }
        for (const t of [...(s.warnings || []), ...(s.error ? [s.error] : [])]) { const li = document.createElement('li'); li.className = 'warn'; li.textContent = t; ul.append(li); }
        card.append(ul);
      }
      for (const pg of r.pageRes) {
        if (r.pages > 1) { const cap = document.createElement('div'); cap.className = 'muted'; cap.textContent = `Seite ${pg.n}`; card.append(cap); }
        card.append(buildEditor(e, pg));
      }
      if (s && s.text) {
        const d = document.createElement('details'); d.style.marginTop = '10px';
        const sm = document.createElement('summary'); sm.textContent = 'Erkannten Text anzeigen'; d.append(sm);
        const pre = document.createElement('pre'); pre.textContent = s.text; pre.style.whiteSpace = 'pre-wrap'; d.append(pre);
        card.append(d);
      }
    }
    box.append(card);
  }
  const b = $('btnSave');
  const allDone = ready > 0 && done === ready;
  b.disabled = analyzing || saving || ready === 0 || allDone;
  b.textContent = saving ? 'Speichere …' : analyzing ? 'Analysiere …' : allDone ? 'Gespeichert ✓' : `Speichern${ready > 1 ? ` (${ready} Dateien)` : ''}`;
  $('openHint').hidden = done === 0;
}

// ---------- Aktualisieren / Start ----------
$('ver').textContent = 'Version ' + APP_VERSION;
$('btnUpdate').onclick = async () => {
  $('btnUpdate').disabled = true; $('btnUpdate').textContent = 'Aktualisiere …';
  try {
    const reg = navigator.serviceWorker && (await navigator.serviceWorker.getRegistration());
    if (reg) await reg.update();
    for (const k of await caches.keys()) if (k.startsWith('ao-wandler-')) await caches.delete(k);
  } catch (e) { console.error(e); }
  location.reload();
};

updateHint();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
