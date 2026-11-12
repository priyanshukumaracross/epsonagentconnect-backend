/**
 * Database setup shared by `npm run db:migrate`, `npm run db:seed` and server start-up.
 */
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { arr, query, runScript } from './pool.js';

const dir = path.dirname(fileURLToPath(import.meta.url));

/** Create / upgrade all tables (idempotent). */
export async function runMigrations() {
  await runScript(await readFile(path.join(dir, 'schema.sql'), 'utf8'));
}

/** Insert a staff user unless the email already exists. Returns true if created. */
export async function createUserIfMissing({ name, email, password, role, languages }) {
  const { affectedRows } = await query(
    `INSERT INTO users (id, name, email, password_hash, role, languages)
     VALUES (?, ?, LOWER(?), ?, ?, ?) ON CONFLICT (email) DO NOTHING`,
    [crypto.randomUUID(), name, email, await bcrypt.hash(password, 10), role, arr(languages)],
  );
  return affectedRows > 0;
}

/**
 * Make sure at least one admin exists. Uses SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD.
 * Never changes an existing account.
 */
export async function ensureAdmin({ name, email, password }) {
  const { rows } = await query("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'");
  if (rows[0].n > 0) return 'exists';
  if (!email || !password) return 'missing-env';
  if (password.length < 8) throw new Error('SEED_ADMIN_PASSWORD must be at least 8 characters');
  await createUserIfMissing({ name, email, password, role: 'admin', languages: ['English'] });
  return 'created';
}
