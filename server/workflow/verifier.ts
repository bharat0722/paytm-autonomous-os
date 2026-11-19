// Independent verifier. Recovery is computed only from committed observations newer than
// each device's most recent remediation watermark. It alone closes a Soundbox incident.
import type { CoreIncident, CoreRuntime, Job, Observation, Sql } from "../../shared/contracts/core.js"
import type { DeviceCheck, Scope } from "../../shared/contracts/http.js"
import type { WorkflowOptions } from "./config.js"
import { FIELD_OWNER, SUPPORT_OWNER, transition } from "./machine.js"
import { ticketLinkTarget } from "./policy.js"
import {
  addAudit, addEscalation, getAction, getState, latestVerification, listActionTargets, listActions, saveState,
  type ActionRow, type ActionTargetRow,
} from "./store.js"
import { FencedError, addMs, guardJob, opaqueId, parseJson, scopeOf } from "./util.js"

export const REQUIRED_SIGNALS: Observation["kind"][] = ["heartbeat", "config", "notification_probe"]
const SIGNAL_LABEL: Record<Observation["kind"], string> = { heartbeat: "heartbeat", config: "expected configuration", notification_probe: "notification probe" }

export interface DeviceEvaluation { check: DeviceCheck; deadline: string | null }

/**
 * Pure evaluation of one device against its most recent committed remediation attempt.
 * A signal passes only when the newest relevant observation of that kind passed, is
 * attributed to that action and device, occurred after execution and within the window,
 * and has a sequence above the pre-action watermark. Newer failures contradict older passes.
 */
export function evaluateDevice(
  deviceId: string, attempt: ActionTargetRow | undefined, observations: Observation[], cutoff: string, windowMs: number,
): DeviceEvaluation {
  if (!attempt) return { check: { deviceId, actionId: null, status: "FAIL", reason: "No committed remediation attempt.", evidenceIds: [] }, deadline: null }
  const deadline = addMs(attempt.applied_at, windowMs)
  if (!attempt.ok) {
    return { check: { deviceId, actionId: attempt.action_id, status: "FAIL", reason: `Simulator reported the action failed${attempt.reason ? `: ${attempt.reason}` : ""}.`, evidenceIds: [] }, deadline }
  }
  const relevant = observations
    .filter((o) => o.deviceId === deviceId && o.sequence > attempt.prior_sequence && o.occurredAt >= attempt.applied_at && o.occurredAt <= cutoff)
    .sort((a, b) => a.sequence - b.sequence)
  const evidenceIds: string[] = []
  const failing: string[] = []
  const missing: string[] = []
  for (const kind of REQUIRED_SIGNALS) {
    const ofKind = relevant.filter((o) => o.kind === kind)
    const newest = ofKind[ofKind.length - 1]
    if (!newest) {
      missing.push(SIGNAL_LABEL[kind])
      continue
    }
    if (!newest.passed) {
      evidenceIds.push(newest.id)
      const contradicted = ofKind.some((o) => o.passed)
      failing.push(`${SIGNAL_LABEL[kind]} failed${contradicted ? " (newer failure contradicts an earlier pass)" : ""}`)
      continue
    }
    // Passes count only inside the observation window; failures count whenever they are newer.
    const attributed = [...ofKind].reverse().find((o) => o.passed && o.actionId === attempt.action_id && o.occurredAt <= deadline)
    if (!attributed) {
      missing.push(`${SIGNAL_LABEL[kind]} attributed to action ${attempt.action_id}`)
      continue
    }
    evidenceIds.push(attributed.id)
  }
  if (failing.length) return { check: { deviceId, actionId: attempt.action_id, status: "FAIL", reason: `${failing.join("; ")}.`, evidenceIds }, deadline }
  if (missing.length) return { check: { deviceId, actionId: attempt.action_id, status: "AWAITING", reason: `Awaiting fresh ${missing.join(", ")}.`, evidenceIds }, deadline }
  return { check: { deviceId, actionId: attempt.action_id, status: "PASS", reason: "Fresh heartbeat, expected configuration and notification probe passed after the action.", evidenceIds }, deadline }
}

