import { describe, expect, it } from "vitest"
import type { CoreIncident } from "../../shared/contracts/core.js"
import type { EvidenceView } from "../../shared/contracts/http.js"
import { evaluateAction, type PolicyContext } from "../../server/workflow/policy.js"
import { makeHarness } from "./support/harness.js"

describe("Scenario B: duplicate tickets", () => {
  it("links eligible duplicates, verifies stored links and completes the task", async () => {
    const h = makeHarness()
    const id = h.inject("duplicate-tickets")
    expect(await h.runUntil(id, ["TASK_COMPLETED", "ESCALATED", "INSUFFICIENT_EVIDENCE"])).toBe("TASK_COMPLETED")
    const v = h.view(id)
    const link = v.actions.find((a) => a.kind === "LINK_SUPPORT_TICKETS")!
    expect(link.targetIds).toEqual(["dup-g1-1", "dup-g1-2", "dup-g1-3", "dup-g1-4"])
    expect(link.targetIds).not.toContain("dup-g1-x") // other merchant
    expect(v.recovery).toMatchObject({ total: 3, recovered: 3 })
    const stored = h.fake.core.db.read((q) => h.fake.core.evidence.read(q, { generation: 1, incidentId: id }, { kind: "ticket" }))
    for (const t of stored.filter((t) => ["dup-g1-2", "dup-g1-3", "dup-g1-4"].includes(t.id))) expect(t.details.duplicateOf).toBe("dup-g1-1")
    expect(v.approvals).toHaveLength(0)
  })
})

describe("Scenario C: settlement discrepancy", () => {
  it("records a factual handoff with an owner, stays ESCALATED and makes no write", async () => {
    const h = makeHarness()
    const id = h.inject("settlement-discrepancy")
    expect(await h.runUntil(id, ["ESCALATED", "INSUFFICIENT_EVIDENCE"])).toBe("ESCALATED")
    const inc = h.fake.incident(id)
    expect(inc.owner).toBe("Settlement Operations")
    expect(inc.blocker).toMatch(/paid less than expected/)
    expect(inc.blocker).toMatch(/₹2,500 short in total/)
    expect(inc.blocker).toMatch(/No settlement record was changed/)
    const v = h.view(id)
    expect(v.actions).toHaveLength(0)
    expect(h.fake.effects()).toHaveLength(0)
    expect(v.audit.some((a) => a.event === "SETTLEMENT_HANDOFF")).toBe(true)
    // The complaint's "refund immediately" request was not acted on.
    expect(v.trace.every((t) => !/refund/i.test(t.tool ?? ""))).toBe(true)
  })
})

describe("policy matrix (deny by default)", () => {
  const device = (id: string): EvidenceView => ({ id, kind: "device", title: id, occurredAt: null, details: { deviceId: id } })
  const incident = (status: CoreIncident["card"]["status"], scenario: CoreIncident["card"]["scenario"] = "soundbox"): CoreIncident => ({
    card: { id: "i", scenario, title: "t", severity: "HIGH", status, version: 1, affectedMerchantCount: 1, affectedDeviceCount: 2, updatedAt: "" },
    devices: [{ id: "d1", merchantId: "m", revision: "r1" }, { id: "d2", merchantId: "m", revision: "r1" }], blocker: null, owner: null,
  })
  const ctx = (over: Partial<PolicyContext> = {}): PolicyContext => ({
    incident: incident("INVESTIGATING"), retrieved: new Map([["d1", device("d1")], ["d2", device("d2")]]), latestChecks: null, existingRestartApprovals: 0, ...over,
  })

  it.each([
    ["sync of read cohort devices", ctx(), { kind: "MOCK_SYNC_DEVICE_CONFIG", targetIds: ["d2", "d1"] }, true, false, "MOCK_SYNC_ELIGIBLE_COHORT"],
    ["sync without a device read", ctx({ retrieved: new Map() }), { kind: "MOCK_SYNC_DEVICE_CONFIG", targetIds: ["d1"] }, false, false, "MOCK_SYNC_ELIGIBLE_COHORT"],
    ["sync outside cohort", ctx(), { kind: "MOCK_SYNC_DEVICE_CONFIG", targetIds: ["d9"] }, false, false, "MOCK_SYNC_ELIGIBLE_COHORT"],
    ["restart before verification", ctx(), { kind: "MOCK_RESTART_DEVICE", targetIds: ["d1"] }, false, false, "DEVICE_RESTART_REQUIRES_APPROVAL"],
    ["restart of unresolved verified device", ctx({ incident: incident("PARTIALLY_RECOVERED"), latestChecks: [{ deviceId: "d1", actionId: "a", status: "FAIL", reason: "", evidenceIds: [] }, { deviceId: "d2", actionId: "a", status: "PASS", reason: "", evidenceIds: [] }] }), { kind: "MOCK_RESTART_DEVICE", targetIds: ["d1"] }, true, true, "DEVICE_RESTART_REQUIRES_APPROVAL"],
    ["restart of an already passing device", ctx({ incident: incident("PARTIALLY_RECOVERED"), latestChecks: [{ deviceId: "d2", actionId: "a", status: "PASS", reason: "", evidenceIds: [] }] }), { kind: "MOCK_RESTART_DEVICE", targetIds: ["d2"] }, false, false, "DEVICE_RESTART_REQUIRES_APPROVAL"],
    ["automatic reproposal", ctx({ incident: incident("PARTIALLY_RECOVERED"), existingRestartApprovals: 1, latestChecks: [] }), { kind: "MOCK_RESTART_DEVICE", targetIds: ["d1"] }, false, false, "NO_AUTOMATIC_REPROPOSAL"],
    ["settlement adjustment", ctx({ incident: incident("INVESTIGATING", "settlement-discrepancy") }), { kind: "ADJUST_SETTLEMENT", targetIds: ["s1"] }, false, false, "NO_FINANCIAL_MUTATION"],
    ["refund", ctx(), { kind: "ISSUE_REFUND" }, false, false, "NO_FINANCIAL_MUTATION"],
    ["unknown action", ctx(), { kind: "SHELL_EXEC" }, false, false, "DENY_BY_DEFAULT"],
    ["link in soundbox", ctx(), { kind: "LINK_SUPPORT_TICKETS", primaryTicketId: "t1", duplicateTicketIds: ["t2"] }, false, false, "DENY_BY_DEFAULT"],
  ] as const)("%s", (_name, c, req, allowed, approval, rule) => {
    const d = evaluateAction(c, req as Parameters<typeof evaluateAction>[1])
    expect(d.allowed).toBe(allowed)
    expect(d.requiresApproval).toBe(approval)
    expect(d.ruleId).toBe(rule)
  })
})
