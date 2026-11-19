-- Owner 02 · Workflow tables (Merchant Reliability OS · SYNTHETIC DEMO)
-- Every record carries generation + incident_id. Statements are idempotent so
-- the workflow module can also ensure its schema at startup.

-- Per-incident workflow checkpoint (phase + monotonically increasing version).
CREATE TABLE IF NOT EXISTS wf_state (
  generation   INTEGER NOT NULL,
  incident_id  TEXT    NOT NULL,
  scenario     TEXT    NOT NULL,
  phase        TEXT    NOT NULL,
  version      INTEGER NOT NULL DEFAULT 0,
  blocker_code TEXT,
  retryable    INTEGER NOT NULL DEFAULT 0,
  updated_at   TEXT    NOT NULL,
  PRIMARY KEY (generation, incident_id)
);

-- One investigator episode per investigate job key. Consumed budget survives lease recovery.
CREATE TABLE IF NOT EXISTS wf_episodes (
  id           TEXT    PRIMARY KEY,
  generation   INTEGER NOT NULL,
  incident_id  TEXT    NOT NULL,
  episode_key  TEXT    NOT NULL,
  stage        TEXT    NOT NULL,
  mode         TEXT    NOT NULL,
  mode_reason  TEXT,
  turns_used   INTEGER NOT NULL DEFAULT 0,
  steps_used   INTEGER NOT NULL DEFAULT 0,
  active_ms    INTEGER NOT NULL DEFAULT 0,
  status       TEXT    NOT NULL,
  outcome      TEXT,
  started_at   TEXT    NOT NULL,
  finished_at  TEXT,
  UNIQUE (generation, incident_id, episode_key)
);

-- Validated steps (never raw model output or reasoning) used to resume an episode.
CREATE TABLE IF NOT EXISTS wf_steps (
  episode_id   TEXT    NOT NULL,
  step_no      INTEGER NOT NULL,
  generation   INTEGER NOT NULL,
  incident_id  TEXT    NOT NULL,
  mode         TEXT    NOT NULL,
  step_json    TEXT    NOT NULL,
  result_json  TEXT    NOT NULL,
  PRIMARY KEY (episode_id, step_no)
);

-- Evidence IDs actually returned by a tool in an episode. Citations must come from here.
CREATE TABLE IF NOT EXISTS wf_retrieved (
  episode_id   TEXT    NOT NULL,
  evidence_id  TEXT    NOT NULL,
  generation   INTEGER NOT NULL,
  incident_id  TEXT    NOT NULL,
  kind         TEXT    NOT NULL,
  record_json  TEXT    NOT NULL,
  PRIMARY KEY (episode_id, evidence_id)
);

CREATE TABLE IF NOT EXISTS wf_trace (
  id           TEXT    PRIMARY KEY,
  generation   INTEGER NOT NULL,
  incident_id  TEXT    NOT NULL,
  op_key       TEXT    NOT NULL,
  at           TEXT    NOT NULL,
  mode         TEXT    NOT NULL,
  stage        TEXT    NOT NULL,
  summary      TEXT    NOT NULL,
  tool         TEXT,
  evidence_ids TEXT    NOT NULL DEFAULT '[]',
  audit_id     TEXT,
  UNIQUE (generation, incident_id, op_key)
);

CREATE TABLE IF NOT EXISTS wf_findings (
  id               TEXT    PRIMARY KEY,
  generation       INTEGER NOT NULL,
  incident_id      TEXT    NOT NULL,
  episode_id       TEXT    NOT NULL UNIQUE,
  at               TEXT    NOT NULL,
  mode             TEXT    NOT NULL,
  observations     TEXT    NOT NULL,
  hypothesis       TEXT,
  evidence_ids     TEXT    NOT NULL,
  uncertainty      TEXT    NOT NULL,
  missing_evidence TEXT    NOT NULL
);

