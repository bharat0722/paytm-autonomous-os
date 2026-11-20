// Builds the playbook view: the steps this incident type follows, each with its status and the recorded
// calls (what we hit, what we sent, what came back). Status is derived from the process log and the incident
// state; nothing here changes any record.
import type { CoreRuntime, Sql } from "../../shared/contracts/core.js"
import { PLAYBOOKS } from "../../shared/contracts/playbooks.js"
import type { PlaybookStepView, PlaybookView, ProcessEntry, Scope, StepStatus } from "../../shared/contracts/http.js"
import { listProcessLog } from "./store.js"
import { requireIncident } from "./machine.js"

const TERMINAL = new Set(["RESOLVED", "TASK_COMPLETED", "ESCALATED"])

export function getPlaybook(core: CoreRuntime, q: Sql, scope: Scope): PlaybookView {
  const incident = requireIncident(core, q, scope)
  const card = incident.card
  const def = PLAYBOOKS[card.scenario]
  const log = listProcessLog(q, scope)
  const terminal = TERMINAL.has(card.status)

  const closeEntry: ProcessEntry | null = terminal ? {
    id: `close_${card.id}`, at: card.updatedAt, stepId: "close", kind: "result", system: "MROS incident store", method: "TRANSITION", endpoint: `/incidents/${card.id}`,
    request: { from: "VERIFYING or earlier", rule: "Only the verifier can resolve; failures escalate" },
    response: { status: card.status, owner: incident.owner, blocker: incident.blocker },
    httpStatus: null, outcome: card.status === "ESCALATED" ? "INFO" : "OK",
    summary: card.status === "RESOLVED" ? "Verified recovery. Case resolved."
      : card.status === "TASK_COMPLETED" ? "All links verified in storage. Task completed."
        : `Escalated to ${incident.owner ?? "a human owner"}${incident.blocker ? `: ${incident.blocker}` : ""}`,
    evidenceIds: [], actionId: null,
  } : null

  let activeAssigned = false
  const steps: PlaybookStepView[] = def.steps.map((s, index) => {
    const entries = s.id === "close" ? (closeEntry ? [closeEntry] : []) : log.filter((e) => e.stepId === s.id)
    let status: StepStatus
    if (entries.length) {
      const failed = entries.some((e) => (e.outcome === "FAILED" || e.outcome === "BLOCKED") && e.system !== "Guardrail")
      const hasWait = entries.some((e) => e.kind === "wait")
      const decided = entries.some((e) => e.kind === "decision" && e.stepId === "approve")
      if (s.kind === "investigate" && !entries.some((e) => e.kind === "result")) status = terminal ? "done" : "active"
      else if (s.kind === "approve" && hasWait && !decided && card.status === "APPROVAL_PENDING") status = "waiting"
      else status = failed ? "failed" : "done"
    } else if (terminal) {
      status = "skipped"
    } else {
      status = "pending"
    }
    if (!terminal && !activeAssigned && (status === "pending" || status === "active" || status === "waiting")) {
      activeAssigned = true
      if (status === "pending") status = s.kind === "approve" && card.status === "APPROVAL_PENDING" ? "waiting" : "active"
    }
    return {
      id: s.id, order: index + 1, kind: s.kind, title: s.title, description: s.description, system: s.system,
      automation: s.automation, status, entries,
    }
  })
  // A failed incident that is not terminal (e.g. investigation failed) must not show a spinner forever.
  if (!terminal && (card.status === "FAILED" || card.status === "INSUFFICIENT_EVIDENCE")) {
    for (const s of steps) if (s.status === "active") s.status = "failed"
  }
  return { generation: scope.generation, incidentId: card.id, scenario: card.scenario, title: def.title, summary: def.summary, steps }
}
