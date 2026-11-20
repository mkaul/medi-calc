#!/usr/bin/env node
// End-to-end test in headless Chrome against a temporary copy of the app
// (adapted from the offline-app template). One browser profile, three phases:
//
//   1. ONLINE   every page loads without console errors; the CDN scripts
//               (Chart.js, Clipper, OpenCV) end up in the service worker's
//               CDN cache; a marker record is written to IndexedDB
//   2. OFFLINE  HTTP cache cleared, local server stopped AND every external
//               host unresolvable:
//               every page still loads, Chart.js / Clipper / OpenCV and the
//               local font are available, data is still there
//   3. UPDATE   server back with a bumped version: the new version installs
//               but WAITS (no silent switch on reload), the menu offers it,
//               the Update button activates it; data and CDN cache survive
//
//   Zwei Varianten (npm run test:browser führt beide aus):
//     node tools/test-browser.mjs            mit config-user.js + private/ (falls vorhanden)
//     node tools/test-browser.mjs --generic  ohne persönliche Dateien, wie auf GitHub
//   npm run test:browser          (CHROME=/path/to/chrome to override)
import { spawn } from 'node:child_process';
import { mkdtemp, rm, cp, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './serve.mjs';

const PAGES = ['index.html', 'blutbild.html', 'plan.html', 'data.html', 'medicalc.html', 'radar.html', 'befund.html', 'EKG.html'];
// page → expression that must be true once its libraries are usable
const LIBS = {
  'blutbild.html': `typeof Chart === 'function' && typeof ClipperLib === 'object' && typeof cv === 'object'`,
  'data.html': `typeof Chart === 'function'`,
  'radar.html': `typeof Chart === 'function'`,
};
const CDN_EXPECTED = ['chart.js@4.5.1', 'clipper-lib@6.4.2', 'opencv.js'];

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GENERIC = process.argv.includes('--generic') || !existsSync(path.join(source, 'config-user.js'));
const root = await mkdtemp(path.join(tmpdir(), 'medicalc-copy-'));
await cp(source, root, { recursive: true, filter: f => !/[\\/](\.git|node_modules)$/.test(f)
  && !(GENERIC && /[\\/](config-user\.js|private)$/.test(f)) });
console.log(GENERIC ? '══ Variante: ohne persönliche Dateien (wie veröffentlicht)' : '══ Variante: mit config-user.js und privaten Modulen');
const profile = await mkdtemp(path.join(tmpdir(), 'medicalc-chrome-'));

const chromePath = [
  process.env.CHROME,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome', '/usr/bin/chromium',
].filter(Boolean).find(p => existsSync(p));
if (!chromePath) { console.error('Chrome nicht gefunden – Pfad per CHROME=… angeben.'); process.exit(2); }

const swFile = path.join(root, 'sw.js');
const manifestFile = path.join(root, 'manifest.json');
const v1 = /const APP_VERSION = '([^']+)'/.exec(await readFile(swFile, 'utf8'))[1];
const v2 = v1.replace(/\d+$/, n => Number(n) + 1);

let server = await startServer({ root, port: 0, quiet: true });
const port = server.address().port;
const base = `http://127.0.0.1:${port}/`;
const stopServer = () => new Promise(r => { server.close(r); server.closeAllConnections(); });
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Minimal Chrome DevTools Protocol client ─────────────────────────────────
async function launch(extraArgs = []) {
  const proc = spawn(chromePath, [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', ...extraArgs, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  const wsUrl = await new Promise((resolve, reject) => {
    let buf = '';
    proc.stderr.on('data', d => { buf += d; const m = /DevTools listening on (ws:\/\/\S+)/.exec(buf); if (m) resolve(m[1]); });
    proc.on('exit', code => reject(new Error(`Chrome beendet (${code})`)));
    setTimeout(() => reject(new Error('Chrome startet nicht')), 20000);
  });
  const ws = new WebSocket(wsUrl);
  await new Promise(r => ws.addEventListener('open', r, { once: true }));
  let nextId = 0;
  const pending = new Map();
  const problems = [];
  ws.addEventListener('message', e => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return; }
    if (msg.method === 'Runtime.exceptionThrown') problems.push(msg.params.exceptionDetails.exception?.description?.split('\n')[0] || msg.params.exceptionDetails.text);
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') problems.push(msg.params.args.map(a => a.value ?? a.description).join(' ').slice(0, 200));
  });
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, msg => (msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)));
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Runtime.enable', {}, sessionId);
  await send('Page.enable', {}, sessionId);

  const evaluate = async expression => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    return r.result.value;
  };
  const waitFor = async (expression, ms = 10000) => {
    for (let t = 0; t < ms; t += 150) {
      const v = await evaluate(expression).catch(() => null);
      if (v) return v;
      await sleep(150);
    }
    return null;
  };
  const open = async url => {
    await send('Page.navigate', { url }, sessionId);
    await waitFor(`document.readyState === 'complete'`, 15000);
  };
  const close = async () => { ws.close(); proc.kill(); await new Promise(r => proc.once('exit', r)); };
  // Browser HTTP cache only — Cache Storage (the service worker's) stays.
  const clearHttpCache = () => send('Network.clearBrowserCache', {}, sessionId);
  return { evaluate, waitFor, open, close, clearHttpCache, problems };
}

