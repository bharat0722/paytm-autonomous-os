// PROVISIONAL COPY of Owner 01's in-process core contract (Shared agreement v1).
// Owner 01 owns this file; reproduced verbatim so the workflow can compile and
// be tested before the bootstrap PR merges. On rebase, take Owner 01's version.
import type { RequestHandler, Router } from "express"
import type {
  ActionKind, EvidenceView, IncidentCard, IncidentStatus, Role, Scope, WorkflowView
} from "./http.js"

export type JobKind = "workflow.investigate" | "workflow.execute" | "workflow.verify"
  | "workflow.expire" | "core.telemetry"
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

/** Legal incident status edges, published once and consumed by core and workflow. */
export const INCIDENT_TRANSITIONS: Readonly<Record<IncidentStatus, readonly IncidentStatus[]>> = {
  DETECTED: ["INVESTIGATING", "FAILED"],
  INVESTIGATING: ["ACTION_RUNNING", "INSUFFICIENT_EVIDENCE", "ESCALATED", "FAILED"],
  ACTION_RUNNING: ["VERIFYING", "ESCALATED", "FAILED"],
  VERIFYING: ["PARTIALLY_RECOVERED", "RESOLVED", "TASK_COMPLETED", "ESCALATED", "FAILED"],
  PARTIALLY_RECOVERED: ["APPROVAL_PENDING", "VERIFYING", "ESCALATED", "FAILED"],
  APPROVAL_PENDING: ["ACTION_RUNNING", "ESCALATED", "FAILED"],
  INSUFFICIENT_EVIDENCE: ["INVESTIGATING", "ESCALATED"],
  FAILED: ["INVESTIGATING", "ESCALATED"],
  RESOLVED: [],
  TASK_COMPLETED: [],
  ESCALATED: [],
}

export function canTransition(from: IncidentStatus, to: IncidentStatus): boolean {
  return INCIDENT_TRANSITIONS[from].includes(to)
}
