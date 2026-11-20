// PRD §15 success metrics, computed from persisted synthetic runs only.
// These are SIMULATED demo measurements, never Paytm production claims.
import type { MetricView, MetricsView, WorkflowView } from "../../shared/contracts/http.js"
import type { Sql, WorkflowModule } from "../../shared/contracts/core.js"
import { listIncidentCards } from "./incidents.js"
import { workflowFor } from "./readmodels.js"
import { PRIVATE_FIXTURE } from "./seed.js"
import { jobForIncident } from "./profile.js"

const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : "—")
const metric = (key: string, label: string, numerator: number | null, denominator: number | null, detail: string, value?: string): MetricView =>
  ({ key, label, numerator, denominator, detail, value: value ?? (numerator !== null && denominator !== null ? pct(numerator, denominator) : "—") })

export function metricsView(q: Sql, workflow: WorkflowModule | null, generation: number): MetricsView {
  const cards = listIncidentCards(q, generation)
  const wfs = new Map<string, WorkflowView>(cards.map((c) => [c.id, workflowFor(q, workflow, { generation, incidentId: c.id })]))

  // 1. Grouping quality: each device incident's roster vs. its detection job's expected cohort.
  let grouped = 0, correct = 0, expectedTotal = 0
  for (const c of cards.filter((x) => x.scenario === "soundbox")) {
    const expected = new Set<string>(jobForIncident(q, c.id)?.cohort?.targetRefs ?? PRIVATE_FIXTURE.targetDeviceRefs)
    const refs = q.all<{ s: string }>("SELECT d.seed_ref AS s FROM incident_devices i JOIN devices d ON d.id = i.device_id WHERE i.incident_id = ?", [c.id]).map((r) => r.s)
    grouped += refs.length
    correct += refs.filter((r) => expected.has(r)).length
    expectedTotal += expected.size
  }
  const grouping = expectedTotal
    ? metric("grouping_quality", "Incident grouping quality", correct, expectedTotal,
      `${correct} of ${expectedTotal} expected devices grouped into the right incident; ${grouped - correct} unrelated device(s) wrongly included.`)
    : metric("grouping_quality", "Incident grouping quality", null, null, "Run a device detection job to measure grouping.")

  // 2. Autonomous completion: low-risk actions executed without a human / low-risk actions proposed.
  const all = [...wfs.values()].flatMap((w) => w.actions)
  const lowRisk = all.filter((a) => a.kind !== "MOCK_RESTART_DEVICE")
  const lowDone = lowRisk.filter((a) => a.status === "SUCCEEDED" || a.status === "PARTIAL")
  const autonomous = metric("autonomous_completion", "Autonomous completion rate", lowDone.length, lowRisk.length,
    `${lowDone.length} of ${lowRisk.length} eligible low-risk actions (config sync, ticket linking) executed with no human step.`)

  // 3. Policy compliance: every executed restricted action had an approved, consumed approval.
  const restricted = all.filter((a) => a.kind === "MOCK_RESTART_DEVICE" && (a.status === "SUCCEEDED" || a.status === "PARTIAL" || a.status === "FAILED"))
  const approvals = [...wfs.values()].flatMap((w) => w.approvals)
  const gated = restricted.filter((a) => approvals.some((p) => p.actionId === a.id && (p.status === "CONSUMED" || p.status === "APPROVED") && p.decidedBy))
  const blockedProposals = [...wfs.values()].flatMap((w) => w.actions).filter((a) => a.kind === "MOCK_RESTART_DEVICE" && a.status === "BLOCKED").length
  const compliance = restricted.length
    ? metric("policy_compliance", "Policy compliance", gated.length, restricted.length,
      `${gated.length} of ${restricted.length} executed restarts had a human approval; ${blockedProposals} restart(s) blocked.`)
    : metric("policy_compliance", "Policy compliance", 0, 0, `No restricted action has executed yet; ${blockedProposals} restart(s) blocked.`, "100%")

  // 4. Verified recovery: latest verifier result across Soundbox incidents.
  let rec = 0, tot = 0
  for (const c of cards.filter((x) => x.scenario === "soundbox")) {
    const r = wfs.get(c.id)?.recovery
    if (r) { rec += r.recovered; tot += r.total }
  }
  const recovery = metric("verified_recovery", "Verified recovery", tot ? rec : null, tot || null,
    tot ? `${rec} of ${tot} affected devices passed fresh post-action checks.` : "No verification has run yet.")

  // 5. Time to triage: incident creation -> first grounded decision (authorized action, approval request or handoff).
  const durations: number[] = []
  for (const c of cards) {
    const created = q.get<{ t: string }>("SELECT created_at AS t FROM incidents WHERE id = ?", [c.id])?.t
    const first = wfs.get(c.id)?.audit.filter((a) => /ACTION_AUTHORIZED|APPROVAL_REQUESTED|SETTLEMENT_HANDOFF|ESCALAT/.test(a.event)).map((a) => a.at).sort()[0]
    if (created && first) durations.push(Math.max(0, Date.parse(first) - Date.parse(created)))
  }
  const avgMs = durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : null
  const triage = metric("time_to_triage", "Time to triage", null, null,
    durations.length ? `Average over ${durations.length} incident(s), from detection to first grounded action decision.` : "No incident has reached a decision yet.",
    avgMs === null ? "—" : avgMs < 1000 ? `${Math.round(avgMs)} ms` : `${(avgMs / 1000).toFixed(1)} s`)

  // 6. Trace completeness: actions with an audit record carrying evidence and a policy rule.
  const audits = new Map([...wfs.values()].flatMap((w) => w.audit).map((a) => [a.id, a]))
  const complete = all.filter((a) => a.ruleId && a.auditId && (audits.get(a.auditId)?.evidenceIds.length ?? 0) > 0)
  const trace = metric("trace_completeness", "Trace completeness", complete.length, all.length,
    `${complete.length} of ${all.length} actions have evidence, a tool decision, a policy rule and an audit record.`)

  // 7. Demo reproducibility: success-path Soundbox runs across all resets that reached verified RESOLVED.
  // Only runs where the human APPROVED the restart are expected to resolve; a rejection that
  // escalates is the correct outcome, so it is reported separately rather than as a failure.
  const finished = q.all<{ id: string; generation: number; status: string }>(
    `SELECT i.id, i.generation, i.status FROM incidents i JOIN batches b ON b.id = i.batch_id
     WHERE i.scenario = 'soundbox' AND b.variant = 'success' AND i.status IN ('RESOLVED','ESCALATED','FAILED')`)
  let approvedRuns = 0, approvedResolved = 0, rejectedRuns = 0
  for (const run of finished) {
    const decided = workflowFor(q, workflow, { generation: run.generation, incidentId: run.id }).approvals
    if (decided.some((a) => a.status === "CONSUMED" || a.status === "APPROVED")) {
      approvedRuns++
      if (run.status === "RESOLVED") approvedResolved++
    } else rejectedRuns++
  }
  const repro = metric("demo_reproducibility", "Run reproducibility", approvedRuns ? approvedResolved : null, approvedRuns || null,
    approvedRuns ? `${approvedResolved} of ${approvedRuns} approved success-path runs (across all resets) reached full verified recovery.` +
      (rejectedRuns ? ` ${rejectedRuns} rejected/unapproved run(s) correctly stayed unresolved.` : "")
      : "Complete an approved device-recovery run to measure reproducibility.")

  return { generation, simulated: true, metrics: [grouping, autonomous, compliance, recovery, triage, trace, repro] }
}
