/**
 * npm run db:seed - creates the admin from SEED_ADMIN_* and, with SEED_DEMO_DATA=true,
 * demo experts and stores. Safe to re-run: existing records are left untouched.
 */
import crypto from 'node:crypto';
import { config } from '../config.js';
import { pool, query } from './pool.js';
import { createUserIfMissing } from './setup.js';

const env = process.env;
const log = (created, role, email, password) =>
  console.log(created ? `  + ${role.padEnd(5)} ${email} / ${password}` : `  = ${role.padEnd(5)} ${email} (already exists)`);

try {
  console.log('Seeding users…');
  const admin = config.seedAdmin;
  if (admin.email && admin.password) {
    log(await createUserIfMissing({ ...admin, role: 'admin', languages: ['English'] }), 'admin', admin.email, admin.password);
  } else {
    console.log('  ! SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD not set - no admin created');
  }

  if (env.SEED_DEMO_DATA === 'true') {
    const agents = [
      ['Riya Sharma', 'riya@epson.local', ['English', 'Hindi']],
      ['Arjun Mehta', 'arjun@epson.local', ['English', 'Hindi', 'Marathi']],
      ['Priya Nair', 'priya@epson.local', ['English', 'Tamil', 'Telugu']],
    ];
    for (const [name, email, languages] of agents) {
      log(await createUserIfMissing({ name, email, password: 'Agent@123', role: 'agent', languages }), 'agent', email, 'Agent@123');
    }

    console.log('Seeding stores…');
    const stores = [
      ['DEL-NP01', 'Epson Store · Nehru Place', 'New Delhi', 'Delhi', 'EcoTank L3250'],
      ['MUM-AW01', 'Croma · Andheri West', 'Mumbai', 'Maharashtra', 'EcoTank L6460'],
      ['BLR-KR01', 'Reliance Digital · Koramangala', 'Bengaluru', 'Karnataka', 'EcoTank L4260'],
    ];
    for (const s of stores) {
      await query(
        `INSERT INTO stores (id, code, name, city, state, default_product) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (code) DO NOTHING`,
        [crypto.randomUUID(), ...s],
      );
      console.log(`  + store ${s[0]}  ${s[1]}`);
    }
  }
  console.log('✔ Seed complete');
} catch (err) {
  console.error('✖ Seed failed:', err.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
