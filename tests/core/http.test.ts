import request from "supertest"
import { afterEach, describe, expect, it } from "vitest"
import { DashboardViewSchema, IncidentViewSchema, InjectResultSchema, SessionViewSchema } from "../../shared/contracts/http.js"
import { makeCore, tempDbPath, TEST_CODES } from "./helpers.js"

const cleanups: (() => void)[] = []
afterEach(() => { while (cleanups.length) cleanups.pop()!() })
const core = (dbPath?: string) => { const c = makeCore(dbPath ? { dbPath } : {}); cleanups.push(() => c.close()); return c }

async function signIn(app: Parameters<typeof request>[0], role: "operator" | "approver") {
  const res = await request(app).post("/api/v1/demo/session").send({ role, accessCode: TEST_CODES[role] })
  expect(res.status).toBe(200)
  const session = SessionViewSchema.parse(res.body.data)
  return { cookie: res.headers["set-cookie"] as unknown as string[], csrf: session.csrfToken!, generation: session.generation }
}

describe("HTTP boundary", () => {
  it("session discovery is anonymous; other reads need a session", async () => {
    const { app } = core()
    const s = await request(app).get("/api/v1/session")
    expect(s.status).toBe(200)
    expect(s.body.data).toMatchObject({ generation: 1, actor: null, csrfToken: null })
    const d = await request(app).get("/api/v1/dashboard")
    expect(d.status).toBe(401)
    expect(d.body.error).toMatchObject({ code: "UNAUTHENTICATED" })
    expect(typeof d.body.error.requestId).toBe("string")
  })

  it("role alone grants nothing: wrong or missing access code is rejected", async () => {
    const { app } = core()
    expect((await request(app).post("/api/v1/demo/session").send({ role: "approver", accessCode: TEST_CODES.operator })).status).toBe(401)
    expect((await request(app).post("/api/v1/demo/session").send({ role: "approver" })).status).toBe(400)
    expect((await request(app).post("/api/v1/demo/session").send({ role: "admin", accessCode: "x" })).status).toBe(400)
  })

  it("mutations need CSRF + current generation + the right role", async () => {
    const { app } = core()
    const op = await signIn(app, "operator")
    const ap = await signIn(app, "approver")
    const inject = (who: typeof op, headers: Record<string, string>) =>
      request(app).post("/api/v1/demo/inject/soundbox").set("Cookie", who.cookie).set(headers).send({ variant: "success" })
    expect((await inject(op, { "X-Demo-Generation": "1" })).status).toBe(403) // no CSRF
    expect((await inject(op, { "X-CSRF-Token": op.csrf })).status).toBe(400) // no generation
    expect((await inject(op, { "X-CSRF-Token": op.csrf, "X-Demo-Generation": "7" })).body.error.code).toBe("STALE_GENERATION")
    expect((await inject(ap, { "X-CSRF-Token": ap.csrf, "X-Demo-Generation": "1" })).status).toBe(403) // approver cannot inject
    const ok = await inject(op, { "X-CSRF-Token": op.csrf, "X-Demo-Generation": "1" })
    expect(ok.status).toBe(200)
    const first = InjectResultSchema.parse(ok.body.data)
    const replay = await inject(op, { "X-CSRF-Token": op.csrf, "X-Demo-Generation": "1" })
    expect(replay.body.data).toEqual(first)
    const conflict = await request(app).post("/api/v1/demo/inject/soundbox").set("Cookie", op.cookie)
      .set({ "X-CSRF-Token": op.csrf, "X-Demo-Generation": "1" }).send({ variant: "partial" })
    expect(conflict.status).toBe(409)
    const bad = await request(app).post("/api/v1/demo/inject/duplicate-tickets").set("Cookie", op.cookie)
      .set({ "X-CSRF-Token": op.csrf, "X-Demo-Generation": "1" }).send({ variant: "partial" })
    expect(bad.status).toBe(400)
  })

  it("dashboard and incident views project real DB state; workflow routes report WORKFLOW_UNAVAILABLE", async () => {
    const { app } = core()
    const op = await signIn(app, "operator")
    const ap = await signIn(app, "approver")
    const { incidentId } = (await request(app).post("/api/v1/demo/inject/soundbox").set("Cookie", op.cookie)
      .set({ "X-CSRF-Token": op.csrf, "X-Demo-Generation": "1" }).send({ variant: "success" })).body.data
    const dash = DashboardViewSchema.parse((await request(app).get("/api/v1/dashboard").set("Cookie", ap.cookie)).body.data)
    expect(dash.kpis).toEqual({ activeIncidents: 1, affectedMerchants: 21, verifiedResolved: 0, pendingApprovals: 0 })
    expect(dash.incidents[0]).toMatchObject({ id: incidentId, status: "DETECTED", affectedDeviceCount: 24 })
    const view = IncidentViewSchema.parse((await request(app).get(`/api/v1/incidents/${incidentId}`).set("Cookie", ap.cookie)).body.data)
    expect(view.evidence.filter((e) => e.kind === "device")).toHaveLength(24)
    expect(view.workflow).toEqual({ finding: null, trace: [], audit: [], actions: [], approvals: [], recovery: null })
    expect((await request(app).get("/api/v1/incidents/inc_nope").set("Cookie", ap.cookie)).status).toBe(404)
    const approvals = await request(app).get("/api/v1/approvals").set("Cookie", ap.cookie)
    expect(approvals.status).toBe(503)
    expect(approvals.body.error.code).toBe("WORKFLOW_UNAVAILABLE")
  })

  it("reset fences old-generation mutations; the browser keeps its session", async () => {
    const { app } = core()
    const op = await signIn(app, "operator")
    const reset = await request(app).post("/api/v1/demo/reset").set("Cookie", op.cookie).set({ "X-CSRF-Token": op.csrf, "X-Demo-Generation": "1" }).send()
    expect(reset.body.data).toEqual({ generation: 2 })
    const stale = await request(app).post("/api/v1/demo/inject/soundbox").set("Cookie", op.cookie)
      .set({ "X-CSRF-Token": op.csrf, "X-Demo-Generation": "1" }).send({ variant: "success" })
    expect(stale.status).toBe(409)
    expect(stale.body.error.code).toBe("STALE_GENERATION")
    const session = await request(app).get("/api/v1/session").set("Cookie", op.cookie)
    expect(session.body.data).toMatchObject({ generation: 2, actor: { role: "operator" } })
    // Three clean reset rehearsals of the inject path.
    for (let g = 2; g <= 4; g++) {
      const r = await request(app).post("/api/v1/demo/inject/soundbox").set("Cookie", op.cookie)
        .set({ "X-CSRF-Token": op.csrf, "X-Demo-Generation": String(g) }).send({ variant: "success" })
      expect(r.status).toBe(200)
      const dash = (await request(app).get("/api/v1/dashboard").set("Cookie", op.cookie)).body.data
      expect(dash.incidents).toHaveLength(1)
      await request(app).post("/api/v1/demo/reset").set("Cookie", op.cookie).set({ "X-CSRF-Token": op.csrf, "X-Demo-Generation": String(g) }).send()
    }
  })

  it("an existing browser session survives an app restart on the same DB", async () => {
    const tmp = tempDbPath(); cleanups.push(tmp.cleanup)
    const first = makeCore({ dbPath: tmp.path })
    const op = await signIn(first.app, "operator")
    first.close()
    const second = core(tmp.path)
    const res = await request(second.app).get("/api/v1/session").set("Cookie", op.cookie)
    expect(res.body.data).toMatchObject({ actor: { role: "operator" }, csrfToken: op.csrf })
    const tampered = await request(second.app).get("/api/v1/dashboard").set("Cookie", "mros_sid=ses_fake.sig")
    expect(tampered.status).toBe(401)
  })
})
