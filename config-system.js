// config-system.js — öffentliche, NICHT personenbezogene Konfiguration.
//
// Alles, was hier steht, ist allgemeines Fachwissen bzw. App-Verhalten und
// darf veröffentlicht werden. Persönliches (eigene Laborbereiche, Medikation,
// Startdaten, Prompt-Schwerpunkte, private Module …) gehört in
// config-user.js (nicht im Repository, Vorlage: config-user.example.js) oder
// wird über ☰ → „Nutzerkonfiguration laden“ importiert. config.js führt beides
// zu window.APP_CONFIG zusammen — die Seiten lesen nur APP_CONFIG.
//
// `self` statt `window`, damit auch der Service Worker die Datei lesen kann.
self.SYSTEM_CONFIG = {

  // ── Marker-Katalog (Blutwerte) ─────────────────────────────────────────────
  // min/max: allgemeine Erwachsenen-Referenzbereiche (Literatur bzw.
  //   bloodwork.json). Laborabhängig! Eigene Laborbereiche gehören in
  //   config-user.js → referenceRanges und überschreiben diese Werte.
  // m / w: geschlechtsspezifische Bereiche; gewählt über profile.sex in
  //   config-user.js. Ohne Angabe gelten min/max.
  // gradient: Steilheit des Radar-Scores außerhalb des Bereichs (1 = Standard).
  // radar: false → nicht als Achse im Spinnennetz (radar.html).
  // score: optionale Funktion value → [0, 1], ersetzt die Bereichs-Logik.
  // scoreType: 'lower' / 'higher' (siehe computeHealthScore in blood-data.js).
  markers: {
    'WBC':    { desc: 'Leukozyten (weiße Blutkörperchen) – Gesamtzahl aller weißen Blutzellen', unit: '10³/µL', min: 4.5, max: 11.0, gradient: 0.5 },
    'RBC':    { desc: 'Erythrozyten (rote Blutkörperchen) – Gesamtzahl der sauerstofftransportierenden Zellen', unit: '10⁶/µL', min: 4.1, max: 5.9, m: { min: 4.5, max: 5.9 }, w: { min: 4.1, max: 5.1 }, gradient: 0.5 },
    'HGB':    { desc: 'Hämoglobin – Sauerstofftransportprotein in den Erythrozyten', unit: 'g/dL', min: 12.0, max: 17.5, m: { min: 13.5, max: 17.5 }, w: { min: 12.0, max: 15.5 } },
    'HCT':    { desc: 'Hämatokrit – Volumenanteil der Erythrozyten im Blut', unit: '%', min: 36, max: 53, m: { min: 41, max: 53 }, w: { min: 36, max: 46 }, gradient: 0.5 },
    'MCV':    { desc: 'Mittleres Erythrozytenvolumen – durchschnittliche Größe der roten Blutkörperchen', unit: 'fL', min: 80, max: 100 },
    'MCH':    { desc: 'Mittlerer Hämoglobingehalt eines Erythrozyten', unit: 'pg', min: 27, max: 33 },
    'MCHC':   { desc: 'Mittlere korpuskuläre Hämoglobinkonzentration der Erythrozyten', unit: 'g/dL', min: 32, max: 36 },
    'PLT':    { desc: 'Thrombozyten (Blutplättchen) – für die Blutgerinnung zuständige Zellen', unit: '10³/µL', min: 150, max: 400 },
    'RDW-SD': { desc: 'Erythrozyten-Verteilungsbreite (Standardabweichung) – Maß für die Größenvariation der roten Blutkörperchen', unit: 'fL', min: 39, max: 46, gradient: 0.1 },
    'RDW-CV': { desc: 'Erythrozyten-Verteilungsbreite (Variationskoeffizient) – relative Größenvariation der roten Blutkörperchen', unit: '%', min: 11.5, max: 14.5, gradient: 0.1 },
    'PDW':    { desc: 'Thrombozyten-Verteilungsbreite – Maß für die Größenvariation der Blutplättchen', unit: 'fL', min: 9, max: 17 },
    'MPV':    { desc: 'Mittleres Thrombozytenvolumen – durchschnittliche Größe der Blutplättchen', unit: 'fL', min: 7.4, max: 10.4, gradient: 0.1 },
    'P-LCR':  { desc: 'Anteil großer Thrombozyten (Platelet Large Cell Ratio)', unit: '%', min: 16, max: 35, gradient: 0.1 },
    'PCT':    { desc: 'Thrombokrit – Volumenanteil der Thrombozyten im Blut', unit: '%', min: 0.17, max: 0.35 },
    // Normoblasten gehören beim Erwachsenen nicht ins periphere Blut — 0 ist der Idealwert.
    // Ein Laborbereich mit min > 0 würde 0.00 als zu niedrig markieren, daher ggf. eigene Score-Funktion.
    // 'NRBC':   { desc: 'Kernhaltige rote Blutkörperchen (Normoblasten) – unreife Erythrozyten-Vorstufen', unit: '10³/µL', min: 0, max: 0.02, score: x => x > 0.02 ? 0 : 1 },
    // 'NRBC_PCT': { desc: 'Normoblasten – Anteil kernhaltiger roter Vorstufen, bezogen auf 100 Leukozyten', unit: '%', min: 0, max: 0, score: x => x > 0 ? 0 : 1 },
    'NEUT':   { desc: 'Neutrophile Granulozyten – häufigste weiße Blutzellen, zentraler Bestandteil der angeborenen Immunabwehr', unit: '10³/µL', min: 2.0, max: 7.5 },
    'LYMPH':  { desc: 'Lymphozyten – weiße Blutzellen des adaptiven Immunsystems (T-, B- und NK-Zellen)', unit: '10³/µL', min: 1.0, max: 4.8, gradient: 0.5 },
    'MONO':   { desc: 'Monozyten – weiße Blutzellen, Vorläufer der Makrophagen und dendritischen Zellen', unit: '10³/µL', min: 0.2, max: 0.9 },
    'EO':     { desc: 'Eosinophile Granulozyten – weiße Blutzellen, aktiv bei Allergien und Parasitenabwehr', unit: '10³/µL', min: 0.04, max: 0.4 },
    'BASO':   { desc: 'Basophile Granulozyten – seltenste weiße Blutzellen, beteiligt an Entzündungs- und Allergiereaktion', unit: '10³/µL', min: 0, max: 0.1 },
    'IG':     { desc: 'Unreife Granulozyten (Immature Granulocytes) – noch nicht ausgereifte Vorläuferzellen', unit: '10³/µL', min: 0, max: 0.05 },
    'IGABS':  { desc: 'Absoluter Wert unreifer Granulozyten (Immature Granulocytes Absolute Count)', unit: '10³/µL', min: 0, max: 0.05 },
    // Prozentanteile am Differentialblutbild (Anteil an Gesamtleukozyten), separat von den
    // gleichnamigen Absolutwerten oben (10³/µL) — siehe pdfAliases: manche Laborgeräte
    // (z.B. Sysmex XN) verwenden für den Prozentwert exakt dasselbe Methodenkürzel wie für den
    // hier bereits vergebenen Absolut-Key (z.B. "NEUT" = Prozent-Spalte, "NEUTA" = Absolut-Spalte),
    // weshalb diese Prozentwerte eigene Keys brauchen statt die Absolut-Referenzbereiche mitzunutzen.
    'NEUT_PCT': { desc: 'Neutrophile Granulozyten – Anteil an den Gesamtleukozyten', unit: '%', min: 40, max: 75 },
    'LYMPH_PCT':{ desc: 'Lymphozyten – Anteil an den Gesamtleukozyten', unit: '%', min: 20, max: 45 },
    'MONO_PCT': { desc: 'Monozyten – Anteil an den Gesamtleukozyten', unit: '%', min: 2, max: 10 },
    'EO_PCT':   { desc: 'Eosinophile Granulozyten – Anteil an den Gesamtleukozyten', unit: '%', min: 1, max: 6 },
    'BASO_PCT': { desc: 'Basophile Granulozyten – Anteil an den Gesamtleukozyten', unit: '%', min: 0, max: 1 },
    'IG_PCT':   { desc: 'Unreife Granulozyten – Anteil an den Gesamtleukozyten', unit: '%', min: 0, max: 0.5 },
    // RET/IRF/LFR/MFR/HFR: Referenzintervalle Sysmex XN, gesunde Erwachsene (m/w gemeinsam – laut Studie
    // keine relevanten Geschlechtsunterschiede): van Pelt et al., Clin Chem Lab Med 2022;60(6):907–920, Tab. 3
    // (Lifelines-Kohorte, n = 15.803), doi:10.1515/cclm-2022-0094. RET % 0,7–2,0 aus derselben Studie,
    // zitiert im Sysmex-White-Paper „Der Retikulozyt und seine Bedeutung“ (10/2022). IRF = MFR + HFR, LFR = 100 − IRF.
    'RET':    { desc: 'Retikulozyten – unreife rote Blutkörperchen direkt nach Verlassen des Knochenmarks', unit: '%', min: 0.7, max: 2.0 },
    'IRF':    { desc: 'Anteil unreifer Retikulozyten (Immature Reticulocyte Fraction)', unit: '%', min: 2.7, max: 13.8 },
    'LFR':    { desc: 'Anteil niedrig fluoreszierender Retikulozyten (Low Fluorescence Ratio) – reife Retikulozyten', unit: '%', min: 86.2, max: 97.6 },
    'MFR':    { desc: 'Anteil mittelfluoreszierender Retikulozyten (Medium Fluorescence Ratio)', unit: '%', min: 2.5, max: 11.9 },
    'HFR':    { desc: 'Anteil hochfluoreszierender Retikulozyten (High Fluorescence Ratio) – jüngste Retikulozyten', unit: '%', min: 0, max: 2.33 },
    // RETI/RETA/RETHE: Sysmex-Kürzel, wie sie in Laborbefunden erscheinen.
    'RETI':   { desc: 'Retikulozyten – Anteil unreifer roter Blutkörperchen an den Erythrozyten, Maß für die Erythropoeseaktivität des Knochenmarks', unit: '%', min: 0.5, max: 2.0 },
    'RETA':   { desc: 'Retikulozyten absolut – Anzahl unreifer roter Blutkörperchen, Maß für die Erythropoeseaktivität des Knochenmarks', unit: 'T/l', min: 0.025, max: 0.1 },
    'RETHE':  { desc: 'Hämoglobingehalt der Retikulozyten – Maß für die aktuelle Eisenversorgung des Knochenmarks', unit: 'pg', min: 28, max: 35 },
    'NLR':    { desc: '⊕ Hergeleitet (NEUT ÷ LYMPH). Neutrophilen-Lymphozyten-Quotient – Marker für systemische Entzündung und Immunstress. Normalbereich ca. 1–3; erhöhte Werte können auf Infektionen, Entzündungen oder maligne Erkrankungen hinweisen.', unit: 'Ratio', min: 1, max: 3, gradient: 0.1 },
    'PLR':    { desc: '⊕ Hergeleitet (PLT ÷ LYMPH). Thrombozyten-Lymphozyten-Quotient – Marker für Entzündung und prothrombotischen Zustand. Normalbereich ca. 50–150; erhöhte Werte werden mit Entzündungserkrankungen und erhöhtem Thromboserisiko assoziiert.', unit: 'Ratio', min: 50, max: 150, gradient: 0.1 },
    'MLR':    { desc: '⊕ Hergeleitet (MONO ÷ LYMPH). Monozyten-Lymphozyten-Quotient – Marker für chronische Entzündung und angeborene Immunaktivierung. Normalbereich ca. 0,1–0,3; erhöhte Werte finden sich bei Infektionen und malignen Erkrankungen.', unit: 'Ratio', min: 0.1, max: 0.3, gradient: 0.03 },
    'SII':    { desc: '⊕ Hergeleitet ((PLT × NEUT) ÷ LYMPH). Systemischer Immun-Entzündungs-Index – umfassender Entzündungsindex. Normalbereich ca. 400–800; gilt als sensitiver Marker für Prognose und Verlauf entzündlicher und maligner Erkrankungen.', unit: 'Index', min: 350, max: 800, gradient: 0.1 },
    'SIRI':   { desc: '⊕ Hergeleitet ((NEUT × MONO) ÷ LYMPH). Systemischer Entzündungsantwort-Index – Marker für die Stärke der Entzündungsreaktion. Normalbereich ca. 0,3–1,5; erhöhte Werte sind mit schlechterem klinischen Verlauf bei Infektionen und Malignomen assoziiert.', unit: 'Index', min: 0.3, max: 1.5, gradient: 0.05 },
    'FreePSA_Ratio_Percent': { desc: '⊕ Hergeleitet (freePSA ÷ PSA × 100). Verhältnis von freiem zu gesamtem Prostata-spezifischem Antigen – Marker für Prostatakrebsrisiko. Normalbereich ca. 15–25%; niedrigere Werte können auf erhöhtes Risiko für Prostatakarzinom hinweisen.', unit: '%', min: 15, max: 30, gradient: 0.5 },
    'TRAVEL_RISK': { desc: '⊕ Berechnetes Reiserisiko (%). Stetiges Modell basierend auf Blutbildparametern (NLR, PLR, RDW, HCT, PDW/MPV): 0% = sicher für Reisen, 100% = lebensgefährlich (Thromboembolie-Risiko). Nutzt Sigmoid-Funktionen für sanfte Risikobewertung. ⚠️ Ärztliche Beratung erforderlich.', unit: '%', min: 0, max: 10, gradient: 1 },
    'NA':    { desc: 'Natrium – wichtigstes Kation des Extrazellulärraums, zentral für Wasserhaushalt und Nervenerregbarkeit', unit: 'mmol/l', min: 135, max: 145, gradient: 0.5 },
    'K':     { desc: 'Kalium – wichtigstes intrazelluläres Kation, entscheidend für neuromuskuläre Erregbarkeit und Herzrhythmus', unit: 'mmol/l', min: 3.5, max: 5.1, gradient: 0.2 },
    'CA':    { desc: 'Calcium – zentrale Rolle in Knochenstoffwechsel, Blutgerinnung und neuromuskulärer Signalübertragung', unit: 'mmol/l', min: 2.15, max: 2.6 },
    'MG':    { desc: 'Magnesium – Cofaktor zahlreicher Enzyme, wichtig für Muskel- und Nervenfunktion sowie Herzrhythmus', unit: 'mmol/l', min: 0.7, max: 1.05 },
    'CREA':  { desc: 'Kreatinin (Jaffé-Methode) – Abbauprodukt des Muskelstoffwechsels, Marker der Nierenfunktion', unit: 'mg/dl', min: 0.5, max: 1.2, m: { min: 0.7, max: 1.2 }, w: { min: 0.5, max: 0.9 } },
    'EGFR':  { desc: 'Geschätzte glomeruläre Filtrationsrate nach CKD-EPI-Formel – Maß der Nierenfunktion', unit: 'ml/min', min: 90, max: 130, gradient: 0.2 },
    'UA':    { desc: 'Harnsäure – Abbauprodukt des Purinstoffwechsels, bei Erhöhung Risiko für Gicht und kardiovaskuläre Erkrankungen', unit: 'mg/dl', min: 2.4, max: 7, m: { min: 3.4, max: 7 }, w: { min: 2.4, max: 5.7 }, gradient: 0.2 },
    'TBIL':  { desc: 'Bilirubin gesamt – Abbauprodukt des Hämoglobins, Marker der Leberfunktion und Hämolyse', unit: 'mg/dl', min: 0.1, max: 1.2 },
    'ALT':   { desc: 'GPT/ALT (Alanin-Aminotransferase) – leberspezifisches Enzym, Marker für Hepatozytenschädigung', unit: 'U/l', min: 10, max: 50, m: { min: 10, max: 50 }, w: { min: 10, max: 35 } },
    'GGT':   { desc: 'Gamma-Glutamyltransferase – Leber-/Gallenwegsenzym, sensitiver Marker für Cholestase und Alkoholeinfluss', unit: 'U/l', min: 6, max: 71, m: { min: 10, max: 71 }, w: { min: 6, max: 42 } },
    'AP':    { desc: 'Alkalische Phosphatase – Enzym aus Leber, Gallenwegen und Knochen, Marker für Cholestase und Knochenumbau', unit: 'U/l', min: 35, max: 129, m: { min: 40, max: 129 }, w: { min: 35, max: 104 } },
    'LDH':   { desc: 'Laktatdehydrogenase – unspezifischer Marker für Zellschädigung (u.a. Hämolyse, Zellzerfall)', unit: 'U/l', min: 135, max: 225, w: { min: 135, max: 214 } },
    'LIP':   { desc: 'Lipase – Verdauungsenzym der Bauchspeicheldrüse, Marker für Pankreasschädigung', unit: 'U/l', min: 13, max: 60 },
    'ALB':   { desc: 'Albumin im Serum – wichtigstes Plasmaprotein, Marker für Ernährungszustand, Lebersyntheseleistung und Eiweißverlust', unit: 'g/dl', min: 3.5, max: 5.2 },
    'GLU':   { desc: 'Glucose – zentraler Energieträger, Marker für Kohlenhydratstoffwechsel und Diabetes', unit: 'mg/dl', min: 70, max: 100, gradient: 0.1 },
    'CRP':   { desc: 'C-reaktives Protein – Akute-Phase-Protein, Marker für Entzündung und Infektion', unit: 'mg/l', min: 0, max: 5 },
    'PHOS':  { desc: 'Phosphat – Mineral mit Bedeutung für Knochenstoffwechsel und Energiehaushalt (ATP)', unit: 'mg/dl', min: 2.5, max: 4.5 },
    'TSH':   { desc: 'Thyreoidea-stimulierendes Hormon – Marker für Schilddrüsenfunktion', unit: 'µIU/ml', min: 0.4, max: 4.0 },
    'FT4':   { desc: 'Freies Thyroxin – aktives Schilddrüsenhormon, Marker für Schilddrüsenfunktion', unit: 'ng/dl', min: 0.8, max: 1.8 },
    'FT3':   { desc: 'Freies Trijodthyronin – aktives Schilddrüsenhormon, Marker für Schilddrüsenfunktion', unit: 'pg/ml', min: 2.3, max: 4.2 },
    'T3':    { desc: 'Trijodthyronin – Schilddrüsenhormon, Marker für Schilddrüsenfunktion', unit: 'ng/dl', min: 0.8, max: 2.0 },
    'T4':    { desc: 'Thyroxin – Schilddrüsenhormon, Marker für Schilddrüsenfunktion', unit: 'µg/dl', min: 4.5, max: 12.0 },
    'TPO':   { desc: 'Thyreoperoxidase-Antikörper – Marker für Autoimmunthyreoiditis (Hashimoto, Morbus Basedow)', unit: 'IU/ml', min: 0, max: 34 },
    'TG':    { desc: 'Thyreoglobulin-Antikörper – Marker für Autoimmunthyreoiditis (Hashimoto, Morbus Basedow)', unit: 'IU/ml', min: 0, max: 115 },
    'IRON':  { desc: 'Eisen – zentraler Bestandteil des Hämoglobins, Marker für Eisenstoffwechsel', unit: 'µg/dl', min: 50, max: 170, m: { min: 65, max: 175 }, w: { min: 50, max: 170 } },
    'FERR':  { desc: 'Ferritin – Eisenspeicherprotein, Marker für Eisenstoffwechsel und Entzündung', unit: 'ng/ml', min: 15, max: 400, m: { min: 30, max: 400 }, w: { min: 15, max: 150 } },
    'B12':   { desc: 'Vitamin B12 (Cobalamin) – essenziell für Blutbildung und Nervenfunktion; Mangel führt zu makrozytärer Anämie', unit: 'pg/ml', min: 191, max: 663 },
    'FOL':   { desc: 'Folsäure – essenziell für Zellteilung und Blutbildung; Mangel führt zu makrozytärer Anämie', unit: 'ng/ml', min: 3.89, max: 20 },
    'PSA':   { desc: 'Prostata-spezifisches Antigen – Marker für Prostataerkrankungen (Grenzwert altersabhängig)', unit: 'ng/ml', min: 0, max: 4, gradient: 0.1 },
    'freePSA': { desc: 'Freies Prostata-spezifisches Antigen – Marker für Prostataerkrankungen', unit: 'ng/ml', min: 0, max: 6, gradient: 0.1 },
    'Cystatin_C': { desc: 'Marker für die Nierenfunktion', unit: 'mg/l', min: 0.61, max: 0.95, gradient: 0.1 },
    'HoloTranscobalamin': { desc: 'Holo-Transcobalamin – aktive Form von Vitamin B12, Marker für B12-Status', unit: 'pg/ml', min: 60, max: 900, gradient: 0.1 },
    'Methylmalonsäure': { desc: 'Marker für Vitamin B12-Mangel', unit: 'µg/l', min: 0, max: 300, gradient: 0.1 },
    'pro-BNP': { desc: 'Pro-BNP – Marker für Herzinsuffizienz (Grenzwert altersabhängig)', unit: 'pg/ml', min: 0, max: 125, gradient: 0.1 },
  },

  // ── PDF-Laborbefunde: Gerätekürzel → Marker-Key ───────────────────────────
  // Deutsche Hämatologie-Ausdrucke (z.B. Sysmex XN) benennen Zeilen mit
  // eigenen Kürzeln. Weitere Kürzel lassen sich in config-user.js →
  // pdfAliases ergänzen. Hat Vorrang vor einem direkten Marker-Treffer (siehe
  // resolvePdfAbbr in blood-data.js): NEUT/LYMPH/MONO/BASO/IG sind auf dem
  // Ausdruck die Prozent-Spalten, nicht die gleichnamigen Absolutwerte.
  pdfAliases: {
    LEUKO: 'WBC', ERY: 'RBC', HB: 'HGB', HK: 'HCT', HKT: 'HCT',
    THROMB: 'PLT', THRO: 'PLT',
    NEUTRO: 'NEUT_PCT', LYMPHO: 'LYMPH_PCT', EOS: 'EO_PCT', BASOS: 'BASO_PCT',
    PLCR: 'P-LCR', RDWCV: 'RDW-CV', RDWSD: 'RDW-SD',
    NEUT: 'NEUT_PCT', LYMPH: 'LYMPH_PCT', MONO: 'MONO_PCT', BASO: 'BASO_PCT', IG: 'IG_PCT',
    NEUTA: 'NEUT', LYMPHA: 'LYMPH', EOSA: 'EO', BASOA: 'BASO', MONOA: 'MONO', IGABS: 'IG',
    NORMOA: 'NRBC', 'NORMO%': 'NRBC_PCT',
    KREAJ: 'CREA', CKDEPI: 'EGFR', HS: 'UA', GPT: 'ALT', P: 'PHOS',
  },

  // ── Profil ─────────────────────────────────────────────────────────────────
  // sex: 'm' | 'w' | null (null → neutrale min/max der Marker)
  profile: { sex: null },

  // ── Apps (Kacheln auf der Startseite, Einträge im ☰-Menü) ──────────────────
  // Ausblenden über config-user.js → hiddenPages: ['medicalc', …]
  pages: [
    { key: 'blutbild', href: 'blutbild.html', label: 'Blutbild via OCR',   icon: '🩸' },
    { key: 'plan',     href: 'plan.html',     label: 'Medikations-Plan',   icon: '💊' },
    { key: 'data',     href: 'data.html',     label: 'Zeitreihen',         icon: '📈' },
    { key: 'medicalc', href: 'medicalc.html', label: 'MediCalc',           icon: '🧮' },
    { key: 'radar',    href: 'radar.html',    label: 'Spinnennetz',        icon: '🕸️' },
    { key: 'befund',   href: 'befund.html',   label: 'Befund',             icon: '👨‍⚕️' },
  ],

  // ── Zeitreihen (data.html) ─────────────────────────────────────────────────
  // Ausblenden einzelner Tabs über config-user.js → hiddenTabs: ['qt', …]
  // QT-Schwellen: etablierte Grenzwerte (ICH E14 / klinische Praxis bei
  // medikamentös bedingter QT-Verlängerung).
  qt: {
    absBorderline:  470, // ms QTc — grenzwertig verlängert
    absCritical:    500, // ms QTc — TdP-Risiko
    deltaAttention: 30,  // ms ΔQTc ggü. Baseline — ICH-E14-Schwelle "beachtenswert"
    deltaCritical:  60,  // ms ΔQTc ggü. Baseline — klinisch signifikanter Anstieg
  },

  // ── Befund (KI-Analyse) ────────────────────────────────────────────────────
  // {{fachgebiete}} wird durch befund.specialties ersetzt, {{datenquellen}}
  // beim Senden durch die ausgewählten Datensätze. Der Prompt ist in der App
  // editierbar; dieser Text ist nur der Standard.
  befund: {
    specialties: 'Labordiagnostik, Hämatologie, Innere Medizin und Kardiologie',
    systemPrompt: `Du bist ein erfahrener Arzt und Medizinexperte, spezialisiert auf {{fachgebiete}}. Du kennst den neuesten Forschungsstand und kannst Zusammenhänge zwischen diesen Fachgebieten herstellen.
Analysiere die folgenden medizinischen Zeitreihendaten ({{datenquellen}}) und erstelle einen umfassenden medizinischen Befundbericht auf Deutsch. Fokussiere dich auf die Interpretation der letzten Trends und Werte. Berücksichtige die Bedeutung der einzelnen Parameter, mögliche Zusammenhänge zwischen den verschiedenen Datenquellen und was die Veränderungen kurz-, mittel- und langfristig bedeuten könnten.
Sei dabei sachlich, nicht alarmistisch!

Gehe dabei systematisch vor:
1. Überblick: Zusammenfassung der wichtigsten Auffälligkeiten
2. Einzelwertanalyse: Bewerte jeden Parameter (Normal / Erhöht / Erniedrigt) und erkläre die klinische Bedeutung
3. Trendanalyse: Identifiziere Veränderungen über die Zeit (Verbesserungen, Verschlechterungen, stabile Werte)
4. Medizinische Interpretation: Mögliche Zusammenhänge und Muster zwischen den Parametern (auch über verschiedene Datenquellen hinweg)? Sind Nebenwirkungen der Medikation erkennbar? Kreuzwirkungen zwischen Medikamenten und Blutwerten? Welche Werte könnten auf Nebenleiden hinweisen?
5. Empfehlungen: Welche Werte sollten besonders beobachtet werden? Welche weiteren Diagnoseschritte und welche weiteren Blutwerte könnten sinnvoll sein? Welche Maßnahmen (Ernährung, Bewegung, Medikation) könnten unterstützend sein?
6. Prognose: Basierend auf den Trends und den jüngsten Werten, welche Entwicklungen könnten in Zukunft zu erwarten sein?
7. Fazit: Fasse die aktuellen Entwicklungen zusammen und formuliere eine klare, verständliche, aktuelle Schlussfolgerung für den Patienten.
`,
  },

  // ── MediCalc (Arztrechnungen: Beihilfe / private Krankenversicherung) ─────
  // Nur Startwerte — in der App unter „Konfiguration“ änderbar.
  medicalc: { beihilfeRate: 0.5, pkvRateLow: 0.5, pkvRateHigh: 0.5, eigenanteilThreshold: 0 },

  // ── Startdaten ─────────────────────────────────────────────────────────────
  // Werden nur beim allerersten Start (leere Datenbank) übernommen. Eigene
  // Startdaten gehören in config-user.js → seed.
  seed: {
    medication: {},   // plan.html: { Kürzel: { desc, sub, start, duration, rxWarningDays } }
    events:     [],   // Therapie-Ereignisse: [{ begin, end, desc, isTherapyStart }]
    radiation:  {},   // { 'YYYY-MM-DD': { typ, dose } }
    bp:         [],
    qt:         [],
    weight:     [],
  },
};
