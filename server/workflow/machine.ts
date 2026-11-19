// The single workflow state machine. Incident status edges come from the shared
// INCIDENT_TRANSITIONS map; this module adds Owner 02's preconditions and makes
// every transition carry its trace entry (mode + reason) in the same transaction.
import { canTransition, type CoreIncident, type CoreRuntime, type Sql } from "../../shared/contracts/core.js"
import type { IncidentStatus, Mode, Scope } from "../../shared/contracts/http.js"
import { addTrace } from "./store.js"
import { WorkflowError } from "./util.js"

/**
 * Soundbox:  DETECTED → INVESTIGATING → ACTION_RUNNING (sync) → VERIFYING
 *            → RESOLVED | PARTIALLY_RECOVERED → APPROVAL_PENDING
 *            → ACTION_RUNNING (restart, approved) → VERIFYING → RESOLVED | ESCALATED
 *            APPROVAL_PENDING → ESCALATED on reject/expiry.
 * Scenario B: INVESTIGATING → ACTION_RUNNING (link) → VERIFYING → TASK_COMPLETED | ESCALATED
 * Scenario C: INVESTIGATING → ESCALATED (factual settlement handoff, read-only).
 * No evidence: INVESTIGATING → INSUFFICIENT_EVIDENCE (retryable → INVESTIGATING).
 */
export interface TransitionInput {
  to: IncidentStatus
  blocker?: string | null
  owner?: string | null
  verifiedCheckId?: string
  mode: Mode
  stage: string
  reason: string
  opKey: string
  evidenceIds?: string[]
  auditId?: string | null
}

export function transition(core: CoreRuntime, tx: Sql, scope: Scope, incident: CoreIncident, input: TransitionInput): CoreIncident {
  const from = incident.card.status
  if (!canTransition(from, input.to)) {
    throw new WorkflowError(409, "WORKFLOW_CONFLICT", `Illegal incident transition ${from} → ${input.to}.`)
  }
  if (input.to === "RESOLVED" && !input.verifiedCheckId) {
    throw new WorkflowError(409, "WORKFLOW_CONFLICT", "RESOLVED requires a verifier-owned check reference.")
  }
  const next = core.incidents.transition(tx, scope, {
    expectedVersion: incident.card.version,
    status: input.to,
    blocker: input.blocker ?? null,
    owner: input.owner ?? null,
    ...(input.verifiedCheckId ? { verifiedCheckId: input.verifiedCheckId } : {}),
  })
  addTrace(tx, scope, `transition:${input.opKey}`, {
    at: core.clock.now(),
    mode: input.mode,
    stage: input.stage,
    summary: `${from} → ${input.to}: ${input.reason}`,
    evidenceIds: input.evidenceIds ?? [],
    auditId: input.auditId ?? null,
  })
  return next
}

export function requireIncident(core: CoreRuntime, q: Sql, scope: Scope): CoreIncident {
  const inc = core.incidents.get(q, scope)
  if (!inc) throw new WorkflowError(404, "NOT_FOUND", "Incident not found in the current generation.")
  return inc
}

/** Field team that owns device follow-up after automation stops. */
export const FIELD_OWNER = "Field Operations"
export const SETTLEMENT_OWNER = "Settlement Operations"
export const SUPPORT_OWNER = "Merchant Support"