-- One action per workflow intent: (generation, incident_id, op_key) is the stable operation key.
CREATE TABLE IF NOT EXISTS wf_actions (
  id                TEXT    PRIMARY KEY,
  generation        INTEGER NOT NULL,
  incident_id       TEXT    NOT NULL,
  op_key            TEXT    NOT NULL,
  kind              TEXT    NOT NULL,
  target_ids        TEXT    NOT NULL,
  args              TEXT    NOT NULL,
  status            TEXT    NOT NULL,
  rule_id           TEXT    NOT NULL,
  summary           TEXT    NOT NULL,
  requires_approval INTEGER NOT NULL DEFAULT 0,
  evidence_ids      TEXT    NOT NULL DEFAULT '[]',
  audit_id          TEXT,
  created_at        TEXT    NOT NULL,
  executed_at       TEXT,
  UNIQUE (generation, incident_id, op_key)
);

-- Per-target simulator outcome of a committed execution (the replayable result).
CREATE TABLE IF NOT EXISTS wf_action_targets (
  action_id      TEXT    NOT NULL,
  target_id      TEXT    NOT NULL,
  generation     INTEGER NOT NULL,
  incident_id    TEXT    NOT NULL,
  ok             INTEGER NOT NULL,
  applied_at     TEXT    NOT NULL,
  prior_sequence INTEGER NOT NULL,
  reason         TEXT,
  PRIMARY KEY (action_id, target_id)
);

CREATE TABLE IF NOT EXISTS wf_approvals (
  id                TEXT    PRIMARY KEY,
  generation        INTEGER NOT NULL,
  incident_id       TEXT    NOT NULL,
  action_id         TEXT    NOT NULL UNIQUE,
  kind              TEXT    NOT NULL,
  proposal_revision TEXT    NOT NULL,
  target_ids        TEXT    NOT NULL,
  target_revisions  TEXT    NOT NULL,
  args              TEXT    NOT NULL,
  rule_id           TEXT    NOT NULL,
  checkpoint        TEXT    NOT NULL,
  status            TEXT    NOT NULL,
  created_at        TEXT    NOT NULL,
  expires_at        TEXT    NOT NULL,
  decided_at        TEXT,
  decided_by        TEXT,
  decision          TEXT,
  reason            TEXT,
  queued            INTEGER NOT NULL DEFAULT 0,
  consumed_at       TEXT,
  evidence_ids      TEXT    NOT NULL,
  rationale         TEXT    NOT NULL,
  impact            TEXT    NOT NULL,
  expected_check    TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS wf_approvals_scope ON wf_approvals (generation, status, expires_at);

CREATE TABLE IF NOT EXISTS wf_verifications (
  id               TEXT    PRIMARY KEY,
  generation       INTEGER NOT NULL,
  incident_id      TEXT    NOT NULL,
  action_id        TEXT    NOT NULL,
  round            INTEGER NOT NULL,
  final            INTEGER NOT NULL,
  checked_at       TEXT    NOT NULL,
  cutoff           TEXT    NOT NULL,
  total            INTEGER NOT NULL,
  before_recovered INTEGER NOT NULL,
  recovered        INTEGER NOT NULL,
  remaining        TEXT    NOT NULL,
  devices          TEXT    NOT NULL,
  workflow_version INTEGER NOT NULL,
  UNIQUE (generation, action_id, round)
);

CREATE TABLE IF NOT EXISTS wf_escalations (
  id           TEXT    PRIMARY KEY,
  generation   INTEGER NOT NULL,
  incident_id  TEXT    NOT NULL,
  op_key       TEXT    NOT NULL,
  at           TEXT    NOT NULL,
  reason_code  TEXT    NOT NULL,
  summary      TEXT    NOT NULL,
  owner        TEXT    NOT NULL,
  retryable    INTEGER NOT NULL DEFAULT 0,
  evidence_ids TEXT    NOT NULL DEFAULT '[]',
  UNIQUE (generation, incident_id, op_key)
);

CREATE TABLE IF NOT EXISTS wf_audit (
  id           TEXT    PRIMARY KEY,
  generation   INTEGER NOT NULL,
  incident_id  TEXT    NOT NULL,
  op_key       TEXT    NOT NULL,
  at           TEXT    NOT NULL,
  actor        TEXT    NOT NULL,
  event        TEXT    NOT NULL,
  summary      TEXT    NOT NULL,
  action_id    TEXT,
  approval_id  TEXT,
  evidence_ids TEXT    NOT NULL DEFAULT '[]',
  UNIQUE (generation, incident_id, op_key)
);
