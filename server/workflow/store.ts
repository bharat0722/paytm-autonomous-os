// Owner 02 persistence. Only workflow (wf_*) tables are written here; core tables
// change exclusively through CoreRuntime ports.
import type { Sql } from "../../shared/contracts/core.js"
import type {
  ActionKind, ActionView, ApprovalStatus, AuditEntry, DeviceCheck, Finding, Mode, Scope, TraceEntry,
} from "../../shared/contracts/http.js"
import { opaqueId, parseJson } from "./util.js"

export type Phase =
  | "TRIAGE" | "SYNC" | "RESTART_PROPOSAL" | "AWAITING_APPROVAL" | "RESTART" | "LINKING" | "DONE"

export interface StateRow {
  generation: number; incident_id: string; scenario: string; phase: Phase; version: number;
  blocker_code: string | null; retryable: number; updated_at: string;
}

export function getState(q: Sql, scope: Scope): StateRow | undefined {
  return q.get<StateRow>("SELECT * FROM wf_state WHERE generation = ? AND incident_id = ?", [scope.generation, scope.incidentId])
}

/** Upserts the per-incident checkpoint and bumps its version. Returns the new version. */
export function saveState(
  tx: Sql, scope: Scope, at: string,
  change: { scenario: string; phase: Phase; blockerCode?: string | null; retryable?: boolean },
): number {
  tx.run(
    `INSERT INTO wf_state (generation, incident_id, scenario, phase, version, blocker_code, retryable, updated_at)
     VALUES (?, ?, ?, ?, 1, ?, ?, ?)
     ON CONFLICT (generation, incident_id) DO UPDATE SET
       phase = excluded.phase, version = wf_state.version + 1, blocker_code = excluded.blocker_code,
       retryable = excluded.retryable, updated_at = excluded.updated_at`,
    [scope.generation, scope.incidentId, change.scenario, change.phase, change.blockerCode ?? null,
      change.retryable ? 1 : 0, at],
  )
  return getState(tx, scope)!.version
}

// ---------------------------------------------------------------------------
// Trace and audit (idempotent by op_key)
// ---------------------------------------------------------------------------
export function addTrace(
  tx: Sql, scope: Scope, opKey: string,
  entry: { at: string; mode: Mode; stage: string; summary: string; tool?: string | null; evidenceIds?: string[]; auditId?: string | null },
): string {
  const id = opaqueId("trc", scope.generation, scope.incidentId, opKey)
  tx.run(
    `INSERT OR IGNORE INTO wf_trace (id, generation, incident_id, op_key, at, mode, stage, summary, tool, evidence_ids, audit_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, scope.generation, scope.incidentId, opKey, entry.at, entry.mode, entry.stage, entry.summary,
      entry.tool ?? null, JSON.stringify(entry.evidenceIds ?? []), entry.auditId ?? null],
  )
  return id
}

export function addAudit(
  tx: Sql, scope: Scope, opKey: string,
  entry: { at: string; actor: string; event: string; summary: string; actionId?: string | null; approvalId?: string | null; evidenceIds?: string[] },
): string {
  const id = opaqueId("aud", scope.generation, scope.incidentId, opKey)
  tx.run(
    `INSERT OR IGNORE INTO wf_audit (id, generation, incident_id, op_key, at, actor, event, summary, action_id, approval_id, evidence_ids)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, scope.generation, scope.incidentId, opKey, entry.at, entry.actor, entry.event, entry.summary,
      entry.actionId ?? null, entry.approvalId ?? null, JSON.stringify(entry.evidenceIds ?? [])],
  )
  return id
}

interface TraceRow {
  id: string; at: string; mode: Mode; stage: string; summary: string; tool: string | null; evidence_ids: string; audit_id: string | null
}
export function listTrace(q: Sql, scope: Scope): TraceEntry[] {
  return q.all<TraceRow>(
    "SELECT * FROM wf_trace WHERE generation = ? AND incident_id = ? ORDER BY at, rowid",
    [scope.generation, scope.incidentId],
  ).map((r) => ({
    id: r.id, at: r.at, mode: r.mode, stage: r.stage, summary: r.summary, tool: r.tool,
    evidenceIds: parseJson<string[]>(r.evidence_ids, []), auditId: r.audit_id,
  }))
}

