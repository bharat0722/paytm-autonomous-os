import type { WorkflowModule } from "../../../shared/contracts/core.js"
import type { Actor, IncidentStatus, Scenario, WorkflowView } from "../../../shared/contracts/http.js"
import { decideApproval } from "../../../server/workflow/approvals.js"
import { DEFAULT_OPTIONS, type WorkflowOptions } from "../../../server/workflow/config.js"
import { createWorkflowWith } from "../../../server/workflow/index.js"
import type { ModelProvider } from "../../../server/workflow/investigator/provider.js"
import { createFakeCore, createRunner, type FakeCore, type JobRunner } from "./fakeCore.js"

export const OPERATOR: Actor = { id: "op-1", role: "operator" }
export const APPROVER: Actor = { id: "ap-1", role: "approver" }

export interface Harness {
  fake: FakeCore
  workflow: WorkflowModule
  runner: JobRunner
  options: WorkflowOptions
  status(incidentId: string): IncidentStatus
  view(incidentId: string): WorkflowView
  runUntil(incidentId: string, statuses: IncidentStatus[]): Promise<IncidentStatus>
  pendingApproval(incidentId: string): WorkflowView["approvals"][number]
  decide(incidentId: string, decision: "approve" | "reject", actor?: Actor): ReturnType<typeof decideApproval>
  inject(scenario: Scenario, variant?: "success" | "partial"): string
}

export function makeHarness(over: Partial<WorkflowOptions> & { provider?: ModelProvider | null; path?: string; fake?: FakeCore } = {}): Harness {
  const fake = over.fake ?? createFakeCore({ path: over.path })
  let mono = 0
  const options: WorkflowOptions = {
    ...DEFAULT_OPTIONS,
    investigatorMode: over.provider ? "sarvam" : "scripted",
    provider: over.provider ?? null,
    providerUnavailableReason: null,
    monotonicNow: () => (mono += 100),
    ...over,
  }
  const workflow = createWorkflowWith(fake.core, options)
  const runner = createRunner(fake, workflow.handlers)
  const scopeOf = (incidentId: string) => ({ generation: Number(incidentId.match(/_g(\d+)_/)![1]), incidentId })
  const h: Harness = {
    fake, workflow, runner, options,
    status: (id) => fake.incident(id).card.status,
    view: (id) => fake.core.db.read((q) => workflow.getIncidentWorkflow(q, scopeOf(id))),
    async runUntil(id, statuses) {
      await runner.drain({ until: () => statuses.includes(h.status(id)) })
      return h.status(id)
    },
    pendingApproval(id) {
      const a = h.view(id).approvals.find((x) => x.status === "PENDING")
      if (!a) throw new Error("no pending approval")
      return a
    },
    decide(id, decision, actor = APPROVER) {
      const a = h.view(id).approvals[0]!
      return decideApproval(fake.core, actor, scopeOf(id).generation, a.id, { decision, proposalRevision: a.proposalRevision })
    },
    inject: (scenario, variant) => fake.inject(scenario, variant).incidentId,
  }
  return h
}
