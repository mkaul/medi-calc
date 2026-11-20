# MediCalc

Clientseitige Gesundheits-Tools als offline-fähige Web-App (PWA). Alle Daten bleiben im Browser des eigenen Geräts (IndexedDB). Es gibt keinen Server und kein Konto. Synchronisiert wird zwischen Geräten per ZIP-Datei, z. B. über einen iCloud-Drive-Ordner.

| App | Zweck |
|---|---|
| 🩸 **Blutbild via OCR** | Laborbefunde per Kamera/Bild (PaddleOCR im Browser), als TXT oder PDF einlesen. Trendcharts je Blutwert, abgeleitete Kennzahlen (NLR, PLR, SII …) |
| 💊 **Medikations-Plan** | Packungen, Reichweite und Rezept-Vorlauf je Medikament, Notizen |
| 📈 **Zeitreihen** | Therapie-Ereignisse, Strahlenbelastung, Blutdruck, QT-Werte (mit QT-Simulator), Gewicht; erweiterbar über Module |
| 🧮 **MediCalc** | Arztrechnungen und Erstattungen (Beihilfe/private Krankenversicherung) |
| 🕸️ **Spinnennetz** | Alle Blutwerte auf einen Blick als Radar-Chart, eingefärbt nach Referenzbereich |
| 👨‍⚕️ **Befund** | KI-Befundbericht über ausgewählte Daten (Anthropic Claude oder DeepSeek, eigener API-Schlüssel). Nur die im Dialog angehakten Daten verlassen das Gerät. |

> ⚠️ Kein Medizinprodukt. Alle Auswertungen dienen der persönlichen Übersicht und ersetzen keine ärztliche Beurteilung.

## Schnellstart

```bash
npm run serve          # http://127.0.0.1:8000
```

Jeder andere statische Webserver funktioniert ebenso, z. B. GitHub Pages oder eigener Webspace. Beim ersten Aufruf lädt die App alles für den Offline-Betrieb. Danach lässt sie sich über „Zum Home-Bildschirm“ bzw. „Installieren“ als App nutzen.

Ohne weitere Einrichtung startet die App leer und verwendet allgemeine Referenzbereiche für Erwachsene.

## Konfiguration

Funktionalität und persönliche Daten sind getrennt:

| Datei | Inhalt | Im Repository? |
|---|---|---|
| `config-system.js` | Marker-Katalog mit allgemeinen Referenzbereichen (m/w), PDF-Kürzel, QT-Schwellen, Standard-Prompt, App-Liste | ja |
| `config-user.example.js` | Vorlage für die persönliche Konfiguration | ja |
| `config-user.js` | **persönliche** Konfiguration | nein (`.gitignore`) |
| `private/` | **persönliche** Module | nein (`.gitignore`) |
| `config.js` | führt alles zu `APP_CONFIG` zusammen, Modul-Registry | ja |

**Eigene Installation (lokal / eigener Webspace):** `config-user.example.js` nach `config-user.js` kopieren und anpassen. Danach `npm run bump` ausführen, damit installierte Apps die Änderung über „🔄 Update“ erhalten.

**Installation ohne eigene Dateien (z. B. GitHub Pages):** Die angepasste Datei über ☰ → *Konfiguration* → „Nutzerkonfiguration laden“ einlesen. Sie wird nur auf diesem Gerät gespeichert, hat Vorrang vor einer `config-user.js` auf dem Server und reist mit dem ZIP-Export auf andere Geräte mit.

Die wichtigsten Einstellungen in `config-user.js`:

| Schlüssel | Bedeutung |
|---|---|
| `profile.sex` | `'m'` / `'w'`: wählt die geschlechtsspezifischen Referenzbereiche |
| `referenceRanges` | Referenzbereiche des eigenen Labors, z. B. `{ WBC: { min: 3.9, max: 10.2 } }` |
| `markers`, `hiddenMarkers` | zusätzliche bzw. ausgeblendete Blutwerte |
| `pdfAliases` | weitere Gerätekürzel aus PDF-Laborbefunden → Marker |
| `hiddenPages`, `hiddenTabs` | Apps bzw. Zeitreihen-Tabs ausblenden |
| `befund.specialties` / `befund.systemPrompt` | Schwerpunkt bzw. kompletter Prompt der KI-Analyse |
| `medicalc` | Erstattungssätze (Beihilfe, PKV, Eigenanteil-Schwelle) |
| `seed` | Startdaten (Medikamente, Ereignisse, Strahlung …), nur bei leerer Datenbank |
| `privateScripts` | eigene Module laden (siehe unten) |
| `privacy.denylist` | Begriffe, die nie veröffentlicht werden dürfen (siehe *Datenschutz-Prüfung*) |

