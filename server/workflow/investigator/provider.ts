import { z } from "zod"
import { FindingSchema } from "../../../shared/contracts/http.js"
import type { Finding, IncidentStatus, Scenario } from "../../../shared/contracts/http.js"

export type Stage = "triage" | "continuation"

/** One strict investigator step: exactly one registered tool call, or a structured finding. */
export type Step =
  | { type: "tool"; tool: string; args: Record<string, unknown> }
  | { type: "finding"; finding: Finding }

export const StepSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("tool"), tool: z.string().min(1).max(64), args: z.record(z.string(), z.unknown()).default({}) }).strict(),
  z.object({ type: z.literal("finding"), finding: FindingSchema.extend({
    observations: z.array(z.string().max(500)).max(20),
    hypothesis: z.string().max(800).nullable(),
    evidenceIds: z.array(z.string().max(120)).max(100),
    uncertainty: z.string().max(500),
    missingEvidence: z.array(z.string().max(300)).max(20),
  }).strict() }).strict(),
])

export interface ToolDescriptor { name: string; description: string; args: string }

/** What a provider sees. History holds validated steps and sanitized tool results only. */
export interface StepContext {
  incident: { id: string; scenario: Scenario; title: string; status: IncidentStatus; cohortDeviceIds: string[] }
  stage: Stage
  tools: ToolDescriptor[]
  history: { step: unknown; result: Record<string, unknown> }[]
}

export interface ModelProvider {
  readonly name: string
  next(ctx: StepContext, signal: AbortSignal): Promise<unknown>
}

export class ProviderError extends Error {
  constructor(message: string, readonly transient: boolean) {
    super(message)
    this.name = "ProviderError"
  }
}
