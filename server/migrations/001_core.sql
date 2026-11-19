-- 001_core.sql · Owner 01 core tables. SYNTHETIC DEMO data only.
-- Every operational row carries `generation`; IDs are opaque and unique across generations.
-- Core FK keys exposed to 010_workflow.sql:
--   generations(id), incidents(id), devices(id), merchants(id), tickets(id), jobs(id)

CREATE TABLE generations (
  id INTEGER PRIMARY KEY,
  created_at TEXT NOT NULL,
  archived_at TEXT,
  telemetry_seq INTEGER NOT NULL DEFAULT 0,
  telemetry_clock TEXT NOT NULL
);

CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Demo sessions persist so a browser session survives an app restart.
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('operator','approver')),
  csrf_token TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE merchants (
  id TEXT PRIMARY KEY,
  generation INTEGER NOT NULL REFERENCES generations(id),
  seed_ref TEXT NOT NULL,
  name TEXT NOT NULL,
  city TEXT NOT NULL,
  category TEXT NOT NULL,
  UNIQUE (generation, seed_ref)
);

CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  generation INTEGER NOT NULL REFERENCES generations(id),
  seed_ref TEXT NOT NULL,
  merchant_id TEXT NOT NULL REFERENCES merchants(id),
  model TEXT NOT NULL,
  config_version TEXT NOT NULL,
  firmware TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  restarted_at TEXT,
  UNIQUE (generation, seed_ref)
);
CREATE INDEX idx_devices_merchant ON devices(merchant_id);

-- Private simulator behaviour. Never exposed through evidence or tools.
CREATE TABLE sim_device_behavior (
  device_id TEXT PRIMARY KEY REFERENCES devices(id),
  generation INTEGER NOT NULL,
  needs_restart INTEGER NOT NULL DEFAULT 0,
  restart_fails INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE batches (
  id TEXT PRIMARY KEY,
  generation INTEGER NOT NULL REFERENCES generations(id),
  scenario TEXT NOT NULL,
  variant TEXT NOT NULL,
  created_at TEXT NOT NULL,
  incident_id TEXT,
  UNIQUE (generation, scenario)
);

CREATE TABLE device_events (
  id TEXT PRIMARY KEY,
  generation INTEGER NOT NULL REFERENCES generations(id),
  batch_id TEXT REFERENCES batches(id),
  device_id TEXT NOT NULL REFERENCES devices(id),
  kind TEXT NOT NULL,
  error_signature TEXT,
  occurred_at TEXT NOT NULL
);
CREATE INDEX idx_events_batch ON device_events(batch_id);

CREATE TABLE payments (
  id TEXT PRIMARY KEY,
  generation INTEGER NOT NULL REFERENCES generations(id),
  merchant_id TEXT NOT NULL REFERENCES merchants(id),
  device_id TEXT REFERENCES devices(id),
  amount_paise INTEGER NOT NULL,
  method TEXT NOT NULL,
  status TEXT NOT NULL,
  occurred_at TEXT NOT NULL
);
CREATE INDEX idx_payments_merchant ON payments(merchant_id);

CREATE TABLE tickets (
  id TEXT PRIMARY KEY,
  generation INTEGER NOT NULL REFERENCES generations(id),
  batch_id TEXT REFERENCES batches(id),
  seed_ref TEXT NOT NULL,
  merchant_id TEXT NOT NULL REFERENCES merchants(id),
  device_id TEXT REFERENCES devices(id),
  category TEXT NOT NULL,
  subject TEXT NOT NULL,
  status TEXT NOT NULL,
  linked_to TEXT REFERENCES tickets(id),
  created_at TEXT NOT NULL,
  UNIQUE (generation, seed_ref)
);
CREATE INDEX idx_tickets_merchant ON tickets(merchant_id);

-- Settlements are READ-ONLY for every port. No financial mutation path exists.
CREATE TABLE settlements (
  id TEXT PRIMARY KEY,
  generation INTEGER NOT NULL REFERENCES generations(id),
  batch_id TEXT REFERENCES batches(id),
  merchant_id TEXT NOT NULL REFERENCES merchants(id),
  settlement_date TEXT NOT NULL,
  gross_paise INTEGER NOT NULL,
  fees_paise INTEGER NOT NULL,
  expected_paise INTEGER NOT NULL,
  settled_paise INTEGER NOT NULL,
  bank_ref TEXT NOT NULL,
  status TEXT NOT NULL,
  occurred_at TEXT NOT NULL
);
CREATE INDEX idx_settlements_merchant ON settlements(merchant_id);

CREATE TABLE incidents (
  id TEXT PRIMARY KEY,
  generation INTEGER NOT NULL REFERENCES generations(id),
  batch_id TEXT NOT NULL REFERENCES batches(id),
  scenario TEXT NOT NULL,
  title TEXT NOT NULL,
  severity TEXT NOT NULL,
  status TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  owner TEXT,
  blocker TEXT,
  correlation_json TEXT NOT NULL,
  verified_check_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_incidents_generation ON incidents(generation);

-- Frozen cohort roster at incident creation.
CREATE TABLE incident_devices (
  incident_id TEXT NOT NULL REFERENCES incidents(id),
  device_id TEXT NOT NULL REFERENCES devices(id),
  merchant_id TEXT NOT NULL REFERENCES merchants(id),
  revision_at_freeze INTEGER NOT NULL,
  PRIMARY KEY (incident_id, device_id)
);

-- Every linked source record (device, device_event, ticket, payment, settlement, merchant).
CREATE TABLE incident_evidence (
  incident_id TEXT NOT NULL REFERENCES incidents(id),
  kind TEXT NOT NULL,
  record_id TEXT NOT NULL,
  PRIMARY KEY (incident_id, kind, record_id)
);

CREATE TABLE observations (
  id TEXT PRIMARY KEY,
  generation INTEGER NOT NULL REFERENCES generations(id),
  device_id TEXT NOT NULL REFERENCES devices(id),
  action_id TEXT,
  sequence INTEGER NOT NULL,
  occurred_at TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('heartbeat','config','notification_probe')),
  passed INTEGER NOT NULL,
  UNIQUE (generation, sequence),
  UNIQUE (action_id, device_id, kind)
);
CREATE INDEX idx_observations_device ON observations(device_id, sequence);

-- Idempotent record of simulated effects (one row per action target).
CREATE TABLE sim_applied (
  action_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  incident_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  ok INTEGER NOT NULL,
  applied_at TEXT NOT NULL,
  prior_sequence INTEGER NOT NULL,
  reason TEXT,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY (action_id, target_id)
);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  generation INTEGER NOT NULL REFERENCES generations(id),
  incident_id TEXT NOT NULL,
  key TEXT NOT NULL,
  kind TEXT NOT NULL,
  run_after TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING','LEASED','DONE','FAILED','CANCELLED')),
  attempt INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT,
  lease_expires_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (generation, key)
);
CREATE INDEX idx_jobs_claim ON jobs(status, run_after);
