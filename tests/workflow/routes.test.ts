import express, { type RequestHandler } from "express"
import request from "supertest"
import { describe, expect, it } from "vitest"
import { ApprovalQueueSchema, DecisionResultSchema, StartResultSchema, type Role } from "../../shared/contracts/http.js"
import { makeHarness, type Harness } from "./support/harness.js"

/**
 * Stand-in for Owner 01's shared middleware: session actor (here from a test header),
 * generation header for mutations, requireRole. CSRF is out of scope for this stub.
 */
function buildApp(h: Harness) {
  const app = express()
  app.use(express.json())
  const router = express.Router()
  router.use((req, res, next) => {
    const role = req.get("x-test-role")
    if (role === "operator" || role === "approver") res.locals.actor = { id: `${role}-1`, role }
    if (req.method !== "GET") {
      const g = req.get("x-demo-generation")
      if (!g || !/^\d+$/.test(g)) { res.status(400).json({ error: { code: "INVALID_INPUT", message: "generation", requestId: "t" } }); return }
      res.locals.generation = Number(g)
    }
    next()
  })
  const requireRole = (role: Role): RequestHandler => (_req, res, next) => {
    if (!res.locals.actor) { res.status(401).json({ error: { code: "UNAUTHENTICATED", message: "", requestId: "t" } }); return }
    if (res.locals.actor.role !== role) { res.status(403).json({ error: { code: "FORBIDDEN", message: "", requestId: "t" } }); return }
    next()
  }
  h.workflow.registerRoutes(router, requireRole)
  app.use("/api/v1", router)
  return app
}

describe("workflow HTTP routes", () => {
  it("serves approvals, enforces roles and generation, and is idempotent", async () => {
    const h = makeHarness()
    const app = buildApp(h)
    const id = h.inject("soundbox")

    // Investigation request: operator only, 202, idempotent.
    const start = await request(app).post(`/api/v1/incidents/${id}/investigate`).set("x-test-role", "operator").set("x-demo-generation", "1").send()
    expect(start.status).toBe(202)
    expect(StartResultSchema.parse(start.body.data)).toMatchObject({ generation: 1, incidentId: id, status: "DETECTED" })
    expect(h.runner.pending("workflow.investigate")).toHaveLength(1)
    expect((await request(app).post(`/api/v1/incidents/${id}/investigate`).set("x-test-role", "approver").set("x-demo-generation", "1").send()).status).toBe(403)
    expect((await request(app).post(`/api/v1/incidents/nope/investigate`).set("x-test-role", "operator").set("x-demo-generation", "1").send()).body.error.code).toBe("NOT_FOUND")
    expect((await request(app).post(`/api/v1/incidents/${id}/investigate`).set("x-test-role", "operator").set("x-demo-generation", "1").send({ force: true })).status).toBe(400)

    await h.runUntil(id, ["APPROVAL_PENDING"])

    expect((await request(app).get("/api/v1/approvals")).status).toBe(401)
    const q = await request(app).get("/api/v1/approvals").set("x-test-role", "operator")
    expect(q.status).toBe(200)
    const queue = ApprovalQueueSchema.parse(q.body.data)
    expect(queue.approvals).toHaveLength(1)
    const ap = queue.approvals[0]!

    const decide = (role: string, body: unknown, gen = "1") =>
      request(app).post(`/api/v1/approvals/${ap.id}/decision`).set("x-test-role", role).set("x-demo-generation", gen).send(body as object)

    // A role in the body has no effect; the session role decides.
    const asOperator = await decide("operator", { decision: "approve", proposalRevision: ap.proposalRevision, role: "approver" })
    expect(asOperator.status).toBe(403)
    expect((await decide("approver", { decision: "maybe", proposalRevision: ap.proposalRevision })).status).toBe(400)
    expect((await decide("approver", { decision: "approve", proposalRevision: ap.proposalRevision, role: "approver" })).status).toBe(400)
    const stale = await decide("approver", { decision: "approve", proposalRevision: ap.proposalRevision }, "7")
    expect(stale.status).toBe(409)
    expect(stale.body.error).toMatchObject({ code: "STALE_GENERATION" })
    expect(typeof stale.body.error.requestId).toBe("string")
    const conflict = await decide("approver", { decision: "approve", proposalRevision: "rev_old" })
    expect(conflict.status).toBe(409)
    expect(conflict.body.error.code).toBe("APPROVAL_CONFLICT")

    const ok = await decide("approver", { decision: "approve", proposalRevision: ap.proposalRevision, reason: "Verified 20/24" })
    expect(ok.status).toBe(200)
    expect(DecisionResultSchema.parse(ok.body.data)).toMatchObject({ queued: true, approval: { status: "APPROVED", reason: "Verified 20/24" } })
    const replay = await decide("approver", { decision: "approve", proposalRevision: ap.proposalRevision, reason: "Verified 20/24" })
    expect(replay.status).toBe(200)
    expect(replay.body.data).toEqual(ok.body.data)

    await h.runUntil(id, ["RESOLVED"])
    const done = await request(app).post(`/api/v1/incidents/${id}/investigate`).set("x-test-role", "operator").set("x-demo-generation", "1").send()
    expect(done.status).toBe(409)
    const after = ApprovalQueueSchema.parse((await request(app).get("/api/v1/approvals").set("x-test-role", "approver")).body.data)
    expect(after.approvals[0]!.status).toBe("CONSUMED")
    expect(h.fake.effects().filter((e) => e.kind === "MOCK_RESTART_DEVICE")).toHaveLength(4)
  })

  it("resumes an INSUFFICIENT_EVIDENCE incident on operator request", async () => {
    const h = makeHarness()
    const app = buildApp(h)
    const id = h.inject("soundbox")
    // Hide device records so the first investigation cannot support a sync.
    h.fake.sql.run("UPDATE core_evidence SET kind = 'hidden' WHERE kind = 'device'")
    expect(await h.runUntil(id, ["INSUFFICIENT_EVIDENCE", "APPROVAL_PENDING"])).toBe("INSUFFICIENT_EVIDENCE")
    expect(h.fake.incident(id).blocker).toMatch(/Device records missing/)
    h.fake.sql.run("UPDATE core_evidence SET kind = 'device' WHERE kind = 'hidden'")
    const res = await request(app).post(`/api/v1/incidents/${id}/investigate`).set("x-test-role", "operator").set("x-demo-generation", "1").send()
    expect(res.status).toBe(202)
    expect(res.body.data.status).toBe("INSUFFICIENT_EVIDENCE")
    expect(await h.runUntil(id, ["APPROVAL_PENDING"])).toBe("APPROVAL_PENDING")
  })
})
