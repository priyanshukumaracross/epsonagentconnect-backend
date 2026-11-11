/** Admin panel API: dashboard, leads, calls, team, stores, exports. */
import { Router } from 'express';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { arr, inList, query, sql } from '../db/pool.js';
import { ah, HttpError } from '../middleware/error.js';
import { requireAuth } from '../middleware/auth.js';
import { paging, whereBuilder, dateRange, nextDay, toCsv, uuid, refId, likeTerm } from '../utils/helpers.js';
import * as presence from '../services/presence.js';
import * as calls from '../services/calls.js';

const router = Router();
router.use(requireAuth('admin'));

const CALL_STATUSES = ['queued', 'in_progress', 'completed', 'missed', 'cancelled', 'failed'];
const n = (expr) => `COALESCE(SUM(CASE WHEN ${expr} THEN 1 ELSE 0 END), 0)`; // count rows matching a condition

/* =========================== Dashboard =========================== */
router.get('/stats', ah(async (req, res) => {
  const { from, to } = dateRange(req.query);
  const lo = from || '1970-01-01';
  const hi = to || '2999-12-31';

  const [{ rows: [totals] }, { rows: [leadTotals] }, { rows: [today] }, { rows: dailyRows }, { rows: states }, { rows: agents }, { rows: stores }] = await Promise.all([
    query(
      `SELECT COUNT(*) AS calls,
              ${n("status = 'completed'")} AS completed,
              ${n("status = 'missed'")} AS missed,
              ${n("status = 'cancelled'")} AS cancelled,
              ${n("status = 'failed'")} AS failed,
              ${n("status = 'queued'")} AS queued,
              ${n("status = 'in_progress'")} AS in_progress,
              ${n("mode = 'video'")} AS video,
              ${n("mode = 'voice'")} AS voice,
              COALESCE(ROUND(AVG(CASE WHEN status = 'completed' THEN duration_seconds END)), 0) AS avg_duration,
              ROUND(AVG(rating), 1) AS avg_rating,
              ${n("outcome = 'purchased'")} AS purchased,
              ${n(`${sql.listHasLiteral('customer_requests', 'callback')} AND status <> 'completed'`)} AS callbacks
         FROM calls WHERE DATE(requested_at) BETWEEN ? AND ?`,
      [lo, hi],
    ),
    query(
      `SELECT COUNT(*) AS leads,
              ${n("EXISTS (SELECT 1 FROM calls c WHERE c.lead_id = l.id AND c.status = 'completed')")} AS connected_leads
         FROM leads l WHERE DATE(l.created_at) BETWEEN ? AND ?`,
      [lo, hi],
    ),
    query(`SELECT ${sql.fmtDay('CURRENT_DATE')} AS d`),
    query(
      `SELECT ${sql.fmtDay('requested_at')} AS day_key,
              ${n("status = 'completed'")} AS completed,
              ${n("status IN ('missed','cancelled','failed')")} AS not_connected
         FROM calls WHERE requested_at >= ${sql.daysAgo(13)}
     GROUP BY day_key`,
    ),
    query(
      `SELECT state, COUNT(*) AS leads FROM leads WHERE DATE(created_at) BETWEEN ? AND ?
        GROUP BY state ORDER BY leads DESC LIMIT 6`,
      [lo, hi],
    ),
    query(
      `SELECT u.id, u.name,
              ${n("c.status = 'completed'")} AS completed,
              COALESCE(ROUND(AVG(CASE WHEN c.status = 'completed' THEN c.duration_seconds END)), 0) AS avg_duration,
              ROUND(AVG(c.rating), 1) AS avg_rating,
              ${n("c.outcome = 'purchased'")} AS purchased
         FROM users u
    LEFT JOIN calls c ON c.agent_id = u.id AND DATE(c.requested_at) BETWEEN ? AND ?
        WHERE u.role = 'agent'
     GROUP BY u.id, u.name ORDER BY completed DESC, u.name LIMIT 10`,
      [lo, hi],
    ),
    query(
      `SELECT s.id, s.name, s.code, COUNT(l.id) AS leads
         FROM stores s LEFT JOIN leads l ON l.store_id = s.id AND DATE(l.created_at) BETWEEN ? AND ?
     GROUP BY s.id, s.name, s.code ORDER BY leads DESC LIMIT 6`,
      [lo, hi],
    ),
  ]);

  // Fill the last 14 days (including days without calls)
  const byDay = new Map(dailyRows.map((r) => [r.day_key, r]));
  const end = new Date(`${today.d}T00:00:00Z`);
  const daily = Array.from({ length: 14 }, (_, i) => {
    const d = new Date(end);
    d.setUTCDate(end.getUTCDate() - 13 + i);
    const day = d.toISOString().slice(0, 10);
    const r = byDay.get(day);
    return { day, completed: r?.completed || 0, not_connected: r?.not_connected || 0 };
  });

  res.json({
    totals: { ...totals, ...leadTotals },
    daily,
    topStates: states,
    topStores: stores,
    agents,
    presence: presence.list(),
  });
}));

