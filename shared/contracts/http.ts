// Shared agreement v1 · HTTP wire types (Owner 01).
// Every type has a runtime validator named `<Type>Schema`.
// Rules: arrays are always present (empty when no results), nulls are explicit,
// identifiers are strings, dates are UTC ISO 8601 strings.
import { z } from "zod"

export type Scenario = "soundbox" | "duplicate-tickets" | "settlement-discrepancy" | "payment-confirmation"
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
  /** Additive (v1.2) display fields. */
  displayId?: string; typeLabel?: string; zone?: string; detectedAt?: string; owner?: string | null;
}
export interface EvidenceView {
  id: string; kind: "device" | "device_event" | "ticket" | "payment" | "settlement" | "merchant" | "payment_signal";
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
/** Why records were grouped into one incident (correlation is a clue, not a proven cause). */
export interface GroupingView {
  rule: string
  signals: { label: string; value: string }[]
  window: { start: string; end: string } | null
  windowMinutes: number | null
  minMerchants: number
  counts: { records: number; merchants: number; devices: number }
  excluded: { key: string; reason: string; count: number }[]
  note: string
  /** Soundbox only: merchants in the cohort who raised a ticket vs. those who did not (silent). */
  outreach: { complainedMerchants: number; silentMerchants: number; silentMerchantIds: string[] } | null
}
/** What kind of incident this is, how it is defined, and which scheduled job detected it. */
export interface IncidentProfile {
  displayId: string; incidentType: string; typeLabel: string; description: string; threshold: string; zone: string
  detectedBy: { jobId: string; jobName: string; cron: string; scheduleLabel: string; ranAt: string }
}
/** A device signal (observation) that evidence references can resolve to. */
export interface SignalView {
  id: string; deviceId: string; actionId: string | null; kind: string; passed: boolean; occurredAt: string; sequence: number
}
export interface IncidentView {
  generation: number; incident: IncidentCard; evidence: EvidenceView[];
  blocker: string | null; owner: string | null; workflow: WorkflowView;
  /** Additive (v1.1): grouping explanation; null when unavailable. */
  grouping: GroupingView | null;
  /** Additive (v1.2): incident type/definition/detecting job, and device signals for reference resolution. */
  profile: IncidentProfile | null;
  signals: SignalView[];
}
export interface DetectionJobView {
  id: string; name: string; scenario: Scenario; incidentType: string; typeLabel: string; description: string; threshold: string
  zone: string; severity: IncidentCard["severity"]; cron: string; scheduleLabel: string; supportsPartial: boolean
  previousFireAt: string; nextFireAt: string
  lastRun: { ranAt: string; incidentId: string; variant: string; status: IncidentStatus | null; displayId: string | null } | null
}
export interface DetectionJobsView { generation: number; now: string; timezone: string; jobs: DetectionJobView[] }
export interface AuditView { generation: number; incidentId: string; audit: AuditEntry[] }
/** POST /incidents/:id/actions: a request; the backend policy decides the path, it never executes directly. */
export interface ActionRequestBody { kind: string; targetIds?: string[] }
export interface ActionRequestResult {
  generation: number; incidentId: string; kind: string
  path: "APPROVAL_PENDING" | "INVESTIGATOR_OWNED" | "ALREADY_EXECUTED"
  decision: { allowed: boolean; requiresApproval: boolean; ruleId: string; reason: string }
  approvalId: string | null; auditId: string | null
}
/** POST /incidents/:id/verify: the verifier owns the result; this queues a fresh check when eligible. */
export interface VerifyResult { generation: number; incidentId: string; status: IncidentStatus; queued: boolean; recovery: RecoveryView | null }
export interface MetricView {
  key: string; label: string; value: string; numerator: number | null; denominator: number | null; detail: string
}
export interface MetricsView { generation: number; simulated: true; metrics: MetricView[] }
export interface DashboardView {
  generation: number;
  kpis: { activeIncidents: number; affectedMerchants: number; verifiedResolved: number; pendingApprovals: number };
  pulse: { key: string; label: string; count: number }[];
  incidents: IncidentCard[];
  activity: (TraceEntry & { incidentId: string })[];
}

// Error envelope and stable codes.
export type ErrorCode =
  | "UNAUTHENTICATED" | "FORBIDDEN" | "STALE_GENERATION" | "APPROVAL_CONFLICT"
  | "APPROVAL_EXPIRED" | "NOT_FOUND" | "INVALID_INPUT" | "WORKFLOW_UNAVAILABLE"
  | "INJECTION_CONFLICT" | "CSRF_INVALID" | "INTERNAL"
export interface ApiError { error: { code: ErrorCode | string; message: string; requestId: string } }
export interface ApiOk<T> { data: T }

// ---------- Runtime validators ----------
const id = z.string().min(1)
const iso = z.string().min(1)
const detailValue = z.union([z.string(), z.number(), z.boolean(), z.null()])

export const DemoScenarioSchema = z.enum(["soundbox", "duplicate-tickets", "settlement-discrepancy"])
export const ScenarioSchema = z.enum([...DemoScenarioSchema.options, "payment-confirmation"])
export const RoleSchema = z.enum(["operator", "approver"])
export const IncidentStatusSchema = z.enum([
  "DETECTED", "INVESTIGATING", "INSUFFICIENT_EVIDENCE", "ACTION_RUNNING", "VERIFYING",
  "PARTIALLY_RECOVERED", "APPROVAL_PENDING", "RESOLVED", "ESCALATED", "FAILED", "TASK_COMPLETED"
])
export const ActionKindSchema = z.enum(["MOCK_SYNC_DEVICE_CONFIG", "MOCK_RESTART_DEVICE", "LINK_SUPPORT_TICKETS"])
export const ApprovalStatusSchema = z.enum(["PENDING", "APPROVED", "REJECTED", "EXPIRED", "CONSUMED"])
export const ModeSchema = z.enum(["live_ai", "scripted_fallback", "system"])

export const DemoSignInSchema = z.object({ role: RoleSchema, accessCode: z.string().min(1).max(200) }).strict()
export const DemoInjectSchema = z.object({ variant: z.enum(["success", "partial"]) }).strict()
export const ApprovalDecisionSchema = z.object({
  decision: z.enum(["approve", "reject"]), proposalRevision: z.string().min(1),
  reason: z.string().max(500).optional()
}).strict()
export const ActorSchema = z.object({ id, role: RoleSchema })
export const SessionViewSchema = z.object({
  generation: z.number().int().positive(), actor: ActorSchema.nullable(), csrfToken: z.string().nullable()
})
export const ScopeSchema = z.object({ generation: z.number().int().positive(), incidentId: id })
export const InjectResultSchema = z.object({ generation: z.number().int().positive(), batchId: id, incidentId: id })
export const StartResultSchema = z.object({ generation: z.number().int().positive(), incidentId: id, status: IncidentStatusSchema })
export const IncidentCardSchema = z.object({
  id, scenario: ScenarioSchema, title: z.string(), severity: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]),
  status: IncidentStatusSchema, version: z.number().int().nonnegative(),
  affectedMerchantCount: z.number().int().nonnegative(), affectedDeviceCount: z.number().int().nonnegative(),
  updatedAt: iso,
  displayId: z.string().optional(), typeLabel: z.string().optional(), zone: z.string().optional(),
  detectedAt: iso.optional(), owner: z.string().nullable().optional()
})
export const EvidenceViewSchema = z.object({
  id, kind: z.enum(["device", "device_event", "ticket", "payment", "settlement", "merchant", "payment_signal"]),
  title: z.string(), occurredAt: iso.nullable(), details: z.record(z.string(), detailValue)
})
export const TraceEntrySchema = z.object({
  id, at: iso, mode: ModeSchema, stage: z.string(), summary: z.string(),
  tool: z.string().nullable(), evidenceIds: z.array(z.string()), auditId: z.string().nullable()
})
export const AuditEntrySchema = z.object({
  id, at: iso, actor: z.string(), event: z.string(), summary: z.string(),
  actionId: z.string().nullable(), approvalId: z.string().nullable(), evidenceIds: z.array(z.string())
})
export const FindingSchema = z.object({
  observations: z.array(z.string()), hypothesis: z.string().nullable(), evidenceIds: z.array(z.string()),
  uncertainty: z.string(), missingEvidence: z.array(z.string())
})
export const ActionViewSchema = z.object({
  id, kind: ActionKindSchema, targetIds: z.array(z.string()), args: z.record(z.string(), z.unknown()),
  status: z.enum(["PROPOSED", "RUNNING", "SUCCEEDED", "PARTIAL", "FAILED", "BLOCKED"]),
  ruleId: z.string(), summary: z.string(), auditId: z.string().nullable()
})
export const ApprovalViewSchema = z.object({
  id, incidentId: id, actionId: id, kind: z.literal("MOCK_RESTART_DEVICE"), proposalRevision: z.string(),
  targetDeviceIds: z.array(z.string()), args: z.record(z.string(), z.unknown()), ruleId: z.string(),
  status: ApprovalStatusSchema, createdAt: iso, expiresAt: iso, decidedAt: iso.nullable(),
  decidedBy: z.string().nullable(), reason: z.string().nullable(), evidenceIds: z.array(z.string()),
  rationale: z.string(), impact: z.string(), expectedCheck: z.string()
})
export const DeviceCheckSchema = z.object({
  deviceId: id, actionId: z.string().nullable(), status: z.enum(["PASS", "FAIL", "AWAITING"]),
  reason: z.string(), evidenceIds: z.array(z.string())
})
export const RecoveryViewSchema = z.object({
  id, checkedAt: iso, total: z.number().int().nonnegative(), beforeRecovered: z.number().int().nonnegative(),
  recovered: z.number().int().nonnegative(), remainingDeviceIds: z.array(z.string()), devices: z.array(DeviceCheckSchema)
})
export const WorkflowViewSchema = z.object({
  finding: FindingSchema.nullable(), trace: z.array(TraceEntrySchema), audit: z.array(AuditEntrySchema),
  actions: z.array(ActionViewSchema), approvals: z.array(ApprovalViewSchema), recovery: RecoveryViewSchema.nullable()
})
export const GroupingViewSchema = z.object({
  rule: z.string(), signals: z.array(z.object({ label: z.string(), value: z.string() })),
  window: z.object({ start: iso, end: iso }).nullable(), windowMinutes: z.number().nullable(),
  minMerchants: z.number().int().nonnegative(),
  counts: z.object({ records: z.number().int().nonnegative(), merchants: z.number().int().nonnegative(), devices: z.number().int().nonnegative() }),
  excluded: z.array(z.object({ key: z.string(), reason: z.string(), count: z.number().int().nonnegative() })),
  note: z.string(),
  outreach: z.object({
    complainedMerchants: z.number().int().nonnegative(), silentMerchants: z.number().int().nonnegative(), silentMerchantIds: z.array(z.string())
  }).nullable()
})
export const IncidentProfileSchema = z.object({
  displayId: z.string(), incidentType: z.string(), typeLabel: z.string(), description: z.string(), threshold: z.string(), zone: z.string(),
  detectedBy: z.object({ jobId: z.string(), jobName: z.string(), cron: z.string(), scheduleLabel: z.string(), ranAt: iso })
})
export const SignalViewSchema = z.object({
  id, deviceId: z.string(), actionId: z.string().nullable(), kind: z.string(), passed: z.boolean(), occurredAt: iso, sequence: z.number().int()
})
export const IncidentViewSchema = z.object({
  generation: z.number().int().positive(), incident: IncidentCardSchema, evidence: z.array(EvidenceViewSchema),
  blocker: z.string().nullable(), owner: z.string().nullable(), workflow: WorkflowViewSchema,
  grouping: GroupingViewSchema.nullable(), profile: IncidentProfileSchema.nullable(), signals: z.array(SignalViewSchema)
})
export const DetectionJobViewSchema = z.object({
  id: z.string(), name: z.string(), scenario: ScenarioSchema, incidentType: z.string(), typeLabel: z.string(), description: z.string(),
  threshold: z.string(), zone: z.string(), severity: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]), cron: z.string(), scheduleLabel: z.string(),
  supportsPartial: z.boolean(), previousFireAt: iso, nextFireAt: iso,
  lastRun: z.object({ ranAt: iso, incidentId: z.string(), variant: z.string(), status: IncidentStatusSchema.nullable(), displayId: z.string().nullable() }).nullable()
})
export const DetectionJobsViewSchema = z.object({ generation: z.number().int().positive(), now: iso, timezone: z.string(), jobs: z.array(DetectionJobViewSchema) })
export const AuditViewSchema = z.object({ generation: z.number().int().positive(), incidentId: id, audit: z.array(AuditEntrySchema) })
export const ActionRequestBodySchema = z.object({ kind: z.string().min(1).max(64), targetIds: z.array(z.string().min(1).max(120)).max(100).optional() }).strict()
export const ActionRequestResultSchema = z.object({
  generation: z.number().int().positive(), incidentId: id, kind: z.string(),
  path: z.enum(["APPROVAL_PENDING", "INVESTIGATOR_OWNED", "ALREADY_EXECUTED"]),
  decision: z.object({ allowed: z.boolean(), requiresApproval: z.boolean(), ruleId: z.string(), reason: z.string() }),
  approvalId: z.string().nullable(), auditId: z.string().nullable()
})
export const VerifyResultSchema = z.object({
  generation: z.number().int().positive(), incidentId: id, status: IncidentStatusSchema, queued: z.boolean(), recovery: RecoveryViewSchema.nullable()
})
export const MetricViewSchema = z.object({
  key: z.string(), label: z.string(), value: z.string(), numerator: z.number().nullable(), denominator: z.number().nullable(), detail: z.string()
})
export const MetricsViewSchema = z.object({ generation: z.number().int().positive(), simulated: z.literal(true), metrics: z.array(MetricViewSchema) })
export const ApprovalQueueSchema = z.object({ generation: z.number().int().positive(), approvals: z.array(ApprovalViewSchema) })
export const DecisionResultSchema = z.object({
  generation: z.number().int().positive(), approval: ApprovalViewSchema, queued: z.boolean()
})
export const DashboardViewSchema = z.object({
  generation: z.number().int().positive(),
  kpis: z.object({
    activeIncidents: z.number().int().nonnegative(), affectedMerchants: z.number().int().nonnegative(),
    verifiedResolved: z.number().int().nonnegative(), pendingApprovals: z.number().int().nonnegative()
  }),
  pulse: z.array(z.object({ key: z.string(), label: z.string(), count: z.number().int().nonnegative() })),
  incidents: z.array(IncidentCardSchema),
  activity: z.array(TraceEntrySchema.extend({ incidentId: id }))
})
export const ApiErrorSchema = z.object({
  error: z.object({ code: z.string(), message: z.string(), requestId: z.string() })
})
export const okEnvelope = <T extends z.ZodType>(schema: T) => z.object({ data: schema })

