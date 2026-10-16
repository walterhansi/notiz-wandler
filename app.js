import * as pdfjs from './lib/pdf.min.mjs';
import {
  DEFAULTS, estimateBackground, extractInk, segmentAll, buildScene,
  bytesToDataURL, sha1Hex, buildTxt, uniqueName, cleanOcrLines,
} from './core.js';

pdfjs.GlobalWorkerOptions.workerSrc = new URL('./lib/pdf.worker.min.mjs', import.meta.url).href;
const PDF_OPTS = {
  wasmUrl: new URL('./lib/wasm/', import.meta.url).href,
  standardFontDataUrl: new URL('./lib/standard_fonts/', import.meta.url).href,
  isEvalSupported: false,
};
const TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
const APP_VERSION = '1.5';
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
  syncOut(); scheduleAnalyze(450);
}));
function setMode(m) {
  mode = m;
  $('modeBilder').setAttribute('aria-pressed', String(m === 'bilder'));
  $('modeAlles').setAttribute('aria-pressed', String(m === 'alles'));
  // Passender Zusammenfass-Abstand, solange der Regler nicht von Hand verstellt wurde
  if (!gapTouched) $('gap').value = m === 'bilder' ? 12 : 50;
  syncOut(); scheduleAnalyze();
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
// save=false: nur analysieren (Vorschau). save=true: erneut rechnen, OCR und Dateien schreiben.
async function processFile(entry, st, { save, status }) {
  const file = await entry.getFile();
  const isImg = isImageName(entry.name);
  let task = null, doc = null, total = 1;
  if (!isImg) {
    task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()), ...PDF_OPTS });
    doc = await task.promise;
    total = doc.numPages;
  }
  const pagesOut = [], ocrPages = [], thumbs = [], warnings = [];
  let figTotal = 0, nPhotos = 0, ocrError = null;
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
      figTotal += figs.length;
      nPhotos += figs.filter((f) => f.kind !== 'drawing').length;

      const figsOut = [];
      const figCanvas = new Map();
      for (const f of figs) {
        const c = mkCanvas(f.w, f.h);
        c.getContext('2d').putImageData(new ImageData(f.rgba, f.w, f.h), 0, 0);
        figCanvas.set(f, c);
        if (save) {
          const mime = f.kind === 'photo' ? 'image/jpeg' : 'image/png'; // Fotos JPEG-Rechteck, sonst PNG mit Transparenz
          const dataURL = bytesToDataURL(await toBytes(c, mime), mime);
          figsOut.push({ x: f.x, y: f.y, w: f.w, h: f.h, dataURL, mime, fileId: await sha1Hex(dataURL) });
        }
        f.rgba = null;
      }
      if (save) pagesOut.push({ width: w, height: h, figures: figsOut });

      // Seite ohne Raster, weiß hinterlegt: für OCR und Vorschau
      const inkCanvas = mkCanvas(w, h);
      inkCanvas.getContext('2d').putImageData(new ImageData(ink, w, h), 0, 0);
      const flat = mkCanvas(w, h);
      const fctx = flat.getContext('2d');
      fctx.fillStyle = '#fff'; fctx.fillRect(0, 0, w, h); fctx.drawImage(inkCanvas, 0, 0);

      if (save && st.ocr && !ocrError) {
        // Bilder für die OCR weißen (sonst entsteht Zeichenmüll aus dem Bildinhalt)
        const ocrCanvas = mkCanvas(w, h);
        const octx = ocrCanvas.getContext('2d');
        octx.drawImage(flat, 0, 0);
        octx.fillStyle = '#fff';
        for (const f of figs) if (f.kind !== 'drawing') octx.fillRect(f.x, f.y, f.w, f.h);
        if (count >= 200) {
          status(`${entry.name}: Seite ${n}/${total}: Text erkennen …`);
          try { ocrPages.push({ n, text: await recognize(ocrCanvas, st, status) }); }
          catch (e) { ocrError = e.message || String(e); }
        } else ocrPages.push({ n, text: '' });
        ocrCanvas.width = ocrCanvas.height = 0;
      }

      if (!save) {
        // Vorschau mit nummerierten Rahmen
        const tw = Math.min(w, 640), tk = tw / w;
        const th = mkCanvas(tw, Math.round(h * tk));
        const tctx = th.getContext('2d');
        tctx.fillStyle = '#fff'; tctx.fillRect(0, 0, th.width, th.height);
        tctx.drawImage(flat, 0, 0, th.width, th.height);
        for (const f of figs) if (f.kind !== 'drawing') tctx.drawImage(figCanvas.get(f), f.x * tk, f.y * tk, f.w * tk, f.h * tk);
        tctx.lineWidth = 2; tctx.font = 'bold 13px system-ui';
        figs.forEach((f, i) => {
          const col = f.kind !== 'drawing' ? '#f9a73b' : '#00b5a6';
          tctx.strokeStyle = col;
          tctx.strokeRect(f.x * tk, f.y * tk, f.w * tk, f.h * tk);
          tctx.fillStyle = col; tctx.fillRect(f.x * tk, f.y * tk, 22, 18);
          tctx.fillStyle = '#04110f'; tctx.fillText(String(i + 1), f.x * tk + 5, f.y * tk + 14);
        });
        thumbs.push({ n, canvas: th, count: figs.length });
      }
      canvas.width = canvas.height = inkCanvas.width = inkCanvas.height = flat.width = flat.height = 0;
      if (page) page.cleanup();
    }
  } finally { if (task) await task.destroy(); }

  const res = { figTotal, nPhotos, pages: total, thumbs, saved: [], text: '', warnings };
  if (!save) return res;

  const base = entry.name.replace(/\.(pdf|png|jpe?g|bmp|gif|webp)$/i, '');
  if (figTotal > 0) {
    const scene = buildScene(pagesOut, { outline: st.outline });
    const name = await saveBlob(base, 'excalidraw', new Blob([JSON.stringify(scene)], { type: 'application/json' }));
    res.saved.push(`${name} – ${figTotal} Element${figTotal === 1 ? '' : 'e'}, einzeln anklickbar`);
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
    catch (err) { console.error(err); saved.set(e.id, { error: err.message || String(err), saved: [], warnings: [], thumbs: [] }); }
    e.busy = false;
  }
  await closeOcr();
  saving = false; $('runState').textContent = '';
  renderResults();
  window.__aoDone = true;
};

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
      const r = c.res;
      p.className = r.figTotal ? 'ok' : 'muted';
      p.textContent = r.figTotal
        ? `${r.figTotal} Element${r.figTotal === 1 ? '' : 'e'} erkannt${r.pages > 1 ? ` auf ${r.pages} Seiten` : ''}`
        : 'Nichts Ausschneidbares gefunden – unter „Erweitert“ lässt sich das anpassen.';
      if (s) {
        const ul = document.createElement('ul');
        for (const t of s.saved || []) { const li = document.createElement('li'); li.textContent = '✓ ' + t; ul.append(li); }
        for (const t of [...(s.warnings || []), ...(s.error ? [s.error] : [])]) { const li = document.createElement('li'); li.className = 'warn'; li.textContent = t; ul.append(li); }
        card.append(ul);
      }
      const tb = document.createElement('div'); tb.className = 'thumbs';
      for (const t of r.thumbs) {
        const fig = document.createElement('figure');
        fig.append(t.canvas);
        const cap = document.createElement('figcaption'); cap.textContent = r.pages > 1 ? `Seite ${t.n}: ${t.count} Element(e)` : `${t.count} Element(e)`;
        fig.append(cap); tb.append(fig);
      }
      card.append(tb);
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
