/**
 * Call lifecycle: queue -> accept -> end, plus realtime broadcasts.
 * Everything that changes a call's status goes through here so the
 * database, agents' queues and the admin dashboard stay in sync.
 */
import crypto from 'node:crypto';
import { query } from '../db/pool.js';
import { config } from '../config.js';
import * as presence from './presence.js';

let io = null;
const ringTimers = new Map(); // callId -> Timeout
const readyCalls = new Map(); // callId -> { agentName } (agent has media ready, customer should send offer)

export const room = (callId) => `call:${callId}`;

export function init(socketServer) {
  io = socketServer;
}

export function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/* ---------------- broadcasts ---------------- */

export function notifyAdmins(event = 'calls:changed', payload = {}) {
  io?.to('admins').emit(event, payload);
}

export function broadcastPresence() {
  io?.to('admins').emit('agents:presence', presence.list());
}

export async function queueSnapshot() {
  const { rows } = await query(
    `SELECT c.id, c.mode, c.language, c.requested_at,
            l.name AS customer_name, l.city, l.state, l.product, l.interests,
            s.name AS store_name
       FROM calls c
       JOIN leads l ON l.id = c.lead_id
  LEFT JOIN stores s ON s.id = l.store_id
      WHERE c.status = 'queued'
   ORDER BY c.requested_at ASC`,
  );
  return rows;
}

export async function broadcastQueue() {
  if (!io) return;
  const queue = await queueSnapshot();
  io.to('agents').emit('queue:update', queue);
  queue.forEach((c, i) => io.to(room(c.id)).emit('queue:position', { position: i + 1, total: queue.length }));
}

const safe = (fn) => fn().catch((err) => console.error('[calls]', err));

/* ---------------- lifecycle ---------------- */

export function onCallCreated(callId) {
  clearTimeout(ringTimers.get(callId));
  ringTimers.set(callId, setTimeout(() => safe(() => markMissed(callId)), config.ringTimeoutSec * 1000));
  safe(broadcastQueue);
  notifyAdmins();
}

export async function markMissed(callId) {
  ringTimers.delete(callId);
  const { affectedRows } = await query(
    `UPDATE calls SET status = 'missed', ended_at = NOW(3), end_reason = 'no_agent_answered', updated_at = NOW(3)
      WHERE id = ? AND status = 'queued'`,
    [callId],
  );
  if (!affectedRows) return;
  io?.to(room(callId)).emit('call:missed');
  io?.in(room(callId)).socketsLeave(room(callId));
  await broadcastQueue();
  notifyAdmins();
}

/** Atomically assign a queued call to an agent. Returns call + lead details, or null if it was taken. */
export async function acceptCall(callId, agent) {
  const { affectedRows } = await query(
    `UPDATE calls SET status = 'in_progress', agent_id = ?, accepted_at = NOW(3), updated_at = NOW(3)
      WHERE id = ? AND status = 'queued'`,
    [agent.id, callId],
  );
  if (!affectedRows) return null;

  clearTimeout(ringTimers.get(callId));
  ringTimers.delete(callId);
  presence.setBusy(agent.id, callId);

  const { rows: details } = await query(
    `SELECT c.id, c.mode, c.language, c.requested_at, c.accepted_at,
            l.id AS lead_id, l.name AS customer_name, l.mobile, l.city, l.state, l.product, l.interests,
            s.name AS store_name, s.code AS store_code,
            (SELECT COUNT(*) FROM calls p WHERE p.lead_id = l.id AND p.status = 'completed') AS previous_calls
       FROM calls c JOIN leads l ON l.id = c.lead_id LEFT JOIN stores s ON s.id = l.store_id
      WHERE c.id = ?`,
    [callId],
  );

  await broadcastQueue();
  broadcastPresence();
  notifyAdmins();
  return details[0];
}

/** Agent has local media ready: tell the customer so it can start WebRTC negotiation. */
export function markReady(callId, agentName) {
  readyCalls.set(callId, { agentName });
  io?.to(room(callId)).emit('call:accepted', { agent: { name: agentName } });
}

export const readyInfo = (callId) => readyCalls.get(callId);

/**
 * End a call from any state. queued -> cancelled, in_progress -> completed. Idempotent.
 * (MySQL evaluates SET left-to-right, so duration/ended_at are computed before status changes.)
 */
export async function endCall(callId, reason) {
  if (!callId) return null;
  const { affectedRows } = await query(
    `UPDATE calls
        SET duration_seconds = CASE WHEN accepted_at IS NOT NULL
                                    THEN GREATEST(0, TIMESTAMPDIFF(SECOND, accepted_at, NOW(3))) END,
            ended_at = NOW(3),
            status = CASE WHEN status = 'in_progress' THEN 'completed' ELSE 'cancelled' END,
            end_reason = ?,
            updated_at = NOW(3)
      WHERE id = ? AND status IN ('queued', 'in_progress')`,
    [reason, callId],
  );
  clearTimeout(ringTimers.get(callId));
  ringTimers.delete(callId);
  readyCalls.delete(callId);
  if (!affectedRows) return null;

  const { rows } = await query('SELECT id, status, agent_id, duration_seconds FROM calls WHERE id = ?', [callId]);
  const call = rows[0];

  io?.to(room(callId)).emit('call:ended', { status: call.status, duration: call.duration_seconds, reason });
  if (call.agent_id) {
    presence.setFree(call.agent_id);
    const sockets = (await io?.in('agents').fetchSockets()) || [];
    sockets.filter((s) => s.data.user?.id === call.agent_id).forEach((s) => s.emit('agent:status', 'available'));
  }
  io?.in(room(callId)).socketsLeave(room(callId));

  await broadcastQueue();
  broadcastPresence();
  notifyAdmins();
  return call;
}

/** On boot, close calls left open by a previous process (their sockets are gone). */
export async function recoverStaleCalls() {
  const { affectedRows: q } = await query(
    `UPDATE calls SET status = 'failed', ended_at = NOW(3), end_reason = 'server_restart', updated_at = NOW(3)
      WHERE status = 'queued'`,
  );
  const { affectedRows: p } = await query(
    `UPDATE calls SET status = 'completed', ended_at = COALESCE(ended_at, NOW(3)), end_reason = 'server_restart', updated_at = NOW(3)
      WHERE status = 'in_progress'`,
  );
  if (q || p) console.log(`[calls] recovered ${q} queued and ${p} in-progress calls after restart`);
}

/** Force-disconnect all sockets of a user (e.g. after deactivation). */
export async function disconnectUser(userId) {
  if (!io) return;
  const sockets = await io.fetchSockets();
  sockets.filter((s) => s.data?.user?.id === userId).forEach((s) => s.disconnect(true));
}
