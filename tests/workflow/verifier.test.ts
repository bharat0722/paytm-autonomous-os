import { describe, expect, it } from "vitest"
import type { Observation } from "../../shared/contracts/core.js"
import type { ActionTargetRow } from "../../server/workflow/store.js"
import { evaluateDevice } from "../../server/workflow/verifier.js"
import { makeHarness } from "./support/harness.js"

const T0 = "2026-11-20T10:00:00.000Z"
const at = (s: number) => new Date(Date.parse(T0) + s * 1000).toISOString()
const attempt: ActionTargetRow = { action_id: "act_A", target_id: "d1", ok: 1, applied_at: at(0), prior_sequence: 10, reason: null }
let n = 0
const obs = (kind: Observation["kind"], seq: number, t: number, passed: boolean, actionId: string | null = "act_A"): Observation =>
  ({ id: `o${++n}`, deviceId: "d1", actionId, sequence: seq, occurredAt: at(t), kind, passed })
const allPass = (seq: number, t: number, actionId: string | null = "act_A") =>
  [obs("heartbeat", seq, t, true, actionId), obs("config", seq + 1, t, true, actionId), obs("notification_probe", seq + 2, t, true, actionId)]

describe("evaluateDevice", () => {
  it("passes on fresh, attributed, post-watermark signals", () => {
    expect(evaluateDevice("d1", attempt, allPass(11, 2), at(5), 60_000).check.status).toBe("PASS")
  })
  it("ignores late-arriving old observations at or below the watermark", () => {
    expect(evaluateDevice("d1", attempt, allPass(8, 2), at(5), 60_000).check.status).toBe("AWAITING")
  })
  it("ignores observations from before execution", () => {
    expect(evaluateDevice("d1", attempt, allPass(11, -5), at(5), 60_000).check.status).toBe("AWAITING")
  })
  it("does not accept a pass attributed to the wrong action", () => {
    const r = evaluateDevice("d1", attempt, allPass(11, 2, "act_OTHER"), at(5), 60_000)
    expect(r.check.status).toBe("AWAITING")
    expect(r.check.reason).toMatch(/attributed to action act_A/)
  })
  it("a newer contradictory failure invalidates an earlier pass, even after the window", () => {
    const r = evaluateDevice("d1", attempt, [...allPass(11, 2), obs("notification_probe", 20, 90, false, null)], at(100), 60_000)
    expect(r.check.status).toBe("FAIL")
    expect(r.check.reason).toMatch(/contradicts/)
  })
  it("ignores observations after the evidence cutoff", () => {
    expect(evaluateDevice("d1", attempt, allPass(11, 10), at(5), 60_000).check.status).toBe("AWAITING")
  })
  it("passes outside the observation window do not count", () => {
    expect(evaluateDevice("d1", attempt, allPass(11, 70), at(80), 60_000).check.status).toBe("AWAITING")
  })
  it("a simulator-reported failure or missing attempt fails", () => {
    expect(evaluateDevice("d1", { ...attempt, ok: 0, reason: "x" }, allPass(11, 2), at(5), 60_000).check.status).toBe("FAIL")
    expect(evaluateDevice("d1", undefined, allPass(11, 2), at(5), 60_000).check.status).toBe("FAIL")
  })
})

describe("verifier integration", () => {
  it("missing telemetry is rechecked within a bounded window, then counts as not recovered", async () => {
    const h = makeHarness()
    h.fake.telemetryOverride = ({ deviceId, kind }) => (deviceId === "sb-g1-d05" && kind === "notification_probe" ? { skip: true } : undefined)
    const id = h.inject("soundbox")
    await h.runUntil(id, ["APPROVAL_PENDING", "ESCALATED"])
    const db = h.fake.sql
    const rounds = db.all<{ round: number; final: number }>("SELECT round, final FROM wf_verifications ORDER BY round")
    expect(rounds.length).toBeGreaterThan(2) // interim rounds while pending
    expect(rounds.at(-1)!.final).toBe(1)
    const v = h.view(id)
    expect(v.recovery!.recovered).toBe(19)
    const d5 = v.recovery!.devices.find((d) => d.deviceId === "sb-g1-d05")!
    expect(d5.status).toBe("FAIL")
    expect(d5.reason).toMatch(/Missing fresh notification probe/)
    expect(v.approvals[0]!.targetDeviceIds).toContain("sb-g1-d05")
  })

  it("stale restart telemetry (wrong attribution) never closes the case", async () => {
    const h = makeHarness()
    const id = h.inject("soundbox")
    await h.runUntil(id, ["APPROVAL_PENDING"])
    // After approval, restart telemetry arrives without the restart action id.
    h.fake.telemetryOverride = ({ kind }) => (kind === "notification_probe" ? { actionId: null } : undefined)
    h.decide(id, "approve")
    expect(await h.runUntil(id, ["RESOLVED", "ESCALATED"])).toBe("ESCALATED")
    expect(h.view(id).recovery!.recovered).toBe(20)
  })

  it("a contradictory failure on a synced device after the restart blocks resolution", async () => {
    const h = makeHarness()
    const id = h.inject("soundbox")
    await h.runUntil(id, ["APPROVAL_PENDING"])
    h.decide(id, "approve")
    h.fake.addObservation({ deviceId: "sb-g1-d03", kind: "notification_probe", actionId: null, occurredAt: h.fake.clock.now(), passed: false })
    expect(await h.runUntil(id, ["RESOLVED", "ESCALATED"])).toBe("ESCALATED")
    const v = h.view(id)
    expect(v.recovery!.recovered).toBe(23)
    expect(v.recovery!.remainingDeviceIds).toEqual(["sb-g1-d03"])
  })
})
