// PRD §13 endpoints: POST /incidents/:id/actions and POST /incidents/:id/verify.
// Neither ever executes an effect directly. Actions run only through the investigator
// (low-risk, policy-checked) or an approved, single-use approval (restricted). Recovery
// is decided only by the verifier; /verify can just queue a fresh, verifier-owned check.
import type { Actor, ActionRequestResult, VerifyResult } from "../../shared/contracts/http.js"
import type { CoreRuntime } from "../../shared/contracts/core.js"
import { approvalView, listApprovals } from "./approvals.js"
import { requireIncident } from "./machine.js"
import { RULES } from "./policy.js"
import { addAudit, listActions } from "./store.js"
import { recoveryView } from "./view.js"
import { WorkflowError, assertActiveGeneration, randomId, sortedUnique } from "./util.js"

const FINANCIAL = /SETTLEMENT|REFUND|PAYOUT|PAYMENT|LEDGER|ADJUST|TRANSFER|REVERSAL|BALANCE/i
const LOW_RISK = new Set(["MOCK_SYNC_DEVICE_CONFIG", "LINK_SUPPORT_TICKETS"])

export class PolicyDenied extends WorkflowError {
  constructor(readonly ruleId: string, message: string, readonly auditId: string) {
    super(403, "POLICY_DENIED", `${ruleId}: ${message}`)
  }
}

export function requestAction(
  core: CoreRuntime, actor: Actor | null, generation: number, incidentId: string, body: { kind: string; targetIds?: string[] },
): ActionRequestResult {
  // Denials must leave an audit record, so the transaction commits first and the error is thrown after.
  const outcome = core.db.write((tx) => {
    assertActiveGeneration(core, tx, generation)
    if (!actor) throw new WorkflowError(401, "UNAUTHENTICATED", "Sign in to request an action.")
    const scope = { generation, incidentId }
    const incident = requireIncident(core, tx, scope)
    const now = core.clock.now()
    const kind = body.kind.toUpperCase()
    const who = `${actor.role}:${actor.id}`
    const audit = (event: string, summary: string, approvalId: string | null = null) =>
      addAudit(tx, scope, `action-request:${randomId("req")}`, { at: now, actor: who, event, summary, approvalId })
    const base = { generation, incidentId, kind }

    if (FINANCIAL.test(kind)) {
      const auditId = audit("ACTION_REQUEST_DENIED", `Denied ${kind}: financial mutation is never available to this workflow.`)
      return { denied: { ruleId: RULES.NO_FINANCIAL, message: "Financial changes are human-led and outside demo write permissions.", auditId } }
    }
    if (kind === "MOCK_RESTART_DEVICE") {
      if (incident.card.scenario !== "soundbox") {
        const auditId = audit("ACTION_REQUEST_DENIED", "Denied restart: only the Soundbox incident has devices.")
        return { denied: { ruleId: RULES.DENY, message: "Restart applies only to the Soundbox incident.", auditId } }
      }
      const approvals = listApprovals(tx, generation, incidentId).map((r) => approvalView(r, now))
      const pending = approvals.find((a) => a.status === "PENDING")
      const used = approvals.find((a) => a.status === "APPROVED" || a.status === "CONSUMED")
      const requested = sortedUnique(body.targetIds ?? [])
      if (pending) {
        const mismatch = requested.length > 0 && requested.join() !== sortedUnique(pending.targetDeviceIds).join()
        const auditId = audit("ACTION_REQUEST_PENDING", `Restart requested; it can run only after approval ${pending.id} is decided by an approver.` +
          (mismatch ? " Requested targets differ from the approval and will not be used." : ""), pending.id)
        return { result: { ...base, path: "APPROVAL_PENDING" as const, approvalId: pending.id, auditId,
          decision: { allowed: false, requiresApproval: true, ruleId: RULES.RESTART, reason: `Awaiting human approval ${pending.id} for ${pending.targetDeviceIds.length} exact devices.` } } }
      }
      if (used) {
        const auditId = audit("ACTION_REQUEST_DENIED", `Restart already ${used.status.toLowerCase()} under approval ${used.id}; approvals are single-use.`, used.id)
        return { result: { ...base, path: "ALREADY_EXECUTED" as const, approvalId: used.id, auditId,
          decision: { allowed: false, requiresApproval: true, ruleId: RULES.NO_REPROPOSAL, reason: "The single-use approval was already used; no second restart." } } }
      }
      const auditId = audit("ACTION_REQUEST_DENIED", "Denied restart: no approved request exists. The investigator proposes restarts only after verified partial recovery.")
      return { denied: { ruleId: RULES.RESTART, message: "No approved restart request exists for this incident.", auditId } }
    }
    if (LOW_RISK.has(kind)) {
      const executed = listActions(tx, scope).find((a) => a.kind === kind && a.status !== "PROPOSED")
      const auditId = audit("ACTION_REQUEST_ROUTED", `${kind} is low-risk and owned by the investigator after it reads the evidence; no manual execution.`)
      return { result: { ...base, path: executed ? "ALREADY_EXECUTED" as const : "INVESTIGATOR_OWNED" as const, approvalId: null, auditId,
        decision: { allowed: true, requiresApproval: false, ruleId: kind === "LINK_SUPPORT_TICKETS" ? RULES.LINK : RULES.SYNC,
          reason: executed ? `Already executed by the investigator (${executed.status}).` : "Allowed by policy; the investigator executes it with evidence." } } }
    }
    const auditId = audit("ACTION_REQUEST_DENIED", `Denied ${kind.slice(0, 64)}: not on the allowlist.`)
    return { denied: { ruleId: RULES.DENY, message: `Action ${kind.slice(0, 64)} is not on the allowlist.`, auditId } }
  })
  if ("denied" in outcome && outcome.denied) throw new PolicyDenied(outcome.denied.ruleId, outcome.denied.message, outcome.denied.auditId)
  return (outcome as { result: ActionRequestResult }).result
}

export function requestVerify(core: CoreRuntime, actor: Actor | null, generation: number, incidentId: string): VerifyResult {
  return core.db.write((tx) => {
    assertActiveGeneration(core, tx, generation)
    if (!actor) throw new WorkflowError(401, "UNAUTHENTICATED", "Sign in to request verification.")
    const scope = { generation, incidentId }
    const incident = requireIncident(core, tx, scope)
    const now = core.clock.now()
    let queued = false
    if (incident.card.status === "VERIFYING") {
      const latest = listActions(tx, scope).filter((a) => a.executed_at).sort((a, b) => String(a.executed_at).localeCompare(String(b.executed_at))).pop()
      if (latest) {
        const round = 100 + incident.card.version
        core.jobs.enqueue(tx, { ...scope, key: `verify:${latest.id}:${round}`, kind: "workflow.verify", runAfter: now, payload: { actionId: latest.id, round } })
        queued = true
      }
    }
    addAudit(tx, scope, `verify-request:v${incident.card.version}:${actor.id}`, {
      at: now, actor: `${actor.role}:${actor.id}`, event: "VERIFICATION_REQUESTED",
      summary: queued ? "A fresh verifier check was queued." : `No new check needed (${incident.card.status}); returning the verifier's latest saved result.`,
    })
    return { generation, incidentId, status: incident.card.status, queued, recovery: recoveryView(tx, scope) }
  })
}