/* =========================== Calls =========================== */
function callFilters(q) {
  const w = whereBuilder();
  const statuses = String(q.status || '').split(',').filter((s) => CALL_STATUSES.includes(s));
  if (statuses.length) w.add('c.status IN (?)', inList(statuses));
  if (q.mode === 'video' || q.mode === 'voice') w.add('c.mode = ?', q.mode);
  if (uuid.safeParse(q.agentId).success) w.add('c.agent_id = ?', q.agentId);
  if (uuid.safeParse(q.storeId).success) w.add('l.store_id = ?', q.storeId);
  if (q.connected === 'yes') w.add("c.status = 'completed'");
  if (q.connected === 'no') w.add("c.status IN ('missed','cancelled','failed')");
  if (q.callback === 'yes') w.add(sql.listHasLiteral('c.customer_requests', 'callback'));
  const { from, to } = dateRange(q);
  if (from) w.add('c.requested_at >= ?', `${from} 00:00:00`);
  if (to) w.add('c.requested_at < ?', nextDay(to));
  if (q.search) {
    const s = likeTerm(q.search);
    const ref = `${String(q.search).trim().replace(/^EPS-/i, '').toLowerCase().replace(/[\\%_]/g, '')}%`;
    w.add(`(l.name ${sql.like} ? OR l.mobile ${sql.like} ? OR l.city ${sql.like} ? OR ${sql.idText('c.id')} ${sql.like} ?)`, s, s, s, ref);
  }
  return w;
}

const CALL_SELECT = `
  SELECT c.id, c.mode, c.language, c.status, c.requested_at, c.accepted_at, c.ended_at, c.duration_seconds,
         c.end_reason, c.rating, c.feedback, c.outcome, c.agent_notes, c.customer_requests,
         ${sql.secondsBetween('c.requested_at', `COALESCE(c.accepted_at, c.ended_at, ${sql.now})`)} AS wait_seconds,
         l.id AS lead_id, l.name AS customer_name, l.mobile, l.city, l.state, l.product, l.interests,
         s.id AS store_id, s.name AS store_name, s.code AS store_code,
         u.id AS agent_id, u.name AS agent_name
    FROM calls c
    JOIN leads l ON l.id = c.lead_id
LEFT JOIN stores s ON s.id = l.store_id
LEFT JOIN users u ON u.id = c.agent_id`;

router.get('/calls', ah(async (req, res) => {
  const { limit, offset, page } = paging(req.query);
  const w = callFilters(req.query);
  const [{ rows }, { rows: [count] }] = await Promise.all([
    query(`${CALL_SELECT} ${w.sql} ORDER BY c.requested_at DESC LIMIT ${limit} OFFSET ${offset}`, w.params),
    query(`SELECT COUNT(*) AS total FROM calls c JOIN leads l ON l.id = c.lead_id ${w.sql}`, w.params),
  ]);
  res.json({ items: rows, total: count.total, page, limit });
}));

