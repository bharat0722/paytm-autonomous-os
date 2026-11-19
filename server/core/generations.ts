// Generation lifecycle: bootstrap, active lookup and atomic reset with fencing.
import { CoreError, type Sql } from "../../shared/contracts/core.js"
import type { CoreDb } from "./db.js"
import { seedGeneration, TELEMETRY_BASE } from "./seed.js"
import type { Clock } from "./util.js"

export function activeGeneration(q: Sql): number {
  const row = q.get<{ value: string }>("SELECT value FROM meta WHERE key = 'active_generation'")
  if (!row) throw new CoreError("NOT_FOUND", "No active generation; the demo is not bootstrapped.")
  return Number(row.value)
}

export function assertActive(q: Sql, generation: number): void {
  const active = activeGeneration(q)
  if (generation !== active) throw new CoreError("STALE_GENERATION", `Generation ${generation} is no longer active (active: ${active}).`)
}

function createGeneration(tx: Sql, clock: Clock): number {
  const max = tx.get<{ m: number | null }>("SELECT MAX(id) AS m FROM generations")?.m ?? 0
  const generation = max + 1
  tx.run("INSERT INTO generations (id, created_at, telemetry_seq, telemetry_clock) VALUES (?,?,0,?)", [generation, clock.now(), TELEMETRY_BASE])
  tx.run("INSERT INTO meta (key, value) VALUES ('active_generation', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [String(generation)])
  seedGeneration(tx, generation)
  return generation
}

/** Ensures generation >= 1 exists. Idempotent across restarts. */
export function ensureBootstrapped(db: CoreDb, clock: Clock): number {
  return db.write((tx) => {
    const row = tx.get<{ value: string }>("SELECT value FROM meta WHERE key = 'active_generation'")
    return row ? Number(row.value) : createGeneration(tx, clock)
  })
}

/**
 * Atomic reset. Archives the old generation (rows are kept but never read again),
 * cancels its jobs so stale workers are fenced, and seeds a fresh generation.
 * Sessions are not generation-scoped: the browser keeps its session and refetches.
 */
export function resetDemo(db: CoreDb, clock: Clock, expectedGeneration: number): number {
  return db.write((tx) => {
    assertActive(tx, expectedGeneration)
    const now = clock.now()
    tx.run("UPDATE generations SET archived_at = ? WHERE id = ?", [now, expectedGeneration])
    tx.run("UPDATE jobs SET status = 'CANCELLED', lease_token = NULL, updated_at = ? WHERE generation = ? AND status IN ('PENDING','LEASED')",
      [now, expectedGeneration])
    return createGeneration(tx, clock)
  })
}

/** Simulated telemetry time (distinct from server time used for approval expiry). */
export function telemetryNow(q: Sql, generation: number): string {
  const row = q.get<{ telemetry_clock: string }>("SELECT telemetry_clock FROM generations WHERE id = ?", [generation])
  if (!row) throw new CoreError("NOT_FOUND", "Unknown generation")
  return row.telemetry_clock
}

export function advanceTelemetry(tx: Sql, generation: number, ms: number): string {
  const current = telemetryNow(tx, generation)
  const next = new Date(Date.parse(current) + ms).toISOString()
  tx.run("UPDATE generations SET telemetry_clock = ? WHERE id = ?", [next, generation])
  return next
}

export function nextTelemetrySequence(tx: Sql, generation: number): number {
  tx.run("UPDATE generations SET telemetry_seq = telemetry_seq + 1 WHERE id = ?", [generation])
  return tx.get<{ s: number }>("SELECT telemetry_seq AS s FROM generations WHERE id = ?", [generation])!.s
}

export function telemetryWatermark(q: Sql, generation: number): number {
  return q.get<{ s: number }>("SELECT telemetry_seq AS s FROM generations WHERE id = ?", [generation])?.s ?? 0
}
