// Process playbook + unpaid-order scenario over the real app: platform, simulator and workflow assembled.
import request from "supertest"
import { afterEach, describe, expect, it } from "vitest"
import { DEFAULT_OPTIONS } from "../../server/workflow/config.js"
import { createWorkflowWith } from "../../server/workflow/index.js"
import { IncidentViewSchema, PlaybookViewSchema, type IncidentStatus, type PlaybookView, type Scenario } from "../../shared/contracts/http.js"
import { PLAYBOOKS } from "../../shared/contracts/playbooks.js"
import { TEST_CODES, makeCore } from "../core/helpers.js"

type Core = ReturnType<typeof makeCore>
const cores: Core[] = []
afterEach(() => { for (const c of cores.splice(0)) c.cleanup() })

function setup() {
  const core = makeCore({
    createWorkflow: (rt) => createWorkflowWith(rt, { ...DEFAULT_OPTIONS, investigatorMode: "scripted", provider: null, providerUnavailableReason: null }),
  })
  cores.push(core)
  return core
}
async function signIn(core: Core, role: "operator" | "approver") {
  const agent = request.agent(core.app)
  const res = await agent.post("/api/v1/demo/session").send({ role, accessCode: TEST_CODES[role] })
  expect(res.status).toBe(200)
  return { agent, csrf: res.body.data.csrfToken as string, generation: res.body.data.generation as number }
}
type Session = Awaited<ReturnType<typeof signIn>>

async function status(op: Session, id: string): Promise<IncidentStatus> {
  const res = await op.agent.get(`/api/v1/incidents/${id}`)
  return IncidentViewSchema.parse(res.body.data).incident.status
}
async function runUntil(core: Core, op: Session, id: string, statuses: IncidentStatus[]) {
  for (let i = 0; i < 400; i++) {
    await core.runner.drain(50)
    const s = await status(op, id)
    if (statuses.includes(s)) return s
    core.clock.advance(1_000)
  }
  throw new Error(`incident never reached ${statuses.join("|")}`)
}
async function inject(op: Session, scenario: Scenario, variant: "success" | "partial" = "success") {
  const res = await op.agent.post(`/api/v1/demo/inject/${scenario}`).set("X-CSRF-Token", op.csrf).set("X-Demo-Generation", String(op.generation)).send({ variant })
  expect(res.status).toBe(200)
  return res.body.data.incidentId as string
}
async function playbook(op: Session, id: string): Promise<PlaybookView> {
  const res = await op.agent.get(`/api/v1/incidents/${id}/playbook`)
  expect(res.status).toBe(200)
  return PlaybookViewSchema.parse(res.body.data)
}
const step = (pb: PlaybookView, id: string) => pb.steps.find((s) => s.id === id)!

describe("unpaid order scenario (Payment Gateway)", () => {
  it("groups the 4 failed-webhook orders, excludes decoys, resends and verifies all PAID", async () => {
    const core = setup()
    const op = await signIn(core, "operator")
    const id = await inject(op, "order-unpaid", "success")
    expect(await runUntil(core, op, id, ["RESOLVED", "ESCALATED", "FAILED", "INSUFFICIENT_EVIDENCE"])).toBe("RESOLVED")

    const view = IncidentViewSchema.parse((await op.agent.get(`/api/v1/incidents/${id}`)).body.data)
    expect(view.evidence.filter((e) => e.kind === "order")).toHaveLength(4)
    expect(view.evidence.every((e) => e.kind !== "order" || e.details.merchantStatus === "PAID")).toBe(true)
    expect(view.workflow.recovery).toMatchObject({ total: 4, recovered: 4 })
    expect(view.workflow.actions.map((a) => a.kind)).toEqual(["RESEND_WEBHOOK"])
    expect(view.workflow.actions[0]!.ruleId).toBe("RESEND_ELIGIBLE_WEBHOOKS")

    const pb = await playbook(op, id)
    expect(pb.steps.map((s) => s.id)).toEqual(PLAYBOOKS["order-unpaid"].steps.map((s) => s.id))
    expect(pb.steps.every((s) => s.status === "done")).toBe(true)
    // Detection records what was grouped and what was left out as a different cause.
    const detect = step(pb, "detect").entries[0]!.response as { excludedAsDifferentCause: { reason: string }[] }
    expect(detect.excludedAsDifferentCause.length).toBeGreaterThanOrEqual(2)
    // Every read says what it hit; the Status API call shows the Paytm response codes.
    const status = step(pb, "investigate").entries.find((e) => e.endpoint === "/v3/order/status")!
    expect(status.system).toMatch(/Transaction Status API/)
    expect((status.response as { records: { STATUS: string; RESPCODE: string }[] }).records.every((r) => r.STATUS === "TXN_SUCCESS" && r.RESPCODE === "01")).toBe(true)
    // The write shows the webhook service request and its per-order response.
    const act = step(pb, "act").entries[0]!
    expect(act).toMatchObject({ method: "POST", endpoint: "/v1/webhooks/resend", httpStatus: 200, outcome: "OK" })
    expect((act.response as { accepted: number }).accepted).toBe(4)
    // The verification reads the merchant side and proves it.
    expect(step(pb, "verify").entries[0]).toMatchObject({ outcome: "OK", summary: expect.stringContaining("4/4") })
    expect(step(pb, "close").entries[0]!.summary).toMatch(/Case resolved/)
  })

  it("partial: 3/4 become PAID, one merchant endpoint still rejects, escalated to Payment Gateway Integration Support", async () => {
    const core = setup()
    const op = await signIn(core, "operator")
    const id = await inject(op, "order-unpaid", "partial")
    expect(await runUntil(core, op, id, ["RESOLVED", "ESCALATED", "FAILED", "INSUFFICIENT_EVIDENCE"])).toBe("ESCALATED")
    const view = IncidentViewSchema.parse((await op.agent.get(`/api/v1/incidents/${id}`)).body.data)
    expect(view.owner).toBe("Payment Gateway Integration Support")
    expect(view.workflow.recovery).toMatchObject({ total: 4, recovered: 3 })
    const pb = await playbook(op, id)
    const act = step(pb, "act").entries[0]!
    expect(act.httpStatus).toBe(207)
    expect(step(pb, "verify").status).toBe("failed")
    expect(step(pb, "close").entries[0]!.summary).toMatch(/Payment Gateway Integration Support/)
  })

  it("denies a resend for an order the Status API reports as pending (policy, not the AI, decides)", async () => {
    const core = setup()
    const op = await signIn(core, "operator")
    const id = await inject(op, "order-unpaid")
    await runUntil(core, op, id, ["RESOLVED"])
    // Decoy orders are never linked to the incident, so they cannot be read or targeted.
    const view = IncidentViewSchema.parse((await op.agent.get(`/api/v1/incidents/${id}`)).body.data)
    const refs = view.evidence.filter((e) => e.kind === "order").map((e) => String(e.details.orderRef)).sort()
    expect(refs).toEqual(["ORD-1001", "ORD-1002", "ORD-2001", "ORD-3001"])
  })
})

