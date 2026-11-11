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

/**
 * Database selection
 *   postgres - local development (Neon):  DATABASE_URL=postgresql://...
 *   mysql    - deployment (cPanel):       DB_HOST/DB_NAME/DB_USER/DB_PASSWORD  or  DATABASE_URL=mysql://...
 * DB_CLIENT=postgres|mysql forces one; otherwise it is detected from DATABASE_URL (no URL = mysql).
 */
function buildDb() {
  const url = process.env.DATABASE_URL || '';
  const client = (process.env.DB_CLIENT || (/^postgres(ql)?:\/\//i.test(url) ? 'postgres' : 'mysql')).toLowerCase();
  if (!['postgres', 'mysql'].includes(client)) throw new Error('DB_CLIENT must be "postgres" or "mysql"');
  const ssl = process.env.DB_SSL === 'true' || process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined;

  if (client === 'postgres') {
    return { client, url: required('DATABASE_URL'), ssl, timezone: process.env.DB_TIMEZONE || 'Asia/Kolkata' };
  }
  const tzOffset = process.env.DB_TIMEZONE_OFFSET || '+05:30';
  if (!/^[+-]\d{2}:\d{2}$/.test(tzOffset)) throw new Error('DB_TIMEZONE_OFFSET must look like +05:30');
  if (url) return { client, uri: url, ssl, tzOffset };
  return {
    client,
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 3306),
    user: required('DB_USER'),
    password: process.env.DB_PASSWORD || '',
    database: required('DB_NAME'),
    ssl,
    tzOffset,
  };
}

export const config = {
  env: process.env.NODE_ENV || 'development',
  isProd: process.env.NODE_ENV === 'production',
  port: Number(process.env.PORT || 4000),
  corsOrigins: list(process.env.CORS_ORIGINS || 'http://localhost:5173,http://localhost:5174'),
  db: buildDb(),
  jwtSecret: required('JWT_SECRET'),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '12h',
  ringTimeoutSec: Number(process.env.CALL_RING_TIMEOUT_SEC || 120),
  iceServers: buildIceServers(),
};

if (config.isProd && (config.jwtSecret.length < 32 || config.jwtSecret.startsWith('change-me'))) {
  throw new Error('JWT_SECRET must be a strong random value (>= 32 chars) in production');
}