const fmtDate = (d) => (d ? new Date(d).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) : '');

router.get('/export/calls.csv', ah(async (req, res) => {
  const w = callFilters(req.query);
  const { rows } = await query(`${CALL_SELECT} ${w.sql} ORDER BY c.requested_at DESC LIMIT 50000`, w.params);
  const csv = toCsv(rows, [
    { label: 'Reference', value: (r) => refId(r.id) },
    { label: 'Requested at', value: (r) => fmtDate(r.requested_at) },
    { label: 'Customer', key: 'customer_name' },
    { label: 'Mobile', key: 'mobile' },
    { label: 'City', key: 'city' },
    { label: 'State', key: 'state' },
    { label: 'Store', key: 'store_name' },
    { label: 'Product', key: 'product' },
    { label: 'Mode', key: 'mode' },
    { label: 'Language', key: 'language' },
    { label: 'Status', key: 'status' },
    { label: 'Call done', value: (r) => (r.status === 'completed' ? 'Yes' : 'No') },
    { label: 'Agent', key: 'agent_name' },
    { label: 'Wait (sec)', key: 'wait_seconds' },
    { label: 'Duration (sec)', key: 'duration_seconds' },
    { label: 'Rating', key: 'rating' },
    { label: 'Outcome', key: 'outcome' },
    { label: 'Agent notes', key: 'agent_notes' },
    { label: 'Customer requests', key: 'customer_requests' },
    { label: 'End reason', key: 'end_reason' },
  ]);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="epson-calls-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(csv);
}));

/* =========================== Leads =========================== */
const CONNECTED = "EXISTS (SELECT 1 FROM calls x WHERE x.lead_id = l.id AND x.status = 'completed')";

function leadFilters(q) {
  const w = whereBuilder();
  if (q.state) w.add('l.state = ?', String(q.state));
  if (uuid.safeParse(q.storeId).success) w.add('l.store_id = ?', q.storeId);
  if (q.connected === 'yes') w.add(CONNECTED);
  if (q.connected === 'no') w.add(`NOT ${CONNECTED}`);
  const { from, to } = dateRange(q);
  if (from) w.add('l.created_at >= ?', `${from} 00:00:00`);
  if (to) w.add('l.created_at < ?', nextDay(to));
  if (q.search) {
    const s = likeTerm(q.search);
    w.add(`(l.name ${sql.like} ? OR l.mobile ${sql.like} ? OR l.city ${sql.like} ?)`, s, s, s);
  }
  return w;
}

const LEAD_SELECT = `
  SELECT l.id, l.name, l.mobile, l.state, l.city, l.interests, l.store_id, l.product, l.consent, l.created_at,
         s.name AS store_name, s.code AS store_code,
         lc.status AS last_call_status, lc.mode AS last_call_mode, lc.requested_at AS last_call_at, lu.name AS last_agent,
         (SELECT COUNT(*) FROM calls x WHERE x.lead_id = l.id) AS call_count,
         ${CONNECTED} AS connected
    FROM leads l
LEFT JOIN stores s ON s.id = l.store_id
LEFT JOIN calls lc ON lc.id = (SELECT c2.id FROM calls c2 WHERE c2.lead_id = l.id ORDER BY c2.requested_at DESC LIMIT 1)
LEFT JOIN users lu ON lu.id = lc.agent_id`;

const asBool = (r) => ({ ...r, connected: !!r.connected });

router.get('/leads', ah(async (req, res) => {
  const { limit, offset, page } = paging(req.query);
  const w = leadFilters(req.query);
  const [{ rows }, { rows: [count] }] = await Promise.all([
    query(`${LEAD_SELECT} ${w.sql} ORDER BY l.created_at DESC LIMIT ${limit} OFFSET ${offset}`, w.params),
    query(`SELECT COUNT(*) AS total FROM leads l ${w.sql}`, w.params),
  ]);
  res.json({ items: rows.map(asBool), total: count.total, page, limit });
}));

