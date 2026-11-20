-- 003_orders.sql · Payment Gateway scenario tables (SYNTHETIC DEMO data only).
-- A paid-at-Paytm order that the merchant still shows as unpaid, with the Paytm-side transaction
-- and the webhook delivery attempts. No real payment, order or merchant system is involved.

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  generation INTEGER NOT NULL REFERENCES generations(id),
  batch_id TEXT REFERENCES batches(id),
  merchant_id TEXT NOT NULL REFERENCES merchants(id),
  merchant_order_ref TEXT NOT NULL,
  amount_paise INTEGER NOT NULL,
  merchant_status TEXT NOT NULL CHECK (merchant_status IN ('UNPAID','PAID','CANCELLED')),
  created_at TEXT NOT NULL,
  paid_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_orders_merchant ON orders(merchant_id);

-- Paytm-side transaction (what the Transaction Status API reports).
CREATE TABLE IF NOT EXISTS pg_transactions (
  id TEXT PRIMARY KEY,
  generation INTEGER NOT NULL REFERENCES generations(id),
  order_id TEXT NOT NULL REFERENCES orders(id),
  txn_ref TEXT NOT NULL,
  bank_txn_ref TEXT,
  status TEXT NOT NULL CHECK (status IN ('TXN_SUCCESS','PENDING','TXN_FAILURE')),
  resp_code TEXT NOT NULL,
  resp_msg TEXT NOT NULL,
  payment_mode TEXT NOT NULL,
  occurred_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pgtxn_order ON pg_transactions(order_id);

-- Every attempt to tell the merchant about the payment (S2S webhook).
CREATE TABLE IF NOT EXISTS webhook_attempts (
  id TEXT PRIMARY KEY,
  generation INTEGER NOT NULL REFERENCES generations(id),
  order_id TEXT NOT NULL REFERENCES orders(id),
  attempt_no INTEGER NOT NULL,
  trigger TEXT NOT NULL,
  http_status INTEGER NOT NULL,
  error TEXT,
  occurred_at TEXT NOT NULL,
  UNIQUE (order_id, attempt_no)
);

-- Private simulator behaviour: whether the merchant endpoint accepts a resent webhook. Never exposed.
CREATE TABLE IF NOT EXISTS sim_order_behavior (
  order_id TEXT PRIMARY KEY REFERENCES orders(id),
  generation INTEGER NOT NULL,
  resend_works INTEGER NOT NULL DEFAULT 1
);
