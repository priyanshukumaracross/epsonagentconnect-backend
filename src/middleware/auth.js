import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { query } from '../db/pool.js';

export const signToken = (user) =>
  jwt.sign({ sub: user.id, role: user.role }, config.jwtSecret, { expiresIn: config.jwtExpiresIn });

export const verifyToken = (token) => jwt.verify(token, config.jwtSecret);

/** Load an active staff user from a JWT. Returns null when invalid. */
export async function userFromToken(token) {
  try {
    const payload = verifyToken(token);
    const { rows } = await query(
      'SELECT id, name, email, role, languages, is_active FROM users WHERE id = ?',
      [payload.sub],
    );
    const user = rows[0];
    return user && user.is_active ? user : null;
  } catch {
    return null;
  }
}

/** Require a logged-in staff member, optionally restricted to roles. Role is read from DB, not the token. */
export function requireAuth(...roles) {
  return async (req, res, next) => {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Please log in' });
    const user = await userFromToken(token);
    if (!user) return res.status(401).json({ error: 'Session expired, please log in again' });
    if (roles.length && !roles.includes(user.role)) return res.status(403).json({ error: 'You do not have access to this' });
    req.user = user;
    next();
  };
}
