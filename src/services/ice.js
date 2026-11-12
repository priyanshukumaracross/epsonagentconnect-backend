/**
 * ICE servers (STUN + TURN) handed to browsers before a call.
 *
 * STUN lets two browsers find a direct path. TURN relays the audio/video when no direct
 * path exists (most 4G/5G networks, office Wi-Fi, India <-> Canada through different NATs).
 *
 * Every configured provider is included; the browsers try them all and use whichever works.
 *   ExpressTURN / any TURN server  TURN_URLS + TURN_USERNAME + TURN_CREDENTIAL  (fixed login)
 *   Metered (Open Relay)            METERED_TURN_APP + METERED_TURN_API_KEY     (fetched via API)
 *   Cloudflare Realtime TURN        CLOUDFLARE_TURN_KEY_ID + CLOUDFLARE_TURN_API_TOKEN
 * With none configured, only STUN (direct connections) is used.
 */
import { config } from '../config.js';

const RETRY_AFTER_FAIL_MS = 60 * 1000;
const HOUR = 60 * 60 * 1000;

/** Port 53 is blocked by browsers and only causes timeouts. */
function clean(servers) {
  return (servers || [])
    .map((s) => {
      const urls = (Array.isArray(s.urls) ? s.urls : [s.urls]).filter((u) => typeof u === 'string' && !/:53(\?|$)/.test(u));
      return urls.length ? { ...s, urls } : null;
    })
    .filter(Boolean);
}
const hasRelay = (servers) => servers.some((s) => s.username && s.credential);

async function fetchCloudflare({ keyId, apiToken }) {
  const ttl = 24 * 60 * 60;
  const res = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ttl }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`responded ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const servers = clean((await res.json()).iceServers);
  if (!hasRelay(servers)) throw new Error('returned no relay credentials');
  // hand out credentials with >= 12 h left, so long calls keep their relay
  return { servers, refreshAt: Date.now() + ttl * 1000 - 12 * HOUR, expiresAt: Date.now() + ttl * 1000 };
}

async function fetchMetered({ app, apiKey, region }) {
  const qs = new URLSearchParams({ apiKey });
  if (region) qs.set('region', region);
  const res = await fetch(`https://${app}.metered.live/api/v1/turn/credentials?${qs}`, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`responded ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = await res.json();
  const servers = clean(Array.isArray(body) ? body : body.iceServers);
  if (!hasRelay(servers)) throw new Error('returned no relay credentials');
  // Metered credentials belong to the API key and stay valid; refresh hourly in case they're rotated
  return { servers, refreshAt: Date.now() + HOUR, expiresAt: Infinity };
}

const PROVIDERS = [
  { name: 'cloudflare', settings: () => config.turn.cloudflare, fetch: fetchCloudflare },
  { name: 'metered', settings: () => config.turn.metered, fetch: fetchMetered },
].map((p) => ({ ...p, cache: null, pending: null, lastFailAt: 0 }));

/** Never throws: a provider that's down is left out (and retried after a minute). */
function fromProvider(p) {
  const now = Date.now();
  const usable = p.cache && p.cache.expiresAt > now ? p.cache.servers : [];
  if (p.cache && p.cache.refreshAt > now) return usable;
  if (now - p.lastFailAt < RETRY_AFTER_FAIL_MS) return usable;
  p.pending ||= p.fetch(p.settings())
    .then((result) => { p.cache = result; return result.servers; })
    .catch((err) => {
      p.lastFailAt = Date.now();
      console.error(`! TURN (${p.name}) credentials unavailable: ${err.message}`);
      return usable;
    })
    .finally(() => { p.pending = null; });
  return p.pending;
}

export function turnProviders() {
  const names = PROVIDERS.filter((p) => p.settings()).map((p) => p.name);
  if (config.turn.static) names.push('static');
  return names;
}

export async function getIceServers() {
  const servers = [];
  if (config.turn.stunUrls.length) servers.push({ urls: config.turn.stunUrls });
  if (config.turn.static) servers.push(config.turn.static);
  const fetched = await Promise.all(PROVIDERS.filter((p) => p.settings()).map(fromProvider));
  return [...servers, ...fetched.flat()];
}
