import { Router } from 'express';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { query } from '../db/pool.js';
import { ah, HttpError } from '../middleware/error.js';
import { requireAuth, signToken } from '../middleware/auth.js';

const router = Router();

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many login attempts. Try again in a few minutes.' } });

const publicUser = (u) => ({ id: u.id, name: u.name, email: u.email, role: u.role, languages: u.languages });

router.post('/login', loginLimiter, ah(async (req, res) => {
  const { email, password } = z.object({
    email: z.string().trim().email('Enter a valid email'),
    password: z.string().min(1, 'Enter your password'),
  }).parse(req.body);

  const { rows } = await query('SELECT * FROM users WHERE email = LOWER(?)', [email]);
  const user = rows[0];
  if (!user || !(await bcrypt.compare(password, user.password_hash))) throw new HttpError(401, 'Incorrect email or password');
  if (!user.is_active) throw new HttpError(403, 'Your account has been deactivated. Contact your administrator.');

  await query(`UPDATE users SET last_login_at = now() WHERE id = ?`, [user.id]);
  res.json({ token: signToken(user), user: publicUser(user) });
}));

router.get('/me', requireAuth(), (req, res) => res.json({ user: publicUser(req.user) }));

router.post('/change-password', requireAuth(), ah(async (req, res) => {
  const { currentPassword, newPassword } = z.object({
    currentPassword: z.string().min(1),
    newPassword: z.string().min(8, 'New password must be at least 8 characters').max(100),
  }).parse(req.body);

  const { rows } = await query('SELECT password_hash FROM users WHERE id = ?', [req.user.id]);
  if (!(await bcrypt.compare(currentPassword, rows[0].password_hash))) throw new HttpError(400, 'Current password is incorrect');
  await query(`UPDATE users SET password_hash = ?, updated_at = now() WHERE id = ?`, [await bcrypt.hash(newPassword, 10), req.user.id]);
  res.json({ ok: true });
}));

export default router;
