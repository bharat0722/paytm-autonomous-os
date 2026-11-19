import { describe, expect, it } from "vitest"
import { decideApproval } from "../../server/workflow/approvals.js"
import { WorkflowError } from "../../server/workflow/util.js"
import { APPROVER, OPERATOR, makeHarness } from "./support/harness.js"

function expectCode(fn: () => unknown, status: number, code: string) {
  try {
    fn()
  } catch (err) {
    expect(err).toBeInstanceOf(WorkflowError)
    expect((err as WorkflowError).status).toBe(status)
    expect((err as WorkflowError).code).toBe(code)
    return
  }
  throw new Error(`expected ${code}`)
}

async function pending() {
  const h = makeHarness()
  const id = h.inject("soundbox")
  await h.runUntil(id, ["APPROVAL_PENDING"])
  return { h, id, ap: h.pendingApproval(id) }
}

const restarts = (h: Awaited<ReturnType<typeof pending>>["h"]) => h.fake.effects().filter((e) => e.kind === "MOCK_RESTART_DEVICE")

describe("approval safety gates", () => {
  it("rejection escalates, denies the restart write and never reproposes", async () => {
    const { h, id } = await pending()
    const r = h.decide(id, "reject")
    expect(r).toMatchObject({ queued: false, approval: { status: "REJECTED", decidedBy: "approver:ap-1" } })
    await h.runner.drain()
    expect(h.status(id)).toBe("ESCALATED")
    expect(restarts(h)).toHaveLength(0)
    const v = h.view(id)
    expect(v.approvals).toHaveLength(1)
    expect(v.actions.find((a) => a.kind === "MOCK_RESTART_DEVICE")!.status).toBe("BLOCKED")
    expect(v.recovery!.recovered).toBe(20)
  })

  it("expiry is durable, escalates and rejects a late decision", async () => {
    const { h, id, ap } = await pending()
    await h.runner.drain() // runs the expiry job at expiresAt on the server clock
    expect(h.status(id)).toBe("ESCALATED")
    expect(h.view(id).approvals[0]!.status).toBe("EXPIRED")
    expectCode(() => decideApproval(h.fake.core, APPROVER, 1, ap.id, { decision: "approve", proposalRevision: ap.proposalRevision }), 409, "APPROVAL_EXPIRED")
    expect(restarts(h)).toHaveLength(0)
  })

  it("a decision after expiry but before the job runs is refused and the expiry commits", async () => {
    const { h, id, ap } = await pending()
    h.fake.clock.advance(5 * 60_000 + 1)
    expect(h.view(id).approvals[0]!.status).toBe("EXPIRED") // read model is honest before the job runs
    expect(h.workflow.countPendingApprovals(h.fake.sql, 1)).toBe(0)
    expectCode(() => decideApproval(h.fake.core, APPROVER, 1, ap.id, { decision: "approve", proposalRevision: ap.proposalRevision }), 409, "APPROVAL_EXPIRED")
    expect(h.status(id)).toBe("ESCALATED")
    await h.runner.drain()
    expect(restarts(h)).toHaveLength(0)
  })

  it("operator role, anonymous actor, altered revision, wrong generation and unknown id are denied", async () => {
    const { h, ap } = await pending()
    const body = { decision: "approve" as const, proposalRevision: ap.proposalRevision }
    expectCode(() => decideApproval(h.fake.core, OPERATOR, 1, ap.id, body), 403, "FORBIDDEN")
    expectCode(() => decideApproval(h.fake.core, null, 1, ap.id, body), 401, "UNAUTHENTICATED")
    expectCode(() => decideApproval(h.fake.core, APPROVER, 1, ap.id, { ...body, proposalRevision: "rev_tampered" }), 409, "APPROVAL_CONFLICT")
    expectCode(() => decideApproval(h.fake.core, APPROVER, 2, ap.id, body), 409, "STALE_GENERATION")
    expectCode(() => decideApproval(h.fake.core, APPROVER, 1, "apr_missing", body), 404, "NOT_FOUND")
    expect(h.view(ap.incidentId).approvals[0]!.status).toBe("PENDING")
    await h.runner.drain({ until: () => false, maxJobs: 0 })
    expect(restarts(h)).toHaveLength(0)
  })

  it("altered stored parameters invalidate the approval (hash binding)", async () => {
    const { h, ap } = await pending()
    h.fake.sql.run("UPDATE wf_approvals SET target_ids = ? WHERE id = ?", [JSON.stringify(["sb-g1-d01", "sb-g1-d21", "sb-g1-d22", "sb-g1-d23"]), ap.id])
    expectCode(() => decideApproval(h.fake.core, APPROVER, 1, ap.id, { decision: "approve", proposalRevision: ap.proposalRevision }), 409, "APPROVAL_CONFLICT")
  })

  it("identical replay returns the existing outcome; racing opposite decision conflicts; one effect", async () => {
    const { h, id, ap } = await pending()
    const body = { decision: "approve" as const, proposalRevision: ap.proposalRevision }
    const first = decideApproval(h.fake.core, APPROVER, 1, ap.id, body)
    const replay = decideApproval(h.fake.core, APPROVER, 1, ap.id, body)
    expect(replay).toEqual(first)
    expectCode(() => decideApproval(h.fake.core, APPROVER, 1, ap.id, { ...body, decision: "reject" }), 409, "APPROVAL_CONFLICT")
    expect(h.runner.pending("workflow.execute")).toHaveLength(1)
    await h.runUntil(id, ["RESOLVED"])
    // A replay after consumption still reports the original decision.
    expect(decideApproval(h.fake.core, APPROVER, 1, ap.id, body).approval.status).toBe("CONSUMED")
    expect(restarts(h)).toHaveLength(4)
  })

  it("a target changed after approval gets zero restart effects", async () => {
    const { h, id } = await pending()
    h.decide(id, "approve")
    h.fake.bumpRevision("sb-g1-d22")
    await h.runner.drain()
    expect(restarts(h)).toHaveLength(0)
    expect(h.status(id)).toBe("ESCALATED")
    const v = h.view(id)
    expect(v.actions.find((a) => a.kind === "MOCK_RESTART_DEVICE")!.status).toBe("BLOCKED")
    expect(v.approvals[0]!.status).toBe("APPROVED") // not consumed
    expect(v.audit.some((a) => a.event === "EXECUTION_BLOCKED" && /TARGET_REVISION_CHANGED/.test(a.summary))).toBe(true)
  })

  it("restart without approval is blocked at execution even if a job is forged", async () => {
    const { h, id } = await pending()
    const action = h.view(id).actions.find((a) => a.kind === "MOCK_RESTART_DEVICE")!
    h.fake.core.db.write((tx) => h.fake.core.jobs.enqueue(tx, { generation: 1, incidentId: id, key: "forged", kind: "workflow.execute", runAfter: h.fake.clock.now(), payload: { actionId: action.id } }))
    await h.runner.runOne(h.runner.claim()!)
    expect(restarts(h)).toHaveLength(0)
    expect(h.view(id).approvals[0]!.status).toBe("PENDING")
    expect(h.view(id).actions.find((a) => a.kind === "MOCK_RESTART_DEVICE")!.status).toBe("PROPOSED")
    // The legitimate path still works afterwards, with exactly one effect.
    h.decide(id, "approve")
    expect(await h.runUntil(id, ["RESOLVED", "ESCALATED"])).toBe("RESOLVED")
    expect(restarts(h)).toHaveLength(4)
  })
})
