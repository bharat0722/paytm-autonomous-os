// Authorized mock execution. One transaction: lease + generation guard, policy and
// approval revalidation, approval consumption, simulator write, per-target outcomes,
// audit, VERIFYING transition and the first verification round.
import type { CoreIncident, CoreRuntime, Job, Sql } from "../../shared/contracts/core.js"
import type { Scope } from "../../shared/contracts/http.js"
import { bindingOf, getApprovalForAction, proposalRevision } from "./approvals.js"
import type { WorkflowOptions } from "./config.js"
import { FIELD_OWNER, SUPPORT_OWNER, transition } from "./machine.js"
import { addAudit, addEscalation, deviceChecks, getAction, latestVerification, saveState, type ActionRow } from "./store.js"
import { FencedError, addMs, guardJob, parseJson, scopeOf, sortedUnique } from "./util.js"

const LABEL: Record<string, string> = {
  MOCK_SYNC_DEVICE_CONFIG: "Mock config sync",
  MOCK_RESTART_DEVICE: "Mock restart",
  LINK_SUPPORT_TICKETS: "Ticket linking",
}

/** Execution-time authorization. Returns a block reason, or null when the effect may run. */
export function authorizeExecution(
  tx: Sql, scope: Scope, incident: CoreIncident, action: ActionRow, now: string,
): { code: string; reason: string } | null {
  const targets = parseJson<string[]>(action.target_ids, [])
  if (incident.card.status !== "ACTION_RUNNING") return { code: "NOT_RUNNING", reason: `Incident is ${incident.card.status}, not ACTION_RUNNING.` }
  const cohort = new Set(incident.devices.map((d) => d.id))
  switch (action.kind) {
    case "MOCK_SYNC_DEVICE_CONFIG":
      if (incident.card.scenario !== "soundbox") return { code: "SCENARIO", reason: "Config sync is only for the Soundbox incident." }
      if (!targets.length || targets.some((t) => !cohort.has(t))) return { code: "TARGET_SCOPE", reason: "Sync targets are outside the frozen cohort." }
      return null
    case "LINK_SUPPORT_TICKETS":
      if (incident.card.scenario !== "duplicate-tickets") return { code: "SCENARIO", reason: "Ticket linking is only for the duplicate-ticket incident." }
      if (targets.length < 2) return { code: "TARGET_SCOPE", reason: "Linking needs a primary and at least one duplicate." }
      return null
    case "MOCK_RESTART_DEVICE": {
      if (incident.card.scenario !== "soundbox") return { code: "SCENARIO", reason: "Restart is only for the Soundbox incident." }
      const approval = getApprovalForAction(tx, action.id)
      if (!approval) return { code: "APPROVAL_MISSING", reason: "No approval exists for this restart." }
      if (approval.generation !== scope.generation || approval.incident_id !== scope.incidentId) return { code: "APPROVAL_SCOPE", reason: "Approval belongs to a different scope." }
      if (approval.status !== "APPROVED") return { code: `APPROVAL_${approval.status}`, reason: `Approval is ${approval.status}, not APPROVED.` }
      if (proposalRevision(bindingOf(approval)) !== approval.proposal_revision) return { code: "APPROVAL_ALTERED", reason: "Approved parameters no longer match their revision." }
      const bound = bindingOf(approval)
      if (sortedUnique(targets).join() !== sortedUnique(bound.targetIds).join()) return { code: "TARGETS_CHANGED", reason: "Action targets differ from the approved targets." }
      if (!approval.decided_at || approval.decided_at >= approval.expires_at) return { code: "APPROVAL_EXPIRED", reason: "Approval was not decided before expiry." }
      for (const id of bound.targetIds) {
        const d = incident.devices.find((x) => x.id === id)
        if (!d) return { code: "TARGET_SCOPE", reason: `Approved target ${id} is no longer in the cohort.` }
        if (d.revision !== bound.targetRevisions[id]) return { code: "TARGET_REVISION_CHANGED", reason: `Device ${id} changed after approval (revision ${bound.targetRevisions[id]} → ${d.revision}).` }
      }
      const latest = latestVerification(tx, scope, { finalOnly: true })
      const unresolved = new Set(latest ? deviceChecks(latest).filter((c) => c.status !== "PASS").map((c) => c.deviceId) : [])
      const resolved = bound.targetIds.filter((id) => !unresolved.has(id))
      if (resolved.length) return { code: "TARGET_NOT_UNRESOLVED", reason: `Targets are not unresolved in the latest verifier snapshot: ${resolved.join(", ")}.` }
      void now
      return null
    }
    default:
      return { code: "DENY_BY_DEFAULT", reason: "Action kind is not on the allowlist." }
  }
}

export function makeExecuteHandler(core: CoreRuntime, options: WorkflowOptions) {
  return async (job: Job): Promise<void> => {
    try {
      core.db.write((tx) => executeTx(core, options, tx, job))
    } catch (err) {
      if (err instanceof FencedError) return
      throw err
    }
  }
}

