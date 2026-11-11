/**
 * Database access for both PostgreSQL (local dev on Neon) and MySQL/MariaDB (cPanel deployment).
 *
 * Write SQL once with `?` placeholders and the `sql.*` helpers below for the few
 * dialect-specific bits. `query()` always resolves to { rows, affectedRows }.
 *
 *   arr(list)     - value for a list column (TEXT[] in Postgres, JSON in MySQL)
 *   inList(list)  - value for `IN (?)`
 */
import pg from 'pg';
import mysql from 'mysql2';
import { config } from '../config.js';

const db = config.db;
export const isPg = db.client === 'postgres';
export const dialect = db.client;

/* ------------------------------ SQL helpers ------------------------------ */
export const sql = isPg
  ? {
    now: 'now()',
    like: 'ILIKE',
    idText: (col) => `CAST(${col} AS TEXT)`,
    secondsBetween: (from, to) => `CAST(EXTRACT(EPOCH FROM (${to} - ${from})) AS INTEGER)`,
    fmtDay: (expr) => `to_char(${expr}, 'YYYY-MM-DD')`,
    daysAgo: (n) => `(CURRENT_DATE - INTERVAL '${Number(n)} days')`,
    listHas: (col) => `(? = ANY(${col}))`,
    listHasLiteral: (col, v) => `('${v}' = ANY(${col}))`,
    listAppend: (col) => `array_append(${col}, ?)`,
    insertIgnore: (intoAndCols, values) => `INSERT INTO ${intoAndCols} VALUES ${values} ON CONFLICT DO NOTHING`,
  }
  : {
    now: 'NOW(3)',
    like: 'LIKE',
    idText: (col) => col,
    secondsBetween: (from, to) => `TIMESTAMPDIFF(SECOND, ${from}, ${to})`,
    fmtDay: (expr) => `DATE_FORMAT(${expr}, '%Y-%m-%d')`,
    daysAgo: (n) => `(CURRENT_DATE - INTERVAL ${Number(n)} DAY)`,
    listHas: (col) => `JSON_CONTAINS(${col}, JSON_QUOTE(?))`,
    listHasLiteral: (col, v) => `JSON_CONTAINS(${col}, '"${v}"')`,
    listAppend: (col) => `JSON_ARRAY_APPEND(${col}, '$', ?)`,
    insertIgnore: (intoAndCols, values) => `INSERT IGNORE INTO ${intoAndCols} VALUES ${values}`,
  };

export const arr = (list) => (isPg ? list : JSON.stringify(list));
export const inList = (list) => (isPg ? { __in: list } : list);

/* ------------------------------ PostgreSQL ------------------------------ */
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

function createPg() {
  pg.types.setTypeParser(20, (v) => parseInt(v, 10)); // COUNT/SUM (bigint) -> number
  pg.types.setTypeParser(1700, (v) => parseFloat(v)); // AVG/ROUND (numeric) -> number
  const pool = new pg.Pool({
    connectionString: db.url,
    ssl: db.ssl,
    max: 10,
    options: `-c timezone=${db.timezone}`,
  });
  pool.on('error', (err) => console.error('[db] idle client error', err));
  return {
    async run(text, params) {
      const q = toPg(text, params);
      const r = await pool.query(q.text, q.values);
      return { rows: r.rows || [], affectedRows: r.rowCount || 0 };
    },
    multi: (text) => pool.query(text),
    end: () => pool.end(),
  };
}

/* ------------------------------ MySQL / MariaDB ------------------------------ */
const JSON_COLUMNS = new Set(['interests', 'languages', 'customer_requests']);

function createMysql() {
  const base = {
    waitForConnections: true,
    connectionLimit: 10,
    timezone: db.tzOffset,
    decimalNumbers: true,
    charset: 'utf8mb4',
    ssl: db.ssl,
    typeCast(field, next) {
      if (field.type === 'TINY' && field.length === 1) {
        const v = field.string();
        return v === null ? null : v === '1';
      }
      // MariaDB stores JSON as text: always return arrays
      if (JSON_COLUMNS.has(field.name) && ['JSON', 'BLOB', 'VAR_STRING', 'STRING'].includes(field.type)) {
        const v = field.string('utf8');
        if (v === null) return null;
        try { return JSON.parse(v); } catch { return v; }
      }
      return next();
    },
  };
  const conn = db.uri ? { uri: db.uri } : { host: db.host, port: db.port, user: db.user, password: db.password, database: db.database };
  const raw = mysql.createPool({ ...conn, ...base });
  raw.on('connection', (c) => c.query(`SET time_zone = '${db.tzOffset}'`));
  const pool = raw.promise();
  return {
    async run(text, params) {
      const [result] = await pool.query(text, params);
      if (Array.isArray(result)) return { rows: result, affectedRows: 0 };
      return { rows: [], affectedRows: result.affectedRows };
    },
    async multi(text) {
      const c = await mysql.createConnection({ ...conn, ssl: db.ssl, charset: 'utf8mb4', multipleStatements: true }).promise();
      try { await c.query(text); } finally { await c.end(); }
    },
    end: () => pool.end(),
  };
}

const driver = isPg ? createPg() : createMysql();

/** Run a query with `?` placeholders. */
export const query = (text, params = []) => driver.run(text, params);

/** Run a multi-statement SQL script (migrations). */
export const runScript = (text) => driver.multi(text);

/** Minimal pool facade used by server start-up / shutdown and scripts. */
export const pool = {
  query: (text, params) => query(text, params),
  end: () => driver.end(),
};