describe("playbooks for every scenario", () => {
  it("soundbox shows the approval wait, the human decision and a verified close", async () => {
    const core = setup()
    const op = await signIn(core, "operator")
    const ap = await signIn(core, "approver")
    const id = await inject(op, "soundbox", "success")
    expect(await runUntil(core, op, id, ["APPROVAL_PENDING", "ESCALATED", "FAILED"])).toBe("APPROVAL_PENDING")

    let pb = await playbook(op, id)
    expect(step(pb, "approve").status).toBe("waiting")
    expect(step(pb, "verify-sync").entries[0]).toMatchObject({ outcome: "INFO", summary: expect.stringContaining("20/24") })
    expect(step(pb, "act-sync").entries[0]).toMatchObject({ method: "POST", endpoint: "/v1/devices/config-sync", httpStatus: 200 })
    expect(step(pb, "act-restart").status).toBe("pending")

    const approvals = await ap.agent.get("/api/v1/approvals")
    const a = approvals.body.data.approvals[0]
    const decided = await ap.agent.post(`/api/v1/approvals/${a.id}/decision`).set("X-CSRF-Token", ap.csrf).set("X-Demo-Generation", String(ap.generation))
      .send({ decision: "approve", proposalRevision: a.proposalRevision })
    expect(decided.status).toBe(200)
    expect(await runUntil(core, op, id, ["RESOLVED", "ESCALATED"])).toBe("RESOLVED")

    pb = await playbook(op, id)
    expect(pb.steps.every((s) => s.status === "done")).toBe(true)
    expect(step(pb, "approve").entries.map((e) => e.kind)).toEqual(["wait", "decision"])
    expect(step(pb, "act-restart").entries[0]).toMatchObject({ endpoint: "/v1/devices/restart", outcome: "OK" })
    expect(step(pb, "verify-restart").entries[0]!.summary).toContain("24/24")
  })

  it("settlement ends as a read-only handoff with no financial call", async () => {
    const core = setup()
    const op = await signIn(core, "operator")
    const id = await inject(op, "settlement-discrepancy")
    expect(await runUntil(core, op, id, ["ESCALATED", "FAILED"])).toBe("ESCALATED")
    const pb = await playbook(op, id)
    expect(step(pb, "handoff").entries[0]).toMatchObject({ system: "Escalation queue", outcome: "OK" })
    expect(step(pb, "handoff").entries[0]!.request).toMatchObject({ financialChange: expect.stringContaining("none") })
    expect(pb.steps.flatMap((s) => s.entries).some((e) => /refund|payout|adjust/i.test(e.endpoint))).toBe(false)
  })

  it("duplicate tickets show the link write and the read-back verification", async () => {
    const core = setup()
    const op = await signIn(core, "operator")
    const id = await inject(op, "duplicate-tickets")
    await runUntil(core, op, id, ["TASK_COMPLETED", "ESCALATED", "FAILED"])
    const pb = await playbook(op, id)
    expect(step(pb, "act-link").entries[0]).toMatchObject({ method: "PATCH", endpoint: "/v1/tickets/link" })
    expect(step(pb, "verify-link").entries[0]!.outcome).toMatch(/OK|FAILED/)
  })

  it("requires a session and the active generation", async () => {
    const core = setup()
    const op = await signIn(core, "operator")
    const id = await inject(op, "soundbox")
    const anon = await request(core.app).get(`/api/v1/incidents/${id}/playbook`)
    expect(anon.status).toBe(401)
    const missing = await op.agent.get("/api/v1/incidents/inc_nope/playbook")
    expect(missing.status).toBe(404)
  })
})
