/**
 * PostgreSQL (Neon) access.
 *
 * Queries use `?` placeholders (converted to $1..$n). `query()` resolves to { rows, affectedRows }.
 *   arr(list)    - value for a TEXT[] column
 *   inList(list) - value for `IN (?)` (expands to one placeholder per item)
 *
 * Dates: "today", day grouping and date filters are computed in config.db.timezone
 * explicitly in SQL (AT TIME ZONE), so results don't depend on the connection's session
 * time zone. That keeps them correct on Neon's pooled (PgBouncer) endpoint too.
 */
import pg from 'pg';
import { config } from '../config.js';

const TZ = config.db.timezone; // validated IANA name, safe to inline

export const sql = {
  /** timestamptz column -> local wall-clock timestamp */
  local: (col) => `(${col} AT TIME ZONE '${TZ}')`,
  /** timestamptz column -> local calendar date */
  day: (col) => `CAST(${col} AT TIME ZONE '${TZ}' AS date)`,
  /** today's local date */
  today: `CAST(now() AT TIME ZONE '${TZ}' AS date)`,
  /** placeholder for a 'YYYY-MM-DD[ HH:MM:SS]' parameter meaning local time -> timestamptz */
  localParam: `(CAST(? AS timestamp) AT TIME ZONE '${TZ}')`,
  /** start (local midnight) of the day N days ago, as timestamptz */
  daysAgoStart: (n) => `(CAST(CAST(now() AT TIME ZONE '${TZ}' AS date) - ${Number(n)} AS timestamp) AT TIME ZONE '${TZ}')`,
  fmtDay: (expr) => `to_char(${expr}, 'YYYY-MM-DD')`,
  secondsBetween: (from, to) => `CAST(EXTRACT(EPOCH FROM (${to} - ${from})) AS INTEGER)`,
};

export const arr = (list) => list;
export const inList = (list) => ({ __in: list });

/** Convert `?` placeholders (outside string literals) to $1..$n, expanding inList() values. */
function toPg(text, params = []) {
  let out = '';
  let inStr = false;
  let i = 0;
  const values = [];
  for (const ch of text) {
    if (ch === "'") inStr = !inStr;
    if (ch === '?' && !inStr) {
      const v = params[i++];
      if (v && typeof v === 'object' && Array.isArray(v.__in)) {
        out += v.__in.length ? v.__in.map((x) => { values.push(x); return `$${values.length}`; }).join(', ') : 'NULL';
      } else {
        values.push(v);
        out += `$${values.length}`;
      }
      continue;
    }
    out += ch;
  }
  return { text: out, values };
}

pg.types.setTypeParser(20, (v) => parseInt(v, 10)); // COUNT/SUM (bigint) -> number
pg.types.setTypeParser(1700, (v) => parseFloat(v)); // AVG/ROUND (numeric) -> number

const pgPool = new pg.Pool({
  connectionString: config.db.url,
  ssl: config.db.ssl,
  max: 10,
  idleTimeoutMillis: 30_000, // Neon closes idle connections when the compute suspends
  connectionTimeoutMillis: 15_000, // allow for Neon's cold start
  keepAlive: true,
});
pgPool.on('error', (err) => console.error('[db] idle client error:', err.message));

/** Connection dropped (e.g. Neon suspended the compute and closed idle connections). */
const isConnectionError = (err) =>
  ['ECONNRESET', 'EPIPE', 'ETIMEDOUT', '57P01', '57P02', '57P03', '08006', '08003'].includes(err?.code)
  || /Connection terminated|connection.*(closed|ended)|Client has encountered a connection error/i.test(err?.message || '');

/** Run a query with `?` placeholders. Retries once if the connection was dropped. */
export async function query(text, params = []) {
  const q = toPg(text, params);
  let r;
  try {
    r = await pgPool.query(q.text, q.values);
  } catch (err) {
    if (!isConnectionError(err)) throw err;
    console.warn('[db] connection dropped, retrying once:', err.message);
    r = await pgPool.query(q.text, q.values);
  }
  return { rows: r.rows || [], affectedRows: r.rowCount || 0 };
}

/** Run a multi-statement SQL script (migrations). */
export const runScript = (text) => pgPool.query(text);

/** Pool facade used by server start-up / shutdown and scripts. */
export const pool = {
  query: (text, params) => query(text, params),
  end: () => pgPool.end(),
};
