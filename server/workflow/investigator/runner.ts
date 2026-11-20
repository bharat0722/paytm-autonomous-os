// Investigator episode runner (workflow.investigate). Model calls run outside
// transactions and may repeat; each validated step, its retrieved evidence and its
// trace commit together under the job lease. Budgets persist across lease recovery.
import type { CoreRuntime, Job } from "../../../shared/contracts/core.js"
import type { EvidenceView, Finding, Mode, Scope } from "../../../shared/contracts/http.js"
import { countRestartApprovals, createRestartApproval } from "../approvals.js"
import type { WorkflowOptions } from "../config.js"
import { FIELD_OWNER, SETTLEMENT_OWNER, transition } from "../machine.js"
import { evaluateAction, type PolicyDecision } from "../policy.js"
import {
  addAudit, addEscalation, addProcessLog, addTrace, deviceChecks, getEpisode, insertAction, latestVerification, listRetrieved,
  listSteps, saveFinding, saveState, type EpisodeRow,
} from "../store.js"
import { describeProposal, describeRead, readStepId, sampleList } from "../process.js"
import { FencedError, guardJob, opaqueId, parseJson, scopeOf, truncate } from "../util.js"
import { ProviderError, StepSchema, type ModelProvider, type Stage, type Step, type StepContext } from "./provider.js"
import { scriptedStep } from "./scripted.js"
import { TOOLS, describeTools, eligibleTools, runTool, type Proposal, type Snapshot, type ToolOutcome, type ToolState } from "./tools.js"

const EVIDENCE_KINDS = new Set(["device", "device_event", "ticket", "payment", "settlement", "merchant"])

export function makeInvestigateHandler(core: CoreRuntime, options: WorkflowOptions) {
  return async (job: Job): Promise<void> => {
    try {
      await investigate(core, options, job)
    } catch (err) {
      if (err instanceof FencedError) return
      throw err
    }
  }
}

function loadSnapshot(core: CoreRuntime, scope: Scope): Snapshot | null {
  return core.db.read((q) => {
    const v = latestVerification(q, scope, { finalOnly: true })
    if (!v) return null
    return { id: v.id, total: v.total, recovered: v.recovered, remainingDeviceIds: parseJson<string[]>(v.remaining, []), devices: deviceChecks(v) }
  })
}

interface HistoryItem { step: unknown; result: Record<string, unknown> }

