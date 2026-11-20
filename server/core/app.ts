// Composition root: builds the Express app, CoreRuntime, job registry and optional workflow.
import express, { type NextFunction, type Request, type RequestHandler, type Response, Router } from "express"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { ZodError } from "zod"
import {
  DemoInjectSchema, DemoSignInSchema, ScenarioSchema, type Role, type SessionView
} from "../../shared/contracts/http.js"
import { CoreError, type CoreRuntime, type JobHandler, type JobKind, type WorkflowFactory, type WorkflowModule } from "../../shared/contracts/core.js"
import type { CoreConfig } from "./config.js"
import { openDb, type CoreDb } from "./db.js"
import { activeGeneration, ensureBootstrapped, resetDemo } from "./generations.js"
import { injectScenario } from "./inject.js"
import { JobRunner } from "./jobs.js"
import { auditView, dashboardView, incidentView } from "./readmodels.js"
import { metricsView } from "./metrics.js"
import { detectionJobsView } from "./profile.js"
import { jobById } from "./datasets.js"
import { createCoreRuntime } from "./runtime.js"
import { SessionStore, safeEqual, type SessionRecord } from "./session.js"
import { emitTelemetry } from "./simulation.js"
import { newId, systemClock, type Clock } from "./util.js"

export class HttpError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) { super(message) }
}

const send = <T>(res: Response, data: T, status = 200) => res.status(status).json({ data })
const fail = (res: Response, status: number, code: string, message: string) =>
  res.status(status).json({ error: { code, message, requestId: String(res.locals.requestId ?? "") } })

export interface AppOptions {
  config: CoreConfig
  createWorkflow?: WorkflowFactory
  clock?: Clock
  db?: CoreDb
  webDistDir?: string
}

export interface CoreApp {
  app: express.Express
  db: CoreDb
  runtime: CoreRuntime
  runner: JobRunner
  workflow: WorkflowModule | null
  sessions: SessionStore
  close(): void
}

