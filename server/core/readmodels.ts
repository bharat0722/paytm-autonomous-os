// Read models built from persisted state (dashboard and incident detail).
import { EMPTY_WORKFLOW, type AuditView, type DashboardView, type IncidentView, type Scope, type WorkflowView } from "../../shared/contracts/http.js"
import type { Sql, WorkflowModule } from "../../shared/contracts/core.js"
import { readAllEvidence } from "./evidence.js"
import { detectionEntries, groupingView } from "./grouping.js"
import { incidentProfile, incidentSignals } from "./profile.js"
import { getIncident, linkedMerchantIds, listIncidentCards } from "./incidents.js"

/** Workflow view with the persisted detection entry first in both trace and audit (FR-08). */
export function workflowFor(q: Sql, workflow: WorkflowModule | null, scope: Scope): WorkflowView {
  const wf = workflow ? workflow.getIncidentWorkflow(q, scope) : { ...EMPTY_WORKFLOW, trace: [], audit: [], actions: [], approvals: [] }
  const detection = detectionEntries(q, scope)
  if (!detection) return wf
  return {
    ...wf,
    trace: [detection.trace, ...wf.trace.filter((t) => t.id !== detection.trace.id)],
    audit: [detection.audit, ...wf.audit.filter((a) => a.id !== detection.audit.id)]
  }
}

export function incidentView(q: Sql, workflow: WorkflowModule | null, scope: Scope): IncidentView | null {
  const inc = getIncident(q, scope)
  if (!inc) return null
  return {
    generation: scope.generation, incident: inc.card, evidence: readAllEvidence(q, scope),
    blocker: inc.blocker, owner: inc.owner, workflow: workflowFor(q, workflow, scope),
    grouping: groupingView(q, scope),
    profile: incidentProfile(q, scope),
    signals: incidentSignals(q, scope)
  }
}

export function auditView(q: Sql, workflow: WorkflowModule | null, scope: Scope): AuditView | null {
  if (!getIncident(q, scope)) return null
  return { generation: scope.generation, incidentId: scope.incidentId, audit: workflowFor(q, workflow, scope).audit }
}

/** Currently affected merchants: the latest verifier snapshot when present, else the frozen cohort. */
function currentlyAffected(q: Sql, incidentId: string, wf: WorkflowView): string[] {
  if (wf.recovery) {
    const remaining = wf.recovery.remainingDeviceIds
    if (!remaining.length) return []
    const ph = remaining.map(() => "?").join(",")
    return q.all<{ merchant_id: string }>(`SELECT DISTINCT merchant_id FROM devices WHERE id IN (${ph})`, remaining).map((r) => r.merchant_id)
  }
  return linkedMerchantIds(q, incidentId)
}

export function dashboardView(q: Sql, workflow: WorkflowModule | null, generation: number): DashboardView {
  const cards = listIncidentCards(q, generation)
  const affected = new Set<string>()
  const activity: DashboardView["activity"] = []
  let active = 0
  let resolved = 0
  for (const card of cards) {
    const wf = workflowFor(q, workflow, { generation, incidentId: card.id })
    for (const t of wf.trace) activity.push({ ...t, incidentId: card.id })
    if (card.status === "RESOLVED") { resolved++; continue }
    if (card.status === "TASK_COMPLETED") continue
    active++
    for (const m of currentlyAffected(q, card.id, wf)) affected.add(m)
  }
  activity.sort((a, b) => b.at.localeCompare(a.at))
  const count = (sql: string) => q.get<{ c: number }>(sql, [generation])!.c
  return {
    generation,
    kpis: {
      activeIncidents: active, affectedMerchants: affected.size, verifiedResolved: resolved,
      pendingApprovals: workflow ? workflow.countPendingApprovals(q, generation) : 0
    },
    pulse: [
      { key: "notification_failures", label: "Soundbox notification failures", count: count("SELECT COUNT(*) AS c FROM device_events WHERE generation = ? AND kind = 'NOTIFICATION_FAILED'") },
      { key: "open_tickets", label: "Open support tickets", count: count("SELECT COUNT(*) AS c FROM tickets WHERE generation = ? AND status = 'OPEN'") },
      { key: "successful_payments", label: "Successful payments", count: count("SELECT COUNT(*) AS c FROM payments WHERE generation = ? AND status = 'SUCCESS'") },
      { key: "short_settlements", label: "Short settlements", count: count("SELECT COUNT(*) AS c FROM settlements WHERE generation = ? AND status = 'SHORT'") },
      { key: "devices", label: "Soundbox devices", count: count("SELECT COUNT(*) AS c FROM devices WHERE generation = ?") }
    ],
    incidents: cards,
    activity: activity.slice(0, 50)
  }
}
