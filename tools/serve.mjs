#!/usr/bin/env node
// Zero-dependency static dev server.
//   node tools/serve.mjs [--port 8000] [--host 127.0.0.1] [--root .]
//
// Service workers need a secure context: http://localhost / 127.0.0.1 is
// fine, a LAN IP (http://192.168.x.y) is NOT — to test on an iPhone, deploy
// to an https host (e.g. GitHub Pages) or use a tunnel.
//
// Sends "Cache-Control: no-cache" so the browser's HTTP cache never hides a
// changed file during development (the service worker cache still applies —
// use ☰ → Update, or DevTools → Application → "Update on reload").
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.zip': 'application/zip',
  '.wasm': 'application/wasm',
};

export function startServer({ root, port = 8000, host = '127.0.0.1', quiet = false }) {
  root = path.resolve(root);
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    let file = path.join(root, decodeURIComponent(url.pathname));
    if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
    try {
      if ((await stat(file)).isDirectory()) {
        if (!url.pathname.endsWith('/')) {
          res.writeHead(301, { Location: url.pathname + '/' + url.search }).end();
          return;
        }
        file = path.join(file, 'index.html');
      }
      const body = await readFile(file);
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
      });
      res.end(req.method === 'HEAD' ? undefined : body);
      if (!quiet) console.log(200, url.pathname);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
      if (!quiet) console.log(404, url.pathname);
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(server));
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: {
    port: { type: 'string', default: process.env.PORT || '8000' },
    host: { type: 'string', default: '127.0.0.1' },
    root: { type: 'string', default: path.join(path.dirname(fileURLToPath(import.meta.url)), '..') },
  } });
  try {
    const server = await startServer({ root: values.root, port: Number(values.port), host: values.host });
    const { port } = server.address();
    console.log(`▶ http://${values.host === '0.0.0.0' ? 'localhost' : values.host}:${port}/   (Strg+C beendet)`);
  } catch (err) {
    console.error(err.code === 'EADDRINUSE' ? `Port ${values.port} ist belegt – anderen wählen: --port 8001` : err.message);
    process.exit(1);
  }
}
