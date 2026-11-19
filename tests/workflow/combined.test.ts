// Combined checks: Owner 01's real app, session/CSRF/generation middleware, SQLite core,
// simulator and telemetry, assembled with the real workflow factory (scripted investigator).
import request from "supertest"
import { afterEach, describe, expect, it } from "vitest"
import { DEFAULT_OPTIONS } from "../../server/workflow/config.js"
import { createWorkflowWith } from "../../server/workflow/index.js"
import { ApprovalQueueSchema, DecisionResultSchema, IncidentViewSchema, type IncidentStatus, type IncidentView } from "../../shared/contracts/http.js"
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

async function view(core: Core, op: Awaited<ReturnType<typeof signIn>>, id: string): Promise<IncidentView> {
  const res = await op.agent.get(`/api/v1/incidents/${id}`)
  expect(res.status).toBe(200)
  return IncidentViewSchema.parse(res.body.data)
}

/** Runs due jobs, advancing the fake clock between batches, until a status is reached. */
async function runUntil(core: Core, op: Awaited<ReturnType<typeof signIn>>, id: string, statuses: IncidentStatus[]) {
  for (let i = 0; i < 400; i++) {
    await core.runner.drain(50)
    const v = await view(core, op, id)
    if (statuses.includes(v.incident.status)) return v
    core.clock.advance(1_000)
  }
  throw new Error(`incident never reached ${statuses.join("|")}`)
}

async function injectSoundbox(core: Core, variant: "success" | "partial") {
  const op = await signIn(core, "operator")
  const ap = await signIn(core, "approver")
  const inj = await op.agent.post("/api/v1/demo/inject/soundbox").set("X-CSRF-Token", op.csrf).set("X-Demo-Generation", String(op.generation)).send({ variant })
  expect(inj.status).toBe(200)
  return { op, ap, id: inj.body.data.incidentId as string }
}

describe("combined: platform + workflow over real HTTP sessions", () => {
  it("20/24 → one exact approval → 24/24 RESOLVED; Approval Center readable by both roles", async () => {
    const core = setup()
    const { op, ap, id } = await injectSoundbox(core, "success")
    const pending = await runUntil(core, op, id, ["APPROVAL_PENDING", "ESCALATED", "INSUFFICIENT_EVIDENCE", "FAILED"])
    expect(pending.incident.status).toBe("APPROVAL_PENDING")
    expect(pending.workflow.recovery).toMatchObject({ total: 24, recovered: 20 })

    expect((await request(core.app).get("/api/v1/approvals")).status).toBe(401)
    for (const who of [op, ap]) {
      const q = await who.agent.get("/api/v1/approvals")
      expect(q.status).toBe(200)
      expect(ApprovalQueueSchema.parse(q.body.data).approvals).toHaveLength(1)
    }
    const approval = ApprovalQueueSchema.parse((await ap.agent.get("/api/v1/approvals")).body.data).approvals[0]!
    expect(approval.targetDeviceIds).toHaveLength(4)
    const body = { decision: "approve", proposalRevision: approval.proposalRevision }

    const asOperator = await op.agent.post(`/api/v1/approvals/${approval.id}/decision`).set("X-CSRF-Token", op.csrf).set("X-Demo-Generation", String(op.generation)).send(body)
    expect(asOperator.status).toBe(403)
    const noCsrf = await ap.agent.post(`/api/v1/approvals/${approval.id}/decision`).set("X-Demo-Generation", String(ap.generation)).send(body)
    expect(noCsrf.status).toBe(403)

    const decide = () => ap.agent.post(`/api/v1/approvals/${approval.id}/decision`).set("X-CSRF-Token", ap.csrf).set("X-Demo-Generation", String(ap.generation)).send(body)
    const first = await decide()
    expect(first.status).toBe(200)
    expect(DecisionResultSchema.parse(first.body.data)).toMatchObject({ queued: true, approval: { status: "APPROVED" } })
    expect((await decide()).body.data).toEqual(first.body.data)

    const done = await runUntil(core, op, id, ["RESOLVED", "ESCALATED"])
    expect(done.incident.status).toBe("RESOLVED")
    expect(done.workflow.recovery).toMatchObject({ total: 24, recovered: 24, remainingDeviceIds: [] })
    expect(done.workflow.approvals[0]!.status).toBe("CONSUMED")
    const dash = await op.agent.get("/api/v1/dashboard")
    expect(dash.body.data.kpis).toMatchObject({ verifiedResolved: 1, pendingApprovals: 0 })
  })

  it("soundbox/partial: approved restart ends at 23/24 and stays unresolved", async () => {
    const core = setup()
    const { op, ap, id } = await injectSoundbox(core, "partial")
    await runUntil(core, op, id, ["APPROVAL_PENDING"])
    const approval = ApprovalQueueSchema.parse((await ap.agent.get("/api/v1/approvals")).body.data).approvals[0]!
    const res = await ap.agent.post(`/api/v1/approvals/${approval.id}/decision`).set("X-CSRF-Token", ap.csrf).set("X-Demo-Generation", String(ap.generation))
      .send({ decision: "approve", proposalRevision: approval.proposalRevision })
    expect(res.status).toBe(200)
    const done = await runUntil(core, op, id, ["RESOLVED", "ESCALATED"])
    expect(done.incident.status).toBe("ESCALATED")
    expect(done.workflow.recovery).toMatchObject({ total: 24, recovered: 23 })
  })
})