function latestAttempts(tx: Sql, scope: Scope, deviceActionIds: Set<string>): Map<string, ActionTargetRow> {
  const map = new Map<string, ActionTargetRow>()
  for (const t of listActionTargets(tx, scope)) if (deviceActionIds.has(t.action_id)) map.set(t.target_id, t)
  return map
}

function evaluateDevices(core: CoreRuntime, tx: Sql, scope: Scope, incident: CoreIncident, cutoff: string, windowMs: number): DeviceEvaluation[] {
  const cohort = incident.devices.map((d) => d.id).sort()
  const deviceActions = new Set(listActions(tx, scope).filter((a) => a.kind !== "LINK_SUPPORT_TICKETS").map((a) => a.id))
  const attempts = latestAttempts(tx, scope, deviceActions)
  const observations = core.evidence.observations(tx, scope, cohort)
  return cohort.map((id) => evaluateDevice(id, attempts.get(id), observations, cutoff, windowMs))
}

function evaluateLinks(core: CoreRuntime, tx: Sql, scope: Scope, action: ActionRow, cutoff: string, windowMs: number): DeviceEvaluation[] {
  const [primary, ...dups] = parseJson<string[]>(action.target_ids, [])
  const records = new Map(core.evidence.read(tx, scope, { kind: "ticket", ids: dups }).map((r) => [r.id, r]))
  const deadline = addMs(action.executed_at ?? cutoff, windowMs)
  return dups.map((id) => {
    const rec = records.get(id)
    const link = rec ? ticketLinkTarget(rec) : null
    const check: DeviceCheck = link === primary
      ? { deviceId: id, actionId: action.id, status: "PASS", reason: `Stored link to ${primary} confirmed.`, evidenceIds: [id] }
      : { deviceId: id, actionId: action.id, status: "AWAITING", reason: link ? `Stored link points to ${link}, not ${primary}.` : "No stored link yet.", evidenceIds: rec ? [id] : [] }
    return { check, deadline }
  })
}

export function makeVerifyHandler(core: CoreRuntime, options: WorkflowOptions) {
  return async (job: Job): Promise<void> => {
    try {
      core.db.write((tx) => verifyTx(core, options, tx, job))
    } catch (err) {
      if (err instanceof FencedError) return
      throw err
    }
  }
}

