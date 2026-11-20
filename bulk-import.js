// One-click bulk data export/import (available from the shared header menu
// on every page) — the sync mechanism
// between the Mac and iPhone installs of this app, with NO server involved:
//   - "Daten exportieren" packs the current state of all four apps into a
//     single ZIP (built natively, see buildZip()) and hands it to the OS
//     share sheet / download, so the user can save it into an iCloud Drive
//     folder that's synced on both devices.
//   - "Daten importieren" lets the user pick any ZIP file (typically the one
//     sitting in that iCloud Drive folder, fully offline — no fetch, no
//     server) and unzips it client-side using the native Compression
//     Streams API (no external library).
// Import always MERGES via a DIFF against the current state:
//   - new records are added
//   - missing fields on existing records are filled in
//   - differing fields on existing records are updated
//   - existing data is NEVER deleted or blanked out by an empty/missing
//     import value — that can only be done manually in the respective app
//   - a deliberate delete in the Blutbild app or in data.html leaves a deletion marker
//     ("Löschvermerk", BlutbildDB metadata 'deletedFiles') that is exported
//     too: on import, a file deleted here is not re-added from the ZIP
//     (only offered, unchecked, for restoring), and a file deleted on the
//     other device is offered for deletion here (red, can be unchecked)
//     — likewise for the Zeitreihen of data.html (store key 'deleted')
// Nothing is written until the user reviews a full change log and confirms.
// Running export-then-import back and forth between devices is therefore
// safe and idempotent in any order — a simple, server-free convergent sync.
//
// Files are classified by INSPECTING THEIR CONTENT on import, never by
// filename. ZIP structural/junk entries (macOS "__MACOSX/" resource forks,
// "._*" AppleDouble files, ".DS_Store", nested folder paths) are ignored.
//
// Each target app is a fully self-contained page with its own IndexedDB
// schema — there is no shared module to import from, so the minimal
// read/write logic for each database is intentionally duplicated here. If a
// target page's schema changes, this file needs a matching update.
(function () {
  'use strict';

  const importBtn = document.getElementById('btn-bulk-import');
  const exportBtn = document.getElementById('btn-bulk-export');
  const resetBtn  = document.getElementById('btn-reset-all');
  const fileInput = document.getElementById('bulk-import-input');
  if (!importBtn && !exportBtn && !resetBtn) return;

  // toISOString() is UTC-based — shortly after local midnight in timezones
  // ahead of UTC (e.g. Germany), UTC is still on the previous day, so this
  // must use local date components instead.
  function todayIso() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  // ── ZIP reading (central directory driven, ZIP32 only) ──────────────────

  async function inflateRaw(bytes) {
    const ds = new DecompressionStream('deflate-raw');
    const stream = new Blob([bytes]).stream().pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  async function unzip(arrayBuffer) {
    const view = new DataView(arrayBuffer);
    const bytes = new Uint8Array(arrayBuffer);
    const EOCD_SIG = 0x06054b50, CD_SIG = 0x02014b50, LFH_SIG = 0x04034b50;

    let eocdOffset = -1;
    const searchStart = Math.max(0, bytes.length - 22 - 65535);
    for (let i = bytes.length - 22; i >= searchStart; i--) {
      if (view.getUint32(i, true) === EOCD_SIG) { eocdOffset = i; break; }
    }
    if (eocdOffset === -1) throw new Error('Kein gültiges ZIP-Archiv gefunden (End-of-Central-Directory fehlt).');

    const entryCount = view.getUint16(eocdOffset + 10, true);
    let cdOffset = view.getUint32(eocdOffset + 16, true);

    const dec = new TextDecoder('utf-8');
    const headers = [];
    for (let i = 0; i < entryCount; i++) {
      if (view.getUint32(cdOffset, true) !== CD_SIG) throw new Error('ZIP-Struktur ungültig (Central Directory beschädigt).');
      const compressionMethod = view.getUint16(cdOffset + 10, true);
      const crc               = view.getUint32(cdOffset + 16, true);
      const compressedSize    = view.getUint32(cdOffset + 20, true);
      const uncompressedSize  = view.getUint32(cdOffset + 24, true);
      const fileNameLen       = view.getUint16(cdOffset + 28, true);
      const extraLen          = view.getUint16(cdOffset + 30, true);
      const commentLen        = view.getUint16(cdOffset + 32, true);
      const localHeaderOffset = view.getUint32(cdOffset + 42, true);
      const fileName = dec.decode(bytes.subarray(cdOffset + 46, cdOffset + 46 + fileNameLen));
      headers.push({ fileName, compressionMethod, crc, compressedSize, uncompressedSize, localHeaderOffset });
      cdOffset += 46 + fileNameLen + extraLen + commentLen;
    }

    const results = [];
    for (const h of headers) {
      if (h.fileName.endsWith('/')) continue;
      if (view.getUint32(h.localHeaderOffset, true) !== LFH_SIG) throw new Error(`ZIP-Struktur ungültig bei "${h.fileName}".`);
      const nameLen  = view.getUint16(h.localHeaderOffset + 26, true);
      const extraLen = view.getUint16(h.localHeaderOffset + 28, true);
      const dataStart = h.localHeaderOffset + 30 + nameLen + extraLen;
      const compressed = bytes.subarray(dataStart, dataStart + h.compressedSize);
      let data;
      if (h.compressionMethod === 0) data = compressed;
      else if (h.compressionMethod === 8) data = await inflateRaw(compressed);
      else throw new Error(`Nicht unterstützte ZIP-Komprimierung (Methode ${h.compressionMethod}) bei "${h.fileName}".`);
      // A half-downloaded file (e.g. iCloud Drive still syncing) must fail
      // loudly instead of importing garbage.
      if (data.length !== h.uncompressedSize || crc32(data) !== h.crc) {
        throw new Error(`Prüfsumme falsch bei "${h.fileName}" – ZIP beschädigt oder unvollständig (iCloud-Download abgeschlossen?).`);
      }
      results.push({ name: h.fileName, bytes: data });
    }
    return results;
  }

  function isJunkEntry(name) {
    const basename = name.split('/').pop();
    return name.startsWith('__MACOSX/') || basename.startsWith('._') || basename === '.DS_Store' || basename === '';
  }

  // ── ZIP writing (STORED/uncompressed — these are small text/JSON/CSV
  //    files, so skipping DEFLATE entirely keeps this simple and is still a
  //    fully standard, valid ZIP any tool can open) ───────────────────────

  function crc32(bytes) {
    let crc = ~0;
    for (let i = 0; i < bytes.length; i++) {
      crc ^= bytes[i];
      for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (0xEDB88320 & -(crc & 1));
    }
    return (~crc) >>> 0;
  }

  function dosDateTime(date) {
    const time = ((date.getHours() & 0x1F) << 11) | ((date.getMinutes() & 0x3F) << 5) | ((date.getSeconds() >> 1) & 0x1F);
    const dt = (((date.getFullYear() - 1980) & 0x7F) << 9) | (((date.getMonth() + 1) & 0xF) << 5) | (date.getDate() & 0x1F);
    return { time, date: dt };
  }

  // files: [{ name, bytes: Uint8Array }] -> Blob (application/zip)
  function buildZip(files) {
    const enc = new TextEncoder();
    const { time, date } = dosDateTime(new Date());
    const chunks = [];
    const centralRecords = [];
    let offset = 0;

    for (const f of files) {
      const nameBytes = enc.encode(f.name);
      const crc = crc32(f.bytes);
      const size = f.bytes.length;

      const local = new Uint8Array(30 + nameBytes.length);
      const lv = new DataView(local.buffer);
      lv.setUint32(0, 0x04034b50, true);
      lv.setUint16(4, 20, true);
      lv.setUint16(6, 0x0800, true); // flag: file names are UTF-8 (umlauts in blutbild/ names)
      lv.setUint16(8, 0, true); // method: stored
      lv.setUint16(10, time, true);
      lv.setUint16(12, date, true);
      lv.setUint32(14, crc, true);
      lv.setUint32(18, size, true);
      lv.setUint32(22, size, true);
      lv.setUint16(26, nameBytes.length, true);
      lv.setUint16(28, 0, true);
      local.set(nameBytes, 30);

      chunks.push(local, f.bytes);
      centralRecords.push({ nameBytes, crc, size, offset, time, date });
      offset += local.length + f.bytes.length;
    }

    const centralStart = offset;
    for (const r of centralRecords) {
      const central = new Uint8Array(46 + r.nameBytes.length);
      const cv = new DataView(central.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true);
      cv.setUint16(6, 20, true);
      cv.setUint16(8, 0x0800, true); // UTF-8 names
      cv.setUint16(10, 0, true);
      cv.setUint16(12, r.time, true);
      cv.setUint16(14, r.date, true);
      cv.setUint32(16, r.crc, true);
      cv.setUint32(20, r.size, true);
      cv.setUint32(24, r.size, true);
      cv.setUint16(28, r.nameBytes.length, true);
      cv.setUint16(30, 0, true);
      cv.setUint16(32, 0, true);
      cv.setUint16(34, 0, true);
      cv.setUint16(36, 0, true);
      cv.setUint32(38, 0, true);
      cv.setUint32(42, r.offset, true);
      central.set(r.nameBytes, 46);
      chunks.push(central);
      offset += central.length;
    }
    const centralSize = offset - centralStart;

    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, centralRecords.length, true);
    ev.setUint16(10, centralRecords.length, true);
    ev.setUint32(12, centralSize, true);
    ev.setUint32(16, centralStart, true);
    chunks.push(eocd);

    return new Blob(chunks, { type: 'application/zip' });
  }

  // ── Minimal IndexedDB helpers ────────────────────────────────────────────

  const openedDbs = [];
  function idbOpen(name, version, onUpgrade) {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(name, version);
      req.onupgradeneeded = e => onUpgrade(e.target.result);
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => db.close(); // never block another tab's reset/upgrade
        openedDbs.push(db);
        resolve(db);
      };
      req.onerror   = () => reject(req.error);
    });
  }
  function idbPut(db, store, value) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).put(value);
      tx.oncomplete = resolve;
      tx.onerror    = () => reject(tx.error);
    });
  }
  function idbRemove(db, store, keys) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite');
      keys.forEach(k => tx.objectStore(store).delete(k));
      tx.oncomplete = resolve;
      tx.onerror    = () => reject(tx.error);
    });
  }
  function idbGetAll(db, store) {
    return new Promise((resolve, reject) => {
      const req = db.transaction(store, 'readonly').objectStore(store).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror   = () => reject(req.error);
    });
  }
  function idbGet(db, store, key) {
    return new Promise((resolve, reject) => {
      const req = db.transaction(store, 'readonly').objectStore(store).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror   = () => reject(req.error);
    });
  }
  function closeAllDbs() {
    openedDbs.forEach(db => { try { db.close(); } catch (_) {} });
    openedDbs.length = 0;
  }
  // Only usable once every open connection to `name` (including any of
  // openedDbs above) has been closed — an open connection in another tab of
  // this app (e.g. plan.html) blocks it indefinitely instead of failing.
  function idbDelete(name) {
    return new Promise((resolve, reject) => {
      const req = indexedDB.deleteDatabase(name);
      req.onsuccess = () => resolve();
      req.onerror   = () => reject(req.error);
      req.onblocked = () => reject(new Error(
        `"${name}" ist noch in einem anderen Tab/Fenster dieser App geöffnet. Bitte alle anderen Tabs schließen und erneut versuchen.`
      ));
    });
  }

  // Upgrade callbacks — mirror each target page's own schema exactly.
  const upgradeBlutbild = db => {
    if (!db.objectStoreNames.contains('files')) {
      const s = db.createObjectStore('files', { keyPath: 'fileId' });
      s.createIndex('lastModified', 'lastModified', { unique: false });
    }
    if (!db.objectStoreNames.contains('metadata')) db.createObjectStore('metadata', { keyPath: 'key' });
  };
  const upgradeTimeseries = db => {
    if (!db.objectStoreNames.contains('store')) db.createObjectStore('store', { keyPath: 'key' });
  };
  const upgradePlan = db => {
    if (!db.objectStoreNames.contains('notes')) db.createObjectStore('notes', { keyPath: 'id' });
    if (!db.objectStoreNames.contains('meta'))  db.createObjectStore('meta',  { keyPath: 'key' });
  };
  const upgradeMedicalc = db => {
    if (!db.objectStoreNames.contains('invoices')) {
      const s = db.createObjectStore('invoices', { keyPath: 'id', autoIncrement: true });
      s.createIndex('date', 'date', { unique: false });
    }
    if (!db.objectStoreNames.contains('config')) db.createObjectStore('config', { keyPath: 'key' });
  };

  function isBlank(v) { return v == null || v === ''; }

  // ── CSV helpers (mirror medicalc.html's own export/import exactly) ──────

  const CSV_HEADERS = [
    'Titel', 'Datum', 'Betrag', 'Zahlungsziel', 'Bezahlt', 'BezahltAm',
    'BeihilfeEingereicht', 'BeihilfeBetrag', 'BeihilfeErstattungsdatum',
    'PKVEingereicht', 'PKVBetrag', 'PKVErstattungsdatum', 'Bemerkungen'
  ];
  function csvEscape(value) {
    const s = String(value == null ? '' : value);
    if (/[;"\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }
  function numForCsv(n) { return typeof n === 'number' && !isNaN(n) ? n.toFixed(2) : ''; }
  function invoiceToCsvRow(inv) {
    return [
      inv.title, inv.date || '', numForCsv(inv.amount), inv.dueDate || '',
      inv.paid ? 'Ja' : 'Nein', inv.paidDate || '',
      inv.beihilfeSubmitted || '', numForCsv(inv.beihilfeAmount), inv.beihilfeDate || '',
      inv.pkvSubmitted || '', numForCsv(inv.pkvAmount), inv.pkvDate || '',
      inv.notes || ''
    ].map(csvEscape).join(';');
  }
  function parseCsvRows(text) {
    const rows = [];
    let row = [], field = '', inQuotes = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQuotes) {
        if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false; }
        else field += c;
        continue;
      }
      if (c === '"') inQuotes = true;
      else if (c === ';') { row.push(field); field = ''; }
      else if (c === '\r') { /* ignore */ }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else field += c;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows.filter(r => !(r.length === 1 && r[0].trim() === ''));
  }
  function parseNumberLoose(s) {
    if (s == null || s === '') return null;
    let t = String(s).trim().replace(/[€$£\s]/g, '');
    if (t === '') return null;
    if (/^-?\d{1,3}(\.\d{3})*,\d+$/.test(t)) t = t.replace(/\./g, '').replace(',', '.');
    else if (/^-?\d+,\d+$/.test(t)) t = t.replace(',', '.');
    else if (/^-?\d{1,3}(,\d{3})*\.\d+$/.test(t)) t = t.replace(/,/g, '');
    const n = parseFloat(t);
    return isNaN(n) ? null : n;
  }
  function parseBoolLoose(s) {
    const t = String(s || '').trim().toLowerCase();
    return ['ja', 'y', 'yes', 'true', '1', 'x', '✅', '✓', '✔'].includes(t);
  }
  function parseDateLoose(s) {
    if (s == null) return '';
    const t = String(s).trim();
    if (t === '') return '';
    if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(t)) {
      const [y, mo, d] = t.split('-');
      return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
    }
    let m = t.match(/^(\d{1,2})\.(\d{1,2})\.(\d{2}|\d{4})$/);
    if (!m) m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
    if (m) {
      const d = m[1].padStart(2, '0'), mo = m[2].padStart(2, '0');
      const y = m[3].length === 2 ? '20' + m[3] : m[3];
      return `${y}-${mo}-${d}`;
    }
    return t;
  }

  // ── Content sniffing — classifies a parsed JSON payload by its shape ────

  function classifyJson(obj) {
    if (obj && typeof obj === 'object' && !Array.isArray(obj) && 'medicalcUserConfig' in obj) {
      return 'nutzer-konfiguration';
    }
    if (obj && typeof obj === 'object' && !Array.isArray(obj) && 'blutbildGeloescht' in obj) {
      return 'blutbild-loeschungen';
    }
    if (obj && typeof obj === 'object' && !Array.isArray(obj) &&
        (['radiationData', 'events', 'bpData', 'qtData', 'weightData', 'geloescht',
          ...window.MediModules.with('bulk').flatMap(m => m.bulk.payloadKeys || [])].some(k => k in obj))) {
      return 'medizinische-daten';
    }
    if (Array.isArray(obj) && obj.length > 0 && obj.every(n => n && typeof n === 'object' && 'id' in n && 'text' in n)) {
      return 'medikation-notizen';
    }
    if (obj && typeof obj === 'object' && !Array.isArray(obj) && 'fingerprint' in obj && ('context' in obj || 'result' in obj || 'systemPrompt' in obj)) {
      return 'blutbild-analyse';
    }
    if (obj && typeof obj === 'object' && !Array.isArray(obj) && 'beihilfeRate' in obj && 'eigenanteilThreshold' in obj) {
      return 'medicalc-konfiguration';
    }
    if (obj && typeof obj === 'object' && !Array.isArray(obj) && 'columnCount' in obj && 'mapping' in obj) {
      return 'medicalc-clipboard-schema';
    }
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      const vals = Object.values(obj);
      if (vals.length > 0 && vals.every(v => v && typeof v === 'object' && 'start' in v)) {
        return 'medikamente';
      }
      if (vals.length > 0 && vals.every(v => Number.isInteger(v))) {
        return 'medikamente-zusatzpackungen';
      }
    }
    return null;
  }

  // ══ EXPORT ════════════════════════════════════════════════════════════

  async function gatherExportFiles() {
    const files = [];
    const today = todayIso();
    const enc = new TextEncoder();

    try {
      const db = await idbOpen('BlutbildDB', 1, upgradeBlutbild);
      for (const r of await idbGetAll(db, 'files')) {
        if (r.ocrText) files.push({ name: `blutbild/${r.name}`, bytes: enc.encode(r.ocrText) });
      }
      const tombstones = await idbGet(db, 'metadata', BLUTBILD_TOMBSTONE_KEY);
      if (tombstones && Object.keys(tombstones.value || {}).length > 0) {
        files.push({
          name: `blutbild-loeschungen-${today}.json`,
          bytes: enc.encode(JSON.stringify({ blutbildGeloescht: tombstones.value }, null, 2)),
        });
      }
      const analyse = await idbGet(db, 'metadata', 'analyse');
      if (analyse && (analyse.context || analyse.result || analyse.systemPrompt)) {
        files.push({
          name: `blutbild-analyse-${today}.json`,
          bytes: enc.encode(JSON.stringify({
            context: analyse.context || '',
            result: analyse.result || '',
            systemPrompt: analyse.systemPrompt || '',
            fingerprint: analyse.fingerprint || '',
            timestamp: analyse.timestamp || '',
          }, null, 2)),
        });
      }
    } catch (err) { console.error('Export: Blutbild fehlgeschlagen', err); }

    try {
      const db = await idbOpen('medical-timeseries-v1', 1, upgradeTimeseries);
      const get = async key => { const r = await idbGet(db, 'store', key); return r ? r.value : undefined; };
      const radiation = await get('radiation');
      const events    = await get('events');
      const bp        = await get('bp');
      const qt        = await get('qt');
      const weight    = await get('weight');
      const payload = {};
      if (radiation) payload.radiationData = radiation;
      if (events)    payload.events = events;
      if (bp)        payload.bpData = bp;
      if (qt)        payload.qtData = qt;
      if (weight)    payload.weightData = weight;
      // Zeitreihen der Module (gleiche Datei, eigene Felder).
      for (const mod of window.MediModules.with('bulk')) {
        try { Object.assign(payload, await mod.bulk.exportPayload(get)); }
        catch (err) { console.error(`Export: Modul ${mod.id} fehlgeschlagen`, err); }
      }
      const deleted = await idbGet(db, 'store', 'deleted');
      if (deleted && deleted.value && Object.keys(deleted.value).length > 0) payload.geloescht = deleted.value;
      if (Object.keys(payload).length > 0) {
        files.push({ name: `medizinische-daten-${today}.json`, bytes: enc.encode(JSON.stringify(payload, null, 2)) });
      }
    } catch (err) { console.error('Export: Zeitreihen fehlgeschlagen', err); }

    try {
      const db = await idbOpen('med-plan-v1', 2, upgradePlan);
      const notes = await idbGetAll(db, 'notes');
      if (notes.length > 0) files.push({ name: `medikation-notizen-${today}.json`, bytes: enc.encode(JSON.stringify(notes, null, 2)) });
      const metaRec = await idbGet(db, 'meta', 'medication');
      if (metaRec && metaRec.value && Object.keys(metaRec.value).length > 0) {
        files.push({ name: `medikamente-${today}.json`, bytes: enc.encode(JSON.stringify(metaRec.value, null, 2)) });
      }
    } catch (err) { console.error('Export: Medikations-Notizen/-Liste fehlgeschlagen', err); }

    try {
      const db = await idbOpen('MediCalcDB', 1, upgradeMedicalc);
      const invoices = await idbGetAll(db, 'invoices');
      if (invoices.length > 0) {
        const BOM = String.fromCharCode(0xFEFF); // so Excel/Numbers detect UTF-8 correctly
        const rows = [CSV_HEADERS.join(';'), ...invoices.map(invoiceToCsvRow)];
        const csv = BOM + rows.join('\r\n');
        files.push({ name: `medicalc_export_${today}.csv`, bytes: enc.encode(csv) });
      }
      const config = await idbGet(db, 'config', 'settings');
      if (config) {
        files.push({
          name: `medicalc-konfiguration-${today}.json`,
          bytes: enc.encode(JSON.stringify({
            beihilfeRate: config.beihilfeRate, pkvRateLow: config.pkvRateLow,
            pkvRateHigh: config.pkvRateHigh, eigenanteilThreshold: config.eigenanteilThreshold,
          }, null, 2)),
        });
      }
    } catch (err) { console.error('Export: MediCalc fehlgeschlagen', err); }

    // localStorage-based per-page settings — not medical data, but genuine
    // user configuration that's just as lost as anything else on a
    // reset+import round-trip if it isn't carried along here too.
    try {
      const rawExtraPacks = localStorage.getItem('med-plan-extra');
      if (rawExtraPacks) {
        const parsed = JSON.parse(rawExtraPacks);
        if (parsed && Object.values(parsed).some(n => n)) {
          files.push({ name: `medikamente-zusatzpackungen-${today}.json`, bytes: enc.encode(JSON.stringify(parsed, null, 2)) });
        }
      }
    } catch (err) { console.error('Export: Medikamente-Zusatzpackungen fehlgeschlagen', err); }

    // Persönliche Konfiguration (config-user.js bzw. importiert, siehe
    // config.js) — damit eine Installation ohne eigene Dateien (z.B. GitHub
    // Pages) sie per ZIP-Import mitbekommt.
    try {
      const cfg = window.APP_CONFIG;
      if (cfg && cfg.source !== 'none') {
        files.push({
          name: `medicalc-nutzerkonfiguration-${today}.json`,
          bytes: enc.encode(JSON.stringify({ medicalcUserConfig: cfg.user }, null, 2)),
        });
      }
    } catch (err) { console.error('Export: Nutzerkonfiguration fehlgeschlagen', err); }

    try {
      const rawSchema = localStorage.getItem('medicalc-clipboard-schema-v1');
      if (rawSchema) {
        files.push({ name: `medicalc-clipboard-schema-${today}.json`, bytes: enc.encode(rawSchema) });
      }
    } catch (err) { console.error('Export: MediCalc-Clipboard-Schema fehlgeschlagen', err); }

    return files;
  }

  async function runExport() {
    const defaultLabel = exportBtn.textContent;
    exportBtn.disabled = true;
    exportBtn.textContent = '⏳ Sammle Daten …';
    try {
      const files = await gatherExportFiles();
      if (files.length === 0) { alert('Keine Daten zum Exportieren vorhanden.'); return; }

      const blob = buildZip(files);
      const fileName = `blutbild-backup-${todayIso()}.zip`;

      // Share sheet on touch devices (incl. iPad), download elsewhere — see save-file.js.
      await window.saveFile(blob, fileName);
    } catch (err) {
      console.error('Export fehlgeschlagen:', err);
      alert('Export fehlgeschlagen: ' + err.message);
    } finally {
      closeAllDbs();
      exportBtn.disabled = false;
      exportBtn.textContent = defaultLabel;
    }
  }

  // ══ IMPORT (diff-merge, never destructive) ═══════════════════════════

  function makeSection(title) {
    return { title, added: [], changed: [], removed: [], unchanged: 0 };
  }

  // Every added/changed line in the preview modal is a checkbox the user can
  // uncheck (checked by default). `commit` performs (or, for records shared
  // by several items, queues into a closure-local `merged`/`touched` pair
  // finalized separately — see the `finalizers` param below) just that one
  // item's change, so unchecking it leaves everything else untouched.
  let importItemSeq = 0;
  function makeItem(label, commit, checked = true) {
    return { id: 'imp-' + (importItemSeq++), label, commit, checked };
  }

  // Same key as blood-data.js's TOMBSTONE_KEY: { [fileName]: deletedAtISO }.
  const BLUTBILD_TOMBSTONE_KEY = 'deletedFiles';

  function formatDeletedAt(iso) {
    const d = new Date(iso);
    return isNaN(d) ? '?' : d.toLocaleDateString('de-DE');
  }

  // Blutbild records keep the name of their source file (TXT, PDF, image),
  // but the export only carries the extracted text — so an entry like
  // "blutbild/2026-10-01-Blutbild.pdf" is plain text despite its extension.
  // Anything that isn't JSON/CSV and decodes as text is such a record; a
  // genuine binary (a real PDF or image dropped into the ZIP) is not.
  const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true });
  function isBlutbildTextEntry(entry) {
    const name = entry.name.split('/').pop();
    if (/\.txt$/i.test(name)) return true;
    if (/\.(json|csv)$/i.test(name)) return false;
    const b = entry.bytes;
    if (b.length === 0 || b.includes(0)) return false;
    if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return false; // "%PDF"
    try { STRICT_UTF8.decode(b); return true; } catch { return false; }
  }

  // `remoteTombstones`: the deletion markers carried in the ZIP (from the
  // device that exported it), see the header comment.
  async function planBlutbildTxt(finalizers, entries, remoteTombstones) {
    const section = makeSection('Blutbild');
    const txtEntries = entries.filter(isBlutbildTextEntry);
    const remoteNames = Object.keys(remoteTombstones);
    if (txtEntries.length === 0 && remoteNames.length === 0) return section;

    const db = await idbOpen('BlutbildDB', 1, upgradeBlutbild);
    const existing = await idbGetAll(db, 'files');
    const existingById = new Map(existing.map(f => [f.fileId, f]));
    const localTombstones = ((await idbGet(db, 'metadata', BLUTBILD_TOMBSTONE_KEY)) || {}).value || {};
    const dec = new TextDecoder('utf-8');

    // Marker changes are collected here and written once, after all item
    // commits (same finalizer pattern as the merged Zeitreihen records).
    const tombstones = { ...localTombstones };
    let touched = false;
    finalizers.push(() => touched ? (() => idbPut(db, 'metadata', { key: BLUTBILD_TOMBSTONE_KEY, value: tombstones })) : null);
    const liftTombstone = name => { if (name in tombstones) { delete tombstones[name]; touched = true; } };

    for (const entry of txtEntries) {
      const name = entry.name.split('/').pop();
      const text = dec.decode(entry.bytes);
      const fileId = name;
      const prev = existingById.get(fileId);
      const add = () => {
        liftTombstone(name);
        return idbPut(db, 'files', {
          fileId, name, path: name, ocrText: text, status: 'success',
          scanDate: new Date().toISOString(), lastModified: Date.now(),
        });
      };
      if (!prev && localTombstones[name]) {
        // Deleted here on purpose — the ZIP just predates that delete (or
        // the other device hasn't imported it yet). Only restore on request.
        section.added.push(makeItem(`${name} (hier am ${formatDeletedAt(localTombstones[name])} gelöscht – wiederherstellen?)`, add, false));
      } else if (!prev) {
        section.added.push(makeItem(name, add));
      } else if (!isBlank(text) && text !== prev.ocrText) {
        section.changed.push(makeItem(`${name}: Text geändert`, () => idbPut(db, 'files', {
          ...prev, ocrText: text, status: 'success',
          scanDate: new Date().toISOString(), lastModified: Date.now(),
        })));
      } else {
        section.unchanged++;
      }
    }

    for (const name of remoteNames) {
      const deletedAt = remoteTombstones[name];
      if (typeof deletedAt !== 'string') continue;
      // By name, not key — mirrors blood-data.js's deleteFileFromStorage.
      const local = existing.filter(f => f.name === name);
      if (local.length === 0) {
        // Nothing to delete here; just remember the marker, so this device
        // also refuses an older ZIP that still has the file.
        if (!tombstones[name] || tombstones[name] < deletedAt) { tombstones[name] = deletedAt; touched = true; }
        continue;
      }
      // Re-added here after it was deleted over there: keep by default.
      const newerHere = local.some(f => (f.scanDate || '') > deletedAt);
      const label = `${name} (auf dem anderen Gerät am ${formatDeletedAt(deletedAt)} gelöscht${newerHere ? ', hier danach neu hinzugefügt' : ''})`;
      section.removed.push(makeItem(label, () => {
        tombstones[name] = deletedAt;
        touched = true;
        return idbRemove(db, 'files', local.map(f => f.fileId));
      }, !newerHere));
    }
    return section;
  }

  // Löschvermerke der Zeitreihen (Store-Key 'deleted', { id: Zeitpunkt }). Die
  // ID-Bildung steht identisch in data.html (TOMB) bzw. im jeweiligen Modul —
  // beide Stellen abgleichen.
  const TS_ID = {
    rad:    date => `rad|${date}`,
    evt:    e => `evt|${e.begin}|${e.desc}`,
    bp:     b => `bp|${b.date}|${b.time}`,
    qt:     q => `qt|${q.date}|${q.qt}`,
    weight: w => `weight|${w.date}|${w.kg}`,
  };

  // Module (config-user.js → privateScripts) gleichen ihre eigenen Zeitreihen
  // über denselben Kontext ab wie die eingebauten unten: mod.bulk.planImport(
  // payload, ctx). ctx.work(storeKey, leer) liefert die Arbeitskopie eines
  // Store-Eintrags (einmal geladen, von allen geteilt), ctx.add/changed/
  // unchanged füllen die Vorschau, ctx.dirty/set markieren zum Schreiben,
  // ctx.remover(präfix, fn) bietet auf dem anderen Gerät Gelöschtes an.
  async function planMedizinischeDaten(finalizers, payload) {
    const section = makeSection('Zeitreihen');
    const db = await idbOpen('medical-timeseries-v1', 1, upgradeTimeseries);
    const val = async key => ((await idbGet(db, 'store', key)) || {}).value;

    // Ein gemeinsamer Datenstand je Store-Key: Hinzufügen/Ändern und Löschen
    // arbeiten darauf, geschrieben wird je Key einmal im Finalizer unten.
    const work = {};
    const sorters = {};
    const dirty = new Set();
    const removers = {};

    const localTomb  = (await val('deleted')) || {};
    const remoteTomb = (payload.geloescht && typeof payload.geloescht === 'object') ? payload.geloescht : {};
    const tomb = { ...localTomb };
    let tombDirty = false;
    const deletedOn = iso => { const d = new Date(iso); return isNaN(d) ? '?' : d.toLocaleDateString('de-DE'); };

    // Neu hinzuzufügender Eintrag: wurde er hier bewusst gelöscht, ist die
    // Zeile nicht vorausgewählt und hebt beim Übernehmen den Vermerk auf.
    const addItem = (id, label, commit) => {
      if (localTomb[id]) {
        section.added.push(makeItem(`${label} (hier am ${deletedOn(localTomb[id])} gelöscht – wiederherstellen?)`, () => {
          commit(); delete tomb[id]; tombDirty = true;
        }, false));
      } else {
        section.added.push(makeItem(label, commit));
      }
    };

    const ctx = {
      async work(key, empty) {
        if (!(key in work)) {
          const v = await val(key);
          work[key] = Array.isArray(empty) ? (Array.isArray(v) ? v.slice() : []) : { ...(v || {}) };
        }
        return work[key];
      },
      get: key => work[key],
      set: (key, value) => { work[key] = value; dirty.add(key); },
      dirty: key => { dirty.add(key); },
      sortOnWrite: (key, fn) => { sorters[key] = fn; },
      add: addItem,
      changed: (label, commit) => { section.changed.push(makeItem(label, commit)); },
      unchanged: () => { section.unchanged++; },
      remover: (prefix, fn) => { removers[prefix] = fn; },
      isBlank,
    };

    const rad    = await ctx.work('radiation', {});
    const events = await ctx.work('events', []);
    const bp     = await ctx.work('bp', []);
    const qt     = await ctx.work('qt', []);
    const weight = await ctx.work('weight', []);
    ctx.sortOnWrite('events', (a, b) => a.begin.localeCompare(b.begin));
    ctx.sortOnWrite('bp', (a, b) => a.date.localeCompare(b.date) || (a.time === b.time ? 0 : a.time === 'abends' ? 1 : -1));
    ctx.sortOnWrite('qt', (a, b) => a.date.localeCompare(b.date));
    ctx.sortOnWrite('weight', (a, b) => a.date.localeCompare(b.date));

    if (payload.radiationData) {
      for (const [date, rec] of Object.entries(payload.radiationData)) {
        const prev = rad[date];
        if (!prev) {
          addItem(TS_ID.rad(date), `Strahlung ${date}: ${rec.typ} (${rec.dose} mSv)`, () => { rad[date] = rec; ctx.dirty('radiation'); });
        } else if (JSON.stringify(prev) !== JSON.stringify(rec)) {
          section.changed.push(makeItem(`Strahlung ${date}: ${prev.dose} → ${rec.dose} mSv`, () => { rad[date] = rec; ctx.dirty('radiation'); }));
        } else section.unchanged++;
      }
    }

    if (Array.isArray(payload.events)) {
      const base = events.slice();
      for (const evt of payload.events) {
        const idx = base.findIndex(e => e.begin === evt.begin && e.desc === evt.desc);
        if (idx === -1) {
          addItem(TS_ID.evt(evt), `Ereignis ${evt.begin} ${evt.desc}`, () => { ctx.get('events').push(evt); ctx.dirty('events'); });
        } else if (!isBlank(evt.end) && base[idx].end !== evt.end) {
          section.changed.push(makeItem(`Ereignis ${evt.begin} ${evt.desc}: Ende ${base[idx].end || '–'} → ${evt.end}`, () => {
            const list = ctx.get('events');
            const i = list.findIndex(e => e.begin === evt.begin && e.desc === evt.desc);
            if (i !== -1) { list[i] = { ...list[i], end: evt.end }; ctx.dirty('events'); }
          }));
        } else section.unchanged++;
      }
    }

    if (Array.isArray(payload.bpData)) {
      const base = bp.slice();
      for (const b of payload.bpData) {
        const idx = base.findIndex(x => x.date === b.date && x.time === b.time);
        if (idx === -1) {
          addItem(TS_ID.bp(b), `Blutdruck ${b.date} ${b.time}: ${b.sys}/${b.dia}${b.pulse != null ? ', Puls ' + b.pulse : ''}`, () => {
            ctx.get('bp').push(b); ctx.dirty('bp');
          });
        } else {
          const prev = base[idx];
          if (prev.sys !== b.sys || prev.dia !== b.dia || (!isBlank(b.pulse) && b.pulse !== prev.pulse)) {
            section.changed.push(makeItem(`Blutdruck ${b.date} ${b.time}: ${prev.sys}/${prev.dia} → ${b.sys}/${b.dia}`, () => {
              const list = ctx.get('bp');
              const i = list.findIndex(x => x.date === b.date && x.time === b.time);
              if (i !== -1) { list[i] = { ...prev, sys: b.sys, dia: b.dia, pulse: isBlank(b.pulse) ? prev.pulse : b.pulse }; ctx.dirty('bp'); }
            }));
          } else section.unchanged++;
        }
      }
    }

    if (Array.isArray(payload.qtData)) {
      const base = qt.slice();
      // Identity: date + qt value — matches "same measurement" without a
      // time-of-day field; a different qt on the same date is treated as a
      // genuinely separate reading (e.g. before/after a dose) rather than a
      // duplicate to merge.
      for (const q of payload.qtData) {
        const idx = base.findIndex(x => x.date === q.date && x.qt === q.qt);
        if (idx === -1) {
          addItem(TS_ID.qt(q), `QT ${q.date}: ${q.qt} ms (RR ${q.rr} ms)`, () => { ctx.get('qt').push(q); ctx.dirty('qt'); });
        } else {
          const prev = base[idx];
          const updated = { ...prev };
          let rowTouched = false;
          for (const field of ['hf', 'rr', 'diff', 'threshold']) {
            if (isBlank(q[field])) continue;
            if (isBlank(prev[field]) || prev[field] !== q[field]) { updated[field] = q[field]; rowTouched = true; }
          }
          if (rowTouched) {
            section.changed.push(makeItem(`QT ${q.date}: aktualisiert`, () => {
              const list = ctx.get('qt');
              const i = list.findIndex(x => x.date === q.date && x.qt === q.qt);
              if (i !== -1) { list[i] = updated; ctx.dirty('qt'); }
            }));
          } else section.unchanged++;
        }
      }
    }

    if (Array.isArray(payload.weightData)) {
      // Identity: date + kg, like qt — a different weight on the same date
      // is treated as a separate reading rather than overwriting one.
      for (const w of payload.weightData) {
        const idx = weight.findIndex(x => x.date === w.date && x.kg === w.kg);
        if (idx === -1) {
          addItem(TS_ID.weight(w), `Gewicht ${w.date}: ${w.kg} kg`, () => { ctx.get('weight').push(w); ctx.dirty('weight'); });
        } else section.unchanged++;
      }
    }

    // Auf dem anderen Gerät bewusst Gelöschtes: als rote, abwählbare Zeilen
    // anbieten. Ohne Zeitstempel an den Einträgen lässt sich ein dort
    // gelöschter und hier danach neu erfasster Eintrag nicht unterscheiden —
    // deshalb steht das Löschdatum in der Zeile.
    const listRemover = (key, idFn, label) => rest => ctx.get(key).some(x => idFn(x) === rest) && {
      label: label(rest),
      remove: () => { ctx.set(key, ctx.get(key).filter(x => idFn(x) !== rest)); },
    };
    removers.rad = rest => rad[rest] && {
      label: `Strahlung ${rest}`,
      remove: () => { delete rad[rest]; ctx.dirty('radiation'); },
    };
    removers.evt    = listRemover('events', e => TS_ID.evt(e).slice(4),    rest => `Ereignis ${rest.replace('|', ' ')}`);
    removers.bp     = listRemover('bp',     x => TS_ID.bp(x).slice(3),     rest => `Blutdruck ${rest.replace('|', ' ')}`);
    removers.qt     = listRemover('qt',     x => TS_ID.qt(x).slice(3),     rest => `QT ${rest.replace('|', ': ')} ms`);
    removers.weight = listRemover('weight', x => TS_ID.weight(x).slice(7), rest => `Gewicht ${rest.replace('|', ': ')} kg`);

    for (const mod of window.MediModules.with('bulk')) {
      await mod.bulk.planImport(payload, ctx);
    }

    for (const [id, at] of Object.entries(remoteTomb)) {
      if (typeof at !== 'string') continue;
      const sep = id.indexOf('|');
      const fn = removers[id.slice(0, sep)];
      const hit = fn && fn(id.slice(sep + 1));
      if (!hit) {
        // Hier nichts zu löschen (oder Modul hier nicht installiert) — Vermerk
        // nur merken, damit auch dieses Gerät eine ältere ZIP mit dem Eintrag
        // nicht mehr automatisch anlegt.
        if (!tomb[id] || tomb[id] < at) { tomb[id] = at; tombDirty = true; }
        continue;
      }
      section.removed.push(makeItem(`${hit.label} (auf dem anderen Gerät am ${deletedOn(at)} gelöscht)`, () => {
        hit.remove(); tomb[id] = at; tombDirty = true;
      }));
    }

    const put = (storeKey, value) => () => idbPut(db, 'store', { key: storeKey, value });
    finalizers.push(() => {
      const ops = [...dirty].map(key => put(key, sorters[key] && Array.isArray(work[key]) ? work[key].sort(sorters[key]) : work[key]));
      if (tombDirty) ops.push(put('deleted', tomb));
      if (ops.length === 0) return null;
      return async () => { for (const op of ops) await op(); };
    });

    return section;
  }

  async function planNotes(finalizers, notes) {
    const section = makeSection('Medikations-Notizen');
    if (!Array.isArray(notes) || notes.length === 0) return section;
    const db = await idbOpen('med-plan-v1', 2, upgradePlan);
    const existingById = new Map((await idbGetAll(db, 'notes')).map(n => [n.id, n]));
    for (const n of notes) {
      if (!n || !n.id) continue;
      const prev = existingById.get(n.id);
      if (!prev) {
        section.added.push(makeItem(n.id, () => idbPut(db, 'notes', n)));
      } else if (!isBlank(n.text) && n.text !== prev.text) {
        section.changed.push(makeItem(`${n.id}: „${prev.text}“ → „${n.text}“`, () => idbPut(db, 'notes', { ...prev, ...n })));
      } else {
        section.unchanged++;
      }
    }
    return section;
  }

  // Medication fields are mostly scalars, but `durationChanges` (plan.html)
  // is an array of { from, duration } — compare by content, not reference,
  // and render it readably instead of "[object Object]".
  function sameMedValue(a, b) {
    return (a !== null && typeof a === 'object') || (b !== null && typeof b === 'object')
      ? JSON.stringify(a) === JSON.stringify(b)
      : a === b;
  }
  function medFieldLabel(field, value) {
    if (field === 'durationChanges' && Array.isArray(value)) {
      if (value.length === 0) return '(keine)';
      return value.map(c => {
        const d = c && typeof c.from === 'string' ? new Date(c.from + 'T00:00') : null;
        return `${c && c.duration} Tage ab ${d && !isNaN(d) ? d.toLocaleDateString('de-DE') : '?'}`;
      }).join(', ');
    }
    return value !== null && typeof value === 'object' ? JSON.stringify(value) : String(value);
  }

  async function planMedikamente(finalizers, medication) {
    const section = makeSection('Medikamente');
    if (!medication || typeof medication !== 'object') return section;
    const db = await idbOpen('med-plan-v1', 2, upgradePlan);
    const metaRec = await idbGet(db, 'meta', 'medication');
    const existing = (metaRec && metaRec.value) || {};
    const merged = { ...existing };
    let touched = false;

    for (const [name, incoming] of Object.entries(medication)) {
      const prev = existing[name];
      if (!prev) {
        section.added.push(makeItem(name, () => { merged[name] = incoming; touched = true; }));
        continue;
      }
      let anyDiff = false;
      for (const [field, value] of Object.entries(incoming)) {
        if (isBlank(value)) continue;
        if (isBlank(prev[field])) {
          anyDiff = true;
          section.added.push(makeItem(`${name}: ${field} = ${medFieldLabel(field, value)}`, () => {
            merged[name] = { ...(merged[name] || prev), [field]: value }; touched = true;
          }));
        } else if (!sameMedValue(prev[field], value)) {
          anyDiff = true;
          section.changed.push(makeItem(`${name}: ${field} ${medFieldLabel(field, prev[field])} → ${medFieldLabel(field, value)}`, () => {
            merged[name] = { ...(merged[name] || prev), [field]: value }; touched = true;
          }));
        }
      }
      if (!anyDiff) section.unchanged++;
    }

    finalizers.push(() => touched ? (() => idbPut(db, 'meta', { key: 'medication', value: merged })) : null);
    return section;
  }

  async function planMedicalcCsv(finalizers, text) {
    const section = makeSection('MediCalc');
    const db = await idbOpen('MediCalcDB', 1, upgradeMedicalc);
    const existing = await idbGetAll(db, 'invoices');
    const clean = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
    const rows = parseCsvRows(clean);
    if (rows.length < 2) return section;
    const header = rows[0].map(h => h.trim().toLowerCase());
    const idx = name => header.indexOf(name.toLowerCase());
    const FIELDS = ['dueDate', 'beihilfeSubmitted', 'beihilfeAmount', 'beihilfeDate', 'pkvSubmitted', 'pkvAmount', 'pkvDate', 'notes'];

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const title  = row[idx('Titel')] || '';
      const date   = parseDateLoose(row[idx('Datum')]);
      const amount = parseNumberLoose(row[idx('Betrag')]);
      if (!title || !date || amount == null) continue;

      const incoming = {
        title, date, amount,
        dueDate: parseDateLoose(row[idx('Zahlungsziel')]),
        paid: parseBoolLoose(row[idx('Bezahlt')]),
        paidDate: parseDateLoose(row[idx('BezahltAm')]),
        beihilfeSubmitted: parseDateLoose(row[idx('BeihilfeEingereicht')]),
        beihilfeAmount: parseNumberLoose(row[idx('BeihilfeBetrag')]),
        beihilfeDate: parseDateLoose(row[idx('BeihilfeErstattungsdatum')]),
        pkvSubmitted: parseDateLoose(row[idx('PKVEingereicht')]),
        pkvAmount: parseNumberLoose(row[idx('PKVBetrag')]),
        pkvDate: parseDateLoose(row[idx('PKVErstattungsdatum')]),
        notes: row[idx('Bemerkungen')] || ''
      };

      // Identity: CSV rows carry no stable id, so (Titel, Datum, Betrag) is
      // used as the natural composite key to recognize "the same invoice".
      const prev = existing.find(inv =>
        inv.title === incoming.title && inv.date === incoming.date && Math.abs((inv.amount || 0) - incoming.amount) < 0.005
      );
      const label = `${incoming.title} (${incoming.date}, ${incoming.amount.toFixed(2)} €)`;

      if (!prev) {
        section.added.push(makeItem(label, () => idbPut(db, 'invoices', incoming)));
        continue;
      }

      const merged = { ...prev };
      let touched = false;
      let anyDiff = false;

      if (incoming.paid === true && !prev.paid) {
        anyDiff = true;
        section.changed.push(makeItem(`${label}: Bezahlt Nein → Ja`, () => { merged.paid = true; touched = true; }));
      }

      for (const field of FIELDS) {
        const val = incoming[field];
        if (isBlank(val)) continue;
        if (isBlank(prev[field])) {
          anyDiff = true;
          section.added.push(makeItem(`${label}: ${field} = ${val}`, () => { merged[field] = val; touched = true; }));
        } else {
          const differs = typeof val === 'number' ? Math.abs(val - prev[field]) >= 0.005 : val !== prev[field];
          if (differs) {
            anyDiff = true;
            section.changed.push(makeItem(`${label}: ${field} ${prev[field]} → ${val}`, () => { merged[field] = val; touched = true; }));
          }
        }
      }

      if (anyDiff) finalizers.push(() => touched ? (() => idbPut(db, 'invoices', merged)) : null);
      else section.unchanged++;
    }
    return section;
  }

  async function planBlutbildAnalyse(finalizers, payload) {
    const section = makeSection('KI-Analyse (Patientenkontext, System-Prompt & Ergebnis)');
    const db = await idbOpen('BlutbildDB', 1, upgradeBlutbild);
    const existing = (await idbGet(db, 'metadata', 'analyse')) || { key: 'analyse' };
    const merged = { ...existing };
    let touched = false;

    let anyDiff = false;
    if (!isBlank(payload.context) && payload.context !== existing.context) {
      anyDiff = true;
      (isBlank(existing.context) ? section.added : section.changed).push(makeItem('Patientenkontext', () => {
        merged.context = payload.context; touched = true;
      }));
    }
    if (!isBlank(payload.systemPrompt) && payload.systemPrompt !== existing.systemPrompt) {
      anyDiff = true;
      (isBlank(existing.systemPrompt) ? section.added : section.changed).push(makeItem('System-Prompt', () => {
        merged.systemPrompt = payload.systemPrompt; touched = true;
      }));
    }
    if (!isBlank(payload.result) && payload.result !== existing.result) {
      anyDiff = true;
      (isBlank(existing.result) ? section.added : section.changed).push(makeItem('KI-Analyse-Ergebnis', () => {
        merged.result = payload.result;
        merged.fingerprint = payload.fingerprint;
        merged.timestamp = payload.timestamp;
        touched = true;
      }));
    }
    if (!anyDiff) section.unchanged++;

    finalizers.push(() => touched ? (() => idbPut(db, 'metadata', merged)) : null);
    return section;
  }

  async function planMedicalcConfig(finalizers, payload) {
    const section = makeSection('MediCalc-Konfiguration');
    const db = await idbOpen('MediCalcDB', 1, upgradeMedicalc);
    const existing = (await idbGet(db, 'config', 'settings')) || { key: 'settings' };
    const merged = { ...existing };
    let touched = false;
    let anyDiff = false;
    const FIELDS = ['beihilfeRate', 'pkvRateLow', 'pkvRateHigh', 'eigenanteilThreshold'];

    for (const field of FIELDS) {
      const val = payload[field];
      if (isBlank(val)) continue;
      if (isBlank(existing[field])) {
        anyDiff = true;
        section.added.push(makeItem(`${field} = ${val}`, () => { merged[field] = val; touched = true; }));
      } else if (Math.abs(val - existing[field]) >= 0.0005) {
        anyDiff = true;
        section.changed.push(makeItem(`${field}: ${existing[field]} → ${val}`, () => { merged[field] = val; touched = true; }));
      }
    }
    if (!anyDiff) section.unchanged++;

    finalizers.push(() => touched ? (() => idbPut(db, 'config', merged)) : null);
    return section;
  }

  // Not an IndexedDB record — reads/writes localStorage directly, but is
  // still queued through `finalizers` so it participates in the same
  // "nothing is written until the user confirms" flow as everything else.
  async function planExtraPacks(finalizers, payload) {
    const section = makeSection('Medikamente-Zusatzpackungen');
    let existing = {};
    try { existing = JSON.parse(localStorage.getItem('med-plan-extra') || '{}') || {}; } catch (_) {}
    const merged = { ...existing };
    let touched = false;

    for (const [name, value] of Object.entries(payload)) {
      if (!Number.isInteger(value)) continue;
      const prev = existing[name] || 0;
      if (value !== 0 && prev === 0) {
        section.added.push(makeItem(`${name}: ${value}`, () => { merged[name] = value; touched = true; }));
      } else if (value !== prev) {
        section.changed.push(makeItem(`${name}: ${prev} → ${value}`, () => { merged[name] = value; touched = true; }));
      } else {
        section.unchanged++;
      }
    }

    finalizers.push(() => touched ? (() => { localStorage.setItem('med-plan-extra', JSON.stringify(merged)); }) : null);
    return section;
  }

  async function planClipboardSchema(finalizers, payload) {
    const section = makeSection('MediCalc-Clipboard-Schema');
    const raw = localStorage.getItem('medicalc-clipboard-schema-v1');
    const existing = raw ? JSON.parse(raw) : null;
    const write = () => { localStorage.setItem('medicalc-clipboard-schema-v1', JSON.stringify(payload)); };
    if (!existing) {
      section.added.push(makeItem('Spalten-Schema übernommen', write));
    } else if (JSON.stringify(existing) !== JSON.stringify(payload)) {
      section.changed.push(makeItem('Spalten-Schema aktualisiert', write));
    } else {
      section.unchanged++;
    }
    return section;
  }

  // Nutzerkonfiguration aus der ZIP: wird (nach Bestätigung) auf diesem Gerät
  // hinterlegt und gilt ab dem Neuladen. Hat diese Installation eine eigene
  // config-user.js, ist die Zeile nicht vorausgewählt — die importierte
  // Fassung hätte sonst Vorrang vor der Datei.
  async function planUserConfig(finalizers, payload) {
    const section = makeSection('Nutzerkonfiguration');
    const cfg = window.APP_CONFIG;
    let incoming;
    try { incoming = cfg.parseUserConfig(JSON.stringify(payload)); } catch (err) { console.warn('Nutzerkonfiguration ungültig', err); return section; }
    // Schlüsselreihenfolge auf allen Ebenen egal (Datei vs. JSON-Export).
    const canonical = v => JSON.stringify(v, (_, x) => (x && typeof x === 'object' && !Array.isArray(x))
      ? Object.fromEntries(Object.keys(x).sort().map(k => [k, x[k]])) : x);
    if (cfg.source !== 'none' && canonical(incoming) === canonical(JSON.parse(JSON.stringify(cfg.user)))) {
      section.unchanged++;
      return section;
    }
    const write = () => { cfg.saveImportedUserConfig(incoming, 'ZIP-Import'); };
    if (cfg.source === 'none') {
      section.added.push(makeItem('Nutzerkonfiguration übernehmen', write));
    } else if (cfg.source === 'import') {
      section.changed.push(makeItem('Nutzerkonfiguration aktualisieren', write));
    } else {
      section.changed.push(makeItem('Nutzerkonfiguration übernehmen (hier gilt bisher config-user.js)', write, false));
    }
    return section;
  }

  // ── Preview modal (self-contained, inline styles) ───────────────────────

  function renderPreviewModal(sections) {
    return new Promise(resolve => {
      const overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(5,8,15,0.75);display:flex;align-items:center;justify-content:center;padding:1.5rem;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;';

      const card = document.createElement('div');
      card.style.cssText = 'background:#141929;border:1px solid #2a3450;border-radius:12px;max-width:600px;width:100%;max-height:85vh;display:flex;flex-direction:column;box-shadow:0 20px 60px rgba(0,0,0,0.5);';

      const header = document.createElement('div');
      header.style.cssText = 'padding:1.25rem 1.5rem 0.75rem;border-bottom:1px solid #2a3450;';
      header.innerHTML = '<h2 style="margin:0;font-size:1.1rem;color:#e2e8f0;">Import-Vorschau</h2><p style="margin:0.35rem 0 0;font-size:0.8rem;color:#64748b;">Es wird nur ergänzt oder aktualisiert. Gelöscht wird nur, was auf einem anderen Gerät bewusst gelöscht wurde (rot markiert). Jede Zeile lässt sich abwählen.</p>';

      const body = document.createElement('div');
      body.style.cssText = 'padding:0.75rem 1.5rem;overflow-y:auto;flex:1;font-size:0.83rem;color:#cbd5e1;line-height:1.55;';

      // Every added/changed row carries its own checkbox (checked by
      // default) so the user can deselect individual lines before
      // confirming; itemsById lets the delegated change-listener below map
      // a checkbox back to the item whose `checked` flag it controls.
      const itemsById = new Map();
      let totalAdded = 0, totalChanged = 0, totalRemoved = 0, checkedCount = 0;

      function itemLi(item) {
        itemsById.set(item.id, item);
        if (item.checked) checkedCount++;
        // Reset the page-wide `label { text-transform: uppercase; ... }`
        // rule (style.css, meant for form field labels) — it cascades onto
        // any <label> regardless of context, which was silently
        // upper-casing every filename/line shown here.
        return `<li style="list-style:none;"><label style="display:flex;gap:0.4rem;align-items:flex-start;cursor:pointer;text-transform:none;letter-spacing:normal;font-weight:normal;color:inherit;font-size:inherit;">` +
          `<input type="checkbox" data-item-id="${item.id}"${item.checked ? ' checked' : ''} style="margin-top:0.2rem;flex-shrink:0;accent-color:#3b82f6;">` +
          `<span>${escapeHtml(item.label)}</span></label></li>`;
      }

      sections.forEach(s => {
        totalAdded += s.added.length;
        totalChanged += s.changed.length;
        totalRemoved += s.removed.length;
        if (s.added.length === 0 && s.changed.length === 0 && s.removed.length === 0) return;
        const sec = document.createElement('div');
        sec.style.cssText = 'margin-bottom:1rem;';
        let html = `<div style="font-weight:700;color:#4f9cf9;font-size:0.78rem;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:0.35rem;">${s.title}</div>`;
        if (s.added.length) html += `<div style="color:#22c55e;margin-bottom:0.15rem;">+ ${s.added.length} neu</div><ul style="margin:0 0 0.4rem 0;padding:0;color:#94a3b8;">${s.added.map(itemLi).join('')}</ul>`;
        if (s.changed.length) html += `<div style="color:#f59e0b;margin-bottom:0.15rem;">~ ${s.changed.length} geändert/ergänzt</div><ul style="margin:0 0 0.4rem 0;padding:0;color:#94a3b8;">${s.changed.map(itemLi).join('')}</ul>`;
        if (s.removed.length) html += `<div style="color:#ef4444;margin-bottom:0.15rem;">− ${s.removed.length} löschen</div><ul style="margin:0;padding:0;color:#94a3b8;">${s.removed.map(itemLi).join('')}</ul>`;
        sec.innerHTML = html;
        body.appendChild(sec);
      });

      if (totalAdded === 0 && totalChanged === 0 && totalRemoved === 0) {
        body.innerHTML = '<p style="color:#64748b;">Keine Unterschiede zum aktuellen Stand gefunden.</p>';
      }

      const footer = document.createElement('div');
      footer.style.cssText = 'padding:1rem 1.5rem;display:flex;gap:0.6rem;justify-content:flex-end;border-top:1px solid #2a3450;';
      const cancelBtn = document.createElement('button');
      cancelBtn.textContent = 'Abbrechen';
      cancelBtn.style.cssText = 'background:transparent;color:#94a3b8;border:1px solid #2a3450;border-radius:6px;padding:0.5rem 1rem;font-size:0.85rem;cursor:pointer;font-family:inherit;';
      const confirmBtn = document.createElement('button');
      confirmBtn.style.cssText = 'color:#fff;border:none;border-radius:6px;padding:0.5rem 1.1rem;font-size:0.85rem;font-weight:600;cursor:pointer;font-family:inherit;';

      function updateConfirmBtn() {
        confirmBtn.textContent = checkedCount > 0 ? `Übernehmen (${checkedCount})` : 'Schließen';
        confirmBtn.style.background = checkedCount > 0 ? '#3b82f6' : '#2a3450';
      }
      updateConfirmBtn();

      body.addEventListener('change', e => {
        const id = e.target && e.target.dataset && e.target.dataset.itemId;
        if (!id) return;
        const item = itemsById.get(id);
        if (!item) return;
        item.checked = e.target.checked;
        checkedCount += item.checked ? 1 : -1;
        updateConfirmBtn();
      });

      footer.appendChild(cancelBtn);
      footer.appendChild(confirmBtn);
      card.appendChild(header);
      card.appendChild(body);
      card.appendChild(footer);
      overlay.appendChild(card);
      document.body.appendChild(overlay);

      function finish(result) { overlay.remove(); resolve(result); }
      cancelBtn.addEventListener('click', () => finish(false));
      confirmBtn.addEventListener('click', () => finish(checkedCount > 0));
      overlay.addEventListener('click', e => { if (e.target === overlay) finish(false); });
    });
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  async function runImport(file) {
    const defaultLabel = importBtn.textContent;
    importBtn.disabled = true;
    importBtn.textContent = '⏳ Entpacke …';

    try {
      const buf = await file.arrayBuffer();
      const allEntries = await unzip(buf);
      const entries = allEntries.filter(e => !isJunkEntry(e.name));
      if (entries.length === 0) throw new Error('Die ZIP-Datei enthält keine verwertbaren Dateien.');

      importBtn.textContent = '⏳ Vergleiche mit vorhandenen Daten …';
      const dec = new TextDecoder('utf-8');
      const finalizers = [];
      const sections = [];
      const skipped = [];

      // Deletion markers first: planBlutbildTxt needs them to tell a file
      // deleted over there from one that is simply missing here.
      const remoteTombstones = {};
      const parsedJson = new Map();
      for (const entry of entries) {
        const name = entry.name.split('/').pop();
        if (!/\.json$/i.test(name)) continue;
        try { parsedJson.set(entry, JSON.parse(dec.decode(entry.bytes))); } catch { continue; }
        const obj = parsedJson.get(entry);
        if (classifyJson(obj) === 'blutbild-loeschungen' && obj.blutbildGeloescht && typeof obj.blutbildGeloescht === 'object') {
          Object.assign(remoteTombstones, obj.blutbildGeloescht);
        }
      }
      sections.push(await planBlutbildTxt(finalizers, entries, remoteTombstones));

      for (const entry of entries) {
        const name = entry.name.split('/').pop();
        if (isBlutbildTextEntry(entry)) continue; // handled above
        if (/\.json$/i.test(name)) {
          if (!parsedJson.has(entry)) { skipped.push(name + ' (ungültiges JSON)'); continue; }
          const obj = parsedJson.get(entry);
          const kind = classifyJson(obj);
          if (kind === 'blutbild-loeschungen')           continue; // handled above
          else if (kind === 'nutzer-konfiguration')       sections.push(await planUserConfig(finalizers, obj));
          else if (kind === 'medizinische-daten')             sections.push(await planMedizinischeDaten(finalizers, obj));
          else if (kind === 'medikation-notizen')        sections.push(await planNotes(finalizers, obj));
          else if (kind === 'medikamente')               sections.push(await planMedikamente(finalizers, obj));
          else if (kind === 'blutbild-analyse')           sections.push(await planBlutbildAnalyse(finalizers, obj));
          else if (kind === 'medicalc-konfiguration')     sections.push(await planMedicalcConfig(finalizers, obj));
          else if (kind === 'medicalc-clipboard-schema')  sections.push(await planClipboardSchema(finalizers, obj));
          else if (kind === 'medikamente-zusatzpackungen') sections.push(await planExtraPacks(finalizers, obj));
          else skipped.push(name + ' (unbekanntes JSON-Format)');
          continue;
        }
        if (/\.csv$/i.test(name)) {
          sections.push(await planMedicalcCsv(finalizers, dec.decode(entry.bytes)));
          continue;
        }
        skipped.push(name + ' (unbekannter Dateityp)');
      }

      importBtn.textContent = defaultLabel;
      importBtn.disabled = false;

      const confirmed = await renderPreviewModal(sections);
      if (!confirmed) return;

      importBtn.disabled = true;
      importBtn.textContent = '⏳ Übernehme Änderungen …';

      // Only checkboxes the user left checked are applied. Merged-record
      // categories (e.g. one Zeitreihen store shared by several dated
      // entries) defer their actual write to a finalizer — see makeItem's
      // comment — so all item commits must run first to populate/mark the
      // shared `merged`/`touched` closures the finalizers below then read.
      let totalOps = 0;
      for (const s of sections) {
        for (const item of [...s.added, ...s.changed, ...s.removed]) {
          if (item.checked) { await item.commit(); totalOps++; }
        }
      }
      for (const finalize of finalizers) {
        const op = finalize();
        if (op) await op();
      }

      let msg = `Import abgeschlossen: ${totalOps} Änderung(en) übernommen.`;
      if (skipped.length) msg += '\nÜbersprungen: ' + skipped.join(', ');
      alert(msg);

      // The import writes straight to IndexedDB, bypassing app.js's own
      // save path — its in-memory state (file gallery, analytics charts,
      // ...) was already loaded before this ran and has no idea anything
      // changed. Reload so every page section re-reads the now-current
      // data, same as the reset flow below already does for the same
      // reason. Skipped when nothing was actually written (nothing to
      // refresh, avoids an unnecessary reload on repeat/no-op imports).
      if (totalOps > 0) location.reload();
    } catch (err) {
      console.error('Import fehlgeschlagen:', err);
      alert('Import fehlgeschlagen: ' + err.message);
    } finally {
      closeAllDbs();
      importBtn.disabled = false;
      importBtn.textContent = defaultLabel;
    }
  }

  // ══ RESET (factory reset — the one destructive operation here) ═══════
  // Everything else in this file is careful to never delete data; this is
  // the deliberate exception the user asked for, since import only ever
  // merges and there was previously no way to clear old/wrong data short of
  // manually emptying each app. Mirrors the same 4 DBs as export/import.

  const RESET_DB_NAMES = ['BlutbildDB', 'medical-timeseries-v1', 'med-plan-v1', 'MediCalcDB'];
  // LLM credentials + preferences for befund.html's KI-Analyse — see the
  // PROVIDERS config in befund.js. Both provider keys are listed so a factory
  // reset really does clear every stored credential, not just Claude's.
  const RESET_LOCALSTORAGE_KEYS = [
    'med-plan-extra',
    'medicalc-clipboard-schema-v1',
    'claude-api-key',
    'deepseek-api-key',
    'befund-ai-provider',
    'befund-ai-model-claude',
    'befund-ai-model-deepseek',
    'medicalc-user-config-v1', // importierte Nutzerkonfiguration (config.js)
  ];
  const RESET_CONFIRM_PHRASE = 'LÖSCHEN';

  function countLabel(n, singular, plural) {
    return `${n} ${n === 1 ? singular : plural}`;
  }

  async function gatherResetSummary() {
    const lines = [];

    try {
      const db = await idbOpen('BlutbildDB', 1, upgradeBlutbild);
      const files = await idbGetAll(db, 'files');
      if (files.length) lines.push(countLabel(files.length, 'Blutbild-Scan', 'Blutbild-Scans'));
      const analyse = await idbGet(db, 'metadata', 'analyse');
      if (analyse && (analyse.context || analyse.result || analyse.systemPrompt)) lines.push('Patientenkontext / System-Prompt / KI-Analyse-Ergebnis');
    } catch (err) { console.error('Reset-Vorschau: Blutbild fehlgeschlagen', err); }

    try {
      const db = await idbOpen('medical-timeseries-v1', 1, upgradeTimeseries);
      const get = async key => { const r = await idbGet(db, 'store', key); return r ? r.value : undefined; };
      const size = v => Array.isArray(v) ? v.length : (v && typeof v === 'object' ? Object.keys(v).length : 0);
      let n = 0;
      for (const key of ['radiation', 'events', 'bp', 'qt', 'weight']) n += size(await get(key));
      for (const mod of window.MediModules.with('bulk')) {
        if (mod.bulk.count) n += await mod.bulk.count(get);
      }
      if (n) lines.push(countLabel(n, 'Zeitreihen-Eintrag', 'Zeitreihen-Einträge'));
    } catch (err) { console.error('Reset-Vorschau: Zeitreihen fehlgeschlagen', err); }

    try {
      const db = await idbOpen('med-plan-v1', 2, upgradePlan);
      const notes = await idbGetAll(db, 'notes');
      const metaRec = await idbGet(db, 'meta', 'medication');
      const medCount = metaRec && metaRec.value ? Object.keys(metaRec.value).length : 0;
      if (notes.length) lines.push(countLabel(notes.length, 'Medikations-Notiz', 'Medikations-Notizen'));
      if (medCount) lines.push(countLabel(medCount, 'Medikament', 'Medikamente'));
    } catch (err) { console.error('Reset-Vorschau: Medikations-Plan fehlgeschlagen', err); }

    try {
      const db = await idbOpen('MediCalcDB', 1, upgradeMedicalc);
      const invoices = await idbGetAll(db, 'invoices');
      if (invoices.length) lines.push(countLabel(invoices.length, 'MediCalc-Rechnung', 'MediCalc-Rechnungen'));
      const config = await idbGet(db, 'config', 'settings');
      if (config) lines.push('MediCalc-Konfiguration (Erstattungssätze, Eigenanteil-Schwelle)');
    } catch (err) { console.error('Reset-Vorschau: MediCalc fehlgeschlagen', err); }

    return lines;
  }

  function renderResetConfirmModal(lines) {
    return new Promise(resolve => {
      const overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(5,8,15,0.75);display:flex;align-items:center;justify-content:center;padding:1.5rem;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;';

      const card = document.createElement('div');
      card.style.cssText = 'background:#141929;border:1px solid #5b2a2a;border-radius:12px;max-width:520px;width:100%;max-height:85vh;display:flex;flex-direction:column;box-shadow:0 20px 60px rgba(0,0,0,0.5);';

      const header = document.createElement('div');
      header.style.cssText = 'padding:1.25rem 1.5rem 0.75rem;border-bottom:1px solid #3a2020;';
      header.innerHTML = '<h2 style="margin:0;font-size:1.1rem;color:#fca5a5;">⚠️ Alles zurücksetzen</h2><p style="margin:0.35rem 0 0;font-size:0.8rem;color:#94a3b8;">Löscht unwiderruflich alle Daten aller vier Apps. Kein Undo — vorher am besten exportieren.</p>';

      const body = document.createElement('div');
      body.style.cssText = 'padding:0.9rem 1.5rem;overflow-y:auto;flex:1;font-size:0.85rem;color:#cbd5e1;line-height:1.6;';
      if (lines.length === 0) {
        body.innerHTML = '<p style="color:#64748b;">Es sind aktuell keine Daten vorhanden.</p>';
      } else {
        body.innerHTML = '<p style="margin:0 0 0.5rem;color:#94a3b8;">Folgendes wird gelöscht:</p><ul style="margin:0;padding-left:1.2rem;">'
          + lines.map(l => `<li>${escapeHtml(l)}</li>`).join('')
          + '</ul><p style="margin:0.75rem 0 0;color:#94a3b8;">sowie Patientenkontext & KI-Analyse-Ergebnis, MediCalc-Konfiguration, Medikamente-Zusatzpackungen, MediCalc-Clipboard-Schema und der gespeicherte Anthropic-API-Schlüssel.</p>';
      }

      const confirmGroup = document.createElement('div');
      confirmGroup.style.cssText = 'padding:0 1.5rem 0.25rem;';
      confirmGroup.innerHTML = `<label style="display:block;font-size:0.8rem;color:#94a3b8;margin-bottom:0.4rem;">Zum Bestätigen "${RESET_CONFIRM_PHRASE}" eingeben:</label>`;
      const confirmInput = document.createElement('input');
      confirmInput.type = 'text';
      confirmInput.autocomplete = 'off';
      confirmInput.spellcheck = false;
      confirmInput.style.cssText = 'width:100%;box-sizing:border-box;background:rgba(0,0,0,0.3);border:1px solid #3a2020;border-radius:6px;padding:0.5rem 0.75rem;color:#f3f4f6;font-family:inherit;font-size:0.9rem;';
      confirmGroup.appendChild(confirmInput);
      body.appendChild(confirmGroup);

      const footer = document.createElement('div');
      footer.style.cssText = 'padding:1rem 1.5rem;display:flex;gap:0.6rem;justify-content:flex-end;border-top:1px solid #3a2020;';
      const cancelBtn = document.createElement('button');
      cancelBtn.textContent = 'Abbrechen';
      cancelBtn.style.cssText = 'background:transparent;color:#94a3b8;border:1px solid #2a3450;border-radius:6px;padding:0.5rem 1rem;font-size:0.85rem;cursor:pointer;font-family:inherit;';
      const confirmBtn = document.createElement('button');
      confirmBtn.textContent = 'Endgültig löschen';
      confirmBtn.disabled = lines.length === 0;
      confirmBtn.style.cssText = 'background:#ef4444;color:#fff;border:none;border-radius:6px;padding:0.5rem 1.1rem;font-size:0.85rem;font-weight:600;cursor:pointer;font-family:inherit;opacity:0.4;';

      function updateConfirmState() {
        const unlocked = lines.length > 0 && confirmInput.value.trim() === RESET_CONFIRM_PHRASE;
        confirmBtn.disabled = !unlocked;
        confirmBtn.style.opacity = unlocked ? '1' : '0.4';
        confirmBtn.style.cursor = unlocked ? 'pointer' : 'not-allowed';
      }
      confirmInput.addEventListener('input', updateConfirmState);
      updateConfirmState();

      footer.appendChild(cancelBtn);
      footer.appendChild(confirmBtn);
      card.appendChild(header);
      card.appendChild(body);
      card.appendChild(footer);
      overlay.appendChild(card);
      document.body.appendChild(overlay);

      function finish(result) { overlay.remove(); resolve(result); }
      cancelBtn.addEventListener('click', () => finish(false));
      confirmBtn.addEventListener('click', () => { if (!confirmBtn.disabled) finish(true); });
      overlay.addEventListener('click', e => { if (e.target === overlay) finish(false); });
      confirmInput.focus();
    });
  }

  async function runReset() {
    const defaultLabel = resetBtn.textContent;
    try {
      resetBtn.disabled = true;
      const lines = await gatherResetSummary();
      closeAllDbs(); // release read connections before the confirm dialog, so deleteDatabase() below never blocks on our own handles

      const confirmed = await renderResetConfirmModal(lines);
      if (!confirmed) return;

      resetBtn.textContent = '⏳ Lösche …';
      for (const name of RESET_DB_NAMES) await idbDelete(name);
      RESET_LOCALSTORAGE_KEYS.forEach(key => { try { localStorage.removeItem(key); } catch (_) {} });

      alert('Zurückgesetzt: alle Daten wurden gelöscht. Die Seite wird jetzt neu geladen.');
      location.reload();
    } catch (err) {
      console.error('Reset fehlgeschlagen:', err);
      alert('Zurücksetzen fehlgeschlagen: ' + err.message);
    } finally {
      closeAllDbs();
      resetBtn.disabled = false;
      resetBtn.textContent = defaultLabel;
    }
  }

  // ── Wiring ────────────────────────────────────────────────────────────

  if (exportBtn) exportBtn.addEventListener('click', runExport);
  if (importBtn && fileInput) {
    importBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', e => {
      const file = e.target.files[0];
      e.target.value = '';
      if (file) runImport(file);
    });
  }
  if (resetBtn) resetBtn.addEventListener('click', runReset);
})();
