import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { createIceConfigProvider } from '../rtc-config.mjs';

test('unconfigured TURN preserves STUN; invalid relay/config fails at startup', async () => {
  const config = await createIceConfigProvider({})({});
  assert.equal(config.turnEnabled, false);
  assert.equal(config.iceTransportPolicy, 'all');
  assert.deepEqual(config.iceServers, [{ urls: 'stun:stun.l.google.com:19302' }]);
  for (const env of [{ TURN_PROVIDER: 'unknown' }, { TURN_PROVIDER: 'cloudflare' }, { TURN_PROVIDER: 'coturn' }, { ICE_TRANSPORT_POLICY: 'relay' }, { TURN_TTL_SECONDS: '2' }]) {
    assert.throws(() => createIceConfigProvider(env));
  }
});

test('coturn issues expiring HMAC credentials per player and refreshes before expiry', async () => {
  let time = 1800000000000;
  const env = { TURN_PROVIDER: 'coturn', TURN_SHARED_SECRET: 'test-only-secret', TURN_URLS: 'turn:example.test:3478,turns:example.test:5349', TURN_TTL_SECONDS: '600', ICE_TRANSPORT_POLICY: 'relay' };
  const get = createIceConfigProvider(env, undefined, () => time);
  const player = {};
  const first = await get(player), other = await get({});
  const turn = first.iceServers[1];
  assert.equal(turn.username.split(':')[0], String(time / 1000 + 600));
  assert.equal(turn.credential, createHmac('sha1', env.TURN_SHARED_SECRET).update(turn.username).digest('base64'));
  assert.notEqual(other.iceServers[1].username, turn.username);
  assert.equal(await get(player), first);
  assert.equal(first.iceTransportPolicy, 'relay');
  assert.ok(!JSON.stringify(first).includes(env.TURN_SHARED_SECRET));
  time += 481000;
  assert.notEqual((await get(player)).iceServers[1].username, turn.username);
});

test('Cloudflare uses a server-only token, deduplicates requests, and strips unrelated fields', async () => {
  let calls = 0;
  const env = { TURN_PROVIDER: 'cloudflare', CLOUDFLARE_TURN_KEY_ID: 'key/id', CLOUDFLARE_TURN_API_TOKEN: 'test-only-token' };
  const get = createIceConfigProvider(env, async (url, options) => {
    calls++;
    assert.ok(url.includes('key%2Fid/credentials/generate-ice-servers'));
    assert.equal(options.headers.Authorization, 'Bearer test-only-token');
    assert.deepEqual(JSON.parse(options.body), { ttl: 3600 });
    return { ok: true, json: async () => ({ iceServers: [{ urls: 'turn:example.test:3478', username: 'temporary-user', credential: 'temporary-password', extra: env.CLOUDFLARE_TURN_API_TOKEN }] }) };
  });
  const player = {};
  const results = await Promise.all([get(player), get(player)]);
  assert.equal(calls, 1);
  assert.equal(results[0], results[1]);
  assert.equal(results[0].iceServers[0].credential, 'temporary-password');
  assert.ok(!JSON.stringify(results).includes(env.CLOUDFLARE_TURN_API_TOKEN));
});

test('Cloudflare failure and malformed replies never silently fall back to STUN', async () => {
  const env = { TURN_PROVIDER: 'cloudflare', CLOUDFLARE_TURN_KEY_ID: 'id', CLOUDFLARE_TURN_API_TOKEN: 'secret' };
  for (const reply of [{ ok: false }, { ok: true, json: async () => ({ iceServers: [{ urls: 'stun:example.test' }] }) }, { ok: true, json: async () => ({ iceServers: [{ urls: 'turn:example.test' }] }) }]) {
    let calls = 0, time = 1000000;
    const get = createIceConfigProvider(env, async () => { calls++; return reply; }, () => time);
    const player = {};
    await assert.rejects(get(player));
    await assert.rejects(get(player));
    assert.equal(calls, 1);
    time += 31000;
    await assert.rejects(get(player));
    assert.equal(calls, 2);
  }
});
