import http from 'node:http';
import { config } from './config.js';
import { createApp } from './app.js';
import { initSocket } from './socket/index.js';
import { pool } from './db/pool.js';
import { ensureAdmin, runMigrations } from './db/setup.js';
import { recoverStaleCalls } from './services/calls.js';
import { getIceServers, turnProviders } from './services/ice.js';
import { startKeepAlive } from './services/keepAlive.js';

const app = createApp();
const server = http.createServer(app);
const io = initSocket(server);

/** Neon suspends idle databases; the first connection can take a few seconds. */
async function waitForDatabase(attempts = 6) {
  for (let i = 1; i <= attempts; i++) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (err) {
      if (i === attempts) throw err;
      console.log(`… waiting for database (${err.message}), retry ${i}/${attempts - 1}`);
      await new Promise((r) => setTimeout(r, 2000 * i));
    }
  }
}

async function start() {
  try {
    await waitForDatabase();
  } catch (err) {
    console.error('✖ Cannot connect to the Neon database:', err.message);
    console.error('  Check DATABASE_URL (backend/.env locally, Environment settings on Render).');
    process.exit(1);
  }

  if (config.autoSetup) {
    await runMigrations();
    const admin = await ensureAdmin(config.seedAdmin);
    if (admin === 'created') console.log(`✔ Admin account created: ${config.seedAdmin.email}`);
    if (admin === 'missing-env') console.warn('! No admin account yet: set SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD and restart.');
  }
  await recoverStaleCalls();

  server.listen(config.port, () => {
    console.log(`✔ Epson Expert Connect API listening on port ${config.port}`);
    startKeepAlive();
    const turn = turnProviders();
    if (!turn.length) console.warn('! No TURN relay configured: calls on mobile data / between countries may connect without audio or video (see README).');
    else getIceServers().then((list) => { if (list.some((x) => x.credential)) console.log(`✔ TURN relay ready (${turn.join(', ')})`); });
  });
}

function shutdown(signal) {
  console.log(`\n${signal} received, shutting down…`);
  io.close();
  server.close(() => pool.end().then(() => process.exit(0)));
  setTimeout(() => process.exit(1), 8000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

start().catch((err) => {
  console.error('✖ Start-up failed:', err);
  process.exit(1);
});
