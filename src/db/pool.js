import mysql from 'mysql2';
import { config } from '../config.js';

/**
 * MySQL 5.7+/8 and MariaDB 10.3+ compatible connection pool.
 * - All times are stored/returned in config.dbTimezoneOffset (session time_zone + driver timezone match).
 * - TINYINT(1) columns come back as booleans, DECIMAL as numbers.
 * - JSON columns (MariaDB stores them as text) are always parsed to arrays/objects.
 */
const JSON_COLUMNS = new Set(['interests', 'languages', 'customer_requests']);

const base = {
  waitForConnections: true,
  connectionLimit: 10,
  timezone: config.dbTimezoneOffset,
  dateStrings: false,
  decimalNumbers: true,
  charset: 'utf8mb4',
  typeCast(field, next) {
    if (field.type === 'TINY' && field.length === 1) {
      const v = field.string();
      return v === null ? null : v === '1';
    }
    if (JSON_COLUMNS.has(field.name) && (field.type === 'JSON' || field.type === 'BLOB' || field.type === 'VAR_STRING' || field.type === 'STRING')) {
      const v = field.string('utf8');
      if (v === null) return null;
      try { return JSON.parse(v); } catch { return v; }
    }
    return next();
  },
};

const raw = config.db.uri
  ? mysql.createPool({ uri: config.db.uri, ssl: config.db.ssl, ...base })
  : mysql.createPool({ ...config.db, ...base });

raw.on('connection', (conn) => {
  conn.query(`SET time_zone = '${config.dbTimezoneOffset}'`);
});

export const pool = raw.promise();

/**
 * Run a query with `?` placeholders. Arrays expand for `IN (?)`.
 * Returns { rows, affectedRows, insertId } so call sites read the same for SELECT/UPDATE.
 */
export async function query(sql, params = []) {
  const [result] = await pool.query(sql, params);
  if (Array.isArray(result)) return { rows: result, affectedRows: 0 };
  return { rows: [], affectedRows: result.affectedRows, insertId: result.insertId };
}

/** Create a single connection that allows multiple statements (used by the migration script). */
export function createMultiStatementConnection() {
  const opts = config.db.uri
    ? { uri: config.db.uri, ssl: config.db.ssl, multipleStatements: true, charset: 'utf8mb4' }
    : { ...config.db, multipleStatements: true, charset: 'utf8mb4' };
  return mysql.createConnection(opts).promise();
}
