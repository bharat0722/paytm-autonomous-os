import type { ZodType } from "zod"
import {
  ApiErrorSchema, ApprovalDecisionSchema, ApprovalQueueSchema, AuditViewSchema, DashboardViewSchema, DecisionResultSchema, DetectionJobsViewSchema, MetricsViewSchema,
  DemoInjectSchema, DemoSignInSchema, IncidentViewSchema, InjectResultSchema, SessionViewSchema,
  StartResultSchema, okEnvelope, type ApprovalDecision, type DemoInject, type DemoSignIn, type Scenario,
  type SessionView,
} from "../../../shared/contracts/http.js"

export class ApiProblem extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 0,
    public readonly requestId: string | null = null,
  ) {
    super(message)
    this.name = "ApiProblem"
  }
}

export function asProblem(error: unknown): ApiProblem {
  return error instanceof ApiProblem ? error : new ApiProblem("NETWORK", "The workspace could not reach the API. Check the connection and try again.")
}

export function needsSessionRefresh(problem: ApiProblem): boolean {
  return ["UNAUTHENTICATED", "STALE_GENERATION", "CSRF_INVALID"].includes(problem.code)
}

function assertGeneration<T extends { generation: number }>(value: T, expected: number): T {
  if (value.generation !== expected) {
    throw new ApiProblem("STALE_GENERATION", "The sandbox was reset. Refreshing the current workspace.", 409)
  }
  return value
}

function sessionHeaders(session: SessionView) {
  if (!session.actor || !session.csrfToken) throw new ApiProblem("UNAUTHENTICATED", "Sign in to continue.", 401)
  return { "X-Demo-Generation": String(session.generation), "X-CSRF-Token": session.csrfToken }
}

export function createApi(fetcher: typeof fetch = fetch) {
  async function request<T>(path: string, schema: ZodType<T>, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers)
    headers.set("Accept", "application/json")
    if (init.body != null) headers.set("Content-Type", "application/json")

    const response = await fetcher("/api/v1" + path, {
      ...init, headers, credentials: "same-origin", cache: "no-store",
    })
    const body: unknown = await response.json().catch(() => null)
    const id = response.headers.get("X-Request-Id")
    if (!response.ok) {
      const error = ApiErrorSchema.safeParse(body)
      if (error.success) {
        const { code, message, requestId } = error.data.error
        throw new ApiProblem(code, message, response.status, requestId || id)
      }
      throw new ApiProblem("HTTP_ERROR", "The workspace API returned an unexpected error. Try again.", response.status, id)
    }
    const result = okEnvelope(schema).safeParse(body)
    if (!result.success) throw new ApiProblem("INVALID_RESPONSE", "The workspace received data it could not display. Try refreshing.", response.status, id)
    return result.data.data
  }

  async function scopedRead<T extends { generation: number }>(path: string, schema: ZodType<T>, generation: number, signal: AbortSignal) {
    return assertGeneration(await request(path, schema, { signal }), generation)
  }

  async function command<T extends { generation: number }>(
    path: string, schema: ZodType<T>, session: SessionView, body: unknown, resets = false,
  ) {
    const result = await request(path, schema, {
      method: "POST", headers: sessionHeaders(session), body: JSON.stringify(body),
    })
    return resets ? result : assertGeneration(result, session.generation)
  }

  return {
    session: (signal?: AbortSignal) => request("/session", SessionViewSchema, { signal }),
    signIn: (form: DemoSignIn) => request("/demo/session", SessionViewSchema, {
      method: "POST", body: JSON.stringify(DemoSignInSchema.parse(form)),
    }),
    dashboard: (generation: number, signal: AbortSignal) => scopedRead("/dashboard", DashboardViewSchema, generation, signal),
    incident: (id: string, generation: number, signal: AbortSignal) =>
      scopedRead("/incidents/" + encodeURIComponent(id), IncidentViewSchema, generation, signal),
    approvals: (generation: number, signal: AbortSignal) => scopedRead("/approvals", ApprovalQueueSchema, generation, signal),
    metrics: (generation: number, signal: AbortSignal) => scopedRead("/metrics", MetricsViewSchema, generation, signal),
    jobs: (generation: number, signal: AbortSignal) => scopedRead("/detection/jobs", DetectionJobsViewSchema, generation, signal),
    runJob: (session: SessionView, jobId: string, body: DemoInject) =>
      command("/detection/jobs/" + encodeURIComponent(jobId) + "/run", InjectResultSchema, session, DemoInjectSchema.parse(body)),
    audit: (id: string, generation: number, signal: AbortSignal) =>
      scopedRead("/incidents/" + encodeURIComponent(id) + "/audit", AuditViewSchema, generation, signal),
    inject: (session: SessionView, scenario: Scenario, body: DemoInject) =>
      command("/demo/inject/" + scenario, InjectResultSchema, session, DemoInjectSchema.parse(body)),
    reset: (session: SessionView) => command("/demo/reset", SessionViewSchema.pick({ generation: true }), session, {}, true),
    investigate: (session: SessionView, id: string) =>
      command("/incidents/" + encodeURIComponent(id) + "/investigate", StartResultSchema, session, {}),
    decide: (session: SessionView, id: string, body: ApprovalDecision) =>
      command("/approvals/" + encodeURIComponent(id) + "/decision", DecisionResultSchema, session, ApprovalDecisionSchema.parse(body)),
  }
}

export const api = createApi()
