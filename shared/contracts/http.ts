// PROVISIONAL COPY of Owner 01's shared contract (Shared agreement v1).
// Owner 01 owns this file. It is reproduced verbatim from the agreement so the
// workflow branch can compile before the bootstrap PR merges. On rebase, take
// Owner 01's version.
import { z } from "zod"

export type Scenario = "soundbox" | "duplicate-tickets" | "settlement-discrepancy"
export type Role = "operator" | "approver"
export type IncidentStatus =
  | "DETECTED" | "INVESTIGATING" | "INSUFFICIENT_EVIDENCE"
  | "ACTION_RUNNING" | "VERIFYING" | "PARTIALLY_RECOVERED"
  | "APPROVAL_PENDING" | "RESOLVED" | "ESCALATED" | "FAILED" | "TASK_COMPLETED"
export type ActionKind = "MOCK_SYNC_DEVICE_CONFIG" | "MOCK_RESTART_DEVICE" | "LINK_SUPPORT_TICKETS"
export type ApprovalStatus = "PENDING" | "APPROVED" | "REJECTED" | "EXPIRED" | "CONSUMED"
export type Mode = "live_ai" | "scripted_fallback" | "system"

export interface DemoSignIn { role: Role; accessCode: string }
export interface DemoInject { variant: "success" | "partial" }
export interface ApprovalDecision { decision: "approve" | "reject"; proposalRevision: string; reason?: string }
export interface Actor { id: string; role: Role }
export interface SessionView { generation: number; actor: Actor | null; csrfToken: string | null }
export interface Scope { generation: number; incidentId: string }
export interface InjectResult { generation: number; batchId: string; incidentId: string }
export interface StartResult { generation: number; incidentId: string; status: IncidentStatus }
export interface ApprovalQueue { generation: number; approvals: ApprovalView[] }
export interface DecisionResult { generation: number; approval: ApprovalView; queued: boolean }
export interface IncidentCard {
  id: string; scenario: Scenario; title: string; severity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  status: IncidentStatus; version: number; affectedMerchantCount: number;
  affectedDeviceCount: number; updatedAt: string;
}
export interface EvidenceView {
  id: string; kind: "device" | "device_event" | "ticket" | "payment" | "settlement" | "merchant";
  title: string; occurredAt: string | null; details: Record<string, string | number | boolean | null>;
}
export interface TraceEntry {
  id: string; at: string; mode: Mode; stage: string; summary: string;
  tool: string | null; evidenceIds: string[]; auditId: string | null;
}
export interface AuditEntry {
  id: string; at: string; actor: string; event: string; summary: string;
  actionId: string | null; approvalId: string | null; evidenceIds: string[];
}
export interface Finding {
  observations: string[]; hypothesis: string | null; evidenceIds: string[];
  uncertainty: string; missingEvidence: string[];
}
export interface ActionView {
  id: string; kind: ActionKind; targetIds: string[]; args: Record<string, unknown>;
  status: "PROPOSED" | "RUNNING" | "SUCCEEDED" | "PARTIAL" | "FAILED" | "BLOCKED";
  ruleId: string; summary: string; auditId: string | null;
}
export interface ApprovalView {
  id: string; incidentId: string; actionId: string; kind: "MOCK_RESTART_DEVICE";
  proposalRevision: string; targetDeviceIds: string[]; args: Record<string, unknown>;
  ruleId: string; status: ApprovalStatus; createdAt: string; expiresAt: string;
  decidedAt: string | null; decidedBy: string | null; reason: string | null;
  evidenceIds: string[]; rationale: string; impact: string; expectedCheck: string;
}
export interface DeviceCheck {
  deviceId: string; actionId: string | null; status: "PASS" | "FAIL" | "AWAITING";
  reason: string; evidenceIds: string[];
}
export interface RecoveryView {
  id: string; checkedAt: string; total: number; beforeRecovered: number; recovered: number;
  remainingDeviceIds: string[]; devices: DeviceCheck[];
}
export interface WorkflowView {
  finding: Finding | null; trace: TraceEntry[]; audit: AuditEntry[]; actions: ActionView[];
  approvals: ApprovalView[]; recovery: RecoveryView | null;
}
export interface IncidentView {
  generation: number; incident: IncidentCard; evidence: EvidenceView[];
  blocker: string | null; owner: string | null; workflow: WorkflowView;
}
export interface DashboardView {
  generation: number;
  kpis: { activeIncidents: number; affectedMerchants: number; verifiedResolved: number; pendingApprovals: number };
  pulse: { key: string; label: string; count: number }[];
  incidents: IncidentCard[];
  activity: (TraceEntry & { incidentId: string })[];
}

// ---------------------------------------------------------------------------
// Runtime schemas (type name + "Schema").
// ---------------------------------------------------------------------------
const iso = z.string()
const detailValue = z.union([z.string(), z.number(), z.boolean(), z.null()])

export const ScenarioSchema = z.enum(["soundbox", "duplicate-tickets", "settlement-discrepancy"])
export const RoleSchema = z.enum(["operator", "approver"])
export const IncidentStatusSchema = z.enum([
  "DETECTED", "INVESTIGATING", "INSUFFICIENT_EVIDENCE", "ACTION_RUNNING", "VERIFYING",
  "PARTIALLY_RECOVERED", "APPROVAL_PENDING", "RESOLVED", "ESCALATED", "FAILED", "TASK_COMPLETED",
])
export const ActionKindSchema = z.enum(["MOCK_SYNC_DEVICE_CONFIG", "MOCK_RESTART_DEVICE", "LINK_SUPPORT_TICKETS"])
export const ApprovalStatusSchema = z.enum(["PENDING", "APPROVED", "REJECTED", "EXPIRED", "CONSUMED"])
export const ModeSchema = z.enum(["live_ai", "scripted_fallback", "system"])