router.get('/leads/states', ah(async (req, res) => {
  const { rows } = await query('SELECT DISTINCT state FROM leads ORDER BY state');
  res.json({ items: rows.map((r) => r.state) });
}));

router.get('/leads/:id', ah(async (req, res) => {
  const id = uuid.parse(req.params.id);
  const { rows } = await query(`${LEAD_SELECT} WHERE l.id = ?`, [id]);
  if (!rows[0]) throw new HttpError(404, 'Lead not found');
  const { rows: history } = await query(`${CALL_SELECT} WHERE c.lead_id = ? ORDER BY c.requested_at DESC`, [id]);
  // other submissions from the same mobile number
  const { rows: related } = await query(
    'SELECT id, name, city, created_at FROM leads WHERE mobile = ? AND id <> ? ORDER BY created_at DESC LIMIT 10',
    [rows[0].mobile, id],
  );
  res.json({ lead: asBool(rows[0]), calls: history, related });
}));

router.get('/export/leads.csv', ah(async (req, res) => {
  const w = leadFilters(req.query);
  const { rows } = await query(`${LEAD_SELECT} ${w.sql} ORDER BY l.created_at DESC LIMIT 50000`, w.params);
  const csv = toCsv(rows, [
    { label: 'Submitted at', value: (r) => fmtDate(r.created_at) },
    { label: 'Name', key: 'name' },
    { label: 'Mobile', key: 'mobile' },
    { label: 'City', key: 'city' },
    { label: 'State', key: 'state' },
    { label: 'Store', key: 'store_name' },
    { label: 'Product', key: 'product' },
    { label: 'Interests', key: 'interests' },
    { label: 'Calls', key: 'call_count' },
    { label: 'Connected with expert', value: (r) => (r.connected ? 'Yes' : 'No') },
    { label: 'Last call status', key: 'last_call_status' },
    { label: 'Last agent', key: 'last_agent' },
  ]);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="epson-leads-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(csv);
}));

/* =========================== Team (admins + agents) =========================== */
const languages = z.array(z.string().trim().min(2).max(30)).min(1, 'Pick at least one language').max(12);
const USER_COLS = 'id, name, email, role, languages, is_active, created_at';

router.get('/users', ah(async (req, res) => {
  const { rows } = await query(
    `SELECT u.id, u.name, u.email, u.role, u.languages, u.is_active, u.last_login_at, u.created_at,
            ${n("c.status = 'completed'")} AS completed_calls,
            ${n("c.status = 'completed' AND DATE(c.requested_at) = CURRENT_DATE")} AS completed_today,
            ROUND(AVG(c.rating), 1) AS avg_rating
       FROM users u LEFT JOIN calls c ON c.agent_id = u.id
      GROUP BY u.id, u.name, u.email, u.role, u.languages, u.is_active, u.last_login_at, u.created_at
      ORDER BY u.role, u.name`,
  );
  const online = new Map(presence.list().map((p) => [p.id, p]));
  res.json({ items: rows.map((u) => ({ ...u, presence: online.get(u.id)?.status || 'offline' })) });
}));

router.post('/users', ah(async (req, res) => {
  const d = z.object({
    name: z.string().trim().min(2, 'Enter a name').max(80),
    email: z.string().trim().email('Enter a valid email').max(191),
    password: z.string().min(8, 'Password must be at least 8 characters').max(100),
    role: z.enum(['admin', 'agent']).default('agent'),
    languages: languages.default(['English']),
  }).parse(req.body);
  const id = crypto.randomUUID();
  await query(
    'INSERT INTO users (id, name, email, password_hash, role, languages) VALUES (?, ?, LOWER(?), ?, ?, ?)',
    [id, d.name, d.email, await bcrypt.hash(d.password, 10), d.role, arr(d.languages)],
  );
  const { rows } = await query(`SELECT ${USER_COLS} FROM users WHERE id = ?`, [id]);
  res.status(201).json({ user: rows[0] });
}));

