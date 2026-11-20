#!/usr/bin/env node
// Consistency check — run before every release (`npm run check`).
// Adapted from the offline-app template.
//   ✓ APP_VERSION in sw.js === manifest.json "version"
//   ✓ every PRECACHE_URLS entry exists, sw.js itself is not in it
//   ✓ every shipped file is precached (otherwise it's missing offline)
//   ✓ every local reference (src/href/url()) from a precached file is precached
//   ✓ manifest icons exist, have the declared size and no alpha channel
//   ✓ external <script> URLs are pinned to an exact version
//   ✓ Datenschutz: keine veröffentlichte Datei enthält einen Begriff aus der
//     Sperrliste in config-user.js (privacy.denylist); persönliche Dateien
//     (config-user.js, private/) sind von .gitignore erfasst
import { readFile, readdir } from 'node:fs/promises';
import vm from 'node:vm';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Development-only / not shipped: never precached.
const DEV_DIRS = new Set(['tools', 'tests', 'docs', 'node_modules', '.git', '.github', '.vscode', '.claude']);
const DEV_FILES = new Set([
  'package.json', 'package-lock.json', 'sw.js', '.gitignore', '.DS_Store',
  'bloodwork.json',  // reference data the Männer-Referenzbereiche were taken from, not loaded at runtime
  'fonts/OFL.txt',   // font license, shipped alongside but not needed offline
]);
// Persönliche Dateien: nicht im Repository (.gitignore), optional vorgeladen
// (sw.js → OPTIONAL_PRECACHE_URLS).
const USER_FILES = new Set(['config-user.js']);
const USER_DIRS = new Set(['private']);
const isUserFile = rel => USER_FILES.has(rel) || USER_DIRS.has(rel.split('/')[0]);
const isDevFile = rel => DEV_DIRS.has(rel.split('/')[0]) || DEV_FILES.has(rel) || isUserFile(rel) || /\.md$/i.test(rel) || rel.split('/').pop().startsWith('.');

async function walk(dir, root = dir, skipDirs = DEV_DIRS) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(root, full).split(path.sep).join('/');
    if (entry.isDirectory()) { if (!skipDirs.has(rel.split('/')[0])) out.push(...await walk(full, root, skipDirs)); }
    else out.push(rel);
  }
  return out;
}

// config-user.js wie im Browser auswerten (setzt self.USER_CONFIG).
async function loadUserConfig(root) {
  const file = path.join(root, 'config-user.js');
  if (!existsSync(file)) return null;
  const sandbox = {};
  vm.runInNewContext(await readFile(file, 'utf8'), { self: sandbox, window: sandbox }, { filename: 'config-user.js' });
  return sandbox.USER_CONFIG || null;
}

// Minimal .gitignore matcher: "name", "dir/", "*.ext", "/root-only".
function gitignoreMatcher(text) {
  const rules = text.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#') && !l.startsWith('!'));
  const toRe = glob => glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]');
  const res = rules.map(rule => {
    const dirOnly = rule.endsWith('/');
    let r = rule.replace(/\/$/, '');
    const anchored = r.startsWith('/') || r.includes('/');
    r = r.replace(/^\//, '');
    const body = toRe(r);
    return new RegExp((anchored ? '^' : '(^|/)') + body + (dirOnly ? '/' : '(/|$)'));
  });
  return rel => res.some(re => re.test(rel));
}

const TEXT_EXT = new Set(['.html', '.js', '.mjs', '.css', '.json', '.md', '.txt', '.svg', '.webmanifest', '']);

// Datenschutz-Prüfung: jede Datei, die veröffentlicht würde (alles außer
// .gitignore-Treffern), gegen die Sperrliste. Begriffe treffen am Wortanfang
// ohne Groß-/Kleinschreibung ("blut" findet "Blutbild", aber "wert" nicht
// "Messwert"); "/…/" ist ein regulärer Ausdruck.
export async function runPrivacyCheck(root) {
  const errors = [];
  const warnings = [];
  const gi = existsSync(path.join(root, '.gitignore')) ? await readFile(path.join(root, '.gitignore'), 'utf8') : '';
  const ignored = gitignoreMatcher(gi);
  for (const rel of ['config-user.js', 'private/']) {
    if (!ignored(rel.endsWith('/') ? rel + 'x.js' : rel)) errors.push(`.gitignore schützt ${rel} nicht – persönliche Daten würden veröffentlicht`);
  }
  let user = null;
  try { user = await loadUserConfig(root); }
  catch (err) { errors.push(`config-user.js lässt sich nicht auswerten: ${err.message}`); }
  if (user) {
    for (const src of (Array.isArray(user.privateScripts) ? user.privateScripts : [])) {
      if (!existsSync(path.join(root, src))) errors.push(`config-user.js → privateScripts: ${src} existiert nicht`);
      else if (!ignored(src)) errors.push(`config-user.js → privateScripts: ${src} ist nicht von .gitignore erfasst`);
    }
  }
  const terms = (user && user.privacy && Array.isArray(user.privacy.denylist)) ? user.privacy.denylist.filter(t => typeof t === 'string' && t.trim()) : [];
  if (!user) warnings.push('Keine config-user.js – Datenschutz-Prüfung ohne Sperrliste');
  else if (terms.length === 0) warnings.push('config-user.js: privacy.denylist ist leer – Datenschutz-Prüfung ohne Sperrliste');
  const patterns = terms.map(t => {
    const m = /^\/(.+)\/([a-z]*)$/.exec(t);
    if (m) return { term: t, re: new RegExp(m[1], m[2].includes('i') ? m[2] : m[2] + 'i') };
    return { term: t, re: new RegExp('(?<![\\p{L}\\p{N}_])' + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'iu') };
  });
  const files = (await walk(root, root, new Set(['.git', 'node_modules']))).filter(rel => !ignored(rel));
  for (const rel of files) {
    if (!TEXT_EXT.has(path.extname(rel).toLowerCase())) continue;
    const lines = (await readFile(path.join(root, rel), 'utf8')).split(/\r?\n/);
    lines.forEach((line, i) => {
      for (const { term, re } of patterns) {
        if (re.test(line)) errors.push(`Datenschutz: ${rel}:${i + 1} enthält „${term}“`);
      }
    });
  }
  return { errors, warnings, scanned: files.length, terms: terms.length };
}