interface AuditRow {
  id: string; at: string; actor: string; event: string; summary: string; action_id: string | null; approval_id: string | null; evidence_ids: string
}
export function listAudit(q: Sql, scope: Scope): AuditEntry[] {
  return q.all<AuditRow>(
    "SELECT * FROM wf_audit WHERE generation = ? AND incident_id = ? ORDER BY at, rowid",
    [scope.generation, scope.incidentId],
  ).map((r) => ({
    id: r.id, at: r.at, actor: r.actor, event: r.event, summary: r.summary, actionId: r.action_id,
    approvalId: r.approval_id, evidenceIds: parseJson<string[]>(r.evidence_ids, []),
  }))
}

// ---------------------------------------------------------------------------
// Episodes, steps and retrieved evidence
// ---------------------------------------------------------------------------
export interface EpisodeRow {
  id: string; generation: number; incident_id: string; episode_key: string; stage: string; mode: Mode;
  mode_reason: string | null; turns_used: number; steps_used: number; active_ms: number; status: string;
  outcome: string | null; started_at: string; finished_at: string | null;
}
export function getEpisode(q: Sql, id: string): EpisodeRow | undefined {
  return q.get<EpisodeRow>("SELECT * FROM wf_episodes WHERE id = ?", [id])
}
export function ensureEpisode(
  tx: Sql, scope: Scope, key: string, init: { stage: string; mode: Mode; modeReason: string | null; at: string },
): EpisodeRow {
  const id = opaqueId("eps", scope.generation, scope.incidentId, key)
  tx.run(
    `INSERT OR IGNORE INTO wf_episodes (id, generation, incident_id, episode_key, stage, mode, mode_reason, status, started_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'RUNNING', ?)`,
    [id, scope.generation, scope.incidentId, key, init.stage, init.mode, init.modeReason, init.at],
  )
  return getEpisode(tx, id)!
}

export interface StepRow { step_no: number; mode: Mode; step_json: string; result_json: string }
export function listSteps(q: Sql, episodeId: string): StepRow[] {
  return q.all<StepRow>("SELECT step_no, mode, step_json, result_json FROM wf_steps WHERE episode_id = ? ORDER BY step_no", [episodeId])
}

