import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
async function start(t, env = {}) {
  const child = spawn(process.execPath, ['server.mjs'], { cwd: root, windowsHide: true, env: { ...process.env, PORT: '0', BASE_PATH: '', TURN_PROVIDER: 'none', ICE_TRANSPORT_POLICY: 'all', TURN_TTL_SECONDS: '3600', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => reject(new Error(`server exited ${code}`)));
    child.stdout.on('data', chunk => { const match = String(chunk).match(/localhost:(\d+)/); if (match) resolve(Number(match[1])); });
  });
}

// Minimal masked WebSocket client keeps integration tests runnable on Node 20.
async function client(t, port, path) {
  const socket = connect(port, '127.0.0.1');
  t.after(() => socket.destroy());
  let upgraded = false, buffer = Buffer.alloc(0), ready;
  const opened = new Promise(resolve => { ready = resolve; });
  const messages = [];
  socket.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    if (!upgraded) {
      const end = buffer.indexOf('\r\n\r\n'); if (end < 0) return;
      assert.match(buffer.subarray(0, end).toString(), /101 Switching Protocols/);
      buffer = buffer.subarray(end + 4); upgraded = true; ready();
    }
    while (buffer.length >= 2) {
      let size = buffer[1] & 127, offset = 2;
      if (size === 126) { if (buffer.length < 4) return; size = buffer.readUInt16BE(2); offset = 4; }
      if (buffer.length < size + offset) return;
      messages.push(JSON.parse(buffer.subarray(offset, offset + size)));
      buffer = buffer.subarray(offset + size);
    }
  });
  socket.write(`GET ${path} HTTP/1.1\r\nHost: localhost:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
  await opened;
  return {
    send(event, data = {}) {
      const body = Buffer.from(JSON.stringify({ event, data })), mask = randomBytes(4);
      const header = Buffer.alloc(body.length < 126 ? 2 : 4); header[0] = 0x81;
      header[1] = 0x80 | (body.length < 126 ? body.length : 126);
      if (body.length >= 126) header.writeUInt16BE(body.length, 2);
      for (let i = 0; i < body.length; i++) body[i] ^= mask[i % 4];
      socket.write(Buffer.concat([header, mask, body]));
    },
    async receive(event) {
      const end = Date.now() + 4000;
      while (Date.now() < end) {
        const index = messages.findIndex(msg => msg.event === event);
        if (index >= 0) return messages.splice(index, 1)[0].data;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      throw new Error(`Missing event: ${event}`);
    },
  };
}

for (const base of ['', '/game-werewolf261020', '/games/wolf']) {
  test(`HTTP, WebSocket, auth and rejoin work under ${base || '/'}`, { timeout: 10000 }, async t => {
    const port = await start(t, { BASE_PATH: base });
    const url = `http://127.0.0.1:${port}`;
    if (base) {
      const redirect = await fetch(url + base + '?invite=abc', { redirect: 'manual' });
      assert.equal(redirect.status, 301);
      assert.equal(redirect.headers.get('location'), base + '/?invite=abc');
    }
    const index = await fetch(url + base + '/');
    assert.equal(index.status, 200);
    assert.match(await index.text(), /src="app.js"/);
    for (const asset of ['app.js', 'styles.css', 'camera-worker.js', 'vendor/mediapipe/wasm/vision_wasm_internal.wasm']) assert.equal((await fetch(url + base + '/' + asset)).status, 200);
    assert.equal((await fetch(url + base + '/%ZZ')).status, 400);
    assert.equal((await fetch(url + base + '/%2e%2e%5cserver.mjs')).status, 404);
    const host = await client(t, port, base + '/signal?test=1');
    host.send('connection:ping'); await host.receive('connection:pong');
    host.send('rtc:config'); assert.match((await host.receive('error')).message, /입장/);
    host.send('room:create', { name: 'Host' }); const joined = await host.receive('room:joined');
    host.send('rtc:config'); assert.equal((await host.receive('rtc:config')).turnEnabled, false);
    const resumed = await client(t, port, base + '/signal');
    resumed.send('room:reconnect', { code: joined.room.code, token: joined.token });
    assert.equal((await resumed.receive('room:joined')).playerId, joined.playerId);
    resumed.send('rtc:config'); assert.equal((await resumed.receive('rtc:config')).turnEnabled, false);
  });
}

test('real lobby kick updates all clients and rejects the removed reconnect token', { timeout: 10000 }, async t => {
  const port=await start(t);
  const host=await client(t,port,'/signal');host.send('room:create',{name:'Host'});const owner=await host.receive('room:joined');
  const guest=await client(t,port,'/signal');guest.send('room:join',{code:owner.room.code,name:'Guest'});const removed=await guest.receive('room:joined');
  const observer=await client(t,port,'/signal');observer.send('room:join',{code:owner.room.code,name:'Observer'});await observer.receive('room:joined');
  for(const ws of [host,observer]){let room;do{room=await ws.receive('room:state');}while(room.players.length!==3);}
  guest.send('room:kick',{playerId:owner.playerId});assert.match((await guest.receive('error')).message,/방장/);
  host.send('room:kick',{playerId:removed.playerId});assert.match((await guest.receive('room:kicked')).message,/강퇴/);
  for(const ws of [host,observer]){
    const room=await ws.receive('room:state');assert.equal(room.players.length,2);assert.equal(room.roles.length,5);
    assert.ok(!room.players.some(p=>p.id===removed.playerId));assert.equal(room.hostId,owner.playerId);
  }
  const reconnect=await client(t,port,'/signal');reconnect.send('room:reconnect',{code:owner.room.code,token:removed.token});
  assert.match((await reconnect.receive('error')).message,/재접속/);
  guest.send('chat:send',{text:'should not reach room'});assert.match((await guest.receive('error')).message,/입장/);
});

test('real signaling returns only temporary coturn credentials to joined players', { timeout: 10000 }, async t => {
  const port = await start(t, { TURN_PROVIDER: 'coturn', TURN_URLS: 'turn:example.test:3478', TURN_SHARED_SECRET: 'test-only-secret', ICE_TRANSPORT_POLICY: 'relay' });
  const ws = await client(t, port, '/signal');
  ws.send('room:create', { name: 'Host' }); await ws.receive('room:joined');
  ws.send('rtc:config'); const config = await ws.receive('rtc:config');
  assert.equal(config.iceTransportPolicy, 'relay');
  assert.equal(config.turnEnabled, true);
  assert.ok(config.iceServers[1].credential);
  assert.ok(!JSON.stringify(config).includes('test-only-secret'));
});
