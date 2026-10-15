import * as pdfjs from './lib/pdf.min.mjs';
import {
  DEFAULTS, estimateBackground, extractInk, segment, buildScene,
  bytesToDataURL, sha1Hex, buildTxt, baseName, uniqueName,
} from './core.js';

pdfjs.GlobalWorkerOptions.workerSrc = new URL('./lib/pdf.worker.min.mjs', import.meta.url).href;
const PDF_OPTS = {
  wasmUrl: new URL('./lib/wasm/', import.meta.url).href,
  standardFontDataUrl: new URL('./lib/standard_fonts/', import.meta.url).href,
  isEvalSupported: false,
};
const TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
const APP_VERSION = '1.1';
const PAGE_W = 1600; // Zielbreite beim Rendern (px)

const $ = (id) => document.getElementById(id);
let entries = [];       // {id, name, size, modified, getFile}
let dirHandle = null;   // gesetzt, wenn ein Ordner mit Schreibzugriff gewählt wurde
let running = false;

// ---------- Auswahl ----------
function setEntries(list, dir) {
  entries = list.map((e, i) => ({ ...e, id: i, checked: true }));
  dirHandle = dir || null;
  renderList();
  updateHint();
}

function updateHint() {
  $('outHint').textContent = dirHandle
    ? `Speichern in: Ordner „${dirHandle.name}“ – direkt neben den PDFs.`
    : 'Speichern in: Download-Ordner deines Browsers. Liegen die PDFs dort, landen die Ergebnisse im selben Ordner. Über „Ordner öffnen“ speichert die App direkt in den gewählten Ordner.';
}

function fmtSize(b) { return b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB'; }

function renderList() {
  const ul = $('fileList');
  ul.textContent = '';
  for (const e of entries) {
    const li = document.createElement('li');
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.checked = e.checked; cb.id = 'f' + e.id;
    cb.onchange = () => { e.checked = cb.checked; syncSelAll(); };
    const nm = document.createElement('label'); nm.className = 'nm'; nm.htmlFor = cb.id; nm.textContent = e.name;
    const meta = document.createElement('span'); meta.className = 'meta';
    meta.textContent = `${fmtSize(e.size)}${e.modified ? ' · ' + new Date(e.modified).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' }) : ''}`;
    li.append(cb, nm, meta);
    ul.append(li);
  }
  const has = entries.length > 0;
  $('listCard').hidden = !has; $('setCard').hidden = !has; $('runCard').hidden = !has;
  syncSelAll();
}
function syncSelAll() { $('selAll').checked = entries.length > 0 && entries.every((e) => e.checked); }
$('selAll').onchange = (ev) => { entries.forEach((e) => (e.checked = ev.target.checked)); renderList(); };

const pdfTypes = [{ description: 'PDF-Dateien', accept: { 'application/pdf': ['.pdf'] } }];

async function pickFiles() {
  if (!window.showOpenFilePicker) { $('fileInput').click(); return; }
  try {
    const hs = await window.showOpenFilePicker({ multiple: true, id: 'ao-pdf', startIn: 'downloads', types: pdfTypes });
    const files = await Promise.all(hs.map((h) => h.getFile()));
    setEntries(files.map((f) => ({ name: f.name, size: f.size, modified: f.lastModified, getFile: async () => f })), null);
  } catch (err) {
    if (err && err.name === 'AbortError') return;
    $('fileInput').click();
  }
}
$('btnFiles').onclick = pickFiles;
$('fileInput').onchange = (ev) => {
  const files = [...ev.target.files].filter((f) => /\.pdf$/i.test(f.name));
  ev.target.value = '';
  if (files.length) setEntries(files.map((f) => ({ name: f.name, size: f.size, modified: f.lastModified, getFile: async () => f })), null);
};

if (!window.showDirectoryPicker) $('btnDir').hidden = true;
$('btnDir').onclick = async () => {
  try {
    const dir = await window.showDirectoryPicker({ id: 'ao-dir', mode: 'readwrite', startIn: 'downloads' });
    const list = [];
    for await (const [name, h] of dir.entries()) {
      if (h.kind !== 'file' || !/\.pdf$/i.test(name)) continue;
      const f = await h.getFile();
      list.push({ name, size: f.size, modified: f.lastModified, getFile: async () => h.getFile() });
    }
    list.sort((a, b) => b.modified - a.modified);
    if (!list.length) { $('outHint').textContent = `Im Ordner „${dir.name}“ liegen keine PDF-Dateien.`; return; }
    setEntries(list, dir);
  } catch (err) {
    if (err && err.name === 'AbortError') return;
    $('outHint').textContent = 'Der Browser erlaubt diesen Ordner nicht (Chrome sperrt z. B. den Download-Ordner selbst als Ordnerauswahl). Nutze „PDF-Dateien wählen“ – die Ergebnisse landen dann im Download-Ordner.';
  }
};

// ---------- Einstellungen ----------
function settings() {
  return {
    gridCut: +$('gridCut').value, gap: +$('gap').value, minSize: +$('minSize').value,
    ocr: $('optOcr').checked, lang: $('ocrLang').value, outline: $('optOutline').checked, conf: $('optConf').checked,
  };
}
function syncOut() {
  $('oCut').textContent = (+$('gridCut').value).toFixed(2);
  $('oGap').textContent = $('gap').value + ' px';
  $('oMin').textContent = $('minSize').value + ' px';
}
['gridCut', 'gap', 'minSize'].forEach((id) => $(id).addEventListener('input', syncOut));
syncOut();

// ---------- Hilfsfunktionen: Canvas / Speichern ----------
const mkCanvas = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
const toPng = (canvas) => new Promise((res, rej) => canvas.toBlob(async (b) => {
  if (!b) return rej(new Error('PNG-Erzeugung fehlgeschlagen'));
  res(new Uint8Array(await b.arrayBuffer()));
}, 'image/png'));

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
  let lines = linesOf(data);
  if (st.conf) lines = lines.filter((l) => l.conf >= 50 && /[\p{L}\p{N}].*[\p{L}\p{N}]/u.test(l.text));
  return lines.map((l) => l.text).filter((t) => t.trim()).join('\n');
}

