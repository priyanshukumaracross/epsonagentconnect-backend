import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { pool, query } from './pool.js';

const env = process.env;

async function upsertUser({ name, email, password, role, languages }) {
  const hash = await bcrypt.hash(password, 10);
  const { affectedRows } = await query(
    `INSERT IGNORE INTO users (id, name, email, password_hash, role, languages)
     VALUES (?, ?, LOWER(?), ?, ?, ?)`,
    [crypto.randomUUID(), name, email, hash, role, JSON.stringify(languages)],
  );
  console.log(affectedRows ? `  + ${role.padEnd(5)} ${email} / ${password}` : `  = ${role.padEnd(5)} ${email} (already exists)`);
}

try {
  console.log('Seeding users…');
  await upsertUser({
    name: env.SEED_ADMIN_NAME || 'Epson Admin',
    email: env.SEED_ADMIN_EMAIL || 'admin@epson.local',
    password: env.SEED_ADMIN_PASSWORD || 'Admin@123',
    role: 'admin',
    languages: ['English'],
  });

  if (env.SEED_DEMO_DATA !== 'false') {
    await upsertUser({ name: 'Riya Sharma', email: 'riya@epson.local', password: 'Agent@123', role: 'agent', languages: ['English', 'Hindi'] });
    await upsertUser({ name: 'Arjun Mehta', email: 'arjun@epson.local', password: 'Agent@123', role: 'agent', languages: ['English', 'Hindi', 'Marathi'] });
    await upsertUser({ name: 'Priya Nair', email: 'priya@epson.local', password: 'Agent@123', role: 'agent', languages: ['English', 'Tamil', 'Telugu'] });

    console.log('Seeding stores…');
    const stores = [
      ['DEL-NP01', 'Epson Store · Nehru Place', 'New Delhi', 'Delhi', 'EcoTank L3250'],
      ['MUM-AW01', 'Croma · Andheri West', 'Mumbai', 'Maharashtra', 'EcoTank L6460'],
      ['BLR-KR01', 'Reliance Digital · Koramangala', 'Bengaluru', 'Karnataka', 'EcoTank L4260'],
    ];
    for (const s of stores) {
      await query(
        'INSERT IGNORE INTO stores (id, code, name, city, state, default_product) VALUES (?, ?, ?, ?, ?, ?)',
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