async function investigate(core: CoreRuntime, options: WorkflowOptions, job: Job): Promise<void> {
  const scope = scopeOf(job)
  const stage: Stage = job.payload.stage === "continuation" ? "continuation" : "triage"
  const initialMode: Mode = options.investigatorMode === "sarvam" && options.provider ? "live_ai" : "scripted_fallback"
  const initialReason = initialMode === "live_ai"
    ? null
    : options.investigatorMode === "scripted"
      ? "INVESTIGATOR_MODE=scripted (reproducible run)"
      : options.providerUnavailableReason ?? "Live provider unavailable"

  // 1. Start or resume the episode (status edge + checkpoint in one transaction).
  const begun = core.db.write((tx) => {
    guardJob(core, tx, job)
    let incident = core.incidents.get(tx, scope)
    if (!incident) return null
    const epId = opaqueId("eps", scope.generation, scope.incidentId, job.key)
    const existing = getEpisode(tx, epId)
    if (existing && existing.status !== "RUNNING") return null // replay of a finished episode
    const now = core.clock.now()
    const status = incident.card.status
    if (stage === "triage") {
      const resume = job.payload.resume === true && (status === "INSUFFICIENT_EVIDENCE" || status === "FAILED")
      if (status === "DETECTED" || resume) {
        incident = transition(core, tx, scope, incident, {
          to: "INVESTIGATING", mode: initialMode, stage: "investigation",
          reason: status === "DETECTED" ? "Investigation started from detection." : "Investigation resumed on operator request.",
          opKey: `${job.key}:start`,
        })
      } else if (status !== "INVESTIGATING" || !existing) {
        // INVESTIGATING without this job's episode means another episode owns the run.
        return null
      }
    } else if (status !== "PARTIALLY_RECOVERED") {
      return null
    }
    const ep = existing ?? ensureEpisodeRow(core, tx, scope, job.key, stage, initialMode, initialReason, now)
    if (!existing) {
      addTrace(tx, scope, `${job.key}:mode`, {
        at: now, mode: initialMode, stage: "investigation",
        summary: initialMode === "live_ai"
          ? `Investigator ${stage} episode started with live model (${options.provider?.name ?? "provider"}).`
          : `Investigator ${stage} episode started in scripted fallback: ${initialReason}.`,
      })
      saveState(tx, scope, now, { scenario: incident.card.scenario, phase: stage === "triage" ? "TRIAGE" : "RESTART_PROPOSAL" })
      if (stage === "triage") {
        const c = (incident.correlation ?? {}) as Record<string, unknown>
        addProcessLog(tx, scope, "detect", {
          at: now, stepId: "detect", kind: "result", system: "Correlation engine", method: "RULE", endpoint: "correlate()",
          request: { rule: c.rule ?? null, windowMinutes: c.windowMinutes ?? null, minDistinctMerchants: c.minMerchants ?? null },
          response: {
            sharedSignature: c.shared ?? c.rule ?? null, window: c.window ?? null,
            items: c.deviceCount ?? c.orderCount ?? c.ticketCount ?? null, merchants: c.merchantCount ?? null,
            excludedAsDifferentCause: c.excluded ?? [], note: c.note ?? null,
          },
          httpStatus: null, outcome: "OK", summary: `Grouped related signals into one case: ${incident.card.title}`,
        })
      }
    }
    return { ep, incident }
  })
  if (!begun) return
  let ep = begun.ep

  // 2. Rebuild durable episode state from checkpoints.
  const state: ToolState = {
    core, scope, incident: begun.incident, retrieved: new Map(), citable: new Set(),
    latestSnapshot: loadSnapshot(core, scope),
    existingRestartApprovals: core.db.read((q) => countRestartApprovals(q, scope)),
    proposal: null, used: new Set(), deniedProposals: new Set(),
  }
  const history: HistoryItem[] = []
  core.db.read((q) => {
    for (const r of listRetrieved(q, ep.id)) {
      state.citable.add(r.evidence_id)
      if (EVIDENCE_KINDS.has(r.kind)) state.retrieved.set(r.evidence_id, parseJson<EvidenceView>(r.record_json, { id: r.evidence_id, kind: r.kind as EvidenceView["kind"], title: "", occurredAt: null, details: {} }))
    }
    for (const s of listSteps(q, ep.id)) {
      const step = parseJson<unknown>(s.step_json, null)
      const result = parseJson<Record<string, unknown> & { __proposal?: Proposal; __tool?: string; __kind?: string }>(s.result_json, {})
      if (result.__tool && result.ok === true) state.used.add(result.__tool)
      // Only the scripted path's own denials stop it from re-proposing; a model's denial does not.
      if (result.__tool && result.ok === false && result.__kind === "proposal" && s.mode === "scripted_fallback") state.deniedProposals.add(result.__tool)
      if (result.__proposal) state.proposal = result.__proposal
      const { __proposal: _p, __tool: _t, __kind: _k, ...modelResult } = result
      history.push({ step, result: modelResult })
    }
  })

  // 3. Step loop.
  let scriptHandover = false
  for (;;) {
    // The script must not trust a live model's empty reads: re-read anything that came back with no records.
    if (ep.mode !== "live_ai" && !scriptHandover) {
      scriptHandover = true
      const kindOf: Record<string, string> = { read_devices: "device", read_device_events: "device_event", read_merchants: "merchant", read_tickets: "ticket",
        read_payments: "payment", read_settlements: "settlement", read_orders: "order", read_webhook_log: "webhook_attempt", check_pg_status: "pg_transaction" }
      for (const [tool, kind] of Object.entries(kindOf)) {
        if (state.used.has(tool) && ![...state.retrieved.values()].some((e) => e.kind === kind)) state.used.delete(tool)
      }
    }
    const eligible = eligibleTools(state, stage)
    let raw: unknown
    if (ep.mode === "live_ai" && options.provider) {
      if (ep.turns_used >= options.maxModelTurns || ep.active_ms >= options.episodeBudgetMs) {
        ep = switchToFallback(core, job, scope, ep, ep.turns_used >= options.maxModelTurns
          ? `model turn budget (${options.maxModelTurns}) exhausted without a finding`
          : `active episode budget (${Math.round(options.episodeBudgetMs / 1000)}s) exhausted`)
        continue
      }
      ep = core.db.write((tx) => {
        guardJob(core, tx, job)
        tx.run("UPDATE wf_episodes SET turns_used = turns_used + 1 WHERE id = ?", [ep.id])
        return getEpisode(tx, ep.id)!
      })
      const ctx: StepContext = {
        incident: {
          id: state.incident.card.id, scenario: state.incident.card.scenario, title: truncate(state.incident.card.title, 160),
          status: state.incident.card.status, cohortDeviceIds: state.incident.devices.map((d) => d.id),
        },
        stage, tools: describeTools(eligible), history,
      }
      const t0 = options.monotonicNow()
      try {
        raw = await callProvider(options.provider, ctx, Math.max(1, options.episodeBudgetMs - ep.active_ms), options.modelCallTimeoutMs)
      } catch (err) {
        ep = addActive(core, job, ep, options.monotonicNow() - t0)
        const reason = err instanceof ProviderError ? err.message : `Provider error (${(err as Error).name})`
        ep = switchToFallback(core, job, scope, ep, `live provider failed: ${truncate(reason, 160)}`)
        continue
      }
      ep = addActive(core, job, ep, options.monotonicNow() - t0)
    } else {
      // Only the script's own steps count against its budget; the live model's turns were already limited separately.
      if (ep.steps_used - ep.turns_used >= options.maxScriptedSteps) {
        failEpisode(core, job, scope, ep, stage, "Investigation step budget exhausted without a finding.")
        return
      }
      raw = scriptedStep(state, stage)
    }

    const parsed = StepSchema.safeParse(raw)
    if (!parsed.success) {
      ep = recordRejected(core, job, scope, ep, history, { invalid: true }, "Output was not a valid step: return one JSON tool step or one finding.")
      continue
    }
    const step = parsed.data as Step
    if (step.type === "finding") {
      const problem = validateFinding(state, step.finding)
      if (problem) {
        ep = recordRejected(core, job, scope, ep, history, step, problem)
        continue
      }
      // A live model that finishes without proposing any allowed action would leave the case stuck at
      // "more evidence needed". Hand the same case to the scripted path instead, visibly and with the reason.
      if (ep.mode === "live_ai" && !state.proposal) {
        ep = switchToFallback(core, job, scope, ep, "live model reported a finding but proposed no allowed action, so the scripted path completes the safe step")
        continue
      }
      finalize(core, options, job, scope, stage, state, ep, step.finding)
      return
    }

    const run = runTool(state, eligible, step.tool, step.args)
    if (!run.ok) {
      ep = recordRejected(core, job, scope, ep, history, { type: "tool", tool: truncate(step.tool, 64), args: {} }, run.error)
      continue
    }
    const kind = TOOLS[step.tool]!.kind
    applyOutcome(state, step.tool, kind, run.outcome, ep.mode)
    ep = recordStep(core, job, scope, ep, history, step, run.outcome, step.tool, kind)
  }
}

