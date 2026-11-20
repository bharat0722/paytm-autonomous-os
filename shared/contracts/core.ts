// Shared agreement v1 · Backend boundary between Owner 01 (core) and Owner 02 (workflow).
// These are trusted in-process ports. The model only ever gets validated tools built on top.
import type { RequestHandler, Router } from "express"
import type {
  ActionKind, EvidenceView, IncidentCard, IncidentStatus, Role, Scope, WorkflowView
} from "./http.js"

export type JobKind = "workflow.investigate" | "workflow.execute" | "workflow.verify"
  | "workflow.expire" | "core.telemetry" | "core.payment_detect"
export type JobInput = Scope & {
  key: string; kind: JobKind; runAfter: string; payload: Record<string, unknown>;
}
export type Job = JobInput & { leaseToken: string; attempt: number }
export type JobHandler = (job: Job) => Promise<void>
export type SqlValue = string | number | null
export interface Sql {
  get<T>(sql: string, args?: SqlValue[]): T | undefined
  all<T>(sql: string, args?: SqlValue[]): T[]
  run(sql: string, args?: SqlValue[]): { changes: number }
}
export interface CohortDevice { id: string; merchantId: string; revision: string }
export interface CoreIncident {
  card: IncidentCard; devices: CohortDevice[]; blocker: string | null; owner: string | null;
  /** How the incident was grouped (rule, window, excluded decoys). Optional: not every core provides it. */
  correlation?: Record<string, unknown>;
}
export interface CoreTransition {
  expectedVersion: number; status: IncidentStatus; blocker: string | null; owner: string | null;
  verifiedCheckId?: string;
}
export interface ReadRequest {
  kind: EvidenceView["kind"]; ids?: string[]; limit?: number;
}
export interface SimulationInput {
  actionId: string; kind: ActionKind; targetIds: string[];
  /** LINK_SUPPORT_TICKETS only (optional, additive): explicit primary per duplicate group. */
  links?: { primaryId: string; duplicateIds: string[] }[];
}
export interface AppliedTarget {
  targetId: string; ok: boolean; appliedAt: string; priorSequence: number; reason: string | null;
}
export interface Observation {
  id: string; deviceId: string; actionId: string | null; sequence: number; occurredAt: string;
  kind: "heartbeat" | "config" | "notification_probe"; passed: boolean;
}
export interface CoreRuntime {
  db: { read<T>(fn: (q: Sql) => T): T; write<T>(fn: (tx: Sql) => T): T };
  clock: { now(): string; telemetryNow(q: Sql, scope: Scope): string };
  activeGeneration(q: Sql): number;
  jobs: { enqueue(tx: Sql, input: JobInput): void; assertLease(tx: Sql, job: Job): void };
  incidents: {
    get(q: Sql, scope: Scope): CoreIncident | null;
    transition(tx: Sql, scope: Scope, change: CoreTransition): CoreIncident;
  };
  evidence: {
    read(q: Sql, scope: Scope, request: ReadRequest): EvidenceView[];
    observations(q: Sql, scope: Scope, deviceIds: string[]): Observation[];
  };
  simulation: { apply(tx: Sql, scope: Scope, input: SimulationInput): AppliedTarget[] };
}
export interface WorkflowModule {
  handlers: Partial<Record<JobKind, JobHandler>>;
  getIncidentWorkflow(q: Sql, scope: Scope): WorkflowView;
  countPendingApprovals(q: Sql, generation: number): number;
  registerRoutes(router: Router, requireRole: (role: Role) => RequestHandler): void;
}
export type WorkflowFactory = (core: CoreRuntime) => WorkflowModule

/**
 * Legal incident status edges (published once, consumed by core and workflow).
 * A same-status VERIFYING -> VERIFYING edge persists an interim check.
 * Owner 02 owns the policy and evidence preconditions for each edge;
 * core enforces only that the edge exists.
 */
export const INCIDENT_TRANSITIONS: Readonly<Record<IncidentStatus, readonly IncidentStatus[]>> = Object.freeze({
  DETECTED: ["INVESTIGATING", "FAILED"],
  INVESTIGATING: ["ACTION_RUNNING", "INSUFFICIENT_EVIDENCE", "ESCALATED", "FAILED"],
  ACTION_RUNNING: ["VERIFYING", "ESCALATED", "FAILED"],
  VERIFYING: ["VERIFYING", "PARTIALLY_RECOVERED", "RESOLVED", "TASK_COMPLETED", "ESCALATED", "FAILED"],
  PARTIALLY_RECOVERED: ["APPROVAL_PENDING", "VERIFYING", "ESCALATED", "FAILED"],
  APPROVAL_PENDING: ["ACTION_RUNNING", "ESCALATED", "FAILED"],
  INSUFFICIENT_EVIDENCE: ["INVESTIGATING", "ESCALATED"],
  FAILED: ["INVESTIGATING", "ESCALATED"],
  RESOLVED: [],
  TASK_COMPLETED: [],
  ESCALATED: []
})

/** Terminal states end the automated run. */
export const TERMINAL_STATUSES: readonly IncidentStatus[] = ["RESOLVED", "TASK_COMPLETED", "ESCALATED"]

export function isLegalTransition(from: IncidentStatus, to: IncidentStatus): boolean {
  return INCIDENT_TRANSITIONS[from].includes(to)
}

/** Alias used by the workflow module (feat/workflow). Same semantics as isLegalTransition. */
export const canTransition = isLegalTransition

/** Errors thrown by core ports. `code` maps to the HTTP error codes. */
export class CoreError extends Error {
  constructor(public readonly code: "STALE_GENERATION" | "NOT_FOUND" | "INVALID_INPUT" | "CONFLICT" | "FENCED", message: string) {
    super(message)
    this.name = "CoreError"
  }
}

/** Documented defaults (shared agreement v1). */
export const CORE_DEFAULTS = Object.freeze({
  correlationWindowMinutes: 5,
  correlationMinMerchants: 3,
  jobLeaseMs: 30_000,
  jobMaxAttempts: 5,
  evidenceReadLimit: 50,
  evidenceReadMaxLimit: 200
})

/** Stable job key for the initial investigation enqueued by injection. */
export const initialInvestigationKey = (incidentId: string) => `investigate:${incidentId}:initial`
