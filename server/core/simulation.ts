// Mock effects (device config sync, device restart, ticket linking) and the telemetry
// worker that emits fresh observations after the effect commits.
// There is deliberately NO financial mutation path: settlements are read-only.
import type { Scope } from "../../shared/contracts/http.js"
import { CoreError, type AppliedTarget, type Job, type SimulationInput, type Sql } from "../../shared/contracts/core.js"
import { advanceTelemetry, assertActive, nextTelemetrySequence, telemetryWatermark } from "./generations.js"
import { assertLease, enqueueJob } from "./jobs.js"
import { AFFECTED_CONFIG, FIXED_CONFIG } from "./seed.js"
import { newId, type Clock } from "./util.js"

interface AppliedRow { target_id: string; ok: number; applied_at: string; prior_sequence: number; reason: string | null; kind: string; incident_id: string }

const toApplied = (r: AppliedRow): AppliedTarget => ({ targetId: r.target_id, ok: r.ok === 1, appliedAt: r.applied_at, priorSequence: r.prior_sequence, reason: r.reason })

/**
 * Called only by Owner 02's authorized executor. Validates scope, applies the mock effect,
 * records per-target outcomes idempotently and queues `core.telemetry` for device actions.
 * Provides no authorization and no closure.
 */
export function applySimulation(tx: Sql, clock: Clock, scope: Scope, input: SimulationInput): AppliedTarget[] {
  assertActive(tx, scope.generation)
  const incident = tx.get<{ id: string; scenario: string }>("SELECT id, scenario FROM incidents WHERE id = ? AND generation = ?", [scope.incidentId, scope.generation])
  if (!incident) throw new CoreError("NOT_FOUND", "Incident not found in this generation.")
  if (!input.actionId || !input.targetIds.length) throw new CoreError("INVALID_INPUT", "actionId and at least one target are required.")

  const prior = tx.all<AppliedRow>("SELECT target_id, ok, applied_at, prior_sequence, reason, kind, incident_id FROM sim_applied WHERE action_id = ? ORDER BY ordinal", [input.actionId])
  if (prior.length) {
    const same = prior[0]!.kind === input.kind && prior[0]!.incident_id === scope.incidentId &&
      prior.length === new Set(input.targetIds).size && prior.every((p) => input.targetIds.includes(p.target_id))
    if (!same) throw new CoreError("CONFLICT", `Action ${input.actionId} was already applied with different parameters.`)
    return prior.map(toApplied) // replay returns the stored result: one effect per intent
  }

  const watermark = telemetryWatermark(tx, scope.generation)
  const results: AppliedTarget[] = []
  const targets = [...new Set(input.targetIds)]

  if (input.kind === "MOCK_SYNC_DEVICE_CONFIG" || input.kind === "MOCK_RESTART_DEVICE") {
    targets.forEach((targetId, i) => {
      const appliedAt = advanceTelemetry(tx, scope.generation, 2_000)
      const inRoster = tx.get<{ x: number }>("SELECT 1 AS x FROM incident_devices WHERE incident_id = ? AND device_id = ?", [scope.incidentId, targetId])
      let ok = false
      let reason: string | null = null
      if (!inRoster) reason = "not in incident cohort"
      else if (input.kind === "MOCK_SYNC_DEVICE_CONFIG") {
        const d = tx.get<{ config_version: string }>("SELECT config_version FROM devices WHERE id = ?", [targetId])!
        if (d.config_version === AFFECTED_CONFIG) {
          tx.run("UPDATE devices SET config_version = ?, revision = revision + 1 WHERE id = ?", [FIXED_CONFIG, targetId])
          ok = true
        } else if (d.config_version === FIXED_CONFIG) {
          ok = true; reason = "already at target config"
        } else reason = `config ${d.config_version} is not eligible for sync`
      } else {
        tx.run("UPDATE devices SET restarted_at = ?, revision = revision + 1 WHERE id = ?", [appliedAt, targetId])
        ok = true
      }
      tx.run(`INSERT INTO sim_applied (action_id, target_id, generation, incident_id, kind, ok, applied_at, prior_sequence, reason, ordinal)
              VALUES (?,?,?,?,?,?,?,?,?,?)`, [input.actionId, targetId, scope.generation, scope.incidentId, input.kind, ok ? 1 : 0, appliedAt, watermark, reason, i])
      results.push({ targetId, ok, appliedAt, priorSequence: watermark, reason })
    })
    enqueueJob(tx, clock, { generation: scope.generation, incidentId: scope.incidentId, key: `telemetry:${input.actionId}`,
      kind: "core.telemetry", runAfter: clock.now(), payload: { actionId: input.actionId } })
    return results
  }

  if (input.kind === "LINK_SUPPORT_TICKETS") {
    const linked = new Set(tx.all<{ record_id: string }>("SELECT record_id FROM incident_evidence WHERE incident_id = ? AND kind = 'ticket'", [scope.incidentId]).map((r) => r.record_id))
    targets.forEach((targetId, i) => {
      const appliedAt = advanceTelemetry(tx, scope.generation, 1_000)
      let ok = false
      let reason: string | null = null
      const t = linked.has(targetId)
        ? tx.get<{ id: string; merchant_id: string; linked_to: string | null }>("SELECT id, merchant_id, linked_to FROM tickets WHERE id = ?", [targetId]) : undefined
      if (!t) reason = "ticket not linked to this incident"
      else {
        // Primary = earliest ticket of the same merchant within the incident.
        const primary = tx.get<{ id: string }>(
          `SELECT t.id FROM tickets t JOIN incident_evidence e ON e.record_id = t.id AND e.incident_id = ? AND e.kind = 'ticket'
           WHERE t.merchant_id = ? ORDER BY t.created_at, t.id LIMIT 1`, [scope.incidentId, t.merchant_id])!
        if (primary.id === t.id) { ok = true; reason = "primary ticket (kept open)" }
        else if (t.linked_to && t.linked_to !== primary.id) reason = "already linked to a different ticket"
        else if (t.linked_to === primary.id) { ok = true; reason = "already linked" }
        else {
          tx.run("UPDATE tickets SET linked_to = ?, status = 'LINKED_DUPLICATE' WHERE id = ? AND linked_to IS NULL", [primary.id, t.id])
          ok = true
        }
      }
      tx.run(`INSERT INTO sim_applied (action_id, target_id, generation, incident_id, kind, ok, applied_at, prior_sequence, reason, ordinal)
              VALUES (?,?,?,?,?,?,?,?,?,?)`, [input.actionId, targetId, scope.generation, scope.incidentId, input.kind, ok ? 1 : 0, appliedAt, watermark, reason, i])
      results.push({ targetId, ok, appliedAt, priorSequence: watermark, reason })
    })
    return results
  }

  throw new CoreError("INVALID_INPUT", `Unsupported action kind ${String(input.kind)}.`)
}

