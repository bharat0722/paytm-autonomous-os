import request from "supertest"
import { afterEach, describe, expect, it } from "vitest"
import { DashboardViewSchema, IncidentViewSchema, type Role } from "../../shared/contracts/http.js"
import { makeCore, TEST_CODES } from "./helpers.js"

type Core = ReturnType<typeof makeCore>
const cores: Core[] = []
const signalUrl = "/api/v1/demo/payment-signals"

function setup(): Core {
  const core = makeCore()
  cores.push(core)
  return core
}

afterEach(() => { for (const core of cores.splice(0)) core.cleanup() })

async function signIn(core: Core, role: Role = "operator") {
  const agent = request.agent(core.app)
  const response = await agent.post("/api/v1/demo/session").send({ role, accessCode: TEST_CODES[role] }).expect(200)
  const session = response.body.data
  const post = (url: string) => agent.post(url).set("X-CSRF-Token", session.csrfToken).set("X-Demo-Generation", String(session.generation))
  return { agent, post, signal: (body: object) => post(signalUrl).send(body) }
}

const order = { merchantRef: "M001", orderRef: "order-1", currency: "INR", amountPaise: 12500, revision: 1, eventId: "order-1-unpaid", source: "merchant-order", status: "UNPAID" }
const gateway = { ...order, eventId: "txn-1-captured", source: "gateway", status: "CAPTURED", transactionRef: "txn-1" }

async function incidentCards(agent: Awaited<ReturnType<typeof signIn>>["agent"]) {
  const res = await agent.get("/api/v1/dashboard").expect(200)
  return DashboardViewSchema.parse(res.body.data).incidents
}

describe("sandbox payment confirmation intake", () => {
  it("opens one evidence-backed handoff after the window and deduplicates retries", async () => {
    const core = setup()
    const op = await signIn(core)
    await op.signal(order).expect(202)
    const first = await op.signal(gateway).expect(202)
    const replay = await op.signal(gateway).expect(202)
    expect(replay.body.data).toEqual({ ...first.body.data, replay: true })
    await op.signal({ ...gateway, amountPaise: 200 }).expect(409)
    await op.signal({ ...gateway, eventId: "different-id-same-revision" }).expect(409)
    core.clock.advance(119_999)
    await core.runner.drain()
    expect(await incidentCards(op.agent)).toEqual([])
    core.clock.advance(1)
    await core.runner.drain()

    const [card] = await incidentCards(op.agent)
    expect(card).toMatchObject({
      scenario: "payment-confirmation", status: "ESCALATED", affectedMerchantCount: 1,
      owner: "Payment Gateway Integration Support",
    })
    const res = await op.agent.get(`/api/v1/incidents/${card!.id}`).expect(200)
    const view = IncidentViewSchema.parse(res.body.data)
    const evidence = view.evidence.filter(item => item.kind === "payment_signal")
    expect(evidence.map(e => e.details.status).sort()).toEqual(["CAPTURED", "UNPAID"])
    expect(view.workflow.audit[0]!.evidenceIds.sort()).toEqual(evidence.map(e => e.id).sort())
    expect(view.grouping?.signals).toContainEqual({ label: "Complexity", value: "L1 · Exact match" })
    expect(view.workflow.actions).toEqual([])

    await op.signal({ ...order, revision: 2, eventId: "order-1-update" }).expect(202)
    core.clock.advance(120_000)
    await core.runner.drain()
    expect((await incidentCards(op.agent)).map(row => row.id)).toEqual([card!.id])
  })

  it("uses latest revisions and keeps merchants with the same order reference separate", async () => {
    const core = setup()
    const op = await signIn(core)
    await op.signal({ ...order, revision: 2, eventId: "order-1-paid", status: "PAID", transactionRef: "txn-1" }).expect(202)
    await op.signal(order).expect(202)
    await op.signal(gateway).expect(202)
    await op.signal({ ...order, merchantRef: "M002", eventId: "second-merchant-unpaid" }).expect(202)
    core.clock.advance(120_000)
    await core.runner.drain()
    expect(await incidentCards(op.agent)).toEqual([])

    await op.signal({ ...gateway, merchantRef: "M002", transactionRef: "txn-2", eventId: "second-merchant-captured", amountPaise: 19999 }).expect(202)
    core.clock.advance(120_000)
    await core.runner.drain()
    const [card] = await incidentCards(op.agent)
    const res = await op.agent.get(`/api/v1/incidents/${card!.id}`).expect(200)
    const view = IncidentViewSchema.parse(res.body.data)
    expect(view.blocker).toMatch(/amounts differ/)
    expect(view.grouping?.signals).toContainEqual({ label: "Complexity", value: "L3 · Specialist review" })
    expect(view.evidence.filter(item => item.kind === "payment_signal").map(item => item.details.merchantRef)).toEqual(["M002", "M002"])
  })

  it("blocks unauthorized and stale intake and fences queued work after reset", async () => {
    const core = setup()
    const op = await signIn(core)
    const approver = await signIn(core, "approver")
    await request(core.app).post(signalUrl).send(gateway).expect(401)
    await op.agent.post(signalUrl).send(gateway).expect(403)
    await approver.signal(gateway).expect(403)
    await op.signal({ ...gateway, merchantRef: "not-enrolled" }).expect(404)
    await op.signal({ ...gateway, amountPaise: 1.2 }).expect(400)
    await op.signal(gateway).expect(202)
    await op.signal(order).expect(202)
    await op.post("/api/v1/demo/reset").send({}).expect(200)
    await op.signal(gateway).expect(409)
    core.clock.advance(120_000)
    await core.runner.drain()
    expect(await incidentCards(op.agent)).toEqual([])
  })
})
