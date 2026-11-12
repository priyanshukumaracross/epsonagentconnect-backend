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

/** STUN/TURN settings; src/services/ice.js turns these into the list browsers use. */
function buildTurn() {
  const keyId = (process.env.CLOUDFLARE_TURN_KEY_ID || '').trim();
  const apiToken = (process.env.CLOUDFLARE_TURN_API_TOKEN || '').trim();
  if (!!keyId !== !!apiToken) throw new Error('Set both CLOUDFLARE_TURN_KEY_ID and CLOUDFLARE_TURN_API_TOKEN (or neither)');
  const turnUrls = list(process.env.TURN_URLS);
  return {
    stunUrls: list(process.env.STUN_URLS ?? 'stun:stun.l.google.com:19302'),
    cloudflare: keyId ? { keyId, apiToken } : null,
    static: turnUrls.length ? { urls: turnUrls, username: process.env.TURN_USERNAME, credential: process.env.TURN_CREDENTIAL } : null,
  };
}

/** Self-ping so the Render free plan doesn't sleep. RENDER_EXTERNAL_URL is set by Render automatically. */
function buildKeepAlive() {
  const minutes = Number(process.env.KEEP_ALIVE_MINUTES || 10);
  if (!(minutes >= 1 && minutes < 15)) throw new Error('KEEP_ALIVE_MINUTES must be between 1 and 14 (Render sleeps after 15 minutes)');
  const url = process.env.KEEP_ALIVE === 'false' ? '' : (process.env.KEEP_ALIVE_URL || process.env.RENDER_EXTERNAL_URL || '').trim();
  return { url, minutes };
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
  turn: buildTurn(),
  keepAlive: buildKeepAlive(),
};

if (config.isProd && (config.jwtSecret.length < 32 || config.jwtSecret.startsWith('change-me'))) {
  throw new Error('JWT_SECRET must be a strong random value (>= 32 chars) in production');
}
