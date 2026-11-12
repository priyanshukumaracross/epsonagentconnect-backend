/**
 * Keeps the Render free web service awake.
 *
 * Render puts a free service to sleep after 15 minutes without incoming requests; waking up
 * takes about a minute, and anyone in the call queue is disconnected. This pings the service's
 * own public URL (it goes out through Render's edge, so it counts as incoming traffic).
 *
 * URL: KEEP_ALIVE_URL, or RENDER_EXTERNAL_URL which Render sets automatically.
 * Interval: KEEP_ALIVE_MINUTES (default 10, must stay under 15). KEEP_ALIVE=false turns it off.
 * The /api/health endpoint doesn't touch the database, so Neon can still sleep and save compute.
 */
import { config } from '../config.js';

export function startKeepAlive() {
  const { url, minutes } = config.keepAlive;
  if (!url) return null;
  const target = `${url.replace(/\/+$/, '')}/api/health?source=keep-alive`;
  let failures = 0;

  const ping = async () => {
    try {
      const res = await fetch(target, { signal: AbortSignal.timeout(30000), headers: { 'User-Agent': 'epson-connect-keepalive' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (failures) console.log('✔ Keep-alive ping working again');
      failures = 0;
    } catch (err) {
      failures += 1;
      if (failures === 1 || failures % 6 === 0) console.warn(`! Keep-alive ping to ${target} failed (${err.message})`);
    }
  };

  const timer = setInterval(ping, minutes * 60 * 1000);
  timer.unref();
  setTimeout(ping, 30000).unref(); // first ping shortly after start-up
  console.log(`✔ Keep-alive: pinging ${target} every ${minutes} min`);
  return timer;
}