function verifyTx(core: CoreRuntime, options: WorkflowOptions, tx: Sql, job: Job): void {
  guardJob(core, tx, job)
  const scope = scopeOf(job)
  const actionId = String(job.payload.actionId ?? "")
  const round = Number(job.payload.round ?? 1)
  const done = tx.get<{ id: string }>("SELECT id FROM wf_verifications WHERE generation = ? AND action_id = ? AND round = ?", [scope.generation, actionId, round])
  if (done) return
  const action = getAction(tx, actionId)
  const incident = core.incidents.get(tx, scope)
  if (!action || !incident || incident.card.status !== "VERIFYING") return

  const now = core.clock.now()
  const cutoff = core.clock.telemetryNow(tx, scope)
  const isLink = action.kind === "LINK_SUPPORT_TICKETS"
  const evals = isLink
    ? evaluateLinks(core, tx, scope, action, cutoff, options.verifyWindowMs)
    : evaluateDevices(core, tx, scope, incident, cutoff, options.verifyWindowMs)

  const awaiting = evals.filter((e) => e.check.status === "AWAITING")
  const windowOpen = awaiting.some((e) => e.deadline !== null && cutoff < e.deadline)
  const final = awaiting.length === 0 || !windowOpen
  const checks = evals.map((e) => e.check.status === "AWAITING" && final
    ? { ...e.check, status: "FAIL" as const, reason: `${e.check.reason.replace(/^Awaiting/, "Missing")} within the ${Math.round(options.verifyWindowMs / 1000)}s window.` }
    : e.check)

  const previous = latestVerification(tx, scope, { finalOnly: true })
  const recovered = checks.filter((c) => c.status === "PASS").length
  const remaining = checks.filter((c) => c.status !== "PASS").map((c) => c.deviceId)
  const checkId = opaqueId("chk", scope.generation, scope.incidentId, actionId, round)
  const version = getState(tx, scope)?.version ?? 0
  tx.run(
    `INSERT INTO wf_verifications (id, generation, incident_id, action_id, round, final, checked_at, cutoff, total, before_recovered, recovered, remaining, devices, workflow_version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [checkId, scope.generation, scope.incidentId, actionId, round, final ? 1 : 0, now, cutoff, checks.length,
      previous?.recovered ?? 0, recovered, JSON.stringify(remaining), JSON.stringify(checks), version],
  )

  if (!final) {
    core.jobs.enqueue(tx, {
      ...scope, key: `verify:${actionId}:${round + 1}`, kind: "workflow.verify",
      runAfter: addMs(now, options.verifyIntervalMs), payload: { actionId, round: round + 1 },
    })
    return
  }

  const evidenceIds = [checkId]
  const tally = `${recovered}/${checks.length}`
  const auditId = addAudit(tx, scope, `verify:${checkId}`, {
    at: now, actor: "workflow:verifier", event: "VERIFICATION_RECORDED",
    summary: `${isLink ? "Stored ticket links" : "Fresh observations"}: ${tally} verified (cutoff ${cutoff}).`,
    actionId, evidenceIds,
  })

  if (recovered === checks.length && checks.length > 0) {
    transition(core, tx, scope, incident, {
      to: isLink ? "TASK_COMPLETED" : "RESOLVED", verifiedCheckId: checkId, mode: "system", stage: "verification",
      reason: isLink ? `All ${tally} duplicate links verified in storage.` : `Verifier confirmed ${tally} devices recovered with fresh observations.`,
      opKey: `verify:${checkId}:closed`, evidenceIds, auditId,
    })
    saveState(tx, scope, now, { scenario: incident.card.scenario, phase: "DONE" })
    return
  }

  if (isLink) {
    const blocker = `Only ${tally} ticket links were stored; manual review needed.`
    addEscalation(tx, scope, `verify:${checkId}`, { at: now, reasonCode: "LINK_UNVERIFIED", summary: blocker, owner: SUPPORT_OWNER, retryable: false, evidenceIds })
    transition(core, tx, scope, incident, { to: "ESCALATED", blocker, owner: SUPPORT_OWNER, mode: "system", stage: "verification", reason: blocker, opKey: `verify:${checkId}:escalated`, evidenceIds, auditId })
    saveState(tx, scope, now, { scenario: incident.card.scenario, phase: "DONE", blockerCode: "LINK_UNVERIFIED" })
    return
  }

  if (action.kind === "MOCK_SYNC_DEVICE_CONFIG") {
    const blocker = `${remaining.length} devices still fail after config sync (${tally} recovered). Restart requires approval.`
    transition(core, tx, scope, incident, { to: "PARTIALLY_RECOVERED", blocker, mode: "system", stage: "verification", reason: `Partial recovery ${tally}.`, opKey: `verify:${checkId}:partial`, evidenceIds, auditId })
    saveState(tx, scope, now, { scenario: incident.card.scenario, phase: "RESTART_PROPOSAL" })
    core.jobs.enqueue(tx, {
      ...scope, key: `investigate:${scope.incidentId}:continuation:${checkId}`, kind: "workflow.investigate",
      runAfter: now, payload: { stage: "continuation", checkId },
    })
    return
  }

  const blocker = `${tally} recovered after the approved restart; ${remaining.join(", ")} still failing. No automatic reproposal; field follow-up required.`
  addEscalation(tx, scope, `verify:${checkId}`, { at: now, reasonCode: "UNRECOVERED_AFTER_RESTART", summary: blocker, owner: FIELD_OWNER, retryable: false, evidenceIds })
  transition(core, tx, scope, incident, { to: "ESCALATED", blocker, owner: FIELD_OWNER, mode: "system", stage: "verification", reason: `Restart verification ${tally}.`, opKey: `verify:${checkId}:escalated`, evidenceIds, auditId })
  saveState(tx, scope, now, { scenario: incident.card.scenario, phase: "DONE", blockerCode: "UNRECOVERED_AFTER_RESTART" })
}
