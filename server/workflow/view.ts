import type { CoreRuntime, Sql } from "../../shared/contracts/core.js"
import type { RecoveryView, Scope, WorkflowView } from "../../shared/contracts/http.js"
import { approvalView, countPending, listApprovals } from "./approvals.js"
import { deviceChecks, latestFinding, latestVerification, listActions, listAudit, listTrace, toActionView } from "./store.js"
import { parseJson } from "./util.js"

export function recoveryView(q: Sql, scope: Scope): RecoveryView | null {
  // Prefer the latest final snapshot; an interim round is shown only while it is the newest evidence.
  const latest = latestVerification(q, scope)
  if (!latest) return null
  return {
    id: latest.id, checkedAt: latest.checked_at, total: latest.total, beforeRecovered: latest.before_recovered,
    recovered: latest.recovered, remainingDeviceIds: parseJson<string[]>(latest.remaining, []), devices: deviceChecks(latest),
  }
}

export function getIncidentWorkflow(core: CoreRuntime, q: Sql, scope: Scope): WorkflowView {
  const now = core.clock.now()
  return {
    finding: latestFinding(q, scope),
    trace: listTrace(q, scope),
    audit: listAudit(q, scope),
    actions: listActions(q, scope).map(toActionView),
    approvals: listApprovals(q, scope.generation, scope.incidentId).map((r) => approvalView(r, now)),
    recovery: recoveryView(q, scope),
  }
}

export function countPendingApprovals(core: CoreRuntime, q: Sql, generation: number): number {
  return countPending(q, generation, core.clock.now())
}