function localRefs(source, ext) {
  const refs = [];
  const add = r => { if (r && !/^(?:[a-z]+:|\/\/|#|data:|mailto:|\$\{)/i.test(r)) refs.push(r.split(/[?#]/)[0]); };
  if (ext === '.html') {
    for (const m of source.matchAll(/\s(?:src|href)\s*=\s*["']([^"']+)["']/gi)) add(m[1]);
  } else if (ext === '.css') {
    for (const m of source.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)) add(m[1]);
  }
  return refs.filter(r => r !== '');
}

function pngInfo(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 26 || v.getUint32(0) !== 0x89504E47) return null;
  return { width: v.getUint32(16), height: v.getUint32(20), hasAlpha: bytes[25] === 4 || bytes[25] === 6 };
}

export async function runCheck(root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')) {
  const errors = [];
  const warnings = [];
  const read = rel => readFile(path.join(root, rel), 'utf8');

  const sw = await read('sw.js');
  const manifest = JSON.parse(await read('manifest.json'));
  const swVersion = /const APP_VERSION = '([^']+)'/.exec(sw)?.[1];
  const precacheBlock = /const PRECACHE_URLS = \[([\s\S]*?)\];/.exec(sw)?.[1] ?? '';
  const precache = [...precacheBlock.matchAll(/'([^']+)'/g)].map(m => m[1].replace(/^\.\//, ''));

  if (!swVersion) errors.push('sw.js: APP_VERSION nicht gefunden');
  if (manifest.version !== swVersion) errors.push(`Version unterschiedlich: manifest.json ${manifest.version} ≠ sw.js ${swVersion} → npm run bump`);
  if (!/^\d+\.\d+\.\d+$/.test(swVersion || '')) errors.push(`Version "${swVersion}" ist kein x.y.z`);

  const precached = new Set(precache);
  for (const rel of precache) if (!existsSync(path.join(root, rel))) errors.push(`PRECACHE_URLS: ${rel} existiert nicht`);
  if (precached.has('sw.js')) errors.push('sw.js darf nicht in PRECACHE_URLS stehen');

  for (const rel of await walk(root)) {
    if (!isDevFile(rel) && !precached.has(rel)) errors.push(`${rel} wird ausgeliefert, fehlt aber in PRECACHE_URLS (offline nicht verfügbar)`);
  }

  for (const rel of precache) {
    if (isUserFile(rel)) errors.push(`PRECACHE_URLS: ${rel} ist eine persönliche Datei – gehört nur in OPTIONAL_PRECACHE_URLS`);
  }

  for (const rel of precache) {
    const ext = path.extname(rel).toLowerCase();
    if (!['.html', '.css'].includes(ext) || !existsSync(path.join(root, rel))) continue;
    const source = await read(rel);
    for (const ref of localRefs(source, ext)) {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(rel), ref));
      if (target.startsWith('..') || target === 'sw.js' || isDevFile(target)) continue; // incl. config-user.js (optional)
      if (!precached.has(target)) errors.push(`${rel} verweist auf ${ref} – nicht in PRECACHE_URLS`);
    }
    if (ext === '.html') {
      for (const m of source.matchAll(/<script\b[^>]*\ssrc=["'](https:\/\/[^"']+)["']/gi)) {
        if (!/@\d+\.\d+\.\d+|\/\d+\.\d+\.\d+\//.test(m[1])) errors.push(`${rel}: CDN-Skript ohne feste Version: ${m[1]}`);
      }
    }
  }

  for (const icon of manifest.icons || []) {
    const file = path.join(root, icon.src);
    if (!existsSync(file)) { errors.push(`Manifest-Icon fehlt: ${icon.src}`); continue; }
    const info = pngInfo(new Uint8Array(await readFile(file)));
    if (!info) { errors.push(`${icon.src} ist kein PNG`); continue; }
    if (icon.sizes !== `${info.width}x${info.height}`) errors.push(`${icon.src}: Manifest sagt ${icon.sizes}, Datei ist ${info.width}x${info.height}`);
    if (info.hasAlpha) warnings.push(`${icon.src} hat einen Alphakanal – iOS/macOS Tahoe zeigen transparente Bereiche falsch an`);
  }

  const privacy = await runPrivacyCheck(root);
  errors.push(...privacy.errors);
  warnings.push(...privacy.warnings);

  return { errors, warnings, version: swVersion, precacheCount: precache.length, privacy };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { errors, warnings, version, precacheCount, privacy } = await runCheck(process.argv[2] && path.resolve(process.argv[2]));
  warnings.forEach(w => console.warn('⚠️ ', w));
  errors.forEach(e => console.error('✗ ', e));
  if (errors.length) { console.error(`\n${errors.length} Fehler.`); process.exit(1); }
  console.log(`✓ MediCalc v${version}: ${precacheCount} Dateien im Precache, alles konsistent.`);
  console.log(`✓ Datenschutz: ${privacy.scanned} veröffentlichte Dateien ohne Treffer (${privacy.terms} Sperrbegriffe).`);
}
