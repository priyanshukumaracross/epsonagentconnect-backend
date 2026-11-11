/**
 * In-memory presence of connected agents.
 * (For multi-instance deployments, move this to Redis together with the socket.io redis adapter.)
 *
 * status: 'available' | 'away' | 'busy'
 */
const agents = new Map(); // agentId -> { id, name, languages, sockets:Set, status, currentCallId, since }

export function connect(user, socketId) {
  let a = agents.get(user.id);
  if (!a) {
    a = { id: user.id, name: user.name, languages: user.languages, sockets: new Set(), status: 'available', currentCallId: null, since: Date.now() };
    agents.set(user.id, a);
  }
  a.sockets.add(socketId);
  return a;
}

/** Returns true when the agent has no more open sockets (fully offline). */
export function disconnect(userId, socketId) {
  const a = agents.get(userId);
  if (!a) return true;
  a.sockets.delete(socketId);
  if (a.sockets.size === 0) {
    agents.delete(userId);
    return true;
  }
  return false;
}

export const get = (id) => agents.get(id);

export function setStatus(id, status) {
  const a = agents.get(id);
  if (!a || a.currentCallId) return a;
  a.status = status === 'away' ? 'away' : 'available';
  a.since = Date.now();
  return a;
}

export function setBusy(id, callId) {
  const a = agents.get(id);
  if (a) Object.assign(a, { status: 'busy', currentCallId: callId, since: Date.now() });
}

export function setFree(id) {
  const a = agents.get(id);
  if (a) Object.assign(a, { status: 'available', currentCallId: null, since: Date.now() });
}

export function list() {
  return [...agents.values()].map(({ sockets, ...rest }) => rest);
}

export const availableCount = () => [...agents.values()].filter((a) => a.status === 'available').length;
export const onlineCount = () => agents.size;
