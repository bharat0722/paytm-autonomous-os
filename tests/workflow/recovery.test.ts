import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { FakeClock, createFakeCore } from "./support/fakeCore.js"
import { makeHarness } from "./support/harness.js"

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

describe("durability, leases and generation fencing", () => {
  it("restores pending approval state after a process restart and completes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mros-wf-"))
    dirs.push(dir)
    const path = join(dir, "demo.db")
    const h1 = makeHarness({ path })
    const id = h1.inject("soundbox")
    await h1.runUntil(id, ["APPROVAL_PENDING"])
    const before = h1.view(id)
    const clockAt = h1.fake.clock.now()
    h1.fake.close()

    // New process: new core + workflow module over the same file.
    const fake2 = createFakeCore({ path, clock: new FakeClock(clockAt) })
    const h2 = makeHarness({ fake: fake2 })
    const after = h2.view(id)
    expect(after.approvals).toEqual(before.approvals)
    expect(after.recovery).toEqual(before.recovery)
    expect(h2.status(id)).toBe("APPROVAL_PENDING")
    h2.decide(id, "approve")
    expect(await h2.runUntil(id, ["RESOLVED", "ESCALATED"])).toBe("RESOLVED")
    fake2.close()
  })

  it("crash after a committed effect replays the stored result (execute, verify, investigate)", async () => {
    const h = makeHarness()
    const id = h.inject("soundbox")
    // Run every job once with a crash after commit, then let redelivery happen.
    for (let i = 0; i < 400 && !["APPROVAL_PENDING"].includes(h.status(id)); i++) {
      const job = h.runner.claim()
      if (!job) {
        const next = h.runner.pending()[0]
        if (!next) break
        h.fake.clock.set(next.run_after)
        continue
      }
      await h.runner.runOne(job, { crashAfterHandler: job.attempt === 1 })
    }
    expect(h.status(id)).toBe("APPROVAL_PENDING")
    h.decide(id, "approve")
    for (let i = 0; i < 400 && !["RESOLVED", "ESCALATED"].includes(h.status(id)); i++) {
      const job = h.runner.claim()
      if (!job) {
        const next = h.runner.pending()[0]
        if (!next) break
        h.fake.clock.set(next.run_after)
        continue
      }
      await h.runner.runOne(job, { crashAfterHandler: job.attempt === 1 })
    }
    expect(h.status(id)).toBe("RESOLVED")
    const effects = h.fake.effects()
    expect(effects.filter((e) => e.kind === "MOCK_SYNC_DEVICE_CONFIG")).toHaveLength(24)
    expect(effects.filter((e) => e.kind === "MOCK_RESTART_DEVICE")).toHaveLength(4)
    const v = h.view(id)
    expect(v.actions).toHaveLength(2)
    expect(v.approvals).toHaveLength(1)
    expect(h.runner.errors).toEqual([])
  })

  it("a stale lease cannot write", async () => {
    const h = makeHarness()
    const id = h.inject("soundbox")
    await h.runUntil(id, ["APPROVAL_PENDING"])
    h.decide(id, "approve")
    const stale = h.runner.claim()!
    expect(stale.kind).toBe("workflow.execute")
    // Lease expires and another worker claims it.
    h.fake.sql.run("UPDATE core_jobs SET status = 'queued' WHERE key = ?", [stale.key])
    const fresh = h.runner.claim()!
    await h.runner.runOne(stale)
    expect(h.runner.errors.at(-1)!.message).toBe("STALE_LEASE")
    expect(h.fake.effects().filter((e) => e.kind === "MOCK_RESTART_DEVICE")).toHaveLength(0)
    await h.runner.runOne(fresh)
    expect(h.fake.effects().filter((e) => e.kind === "MOCK_RESTART_DEVICE")).toHaveLength(4)
  })

  it("rolls back every local write when the simulator throws mid-transaction", async () => {
    const h = makeHarness()
    const id = h.inject("soundbox")
    await h.runUntil(id, ["APPROVAL_PENDING"])
    h.decide(id, "approve")
    const apply = h.fake.core.simulation.apply
    h.fake.core.simulation.apply = () => { throw new Error("simulator down") }
    const job = h.runner.claim()!
    await h.runner.runOne(job)
    const v = h.view(id)
    expect(v.approvals[0]!.status).toBe("APPROVED") // consumption rolled back
    expect(v.actions.find((a) => a.kind === "MOCK_RESTART_DEVICE")!.status).toBe("PROPOSED")
    expect(v.audit.some((a) => a.event === "APPROVAL_CONSUMED")).toBe(false)
    expect(h.status(id)).toBe("ACTION_RUNNING")
    h.fake.core.simulation.apply = apply
    expect(await h.runUntil(id, ["RESOLVED", "ESCALATED"])).toBe("RESOLVED")
    expect(h.fake.effects().filter((e) => e.kind === "MOCK_RESTART_DEVICE")).toHaveLength(4)
  })

  it("reset fences old-generation jobs; the new generation is unaffected", async () => {
    const h = makeHarness()
    const oldId = h.inject("soundbox")
    await h.runUntil(oldId, ["APPROVAL_PENDING"])
    h.decide(oldId, "approve") // queues an execute job in generation 1
    expect(h.fake.reset()).toBe(2)
    const newId = h.inject("soundbox")
    await h.runner.drain({ until: () => h.status(newId) === "APPROVAL_PENDING" })
    expect(h.fake.effects().filter((e) => e.kind === "MOCK_RESTART_DEVICE")).toHaveLength(0)
    expect(h.status(oldId)).toBe("ACTION_RUNNING") // frozen in the old generation
    expect(h.workflow.countPendingApprovals(h.fake.sql, 2)).toBe(1)
    expect(h.workflow.countPendingApprovals(h.fake.sql, 1)).toBe(0) // old pending approval is not counted in gen 2
    h.decide(newId, "approve")
    expect(await h.runUntil(newId, ["RESOLVED"])).toBe("RESOLVED")
    expect(h.fake.effects().filter((e) => e.kind === "MOCK_RESTART_DEVICE" && e.target_id.startsWith("sb-g1"))).toHaveLength(0)
  })

  it("three clean resets each rehearse the full success path", async () => {
    const h = makeHarness()
    for (let i = 0; i < 3; i++) {
      if (i > 0) h.fake.reset()
      const id = h.inject("soundbox")
      await h.runUntil(id, ["APPROVAL_PENDING"])
      expect(h.view(id).recovery!.recovered).toBe(20)
      h.decide(id, "approve")
      expect(await h.runUntil(id, ["RESOLVED", "ESCALATED"])).toBe("RESOLVED")
      expect(h.view(id).recovery!.recovered).toBe(24)
    }
    expect(h.fake.effects().filter((e) => e.kind === "MOCK_RESTART_DEVICE")).toHaveLength(12)
  })

  it("duplicate investigation delivery creates one action per workflow intent", async () => {
    const h = makeHarness()
    const id = h.inject("soundbox")
    // Duplicate enqueue is deduplicated by stable key; replay of the finished job is a no-op.
    h.fake.core.db.write((tx) => h.fake.core.jobs.enqueue(tx, { generation: 1, incidentId: id, key: `investigate:${id}:initial`, kind: "workflow.investigate", runAfter: h.fake.clock.now(), payload: {} }))
    const job = h.runner.claim()!
    await h.runner.runOne(job)
    await h.workflow.handlers["workflow.investigate"]!({ ...job, leaseToken: "replayed" }).catch(() => undefined)
    await h.runUntil(id, ["APPROVAL_PENDING"])
    expect(h.view(id).actions.filter((a) => a.kind === "MOCK_SYNC_DEVICE_CONFIG")).toHaveLength(1)
  })
})
