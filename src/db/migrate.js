import { pool, query } from './pool.js';
import { runMigrations } from './setup.js';

try {
  await runMigrations();
  const { rows: [v] } = await query('SELECT version() AS v');
  console.log(`✔ Database schema is up to date (${String(v.v).split(' on ')[0]})`);
} catch (err) {
  console.error('✖ Migration failed:', err.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
