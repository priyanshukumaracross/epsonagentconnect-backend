import http from 'node:http';
import { config } from './config.js';
import { createApp } from './app.js';
import { initSocket } from './socket/index.js';
import { pool } from './db/pool.js';
import { recoverStaleCalls } from './services/calls.js';

const app = createApp();
const server = http.createServer(app);
const io = initSocket(server);

async function start() {
  try {
    await pool.query('SELECT 1');
  } catch (err) {
    console.error('✖ Cannot connect to MySQL:', err.message);
    console.error('  Check the database settings in backend/.env and run `npm run db:setup`.');
    process.exit(1);
  }
  await recoverStaleCalls();
  server.listen(config.port, () => {
    console.log(`✔ Epson Expert Connect API running on http://localhost:${config.port}`);
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

start();
