// config-user.example.js — Vorlage für die persönliche Konfiguration.
//
// So geht's:
//   • Eigene Installation (lokal / eigener Webspace): diese Datei nach
//     config-user.js kopieren und anpassen. config-user.js steht in
//     .gitignore und landet nie im Repository.
//   • Installation ohne eigene Dateien (z.B. GitHub Pages): die angepasste
//     Datei in der App über ☰ → „Nutzerkonfiguration laden“ einlesen. Sie wird
//     dann nur auf diesem Gerät gespeichert und mit dem ZIP-Export übertragen.
//
// Alles ist optional — ohne Konfiguration startet die App leer und verwendet
// allgemeine Referenzbereiche. Nach Änderungen an config-user.js: `npm run bump`,
// damit installierte Apps sie über den „Update“-Button erhalten.
self.USER_CONFIG = {

  // Wählt die geschlechtsspezifischen Referenzbereiche ('m' | 'w').
  profile: { sex: 'w' },

  // Referenzbereiche des eigenen Labors (stehen auf jedem Laborbefund).
  // Überschreiben die allgemeinen Bereiche aus config-system.js.
  referenceRanges: {
    // WBC: { min: 3.9, max: 10.2 },
    // CRP: { max: 5 },
  },

  // Zusätzliche Marker, die im Katalog (config-system.js) fehlen.
  markers: {
    // 'VITD': { desc: '25-OH-Vitamin D', unit: 'ng/ml', min: 30, max: 100 },
  },

  // Marker, die nirgends angezeigt werden sollen.
  hiddenMarkers: [],

  // Weitere Gerätekürzel aus PDF-Laborbefunden → Marker-Key.
  pdfAliases: {
    // 'LEUK': 'WBC',
  },

  // Apps bzw. Zeitreihen-Tabs ausblenden.
  hiddenPages: [],            // z.B. ['medicalc']
  hiddenTabs: [],             // z.B. ['qt', 'radiation']

  // Eigene Module (eigene Tabs in den Zeitreihen usw.), z.B. aus einem
  // privaten Ordner, der ebenfalls nicht veröffentlicht wird. Muster: siehe
  // Abschnitt „Module“ in README.md.
  privateScripts: [],

  befund: {
    // Fachgebiete, auf die sich die KI-Analyse konzentrieren soll.
    specialties: 'Labordiagnostik, Hämatologie, Innere Medizin und Kardiologie',
    // Oder den ganzen Systemprompt ersetzen ({{datenquellen}} = ausgewählte Daten):
    // systemPrompt: `…`,
  },

  // Erstattungssätze für MediCalc (Beihilfe / private Krankenversicherung).
  medicalc: { beihilfeRate: 0.5, pkvRateLow: 0.5, pkvRateHigh: 0.5, eigenanteilThreshold: 0 },

  // Startdaten — nur beim allerersten Start (leere Datenbank) übernommen.
  seed: {
    medication: {
      // Beispiel: { desc: 'BEISPIELMITTEL (Wirkstoff)', sub: 'Dauermedikation', start: '2026-01-01', duration: 28, rxWarningDays: 14 },
    },
    events: [
      // { begin: '2026-01-01', end: '', desc: 'Therapiebeginn', isTherapyStart: true },
    ],
  },

  // Datenschutz-Prüfung (`npm run check`): Begriffe, die in keiner
  // veröffentlichten Datei vorkommen dürfen — etwa der eigene Name, Arzt,
  // Klinik, Medikamente, Diagnose. Treffer am Wortanfang, ohne Groß-/Klein-
  // schreibung; /…/ = regulärer Ausdruck.
  privacy: {
    denylist: [],
  },
};
