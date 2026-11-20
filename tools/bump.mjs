#!/usr/bin/env node
// Raises the version in sw.js AND manifest.json in one go, then runs the
// consistency check. Changing sw.js is what makes browsers see an update.
//   node tools/bump.mjs [patch|minor|major|x.y.z]   (default: patch)
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCheck } from './check.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = process.argv[2] || 'patch';

const swPath = path.join(root, 'sw.js');
const manifestPath = path.join(root, 'manifest.json');
const sw = await readFile(swPath, 'utf8');
const manifest = await readFile(manifestPath, 'utf8');

const current = /const APP_VERSION = '(\d+)\.(\d+)\.(\d+)'/.exec(sw);
if (!current) { console.error('APP_VERSION in sw.js nicht gefunden.'); process.exit(1); }
let [major, minor, patch] = current.slice(1).map(Number);

let next;
if (/^\d+\.\d+\.\d+$/.test(arg)) next = arg;
else if (arg === 'major') next = `${major + 1}.0.0`;
else if (arg === 'minor') next = `${major}.${minor + 1}.0`;
else if (arg === 'patch') next = `${major}.${minor}.${patch + 1}`;
else { console.error(`Unbekanntes Argument "${arg}". Erlaubt: patch | minor | major | x.y.z`); process.exit(1); }

await writeFile(swPath, sw.replace(/const APP_VERSION = '[^']+'/, `const APP_VERSION = '${next}'`));
await writeFile(manifestPath, manifest.replace(/"version":\s*"[^"]+"/, `"version": "${next}"`));
console.log(`Version ${current.slice(1).join('.')} → ${next}`);

const { errors, warnings } = await runCheck(root);
warnings.forEach(w => console.warn('⚠️ ', w));
errors.forEach(e => console.error('✗ ', e));
process.exit(errors.length ? 1 : 0);
