// Owner 02 HTTP routes, attached to a router already mounted at /api/v1.
// Shared middleware authenticates the session, validates CSRF + X-Demo-Generation for
// mutations and sets res.locals.{actor, generation}. Commands re-check generation and
// entitlement themselves; a role in the request body has no effect.
import type { NextFunction, Request, RequestHandler, Response, Router } from "express"
import { z } from "zod"
import type { CoreRuntime } from "../../shared/contracts/core.js"
import { ActionRequestBodySchema, ApprovalDecisionSchema, type Actor, type ApprovalQueue, type Role, type StartResult } from "../../shared/contracts/http.js"
import { requestAction, requestVerify } from "./requests.js"
import { approvalView, decideApproval, listApprovals } from "./approvals.js"
import { requireIncident } from "./machine.js"
import { addAudit, getState } from "./store.js"
import { WorkflowError, assertActiveGeneration, randomId } from "./util.js"

const EmptyBody = z.union([z.undefined(), z.null(), z.object({}).strict()])

/**
 * The validated session actor. `requireRole` sets `res.locals.actor`; on routes open to
 * both roles (GET /approvals) the platform's session middleware only sets
 * `res.locals.session`, so fall back to its actor.
 */
function actorOf(res: Response): Actor | null {
  const a = (res.locals.actor ?? (res.locals.session as { actor?: Actor } | null | undefined)?.actor) as Actor | undefined
  return a && typeof a.id === "string" && (a.role === "operator" || a.role === "approver") ? a : null
}

function generationOf(res: Response): number {
  const g = res.locals.generation
  if (typeof g !== "number" || !Number.isInteger(g) || g <= 0) {
    throw new WorkflowError(400, "INVALID_INPUT", "A valid X-Demo-Generation is required.")
  }
  return g
}

export function sendError(req: Request, res: Response, err: unknown): void {
  const requestId = (res.locals.requestId as string | undefined) ?? req.get("x-request-id") ?? randomId("req")
  if (err instanceof WorkflowError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message, requestId } })
    return
  }
  if (err instanceof z.ZodError) {
    res.status(400).json({ error: { code: "INVALID_INPUT", message: "The request payload is invalid.", requestId } })
    return
  }
  res.status(500).json({ error: { code: "WORKFLOW_UNAVAILABLE", message: "The workflow could not complete the request.", requestId } })
}

function wrap(fn: (req: Request, res: Response) => void): RequestHandler {
  return (req: Request, res: Response, _next: NextFunction) => {
    try {
      fn(req, res)
    } catch (err) {
      sendError(req, res, err)
    }
  }
}

/** Idempotently queue an eligible start/resume. In-flight states return 202 with no new job. */
export function requestInvestigation(core: CoreRuntime, actor: Actor | null, generation: number, incidentId: string): StartResult {
  return core.db.write((tx) => {
    assertActiveGeneration(core, tx, generation)
    if (!actor) throw new WorkflowError(401, "UNAUTHENTICATED", "Sign in to request an investigation.")
    if (actor.role !== "operator") throw new WorkflowError(403, "FORBIDDEN", "Only the operator can request investigation.")
    const scope = { generation, incidentId }
    const incident = requireIncident(core, tx, scope)
    const status = incident.card.status
    const now = core.clock.now()
    if (status === "DETECTED") {
      core.jobs.enqueue(tx, { ...scope, key: `investigate:${incidentId}:initial`, kind: "workflow.investigate", runAfter: now, payload: {} })
    } else if (status === "INSUFFICIENT_EVIDENCE" || status === "FAILED") {
      const st = getState(tx, scope)
      if (status === "FAILED" && st && !st.retryable) throw new WorkflowError(409, "WORKFLOW_CONFLICT", "This failure is not retryable.")
      const key = `investigate:${incidentId}:resume:v${incident.card.version}`
      core.jobs.enqueue(tx, { ...scope, key, kind: "workflow.investigate", runAfter: now, payload: { resume: true } })
      addAudit(tx, scope, `request:${key}`, { at: now, actor: `${actor.role}:${actor.id}`, event: "INVESTIGATION_REQUESTED", summary: `Operator requested investigation resume from ${status}.` })
    } else if (status === "RESOLVED" || status === "ESCALATED" || status === "TASK_COMPLETED") {
      throw new WorkflowError(409, "WORKFLOW_CONFLICT", `The automated run has ended (${status}).`)
    }
    return { generation, incidentId, status }
  })
}

export function registerWorkflowRoutes(core: CoreRuntime, router: Router, requireRole: (role: Role) => RequestHandler): void {
  router.post("/incidents/:id/investigate", requireRole("operator"), wrap((req, res) => {
    const parsed = EmptyBody.safeParse(req.body && Object.keys(req.body).length === 0 ? undefined : req.body)
    if (!parsed.success) throw new WorkflowError(400, "INVALID_INPUT", "This request takes an empty body.")
    const result = requestInvestigation(core, actorOf(res), generationOf(res), String(req.params.id))
    res.status(202).json({ data: result })
  }))

  // PRD §13: request an action; policy decides the path. Never executes directly.
  router.post("/incidents/:id/actions", requireRole("operator"), wrap((req, res) => {
    const body = ActionRequestBodySchema.safeParse(req.body)
    if (!body.success) throw new WorkflowError(400, "INVALID_INPUT", "Body must contain kind and optional targetIds.")
    const result = requestAction(core, actorOf(res), generationOf(res), String(req.params.id), body.data)
    res.status(result.path === "APPROVAL_PENDING" ? 202 : 200).json({ data: result })
  }))

  // PRD §13: queue a fresh verifier-owned check when the incident is VERIFYING; otherwise return the latest result.
  router.post("/incidents/:id/verify", requireRole("operator"), wrap((req, res) => {
    const parsed = EmptyBody.safeParse(req.body && Object.keys(req.body).length === 0 ? undefined : req.body)
    if (!parsed.success) throw new WorkflowError(400, "INVALID_INPUT", "This request takes an empty body.")
    const result = requestVerify(core, actorOf(res), generationOf(res), String(req.params.id))
    res.status(result.queued ? 202 : 200).json({ data: result })
  }))

  router.get("/approvals", wrap((_req, res) => {
    if (!actorOf(res)) throw new WorkflowError(401, "UNAUTHENTICATED", "Sign in to view approvals.")
    const data = core.db.read((q): ApprovalQueue => {
      const generation = core.activeGeneration(q)
      const now = core.clock.now()
      return { generation, approvals: listApprovals(q, generation).map((r) => approvalView(r, now)) }
    })
    res.status(200).json({ data })
  }))

  router.post("/approvals/:id/decision", requireRole("approver"), wrap((req, res) => {
    const body = ApprovalDecisionSchema.safeParse(req.body)
    if (!body.success) throw new WorkflowError(400, "INVALID_INPUT", "Body must contain decision (approve|reject), proposalRevision and optional reason.")
    const result = decideApproval(core, actorOf(res), generationOf(res), String(req.params.id), body.data)
    res.status(200).json({ data: result })
  }))
}
