// config.js — führt config-system.js und die Nutzerkonfiguration zu
// self.APP_CONFIG zusammen, stellt die Modul-Registry self.MediModules bereit
// und lädt private Modul-Skripte.
//
// Einbindung auf jeder Seite, in dieser Reihenfolge und VOR allen anderen
// App-Skripten (klassische, synchrone <script>-Tags):
//   <script src="config-system.js"></script>
//   <script src="config-user.js"></script>   ← fehlt die Datei: kein Problem
//   <script src="config.js"></script>
//
// Woher die Nutzerkonfiguration kommt (Vorrang von oben nach unten):
//   1. importiert über ☰ → „Nutzerkonfiguration laden“ (localStorage dieses
//      Geräts) — für Installationen ohne eigene Dateien, z.B. GitHub Pages
//   2. config-user.js neben den App-Dateien (self.USER_CONFIG) — für die
//      eigene Installation (lokal, eigener Webspace)
//   3. keine — die App startet leer mit allgemeinen Referenzbereichen
//
// Private Module (config-user.js → privateScripts) werden hier synchron per
// document.write nachgeladen: so registrieren sie sich garantiert, bevor das
// Hauptskript der Seite läuft, und der öffentliche HTML-Code muss ihre Namen
// nicht kennen.
(function (g) {
  'use strict';

  const IMPORT_KEY = 'medicalc-user-config-v1';
  const SYS = g.SYSTEM_CONFIG || {};

  const isObj = v => v && typeof v === 'object' && !Array.isArray(v);

  function readImported() {
    try {
      const raw = g.localStorage && g.localStorage.getItem(IMPORT_KEY);
      if (!raw) return null;
      const rec = JSON.parse(raw);
      return isObj(rec) && isObj(rec.config) ? rec : null;
    } catch (_) { return null; }
  }

  const fileConfig = isObj(g.USER_CONFIG) ? g.USER_CONFIG : null;
  const imported = readImported();
  const USER = (imported && imported.config) || fileConfig || {};
  const source = imported ? 'import' : (fileConfig ? 'file' : 'none');

  // ── Marker: Katalog + Geschlecht + eigene Laborbereiche ────────────────────
  const sex = (isObj(USER.profile) && USER.profile.sex) || (SYS.profile && SYS.profile.sex) || null;
  const markers = {};
  const addMarkers = src => {
    if (!isObj(src)) return;
    Object.keys(src).forEach(k => {
      const base = markers[k] || {};
      markers[k] = Object.assign({}, base, src[k]);
    });
  };
  addMarkers(SYS.markers);
  addMarkers(USER.markers); // eigene/zusätzliche Marker (vollständige Einträge)
  Object.keys(markers).forEach(k => {
    const m = markers[k];
    const bySex = sex && isObj(m[sex]) ? m[sex] : null;
    if (bySex) {
      if (bySex.min !== undefined) m.min = bySex.min;
      if (bySex.max !== undefined) m.max = bySex.max;
    }
  });
  if (isObj(USER.referenceRanges)) {
    Object.keys(USER.referenceRanges).forEach(k => {
      const r = USER.referenceRanges[k];
      if (!markers[k] || !isObj(r)) return;
      ['min', 'max', 'gradient', 'radar'].forEach(f => { if (r[f] !== undefined) markers[k][f] = r[f]; });
    });
  }
  (Array.isArray(USER.hiddenMarkers) ? USER.hiddenMarkers : []).forEach(k => { delete markers[k]; });

  const seed = Object.assign({}, SYS.seed, isObj(USER.seed) ? USER.seed : {});
  const hiddenPages = new Set(Array.isArray(USER.hiddenPages) ? USER.hiddenPages : []);
  const hiddenTabs = new Set(Array.isArray(USER.hiddenTabs) ? USER.hiddenTabs : []);
  const sysBefund = SYS.befund || {};
  const userBefund = isObj(USER.befund) ? USER.befund : {};
  const specialties = userBefund.specialties || sysBefund.specialties || '';
  const promptTemplate = (userBefund.systemPrompt || sysBefund.systemPrompt || '').split('{{fachgebiete}}').join(specialties);

  g.APP_CONFIG = {
    system: SYS,
    user: USER,
    source,                       // 'import' | 'file' | 'none'
    hasUserFile: !!fileConfig,
    importedAt: imported ? imported.importedAt : null,
    importedFrom: imported ? imported.fileName : null,
    profile: { sex },
    markers,
    pdfAliases: Object.assign({}, SYS.pdfAliases, isObj(USER.pdfAliases) ? USER.pdfAliases : {}),
    pages: (SYS.pages || []).filter(p => !hiddenPages.has(p.key)),
    isPageEnabled: key => !hiddenPages.has(key),
    isTabEnabled: id => !hiddenTabs.has(id),
    qt: Object.assign({}, SYS.qt, isObj(USER.qt) ? USER.qt : {}),
    befund: { specialties, systemPrompt: promptTemplate },
    medicalc: Object.assign({}, SYS.medicalc, isObj(USER.medicalc) ? USER.medicalc : {}),
    seed,
    privateScripts: Array.isArray(USER.privateScripts) ? USER.privateScripts.slice() : [],

    // Nutzerkonfiguration auf diesem Gerät hinterlegen (☰-Menü, ZIP-Import).
    // `text`: Inhalt einer config-user.json oder config-user.js. Gespeichert
    // wird reines JSON — Funktionen (z.B. eigene score-Funktionen) gehen
    // dabei verloren und gehören in die Datei-Variante.
    // allowJs: nur beim bewussten Laden einer eigenen config-user.js über das
    // Menü — ein ZIP-Import akzeptiert ausschließlich JSON.
    parseUserConfig(text, { allowJs = false } = {}) {
      const trimmed = String(text || '').trim();
      let obj = null;
      try { obj = JSON.parse(trimmed); } catch (_) { /* kein JSON → JS */ }
      if (!obj && allowJs) {
        const sandbox = {};
        // Die eigene Konfigurationsdatei des Nutzers, nur einmal beim Import
        // ausgewertet; gespeichert wird danach nur das JSON-Ergebnis.
        new Function('self', 'window', 'globalThis', trimmed)(sandbox, sandbox, sandbox);
        obj = sandbox.USER_CONFIG;
      }
      if (isObj(obj) && isObj(obj.medicalcUserConfig)) obj = obj.medicalcUserConfig; // ZIP-Export-Hülle
      if (!isObj(obj)) throw new Error('Keine Nutzerkonfiguration gefunden (erwartet: self.USER_CONFIG = { … } bzw. ein JSON-Objekt).');
      return JSON.parse(JSON.stringify(obj));
    },
    saveImportedUserConfig(config, fileName) {
      g.localStorage.setItem(IMPORT_KEY, JSON.stringify({ config, fileName: fileName || '', importedAt: new Date().toISOString() }));
    },
    clearImportedUserConfig() {
      try { g.localStorage.removeItem(IMPORT_KEY); } catch (_) {}
    },
    IMPORT_KEY,
  };

  // ── Modul-Registry ─────────────────────────────────────────────────────────
  // Ein Modul ist ein Objekt mit id, label und optionalen Hooks je Seite:
  //   data:   Tab in data.html (siehe dort „MODULE“)
  //   befund: datasets(getRecord) → zusätzliche Datensätze für die KI-Analyse
  //   bulk:   exportPayload / planImport / payloadKeys / count für bulk-import.js
  const modules = [];
  g.MediModules = {
    register(def) {
      if (!isObj(def) || !def.id) throw new Error('MediModules.register: id fehlt');
      if (modules.some(m => m.id === def.id)) return;
      modules.push(def);
    },
    all: () => modules.slice(),
    with: hook => modules.filter(m => m[hook]),
  };

  // ── Private Modul-Skripte ──────────────────────────────────────────────────
  // Nur in Seiten (nicht im Service Worker) und nur während des Parsens.
  if (g.document && g.document.readyState === 'loading') {
    g.APP_CONFIG.privateScripts.forEach(src => {
      if (typeof src !== 'string' || !/^[\w./-]+\.js$/.test(src) || src.includes('..')) {
        console.warn('privateScripts: ungültiger Pfad ignoriert:', src);
        return;
      }
      g.document.write(`<script src="${src}"><\/script>`);
    });
  }
})(self);