// ---------- Verarbeitung ----------
async function processFile(entry, st, onProgress, status) {
  const file = await entry.getFile();
  const buf = new Uint8Array(await file.arrayBuffer());
  const task = pdfjs.getDocument({ data: buf, ...PDF_OPTS });
  const doc = await task.promise;
  const pagesOut = [], ocrPages = [], thumbs = [];
  let figTotal = 0;
  try {
    for (let n = 1; n <= doc.numPages; n++) {
      onProgress((n - 1) / doc.numPages, `Seite ${n}/${doc.numPages}: rendern …`);
      const page = await doc.getPage(n);
      const v1 = page.getViewport({ scale: 1 });
      let scale = Math.min(4, Math.max(0.5, PAGE_W / v1.width));
      if (v1.width * v1.height * scale * scale > 28e6) scale = Math.sqrt(28e6 / (v1.width * v1.height));
      const vp = page.getViewport({ scale });
      const w = Math.ceil(vp.width), h = Math.ceil(vp.height);
      const canvas = mkCanvas(w, h);
      await page.render({ canvas, viewport: vp, background: '#ffffff' }).promise;
      const ctx = canvas.getContext('2d');
      const rgba = ctx.getImageData(0, 0, w, h).data;

      status(`Seite ${n}/${doc.numPages}: Raster entfernen, Zeichnungen suchen …`);
      await new Promise((r) => setTimeout(r)); // UI atmen lassen
      const bg = estimateBackground(rgba);
      const { ink, count } = extractInk(rgba, bg, st.gridCut);
      const figs = segment(ink, w, h, { gap: st.gap, minSize: st.minSize });
      figTotal += figs.length;

      const figsOut = [];
      for (const f of figs) {
        const c = mkCanvas(f.w, f.h);
        c.getContext('2d').putImageData(new ImageData(f.rgba, f.w, f.h), 0, 0);
        const dataURL = bytesToDataURL(await toPng(c));
        figsOut.push({ x: f.x, y: f.y, w: f.w, h: f.h, dataURL, fileId: await sha1Hex(dataURL) });
        f.rgba = null;
      }
      pagesOut.push({ width: w, height: h, figures: figsOut });

      // Ink-only-Canvas (weiß hinterlegt) für OCR und Vorschau
      const inkCanvas = mkCanvas(w, h);
      inkCanvas.getContext('2d').putImageData(new ImageData(ink, w, h), 0, 0);
      const flat = mkCanvas(w, h);
      const fctx = flat.getContext('2d');
      fctx.fillStyle = '#fff'; fctx.fillRect(0, 0, w, h); fctx.drawImage(inkCanvas, 0, 0);

      if (st.ocr) {
        if (count >= 200) {
          status(`Seite ${n}/${doc.numPages}: OCR …`);
          ocrPages.push({ n, text: await recognize(flat, st, status) });
        } else ocrPages.push({ n, text: '' });
      }

      // Vorschau mit nummerierten Rahmen
      const tw = Math.min(w, 520), k = tw / w;
      const th = mkCanvas(tw, Math.round(h * k));
      const tctx = th.getContext('2d');
      tctx.fillStyle = '#fff'; tctx.fillRect(0, 0, th.width, th.height);
      tctx.drawImage(flat, 0, 0, th.width, th.height);
      tctx.lineWidth = 2; tctx.font = 'bold 13px system-ui';
      figs.forEach((f, i) => {
        tctx.strokeStyle = '#00b5a6';
        tctx.strokeRect(f.x * k, f.y * k, f.w * k, f.h * k);
        tctx.fillStyle = '#00b5a6'; tctx.fillRect(f.x * k, f.y * k, 22, 18);
        tctx.fillStyle = '#04110f'; tctx.fillText(String(i + 1), f.x * k + 5, f.y * k + 14);
      });
      thumbs.push({ n, canvas: th, count: figs.length });
      canvas.width = canvas.height = inkCanvas.width = inkCanvas.height = flat.width = flat.height = 0;
      page.cleanup();
    }
  } finally { await task.destroy(); }

  const base = baseName(entry.name);
  const saved = [];
  if (figTotal > 0) {
    const scene = buildScene(pagesOut, { outline: st.outline });
    const name = await saveBlob(base, 'excalidraw', new Blob([JSON.stringify(scene)], { type: 'application/json' }));
    saved.push(`${name} – ${figTotal} Zeichnung${figTotal === 1 ? '' : 'en'}, einzeln anklickbar`);
  }
  let text = '';
  if (st.ocr) {
    text = buildTxt(entry.name, st.lang, ocrPages);
    const name = await saveBlob(base, 'txt', new Blob([text], { type: 'text/plain;charset=utf-8' }));
    saved.push(`${name} – OCR-Text`);
  }
  return { saved, thumbs, text, figTotal, pages: doc.numPages };
}

