import { describe, expect, it } from "vitest"
import { WorkflowViewSchema } from "../../shared/contracts/http.js"
import { makeHarness } from "./support/harness.js"

describe("Soundbox hero flow (scripted, real SQLite)", () => {
  it("one approval leads to exactly one restart effect", async () => {
    const h = makeHarness()
    const id = h.inject("soundbox")
    expect(await h.runUntil(id, ["APPROVAL_PENDING"])).toBe("APPROVAL_PENDING")
    const result = h.decide(id, "approve")
    expect(result.queued).toBe(true)
    expect(result.approval.status).toBe("APPROVED")
    await h.runUntil(id, ["RESOLVED", "ESCALATED"])
    const restarts = h.fake.effects().filter((e) => e.kind === "MOCK_RESTART_DEVICE")
    expect(restarts).toHaveLength(4)
    expect(new Set(restarts.map((r) => r.action_id)).size).toBe(1)
  })

  it("reads real records, syncs, verifies 20/24, approves exactly four, verifies 24/24", async () => {
    const h = makeHarness()
    const id = h.inject("soundbox")
    await h.runUntil(id, ["APPROVAL_PENDING"])

    const v1 = h.view(id)
    WorkflowViewSchema.parse(v1)
    // A real DB read precedes sync.
    const readIdx = v1.trace.findIndex((t) => t.tool === "read_devices")
    const syncIdx = v1.trace.findIndex((t) => t.summary.includes("ACTION_RUNNING"))
    expect(readIdx).toBeGreaterThanOrEqual(0)
    expect(readIdx).toBeLessThan(syncIdx)
    expect(v1.trace[readIdx]!.evidenceIds).toHaveLength(24)
    expect(v1.trace.every((t) => t.mode !== "live_ai")).toBe(true)
    expect(v1.trace.some((t) => t.mode === "scripted_fallback" && /INVESTIGATOR_MODE=scripted/.test(t.summary))).toBe(true)

    // Persisted devices changed and fresh observations give 20/24.
    expect(h.fake.effects().filter((e) => e.kind === "MOCK_SYNC_DEVICE_CONFIG")).toHaveLength(24)
    expect(v1.recovery).toMatchObject({ total: 24, recovered: 20, beforeRecovered: 0 })
    expect(v1.recovery!.remainingDeviceIds).toEqual(["sb-g1-d21", "sb-g1-d22", "sb-g1-d23", "sb-g1-d24"])
    expect(v1.finding?.hypothesis).toBeTruthy()

    // Exactly one four-device approval.
    expect(v1.approvals).toHaveLength(1)
    const ap = v1.approvals[0]!
    expect(ap).toMatchObject({ kind: "MOCK_RESTART_DEVICE", status: "PENDING", ruleId: "DEVICE_RESTART_REQUIRES_APPROVAL" })
    expect(ap.targetDeviceIds).toEqual(["sb-g1-d21", "sb-g1-d22", "sb-g1-d23", "sb-g1-d24"])
    expect(Date.parse(ap.expiresAt) - Date.parse(ap.createdAt)).toBe(5 * 60_000)
    expect(h.workflow.countPendingApprovals(h.fake.sql, 1)).toBe(1)

    h.decide(id, "approve")
    expect(await h.runUntil(id, ["RESOLVED", "ESCALATED"])).toBe("RESOLVED")
    const v2 = h.view(id)
    expect(v2.recovery).toMatchObject({ total: 24, recovered: 24, beforeRecovered: 20, remainingDeviceIds: [] })
    // The four restarted devices pass on fresh restart observations; the 20 keep their sync passes.
    const restartAction = v2.actions.find((a) => a.kind === "MOCK_RESTART_DEVICE")!
    for (const d of v2.recovery!.devices) {
      expect(d.status).toBe("PASS")
      if (ap.targetDeviceIds.includes(d.deviceId)) expect(d.actionId).toBe(restartAction.id)
      else expect(d.actionId).not.toBe(restartAction.id)
    }
    expect(v2.approvals[0]!.status).toBe("CONSUMED")
    expect(v2.audit.map((a) => a.event)).toEqual(expect.arrayContaining([
      "ACTION_AUTHORIZED", "ACTION_EXECUTED", "VERIFICATION_RECORDED", "APPROVAL_REQUESTED", "APPROVAL_APPROVED", "APPROVAL_CONSUMED",
    ]))
    expect(h.fake.core.db.read((q) => q.get<{ verified_check_id: string }>("SELECT verified_check_id FROM core_incidents WHERE id = ?", [id]))!.verified_check_id)
      .toBe(v2.recovery!.id)
    expect(h.workflow.countPendingApprovals(h.fake.sql, 1)).toBe(0)
    expect(h.runner.errors).toEqual([])
  })

  it("soundbox/partial: approved restart yields 23/24 and escalates, never resolves", async () => {
    const h = makeHarness()
    const id = h.inject("soundbox", "partial")
    await h.runUntil(id, ["APPROVAL_PENDING"])
    h.decide(id, "approve")
    expect(await h.runUntil(id, ["RESOLVED", "ESCALATED"])).toBe("ESCALATED")
    const v = h.view(id)
    expect(v.recovery).toMatchObject({ recovered: 23, total: 24, remainingDeviceIds: ["sb-g1-d24"] })
    expect(h.fake.incident(id).owner).toBe("Field Operations")
    expect(h.fake.incident(id).blocker).toMatch(/23\/24/)
    // No automatic reproposal.
    expect(v.approvals).toHaveLength(1)
    await h.runner.drain()
    expect(h.status(id)).toBe("ESCALATED")
  })
})
