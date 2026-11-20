CREATE TABLE sandbox_payment_signals (
  id TEXT PRIMARY KEY,
  generation INTEGER NOT NULL REFERENCES generations(id),
  merchant_id TEXT NOT NULL REFERENCES merchants(id),
  order_ref TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('gateway', 'merchant-order')),
  source_event_id TEXT NOT NULL,
  subject_ref TEXT NOT NULL,
  revision INTEGER NOT NULL,
  actor_id TEXT NOT NULL,
  received_at TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  UNIQUE (generation, source, source_event_id),
  UNIQUE (generation, merchant_id, order_ref, source, subject_ref, revision)
);

CREATE INDEX idx_payment_signals_order
  ON sandbox_payment_signals (generation, merchant_id, order_ref, source, subject_ref, revision DESC);
