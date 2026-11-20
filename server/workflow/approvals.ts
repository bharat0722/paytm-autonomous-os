// Restricted approvals: bound to immutable normalized parameters, decided once in a
// conditional transaction, expired durably on the server clock.
import type { CoreIncident, CoreRuntime, Job, Sql } from "../../shared/contracts/core.js"
import type { Actor, ApprovalDecision, ApprovalStatus, ApprovalView, DecisionResult, Scope } from "../../shared/contracts/http.js"
import { FIELD_OWNER, transition } from "./machine.js"
import { canDecideApproval } from "./policy.js"
import { addAudit, addEscalation, addProcessLog, saveState } from "./store.js"
import { FencedError, WorkflowError, addMs, assertActiveGeneration, guardJob, opaqueId, parseJson, scopeOf, sha256, stableJson } from "./util.js"

export interface ApprovalRow {
  id: string; generation: number; incident_id: string; action_id: string; kind: "MOCK_RESTART_DEVICE";
  proposal_revision: string; target_ids: string; target_revisions: string; args: string; rule_id: string;
  checkpoint: string; status: ApprovalStatus; created_at: string; expires_at: string; decided_at: string | null;
  decided_by: string | null; decision: "approve" | "reject" | null; reason: string | null; queued: number;
  consumed_at: string | null; evidence_ids: string; rationale: string; impact: string; expected_check: string;
}

export interface ApprovalBinding {
  generation: number; incidentId: string; actionId: string; kind: "MOCK_RESTART_DEVICE";
  targetIds: string[]; targetRevisions: Record<string, string>; args: Record<string, unknown>; checkpoint: string;
}

/** The proposal revision is a hash over every bound parameter; any change produces a different revision. */
export function proposalRevision(b: ApprovalBinding): string {
  return `rev_${sha256(stableJson({ ...b, targetIds: [...b.targetIds].sort() })).slice(0, 20)}`
}

export function bindingOf(r: ApprovalRow): ApprovalBinding {
  return {
    generation: r.generation, incidentId: r.incident_id, actionId: r.action_id, kind: r.kind,
    targetIds: parseJson<string[]>(r.target_ids, []), targetRevisions: parseJson<Record<string, string>>(r.target_revisions, {}),
    args: parseJson<Record<string, unknown>>(r.args, {}), checkpoint: r.checkpoint,
  }
}

export function getApproval(q: Sql, id: string): ApprovalRow | undefined {
  return q.get<ApprovalRow>("SELECT * FROM wf_approvals WHERE id = ?", [id])
}
export function getApprovalForAction(q: Sql, actionId: string): ApprovalRow | undefined {
  return q.get<ApprovalRow>("SELECT * FROM wf_approvals WHERE action_id = ?", [actionId])
}
export function countRestartApprovals(q: Sql, scope: Scope): number {
  return q.get<{ n: number }>("SELECT COUNT(*) AS n FROM wf_approvals WHERE generation = ? AND incident_id = ?", [scope.generation, scope.incidentId])?.n ?? 0
}

/** Read model: a pending approval past its server-clock expiry is reported as EXPIRED. */
export function approvalView(r: ApprovalRow, now: string): ApprovalView {
  const status: ApprovalStatus = r.status === "PENDING" && now >= r.expires_at ? "EXPIRED" : r.status
  return {
    id: r.id, incidentId: r.incident_id, actionId: r.action_id, kind: r.kind, proposalRevision: r.proposal_revision,
    targetDeviceIds: parseJson<string[]>(r.target_ids, []), args: parseJson<Record<string, unknown>>(r.args, {}),
    ruleId: r.rule_id, status, createdAt: r.created_at, expiresAt: r.expires_at, decidedAt: r.decided_at,
    decidedBy: r.decided_by, reason: r.reason, evidenceIds: parseJson<string[]>(r.evidence_ids, []),
    rationale: r.rationale, impact: r.impact, expectedCheck: r.expected_check,
  }
}

export function listApprovals(q: Sql, generation: number, incidentId?: string): ApprovalRow[] {
  return incidentId
    ? q.all<ApprovalRow>("SELECT * FROM wf_approvals WHERE generation = ? AND incident_id = ? ORDER BY created_at, rowid", [generation, incidentId])
    : q.all<ApprovalRow>("SELECT * FROM wf_approvals WHERE generation = ? ORDER BY created_at DESC, rowid DESC", [generation])
}