function showResult(entry, res, err) {
  const card = document.createElement('div');
  card.className = 'card res';
  const h = document.createElement('h3'); h.textContent = entry.name; card.append(h);
  const p = document.createElement('div');
  if (err) { p.className = 'err'; p.textContent = 'Fehler: ' + (err.message || err); card.append(p); }
  else {
    p.className = res.figTotal || res.saved.length ? 'ok' : 'muted';
    p.textContent = res.figTotal ? `${res.figTotal} Zeichnung(en) auf ${res.pages} Seite(n) erkannt` : 'Keine Zeichnungen gefunden – Schwelle/Abstand in den Einstellungen anpassen?';
    card.append(p);
    if (res.saved.length) {
      const ul = document.createElement('ul');
      for (const s of res.saved) { const li = document.createElement('li'); li.textContent = s; ul.append(li); }
      card.append(ul);
    }
    const tb = document.createElement('div'); tb.className = 'thumbs';
    for (const t of res.thumbs) {
      const fig = document.createElement('figure');
      fig.append(t.canvas);
      const cap = document.createElement('figcaption'); cap.textContent = `Seite ${t.n}: ${t.count} Zeichnung(en)`;
      fig.append(cap); tb.append(fig);
    }
    card.append(tb);
    if (res.text) {
      const d = document.createElement('details'); d.style.marginTop = '10px';
      const s = document.createElement('summary'); s.textContent = 'Erkannten Text anzeigen'; d.append(s);
      const pre = document.createElement('pre'); pre.textContent = res.text; pre.style.whiteSpace = 'pre-wrap'; d.append(pre);
      card.append(d);
    }
  }
  $('results').prepend(card);
}

$('btnRun').onclick = async () => {
  if (running) return;
  const sel = entries.filter((e) => e.checked);
  if (!sel.length) { $('runState').textContent = 'Bitte mindestens eine PDF auswählen.'; return; }
  running = true; $('btnRun').disabled = true; $('barWrap').hidden = false;
  $('results').textContent = '';
  const st = settings();
  const status = (t) => { $('runState').textContent = t; };
  let ok = 0;
  for (let i = 0; i < sel.length; i++) {
    const e = sel[i];
    const prog = (f, t) => { $('bar').style.width = ((i + f) / sel.length * 100).toFixed(1) + '%'; if (t) status(`${e.name} (${i + 1}/${sel.length}) – ${t}`); };
    try {
      const res = await processFile(e, st, prog, (t) => status(`${e.name} (${i + 1}/${sel.length}) – ${t}`));
      showResult(e, res); ok++;
    } catch (err) {
      console.error(err);
      showResult(e, null, err);
    }
    $('bar').style.width = ((i + 1) / sel.length * 100).toFixed(1) + '%';
  }
  await closeOcr();
  status(`Fertig: ${ok} von ${sel.length} Datei(en) umgewandelt.`);
  running = false; $('btnRun').disabled = false;
  window.__aoDone = true;
};

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