export interface RetrievedRow { evidence_id: string; kind: string; record_json: string }
export function listRetrieved(q: Sql, episodeId: string): RetrievedRow[] {
  return q.all<RetrievedRow>("SELECT evidence_id, kind, record_json FROM wf_retrieved WHERE episode_id = ? ORDER BY rowid", [episodeId])
}

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------
interface FindingRow {
  observations: string; hypothesis: string | null; evidence_ids: string; uncertainty: string; missing_evidence: string
}
export function saveFinding(tx: Sql, scope: Scope, episodeId: string, at: string, mode: Mode, f: Finding): void {
  tx.run(
    `INSERT OR IGNORE INTO wf_findings (id, generation, incident_id, episode_id, at, mode, observations, hypothesis, evidence_ids, uncertainty, missing_evidence)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [opaqueId("fnd", scope.generation, scope.incidentId, episodeId), scope.generation, scope.incidentId, episodeId, at, mode,
      JSON.stringify(f.observations), f.hypothesis, JSON.stringify(f.evidenceIds), f.uncertainty, JSON.stringify(f.missingEvidence)],
  )
}
export function latestFinding(q: Sql, scope: Scope): Finding | null {
  const r = q.get<FindingRow>(
    "SELECT * FROM wf_findings WHERE generation = ? AND incident_id = ? ORDER BY at DESC, rowid DESC LIMIT 1",
    [scope.generation, scope.incidentId],
  )
  if (!r) return null
  return {
    observations: parseJson<string[]>(r.observations, []), hypothesis: r.hypothesis,
    evidenceIds: parseJson<string[]>(r.evidence_ids, []), uncertainty: r.uncertainty,
    missingEvidence: parseJson<string[]>(r.missing_evidence, []),
  }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------
export interface ActionRow {
  id: string; generation: number; incident_id: string; op_key: string; kind: ActionKind; target_ids: string; args: string;
  status: ActionView["status"]; rule_id: string; summary: string; requires_approval: number; evidence_ids: string;
  audit_id: string | null; created_at: string; executed_at: string | null;
}
export function actionId(scope: Scope, opKey: string): string {
  return opaqueId("act", scope.generation, scope.incidentId, opKey)
}
export function getAction(q: Sql, id: string): ActionRow | undefined {
  return q.get<ActionRow>("SELECT * FROM wf_actions WHERE id = ?", [id])
}
export function getActionByKey(q: Sql, scope: Scope, opKey: string): ActionRow | undefined {
  return q.get<ActionRow>("SELECT * FROM wf_actions WHERE generation = ? AND incident_id = ? AND op_key = ?", [scope.generation, scope.incidentId, opKey])
}
export function listActions(q: Sql, scope: Scope): ActionRow[] {
  return q.all<ActionRow>("SELECT * FROM wf_actions WHERE generation = ? AND incident_id = ? ORDER BY created_at, rowid", [scope.generation, scope.incidentId])
}
/** Inserts an action under its stable operation key. Returns false if this intent already exists. */
export function insertAction(
  tx: Sql, scope: Scope,
  a: { opKey: string; kind: ActionKind; targetIds: string[]; args: Record<string, unknown>; ruleId: string; summary: string;
    requiresApproval: boolean; evidenceIds: string[]; auditId: string | null; at: string },
): { id: string; created: boolean } {
  const id = actionId(scope, a.opKey)
  const r = tx.run(
    `INSERT OR IGNORE INTO wf_actions (id, generation, incident_id, op_key, kind, target_ids, args, status, rule_id, summary, requires_approval, evidence_ids, audit_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'PROPOSED', ?, ?, ?, ?, ?, ?)`,
    [id, scope.generation, scope.incidentId, a.opKey, a.kind, JSON.stringify(a.targetIds), JSON.stringify(a.args), a.ruleId,
      a.summary, a.requiresApproval ? 1 : 0, JSON.stringify(a.evidenceIds), a.auditId, a.at],
  )
  return { id, created: r.changes === 1 }
}
export function toActionView(r: ActionRow): ActionView {
  return {
    id: r.id, kind: r.kind, targetIds: parseJson<string[]>(r.target_ids, []), args: parseJson<Record<string, unknown>>(r.args, {}),
    status: r.status, ruleId: r.rule_id, summary: r.summary, auditId: r.audit_id,
  }
}

export interface ActionTargetRow {
  action_id: string; target_id: string; ok: number; applied_at: string; prior_sequence: number; reason: string | null
}
export function listActionTargets(q: Sql, scope: Scope): ActionTargetRow[] {
  return q.all<ActionTargetRow>(
    "SELECT * FROM wf_action_targets WHERE generation = ? AND incident_id = ? ORDER BY applied_at, rowid",
    [scope.generation, scope.incidentId],
  )
}

// ---------------------------------------------------------------------------
// Verification snapshots
// ---------------------------------------------------------------------------
export interface VerificationRow {
  id: string; action_id: string; round: number; final: number; checked_at: string; cutoff: string; total: number;
  before_recovered: number; recovered: number; remaining: string; devices: string; workflow_version: number
}
export function latestVerification(q: Sql, scope: Scope, opts: { finalOnly?: boolean } = {}): VerificationRow | undefined {
  return q.get<VerificationRow>(
    `SELECT * FROM wf_verifications WHERE generation = ? AND incident_id = ? ${opts.finalOnly ? "AND final = 1" : ""}
     ORDER BY checked_at DESC, rowid DESC LIMIT 1`,
    [scope.generation, scope.incidentId],
  )
}
export function deviceChecks(r: VerificationRow): DeviceCheck[] {
  return parseJson<DeviceCheck[]>(r.devices, [])
}

// ---------------------------------------------------------------------------
// Escalations
// ---------------------------------------------------------------------------
export function addEscalation(
  tx: Sql, scope: Scope, opKey: string,
  e: { at: string; reasonCode: string; summary: string; owner: string; retryable: boolean; evidenceIds: string[] },
): void {
  tx.run(
    `INSERT OR IGNORE INTO wf_escalations (id, generation, incident_id, op_key, at, reason_code, summary, owner, retryable, evidence_ids)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [opaqueId("esc", scope.generation, scope.incidentId, opKey), scope.generation, scope.incidentId, opKey, e.at,
      e.reasonCode, e.summary, e.owner, e.retryable ? 1 : 0, JSON.stringify(e.evidenceIds)],
  )
}

export type { ApprovalStatus }
