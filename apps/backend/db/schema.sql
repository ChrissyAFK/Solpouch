-- Solpouch Tiger Data schema (Postgres + TimescaleDB). Amounts are micro-USDC (bigint).
CREATE EXTENSION IF NOT EXISTS timescaledb;

CREATE TABLE IF NOT EXISTS merchants (
  id        text PRIMARY KEY,
  name      text NOT NULL,
  pay_to    text NOT NULL,
  kind      text NOT NULL CHECK (kind IN ('grocery','food','building_supply','other'))
);

CREATE TABLE IF NOT EXISTS pouches (
  id                    text PRIMARY KEY,
  address               text NOT NULL UNIQUE,
  name                  text NOT NULL,
  max_per_order         bigint NOT NULL,
  daily_limit           bigint NOT NULL,
  confirm_above         bigint NOT NULL DEFAULT 0,
  allowed_merchant_ids  text[] NOT NULL DEFAULT '{}',
  frozen                boolean NOT NULL DEFAULT false,
  created_at            timestamptz NOT NULL DEFAULT now()
);

-- Balance and daily spend live on the pouch row for the app store.
ALTER TABLE pouches ADD COLUMN IF NOT EXISTS balance     bigint NOT NULL DEFAULT 0;
ALTER TABLE pouches ADD COLUMN IF NOT EXISTS spent_today bigint NOT NULL DEFAULT 0;
ALTER TABLE pouches ADD COLUMN IF NOT EXISTS spent_day   date;
ALTER TABLE pouches ADD COLUMN IF NOT EXISTS owner_email text;
CREATE INDEX IF NOT EXISTS pouches_owner_email_idx ON pouches (owner_email);

-- Order lines are stored as JSONB in orders.lines (simple upserts); order_lines below is unused by the app.
CREATE TABLE IF NOT EXISTS orders (
  id            text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  pouch_id      text NOT NULL REFERENCES pouches(id),
  merchant_id   text NOT NULL,
  request       text NOT NULL,
  total         bigint NOT NULL,
  status        text NOT NULL,
  reject_reason text,
  tx_signature  text,
  PRIMARY KEY (id, created_at)
);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS lines jsonb NOT NULL DEFAULT '[]';
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_merchant_id_fkey;
SELECT create_hypertable('orders', 'created_at', if_not_exists => TRUE);

CREATE TABLE IF NOT EXISTS order_lines (
  order_id       text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  line_no        int NOT NULL,
  requested      text NOT NULL,
  requested_qty  int NOT NULL,
  product_id     text,
  qty            int NOT NULL,
  line_total     bigint NOT NULL,
  match_score    real NOT NULL,
  substitution   boolean NOT NULL DEFAULT false,
  note           text,
  PRIMARY KEY (order_id, line_no, created_at)
);
SELECT create_hypertable('order_lines', 'created_at', if_not_exists => TRUE);

CREATE TABLE IF NOT EXISTS topups (
  id          text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  pouch_id    text NOT NULL REFERENCES pouches(id),
  amount      bigint NOT NULL,
  reason      text NOT NULL,
  status      text NOT NULL,
  ready_at    timestamptz NOT NULL,
  PRIMARY KEY (id, created_at)
);
SELECT create_hypertable('topups', 'created_at', if_not_exists => TRUE);

-- Written by the indexer from the program's PaymentMade events (the source of truth).
CREATE TABLE IF NOT EXISTS payments (
  time          timestamptz NOT NULL,
  pouch_id      text NOT NULL,
  merchant_id   text,
  order_id      text NOT NULL,
  amount        bigint NOT NULL,
  tx_signature  text NOT NULL,
  PRIMARY KEY (tx_signature, time)
);
SELECT create_hypertable('payments', 'time', if_not_exists => TRUE);

