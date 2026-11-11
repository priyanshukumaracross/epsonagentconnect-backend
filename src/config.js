import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

// Load backend/.env no matter which directory the process starts in (cPanel/Passenger, PM2, node).
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.env') });

function required(key) {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required environment variable: ${key} (see backend/.env.example)`);
  return value;
}

const list = (v) => (v || '').split(',').map((s) => s.trim()).filter(Boolean);

function buildIceServers() {
  const servers = [];
  const stun = list(process.env.STUN_URLS ?? 'stun:stun.l.google.com:19302');
  if (stun.length) servers.push({ urls: stun });
  const turn = list(process.env.TURN_URLS);
  if (turn.length) {
    servers.push({ urls: turn, username: process.env.TURN_USERNAME, credential: process.env.TURN_CREDENTIAL });
  }
  return servers;
}

/** MySQL connection: either DATABASE_URL=mysql://user:pass@host:3306/db or the separate DB_* variables. */
function buildDb() {
  const common = {
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
  };
  if (process.env.DATABASE_URL) return { uri: process.env.DATABASE_URL, ...common };
  return {
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 3306),
    user: required('DB_USER'),
    password: process.env.DB_PASSWORD || '',
    database: required('DB_NAME'),
    ...common,
  };
}

const tzOffset = process.env.DB_TIMEZONE_OFFSET || '+05:30';
if (!/^[+-]\d{2}:\d{2}$/.test(tzOffset)) throw new Error('DB_TIMEZONE_OFFSET must look like +05:30');

export const config = {
  env: process.env.NODE_ENV || 'development',
  isProd: process.env.NODE_ENV === 'production',
  port: Number(process.env.PORT || 4000),
  corsOrigins: list(process.env.CORS_ORIGINS || 'http://localhost:5173,http://localhost:5174'),
  db: buildDb(),
  // All timestamps are stored and reported in this offset (default: India Standard Time)
  dbTimezoneOffset: tzOffset,
  jwtSecret: required('JWT_SECRET'),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '12h',
  ringTimeoutSec: Number(process.env.CALL_RING_TIMEOUT_SEC || 120),
  iceServers: buildIceServers(),
};

if (config.isProd && (config.jwtSecret.length < 32 || config.jwtSecret.startsWith('change-me'))) {
  throw new Error('JWT_SECRET must be a strong random value (>= 32 chars) in production');
}