let failures = 0;
const step = (ok, label) => { console.log(`${ok ? '✓' : '✗'} ${label}`); if (!ok) failures++; return ok; };
const cdnCacheKeys = `caches.open('blutbild-cdn').then(c => c.keys()).then(ks => ks.map(r => r.url))`;

let browser;
try {
  // ── 1. Online ─────────────────────────────────────────────────────────────
  console.log('— Phase 1: online');
  browser = await launch();
  await browser.open(base + 'index.html');
  step(await browser.waitFor('!!navigator.serviceWorker.controller', 20000), 'Service Worker steuert die Seite');
  for (const page of PAGES) {
    browser.problems.length = 0;
    await browser.open(base + page);
    if (LIBS[page]) step(await browser.waitFor(LIBS[page], 60000), `${page}: Bibliotheken geladen`);
    await sleep(800);
    step(browser.problems.length === 0, `${page}: keine Konsolenfehler${browser.problems.length ? ' – ' + browser.problems.join(' | ') : ''}`);
  }
  // ── Funktion: Konfiguration, Module, Tabs, Charts ─────────────────────────
  browser.problems.length = 0;
  await browser.open(base + 'index.html');
  const pageCount = await browser.evaluate('APP_CONFIG.pages.length');
  step(pageCount > 0 && await browser.evaluate(`document.querySelectorAll('#app-grid .app-tile').length`) === pageCount, `index.html: ${pageCount} Kacheln aus der Konfiguration`);
  step(await browser.evaluate('APP_CONFIG.source') === (GENERIC ? 'none' : 'file'), `Konfigurationsquelle: ${GENERIC ? 'keine' : 'config-user.js'}`);
  await browser.open(base + 'data.html');
  await browser.waitFor(`typeof Chart === 'function' && document.querySelector('.tab.active')`, 30000);
  await sleep(500);
  const tabs = await browser.evaluate(`[...document.querySelectorAll('.tab')].map(t => t.dataset.tab).join(',')`);
  const modules = await browser.evaluate(`MediModules.all().map(m => m.id).join(',')`);
  if (GENERIC) {
    step(modules === '', `data.html: keine Module registriert (${modules || '–'})`);
    step(tabs === 'radiation,events,bp,qt,weight', `data.html: Kern-Tabs ${tabs}`);
  } else {
    step(modules.length > 0, `data.html: Module registriert (${modules})`);
    step(tabs.split(',').length > 5, `data.html: Tabs inkl. Module ${tabs}`);
  }
  for (const tab of tabs.split(',')) {
    await browser.evaluate(`document.querySelector('.tab[data-tab="${tab}"]').click()`);
    await sleep(300);
  }
  step(browser.problems.length === 0, `data.html: alle Tabs ohne Fehler durchgeklickt${browser.problems.length ? ' – ' + browser.problems.join(' | ') : ''}`);
  // Seed-Daten der Konfiguration (nur mit config-user.js): erster Tab hat ein Chart.
  await browser.evaluate(`document.querySelector('.tab').click()`);
  await sleep(500);
  if (!GENERIC) step(await browser.evaluate('chart !== null'), 'data.html: Chart aus den Startdaten gezeichnet');
  if (GENERIC) {
    // Nutzerkonfiguration importieren (wie über ☰ → „Nutzerkonfiguration laden“)
    browser.problems.length = 0;
    await browser.evaluate(`APP_CONFIG.saveImportedUserConfig(APP_CONFIG.parseUserConfig(${JSON.stringify(JSON.stringify({
      profile: { sex: 'w' }, referenceRanges: { WBC: { min: 3.9 } }, hiddenTabs: ['qt'],
      seed: { events: [{ begin: '2026-01-01', end: '', desc: 'E2E-Ereignis' }], radiation: { '2026-01-02': { typ: 'E2E', dose: 1 } } },
    }))}), 'e2e.json')`);
    await browser.open(base + 'data.html');
    await browser.waitFor(`typeof Chart === 'function' && document.querySelector('.tab.active')`, 30000);
    await sleep(500);
    step(await browser.evaluate(`APP_CONFIG.source === 'import' && APP_CONFIG.markers.WBC.min === 3.9 && APP_CONFIG.markers.HGB.max === 15.5`), 'Importierte Konfiguration: Quelle, eigener Laborbereich, Frauen-Bereich');
    step(await browser.evaluate(`!document.querySelector('.tab[data-tab="qt"]') && events.length === 1 && chart !== null`), 'Importierte Konfiguration: Tab ausgeblendet, Startdaten, Strahlungs-Chart');
    step(browser.problems.length === 0, `Importierte Konfiguration: keine Konsolenfehler${browser.problems.length ? ' – ' + browser.problems.join(' | ') : ''}`);
    await browser.evaluate('APP_CONFIG.clearImportedUserConfig()');
  }
  await browser.open(base + 'befund.html');
  await sleep(500);
  step(await browser.evaluate(`MediModules.with('befund').length`) === (GENERIC ? 0 : modules.split(',').filter(Boolean).length), 'befund.html: Datensätze der Module registriert');

  await browser.evaluate(`new Promise((resolve, reject) => {
    const req = indexedDB.open('BlutbildDB', 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('files')) db.createObjectStore('files', { keyPath: 'fileId' }).createIndex('lastModified', 'lastModified');
      if (!db.objectStoreNames.contains('metadata')) db.createObjectStore('metadata', { keyPath: 'key' });
    };
    req.onsuccess = () => { const tx = req.result.transaction('metadata', 'readwrite'); tx.objectStore('metadata').put({ key: 'e2e-marker', value: 42 }); tx.oncomplete = () => { req.result.close(); resolve(); }; };
    req.onerror = () => reject(req.error);
  })`);
  const cdn = await browser.waitFor(`${cdnCacheKeys}.then(urls => ${JSON.stringify(CDN_EXPECTED)}.every(e => urls.some(u => u.includes(e))) && urls)`, 30000);
  step(!!cdn, `CDN-Cache enthält ${CDN_EXPECTED.join(', ')}`);
  // Offline must not depend on the browser's HTTP cache (Chart.js: max-age
  // 7 days; iOS evicts it much earlier) — only on the service worker.
  await browser.clearHttpCache();
  await browser.close();

  // ── 2. Offline ────────────────────────────────────────────────────────────
  console.log('— Phase 2: offline (lokaler Server aus, alle externen Hosts unerreichbar)');
  await stopServer();
  browser = await launch(['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1']);
  const offlineErrors = {};
  for (const page of PAGES) {
    browser.problems.length = 0;
    await browser.open(base + page);
    step(await browser.waitFor(`!!document.querySelector('h1, header, main, canvas')`, 10000), `${page}: lädt offline`);
    if (page === 'data.html' && !GENERIC) step(await browser.waitFor(`MediModules.all().length > 0 && document.querySelectorAll('.tab').length > 5`, 10000), 'data.html: private Module offline verfügbar');
    if (LIBS[page]) step(await browser.waitFor(LIBS[page], 30000), `${page}: Bibliotheken offline verfügbar`);
    await sleep(500);
    if (browser.problems.length) offlineErrors[page] = [...browser.problems];
  }
  await browser.open(base + 'blutbild.html');
  step(await browser.waitFor(`document.fonts.ready.then(() => [...document.fonts].some(f => f.family.includes('Jakarta') && f.status === 'loaded'))`, 10000),
    'blutbild.html: Schrift Plus Jakarta Sans offline geladen');
  step(await browser.evaluate(`fetch('nicht-im-cache.txt').then(r => r.status, () => 'network-error')`) === 503, 'Gegenprobe: Server ist wirklich aus (nicht gecachte Datei → 503)');
  // sw.js answers a failed CDN fetch with 503 (Response.error() only for <script>).
  const cdnProbe = await browser.evaluate(`fetch('https://cdn.jsdelivr.net/npm/nicht-gecacht@1.0.0/x.js', { mode: 'cors' }).then(r => r.status, () => 'network-error')`);
  step(cdnProbe === 503 || cdnProbe === 'network-error', `Gegenprobe: CDN ist wirklich unerreichbar (${cdnProbe})`);
  for (const [page, errs] of Object.entries(offlineErrors)) console.log(`  ℹ️  ${page} offline: ${errs.join(' | ')}`);
  await browser.close();

  // ── 3. Update ─────────────────────────────────────────────────────────────
  console.log(`— Phase 3: Update ${v1} → ${v2}`);
  await writeFile(swFile, (await readFile(swFile, 'utf8')).replace(`APP_VERSION = '${v1}'`, `APP_VERSION = '${v2}'`));
  await writeFile(manifestFile, (await readFile(manifestFile, 'utf8')).replace(`"version": "${v1}"`, `"version": "${v2}"`));
  server = await startServer({ root, port, quiet: true });
  browser = await launch();
  const shownVersion = `document.getElementById('start-version')?.textContent || ''`;
  await browser.open(base + 'index.html');
  await browser.evaluate(`navigator.serviceWorker.getRegistration().then(r => r.update())`).catch(() => {});
  step(await browser.waitFor(`navigator.serviceWorker.getRegistration().then(r => !!r.waiting)`, 30000), 'Neue Version installiert und wartet');
  await browser.open(base + 'index.html');
  await sleep(1000);
  step(await browser.waitFor(`${shownVersion} === 'v${v1}'`), `Kein stiller Versionswechsel beim Neuladen (weiter v${v1})`);
  step(await browser.waitFor(`(document.getElementById('btn-update')?.textContent || '').includes('bereit')`), 'Menü zeigt „Update installieren (bereit)“');
  await browser.evaluate(`document.getElementById('btn-update').click()`);
  await sleep(500);
  step(await browser.waitFor(`${shownVersion} === 'v${v2}'`, 20000), `Update-Button: neu geladen in v${v2}`);
  step(await browser.evaluate(`new Promise(res => { const r = indexedDB.open('BlutbildDB'); r.onsuccess = () => { const g = r.result.transaction('metadata').objectStore('metadata').get('e2e-marker'); g.onsuccess = () => { r.result.close(); res(g.result?.value === 42); }; }; r.onerror = () => res(false); })`),
    'Daten nach Update erhalten');
  const keys = await browser.evaluate('caches.keys()');
  step(JSON.stringify([...keys].sort()) === JSON.stringify([`blutbild-cdn`, `blutbild-v${v2}`].sort()), `Caches nach Update: ${keys.join(', ')} (alter App-Cache weg, CDN-Cache bleibt)`);
  const cdnAfter = await browser.evaluate(cdnCacheKeys);
  step(CDN_EXPECTED.every(e => cdnAfter.some(u => u.includes(e))), 'CDN-Cache überlebt das Update (kein erneuter Download von OpenCV & Co.)');

  // ── 4. Update found by the button itself ──────────────────────────────────
  // Phase 3 only covers a version the browser had already found and
  // installed; here the click has to run the network check and the install.
  const v3 = v2.replace(/\d+$/, n => Number(n) + 1);
  console.log(`— Phase 4: Update-Button findet ${v3} selbst`);
  await browser.waitFor(`navigator.serviceWorker.getRegistration().then(r => !!r.active && !r.installing && !r.waiting)`, 10000);
  await writeFile(swFile, (await readFile(swFile, 'utf8')).replace(`APP_VERSION = '${v2}'`, `APP_VERSION = '${v3}'`));
  await writeFile(manifestFile, (await readFile(manifestFile, 'utf8')).replace(`"version": "${v2}"`, `"version": "${v3}"`));
  await browser.evaluate(`document.getElementById('btn-update').click()`);
  await sleep(500);
  step(await browser.waitFor(`${shownVersion} === 'v${v3}'`, 45000), `Update-Button: geprüft, installiert, neu geladen in v${v3}`);
} catch (err) {
  console.error(err);
  failures++;
} finally {
  await browser?.close().catch(() => {});
  await stopServer();
  await rm(profile, { recursive: true, force: true }).catch(() => {});
  await rm(root, { recursive: true, force: true }).catch(() => {});
}

console.log(failures ? `\n${failures} Prüfung(en) fehlgeschlagen.` : '\nAlles bestanden.');
process.exit(failures ? 1 : 0);
