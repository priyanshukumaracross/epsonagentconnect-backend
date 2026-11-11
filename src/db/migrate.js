import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createMultiStatementConnection } from './pool.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
let conn;
try {
  conn = await createMultiStatementConnection();
  const sql = await readFile(path.join(dir, 'schema.sql'), 'utf8');
  await conn.query(sql);
  const [[v]] = await conn.query('SELECT VERSION() AS v');
  console.log(`✔ Database schema is up to date (server ${v.v})`);
} catch (err) {
  console.error('✖ Migration failed:', err.message);
  process.exitCode = 1;
} finally {
  await conn?.end();
}