function ensureEpisodeRow(core: CoreRuntime, tx: Parameters<Parameters<CoreRuntime["db"]["write"]>[0]>[0], scope: Scope, key: string, stage: Stage, mode: Mode, reason: string | null, at: string): EpisodeRow {
  const id = opaqueId("eps", scope.generation, scope.incidentId, key)
  tx.run(
    `INSERT OR IGNORE INTO wf_episodes (id, generation, incident_id, episode_key, stage, mode, mode_reason, status, started_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'RUNNING', ?)`,
    [id, scope.generation, scope.incidentId, key, stage, mode, reason, at],
  )
  void core
  return getEpisode(tx, id)!
}

async function callProvider(provider: ModelProvider, ctx: StepContext, remainingMs: number, perCallMs: number): Promise<unknown> {
  const started = Date.now()
  for (let attempt = 0; attempt < 2; attempt++) {
    const budget = Math.min(perCallMs, remainingMs - (Date.now() - started))
    if (budget <= 0) throw new ProviderError("Provider call exceeded the episode budget", false)
    const ac = new AbortController()
    let timer: NodeJS.Timeout | undefined
    try {
      return await Promise.race([
        provider.next(ctx, ac.signal),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            ac.abort()
            reject(new ProviderError("Provider call timed out", true))
          }, budget)
        }),
      ])
    } catch (err) {
      const transient = err instanceof ProviderError ? err.transient : true
      if (attempt === 0 && transient) continue // one transient retry within the budget
      throw err
    } finally {
      clearTimeout(timer)
    }
  }
  throw new ProviderError("Provider retry exhausted", false)
}

