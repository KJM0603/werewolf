// Real WebSocket clients, no bots or timer shortcuts.
// Run: node tests/live-multiplayer.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const port = Number(process.env.MULTIPLAYER_TEST_PORT || 4187);
const clients = [];
const server = spawn(process.execPath, ['server.mjs'], { cwd: root, env: { ...process.env, PORT: String(port) }, stdio: ['ignore','pipe','pipe'], windowsHide: true });
function wait(check, ms = 5000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (check()) { clearInterval(timer); resolve(); }
      else if (Date.now() - started > ms) { clearInterval(timer); reject(new Error('Timed out')); }
    }, 20);
  });
}
async function client() {
  const ws = new WebSocket(`ws://localhost:${port}/signal`);
  const c = { ws, events: [], room: null, send: (event, data = {}) => ws.send(JSON.stringify({ event, data })) };
  ws.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data); c.events.push(message);
    if (message.event === 'room:joined') { c.room = message.data.room; c.id = message.data.playerId; }
    if (['room:state','game:phase'].includes(message.event)) c.room = message.data;
    if (message.event === 'discussion:skip-state') c.room.discussionSkip = message.data;
  });
  clients.push(c);
  await wait(() => ws.readyState === WebSocket.OPEN);
  return c;
}
try {
  await new Promise((resolve, reject) => {
    server.stdout.once('data', resolve); server.once('error', reject);
    server.once('exit', code => reject(new Error(`Test server exited: ${code}`)));
  });
  const host = await client(); host.send('room:create', { name: 'Host' });
  await wait(() => host.room);
  for (const name of ['Guest A','Guest B']) {
    const guest = await client(); guest.send('room:join', { code: host.room.code, name });
    await wait(() => guest.room); guest.send('player:ready', { ready: true });
  }
  await wait(() => host.room.players.filter(p => p.ready).length === 2);
  host.send('game:start');
  await wait(() => clients.every(c => c.room.phase === 'discussion'), 60000);
  assert.equal(host.room.discussionSkip.required, 2);
  clients[1].send('discussion:skip-vote', { agree: true });
  clients[1].send('discussion:skip-vote', { agree: true });
  await wait(() => clients.every(c => c.room.discussionSkip.votes.length === 1));
  assert.ok(clients.every(c => c.room.phase === 'discussion'));
  clients[1].send('discussion:skip-vote', { agree: false });
  await wait(() => clients.every(c => c.room.discussionSkip.votes.length === 0));
  clients[1].send('discussion:skip-vote', { agree: true });
  await wait(() => clients.every(c => c.room.discussionSkip.votes.length === 1));
  clients[2].send('discussion:skip-vote', { agree: true });
  await wait(() => clients.every(c => c.room.phase === 'voting'));
  assert.ok(clients.every(c => c.room.discussionSkip.votes.length === 2));
  console.log('PASS: 3 real clients; nonhost consent, deduplication, withdrawal, synchronized 2/3 majority transition.');
} finally {
  for (const c of clients) c.ws.close();
  server.kill();
}