/**
 * `core.telemetry` handler body (runs in one transaction under the job lease).
 * Emits observations from the resulting mock state + private per-device behaviour.
 * Idempotent: a retried job finds existing observations and writes nothing.
 */
export function emitTelemetry(tx: Sql, job: Job): number {
  assertLease(tx, job)
  const actionId = String(job.payload.actionId ?? "")
  const already = tx.get<{ c: number }>("SELECT COUNT(*) AS c FROM observations WHERE action_id = ?", [actionId])!.c
  if (already > 0) return 0
  const targets = tx.all<{ target_id: string; ok: number }>(
    "SELECT target_id, ok FROM sim_applied WHERE action_id = ? AND generation = ? ORDER BY ordinal", [actionId, job.generation])
  let written = 0
  for (const t of targets) {
    if (t.ok !== 1) continue
    const d = tx.get<{ config_version: string; restarted_at: string | null; needs_restart: number; restart_fails: number }>(
      `SELECT d.config_version, d.restarted_at, b.needs_restart, b.restart_fails FROM devices d
       JOIN sim_device_behavior b ON b.device_id = d.id WHERE d.id = ?`, [t.target_id])
    if (!d) continue
    const configOk = d.config_version === FIXED_CONFIG
    const notifyOk = configOk && (d.needs_restart === 0 || (d.restarted_at !== null && d.restart_fails === 0))
    for (const [kind, passed] of [["heartbeat", true], ["config", configOk], ["notification_probe", notifyOk]] as const) {
      const occurredAt = advanceTelemetry(tx, job.generation, 1_500)
      tx.run(`INSERT INTO observations (id, generation, device_id, action_id, sequence, occurred_at, kind, passed) VALUES (?,?,?,?,?,?,?,?)`,
        [newId("obs"), job.generation, t.target_id, actionId, nextTelemetrySequence(tx, job.generation), occurredAt, kind, passed ? 1 : 0])
      written++
    }
  }
  return written
}
