// Incident identity and classification: human-readable IDs, incident types, thresholds,
// the scheduled job that detected each incident, and the detection job catalogue.
import type { DetectionJobsView, IncidentProfile, IncidentStatus, Scope, SignalView } from "../../shared/contracts/http.js"
import type { Sql } from "../../shared/contracts/core.js"
import { DETECTION_JOBS, cronWindow, defaultJobFor, jobByBatchKey, jobById, type DetectionJob } from "./datasets.js"

const IST_OFFSET_MS = 330 * 60_000

/** e.g. INC-20261120-003: IST date of detection + sequence within the current workspace run. */
export function displayIdFor(q: Sql, incidentId: string): string | null {
  const row = q.get<{ generation: number; created_at: string }>("SELECT generation, created_at FROM incidents WHERE id = ?", [incidentId])
  if (!row) return null
  const seq = q.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM incidents WHERE generation = ? AND (created_at < ? OR (created_at = ? AND id <= ?))",
    [row.generation, row.created_at, row.created_at, incidentId])!.n
  const d = new Date(Date.parse(row.created_at) + IST_OFFSET_MS).toISOString().slice(0, 10).replaceAll("-", "")
  return `INC-${d}-${String(seq).padStart(3, "0")}`
}

export function jobForIncident(q: Sql, incidentId: string): DetectionJob | null {
  const row = q.get<{ scenario: string; correlation_json: string; batch_key: string | null }>(
    `SELECT i.scenario, i.correlation_json, b.scenario AS batch_key FROM incidents i LEFT JOIN batches b ON b.id = i.batch_id WHERE i.id = ?`, [incidentId])
  if (!row) return null
  try {
    const jobId = (JSON.parse(row.correlation_json) as { jobId?: string }).jobId
    if (jobId && jobById(jobId)) return jobById(jobId)!
  } catch { /* fall through */ }
  return (row.batch_key && jobByBatchKey(row.batch_key)) || defaultJobFor(row.scenario as DetectionJob["scenario"])
}

export function incidentProfile(q: Sql, scope: Scope): IncidentProfile | null {
  const inc = q.get<{ created_at: string }>("SELECT created_at FROM incidents WHERE id = ? AND generation = ?", [scope.incidentId, scope.generation])
  const job = inc ? jobForIncident(q, scope.incidentId) : null
  if (!inc || !job) return null
  return {
    displayId: displayIdFor(q, scope.incidentId)!, incidentType: job.incidentType, typeLabel: job.typeLabel,
    description: job.description, threshold: job.threshold, zone: job.zone,
    detectedBy: { jobId: job.id, jobName: job.name, cron: job.cron, scheduleLabel: job.scheduleLabel, ranAt: inc.created_at }
  }
}

/** Device signals for the incident's cohort, so every observation reference resolves. */
export function incidentSignals(q: Sql, scope: Scope): SignalView[] {
  return q.all<{ id: string; device_id: string; action_id: string | null; kind: string; passed: number; occurred_at: string; sequence: number }>(
    `SELECT o.id, o.device_id, o.action_id, o.kind, o.passed, o.occurred_at, o.sequence
     FROM observations o JOIN incident_devices i ON i.device_id = o.device_id AND i.incident_id = ?
     WHERE o.generation = ? ORDER BY o.sequence`, [scope.incidentId, scope.generation]
  ).map((o) => ({ id: o.id, deviceId: o.device_id, actionId: o.action_id, kind: o.kind, passed: o.passed === 1, occurredAt: o.occurred_at, sequence: o.sequence }))
}

export function detectionJobsView(q: Sql, generation: number, now: string): DetectionJobsView {
  const jobs = DETECTION_JOBS.map((job) => {
    const run = q.get<{ created_at: string; incident_id: string | null; variant: string }>(
      "SELECT created_at, incident_id, variant FROM batches WHERE generation = ? AND scenario = ?", [generation, job.batchKey])
    const status = run?.incident_id ? q.get<{ status: IncidentStatus }>("SELECT status FROM incidents WHERE id = ?", [run.incident_id])?.status ?? null : null
    const w = cronWindow(job.cron, now)
    return {
      id: job.id, name: job.name, scenario: job.scenario, incidentType: job.incidentType, typeLabel: job.typeLabel,
      description: job.description, threshold: job.threshold, zone: job.zone, severity: job.severity, cron: job.cron,
      scheduleLabel: job.scheduleLabel, supportsPartial: job.supportsPartial, previousFireAt: w.previous, nextFireAt: w.next,
      lastRun: run?.incident_id ? { ranAt: run.created_at, incidentId: run.incident_id, variant: run.variant, status, displayId: displayIdFor(q, run.incident_id) } : null
    }
  })
  return { generation, now, timezone: "Asia/Kolkata", jobs }
}
