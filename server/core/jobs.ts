// Durable at-least-once job queue with leases, bounded retries, restart recovery and
// generation fencing. Network calls never happen inside effect transactions.
import { CORE_DEFAULTS, CoreError, type Job, type JobHandler, type JobInput, type JobKind, type Sql } from "../../shared/contracts/core.js"
import type { CoreDb } from "./db.js"
import { activeGeneration } from "./generations.js"
import { addMs, newId, randomToken, type Clock } from "./util.js"

interface JobRow {
  id: string; generation: number; incident_id: string; key: string; kind: JobKind; run_after: string;
  payload_json: string; status: string; attempt: number; lease_token: string | null
}

/** Deduplicates stable keys within a generation (INSERT OR IGNORE on (generation, key)). */
export function enqueueJob(tx: Sql, clock: Clock, input: JobInput): void {
  const now = clock.now()
  tx.run(
    `INSERT OR IGNORE INTO jobs (id, generation, incident_id, key, kind, run_after, payload_json, status, attempt, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,'PENDING',0,?,?)`,
    [newId("job"), input.generation, input.incidentId, input.key, input.kind, input.runAfter, JSON.stringify(input.payload), now, now]
  )
}

/** Throws FENCED unless this job still holds its lease in the active generation. */
export function assertLease(tx: Sql, job: Job): void {
  const row = tx.get<{ status: string; lease_token: string | null; generation: number }>(
    "SELECT status, lease_token, generation FROM jobs WHERE generation = ? AND key = ?", [job.generation, job.key])
  if (!row || row.status !== "LEASED" || row.lease_token !== job.leaseToken) throw new CoreError("FENCED", `Lease lost for job ${job.key}.`)
  if (activeGeneration(tx) !== job.generation) throw new CoreError("FENCED", `Generation ${job.generation} is no longer active.`)
}

const toJob = (r: JobRow, leaseToken: string, attempt: number): Job => ({
  generation: r.generation, incidentId: r.incident_id, key: r.key, kind: r.kind, runAfter: r.run_after,
  payload: JSON.parse(r.payload_json) as Record<string, unknown>, leaseToken, attempt
})

export class JobRunner {
  private timer: NodeJS.Timeout | null = null
  private running = false

  constructor(
    private readonly db: CoreDb,
    private readonly clock: Clock,
    private readonly registry: Partial<Record<JobKind, JobHandler>>,
    private readonly opts: { leaseMs: number; maxAttempts: number } = { leaseMs: CORE_DEFAULTS.jobLeaseMs, maxAttempts: CORE_DEFAULTS.jobMaxAttempts }
  ) {}

  /** Claims one due job of a registered kind in the active generation (or an expired lease). */
  claim(): Job | null {
    const kinds = Object.keys(this.registry) as JobKind[]
    if (!kinds.length) return null
    return this.db.write((tx) => {
      const now = this.clock.now()
      const gen = activeGeneration(tx)
      const ph = kinds.map(() => "?").join(",")
      const row = tx.get<JobRow>(
        `SELECT id, generation, incident_id, key, kind, run_after, payload_json, status, attempt, lease_token FROM jobs
         WHERE generation = ? AND kind IN (${ph}) AND run_after <= ?
           AND (status = 'PENDING' OR (status = 'LEASED' AND lease_expires_at < ?))
         ORDER BY run_after, created_at LIMIT 1`, [gen, ...kinds, now, now])
      if (!row) return null
      const token = randomToken(16)
      const attempt = row.attempt + 1
      tx.run("UPDATE jobs SET status = 'LEASED', lease_token = ?, lease_expires_at = ?, attempt = ?, updated_at = ? WHERE id = ?",
        [token, addMs(now, this.opts.leaseMs), attempt, now, row.id])
      return toJob(row, token, attempt)
    })
  }

  private finish(job: Job, outcome: { ok: true } | { ok: false; error: unknown }): void {
    this.db.write((tx) => {
      const now = this.clock.now()
      const owned = tx.get<{ id: string }>("SELECT id FROM jobs WHERE generation = ? AND key = ? AND lease_token = ? AND status = 'LEASED'",
        [job.generation, job.key, job.leaseToken])
      if (!owned) return // lease lost or generation reset: nothing to record
      if (outcome.ok) {
        tx.run("UPDATE jobs SET status = 'DONE', lease_token = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?", [now, owned.id])
        return
      }
      const err = outcome.error
      const message = err instanceof Error ? err.message : String(err)
      const fenced = err instanceof CoreError && (err.code === "FENCED" || err.code === "STALE_GENERATION")
      if (fenced) {
        tx.run("UPDATE jobs SET status = 'CANCELLED', lease_token = NULL, last_error = ?, updated_at = ? WHERE id = ?", [message, now, owned.id])
      } else if (job.attempt >= this.opts.maxAttempts) {
        tx.run("UPDATE jobs SET status = 'FAILED', lease_token = NULL, last_error = ?, updated_at = ? WHERE id = ?", [message, now, owned.id])
      } else {
        tx.run("UPDATE jobs SET status = 'PENDING', lease_token = NULL, lease_expires_at = NULL, last_error = ?, run_after = ?, updated_at = ? WHERE id = ?",
          [message, addMs(now, 500 * 2 ** (job.attempt - 1)), now, owned.id])
      }
    })
  }

  /** Runs at most one job. Returns true if a job was processed. */
  async runOnce(): Promise<boolean> {
    const job = this.claim()
    if (!job) return false
    const handler = this.registry[job.kind]
    if (!handler) return false
    try {
      await handler(job)
      this.finish(job, { ok: true })
    } catch (error) {
      this.finish(job, { ok: false, error })
    }
    return true
  }

  /** Drains due jobs (tests and the polling loop). */
  async drain(max = 100): Promise<number> {
    let n = 0
    while (n < max && (await this.runOnce())) n++
    return n
  }

  start(intervalMs: number): void {
    const tick = async () => {
      if (this.running) return
      this.running = true
      try { await this.drain(20) } catch (e) { console.error("[jobs] worker error", e) } finally { this.running = false }
      this.timer = setTimeout(tick, intervalMs)
    }
    this.timer = setTimeout(tick, intervalMs)
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }
}
