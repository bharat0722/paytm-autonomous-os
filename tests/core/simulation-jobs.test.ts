import { afterEach, describe, expect, it } from "vitest"
import { activeGeneration, resetDemo } from "../../server/core/generations.js"
import { injectScenario } from "../../server/core/inject.js"
import { JobRunner } from "../../server/core/jobs.js"
import { emitTelemetry } from "../../server/core/simulation.js"
import { PRIVATE_FIXTURE } from "../../server/core/seed.js"
import { CoreError, type Job } from "../../shared/contracts/core.js"
import { makeCore } from "./helpers.js"

const cores: { cleanup(): void }[] = []
afterEach(() => { while (cores.length) cores.pop()!.cleanup() })

function setup(variant: "success" | "partial" = "success") {
  const c = makeCore(); cores.push(c)
  const generation = c.db.read((q) => activeGeneration(q))
  const { incidentId } = injectScenario(c.db, c.clock, generation, "soundbox", variant)
  const scope = { generation, incidentId }
  const roster = c.runtime.db.read((q) => c.runtime.incidents.get(q, scope))!.devices
  return { c, scope, roster }
}

/** Latest notification_probe per device. */
function probeStatus(c: ReturnType<typeof makeCore>, scope: { generation: number; incidentId: string }, ids: string[]) {
  const obs = c.runtime.db.read((q) => c.runtime.evidence.observations(q, scope, ids))
  const latest = new Map<string, boolean>()
  for (const o of obs) if (o.kind === "notification_probe") latest.set(o.deviceId, o.passed)
  return latest
}

const refOf = (c: ReturnType<typeof makeCore>, id: string) => c.db.read((q) => q.get<{ s: string }>("SELECT seed_ref AS s FROM devices WHERE id = ?", [id])!.s)