export function createApp(options: AppOptions): CoreApp {
  const clock = options.clock ?? systemClock
  const db = options.db ?? openDb(options.config.dbPath)
  ensureBootstrapped(db, clock)
  const runtime = createCoreRuntime(db, clock)
  const workflow = options.createWorkflow ? options.createWorkflow(runtime) : null
  const sessions = new SessionStore(db, clock, options.config.sessionSecret, options.config.sessionTtlHours)

  // Explicit job registry: core registers telemetry; the workflow supplies its own kinds.
  const registry: Partial<Record<JobKind, JobHandler>> = {
    ...(workflow?.handlers ?? {}),
    "core.telemetry": async (job) => { db.write((tx) => emitTelemetry(tx, job)) }
  }
  const runner = new JobRunner(db, clock, registry)

  const app = express()
  app.disable("x-powered-by")
  app.set("trust proxy", false)
  app.use((req, res, next) => {
    res.locals.requestId = newId("req")
    res.setHeader("X-Request-Id", String(res.locals.requestId))
    next()
  })

  const api = Router()
  api.use(express.json({ limit: "16kb", strict: true }))

  // Session discovery on every request.
  api.use((req, res, next) => {
    res.locals.session = sessions.fromCookie(req.headers.cookie)
    next()
  })

  // Reads require a session (except session discovery/sign-in). Mutations require CSRF + generation.
  api.use((req, res, next) => {
    const session = res.locals.session as SessionRecord | null
    const isSessionRoute = req.path === "/session" || req.path === "/demo/session"
    if (isSessionRoute) return next()
    if (!session) return fail(res, 401, "UNAUTHENTICATED", "Sign in first.")
    if (req.method === "GET" || req.method === "HEAD") {
      res.locals.generation = db.read((q) => activeGeneration(q))
      return next()
    }
    const csrf = req.get("X-CSRF-Token") ?? ""
    if (!csrf || !safeEqual(csrf, session.csrfToken)) return fail(res, 403, "FORBIDDEN", "Missing or invalid CSRF token.")
    const genHeader = req.get("X-Demo-Generation") ?? ""
    if (!/^\d+$/.test(genHeader)) return fail(res, 400, "INVALID_INPUT", "X-Demo-Generation must be a decimal integer.")
    const generation = Number(genHeader)
    const active = db.read((q) => activeGeneration(q))
    if (generation !== active) return fail(res, 409, "STALE_GENERATION", `Demo generation ${generation} is stale (active ${active}). Refetch.`)
    res.locals.generation = generation
    next()
  })

  const requireRole = (role: Role): RequestHandler => (req, res, next) => {
    const session = res.locals.session as SessionRecord | null
    if (!session) return fail(res, 401, "UNAUTHENTICATED", "Sign in first.")
    if (session.actor.role !== role) return fail(res, 403, "FORBIDDEN", `Requires the ${role} role.`)
    res.locals.actor = session.actor
    next()
  }

  const sessionView = (session: SessionRecord | null): SessionView => ({
    generation: db.read((q) => activeGeneration(q)), actor: session?.actor ?? null, csrfToken: session?.csrfToken ?? null
  })

  api.get("/session", (req, res) => send(res, sessionView(res.locals.session as SessionRecord | null)))

  api.post("/demo/session", (req, res) => {
    const body = DemoSignInSchema.parse(req.body)
    const expected = body.role === "operator" ? options.config.operatorCode : options.config.approverCode
    if (!safeEqual(body.accessCode, expected)) return fail(res, 401, "UNAUTHENTICATED", "Invalid access code for that role.")
    const { record, cookieValue } = sessions.create(body.role)
    res.setHeader("Set-Cookie", sessions.cookieHeader(cookieValue))
    send(res, sessionView(record))
  })

  api.post("/demo/reset", requireRole("operator"), (req, res) => {
    const generation = resetDemo(db, clock, res.locals.generation as number)
    send(res, { generation })
  })

  api.post("/demo/inject/:scenario", requireRole("operator"), (req, res) => {
    const scenario = ScenarioSchema.parse(req.params.scenario)
    const { variant } = DemoInjectSchema.parse(req.body ?? {})
    send(res, injectScenario(db, clock, res.locals.generation as number, scenario, variant))
  })

  api.get("/dashboard", (req, res) => {
    send(res, db.read((q) => dashboardView(q, workflow, res.locals.generation as number)))
  })

  // Scheduled detection jobs (cron catalogue) and on-demand runs.
  api.get("/detection/jobs", (req, res) => {
    send(res, db.read((q) => detectionJobsView(q, res.locals.generation as number, clock.now())))
  })

  api.post("/detection/jobs/:id/run", requireRole("operator"), (req, res) => {
    const job = jobById(String(req.params.id))
    if (!job) return fail(res, 404, "NOT_FOUND", "Unknown detection job.")
    const { variant } = DemoInjectSchema.parse(req.body && Object.keys(req.body).length ? req.body : { variant: "success" })
    send(res, injectScenario(db, clock, res.locals.generation as number, job.scenario, variant, job.id))
  })

  api.get("/metrics", (req, res) => {
    send(res, db.read((q) => metricsView(q, workflow, res.locals.generation as number)))
  })

  api.get("/incidents/:id/audit", (req, res) => {
    const view = db.read((q) => auditView(q, workflow, { generation: res.locals.generation as number, incidentId: String(req.params.id) }))
    if (!view) return fail(res, 404, "NOT_FOUND", "Incident not found in the active generation.")
    send(res, view)
  })

  api.get("/incidents/:id", (req, res) => {
    const view = db.read((q) => incidentView(q, workflow, { generation: res.locals.generation as number, incidentId: String(req.params.id) }))
    if (!view) return fail(res, 404, "NOT_FOUND", "Incident not found in the active generation.")
    send(res, view)
  })

  if (workflow) {
    workflow.registerRoutes(api, requireRole)
  } else {
    const unavailable: RequestHandler = (req, res) => fail(res, 503, "WORKFLOW_UNAVAILABLE", "Workflow module is not assembled in this build.")
    api.post("/incidents/:id/investigate", unavailable)
    api.get("/approvals", unavailable)
    api.post("/approvals/:id/decision", unavailable)
  }

  api.use((req, res) => fail(res, 404, "NOT_FOUND", `No route ${req.method} ${req.path}`))

  // Central error mapping.
  api.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) return fail(res, err.status, err.code, err.message)
    if (err instanceof ZodError) return fail(res, 400, "INVALID_INPUT", err.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "))
    if (err instanceof SyntaxError) return fail(res, 400, "INVALID_INPUT", "Malformed JSON body.")
    if (err instanceof CoreError) {
      const map: Record<CoreError["code"], [number, string]> = {
        STALE_GENERATION: [409, "STALE_GENERATION"], FENCED: [409, "STALE_GENERATION"], NOT_FOUND: [404, "NOT_FOUND"],
        INVALID_INPUT: [400, "INVALID_INPUT"], CONFLICT: [409, "INJECTION_CONFLICT"]
      }
      const [status, code] = map[err.code]
      return fail(res, status, code, err.message)
    }
    console.error(`[api] ${String(res.locals.requestId)}`, err)
    return fail(res, 500, "INTERNAL", "Unexpected server error.")
  })

  app.use("/api/v1", api)

  // Same-origin UI: serve the built app when present.
  const webDir = options.webDistDir ?? resolve("dist/web")
  if (existsSync(webDir)) {
    app.use(express.static(webDir, { index: "index.html" }))
    app.use((req, res, next) => (req.method === "GET" && !req.path.startsWith("/api/") ? res.sendFile(resolve(webDir, "index.html")) : next()))
  }

  return { app, db, runtime, runner, workflow, sessions, close: () => { runner.stop(); db.close() } }
}
