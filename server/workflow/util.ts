import { createHash, randomUUID } from "node:crypto"
import type { CoreRuntime, Job, Sql } from "../../shared/contracts/core.js"
import type { Scope } from "../../shared/contracts/http.js"

/** Deterministic opaque id. Generation is always part of `parts`, so ids are unique across generations. */
export function opaqueId(prefix: string, ...parts: (string | number)[]): string {
  return `${prefix}_${sha256(parts.join("\u0000")).slice(0, 24)}`
}

export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex")
}

export function randomId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 24)}`
}

/** Stable JSON: object keys sorted recursively so hashes do not depend on insertion order. */
export function stableJson(value: unknown): string {
  return JSON.stringify(normalize(value))
}
function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize)
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = normalize((value as Record<string, unknown>)[key])
    }
    return out
  }
  return value
}

export function parseJson<T>(text: string | null | undefined, fallback: T): T {
  if (text == null) return fallback
  try {
    return JSON.parse(text) as T
  } catch {
    return fallback
  }
}

export function addMs(iso: string, ms: number): string {
  return new Date(Date.parse(iso) + ms).toISOString()
}

export function sortedUnique(ids: readonly string[]): string[] {
  return [...new Set(ids)].sort()
}

/** Service-level error carrying the agreed HTTP status and stable code. */
export class WorkflowError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = "WorkflowError"
  }
}

/** Raised when a job belongs to an inactive generation; the handler stops with no effect. */
export class FencedError extends Error {
  constructor(message = "Job fenced by an inactive generation") {
    super(message)
    this.name = "FencedError"
  }
}

/**
 * Every effect transaction for a job starts here: the lease must still be held and
 * the job's generation must still be active. Either failure fences the write.
 */
export function guardJob(core: CoreRuntime, tx: Sql, job: Job): void {
  core.jobs.assertLease(tx, job)
  if (core.activeGeneration(tx) !== job.generation) throw new FencedError()
}

export function assertActiveGeneration(core: CoreRuntime, q: Sql, generation: number): void {
  if (core.activeGeneration(q) !== generation) {
    throw new WorkflowError(409, "STALE_GENERATION", "The demo was reset. Refresh to continue in the current generation.")
  }
}

export function scopeOf(job: Pick<Job, "generation" | "incidentId">): Scope {
  return { generation: job.generation, incidentId: job.incidentId }
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}