export function countPending(q: Sql, generation: number, now: string): number {
  return q.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM wf_approvals WHERE generation = ? AND status = 'PENDING' AND expires_at > ?",
    [generation, now],
  )?.n ?? 0
}

export function createRestartApproval(
  core: CoreRuntime, tx: Sql, scope: Scope, incident: CoreIncident,
  p: { actionId: string; targetIds: string[]; checkpoint: string; ruleId: string; rationale: string; evidenceIds: string[]; ttlMs: number; recoveredBefore: number; total: number },
): ApprovalRow {
  const now = core.clock.now()
  const revisions: Record<string, string> = {}
  for (const id of p.targetIds) {
    const d = incident.devices.find((x) => x.id === id)
    if (!d) throw new WorkflowError(409, "WORKFLOW_CONFLICT", `Target ${id} is outside the cohort.`)
    revisions[id] = d.revision
  }
  const binding: ApprovalBinding = {
    generation: scope.generation, incidentId: scope.incidentId, actionId: p.actionId, kind: "MOCK_RESTART_DEVICE",
    targetIds: [...p.targetIds].sort(), targetRevisions: revisions, args: { mode: "mock", restartType: "soft" }, checkpoint: p.checkpoint,
  }
  const id = opaqueId("apr", scope.generation, scope.incidentId, p.actionId)
  const expiresAt = addMs(now, p.ttlMs)
  tx.run(
    `INSERT OR IGNORE INTO wf_approvals (id, generation, incident_id, action_id, kind, proposal_revision, target_ids, target_revisions, args, rule_id,
       checkpoint, status, created_at, expires_at, evidence_ids, rationale, impact, expected_check)
     VALUES (?, ?, ?, ?, 'MOCK_RESTART_DEVICE', ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, ?, ?, ?, ?)`,
    [id, scope.generation, scope.incidentId, p.actionId, proposalRevision(binding), JSON.stringify(binding.targetIds),
      JSON.stringify(revisions), JSON.stringify(binding.args), p.ruleId, p.checkpoint, now, expiresAt,
      JSON.stringify(p.evidenceIds), p.rationale,
      `Mock restart of exactly ${binding.targetIds.length} synthetic Soundbox devices (${binding.targetIds.join(", ")}). No other device is touched; no real device or financial system is involved.`,
      `Verifier requires fresh heartbeat, config and notification-probe passes for the restarted devices after execution; resolution only at ${p.total}/${p.total} (currently ${p.recoveredBefore}/${p.total}).`],
  )
  const row = getApproval(tx, id)!
  core.jobs.enqueue(tx, {
    generation: scope.generation, incidentId: scope.incidentId, key: `expire:${id}`, kind: "workflow.expire",
    runAfter: row.expires_at, payload: { approvalId: id },
  })
  return row
}

const ACTOR = (a: Actor) => `${a.role}:${a.id}`

/**
 * Decide an approval. The actor comes from the established session; the role is
 * rechecked here. Concurrent decisions resolve with one conditional update.
 */