## Eigene Module

Ein Modul ist ein klassisches Skript, das sich bei `MediModules` anmeldet. Es wird über `config-user.js → privateScripts` geladen, typischerweise aus `private/`. So lassen sich eigene Zeitreihen-Tabs, Datensätze für den Befund und die ZIP-Synchronisation ergänzen, ohne öffentlichen Code zu ändern.

```js
// private/glucose.js
(function () {
  let values = [];
  window.MediModules.register({
    id: 'glucose',
    label: 'Blutzucker',
    data: {                                   // Tab in data.html
      tab: { id: 'glucose', label: 'Blutzucker', order: 70 },
      panelHtml: '<table><tbody id="glucose-tbody"></tbody></table>',
      async load(dbGet) { values = (await dbGet('glucose')) || []; },
      save: dbPut => [dbPut('glucose', values)],
      renderTable() { /* … */ },
      buildChart() { /* chart = new Chart(document.getElementById('main-chart'), …) */ },
    },
    befund: {                                 // Datensatz für die KI-Analyse
      async datasets(getRecord) { /* [{ key, label, countLabel, build }] */ return []; },
    },
    bulk: {                                   // ZIP-Export/-Import
      payloadKeys: ['glucoseData'],
      async exportPayload(get) { return { glucoseData: await get('glucose') }; },
      async planImport(payload, ctx) { /* ctx.work / ctx.add / ctx.changed … */ },
    },
  });
})();
```

Alle Hooks sind dokumentiert: `data` im Abschnitt „MODULE“ von `data.html`, `bulk` bei `planMedizinischeDaten` in `bulk-import.js`, die Registry in `config.js`.

## Daten und Synchronisation

- **☰ → Alle Daten exportieren (ZIP):** Stand aller Apps inklusive Nutzerkonfiguration. Auf Touch-Geräten über das Teilen-Menü.
- **☰ → Alle Daten importieren (ZIP):** gleicht ab statt zu überschreiben. Neues wird ergänzt, Geändertes aktualisiert. Erst nach Bestätigung in einer Vorschau wird etwas geschrieben.
- **Löschvermerke:** Bewusst Gelöschtes (✕) wird als Vermerk mit exportiert. Ein Import bringt es nicht zurück, und auf dem anderen Gerät Gelöschtes wird zum Löschen angeboten.
- **Blutbild-Dateien** brauchen ein Datum am Anfang des Dateinamens (`2026-08-05 …`), damit die Werte zeitlich eingeordnet werden. Bei PDFs wird das Messdatum jeder Zeile zusätzlich mit dem Dateinamen abgeglichen.

## Entwicklung

```bash
npm run bump            # Version erhöhen (patch | minor | major | x.y.z) – nie von Hand
npm run check           # Versionen, Precache, gepinnte CDN-URLs, Icons, Datenschutz
npm run test:browser    # Headless Chrome: online → offline → Update, mit und ohne config-user.js
npm run serve           # lokaler Server ohne Caching
```

- **Offline-first:** Der Service Worker (`sw.js`) liefert alle eigenen Dateien cache-first aus. CDN-Bibliotheken (Chart.js, OpenCV, PaddleOCR, pdf-parse) liegen mit exakter Version in einem eigenen, versionsunabhängigen Cache.
- **Updates nur per Button:** Eine neue Version wird installiert und wartet, bis „🔄 Update“ sie aktiviert. Die Version steht in `sw.js` und `manifest.json`. `config-user.js` und die Module aus `privateScripts` werden zusätzlich (optional) vorgeladen.
- **Datenschutz-Prüfung:** `npm run check` durchsucht jede Datei, die veröffentlicht würde (alles außer `.gitignore`-Treffern), nach den Begriffen aus `config-user.js → privacy.denylist`. Außerdem prüft es, dass `config-user.js` und `private/` ignoriert werden. Vor jedem `git push` ausführen.

## Lizenz

Schrift *Plus Jakarta Sans*: SIL Open Font License (`fonts/OFL.txt`).