function validateFinding(state: ToolState, f: Finding): string | null {
  const invented = f.evidenceIds.filter((id) => !state.citable.has(id))
  if (invented.length) return `Finding cites ids not returned in this run: ${invented.slice(0, 5).join(", ")}.`
  if (f.hypothesis && f.evidenceIds.length === 0) return "A hypothesis must cite evidence returned in this run."
  if (state.citable.size === 0) return "Read the incident's evidence before reporting a finding."
  return null
}

function applyOutcome(state: ToolState, tool: string, kind: "read" | "proposal", o: ToolOutcome, mode: Mode): void {
  for (const ev of o.newEvidence) {
    state.retrieved.set(ev.id, ev)
    state.citable.add(ev.id)
  }
  for (const c of o.newCitable) state.citable.add(c.id)
  if (o.ok) state.used.add(tool)
  if (!o.ok && kind === "proposal" && mode === "scripted_fallback") state.deniedProposals.add(tool)
  if (o.proposal) state.proposal = o.proposal
}

function recordStep(
  core: CoreRuntime, job: Job, scope: Scope, ep: EpisodeRow, history: HistoryItem[], step: Step, o: ToolOutcome,
  tool: string, kind: "read" | "proposal",
): EpisodeRow {
  const stepNo = history.length + 1
  const stored = { ...o.modelResult, __tool: tool, __kind: kind, ...(o.proposal ? { __proposal: o.proposal } : {}) }
  const next = core.db.write((tx) => {
    guardJob(core, tx, job)
    const now = core.clock.now()
    tx.run(
      "INSERT OR IGNORE INTO wf_steps (episode_id, step_no, generation, incident_id, mode, step_json, result_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [ep.id, stepNo, scope.generation, scope.incidentId, ep.mode, JSON.stringify(step), JSON.stringify(stored)],
    )
    for (const ev of o.newEvidence) {
      tx.run(
        "INSERT OR IGNORE INTO wf_retrieved (episode_id, evidence_id, generation, incident_id, kind, record_json) VALUES (?, ?, ?, ?, ?, ?)",
        [ep.id, ev.id, scope.generation, scope.incidentId, ev.kind, JSON.stringify(ev)],
      )
    }
    for (const c of o.newCitable) {
      tx.run(
        "INSERT OR IGNORE INTO wf_retrieved (episode_id, evidence_id, generation, incident_id, kind, record_json) VALUES (?, ?, ?, ?, ?, '{}')",
        [ep.id, c.id, scope.generation, scope.incidentId, c.kind],
      )
    }
    addTrace(tx, scope, `${ep.episode_key}:step:${stepNo}`, {
      at: now, mode: ep.mode, stage: kind === "read" ? "evidence" : "proposal", summary: o.summary, tool, evidenceIds: o.evidenceIds,
    })
    const args = step.type === "tool" ? step.args : {}
    const call = kind === "read"
      ? describeRead(tool, args, o.newEvidence, o.summary, o.ok, ep.stage === "continuation" ? "continuation" : "triage", o.modelResult)
      : describeProposal(tool, args, o.modelResult, o.ok, o.summary)
    addProcessLog(tx, scope, `${ep.episode_key}:step:${stepNo}`, { at: now, ...call, summary: o.summary, evidenceIds: o.evidenceIds })
    tx.run("UPDATE wf_episodes SET steps_used = steps_used + 1 WHERE id = ?", [ep.id])
    return getEpisode(tx, ep.id)!
  })
  history.push({ step, result: o.modelResult })
  return next
}

function recordRejected(core: CoreRuntime, job: Job, scope: Scope, ep: EpisodeRow, history: HistoryItem[], step: unknown, error: string): EpisodeRow {
  const stepNo = history.length + 1
  const result = { ok: false, error }
  const next = core.db.write((tx) => {
    guardJob(core, tx, job)
    tx.run(
      "INSERT OR IGNORE INTO wf_steps (episode_id, step_no, generation, incident_id, mode, step_json, result_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [ep.id, stepNo, scope.generation, scope.incidentId, ep.mode, JSON.stringify(step), JSON.stringify(result)],
    )
    addTrace(tx, scope, `${ep.episode_key}:step:${stepNo}`, {
      at: core.clock.now(), mode: ep.mode, stage: "guardrail", summary: `Rejected step: ${truncate(error, 240)}`,
    })
    addProcessLog(tx, scope, `${ep.episode_key}:step:${stepNo}`, {
      at: core.clock.now(), stepId: readStepId(ep.stage === "continuation" ? "continuation" : "triage"), kind: "decision", system: "Guardrail",
      method: "CATCH", endpoint: "validateStep", request: truncate(JSON.stringify(step ?? null), 400), response: { error, handled: "the AI was asked again" }, outcome: "INFO",
      summary: `Guardrail caught a malformed AI output and asked again (${truncate(error, 160)})`,
    })
    tx.run("UPDATE wf_episodes SET steps_used = steps_used + 1 WHERE id = ?", [ep.id])
    return getEpisode(tx, ep.id)!
  })
  history.push({ step, result })
  return next
}

