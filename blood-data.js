// Shared blood-marker data layer, used by blutbild.html (OCR + trend charts),
// radar.html (Spinnennetz) and befund.html (KI-Befund).
// All three pages compute the same `groupedData` (blood marker -> chronological
// value series) from the OCR text stored in IndexedDB (`BlutbildDB`) by
// blutbild.html's scanner — this file is the single source of truth for that
// pipeline so it isn't reimplemented three times.
//
// Exposed as window.BloodData (not a bare global) so each consuming page's
// own script can destructure only what it needs, e.g.:
//   const { MEDICAL_ABBR, loadFilesFromStorage, computeGroupedData } = window.BloodData;
(function () {
  'use strict';

  // --- OFFLINE STORAGE (IndexedDB) ──────────────────────────────────────────
  const DB_NAME = 'BlutbildDB';
  const DB_VERSION = 1;
  const STORE_FILES = 'files';
  const STORE_METADATA = 'metadata';

  // One shared connection (previously every call opened a new one and never
  // closed it). Released as soon as another tab wants to upgrade or delete
  // the database ("Alles zurücksetzen"), so that is never blocked by us.
  let dbPromise = null;
  async function initDB() {
    if (dbPromise) return dbPromise;
    return dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onerror = () => { dbPromise = null; reject(req.error); };
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => { db.close(); dbPromise = null; };
        resolve(db);
      };
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE_FILES)) {
          const store = db.createObjectStore(STORE_FILES, { keyPath: 'fileId' });
          store.createIndex('lastModified', 'lastModified', { unique: false });
        }
        if (!db.objectStoreNames.contains(STORE_METADATA)) {
          db.createObjectStore(STORE_METADATA, { keyPath: 'key' });
        }
      };
    });
  }

  // Keyed by name alone (not name+lastModified): there is never more than
  // one Blutbild per file name, so re-saving/re-importing the same name
  // (e.g. a TXT re-imported after being re-saved/AirDropped, which changes
  // its OS mtime) must overwrite the existing record rather than create a
  // second one under a different key.
  // Saving a file is always a deliberate (re-)add, so it also lifts a
  // deletion marker for that name (see deleteFileFromStorage) in the same
  // transaction.
  async function saveFileToStorage(file, ocrText, status) {
    try {
      const db = await initDB();
      const tx = db.transaction([STORE_FILES, STORE_METADATA], 'readwrite');
      updateTombstones(tx.objectStore(STORE_METADATA), t => { delete t[file.name]; });
      tx.objectStore(STORE_FILES).put({
        fileId: file.name,
        name: file.name,
        path: file.webkitRelativePath || file.name,
        ocrText: ocrText || '',
        status: status || 'pending',
        scanDate: new Date().toISOString(),
        lastModified: file.lastModified,
      });
      return new Promise((r, j) => {
        tx.oncomplete = r;
        tx.onerror = () => j(tx.error);
      });
    } catch (e) {
      console.warn('Could not save to IndexedDB:', e);
    }
  }

  async function loadFilesFromStorage() {
    try {
      const db = await initDB();
      const tx = db.transaction(STORE_FILES, 'readwrite');
      const store = tx.objectStore(STORE_FILES);
      const all = await new Promise((r, j) => {
        const req = store.getAll();
        req.onsuccess = () => r(req.result);
        req.onerror = () => j(req.error);
      });

      // One-time self-heal for records written before fileId was name-only
      // (see saveFileToStorage above): those old composite keys don't
      // collide on their own, so duplicates with the same `name` can still
      // be sitting in the store. Collapse them here, keeping the most
      // recently scanned copy, and delete the rest so the object store
      // itself (also read directly by bulk-import.js for backup/export)
      // stays clean, not just this in-memory view.
      const byName = new Map();
      for (const rec of all) {
        const existing = byName.get(rec.name);
        if (!existing || (rec.scanDate || '') > (existing.scanDate || '')) {
          byName.set(rec.name, rec);
        }
      }
      if (byName.size < all.length) {
        const keepIds = new Set([...byName.values()].map(r => r.fileId));
        all.filter(r => !keepIds.has(r.fileId)).forEach(r => store.delete(r.fileId));
      }

      return new Promise((r, j) => {
        tx.oncomplete = () => r([...byName.values()]);
        tx.onerror = () => j(tx.error);
      });
    } catch (e) {
      console.warn('Could not load from IndexedDB:', e);
      return [];
    }
  }

  // Keeps the deletion markers (see deleteFileFromStorage): clearing the
  // workspace is not a deliberate delete of each file, but files deleted
  // deliberately before must stay deleted on the next ZIP import.
  async function clearStoredFiles() {
    try {
      const db = await initDB();
      const tx = db.transaction([STORE_FILES, STORE_METADATA], 'readwrite');
      tx.objectStore(STORE_FILES).clear();
      tx.objectStore(STORE_METADATA).openCursor().onsuccess = (e) => {
        const cursor = e.target.result;
        if (!cursor) return;
        if (cursor.key !== TOMBSTONE_KEY) cursor.delete();
        cursor.continue();
      };
      return new Promise((r, j) => {
        tx.oncomplete = r;
        tx.onerror = () => j(tx.error);
      });
    } catch (e) {
      console.warn('Could not clear storage:', e);
    }
  }

  // --- DELETION MARKERS ("Löschvermerke") ──────────────────────────────
  // A deliberate delete leaves a marker { [fileName]: deletedAtISO } in the
  // metadata store. bulk-import.js exports the markers with the ZIP and
  // checks them on import, so an older ZIP (or another device that still
  // has the file) does not silently bring a deleted Blutbild back, and a
  // delete made on one device can be carried over to the other — always
  // only after the user confirmed it in the import preview.
  // bulk-import.js reads/writes the same key directly (it has no access to
  // this module) — keep both in sync.
  const TOMBSTONE_KEY = 'deletedFiles';

  // Read-modify-write of the marker map inside the caller's transaction,
  // so it commits (or fails) together with the file-store change.
  function updateTombstones(metaStore, mutate) {
    const req = metaStore.get(TOMBSTONE_KEY);
    req.onsuccess = () => {
      const tombstones = { ...(req.result && req.result.value) };
      const before = JSON.stringify(tombstones);
      mutate(tombstones);
      if (JSON.stringify(tombstones) !== before) {
        metaStore.put({ key: TOMBSTONE_KEY, value: tombstones });
      }
    };
  }

  // Deletes by `name`, not by key: the current key is the name itself (see
  // saveFileToStorage), but a record written under the old name+lastModified
  // key may still exist for the same file, and leaving it behind would make
  // the "deleted" file reappear on the next reload. Records the deletion
  // marker in the same transaction.
  async function deleteFileFromStorage(fileName) {
    try {
      const db = await initDB();
      const tx = db.transaction([STORE_FILES, STORE_METADATA], 'readwrite');
      const store = tx.objectStore(STORE_FILES);
      store.openCursor().onsuccess = (e) => {
        const cursor = e.target.result;
        if (!cursor) return;
        if (cursor.value.name === fileName) cursor.delete();
        cursor.continue();
      };
      const deletedAt = new Date().toISOString();
      updateTombstones(tx.objectStore(STORE_METADATA), t => { t[fileName] = deletedAt; });
      return new Promise((r, j) => { tx.oncomplete = r; tx.onerror = () => j(tx.error); });
    } catch (e) {
      console.warn('Could not delete from IndexedDB:', e);
    }
  }

  // --- THERAPY EVENTS (rendered as vertical markers on blutbild.html's trend charts) ---
  // Same list as data.html's Therapie-Ereignisse tab (medical-timeseries-v1 →
  // store → 'events'). Until loadEvents() resolves — or when data.html was
  // never opened — the start data from the configuration applies. The array
  // is filled in place, so a reference taken before loading stays valid.
  const EVENTS = (window.APP_CONFIG.seed.events || []).map(e => ({ ...e }));

  function loadEvents() {
    return new Promise(resolve => {
      let req;
      try { req = indexedDB.open('medical-timeseries-v1', 1); } catch (_) { resolve(EVENTS); return; }
      // Same schema as data.html's initDB — creating the store here keeps a
      // first visit to blutbild.html from leaving an empty, store-less DB behind.
      req.onupgradeneeded = e => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('store')) db.createObjectStore('store', { keyPath: 'key' });
      };
      req.onerror = () => resolve(EVENTS);
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => db.close();
        try {
          const get = db.transaction('store', 'readonly').objectStore('store').get('events');
          get.onsuccess = () => {
            const stored = get.result && get.result.value;
            if (Array.isArray(stored)) EVENTS.splice(0, EVENTS.length, ...stored);
            db.close();
            resolve(EVENTS);
          };
          get.onerror = () => { db.close(); resolve(EVENTS); };
        } catch (_) { db.close(); resolve(EVENTS); }
      };
    });
  }

  // --- MEDICAL ABBREVIATION DICTIONARY ---
  // Catalog in config-system.js (general reference ranges), resolved by
  // config.js for the user's sex and own lab ranges (config-user.js →
  // referenceRanges). See config-system.js for the meaning of each field.
  const MEDICAL_ABBR = window.APP_CONFIG.markers;

  const DERIVED_MARKERS = new Set(['FreePSA_Ratio_Percent','NLR', 'PLR', 'MLR', 'SII', 'SIRI', 'TRAVEL_RISK']);

  const DERIVED_SPECS = [
    {
      name: 'FreePSA_Ratio_Percent',
      deps: ['PSA', 'freePSA'],
      formula: 'freePSA ÷ PSA',
      compute: v => 100 * v['freePSA'] / v['PSA'],
      decimals: 2
    },
    {
      name: 'NLR',
      deps: ['NEUT', 'LYMPH'],
      formula: 'NEUT ÷ LYMPH',
      compute: v => v['NEUT'] / v['LYMPH'],
      decimals: 2
    },
    {
      name: 'PLR',
      deps: ['PLT', 'LYMPH'],
      formula: 'PLT ÷ LYMPH',
      compute: v => v['PLT'] / v['LYMPH'],
      decimals: 1
    },
    {
      name: 'MLR',
      deps: ['MONO', 'LYMPH'],
      formula: 'MONO ÷ LYMPH',
      compute: v => v['MONO'] / v['LYMPH'],
      decimals: 3
    },
    {
      name: 'SII',
      deps: ['PLT', 'NEUT', 'LYMPH'],
      formula: '(PLT × NEUT) ÷ LYMPH',
      compute: v => (v['PLT'] * v['NEUT']) / v['LYMPH'],
      decimals: 1
    },
    {
      name: 'SIRI',
      deps: ['NEUT', 'MONO', 'LYMPH'],
      formula: '(NEUT × MONO) ÷ LYMPH',
      compute: v => (v['NEUT'] * v['MONO']) / v['LYMPH'],
      decimals: 3
    }
  ];

  /**
   * Berechnet das Reiserisiko (0–100%) basierend auf Blutwertparametern
   * unter Verwendung von Sigmoid-Funktionen für stetige Risikoübergänge.
   *
   * Kalibrierung:
   * - Normale Werte → ~0%
   * - Grenzwerte → ~10-15%
   * - Deutlich abnormale Werte → 50-100%
   *
   * Berücksichtigt: NLR, PLR, RDW-CV, HCT, PDW/MPV
   **/
  function calculateTravelRisk(bloodValues) {
    // Sigmoid-Funktion: smooth S-curve mapping value → risk (0–100%)
    const sigmoid = (value, center, steepness) => {
      return 100 / (1 + Math.exp(-steepness * (value - center)));
    };

    const riskComponents = [];

    // NLR component: Normal 1.5-3, Elevated 3-5, High >5
    if (bloodValues.NEUT && bloodValues.LYMPH && bloodValues.LYMPH !== 0) {
      const nlr = bloodValues.NEUT / bloodValues.LYMPH;
      // Center at 10 (well into abnormal), low steepness for gradual rise
      const nlrRisk = sigmoid(nlr, 10, 0.5);
      riskComponents.push({ value: nlrRisk, weight: 0.45 });
    }

    // PLR component: Normal 80-150, Elevated 150-200, High >200
    if (bloodValues.PLT && bloodValues.LYMPH && bloodValues.LYMPH !== 0) {
      const plr = bloodValues.PLT / bloodValues.LYMPH;
      // Center at 400 (very abnormal), low steepness
      const plrRisk = sigmoid(plr, 400, 0.008);
      riskComponents.push({ value: plrRisk, weight: 0.30 });
    }

    // RDW-CV component: Normal 11.5-14.5, Elevated >14.5
    if (bloodValues.RDW_CV) {
      // Center at 20 (very abnormal), high steepness for sharp transition
      const rdwRisk = sigmoid(bloodValues.RDW_CV, 20, 2.0);
      riskComponents.push({ value: rdwRisk, weight: 0.12 });
    }

    // HCT component: Normal 38-48, Elevated >48 (polycythemia risk)
    if (bloodValues.HCT) {
      // Center at 55 (clearly abnormal), moderate steepness
      const hctRisk = sigmoid(bloodValues.HCT, 55, 1.0);
      riskComponents.push({ value: hctRisk, weight: 0.08 });
    }

    // Platelet size indicators: PDW/MPV combination (platelet activation)
    if (bloodValues.PDW && bloodValues.MPV) {
      const plateletMeanSize = (bloodValues.PDW + bloodValues.MPV) / 2;
      // Center at 15 (abnormal), high steepness
      const plateletRisk = sigmoid(plateletMeanSize, 15, 2.0);
      riskComponents.push({ value: plateletRisk, weight: 0.05 });
    }

    // No data available
    if (riskComponents.length === 0) return 0;

    // Compute weighted average of component risks
    let totalWeightedRisk = 0;
    let totalWeight = 0;
    riskComponents.forEach(comp => {
      totalWeightedRisk += comp.value * comp.weight;
      totalWeight += comp.weight;
    });

    const finalRisk = totalWeight > 0 ? totalWeightedRisk / totalWeight : 0;
    return Math.round(finalRisk * 10) / 10; // Round to 1 decimal place
  }

  // Extracts chronological dates from the beginning of filenames
  function extractDateFromFilename(filename) {
    if (!filename) return null;

    // YYYY-MM-DD or YYYY_MM_DD
    let match = filename.match(/^(\d{4})[-_](\d{2})[-_](\d{2})/);
    if (match) return `${match[1]}-${match[2]}-${match[3]}`;

    // DD-MM-YYYY or DD_MM_YYYY
    match = filename.match(/^(\d{2})[-_](\d{2})[-_](\d{4})/);
    if (match) return `${match[3]}-${match[2]}-${match[1]}`;

    // YYYYMMDD
    match = filename.match(/^(\d{4})(\d{2})(\d{2})/);
    if (match) return `${match[1]}-${match[2]}-${match[3]}`;

    // Numeric prefix fallback
    match = filename.match(/^(\d+)/);
    if (match) return match[1];

    return null;
  }

  // --- PDF LAB REPORT PARSING ─────────────────────────────────────────────
  // German hematology-analyzer printouts (e.g. Sysmex XN) label each row with
  // their own device abbreviation, which doesn't always match this app's
  // MEDICAL_ABBR keys (English CBC nomenclature). The alias table lives in
  // config-system.js (pdfAliases), extendable via config-user.js.
  const PDF_ABBR_ALIASES = window.APP_CONFIG.pdfAliases;

  // Resolves a raw token (case-insensitive) to a MEDICAL_ABBR key. Checks
  // PDF_ABBR_ALIASES *before* a direct MEDICAL_ABBR match: several device
  // labels above (NEUT, LYMPH, MONO, BASO, IG) are spelled exactly like an
  // existing MEDICAL_ABBR key but mean something different on the printout
  // (percent, not the key's absolute definition) — the alias must win so
  // that ambiguity resolves correctly. Returns null if unknown.
  function resolvePdfAbbr(token) {
    if (!token) return null;
    const upper = token.toUpperCase();
    if (Object.prototype.hasOwnProperty.call(PDF_ABBR_ALIASES, upper)) return PDF_ABBR_ALIASES[upper];
    if (Object.prototype.hasOwnProperty.call(MEDICAL_ABBR, upper)) return upper;
    return null;
  }

  // Converts a lab-report date like "5.08.26" or "05.08.2026" to "YYYY-MM-DD".
  function parsePdfDate(raw) {
    const m = raw.match(/^(\d{1,2})\.(\d{1,2})\.(\d{2}|\d{4})$/);
    if (!m) return null;
    const day = m[1].padStart(2, '0');
    const month = m[2].padStart(2, '0');
    const year = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${year}-${month}-${day}`;
  }

  const PDF_NUM_RE = /^[+-]?\d+(?:[.,]\d+)?$/;
  const PDF_DATE_TOKEN_RE = /^\d{1,2}\.\d{1,2}\.(?:\d{2}|\d{4})$/;
  const PDF_TIME_TOKEN_RE = /^\d{1,2}:\d{2}$/;

  // Some lab printouts insert a low/high indicator glyph (↑/↓, or whatever a
  // custom analyzer font maps to once extracted as text — this varies and
  // isn't worth hardcoding) directly between the value and its unit. Detected
  // generically as "a token with no letters/digits that isn't the literal
  // unit '%'", since '%' is itself a common bare unit here and must not be
  // mistaken for one of these indicators.
  function isStrayIndicatorToken(token) {
    return token !== '%' && !/[A-Za-z0-9]/.test(token);
  }

  // Tries to parse "VALUE [INDICATOR] UNIT (MIN - MAX | < MAX | > MIN) DATE TIME"
  // starting at tokens[startIdx], e.g. "4.72 G/l 4.23 - 9.07 5.08.26 09:55" or
  // "68.9 ↓ ml/min > 90 5.08.26 11:40" or "0.4 % < 0.5 5.08.26 09:55".
  // Returns { value, measureDate } on success, null if the shape doesn't fit.
  function tryParsePdfValueTail(tokens, startIdx) {
    let idx = startIdx;
    if (idx >= tokens.length || !PDF_NUM_RE.test(tokens[idx])) return null;
    const value = parseFloat(tokens[idx].replace(',', '.'));
    idx++;

    if (idx < tokens.length && isStrayIndicatorToken(tokens[idx])) idx++;

    if (idx >= tokens.length) return null; // unit token (accepted as-is; units vary too widely to validate)
    idx++;

    if (idx >= tokens.length) return null;
    const gluedRange = tokens[idx].match(/^([+-]?\d+(?:[.,]\d+)?)[-–]([+-]?\d+(?:[.,]\d+)?)$/);
    if (tokens[idx] === '<' || tokens[idx] === '>') {
      if (idx + 1 >= tokens.length || !PDF_NUM_RE.test(tokens[idx + 1])) return null;
      idx += 2;
    } else if (gluedRange) {
      idx += 1;
    } else if (PDF_NUM_RE.test(tokens[idx])) {
      if (idx + 2 >= tokens.length || (tokens[idx + 1] !== '-' && tokens[idx + 1] !== '–') || !PDF_NUM_RE.test(tokens[idx + 2])) return null;
      idx += 3;
    } else {
      return null;
    }

    if (idx >= tokens.length || !PDF_DATE_TOKEN_RE.test(tokens[idx])) return null;
    const measureDate = parsePdfDate(tokens[idx]);
    idx++;

    if (idx >= tokens.length || !PDF_TIME_TOKEN_RE.test(tokens[idx])) return null;

    return { value, measureDate };
  }

  // Parses lab-report text extracted from a PDF (via pdf-parse) into
  // MEDICAL_ABBR-keyed value lines. Each line is scanned token by token for
  // the first position whose token resolves to a MEDICAL_ABBR key (see
  // resolvePdfAbbr) AND whose remainder matches the expected
  // "VALUE [INDICATOR] UNIT RANGE DATE TIME" tail (see tryParsePdfValueTail).
  // Requiring the tail to match, not just the abbreviation, is what makes
  // this robust to variable-length descriptions (a description word can
  // itself coincidentally be a known abbreviation, e.g. "eGFR" in
  // "eGFR nach CKD-EPI-Formel CKDEPI 68.9 ...") without hardcoding "1st or
  // 2nd word" — the real position varies per report row.
  // Each row's Messdatum is cross-checked against `expectedDate` (the date
  // encoded in the source filename, see extractDateFromFilename) — rows whose
  // date doesn't match are reported in `mismatches` instead of `entries`, so a
  // filename/report mismatch can't silently mis-date a chart point.
  function parsePdfBloodLines(pdfText, expectedDate) {
    const entries = [];
    const mismatches = [];
    if (!pdfText) return { entries, mismatches };

    for (const rawLine of pdfText.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      const tokens = line.split(/\s+/);
      if (tokens.length < 2) continue;

      let matched = null;
      for (let idx = 0; idx < tokens.length - 1; idx++) {
        const key = resolvePdfAbbr(tokens[idx]);
        if (!key) continue;
        const tail = tryParsePdfValueTail(tokens, idx + 1);
        if (tail) {
          matched = { key, value: tail.value, measureDate: tail.measureDate };
          break;
        }
      }
      if (!matched) continue;

      const { key, value, measureDate } = matched;

      if (expectedDate && measureDate && measureDate !== expectedDate) {
        mismatches.push({ key, measureDate, expectedDate, line });
        continue;
      }

      entries.push({ key, value, line });
    }

    return { entries, mismatches };
  }

  // Parses lines of the form: KNOWN_MARKER VALUE [rest of line ignored]
  // Only markers that are keys in MEDICAL_ABBR are accepted; anything else is skipped.
  // A line may start with its own date ("2026-10-20 HB 13.5",
  // "20.10.2026 HB 13,5"): lines typed into the result editor after the
  // scan then become extra data points on that date instead of overwriting
  // the file's own. Returns { date, rest } (date null when absent/invalid).
  function splitLineDate(line) {
    let m = line.match(/^(\d{4})[-./](\d{2})[-./](\d{2})\s+(.*)$/);
    let y, mo, d;
    if (m) { [, y, mo, d] = m; }
    else if ((m = line.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4}|\d{2})\s+(.*)$/))) {
      [, d, mo, y] = m;
      if (y.length === 2) y = '20' + y;
    } else return { date: null, rest: line };
    mo = mo.padStart(2, '0'); d = d.padStart(2, '0');
    if (+mo < 1 || +mo > 12 || +d < 1 || +d > 31) return { date: null, rest: line };
    return { date: `${y}-${mo}-${d}`, rest: m[4] };
  }

  function parseMarkerLines(ocrText) {
    const markers = [];
    if (!ocrText) return markers;

    for (const rawLine of ocrText.split(/\r?\n/)) {
      const { date, rest } = splitLineDate(rawLine.trim());
      // Trailing digits belong to the name only when a separator follows
      // ("B12 260.4"), so glued forms like "NA143" still parse as NA = 143.
      const match = rest.match(/^([A-Za-z]+(?:\d+(?=[\s:=]))?(?:[-_][A-Za-z]+)*)\s*[:=-]?\s*([+-]?\d+(?:[.,]\d+)?)/);
      if (!match) continue;
      if (!Object.prototype.hasOwnProperty.call(MEDICAL_ABBR, match[1])) continue;
      markers.push({ name: match[1], value: parseFloat(match[2].replace(',', '.')), line: rawLine.trim(), date });
    }
    return markers;
  }

  // Scoring logic per axis (used by the Spinnennetz/radar chart).
  // All current markers are range-type (100% at center of reference range).
  // The scoreType field on a MEDICAL_ABBR entry can override this:
  //   'lower' – lower is better (e.g. LDL, HbA1c): needs abbr.target + optional abbr.badMax
  //   'higher' – higher is better (e.g. HDL, Vit-D): needs abbr.target + optional abbr.badMin
  function computeHealthScore(markerName, value) {
    const abbr = MEDICAL_ABBR[markerName];
    if (!abbr || value == null || isNaN(value)) return null;

    // Custom scoring function takes precedence over all generic types.
    // Convention: function returns a value in [0, 1] which is scaled to [0, 100].
    if (typeof abbr.score === 'function') {
      return Math.round(Math.max(0, Math.min(1, abbr.score(value))) * 100);
    }

    const scoreType = abbr.scoreType || 'range';

    if (scoreType === 'range') {
      const { min, max } = abbr;
      if (min === undefined || max === undefined) return null;
      const center = (min + max) / 2;
      const halfRange = (max - min) / 2;
      if (halfRange <= 0) return null;
      const d = Math.abs(value - center) / halfRange;
      if (d <= 1) {
        // Flat 100 % anywhere within the reference range.
        return 100;
      } else {
        // Outside range: gradient scales the steepness (1 = default, 2 = twice as steep, 0.5 = half).
        // Default gradient=1 reaches 0 % at d≈1.5 (i.e. 50 % beyond the boundary).
        const g = abbr.gradient !== undefined ? abbr.gradient : 1;
        return Math.max(0, Math.round(100 - 200 * g * (d - 1)));
      }

    } else if (scoreType === 'lower') {
      const target = abbr.target !== undefined ? abbr.target : abbr.max;
      const badMax = abbr.badMax !== undefined ? abbr.badMax : target * 2;
      if (value <= target) return 100;
      if (badMax <= target) return 0;
      return Math.max(0, Math.round(100 * (1 - (value - target) / (badMax - target))));

    } else if (scoreType === 'higher') {
      const target = abbr.target !== undefined ? abbr.target : abbr.min;
      const badMin = abbr.badMin !== undefined ? abbr.badMin : 0;
      if (value >= target) return 100;
      if (target <= badMin) return 0;
      return Math.max(0, Math.round(100 * (value - badMin) / (target - badMin)));
    }

    return null;
  }

  // Color for a score: >= 95% within range (green), < 95 % = outside range (amber), < 40 % = well outside (red).
  function scoreColor(score) {
    if (score < 40) return '#ef4444';
    if (score < 95) return '#f59e0b';
    return '#10b981';
  }

  // Builds the marker -> chronological value series (incl. derived markers
  // and TRAVEL_RISK) that blutbild.html's trend charts, radar.html's
  // Spinnennetz and befund.html's KI-Analyse all render from. `files` is the
  // array of stored file records (as returned by loadFilesFromStorage(), or
  // any array of objects shaped like { name, ocrText, status }).
  function computeGroupedData(files) {
    const groupedData = {};

    // 1. Gather all scanned data from successfully scanned files.
    // Keyed transiently by date per marker: if a marker is reported by more
    // than one file dated the same day (e.g. an OCR scan and a PDF import of
    // the same draw), that must collapse to a single chart point instead of
    // duplicating the date on the x-axis — last file processed for that date
    // wins, the same "later overwrites" rule the derived-marker byDate lookup
    // below already uses.
    const rawByMarkerDate = {};
    files.forEach(fileObj => {
      if (fileObj.status !== 'success' || !fileObj.ocrText) return;

      const fileDate = extractDateFromFilename(fileObj.name);
      if (!fileDate) return; // Skip if date prefix not matched

      const markers = parseMarkerLines(fileObj.ocrText);
      markers.forEach(m => {
        if (!rawByMarkerDate[m.name]) {
          rawByMarkerDate[m.name] = new Map();
        }

        const date = m.date || fileDate;
        rawByMarkerDate[m.name].set(date, {
          date,
          value: m.value,
          filename: fileObj.name,
          line: m.line
        });
      });
    });
    Object.keys(rawByMarkerDate).forEach(name => {
      groupedData[name] = [...rawByMarkerDate[name].values()];
    });

    // Compute all derived markers
    DERIVED_SPECS.forEach(spec => {
      const allDepsPresent = spec.deps.every(dep => groupedData[dep] && groupedData[dep].length > 0);
      if (!allDepsPresent) {
        delete groupedData[spec.name];
        return;
      }

      // Build date-keyed lookup across all dependency series
      const byDate = {};
      spec.deps.forEach(dep => {
        groupedData[dep].forEach(p => {
          if (!byDate[p.date]) byDate[p.date] = { _filename: p.filename };
          byDate[p.date][dep] = p.value;
        });
      });

      const points = [];
      Object.keys(byDate).sort().forEach(date => {
        const vals = byDate[date];
        if (!spec.deps.every(dep => dep in vals)) return;
        if (!isFinite(spec.compute(vals))) return; // Division durch 0 (z.B. LYMPH, PSA)
        points.push({
          date,
          value: parseFloat(spec.compute(vals).toFixed(spec.decimals)),
          filename: vals._filename,
          line: `${spec.name} = ${spec.formula}`
        });
      });

      if (points.length > 0) {
        groupedData[spec.name] = points;
      } else {
        delete groupedData[spec.name];
      }
    });

    // Compute TRAVEL_RISK for all dates (special case: uses all available blood values)
    {
      const allValuesByDate = {};
      Object.keys(groupedData).forEach(marker => {
        if (DERIVED_MARKERS.has(marker)) return; // Skip other derived markers
        groupedData[marker].forEach(p => {
          if (!allValuesByDate[p.date]) {
            allValuesByDate[p.date] = { date: p.date, filename: p.filename };
          }
          allValuesByDate[p.date][marker] = p.value;
        });
      });

      const riskPoints = [];
      Object.keys(allValuesByDate).sort().forEach(date => {
        const risk = calculateTravelRisk(allValuesByDate[date]);
        riskPoints.push({
          date,
          value: risk,
          filename: allValuesByDate[date].filename || 'unknown',
          line: `Travel Risk = ${risk.toFixed(1)}%`
        });
      });

      if (riskPoints.length > 0) {
        groupedData['TRAVEL_RISK'] = riskPoints;
      } else {
        delete groupedData['TRAVEL_RISK'];
      }
    }

    return groupedData;
  }

  window.BloodData = {
    initDB, saveFileToStorage, loadFilesFromStorage, deleteFileFromStorage, clearStoredFiles,
    EVENTS, loadEvents, MEDICAL_ABBR, DERIVED_MARKERS, DERIVED_SPECS, calculateTravelRisk,
    extractDateFromFilename, parseMarkerLines,
    PDF_ABBR_ALIASES, resolvePdfAbbr, parsePdfBloodLines,
    computeHealthScore, scoreColor, computeGroupedData
  };
})();