describe("simulation + telemetry", () => {
  it("sync -> 20/24 pass; restart of exactly the 4 failing -> 24/24 (success variant)", async () => {
    const { c, scope, roster } = setup("success")
    const ids = roster.map((d) => d.id)
    const sync = c.runtime.db.write((tx) => c.runtime.simulation.apply(tx, scope, { actionId: "act_sync_1", kind: "MOCK_SYNC_DEVICE_CONFIG", targetIds: ids }))
    expect(sync.every((t) => t.ok)).toBe(true)
    expect(await c.runner.drain()).toBe(1) // core.telemetry only (no workflow registered)
    let status = probeStatus(c, scope, ids)
    const failing = ids.filter((id) => status.get(id) === false)
    expect([...status.values()].filter(Boolean)).toHaveLength(20)
    expect(failing.map((id) => refOf(c, id)).sort()).toEqual([...PRIVATE_FIXTURE.needsRestartRefs].sort())
    // Persisted devices changed revision.
    const after = c.runtime.db.read((q) => c.runtime.incidents.get(q, scope))!.devices
    expect(after.every((d) => d.revision === "2")).toBe(true)

    c.runtime.db.write((tx) => c.runtime.simulation.apply(tx, scope, { actionId: "act_restart_1", kind: "MOCK_RESTART_DEVICE", targetIds: failing }))
    await c.runner.drain()
    status = probeStatus(c, scope, ids)
    expect([...status.values()].filter(Boolean)).toHaveLength(24)
  })

  it("partial variant leaves exactly one device failing after restart (23/24)", async () => {
    const { c, scope, roster } = setup("partial")
    const ids = roster.map((d) => d.id)
    c.runtime.db.write((tx) => c.runtime.simulation.apply(tx, scope, { actionId: "s", kind: "MOCK_SYNC_DEVICE_CONFIG", targetIds: ids }))
    await c.runner.drain()
    const failing = ids.filter((id) => probeStatus(c, scope, ids).get(id) === false)
    c.runtime.db.write((tx) => c.runtime.simulation.apply(tx, scope, { actionId: "r", kind: "MOCK_RESTART_DEVICE", targetIds: failing }))
    await c.runner.drain()
    const status = probeStatus(c, scope, ids)
    const stillFailing = ids.filter((id) => status.get(id) === false)
    expect(stillFailing.map((id) => refOf(c, id))).toEqual([PRIVATE_FIXTURE.partialFailRef])
  })

  it("replaying an action returns the stored result with no second effect; changed params conflict", async () => {
    const { c, scope, roster } = setup()
    const targets = roster.slice(0, 4).map((d) => d.id)
    const first = c.runtime.db.write((tx) => c.runtime.simulation.apply(tx, scope, { actionId: "dup", kind: "MOCK_RESTART_DEVICE", targetIds: targets }))
    const again = c.runtime.db.write((tx) => c.runtime.simulation.apply(tx, scope, { actionId: "dup", kind: "MOCK_RESTART_DEVICE", targetIds: targets }))
    expect(again).toEqual(first)
    const revisions = c.db.read((q) => q.all<{ r: number }>(`SELECT revision AS r FROM devices WHERE id IN (${targets.map(() => "?").join(",")})`, targets))
    expect(revisions.every((r) => r.r === 2)).toBe(true)
    expect(() => c.runtime.db.write((tx) => c.runtime.simulation.apply(tx, scope, { actionId: "dup", kind: "MOCK_RESTART_DEVICE", targetIds: targets.slice(0, 2) }))).toThrow(CoreError)
    expect(await c.runner.drain()).toBe(1)
  })

  it("targets outside the cohort are refused per target", () => {
    const { c, scope } = setup()
    const outsider = c.db.read((q) => q.get<{ id: string }>("SELECT id FROM devices WHERE seed_ref = 'D-M080-1' AND generation = ?", [scope.generation])!.id)
    const res = c.runtime.db.write((tx) => c.runtime.simulation.apply(tx, scope, { actionId: "x", kind: "MOCK_RESTART_DEVICE", targetIds: [outsider] }))
    expect(res[0]).toMatchObject({ ok: false, reason: "not in incident cohort" })
  })

  it("telemetry retries produce one set of observations with monotonic sequences", async () => {
    const { c, scope, roster } = setup()
    const ids = roster.map((d) => d.id)
    c.runtime.db.write((tx) => c.runtime.simulation.apply(tx, scope, { actionId: "t1", kind: "MOCK_SYNC_DEVICE_CONFIG", targetIds: ids }))
    const job = new JobRunner(c.db, c.clock, { "core.telemetry": async () => {} }).claim()!
    expect(c.db.write((tx) => emitTelemetry(tx, job))).toBe(72)
    expect(c.db.write((tx) => emitTelemetry(tx, job))).toBe(0)
    const seqs = c.runtime.db.read((q) => c.runtime.evidence.observations(q, scope, ids)).map((o) => o.sequence)
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
    expect(new Set(seqs).size).toBe(seqs.length)
  })

  it("delayed old-generation telemetry cannot affect the new demo", async () => {
    const { c, scope, roster } = setup()
    c.runtime.db.write((tx) => c.runtime.simulation.apply(tx, scope, { actionId: "old", kind: "MOCK_SYNC_DEVICE_CONFIG", targetIds: roster.map((d) => d.id) }))
    const runner = new JobRunner(c.db, c.clock, { "core.telemetry": async () => {} })
    const staleJob = runner.claim()!
    const newGen = resetDemo(c.db, c.clock, scope.generation)
    expect(newGen).toBe(scope.generation + 1)
    expect(() => c.db.write((tx) => emitTelemetry(tx, staleJob))).toThrow(/Lease lost|no longer active/)
    const obs = c.db.read((q) => q.get<{ c: number }>("SELECT COUNT(*) AS c FROM observations")!.c)
    expect(obs).toBe(0)
    expect(() => c.runtime.db.write((tx) => c.runtime.simulation.apply(tx, scope, { actionId: "late", kind: "MOCK_RESTART_DEVICE", targetIds: [roster[0]!.id] }))).toThrow(/no longer active/)
  })

  it("ticket linking links eligible duplicates and guards existing conflicting links; settlements stay read-only", () => {
    const c = makeCore(); cores.push(c)
    const generation = c.db.read((q) => activeGeneration(q))
    const b = injectScenario(c.db, c.clock, generation, "duplicate-tickets", "success")
    const s = injectScenario(c.db, c.clock, generation, "settlement-discrepancy", "success")
    const scope = { generation, incidentId: b.incidentId }
    const tickets = c.runtime.db.read((q) => c.runtime.evidence.read(q, scope, { kind: "ticket", limit: 200 })).map((t) => t.id)
    const settlementsBefore = c.db.read((q) => q.all("SELECT * FROM settlements ORDER BY id"))
    const res = c.runtime.db.write((tx) => c.runtime.simulation.apply(tx, scope, { actionId: "link1", kind: "LINK_SUPPORT_TICKETS", targetIds: tickets }))
    expect(res.filter((r) => r.reason === "already linked to a different ticket")).toHaveLength(1)
    expect(res.filter((r) => r.reason === "primary ticket (kept open)")).toHaveLength(6)
    const linked = c.db.read((q) => q.get<{ c: number }>("SELECT COUNT(*) AS c FROM tickets WHERE status = 'LINKED_DUPLICATE'")!.c)
    expect(linked).toBe(7)
    // No financial mutation port exists and nothing touched settlements.
    expect(Object.keys(c.runtime.simulation)).toEqual(["apply"])
    expect(() => c.runtime.db.write((tx) => c.runtime.simulation.apply(tx, { generation, incidentId: s.incidentId },
      { actionId: "fin", kind: "MOCK_SYNC_DEVICE_CONFIG", targetIds: ["anything"] }))).not.toThrow()
    expect(c.db.read((q) => q.all("SELECT * FROM settlements ORDER BY id"))).toEqual(settlementsBefore)
  })
})