function executeTx(core: CoreRuntime, options: WorkflowOptions, tx: Sql, job: Job): void {
  guardJob(core, tx, job)
  const scope = scopeOf(job)
  const action = getAction(tx, String(job.payload.actionId ?? ""))
  if (!action || action.generation !== job.generation || action.incident_id !== job.incidentId) return
  // A committed execution already stored its result and follow-ups; replay it.
  if (action.status !== "PROPOSED") return
  const incident = core.incidents.get(tx, scope)
  if (!incident) return
  // Only an approved/authorized run moves the incident to ACTION_RUNNING; any other
  // delivery is stale or unauthorized and must have no effect on the action either.
  if (incident.card.status !== "ACTION_RUNNING") return
  const now = core.clock.now()
  const targets = parseJson<string[]>(action.target_ids, [])
  const label = LABEL[action.kind] ?? action.kind

  const blocked = authorizeExecution(tx, scope, incident, action, now)
  if (blocked) {
    tx.run("UPDATE wf_actions SET status = 'BLOCKED' WHERE id = ? AND status = 'PROPOSED'", [action.id])
    const approval = getApprovalForAction(tx, action.id)
    const auditId = addAudit(tx, scope, `execute:${action.id}:blocked`, {
      at: now, actor: "workflow:executor", event: "EXECUTION_BLOCKED", summary: `${label} blocked (${blocked.code}): ${blocked.reason} No effect was applied.`,
      actionId: action.id, approvalId: approval?.id ?? null,
    })
    if (incident.card.status === "ACTION_RUNNING") {
      const owner = action.kind === "LINK_SUPPORT_TICKETS" ? SUPPORT_OWNER : FIELD_OWNER
      addEscalation(tx, scope, `execute:${action.id}:blocked`, { at: now, reasonCode: blocked.code, summary: blocked.reason, owner, retryable: false, evidenceIds: [] })
      transition(core, tx, scope, incident, {
        to: "ESCALATED", blocker: `${label} blocked: ${blocked.reason}`, owner, mode: "system", stage: "execution",
        reason: `Execution revalidation failed (${blocked.code}).`, opKey: `execute:${action.id}:blocked`, auditId,
      })
      saveState(tx, scope, now, { scenario: incident.card.scenario, phase: "DONE", blockerCode: blocked.code })
    }
    return
  }

  let approvalId: string | null = null
  if (action.kind === "MOCK_RESTART_DEVICE") {
    const approval = getApprovalForAction(tx, action.id)!
    const consumed = tx.run(
      "UPDATE wf_approvals SET status = 'CONSUMED', consumed_at = ?, queued = 1 WHERE id = ? AND status = 'APPROVED'",
      [now, approval.id],
    ).changes
    if (consumed !== 1) return
    approvalId = approval.id
    addAudit(tx, scope, `approval:${approval.id}:consumed`, {
      at: now, actor: "workflow:executor", event: "APPROVAL_CONSUMED", summary: `Approval ${approval.proposal_revision} consumed by one execution.`,
      actionId: action.id, approvalId: approval.id,
    })
  }

  tx.run("UPDATE wf_actions SET status = 'RUNNING' WHERE id = ?", [action.id])
  const results = core.simulation.apply(tx, scope, { actionId: action.id, kind: action.kind, targetIds: targets })
  for (const r of results) {
    tx.run(
      `INSERT OR IGNORE INTO wf_action_targets (action_id, target_id, generation, incident_id, ok, applied_at, prior_sequence, reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [action.id, r.targetId, scope.generation, scope.incidentId, r.ok ? 1 : 0, r.appliedAt, r.priorSequence, r.reason],
    )
  }
  const okCount = results.filter((r) => r.ok).length
  const status = okCount === results.length && results.length > 0 ? "SUCCEEDED" : okCount === 0 ? "FAILED" : "PARTIAL"
  tx.run("UPDATE wf_actions SET status = ?, executed_at = ? WHERE id = ?", [status, now, action.id])
  const auditId = addAudit(tx, scope, `execute:${action.id}:applied`, {
    at: now, actor: "workflow:executor", event: "ACTION_EXECUTED",
    summary: `${label} applied by the simulator to ${okCount}/${results.length} targets (write only; recovery not yet verified).`,
    actionId: action.id, approvalId, evidenceIds: [],
  })
  tx.run("UPDATE wf_actions SET audit_id = COALESCE(audit_id, ?) WHERE id = ?", [auditId, action.id])
  transition(core, tx, scope, incident, {
    to: "VERIFYING", mode: "system", stage: "execution", reason: `${label} executed (${status}); awaiting fresh observations.`,
    opKey: `execute:${action.id}:verifying`, auditId,
  })
  saveState(tx, scope, now, { scenario: incident.card.scenario, phase: action.kind === "MOCK_RESTART_DEVICE" ? "RESTART" : action.kind === "LINK_SUPPORT_TICKETS" ? "LINKING" : "SYNC" })
  core.jobs.enqueue(tx, {
    ...scope, key: `verify:${action.id}:1`, kind: "workflow.verify", runAfter: addMs(now, options.verifyIntervalMs),
    payload: { actionId: action.id, round: 1 },
  })
}
