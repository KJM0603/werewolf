import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

if (!process.argv[2]) throw new Error('Usage: node tests/browser/serve-camera.mjs <portrait.jpg>');
const folder = dirname(fileURLToPath(import.meta.url));
const root = resolve(folder, '../../public');
const portrait = resolve(process.argv[2]);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.wasm': 'application/wasm', '.jpg': 'image/jpeg' };
createServer((req, res) => {
  try {
    const path = new URL(req.url, 'http://localhost').pathname;
    const file = path === '/' ? resolve(folder, 'camera.html')
      : path === '/portrait.jpg' ? portrait : resolve(root, `.${path}`);
    if (path !== '/' && path !== '/portrait.jpg' && !file.startsWith(root + sep)) throw new Error('Outside public');
    const body = readFileSync(file);
    res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end();
  }
}).listen(4186, '127.0.0.1', () => console.log('Camera test: http://localhost:4186'));
