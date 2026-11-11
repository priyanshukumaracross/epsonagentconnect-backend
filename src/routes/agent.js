/** Agent (product expert) API: own call history, stats and post-call notes. */
import { Router } from 'express';
import { z } from 'zod';
import { query, sql } from '../db/pool.js';
import { ah, HttpError } from '../middleware/error.js';
import { requireAuth } from '../middleware/auth.js';
import { paging, uuid, likeTerm } from '../utils/helpers.js';
import * as calls from '../services/calls.js';

const router = Router();
router.use(requireAuth('agent'));

const n = (expr) => `COALESCE(SUM(CASE WHEN ${expr} THEN 1 ELSE 0 END), 0)`;

router.get('/stats', ah(async (req, res) => {
  const { rows } = await query(
    `SELECT ${n("status = 'completed' AND DATE(requested_at) = CURRENT_DATE")} AS completed_today,
            COALESCE(SUM(CASE WHEN DATE(requested_at) = CURRENT_DATE THEN duration_seconds END), 0) AS talk_time_today,
            ${n("status = 'completed'")} AS completed_total,
            ROUND(AVG(rating), 1) AS avg_rating,
            ${n("status = 'completed' AND outcome IS NULL")} AS pending_notes
       FROM calls WHERE agent_id = ?`,
    [req.user.id],
  );
  res.json({ stats: rows[0] });
}));

router.get('/calls', ah(async (req, res) => {
  const { limit, offset, page } = paging(req.query, 20);
  const params = [req.user.id];
  let extra = '';
  if (req.query.search) {
    const s = likeTerm(req.query.search);
    params.push(s, s, s);
    extra = `AND (l.name ${sql.like} ? OR l.mobile ${sql.like} ? OR l.city ${sql.like} ?)`;
  }
  if (req.query.pending === 'yes') extra += " AND c.outcome IS NULL AND c.status = 'completed'";
  const [{ rows }, { rows: [count] }] = await Promise.all([
    query(
      `SELECT c.id, c.mode, c.language, c.status, c.requested_at, c.accepted_at, c.duration_seconds,
              c.rating, c.feedback, c.outcome, c.agent_notes, c.customer_requests,
              l.name AS customer_name, l.mobile, l.city, l.state, l.product, l.interests, s.name AS store_name
         FROM calls c JOIN leads l ON l.id = c.lead_id LEFT JOIN stores s ON s.id = l.store_id
        WHERE c.agent_id = ? ${extra}
     ORDER BY c.requested_at DESC LIMIT ${limit} OFFSET ${offset}`,
      params,
    ),
    query(`SELECT COUNT(*) AS total FROM calls c JOIN leads l ON l.id = c.lead_id WHERE c.agent_id = ? ${extra}`, params),
  ]);
  res.json({ items: rows, total: count.total, page, limit });
}));

router.patch('/calls/:id/notes', ah(async (req, res) => {
  const id = uuid.parse(req.params.id);
  const d = z.object({
    outcome: z.enum(['interested', 'purchased', 'follow_up', 'not_interested', 'support', 'other']),
    notes: z.string().trim().max(2000).optional().default(''),
  }).parse(req.body);
  const { affectedRows } = await query(
    `UPDATE calls SET outcome = ?, agent_notes = NULLIF(?, ''), updated_at = ${sql.now} WHERE id = ? AND agent_id = ?`,
    [d.outcome, d.notes, id, req.user.id],
  );
  if (!affectedRows) throw new HttpError(404, 'Call not found');
  const { rows } = await query('SELECT id, outcome, agent_notes FROM calls WHERE id = ?', [id]);
  calls.notifyAdmins();
  res.json({ call: rows[0] });
}));

export default router;
