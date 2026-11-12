import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

// Load backend/.env for local development. On Render, variables come from the dashboard / render.yaml.
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.env') });

function required(key) {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required environment variable: ${key} (see backend/.env.example)`);
  return value;
}

const list = (v) => (v || '').split(',').map((s) => s.trim()).filter(Boolean);

/**
 * CORS_ORIGINS entry -> exact string, or a RegExp when it contains "*".
 * "*" matches one part of a host name, e.g. https://epson-*.vercel.app also allows
 * Vercel preview URLs like https://epson-connect-git-main-yourteam.vercel.app
 */
function corsEntry(origin) {
  const clean = origin.replace(/\/+$/, '');
  if (!clean.includes('*')) return clean;
  const pattern = clean.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')).join('[a-z0-9-]*');
  return new RegExp(`^${pattern}$`, 'i');
}

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
 * Neon PostgreSQL. DATABASE_URL is the connection string from the Neon console
 * (it already contains sslmode=require). DB_TIMEZONE is used for "today", daily charts and date filters.
 */
function buildDb() {
  const url = required('DATABASE_URL');
  if (!/^postgres(ql)?:\/\//i.test(url)) throw new Error('DATABASE_URL must be a PostgreSQL (Neon) connection string');
  const timezone = process.env.DB_TIMEZONE || 'Asia/Kolkata';
  if (!/^[A-Za-z]+(?:\/[A-Za-z0-9_+-]+)*$/.test(timezone)) throw new Error('DB_TIMEZONE must be an IANA zone like Asia/Kolkata');
  return { url, timezone, ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined };
}

export const config = {
  env: process.env.NODE_ENV || 'development',
  isProd: process.env.NODE_ENV === 'production',
  port: Number(process.env.PORT || 4000),
  corsOrigins: list(process.env.CORS_ORIGINS || 'http://localhost:5173,http://localhost:5174').map(corsEntry),
  db: buildDb(),
  jwtSecret: required('JWT_SECRET'),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '12h',
  ringTimeoutSec: Number(process.env.CALL_RING_TIMEOUT_SEC || 120),
  // On start-up: create/upgrade tables and create the first admin from SEED_ADMIN_* (no shell needed on Render)
  autoSetup: process.env.AUTO_SETUP !== 'false',
  seedAdmin: {
    name: process.env.SEED_ADMIN_NAME || 'Epson Admin',
    email: process.env.SEED_ADMIN_EMAIL || '',
    password: process.env.SEED_ADMIN_PASSWORD || '',
  },
  iceServers: buildIceServers(),
};

if (config.isProd && (config.jwtSecret.length < 32 || config.jwtSecret.startsWith('change-me'))) {
  throw new Error('JWT_SECRET must be a strong random value (>= 32 chars) in production');
}
