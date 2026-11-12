/**
 * ICE servers (STUN + TURN) handed to browsers before a call.
 *
 * STUN lets two browsers find a direct path. TURN relays the audio/video when no direct
 * path exists (most 4G/5G networks, office Wi-Fi, India <-> Canada through different NATs).
 *
 * Providers, first one configured wins:
 *   1. Cloudflare Realtime TURN  CLOUDFLARE_TURN_KEY_ID + CLOUDFLARE_TURN_API_TOKEN
 *      short-lived credentials are generated server-side and cached
 *   2. Any static TURN server    TURN_URLS + TURN_USERNAME + TURN_CREDENTIAL
 *   3. STUN only                 (direct connections only; calls can fail on mobile data)
 */
import { config } from '../config.js';

const CF_TTL_SEC = 24 * 60 * 60;      // lifetime of generated credentials
const CF_MIN_LEFT_MS = 12 * 60 * 60 * 1000; // hand out credentials with >= 12 h left, so long calls keep their relay
const RETRY_AFTER_FAIL_MS = 60 * 1000;

let cache = null;          // { iceServers, expiresAt }
let pending = null;
let lastFailAt = 0;

export function turnProvider() {
  if (config.turn.cloudflare) return 'cloudflare';
  if (config.turn.static) return 'static';
  return 'none';
}

function staticServers() {
  const servers = [];
  if (config.turn.stunUrls.length) servers.push({ urls: config.turn.stunUrls });
  if (config.turn.static) servers.push(config.turn.static);
  return servers;
}

async function fetchCloudflare() {
  const { keyId, apiToken } = config.turn.cloudflare;
  const res = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ttl: CF_TTL_SEC }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Cloudflare TURN responded ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = await res.json();
  const servers = (body.iceServers || [])
    .map((s) => {
      const urls = (Array.isArray(s.urls) ? s.urls : [s.urls])
        .filter((u) => typeof u === 'string' && !/:53(\?|$)/.test(u)); // port 53 is blocked by browsers and only causes timeouts
      return urls.length ? { ...s, urls } : null;
    })
    .filter(Boolean);
  if (!servers.some((s) => s.username && s.credential)) throw new Error('Cloudflare TURN returned no relay credentials');
  return servers;
}

/** Current ICE servers. Never throws: falls back to STUN (+ static TURN) if the provider is down. */
export async function getIceServers() {
  if (!config.turn.cloudflare) return staticServers();
  if (cache && cache.expiresAt - Date.now() > CF_MIN_LEFT_MS) return cache.iceServers;
  if (Date.now() - lastFailAt < RETRY_AFTER_FAIL_MS) return cache && cache.expiresAt > Date.now() ? cache.iceServers : staticServers();

  pending ||= fetchCloudflare()
    .then((iceServers) => {
      // Cloudflare already includes its own STUN; keep any extra STUN configured
      const extra = config.turn.stunUrls.length ? [{ urls: config.turn.stunUrls }] : [];
      cache = { iceServers: [...iceServers, ...extra], expiresAt: Date.now() + CF_TTL_SEC * 1000 };
      return cache.iceServers;
    })
    .catch((err) => {
      lastFailAt = Date.now();
      console.error('! TURN credentials unavailable, calls fall back to direct connections:', err.message);
      return cache && cache.expiresAt > Date.now() ? cache.iceServers : staticServers();
    })
    .finally(() => { pending = null; });
  return pending;
}
