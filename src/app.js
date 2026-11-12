import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { config } from './config.js';
import { query } from './db/pool.js';
import authRoutes from './routes/auth.js';
import publicRoutes from './routes/public.js';
import adminRoutes from './routes/admin.js';
import agentRoutes from './routes/agent.js';
import { turnProvider } from './services/ice.js';
import { notFound, errorHandler, ah } from './middleware/error.js';

export function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(helmet());
  app.use(cors({ origin: config.corsOrigins, credentials: true }));
  app.use(express.json({ limit: '100kb' }));
  if (!config.isProd) app.use(morgan('dev'));

  // Lightweight by default (Render health checks shouldn't keep Neon awake); ?db=1 also checks the database.
  app.get('/api/health', ah(async (req, res) => {
    if (req.query.db) await query('SELECT 1');
    res.json({ ok: true, time: new Date().toISOString(), turn: turnProvider() });
  }));

  app.use('/api/auth', authRoutes);
  app.use('/api/public', publicRoutes);
  app.use('/api/admin', adminRoutes);
  app.use('/api/agent', agentRoutes);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
