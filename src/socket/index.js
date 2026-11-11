/**
 * Socket.IO: call queue, presence and WebRTC signaling relay.
 *
 * Customer auth : { callId, customerToken }   (returned by POST /api/public/calls)
 * Staff auth    : { token }                   (JWT from POST /api/auth/login)
 *
 * WebRTC flow
 *   1. customer connects -> waits in room call:<id>
 *   2. agent  -> call:accept {callId}        (server assigns atomically)
 *   3. agent  -> call:ready                  (agent has camera/mic)
 *   4. server -> customer  call:accepted
 *   5. customer creates offer -> signal -> agent answers -> ICE both ways
 */
import { Server } from 'socket.io';
import { config } from '../config.js';
import { query } from '../db/pool.js';
import { userFromToken } from '../middleware/auth.js';
import * as presence from '../services/presence.js';
import * as calls from '../services/calls.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CUSTOMER_GRACE_MS = 10_000; // tolerate short network drops before ending the call

const run = (fn) => Promise.resolve().then(fn).catch((err) => console.error('[socket]', err));

export function initSocket(httpServer) {
  const io = new Server(httpServer, {
    cors: { origin: config.corsOrigins, credentials: true },
    maxHttpBufferSize: 1e5,
  });
  calls.init(io);

  io.use(async (socket, next) => {
    const { token, callId, customerToken } = socket.handshake.auth || {};
    try {
      if (token) {
        const user = await userFromToken(token);
        if (!user) return next(new Error('UNAUTHORIZED'));
        socket.data.kind = 'staff';
        socket.data.user = user;
        return next();
      }
      if (callId && customerToken && UUID_RE.test(callId)) {
        const { rows } = await query('SELECT id, status, customer_token FROM calls WHERE id = ?', [callId]);
        const call = rows[0];
        if (!call || !calls.safeEqual(call.customer_token, customerToken)) return next(new Error('UNAUTHORIZED'));
        if (!['queued', 'in_progress'].includes(call.status)) return next(new Error('CALL_NOT_ACTIVE'));
        socket.data.kind = 'customer';
        socket.data.callId = callId;
        return next();
      }
      next(new Error('UNAUTHORIZED'));
    } catch (err) {
      console.error('[socket auth]', err);
      next(new Error('UNAUTHORIZED'));
    }
  });

  io.on('connection', (socket) => {
    if (socket.data.kind === 'customer') return handleCustomer(io, socket);
    if (socket.data.user.role === 'admin') return handleAdmin(io, socket);
    return handleAgent(io, socket);
  });

  return io;
}

/* ---------------- customer ---------------- */
function handleCustomer(io, socket) {
  const { callId } = socket.data;
  const room = calls.room(callId);
  socket.join(room);

  run(calls.broadcastQueue);
  // Agent may already be ready (customer reconnected / connected late)
  const ready = calls.readyInfo(callId);
  if (ready) socket.emit('call:accepted', { agent: { name: ready.agentName } });

  socket.on('signal', (data) => socket.to(room).emit('signal', data));
  socket.on('call:end', () => run(() => calls.endCall(callId, 'customer_ended')));

  socket.on('disconnect', () => {
    setTimeout(() => run(async () => {
      const others = await io.in(room).fetchSockets();
      if (!others.some((s) => s.data.kind === 'customer')) await calls.endCall(callId, 'customer_disconnected');
    }), CUSTOMER_GRACE_MS);
  });
}

/* ---------------- admin ---------------- */
function handleAdmin(io, socket) {
  socket.join('admins');
  socket.emit('agents:presence', presence.list());
}

/* ---------------- agent ---------------- */
function handleAgent(io, socket) {
  const user = socket.data.user;
  socket.join('agents');
  const me = presence.connect(user, socket.id);
  socket.emit('agent:status', me.status);
  calls.broadcastPresence();
  run(async () => socket.emit('queue:update', await calls.queueSnapshot()));

  const emitStatus = () => {
    const status = presence.get(user.id)?.status || 'away';
    io.to('agents').fetchSockets().then((ss) =>
      ss.filter((s) => s.data.user?.id === user.id).forEach((s) => s.emit('agent:status', status)),
    );
  };

  socket.on('agent:setStatus', (status) => {
    presence.setStatus(user.id, status);
    emitStatus();
    calls.broadcastPresence();
  });

  socket.on('call:accept', (payload, ack = () => {}) => run(async () => {
    const callId = payload?.callId;
    if (!UUID_RE.test(String(callId))) return ack({ error: 'Invalid call' });
    if (presence.get(user.id)?.currentCallId) return ack({ error: 'You are already on a call' });
    const call = await calls.acceptCall(callId, user);
    if (!call) return ack({ error: 'This customer was already picked up by another expert or has left' });
    socket.data.callId = callId;
    socket.join(calls.room(callId));
    emitStatus();
    ack({ call });
  }));

  socket.on('call:ready', () => {
    if (socket.data.callId) calls.markReady(socket.data.callId, user.name);
  });

  socket.on('signal', (data) => {
    if (socket.data.callId) socket.to(calls.room(socket.data.callId)).emit('signal', data);
  });

  socket.on('call:end', () => run(async () => {
    const callId = socket.data.callId;
    socket.data.callId = null;
    await calls.endCall(callId, 'agent_ended');
    emitStatus();
  }));

  socket.on('disconnect', () => run(async () => {
    if (socket.data.callId) await calls.endCall(socket.data.callId, 'agent_disconnected');
    presence.disconnect(user.id, socket.id);
    calls.broadcastPresence();
  }));
}
