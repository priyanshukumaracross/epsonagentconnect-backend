import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { query } from '../db/pool.js';

export const signToken = (user) =>
  jwt.sign({ sub: user.id, role: user.role }, config.jwtSecret, { expiresIn: config.jwtExpiresIn });

export const verifyToken = (token) => jwt.verify(token, config.jwtSecret);

/**
 * Load an active staff user from a JWT.
 * Returns null only when the token is invalid/expired or the account is gone/deactivated.
 * Database errors are thrown, so a temporary outage is a 500/retry - not a forced logout.
 */
export async function userFromToken(token) {
  let payload;
  try {
    payload = verifyToken(token);
  } catch {
    return null;
  }
  const { rows } = await query(
    'SELECT id, name, email, role, languages, is_active FROM users WHERE id = ?',
    [payload.sub],
  );
  const user = rows[0];
  return user && user.is_active ? user : null;
}

/** Require a logged-in staff member, optionally restricted to roles. Role is read from DB, not the token. */
export function requireAuth(...roles) {
  return async (req, res, next) => {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Please log in' });
    let user;
    try {
      user = await userFromToken(token);
    } catch (err) {
      return next(err);
    }
    if (!user) return res.status(401).json({ error: 'Session expired, please log in again' });
    if (roles.length && !roles.includes(user.role)) return res.status(403).json({ error: 'You do not have access to this' });
    req.user = user;
    next();
  };
}