export function decideApproval(
  core: CoreRuntime, actor: Actor | null, generation: number, approvalId: string, body: ApprovalDecision,
): DecisionResult {
  const outcome = core.db.write((tx): DecisionResult | "EXPIRED" => {
    assertActiveGeneration(core, tx, generation)
    const auth = canDecideApproval(actor)
    if (!auth.allowed || !actor) throw new WorkflowError(actor ? 403 : 401, actor ? "FORBIDDEN" : "UNAUTHENTICATED", auth.reason)
    const row = getApproval(tx, approvalId)
    if (!row || row.generation !== generation) throw new WorkflowError(404, "NOT_FOUND", "Approval not found in the current generation.")
    const scope: Scope = { generation, incidentId: row.incident_id }
    const now = core.clock.now()

    if (row.status !== "PENDING") {
      const identical = row.decision === body.decision && row.proposal_revision === body.proposalRevision
      if (identical) return { generation, approval: approvalView(row, now), queued: row.queued === 1 }
      if (row.status === "EXPIRED") throw new WorkflowError(409, "APPROVAL_EXPIRED", "This approval expired. No action was taken.")
      throw new WorkflowError(409, "APPROVAL_CONFLICT", `This approval was already ${row.status.toLowerCase()}.`)
    }
    if (body.proposalRevision !== row.proposal_revision || proposalRevision(bindingOf(row)) !== row.proposal_revision) {
      throw new WorkflowError(409, "APPROVAL_CONFLICT", "The proposal changed since it was shown. Refresh and review the current request.")
    }
    if (now >= row.expires_at) {
      // Commit the expiry (and its escalation) before reporting the error.
      expireApprovalTx(core, tx, row)
      return "EXPIRED"
    }

    const incident = core.incidents.get(tx, scope)
    if (!incident) throw new WorkflowError(404, "NOT_FOUND", "Incident not found in the current generation.")
    if (incident.card.status !== "APPROVAL_PENDING") {
      throw new WorkflowError(409, "APPROVAL_CONFLICT", `The incident is ${incident.card.status}; this approval can no longer be decided.`)
    }

    const status: ApprovalStatus = body.decision === "approve" ? "APPROVED" : "REJECTED"
    const reason = body.reason?.trim() ? body.reason.trim().slice(0, 500) : null
    const changed = tx.run(
      `UPDATE wf_approvals SET status = ?, decision = ?, decided_at = ?, decided_by = ?, reason = ?, queued = ?
       WHERE id = ? AND status = 'PENDING' AND proposal_revision = ?`,
      [status, body.decision, now, ACTOR(actor), reason, body.decision === "approve" ? 1 : 0, row.id, row.proposal_revision],
    ).changes
    if (changed !== 1) throw new WorkflowError(409, "APPROVAL_CONFLICT", "Another decision was recorded first.")

    const targets = parseJson<string[]>(row.target_ids, [])
    if (body.decision === "approve") {
      const auditId = addAudit(tx, scope, `approval:${row.id}:approved`, {
        at: now, actor: ACTOR(actor), event: "APPROVAL_APPROVED", summary: `Approved mock restart of ${targets.length} devices (${row.proposal_revision}).`,
        actionId: row.action_id, approvalId: row.id, evidenceIds: parseJson<string[]>(row.evidence_ids, []),
      })
      transition(core, tx, scope, incident, {
        to: "ACTION_RUNNING", mode: "system", stage: "approval", reason: `Approved by ${actor.role}; restart queued.`,
        opKey: `approval:${row.id}:approved`, auditId,
      })
      saveState(tx, scope, now, { scenario: incident.card.scenario, phase: "RESTART" })
      addProcessLog(tx, scope, `approval:${row.id}:decided`, {
        at: now, stepId: "approve", kind: "decision", system: "Approval Center", method: "DECIDE", endpoint: `/approvals/${row.id}/decision`,
        request: { decision: "approve", proposalRevision: row.proposal_revision, by: actor.role, reason },
        response: { status: "APPROVED", targets: targets.length, singleUse: true, expiresAt: row.expires_at },
        httpStatus: 200, outcome: "OK", summary: `Approved by the ${actor.role} for exactly ${targets.length} devices. The restart is queued once.`,
        actionId: row.action_id, evidenceIds: parseJson<string[]>(row.evidence_ids, []),
      })
      core.jobs.enqueue(tx, {
        generation, incidentId: row.incident_id, key: `execute:${row.action_id}`, kind: "workflow.execute",
        runAfter: now, payload: { actionId: row.action_id, approvalId: row.id },
      })
    } else {
      const auditId = addAudit(tx, scope, `approval:${row.id}:rejected`, {
        at: now, actor: ACTOR(actor), event: "APPROVAL_REJECTED", summary: `Rejected mock restart of ${targets.length} devices.${reason ? ` Reason: ${reason}` : ""}`,
        actionId: row.action_id, approvalId: row.id,
      })
      tx.run("UPDATE wf_actions SET status = 'BLOCKED' WHERE id = ? AND status = 'PROPOSED'", [row.action_id])
      const blocker = `Restart rejected by approver; ${targets.length} devices remain unresolved. No automatic reproposal.`
      addEscalation(tx, scope, `approval:${row.id}:rejected`, { at: now, reasonCode: "APPROVAL_REJECTED", summary: blocker, owner: FIELD_OWNER, retryable: false, evidenceIds: [] })
      transition(core, tx, scope, incident, {
        to: "ESCALATED", blocker, owner: FIELD_OWNER, mode: "system", stage: "approval", reason: "Restart rejected.",
        opKey: `approval:${row.id}:rejected`, auditId,
      })
      saveState(tx, scope, now, { scenario: incident.card.scenario, phase: "DONE", blockerCode: "APPROVAL_REJECTED" })
      addProcessLog(tx, scope, `approval:${row.id}:decided`, {
        at: now, stepId: "approve", kind: "decision", system: "Approval Center", method: "DECIDE", endpoint: `/approvals/${row.id}/decision`,
        request: { decision: "reject", proposalRevision: row.proposal_revision, by: actor.role, reason },
        response: { status: "REJECTED", executed: false }, httpStatus: 200, outcome: "BLOCKED",
        summary: `Rejected by the ${actor.role}. The restart will never run.`, actionId: row.action_id,
      })
    }
    return { generation, approval: approvalView(getApproval(tx, row.id)!, now), queued: body.decision === "approve" }
  })
  if (outcome === "EXPIRED") throw new WorkflowError(409, "APPROVAL_EXPIRED", "This approval expired. No action was taken.")
  return outcome
}