export const DemoSignInSchema = z.object({ role: RoleSchema, accessCode: z.string().min(1) }).strict()
export const DemoInjectSchema = z.object({ variant: z.enum(["success", "partial"]) }).strict()
export const ApprovalDecisionSchema = z.object({
  decision: z.enum(["approve", "reject"]),
  proposalRevision: z.string().min(1).max(200),
  reason: z.string().max(500).optional(),
}).strict()
export const ActorSchema = z.object({ id: z.string(), role: RoleSchema })
export const SessionViewSchema = z.object({
  generation: z.number().int().positive(), actor: ActorSchema.nullable(), csrfToken: z.string().nullable(),
})
export const ScopeSchema = z.object({ generation: z.number().int().positive(), incidentId: z.string() })
export const InjectResultSchema = z.object({ generation: z.number().int(), batchId: z.string(), incidentId: z.string() })
export const StartResultSchema = z.object({ generation: z.number().int(), incidentId: z.string(), status: IncidentStatusSchema })
export const IncidentCardSchema = z.object({
  id: z.string(), scenario: ScenarioSchema, title: z.string(),
  severity: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]), status: IncidentStatusSchema,
  version: z.number().int(), affectedMerchantCount: z.number().int(), affectedDeviceCount: z.number().int(),
  updatedAt: iso,
})
export const EvidenceViewSchema = z.object({
  id: z.string(),
  kind: z.enum(["device", "device_event", "ticket", "payment", "settlement", "merchant"]),
  title: z.string(), occurredAt: iso.nullable(), details: z.record(z.string(), detailValue),
})
export const TraceEntrySchema = z.object({
  id: z.string(), at: iso, mode: ModeSchema, stage: z.string(), summary: z.string(),
  tool: z.string().nullable(), evidenceIds: z.array(z.string()), auditId: z.string().nullable(),
})
export const AuditEntrySchema = z.object({
  id: z.string(), at: iso, actor: z.string(), event: z.string(), summary: z.string(),
  actionId: z.string().nullable(), approvalId: z.string().nullable(), evidenceIds: z.array(z.string()),
})
export const FindingSchema = z.object({
  observations: z.array(z.string()), hypothesis: z.string().nullable(), evidenceIds: z.array(z.string()),
  uncertainty: z.string(), missingEvidence: z.array(z.string()),
})
export const ActionViewSchema = z.object({
  id: z.string(), kind: ActionKindSchema, targetIds: z.array(z.string()), args: z.record(z.string(), z.unknown()),
  status: z.enum(["PROPOSED", "RUNNING", "SUCCEEDED", "PARTIAL", "FAILED", "BLOCKED"]),
  ruleId: z.string(), summary: z.string(), auditId: z.string().nullable(),
})
export const ApprovalViewSchema = z.object({
  id: z.string(), incidentId: z.string(), actionId: z.string(), kind: z.literal("MOCK_RESTART_DEVICE"),
  proposalRevision: z.string(), targetDeviceIds: z.array(z.string()), args: z.record(z.string(), z.unknown()),
  ruleId: z.string(), status: ApprovalStatusSchema, createdAt: iso, expiresAt: iso,
  decidedAt: iso.nullable(), decidedBy: z.string().nullable(), reason: z.string().nullable(),
  evidenceIds: z.array(z.string()), rationale: z.string(), impact: z.string(), expectedCheck: z.string(),
})
export const DeviceCheckSchema = z.object({
  deviceId: z.string(), actionId: z.string().nullable(), status: z.enum(["PASS", "FAIL", "AWAITING"]),
  reason: z.string(), evidenceIds: z.array(z.string()),
})
export const RecoveryViewSchema = z.object({
  id: z.string(), checkedAt: iso, total: z.number().int(), beforeRecovered: z.number().int(),
  recovered: z.number().int(), remainingDeviceIds: z.array(z.string()), devices: z.array(DeviceCheckSchema),
})
export const WorkflowViewSchema = z.object({
  finding: FindingSchema.nullable(), trace: z.array(TraceEntrySchema), audit: z.array(AuditEntrySchema),
  actions: z.array(ActionViewSchema), approvals: z.array(ApprovalViewSchema), recovery: RecoveryViewSchema.nullable(),
})
export const ApprovalQueueSchema = z.object({ generation: z.number().int(), approvals: z.array(ApprovalViewSchema) })
export const DecisionResultSchema = z.object({ generation: z.number().int(), approval: ApprovalViewSchema, queued: z.boolean() })
export const IncidentViewSchema = z.object({
  generation: z.number().int(), incident: IncidentCardSchema, evidence: z.array(EvidenceViewSchema),
  blocker: z.string().nullable(), owner: z.string().nullable(), workflow: WorkflowViewSchema,
})
export const DashboardViewSchema = z.object({
  generation: z.number().int(),
  kpis: z.object({
    activeIncidents: z.number().int(), affectedMerchants: z.number().int(),
    verifiedResolved: z.number().int(), pendingApprovals: z.number().int(),
  }),
  pulse: z.array(z.object({ key: z.string(), label: z.string(), count: z.number().int() })),
  incidents: z.array(IncidentCardSchema),
  activity: z.array(TraceEntrySchema.extend({ incidentId: z.string() })),
})
