// Release-candidate checks for the PRD §13 endpoints, Scenario B multi-merchant linking,
// metrics and the detection audit, over the real assembled app (scripted investigator).
import request from "supertest"
import { afterEach, describe, expect, it } from "vitest"
import { DEFAULT_OPTIONS } from "../../server/workflow/config.js"
import { createWorkflowWith } from "../../server/workflow/index.js"
import {
  ActionRequestResultSchema, AuditViewSchema, DetectionJobsViewSchema, IncidentViewSchema, MetricsViewSchema, VerifyResultSchema,
  type IncidentStatus, type IncidentView,
} from "../../shared/contracts/http.js"
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
type Who = { agent: ReturnType<typeof request.agent>; csrf: string; generation: number }
async function signIn(core: Core, role: "operator" | "approver"): Promise<Who> {
  const agent = request.agent(core.app)
  const res = await agent.post("/api/v1/demo/session").send({ role, accessCode: TEST_CODES[role] })
  return { agent, csrf: res.body.data.csrfToken as string, generation: res.body.data.generation as number }
}
const post = (w: Who, path: string, body?: object) => w.agent.post(`/api/v1${path}`).set("X-CSRF-Token", w.csrf).set("X-Demo-Generation", String(w.generation)).send(body ?? {})
async function view(w: Who, id: string): Promise<IncidentView> {
  return IncidentViewSchema.parse((await w.agent.get(`/api/v1/incidents/${id}`)).body.data)
}
async function runUntil(core: Core, w: Who, id: string, statuses: IncidentStatus[]) {
  for (let i = 0; i < 400; i++) {
    await core.runner.drain(50)
    const v = await view(w, id)
    if (statuses.includes(v.incident.status)) return v
    core.clock.advance(1_000)
  }
  throw new Error(`incident never reached ${statuses.join("|")}`)
}

describe("PRD §13 action and verify endpoints", () => {
  it("restart is denied before a proposal, pending while awaiting approval, and single-use after; nothing executes from the endpoint", async () => {
    const core = setup()
    const op = await signIn(core, "operator")
    const ap = await signIn(core, "approver")
    const id = (await post(op, "/demo/inject/soundbox", { variant: "success" })).body.data.incidentId as string

    // Before any proposal: denied with a policy rule, and audited.
    const early = await post(op, `/incidents/${id}/actions`, { kind: "MOCK_RESTART_DEVICE", targetIds: ["dev_x"] })
    expect(early.status).toBe(403)
    expect(early.body.error).toMatchObject({ code: "POLICY_DENIED" })
    expect(early.body.error.message).toMatch(/DEVICE_RESTART_REQUIRES_APPROVAL/)

    // Financial and unknown kinds are denied by default.
    expect((await post(op, `/incidents/${id}/actions`, { kind: "ISSUE_REFUND" })).body.error.message).toMatch(/NO_FINANCIAL_MUTATION/)
    expect((await post(op, `/incidents/${id}/actions`, { kind: "RUN_SQL" })).body.error.message).toMatch(/DENY_BY_DEFAULT/)
    // Approver cannot use the operator endpoint.
    expect((await post(ap, `/incidents/${id}/actions`, { kind: "MOCK_RESTART_DEVICE" })).status).toBe(403)

    const pending = await runUntil(core, op, id, ["APPROVAL_PENDING"])
    const restartsBefore = pending.workflow.actions.filter((a) => a.kind === "MOCK_RESTART_DEVICE" && a.status === "SUCCEEDED").length
    const asked = await post(op, `/incidents/${id}/actions`, { kind: "MOCK_RESTART_DEVICE" })
    expect(asked.status).toBe(202)
    const result = ActionRequestResultSchema.parse(asked.body.data)
    expect(result).toMatchObject({ path: "APPROVAL_PENDING", decision: { allowed: false, requiresApproval: true } })
    await core.runner.drain(50)
    const still = await view(op, id)
    expect(still.incident.status).toBe("APPROVAL_PENDING")
    expect(still.workflow.actions.filter((a) => a.kind === "MOCK_RESTART_DEVICE" && a.status === "SUCCEEDED").length).toBe(restartsBefore)

    // Low-risk sync is owned by the investigator and already executed.
    const sync = ActionRequestResultSchema.parse((await post(op, `/incidents/${id}/actions`, { kind: "MOCK_SYNC_DEVICE_CONFIG" })).body.data)
    expect(sync).toMatchObject({ path: "ALREADY_EXECUTED", decision: { allowed: true, requiresApproval: false } })

    const appr = pending.workflow.approvals.find((a) => a.status === "PENDING")!
    expect((await post(ap, `/approvals/${appr.id}/decision`, { decision: "approve", proposalRevision: appr.proposalRevision })).status).toBe(200)
    const done = await runUntil(core, op, id, ["RESOLVED", "ESCALATED"])
    expect(done.incident.status).toBe("RESOLVED")
    const after = ActionRequestResultSchema.parse((await post(op, `/incidents/${id}/actions`, { kind: "MOCK_RESTART_DEVICE" })).body.data)
    expect(after.path).toBe("ALREADY_EXECUTED")
    expect((await view(op, id)).workflow.actions.filter((a) => a.kind === "MOCK_RESTART_DEVICE")).toHaveLength(1)

    // Verify on a closed incident returns the verifier's saved result without a new check.
    const verify = await post(op, `/incidents/${id}/verify`)
    expect(verify.status).toBe(200)
    expect(VerifyResultSchema.parse(verify.body.data)).toMatchObject({ status: "RESOLVED", queued: false, recovery: { recovered: 24, total: 24 } })

    // Durable audit: detection first, then policy/approval records, then our request records.
    const audit = AuditViewSchema.parse((await op.agent.get(`/api/v1/incidents/${id}/audit`)).body.data).audit
    expect(audit[0]!.event).toBe("INCIDENT_DETECTED")
    const events = audit.map((a) => a.event)
    for (const e of ["ACTION_AUTHORIZED", "APPROVAL_REQUESTED", "APPROVAL_APPROVED", "ACTION_REQUEST_DENIED", "ACTION_REQUEST_PENDING", "VERIFICATION_REQUESTED"]) expect(events).toContain(e)
  })
})

