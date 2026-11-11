import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { dialect, pool, query, runScript } from './pool.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
try {
  const sqlText = await readFile(path.join(dir, `schema.${dialect}.sql`), 'utf8');
  await runScript(sqlText);
  const { rows: [v] } = await query('SELECT VERSION() AS v');
  console.log(`✔ Database schema is up to date (${dialect}: ${String(v.v).split(' on ')[0]})`);
} catch (err) {
  console.error('✖ Migration failed:', err.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
