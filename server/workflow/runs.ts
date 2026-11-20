// Read-only view of the background machinery behind an incident: the jobs on the work list, the
// investigator runs, and the schedules and limits that govern them. Nothing here changes any record.
import { CORE_DEFAULTS, type CoreRuntime, type Sql } from "../../shared/contracts/core.js"
import type { JobStatus, JobView, Mode, RunView, RunsView, ScheduleView, Scope } from "../../shared/contracts/http.js"
import type { WorkflowOptions } from "./config.js"
import { requireIncident } from "./machine.js"

const JOB_LABEL: Record<string, string> = {
  "workflow.investigate": "AI investigation",
  "workflow.execute": "Run the approved action",
  "workflow.verify": "Check that it worked",
  "workflow.expire": "Approval timeout",
  "core.telemetry": "Device signal report",
}

interface JobRow { id: string; kind: string; status: JobStatus; run_after: string; attempt: number; created_at: string; updated_at: string; last_error: string | null }
interface EpisodeRow {
  id: string; stage: "triage" | "continuation"; mode: Mode; mode_reason: string | null; turns_used: number; steps_used: number;
  active_ms: number; status: string; outcome: string | null; started_at: string; finished_at: string | null
}

export function getRuns(core: CoreRuntime, q: Sql, scope: Scope, o: WorkflowOptions): RunsView {
  requireIncident(core, q, scope)
  const jobs: JobView[] = q.all<JobRow>(
    "SELECT id, kind, status, run_after, attempt, created_at, updated_at, last_error FROM jobs WHERE generation = ? AND incident_id = ? ORDER BY created_at, rowid",
    [scope.generation, scope.incidentId],
  ).map((j) => ({
    id: j.id, kind: j.kind, label: JOB_LABEL[j.kind] ?? j.kind, status: j.status, runAfter: j.run_after, attempt: j.attempt,
    createdAt: j.created_at, updatedAt: j.updated_at, lastError: j.last_error,
  }))
  const runs: RunView[] = q.all<EpisodeRow>(
    "SELECT id, stage, mode, mode_reason, turns_used, steps_used, active_ms, status, outcome, started_at, finished_at FROM wf_episodes WHERE generation = ? AND incident_id = ? ORDER BY started_at, rowid",
    [scope.generation, scope.incidentId],
  ).map((r) => ({
    id: r.id, stage: r.stage, mode: r.mode, modeReason: r.mode_reason, turnsUsed: r.turns_used, stepsUsed: r.steps_used, activeMs: r.active_ms,
    status: r.status, outcome: r.outcome, startedAt: r.started_at, finishedAt: r.finished_at,
  }))
  const secs = (ms: number) => `${Math.round(ms / 1000)} s`
  const schedules: ScheduleView[] = [
    { id: "verify", title: "Re-check after a fix", value: `every ${secs(o.verifyIntervalMs)}`, detail: `for up to ${secs(o.verifyWindowMs)}, then it counts as failed` },
    { id: "approval", title: "Approval time limit", value: `${Math.round(o.approvalTtlMs / 60_000)} min`, detail: "if nobody decides, the action never runs" },
    { id: "ai", title: "AI investigation limit", value: `${o.maxModelTurns} steps`, detail: `or ${secs(o.episodeBudgetMs)}, whichever comes first` },
    { id: "retry", title: "Job retries", value: `${CORE_DEFAULTS.jobMaxAttempts} tries`, detail: `a worker holds a job for ${secs(CORE_DEFAULTS.jobLeaseMs)}; a crash hands it to another` },
  ]
  return { generation: scope.generation, incidentId: scope.incidentId, jobs, runs, schedules }
}