describe("Scenario B and metrics", () => {
  it("links every eligible duplicate across all merchants, leaves the conflicting link alone and verifies 7/7", async () => {
    const core = setup()
    const op = await signIn(core, "operator")
    const id = (await post(op, "/demo/inject/duplicate-tickets", { variant: "success" })).body.data.incidentId as string
    const v = await runUntil(core, op, id, ["TASK_COMPLETED", "ESCALATED", "FAILED"])
    expect(v.incident.status).toBe("TASK_COMPLETED")
    expect(v.workflow.recovery).toMatchObject({ recovered: 7, total: 7 })
    const link = v.workflow.actions.find((a) => a.kind === "LINK_SUPPORT_TICKETS")!
    expect((link.args.groups as unknown[]).length).toBe(6)
    const tickets = v.evidence.filter((e) => e.kind === "ticket")
    expect(tickets.filter((t) => t.details.status === "LINKED_DUPLICATE")).toHaveLength(7)
    expect(v.workflow.finding?.observations.join(" ")).toMatch(/already linked to a different case/)
    expect(v.grouping).toMatchObject({ counts: { records: 14, merchants: 6 } })

    const metrics = MetricsViewSchema.parse((await op.agent.get("/api/v1/metrics")).body.data)
    expect(metrics.metrics.find((m) => m.key === "autonomous_completion")).toMatchObject({ numerator: 1, denominator: 1 })
    expect(metrics.metrics.find((m) => m.key === "trace_completeness")).toMatchObject({ numerator: 1, denominator: 1 })
  })
})

describe("multiple scheduled detection jobs", () => {
  it("runs three device datasets side by side; each groups its own cohort and resolves after approval", async () => {
    const core = setup()
    const op = await signIn(core, "operator")
    const ap = await signIn(core, "approver")
    const jobs = DetectionJobsViewSchema.parse((await op.agent.get("/api/v1/detection/jobs")).body.data)
    expect(jobs.jobs.map((j) => j.id)).toEqual(["voice-alert-sweep", "audio-codec-monitor", "connectivity-monitor", "support-dedupe", "settlement-recon"])
    expect(jobs.jobs.every((j) => j.nextFireAt > jobs.now && j.lastRun === null)).toBe(true)

    const expected: Record<string, { total: number; afterSync: number; restart: number }> = {
      "voice-alert-sweep": { total: 24, afterSync: 20, restart: 4 },
      "audio-codec-monitor": { total: 16, afterSync: 13, restart: 3 },
      "connectivity-monitor": { total: 12, afterSync: 10, restart: 2 },
    }
    const ids: Record<string, string> = {}
    for (const jobId of Object.keys(expected)) {
      const r = await post(op, `/detection/jobs/${jobId}/run`, { variant: "success" })
      expect(r.status).toBe(200)
      ids[jobId] = r.body.data.incidentId
    }
    for (const [jobId, e] of Object.entries(expected)) {
      const v = await runUntil(core, op, ids[jobId]!, ["APPROVAL_PENDING"])
      expect(v.profile).toMatchObject({ detectedBy: { jobId } })
      expect(v.profile!.displayId).toMatch(/^INC-\d{8}-\d{3}$/)
      expect(v.incident.affectedDeviceCount).toBe(e.total)
      expect(v.workflow.recovery).toMatchObject({ total: e.total, recovered: e.afterSync })
      const appr = v.workflow.approvals.find((a) => a.status === "PENDING")!
      expect(appr.targetDeviceIds).toHaveLength(e.restart)
      expect(v.signals.length).toBeGreaterThan(0)
      // Every observation reference in the latest recovery resolves to a returned signal.
      const signalIds = new Set(v.signals.map((s) => s.id))
      expect(v.workflow.recovery!.devices.flatMap((d) => d.evidenceIds).every((id) => signalIds.has(id))).toBe(true)
      await post(ap, `/approvals/${appr.id}/decision`, { decision: "approve", proposalRevision: appr.proposalRevision })
    }
    for (const [jobId, e] of Object.entries(expected)) {
      const done = await runUntil(core, op, ids[jobId]!, ["RESOLVED", "ESCALATED"])
      expect(done.incident.status).toBe("RESOLVED")
      expect(done.workflow.recovery).toMatchObject({ recovered: e.total, total: e.total })
    }
    const after = DetectionJobsViewSchema.parse((await op.agent.get("/api/v1/detection/jobs")).body.data)
    expect(after.jobs.filter((j) => j.lastRun?.status === "RESOLVED")).toHaveLength(3)
    const metrics = MetricsViewSchema.parse((await op.agent.get("/api/v1/metrics")).body.data)
    expect(metrics.metrics.find((m) => m.key === "grouping_quality")).toMatchObject({ numerator: 52, denominator: 52 })
  })
})