-- Product price history per merchant catalog snapshot.
CREATE TABLE IF NOT EXISTS prices (
  time         timestamptz NOT NULL,
  merchant_id  text NOT NULL,
  product_id   text NOT NULL,
  unit_price   bigint NOT NULL,
  in_stock     boolean NOT NULL,
  PRIMARY KEY (merchant_id, product_id, time)
);
SELECT create_hypertable('prices', 'time', if_not_exists => TRUE);

-- Spend per pouch per day, maintained incrementally.
CREATE MATERIALIZED VIEW IF NOT EXISTS spend_daily
WITH (timescaledb.continuous) AS
SELECT
  time_bucket('1 day', time) AS bucket,
  pouch_id,
  sum(amount)  AS spent,
  count(*)     AS orders
FROM payments
GROUP BY bucket, pouch_id
WITH NO DATA;

SELECT add_continuous_aggregate_policy('spend_daily',
  start_offset      => INTERVAL '3 days',
  end_offset        => INTERVAL '1 hour',
  schedule_interval => INTERVAL '15 minutes',
  if_not_exists     => TRUE);

-- Compress old payments.
ALTER TABLE payments SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'pouch_id',
  timescaledb.compress_orderby   = 'time DESC'
);
SELECT add_compression_policy('payments', INTERVAL '7 days', if_not_exists => TRUE);

create table if not exists users (
  email text primary key,
  display_name text,
  avatar text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Additive storage-hardening migration. Existing records remain unowned, version 0.
ALTER TABLE pouches ADD COLUMN IF NOT EXISTS version bigint NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS version bigint NOT NULL DEFAULT 0;
ALTER TABLE topups ADD COLUMN IF NOT EXISTS version bigint NOT NULL DEFAULT 0;
ALTER TABLE topups ADD COLUMN IF NOT EXISTS tx_signature text;

-- Regular tables: journals and auth records must have globally unique identifiers.
CREATE TABLE IF NOT EXISTS vault_operations (
  id text PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('pay', 'topup')),
  pouch_id text NOT NULL,
  tx_signature text NOT NULL,
  signed_transaction text NOT NULL,
  last_valid_block_height bigint NOT NULL,
  created_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS rate_limit_buckets (
  key text PRIMARY KEY,
  hits bigint NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS rate_limit_buckets_expiry_idx ON rate_limit_buckets(expires_at);

ALTER TABLE orders ADD COLUMN IF NOT EXISTS store jsonb;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS fulfillment jsonb;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS paid_at timestamptz;
ALTER TABLE topups ADD COLUMN IF NOT EXISTS completed_at timestamptz;
CREATE TABLE IF NOT EXISTS web_sessions (id text PRIMARY KEY,email text NOT NULL,name text NOT NULL,picture text NOT NULL,created_at timestamptz NOT NULL,expires_at timestamptz NOT NULL);
CREATE INDEX IF NOT EXISTS web_sessions_email_idx ON web_sessions(email);
CREATE INDEX IF NOT EXISTS web_sessions_expiry_idx ON web_sessions(expires_at);

-- Chain indexer (src/indexer.ts). Regular tables: every decoded vault event,
-- keyed by (signature, event_index) so replays and backfills are idempotent.
-- PaymentMade events are also written to the payments hypertable above.
CREATE TABLE IF NOT EXISTS vault_events (
  signature     text NOT NULL,
  event_index   int NOT NULL,
  name          text NOT NULL,
  pouch_address text,
  amount        bigint,
  time          timestamptz NOT NULL,
  slot          bigint NOT NULL,
  data          jsonb NOT NULL DEFAULT '{}',
  PRIMARY KEY (signature, event_index)
);
CREATE INDEX IF NOT EXISTS vault_events_pouch_idx ON vault_events (pouch_address, time);
CREATE TABLE IF NOT EXISTS indexer_cursors (
  name       text PRIMARY KEY,
  signature  text NOT NULL,
  slot       bigint NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- Include not-yet-materialized payments so /stats/spend is current.
ALTER MATERIALIZED VIEW spend_daily SET (timescaledb.materialized_only = false);