/** Marks a pending, past-expiry approval EXPIRED and escalates the incident. Idempotent. */
function expireApprovalTx(core: CoreRuntime, tx: Sql, row: ApprovalRow): boolean {
  const now = core.clock.now()
  const changed = tx.run(
    "UPDATE wf_approvals SET status = 'EXPIRED', decided_at = ? WHERE id = ? AND status = 'PENDING' AND expires_at <= ?",
    [now, row.id, now],
  ).changes
  if (changed !== 1) return false
  const scope: Scope = { generation: row.generation, incidentId: row.incident_id }
  tx.run("UPDATE wf_actions SET status = 'BLOCKED' WHERE id = ? AND status = 'PROPOSED'", [row.action_id])
  const auditId = addAudit(tx, scope, `approval:${row.id}:expired`, {
    at: now, actor: "system:expiry", event: "APPROVAL_EXPIRED", summary: `Approval expired at ${row.expires_at} without a decision.`,
    actionId: row.action_id, approvalId: row.id,
  })
  addProcessLog(tx, scope, `approval:${row.id}:expired`, {
    at: now, stepId: "approve", kind: "decision", system: "Approval Center", method: "EXPIRE", endpoint: `/approvals/${row.id}`,
    request: { expiresAt: row.expires_at }, response: { status: "EXPIRED", executed: false }, httpStatus: null, outcome: "BLOCKED",
    summary: "No one decided before the approval expired. The restart will never run.", actionId: row.action_id,
  })
  const incident = core.incidents.get(tx, scope)
  if (incident?.card.status === "APPROVAL_PENDING") {
    const blocker = "Restart approval expired without a decision; devices remain unresolved. No automatic reproposal."
    addEscalation(tx, scope, `approval:${row.id}:expired`, { at: now, reasonCode: "APPROVAL_EXPIRED", summary: blocker, owner: FIELD_OWNER, retryable: false, evidenceIds: [] })
    transition(core, tx, scope, incident, {
      to: "ESCALATED", blocker, owner: FIELD_OWNER, mode: "system", stage: "approval", reason: "Approval expired.",
      opKey: `approval:${row.id}:expired`, auditId,
    })
    saveState(tx, scope, now, { scenario: incident.card.scenario, phase: "DONE", blockerCode: "APPROVAL_EXPIRED" })
  }
  return true
}

export function makeExpireHandler(core: CoreRuntime) {
  return async (job: Job): Promise<void> => {
    const approvalId = String(job.payload.approvalId ?? "")
    try {
      core.db.write((tx) => {
        guardJob(core, tx, job)
        const row = getApproval(tx, approvalId)
        if (!row || row.generation !== job.generation || row.status !== "PENDING") return
        if (core.clock.now() < row.expires_at) {
          // Delivered early (clock skew): reschedule durably.
          core.jobs.enqueue(tx, { ...scopeOf(job), key: `expire:${row.id}:retry:${job.attempt}`, kind: "workflow.expire", runAfter: row.expires_at, payload: { approvalId } })
          return
        }
        expireApprovalTx(core, tx, row)
      })
    } catch (err) {
      if (err instanceof FencedError) return
      throw err
    }
  }
}
