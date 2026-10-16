# ao Notiz-Wandler (PWA)

Wandelt Notiz-PDFs (z. B. aus Huawei Notizen via PairDrop) um:

* **Raster entfernen** und jede einzeln abgrenzbare Zeichnung als **eigenes, anklickbares Bild-Element** in eine `.excalidraw`-Datei übernehmen (Name wie die PDF).
* **Fotos** (flächige Bilder, z. B. Übungsfotos A/B/C) werden als Rechteck in Originalfarben einzeln übernommen, sofern sie durch freien Rand getrennt sind. Im Modus **„Nur Bilder (freigestellt)“** werden Personen/Illustrationen mit voller Kernfläche ohne Hintergrund ausgeschnitten, Text wird ignoriert (und nur per OCR in die `.txt` übernommen).
* **OCR-Text** in eine `.txt`-Datei (gleicher Name, `Seite n`-Abschnitte).

## Benutzung
1. App öffnen (Chrome/Brave), optional „Installieren“ in der Adressleiste.
2. **PDF-Dateien wählen** (der Dialog startet im Download-Ordner) oder **Ordner öffnen** (Schreibzugriff, Ergebnisse landen direkt neben den PDFs).
3. Auswahl prüfen, bei Bedarf Einstellungen anpassen, **Umwandeln**.
4. Die Vorschau zeigt je Seite die erkannten Zeichnungen mit nummerierten Rahmen.

Ohne Ordnerzugriff speichert der Browser die Ergebnisse in seinem Download-Ordner; das ist derselbe Ordner wie die PDFs, wenn diese dort liegen.
Bereits vorhandene Dateien werden bei „Ordner öffnen“ nie überschrieben (es entsteht `name (2).txt` usw.).

## Veröffentlichen (GitHub Pages)
Den Inhalt dieses Ordners (ohne `tests/`) in ein Repository legen, unter Settings → Pages den Branch `main` / Ordner `/ (root)` aktivieren. Alle Pfade sind relativ, die App läuft auch in einem Unterpfad. Lokal testen: `python -m http.server` im Ordner und `http://localhost:8000` öffnen (Service Worker und Dateizugriff brauchen https oder localhost).

## Technik / Grenzen
* PDF-Rendering: pdf.js 6.2.108 (Legacy-Build, liegt in `lib/`). Raster-Entfernung: Farbe-zu-Alpha gegen die Papierfarbe, Rasterpunkte (sehr blass) fallen unter die Schwelle.
* OCR: Tesseract.js 5.1.1, wird beim ersten OCR-Lauf von cdn.jsdelivr.net (Bibliothek) und von dessen Standard-Quelle (Sprachdaten) geladen und danach teilweise zwischengespeichert. **Gedruckter Text** wird gut erkannt, **Handschrift** nur eingeschränkt.
* Excalidraw-Datei: Format `excalidraw` Version 2, Zeichnungen als freigestellte PNGs (transparenter Hintergrund).

## Eingabe
PDFs und Bilddateien (PNG, JPG …), per Dateiauswahl, Ordner, Drag & Drop oder Zwischenablage (Strg+V, wird sofort umgewandelt). Standardmodus: „Nur Bilder (freigestellt)“.