describe("jobs", () => {
  it("dedupes stable keys, leases, retries with backoff, then fails after max attempts", async () => {
    const c = makeCore(); cores.push(c)
    const generation = c.db.read((q) => activeGeneration(q))
    const { incidentId } = injectScenario(c.db, c.clock, generation, "soundbox", "success")
    let calls = 0
    const runner = new JobRunner(c.db, c.clock, { "workflow.investigate": async () => { calls++; throw new Error("boom") } }, { leaseMs: 1000, maxAttempts: 3 })
    c.runtime.db.write((tx) => c.runtime.jobs.enqueue(tx, { generation, incidentId, key: `investigate:${incidentId}:initial`, kind: "workflow.investigate", runAfter: c.clock.now(), payload: {} }))
    for (let i = 0; i < 3; i++) { await runner.runOnce(); c.clock.advance(10_000) }
    expect(calls).toBe(3)
    const row = c.db.read((q) => q.get<{ status: string; attempt: number }>("SELECT status, attempt FROM jobs WHERE kind = 'workflow.investigate'"))
    expect(row).toEqual({ status: "FAILED", attempt: 3 })
  })

  it("recovers an expired lease after a crash, and a stale worker is fenced on effect", async () => {
    const c = makeCore(); cores.push(c)
    const generation = c.db.read((q) => activeGeneration(q))
    injectScenario(c.db, c.clock, generation, "soundbox", "success")
    const runner = new JobRunner(c.db, c.clock, { "workflow.investigate": async () => {} }, { leaseMs: 1000, maxAttempts: 5 })
    const crashed = runner.claim()! // worker "crashes" holding the lease
    expect(runner.claim()).toBeNull()
    c.clock.advance(2000)
    const recovered = runner.claim()!
    expect(recovered.key).toBe(crashed.key)
    expect(recovered.attempt).toBe(2)
    expect(() => c.db.write((tx) => c.runtime.jobs.assertLease(tx, crashed))).toThrow(/Lease lost/)
    expect(() => c.db.write((tx) => c.runtime.jobs.assertLease(tx, recovered))).not.toThrow()
  })

  it("claims only registered kinds and only in the active generation", () => {
    const c = makeCore(); cores.push(c)
    const generation = c.db.read((q) => activeGeneration(q))
    injectScenario(c.db, c.clock, generation, "soundbox", "success")
    expect(new JobRunner(c.db, c.clock, { "core.telemetry": async () => {} }).claim()).toBeNull()
    resetDemo(c.db, c.clock, generation)
    const job: Job | null = new JobRunner(c.db, c.clock, { "workflow.investigate": async () => {} }).claim()
    expect(job).toBeNull()
    const cancelled = c.db.read((q) => q.get<{ status: string }>("SELECT status FROM jobs WHERE generation = ?", [generation])!.status)
    expect(cancelled).toBe("CANCELLED")
  })
})

describe("incident transitions", () => {
  it("enforce legal edges, expected version, verifier check for RESOLVED and active generation", () => {
    const { c, scope } = setup()
    const tr = (status: Parameters<typeof c.runtime.incidents.transition>[2]["status"], expectedVersion: number, verifiedCheckId?: string) =>
      c.runtime.db.write((tx) => c.runtime.incidents.transition(tx, scope, { expectedVersion, status, blocker: null, owner: null, ...(verifiedCheckId ? { verifiedCheckId } : {}) }))
    expect(() => tr("RESOLVED", 1, "chk")).toThrow(/Illegal transition/)
    expect(tr("INVESTIGATING", 1).card.version).toBe(2)
    expect(() => tr("ACTION_RUNNING", 1)).toThrow(/expected 1/)
    tr("ACTION_RUNNING", 2); tr("VERIFYING", 3)
    expect(tr("VERIFYING", 4).card.status).toBe("VERIFYING")
    expect(() => tr("RESOLVED", 5)).toThrow(/verifier-owned check/)
    expect(tr("RESOLVED", 5, "chk_1").card.status).toBe("RESOLVED")
    resetDemo(c.db, c.clock, scope.generation)
    expect(() => tr("ESCALATED", 6)).toThrow(/no longer active/)
  })
})
