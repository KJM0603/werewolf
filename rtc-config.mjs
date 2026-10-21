import { createHmac, randomBytes } from 'node:crypto';

const STUN = { urls: 'stun:stun.l.google.com:19302' };

// Long-lived provider secrets stay here, outside public/. Each player gets
// expiring credentials; concurrent requests share one provider call.
export function createIceConfigProvider(env = process.env, request = fetch, now = Date.now) {
  const provider = env.TURN_PROVIDER || 'none';
  if (!['none', 'cloudflare', 'coturn'].includes(provider)) throw new Error('Invalid TURN_PROVIDER');
  const ttl = Number(env.TURN_TTL_SECONDS || 3600);
  if (!Number.isInteger(ttl) || ttl < 600 || ttl > 86400) throw new Error('TURN_TTL_SECONDS must be 600..86400');
  const policy = env.ICE_TRANSPORT_POLICY || 'all';
  if (!['all', 'relay'].includes(policy) || (policy === 'relay' && provider === 'none')) throw new Error('Invalid ICE_TRANSPORT_POLICY or missing TURN provider');
  if (provider === 'cloudflare' && (!env.CLOUDFLARE_TURN_KEY_ID || !env.CLOUDFLARE_TURN_API_TOKEN)) throw new Error('Cloudflare TURN credentials are required');
  const urls = (env.TURN_URLS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (provider === 'coturn' && (!env.TURN_SHARED_SECRET || !urls.length || urls.some(url => !/^turns?:[^\s]+$/.test(url)))) throw new Error('coturn TURN_URLS and TURN_SHARED_SECRET are required');
  const cache = new WeakMap();
  return async function getIceConfig(player) {
    const cached = cache.get(player);
    if (cached?.pending) return cached.pending;
    if (cached?.value && cached.value.expiresAt > now() + 120_000) return cached.value;
    if (cached?.retryAt > now()) throw new Error('TURN credential retry cooldown');
    const pending = (async () => {
      const expiresAt = now() + ttl * 1000;
      let iceServers = [STUN];
      if (provider === 'cloudflare') {
        const response = await request(`https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(env.CLOUDFLARE_TURN_KEY_ID)}/credentials/generate-ice-servers`, {
          method: 'POST', headers: { Authorization: `Bearer ${env.CLOUDFLARE_TURN_API_TOKEN}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ ttl }), signal: AbortSignal.timeout(8000),
        });
        if (!response.ok) throw new Error('TURN credential service unavailable');
        const data = await response.json();
        if (!Array.isArray(data.iceServers) || !data.iceServers.length) throw new Error('Invalid TURN response');
        iceServers = data.iceServers.map(server => {
          const list = (Array.isArray(server.urls) ? server.urls : [server.urls]);
          if (!list.length || list.some(url => typeof url !== 'string' || !/^(stun|stuns|turn|turns):[^\s]+$/.test(url))) throw new Error('Invalid ICE URLs');
          const result = { urls: list };
          if (list.some(url => /^turns?:/.test(url))) {
            if (typeof server.username !== 'string' || !server.username || typeof server.credential !== 'string' || !server.credential) throw new Error('Missing TURN credential');
            result.username = server.username; result.credential = server.credential;
          }
          return result;
        });
        if (!iceServers.some(server => server.urls.some(url => /^turns?:/.test(url)))) throw new Error('Missing TURN server');
      } else if (provider === 'coturn') {
        const username = `${Math.floor(expiresAt / 1000)}:${randomBytes(12).toString('hex')}`;
        const credential = createHmac('sha1', env.TURN_SHARED_SECRET).update(username).digest('base64');
        iceServers.push({ urls, username, credential });
      }
      return { iceServers, iceTransportPolicy: policy, expiresAt, turnEnabled: provider !== 'none' };
    })();
    cache.set(player, { pending });
    try { const value = await pending; cache.set(player, { value }); return value; }
    catch { cache.set(player, { retryAt: now() + 30_000 }); throw new Error('TURN credential service unavailable'); }
  };
}
