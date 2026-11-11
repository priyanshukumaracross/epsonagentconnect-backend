-- Epson Expert Connect - PostgreSQL schema (local development on Neon). Idempotent: safe to re-run.
-- Production uses MySQL: see schema.mysql.sql (same tables and columns).
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Staff: admins and agents (product experts)
CREATE TABLE IF NOT EXISTS users (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name           TEXT NOT NULL,
  email          TEXT NOT NULL UNIQUE,
  password_hash  TEXT NOT NULL,
  role           TEXT NOT NULL CHECK (role IN ('admin', 'agent')),
  languages      TEXT[] NOT NULL DEFAULT '{English}',
  is_active      BOOLEAN NOT NULL DEFAULT TRUE,
  last_login_at  TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Retail stores where QR codes are placed
CREATE TABLE IF NOT EXISTS stores (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code             TEXT NOT NULL UNIQUE,
  name             TEXT NOT NULL,
  city             TEXT,
  state            TEXT,
  default_product  TEXT,
  is_active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Customers who filled the form after scanning a QR code
CREATE TABLE IF NOT EXISTS leads (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  mobile      TEXT NOT NULL,
  state       TEXT NOT NULL,
  city        TEXT NOT NULL,
  interests   TEXT[] NOT NULL DEFAULT '{}',
  store_id    UUID REFERENCES stores(id) ON DELETE SET NULL,
  product     TEXT,
  consent     BOOLEAN NOT NULL DEFAULT FALSE,
  user_agent  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_leads_created_at ON leads (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_leads_mobile     ON leads (mobile);
CREATE INDEX IF NOT EXISTS idx_leads_store      ON leads (store_id);

-- Every call attempt from a lead (statuses: see schema.mysql.sql)
CREATE TABLE IF NOT EXISTS calls (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id            UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  agent_id           UUID REFERENCES users(id) ON DELETE SET NULL,
  mode               TEXT NOT NULL CHECK (mode IN ('video', 'voice')),
  language           TEXT NOT NULL DEFAULT 'English',
  status             TEXT NOT NULL DEFAULT 'queued'
                     CHECK (status IN ('queued', 'in_progress', 'completed', 'missed', 'cancelled', 'failed')),
  customer_token     TEXT NOT NULL,
  requested_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  accepted_at        TIMESTAMPTZ,
  ended_at           TIMESTAMPTZ,
  duration_seconds   INTEGER,
  end_reason         TEXT,
  rating             SMALLINT CHECK (rating BETWEEN 1 AND 5),
  feedback           TEXT,
  outcome            TEXT CHECK (outcome IN ('interested', 'purchased', 'follow_up', 'not_interested', 'support', 'other')),
  agent_notes        TEXT,
  customer_requests  TEXT[] NOT NULL DEFAULT '{}',
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_calls_status       ON calls (status);
CREATE INDEX IF NOT EXISTS idx_calls_requested_at ON calls (requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_calls_agent        ON calls (agent_id);
CREATE INDEX IF NOT EXISTS idx_calls_lead         ON calls (lead_id);
