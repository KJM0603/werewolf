// Tests the actual app's peer functions with synthetic tracks, no device access.
// Run: node tests/browser/serve-media.mjs, then open http://localhost:4188.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
createServer((req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  let body, type = 'text/html';
  if (path === '/') body = read('./media.html');
  else if (path === '/peer') body = '<div id="app"></div><div id="toast"></div><script src="/client.js"></script>';
  else if (path === '/client.js') {
    type = 'text/javascript';
    body = read('../../public/app.js').split('setInterval(()=>')[0] + read('./media-peer.js');
  } else { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store' });
  res.end(body);
}).listen(4188, '127.0.0.1', () => console.log('Media tests: http://localhost:4188'));