function addActive(core: CoreRuntime, job: Job, ep: EpisodeRow, ms: number): EpisodeRow {
  return core.db.write((tx) => {
    guardJob(core, tx, job)
    tx.run("UPDATE wf_episodes SET active_ms = active_ms + ? WHERE id = ?", [Math.max(0, Math.round(ms)), ep.id])
    return getEpisode(tx, ep.id)!
  })
}

function switchToFallback(core: CoreRuntime, job: Job, scope: Scope, ep: EpisodeRow, reason: string): EpisodeRow {
  return core.db.write((tx) => {
    guardJob(core, tx, job)
    tx.run("UPDATE wf_episodes SET mode = 'scripted_fallback', mode_reason = ? WHERE id = ? AND mode = 'live_ai'", [reason, ep.id])
    addTrace(tx, scope, `${ep.episode_key}:fallback`, {
      at: core.clock.now(), mode: "scripted_fallback", stage: "investigation",
      summary: `Switched to scripted fallback: ${reason}. Same evidence, policy, writes and verifier apply.`,
    })
    return getEpisode(tx, ep.id)!
  })
}

function failEpisode(core: CoreRuntime, job: Job, scope: Scope, ep: EpisodeRow, stage: Stage, reason: string): void {
  core.db.write((tx) => {
    guardJob(core, tx, job)
    const incident = core.incidents.get(tx, scope)
    const now = core.clock.now()
    tx.run("UPDATE wf_episodes SET status = 'COMPLETED', outcome = 'FAILED', finished_at = ? WHERE id = ? AND status = 'RUNNING'", [now, ep.id])
    if (incident && (incident.card.status === "INVESTIGATING" || incident.card.status === "PARTIALLY_RECOVERED")) {
      transition(core, tx, scope, incident, {
        to: "FAILED", blocker: `${reason} Retryable: request investigation again.`, mode: ep.mode, stage: "investigation",
        reason, opKey: `${ep.episode_key}:failed`,
      })
      saveState(tx, scope, now, { scenario: incident.card.scenario, phase: stage === "triage" ? "TRIAGE" : "RESTART_PROPOSAL", blockerCode: "INVESTIGATION_FAILED", retryable: true })
    }
  })
}

function modeNote(ep: EpisodeRow): string {
  return ep.mode === "live_ai" ? "live_ai" : `scripted_fallback: ${ep.mode_reason ?? "fallback"}`
}