router.patch('/users/:id', ah(async (req, res) => {
  const id = uuid.parse(req.params.id);
  const d = z.object({
    name: z.string().trim().min(2).max(80).optional(),
    languages: languages.optional(),
    isActive: z.boolean().optional(),
    role: z.enum(['admin', 'agent']).optional(),
    password: z.string().min(8, 'Password must be at least 8 characters').max(100).optional(),
  }).parse(req.body);

  if (id === req.user.id && (d.isActive === false || d.role === 'agent')) {
    throw new HttpError(400, 'You cannot deactivate or demote your own account');
  }
  const sets = [];
  const params = [];
  const set = (col, v) => { sets.push(`${col} = ?`); params.push(v); };
  if (d.name !== undefined) set('name', d.name);
  if (d.languages !== undefined) set('languages', arr(d.languages));
  if (d.isActive !== undefined) set('is_active', d.isActive);
  if (d.role !== undefined) set('role', d.role);
  if (d.password !== undefined) set('password_hash', await bcrypt.hash(d.password, 10));
  if (!sets.length) throw new HttpError(400, 'Nothing to update');

  const { rows: existing } = await query('SELECT id FROM users WHERE id = ?', [id]);
  if (!existing[0]) throw new HttpError(404, 'User not found');
  await query(`UPDATE users SET ${sets.join(', ')}, updated_at = ${sql.now} WHERE id = ?`, [...params, id]);
  const { rows } = await query(`SELECT ${USER_COLS} FROM users WHERE id = ?`, [id]);
  if (d.isActive === false || d.role) await calls.disconnectUser(id);
  res.json({ user: rows[0] });
}));

/* =========================== Stores =========================== */
const storeSchema = z.object({
  code: z.string().trim().min(2).max(40).regex(/^[A-Za-z0-9_-]+$/, 'Code can contain letters, numbers, - and _').transform((s) => s.toUpperCase()),
  name: z.string().trim().min(2, 'Enter the store name').max(120),
  city: z.string().trim().max(60).nullish(),
  state: z.string().trim().max(60).nullish(),
  defaultProduct: z.string().trim().max(80).nullish(),
  isActive: z.boolean().optional(),
});

router.get('/stores', ah(async (req, res) => {
  const { rows } = await query(
    `SELECT s.*,
            (SELECT COUNT(*) FROM leads l WHERE l.store_id = s.id) AS leads,
            (SELECT COUNT(*) FROM calls c JOIN leads l ON l.id = c.lead_id WHERE l.store_id = s.id AND c.status = 'completed') AS completed_calls
       FROM stores s ORDER BY s.created_at DESC`,
  );
  res.json({ items: rows });
}));

router.post('/stores', ah(async (req, res) => {
  const d = storeSchema.parse(req.body);
  const id = crypto.randomUUID();
  await query(
    'INSERT INTO stores (id, code, name, city, state, default_product, is_active) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [id, d.code, d.name, d.city || null, d.state || null, d.defaultProduct || null, d.isActive ?? true],
  );
  const { rows } = await query('SELECT * FROM stores WHERE id = ?', [id]);
  res.status(201).json({ store: rows[0] });
}));

router.patch('/stores/:id', ah(async (req, res) => {
  const id = uuid.parse(req.params.id);
  const d = storeSchema.partial().parse(req.body);
  const map = { code: 'code', name: 'name', city: 'city', state: 'state', defaultProduct: 'default_product', isActive: 'is_active' };
  const sets = [];
  const params = [];
  for (const [k, col] of Object.entries(map)) {
    if (d[k] !== undefined) { sets.push(`${col} = ?`); params.push(d[k]); }
  }
  if (!sets.length) throw new HttpError(400, 'Nothing to update');
  const { rows: existing } = await query('SELECT id FROM stores WHERE id = ?', [id]);
  if (!existing[0]) throw new HttpError(404, 'Store not found');
  await query(`UPDATE stores SET ${sets.join(', ')}, updated_at = ${sql.now} WHERE id = ?`, [...params, id]);
  const { rows } = await query('SELECT * FROM stores WHERE id = ?', [id]);
  res.json({ store: rows[0] });
}));

export default router;
