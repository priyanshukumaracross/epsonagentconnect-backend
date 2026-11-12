import { z } from 'zod';

export const uuid = z.string().uuid('Invalid id');

/** Pagination from query string. */
export function paging(q, defLimit = 25) {
  const limit = Math.min(Math.max(parseInt(q.limit, 10) || defLimit, 1), 200);
  const page = Math.max(parseInt(q.page, 10) || 1, 1);
  return { limit, page, offset: (page - 1) * limit };
}

/** Tiny WHERE-clause builder using `?` placeholders: w.add('x = ?', value). */
export function whereBuilder() {
  const parts = [];
  const params = [];
  return {
    params,
    add(sql, ...values) {
      params.push(...values);
      parts.push(sql);
    },
    get sql() {
      return parts.length ? `WHERE ${parts.join(' AND ')}` : '';
    },
  };
}

/** Escape % and _ for LIKE searches. */
export const likeTerm = (s) => `%${String(s).trim().slice(0, 60).replace(/[\\%_]/g, (m) => `\\${m}`)}%`;

/** Parse YYYY-MM-DD (inclusive range) into SQL-friendly bounds. */
export function dateRange(q) {
  const ok = (d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d);
  return { from: ok(q.from) ? q.from : null, to: ok(q.to) ? q.to : null };
}

export function toCsv(rows, columns) {
  const esc = (v) => {
    if (v === null || v === undefined) return '';
    let s = Array.isArray(v) ? v.join('; ') : v instanceof Date ? v.toISOString() : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // guard against spreadsheet formula injection
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = columns.map((c) => esc(c.label)).join(',');
  const body = rows.map((r) => columns.map((c) => esc(typeof c.value === 'function' ? c.value(r) : r[c.key])).join(','));
  return '﻿' + [head, ...body].join('\r\n');
}

export const refId = (id) => `EPS-${String(id).slice(0, 8).toUpperCase()}`;

/** 'YYYY-MM-DD' -> the following day, for exclusive upper bounds (`< nextDay(to)`). */
export function nextDay(day) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