/** Persist the finding and act on the proposal under an authoritative policy re-check, in one transaction. */
function finalize(
  core: CoreRuntime, options: WorkflowOptions, job: Job, scope: Scope, stage: Stage, state: ToolState, epIn: EpisodeRow, finding: Finding,
): void {
  core.db.write((tx) => {
    guardJob(core, tx, job)
    const ep = getEpisode(tx, epIn.id)
    if (!ep || ep.status !== "RUNNING") return
    const incident = core.incidents.get(tx, scope)
    if (!incident) return
    const now = core.clock.now()
    const expected = stage === "triage" ? "INVESTIGATING" : "PARTIALLY_RECOVERED"
    if (incident.card.status !== expected) {
      tx.run("UPDATE wf_episodes SET status = 'ABANDONED', outcome = ?, finished_at = ? WHERE id = ?", [`status ${incident.card.status}`, now, ep.id])
      return
    }
    const mode = ep.mode
    const actor = `workflow:investigator(${mode})`
    saveFinding(tx, scope, ep.id, now, mode, finding)
    addTrace(tx, scope, `${ep.episode_key}:finding`, {
      at: now, mode, stage: "finding",
      summary: `Finding: ${truncate(finding.hypothesis ?? "no hypothesis; " + (finding.missingEvidence.join("; ") || "insufficient evidence"), 300)}`,
      evidenceIds: finding.evidenceIds,
    })

    addProcessLog(tx, scope, `${ep.episode_key}:finding`, {
      at: now, stepId: readStepId(stage), kind: "result", system: `Investigator (${mode === "live_ai" ? "AI model" : "scripted fallback"})`, method: "FINDING",
      endpoint: "finding", request: { citedEvidence: finding.evidenceIds.length },
      response: { hypothesis: finding.hypothesis, observations: finding.observations, uncertainty: finding.uncertainty, missingEvidence: finding.missingEvidence },
      httpStatus: null, outcome: "INFO", summary: `Finding: ${truncate(finding.hypothesis ?? "no hypothesis", 200)}`, evidenceIds: finding.evidenceIds,
    })

    const p = state.proposal
    let decision: PolicyDecision | null = null
    if (p && (p.kind === "sync" || p.kind === "restart" || p.kind === "link" || p.kind === "resend")) {
      const latest = latestVerification(tx, scope, { finalOnly: true })
      decision = evaluateAction(
        { incident, retrieved: state.retrieved, latestChecks: latest ? deviceChecks(latest) : null, existingRestartApprovals: countRestartApprovals(tx, scope) },
        p.kind === "link"
          ? { kind: "LINK_SUPPORT_TICKETS", groups: p.groups }
          : p.kind === "resend"
            ? { kind: "RESEND_WEBHOOK", targetIds: p.decision.targetIds }
            : { kind: p.kind === "sync" ? "MOCK_SYNC_DEVICE_CONFIG" : "MOCK_RESTART_DEVICE", targetIds: p.decision.targetIds },
      )
    }
    let outcome = "NO_ACTION"

    if (p?.kind === "sync" && decision?.allowed) {
      const auditId = addAudit(tx, scope, `${ep.episode_key}:sync-proposed`, {
        at: now, actor, event: "ACTION_AUTHORIZED", summary: `Policy ${decision.ruleId} authorized mock config sync of ${decision.targetIds.length} devices.`,
        evidenceIds: p.evidenceIds,
      })
      const a = insertAction(tx, scope, {
        opKey: "sync", kind: "MOCK_SYNC_DEVICE_CONFIG", targetIds: decision.targetIds, args: { mode: "mock", profile: "notification-default" },
        ruleId: decision.ruleId, summary: truncate(p.rationale, 400), requiresApproval: false, evidenceIds: p.evidenceIds, auditId, at: now,
      })
      if (a.created) {
        transition(core, tx, scope, incident, { to: "ACTION_RUNNING", mode, stage: "decision", reason: `Mock config sync authorized by ${decision.ruleId} (${modeNote(ep)}).`, opKey: `${ep.episode_key}:sync`, auditId, evidenceIds: p.evidenceIds })
        saveState(tx, scope, now, { scenario: incident.card.scenario, phase: "SYNC" })
        core.jobs.enqueue(tx, { ...scope, key: `execute:${a.id}`, kind: "workflow.execute", runAfter: now, payload: { actionId: a.id } })
        outcome = "SYNC_QUEUED"
      }
    } else if (p?.kind === "restart" && decision?.allowed) {
      const latest = latestVerification(tx, scope, { finalOnly: true })!
      const opKey = `restart:${latest.id}`
      const auditId = addAudit(tx, scope, `${ep.episode_key}:restart-requested`, {
        at: now, actor, event: "APPROVAL_REQUESTED", summary: `Restart of ${decision.targetIds.length} unresolved devices requires approval (${decision.ruleId}).`,
        evidenceIds: p.evidenceIds,
      })
      const a = insertAction(tx, scope, {
        opKey, kind: "MOCK_RESTART_DEVICE", targetIds: decision.targetIds, args: { mode: "mock", restartType: "soft" },
        ruleId: decision.ruleId, summary: truncate(p.rationale, 400), requiresApproval: true, evidenceIds: p.evidenceIds, auditId, at: now,
      })
      if (a.created) {
        const approval = createRestartApproval(core, tx, scope, incident, {
          actionId: a.id, targetIds: decision.targetIds, checkpoint: latest.id, ruleId: decision.ruleId,
          rationale: truncate(p.rationale, 600), evidenceIds: p.evidenceIds, ttlMs: options.approvalTtlMs,
          recoveredBefore: latest.recovered, total: latest.total,
        })
        tx.run("UPDATE wf_audit SET approval_id = ? WHERE id = ?", [approval.id, auditId])
        addProcessLog(tx, scope, `approval:${approval.id}:requested`, {
          at: now, stepId: "approve", kind: "wait", system: "Approval Center", method: "REQUEST", endpoint: "/approvals",
          request: { action: "MOCK_RESTART_DEVICE", targets: sampleList(decision.targetIds), rule: decision.ruleId, expiresInSeconds: Math.round(options.approvalTtlMs / 1000) },
          response: { approvalId: approval.id, status: "PENDING", expiresAt: approval.expires_at, proposalRevision: approval.proposal_revision },
          httpStatus: 202, outcome: "INFO", summary: `Waiting for a human approver to decide on ${decision.targetIds.length} devices.`, actionId: a.id, evidenceIds: p.evidenceIds,
        })
        transition(core, tx, scope, incident, {
          to: "APPROVAL_PENDING", blocker: `Awaiting human approval to mock-restart ${decision.targetIds.length} devices (${latest.recovered}/${latest.total} recovered).`,
          mode, stage: "decision", reason: `Restricted restart proposed under ${decision.ruleId} (${modeNote(ep)}).`, opKey: `${ep.episode_key}:restart`, auditId, evidenceIds: p.evidenceIds,
        })
        saveState(tx, scope, now, { scenario: incident.card.scenario, phase: "AWAITING_APPROVAL" })
        outcome = "APPROVAL_REQUESTED"
      }
    } else if (p?.kind === "link" && decision?.allowed) {
      const auditId = addAudit(tx, scope, `${ep.episode_key}:link-proposed`, {
        at: now, actor, event: "ACTION_AUTHORIZED", summary: `Policy ${decision.ruleId} authorized: ${decision.reason}`,
        evidenceIds: p.evidenceIds,
      })
      const groups = decision.groups ?? p.groups
      const a = insertAction(tx, scope, {
        opKey: "link", kind: "LINK_SUPPORT_TICKETS", targetIds: decision.targetIds, args: { primaryTicketId: groups[0]?.primaryTicketId ?? p.primaryTicketId, groups },
        ruleId: decision.ruleId, summary: truncate(p.rationale, 400), requiresApproval: false, evidenceIds: p.evidenceIds, auditId, at: now,
      })
      if (a.created) {
        transition(core, tx, scope, incident, { to: "ACTION_RUNNING", mode, stage: "decision", reason: `Ticket linking authorized by ${decision.ruleId} (${modeNote(ep)}).`, opKey: `${ep.episode_key}:link`, auditId, evidenceIds: p.evidenceIds })
        saveState(tx, scope, now, { scenario: incident.card.scenario, phase: "LINKING" })
        core.jobs.enqueue(tx, { ...scope, key: `execute:${a.id}`, kind: "workflow.execute", runAfter: now, payload: { actionId: a.id } })
        outcome = "LINK_QUEUED"
      }
    } else if (p?.kind === "resend" && decision?.allowed) {
      const auditId = addAudit(tx, scope, `${ep.episode_key}:resend-proposed`, {
        at: now, actor, event: "ACTION_AUTHORIZED", summary: `Policy ${decision.ruleId} authorized resending the webhook for ${decision.targetIds.length} orders.`,
        evidenceIds: p.evidenceIds,
      })
      const a = insertAction(tx, scope, {
        opKey: "resend", kind: "RESEND_WEBHOOK", targetIds: decision.targetIds, args: { event: "TXN_SUCCESS", mode: "mock" },
        ruleId: decision.ruleId, summary: truncate(p.rationale, 400), requiresApproval: false, evidenceIds: p.evidenceIds, auditId, at: now,
      })
      if (a.created) {
        transition(core, tx, scope, incident, { to: "ACTION_RUNNING", mode, stage: "decision", reason: `Webhook resend authorized by ${decision.ruleId} (${modeNote(ep)}).`, opKey: `${ep.episode_key}:resend`, auditId, evidenceIds: p.evidenceIds })
        saveState(tx, scope, now, { scenario: incident.card.scenario, phase: "RESEND" })
        core.jobs.enqueue(tx, { ...scope, key: `execute:${a.id}`, kind: "workflow.execute", runAfter: now, payload: { actionId: a.id } })
        outcome = "RESEND_QUEUED"
      }
    } else if (p?.kind === "handoff") {
      const auditId = addAudit(tx, scope, `${ep.episode_key}:handoff`, {
        at: now, actor, event: "SETTLEMENT_HANDOFF", summary: `Factual handoff to ${SETTLEMENT_OWNER}. Settlement data is read-only; no financial change was made.`,
        evidenceIds: p.evidenceIds,
      })
      addEscalation(tx, scope, `${ep.episode_key}:handoff`, { at: now, reasonCode: "SETTLEMENT_DISCREPANCY", summary: p.summary, owner: SETTLEMENT_OWNER, retryable: false, evidenceIds: p.evidenceIds })
      addProcessLog(tx, scope, `${ep.episode_key}:handoff`, {
        at: now, stepId: "handoff", kind: "call", system: "Escalation queue", method: "CREATE", endpoint: "/escalations",
        request: { owner: SETTLEMENT_OWNER, reasonCode: "SETTLEMENT_DISCREPANCY", financialChange: "none (read-only)" },
        response: { owner: SETTLEMENT_OWNER, status: "OPEN", summary: truncate(p.summary, 400), evidenceCount: p.evidenceIds.length },
        httpStatus: 201, outcome: "OK", summary: `Handed the evidence packet to ${SETTLEMENT_OWNER}. No settlement record was changed.`, evidenceIds: p.evidenceIds,
      })
      transition(core, tx, scope, incident, {
        to: "ESCALATED", blocker: truncate(p.summary, 600), owner: SETTLEMENT_OWNER, mode, stage: "handoff",
        reason: `Settlement discrepancy handed off to ${SETTLEMENT_OWNER} (${modeNote(ep)}).`, opKey: `${ep.episode_key}:handoff`, auditId, evidenceIds: p.evidenceIds,
      })
      saveState(tx, scope, now, { scenario: incident.card.scenario, phase: "DONE", blockerCode: "SETTLEMENT_HANDOFF" })
      outcome = "HANDOFF"
    } else if (p?.kind === "escalate") {
      const owner = incident.card.scenario === "settlement-discrepancy" ? SETTLEMENT_OWNER : FIELD_OWNER
      const auditId = addAudit(tx, scope, `${ep.episode_key}:escalate`, { at: now, actor, event: "ESCALATED", summary: truncate(p.reason, 400), evidenceIds: p.evidenceIds })
      addEscalation(tx, scope, `${ep.episode_key}:escalate`, { at: now, reasonCode: "INVESTIGATOR_ESCALATION", summary: p.reason, owner, retryable: false, evidenceIds: p.evidenceIds })
      transition(core, tx, scope, incident, { to: "ESCALATED", blocker: truncate(p.reason, 600), owner, mode, stage: "decision", reason: `Investigator escalated (${modeNote(ep)}).`, opKey: `${ep.episode_key}:escalate`, auditId })
      saveState(tx, scope, now, { scenario: incident.card.scenario, phase: "DONE", blockerCode: "ESCALATED" })
      outcome = "ESCALATED"
    }

    if (outcome === "NO_ACTION") {
      const why = decision && !decision.allowed
        ? `Policy ${decision.ruleId} denied the proposal at commit: ${decision.reason}`
        : finding.missingEvidence.length ? `Missing evidence: ${finding.missingEvidence.join("; ")}` : "No safe allowed step was supported by the evidence."
      if (decision && !decision.allowed) {
        addAudit(tx, scope, `${ep.episode_key}:denied`, { at: now, actor, event: "POLICY_DENIED", summary: truncate(why, 400) })
      }
      if (stage === "triage") {
        transition(core, tx, scope, incident, { to: "INSUFFICIENT_EVIDENCE", blocker: truncate(why, 600), mode, stage: "decision", reason: `${truncate(why, 200)} (${modeNote(ep)})`, opKey: `${ep.episode_key}:insufficient` })
        saveState(tx, scope, now, { scenario: incident.card.scenario, phase: "TRIAGE", blockerCode: "INSUFFICIENT_EVIDENCE", retryable: true })
      } else {
        addEscalation(tx, scope, `${ep.episode_key}:no-restart`, { at: now, reasonCode: "NO_SAFE_STEP", summary: why, owner: FIELD_OWNER, retryable: false, evidenceIds: [] })
        transition(core, tx, scope, incident, { to: "ESCALATED", blocker: truncate(why, 600), owner: FIELD_OWNER, mode, stage: "decision", reason: `${truncate(why, 200)} (${modeNote(ep)})`, opKey: `${ep.episode_key}:escalated` })
        saveState(tx, scope, now, { scenario: incident.card.scenario, phase: "DONE", blockerCode: "NO_SAFE_STEP" })
      }
    }
    tx.run("UPDATE wf_episodes SET status = 'COMPLETED', outcome = ?, finished_at = ? WHERE id = ?", [outcome, now, ep.id])
  })
}
