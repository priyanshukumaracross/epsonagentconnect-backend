/** Endpoints used by the customer website (no login). */
import { Router } from 'express';
import crypto from 'node:crypto';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { arr, query } from '../db/pool.js';
import { config } from '../config.js';
import { ah, HttpError } from '../middleware/error.js';
import { uuid } from '../utils/helpers.js';
import * as presence from '../services/presence.js';
import * as calls from '../services/calls.js';

const router = Router();

const writeLimiter = rateLimit({ windowMs: 10 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many requests. Please wait a few minutes and try again.' } });

const MODES = ['video', 'voice'];
const REQUESTS = ['brochure', 'store_assist', 'callback'];

router.get('/stores/:code', ah(async (req, res) => {
  const { rows } = await query(
    'SELECT code, name, city, state, default_product FROM stores WHERE code = ? AND is_active',
    [String(req.params.code).slice(0, 40)],
  );
  if (!rows[0]) throw new HttpError(404, 'Store not found');
  res.json({ store: rows[0] });
}));

router.get('/availability', (req, res) => {
  res.json({ agentsOnline: presence.onlineCount(), agentsAvailable: presence.availableCount() });
});

router.get('/ice', (req, res) => res.json({ iceServers: config.iceServers }));

const leadSchema = z.object({
  name: z.string().trim().min(2, 'Please enter your name').max(60).regex(/^[\p{L}\p{M} .'-]+$/u, 'Name can only contain letters'),
  mobile: z.string().trim().regex(/^[6-9]\d{9}$/, 'Enter a valid 10-digit mobile number'),
  state: z.string().trim().min(2, 'Select your state').max(60),
  city: z.string().trim().min(2, 'Select your city').max(60),
  interests: z.array(z.string().trim().max(40)).max(10).default([]),
  storeCode: z.string().trim().max(40).nullish(),
  product: z.string().trim().max(80).nullish(),
  consent: z.literal(true, { errorMap: () => ({ message: 'Please accept the consent to continue' }) }),
});

router.post('/leads', writeLimiter, ah(async (req, res) => {
  const d = leadSchema.parse(req.body);
  let storeId = null;
  if (d.storeCode) {
    const { rows } = await query('SELECT id FROM stores WHERE code = ?', [d.storeCode]);
    storeId = rows[0]?.id || null;
  }
  const id = crypto.randomUUID();
  await query(
    `INSERT INTO leads (id, name, mobile, state, city, interests, store_id, product, consent, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, d.name, d.mobile, d.state, d.city, arr(d.interests), storeId, d.product || null, d.consent, (req.get('user-agent') || '').slice(0, 300)],
  );
  const { rows } = await query('SELECT id, name, mobile, state, city, interests, product, created_at FROM leads WHERE id = ?', [id]);
  calls.notifyAdmins();
  res.status(201).json({ lead: rows[0] });
}));

router.post('/calls', writeLimiter, ah(async (req, res) => {
  const d = z.object({
    leadId: uuid,
    mode: z.enum(MODES),
    language: z.string().trim().min(2).max(30).default('English'),
  }).parse(req.body);

  const { rows: lead } = await query('SELECT id FROM leads WHERE id = ?', [d.leadId]);
  if (!lead[0]) throw new HttpError(404, 'Please fill in your details again');

  // A customer only has one live request at a time
  const { rows: open } = await query("SELECT id FROM calls WHERE lead_id = ? AND status IN ('queued','in_progress')", [d.leadId]);
  for (const c of open) await calls.endCall(c.id, 'replaced_by_new_request');

  const id = crypto.randomUUID();
  const token = crypto.randomBytes(24).toString('hex');
  await query(
    'INSERT INTO calls (id, lead_id, mode, language, customer_token, customer_requests) VALUES (?, ?, ?, ?, ?, ?)',
    [id, d.leadId, d.mode, d.language, token, arr([])],
  );
  const { rows } = await query('SELECT id, mode, language, status, requested_at FROM calls WHERE id = ?', [id]);
  calls.onCallCreated(id);
  res.status(201).json({
    call: rows[0],
    customerToken: token,
    ringTimeoutSec: config.ringTimeoutSec,
    agentsAvailable: presence.availableCount(),
  });
}));

/** Verify the customer token for a call; returns the call row. */
async function customerCall(id, token) {
  uuid.parse(id);
  const { rows } = await query('SELECT id, status, customer_token FROM calls WHERE id = ?', [id]);
  const call = rows[0];
  if (!call || typeof token !== 'string' || !calls.safeEqual(call.customer_token, token)) throw new HttpError(404, 'Call not found');
  return call;
}

router.post('/calls/:id/feedback', writeLimiter, ah(async (req, res) => {
  const d = z.object({
    token: z.string(),
    rating: z.number().int().min(1).max(5),
    comment: z.string().trim().max(500).optional(),
  }).parse(req.body);
  const call = await customerCall(req.params.id, d.token);
  if (call.status !== 'completed') throw new HttpError(400, 'Feedback can be given after the call');
  await query(`UPDATE calls SET rating = ?, feedback = COALESCE(?, feedback), updated_at = now() WHERE id = ?`, [d.rating, d.comment || null, call.id]);
  calls.notifyAdmins();
  res.json({ ok: true });
}));

router.post('/calls/:id/requests', writeLimiter, ah(async (req, res) => {
  const d = z.object({ token: z.string(), type: z.enum(REQUESTS) }).parse(req.body);
  const call = await customerCall(req.params.id, d.token);
  await query(
    `UPDATE calls SET customer_requests = array_append(customer_requests, ?), updated_at = now()
      WHERE id = ? AND NOT (? = ANY(customer_requests))`,
    [d.type, call.id, d.type],
  );
  calls.notifyAdmins();
  res.json({ ok: true });
}));

export default router;