export const EMPTY_WORKFLOW: WorkflowView = Object.freeze({
  finding: null, trace: [], audit: [], actions: [], approvals: [], recovery: null
}) as WorkflowView

// ---------- Compile-time check: schemas match the wire types ----------
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
type Assert<T extends true> = T
export type _ContractChecks = [
  Assert<Same<z.infer<typeof IncidentCardSchema>, IncidentCard>>,
  Assert<Same<z.infer<typeof EvidenceViewSchema>, EvidenceView>>,
  Assert<Same<z.infer<typeof TraceEntrySchema>, TraceEntry>>,
  Assert<Same<z.infer<typeof AuditEntrySchema>, AuditEntry>>,
  Assert<Same<z.infer<typeof FindingSchema>, Finding>>,
  Assert<Same<z.infer<typeof ApprovalViewSchema>, ApprovalView>>,
  Assert<Same<z.infer<typeof RecoveryViewSchema>, RecoveryView>>,
  Assert<Same<z.infer<typeof WorkflowViewSchema>, WorkflowView>>,
  Assert<Same<z.infer<typeof IncidentViewSchema>, IncidentView>>,
  Assert<Same<z.infer<typeof DashboardViewSchema>, DashboardView>>,
  Assert<Same<z.infer<typeof SessionViewSchema>, SessionView>>,
  Assert<Same<z.infer<typeof ApprovalDecisionSchema>, ApprovalDecision>>,
  Assert<Same<z.infer<typeof InjectResultSchema>, InjectResult>>,
  Assert<Same<z.infer<typeof GroupingViewSchema>, GroupingView>>,
  Assert<Same<z.infer<typeof AuditViewSchema>, AuditView>>,
  Assert<Same<z.infer<typeof MetricsViewSchema>, MetricsView>>,
  Assert<Same<z.infer<typeof IncidentProfileSchema>, IncidentProfile>>,
  Assert<Same<z.infer<typeof DetectionJobsViewSchema>, DetectionJobsView>>
]
