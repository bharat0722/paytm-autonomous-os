// Illustrative response envelopes for consumers (Owner 02 / 03) to build against.
// Stable illustrative IDs. NEVER feed these to a real investigator: they contain the
// expected answer (which devices need a restart).
import type { ApiError, ApiOk, ApprovalView, DashboardView, GroupingView, IncidentView, MetricsView, RecoveryView, SessionView } from "./http.js"

const devices = Array.from({ length: 24 }, (_, i) => `dev_ex_${String(i + 1).padStart(2, "0")}`)
const needsRestart = devices.slice(20)
const at = (m: number) => new Date(Date.UTC(2026, 10, 20, 5, 30 + m)).toISOString()

const card = (status: IncidentView["incident"]["status"], version: number) => ({
  id: "inc_ex_soundbox", scenario: "soundbox" as const,
  title: "Soundbox payment notifications failing (24 devices, model SBX-AI-2, config 7.4.1)",
  severity: "HIGH" as const, status, version, affectedMerchantCount: 21, affectedDeviceCount: 24, updatedAt: at(9)
})

const recovery = (recovered: number, remaining: string[]): RecoveryView => ({
  id: `chk_ex_${recovered}`, checkedAt: at(recovered === 24 ? 14 : 8), total: 24,
  beforeRecovered: 0, recovered, remainingDeviceIds: remaining,
  devices: devices.map((d) => ({
    deviceId: d, actionId: remaining.includes(d) ? "act_ex_sync" : (recovered === 24 && needsRestart.includes(d) ? "act_ex_restart" : "act_ex_sync"),
    status: remaining.includes(d) ? "FAIL" as const : "PASS" as const,
    reason: remaining.includes(d) ? "notification_probe failed after config sync" : "notification_probe passed",
    evidenceIds: [`obs_ex_${d}`]
  }))
})

export const exampleApproval: ApprovalView = {
  id: "apr_ex_restart", incidentId: "inc_ex_soundbox", actionId: "act_ex_restart", kind: "MOCK_RESTART_DEVICE",
  proposalRevision: "rev_ex_1", targetDeviceIds: needsRestart, args: {}, ruleId: "R-RESTART-APPROVAL",
  status: "PENDING", createdAt: at(8), expiresAt: at(23), decidedAt: null, decidedBy: null, reason: null,
  evidenceIds: needsRestart.map((d) => `obs_ex_${d}`),
  rationale: "4 devices still fail the notification probe after config sync.",
  impact: "Mock restart of exactly 4 synthetic devices; no financial effect.",
  expectedCheck: "Fresh notification_probe PASS on all 4 targets."
}

export const exampleGrouping: GroupingView = {
  rule: "same model + config version + error signature, >= 3 distinct merchants within 5 minutes",
  signals: [{ label: "Device model", value: "SBX-AI-2" }, { label: "Config version", value: "7.4.1" }, { label: "Error signature", value: "NOTIFY_PUSH_DROPPED" }],
  window: { start: at(1), end: at(5) }, windowMinutes: 5, minMerchants: 3,
  counts: { records: 24, merchants: 21, devices: 24 },
  excluded: [{ key: "SBX-AI-2|7.4.1|NOTIFY_PUSH_DROPPED", reason: "outside correlation window", count: 2 }],
  note: "The shared configuration is a correlation, not a proven root cause.",
  outreach: { complainedMerchants: 9, silentMerchants: 12, silentMerchantIds: ["mer_ex_003"] }
}

export const exampleMetrics: ApiOk<MetricsView> = {
  data: { generation: 1, simulated: true, metrics: [
    { key: "grouping_quality", label: "Incident grouping quality", value: "100%", numerator: 24, denominator: 24, detail: "24 of 24 manifest devices grouped." }
  ] }
}

export const exampleSession: ApiOk<SessionView> = { data: { generation: 1, actor: { id: "act_operator", role: "operator" }, csrfToken: "csrf_example" } }

export const examplePendingIncident: ApiOk<IncidentView> = {
  data: {
    generation: 1, incident: card("APPROVAL_PENDING", 6),
    evidence: [{ id: devices[0]!, kind: "device", title: "Soundbox SBX-AI-2 · Kirana Store 001", occurredAt: null,
      details: { model: "SBX-AI-2", configVersion: "7.4.1", merchantId: "mer_ex_001" } }],
    blocker: "Awaiting approval for 4-device mock restart", owner: "approver",
    workflow: {
      finding: { observations: ["24 devices share model SBX-AI-2 and config 7.4.1", "Payments succeeded; notifications failed"],
        hypothesis: "Config 7.4.1 notification setting (unproven)", evidenceIds: [devices[0]!], uncertainty: "Cause not confirmed",
        missingEvidence: [] },
      trace: [], audit: [], actions: [], approvals: [exampleApproval], recovery: recovery(20, needsRestart)
    },
    grouping: exampleGrouping,
    profile: {
      displayId: "INC-20261120-001", incidentType: "DEVICE_ALERT_OUTAGE", typeLabel: "Soundbox voice-alert outage",
      description: "Soundboxes stopped announcing successful payments.", threshold: "≥ 3 merchants · same model + config + error code · within 5 minutes",
      zone: "North-1", detectedBy: { jobId: "voice-alert-sweep", jobName: "Payment voice-alert health sweep", cron: "*/15 * * * *", scheduleLabel: "Every 15 minutes", ranAt: at(0) }
    },
    signals: []
  }
}

export const exampleResolvedIncident: ApiOk<IncidentView> = {
  data: {
    ...examplePendingIncident.data, incident: card("RESOLVED", 9), blocker: null, owner: null,
    workflow: {
      ...examplePendingIncident.data.workflow,
      approvals: [{ ...exampleApproval, status: "CONSUMED", decidedAt: at(10), decidedBy: "act_approver" }],
      recovery: recovery(24, [])
    }
  }
}

export const exampleDashboard: ApiOk<DashboardView> = {
  data: {
    generation: 1,
    kpis: { activeIncidents: 1, affectedMerchants: 4, verifiedResolved: 0, pendingApprovals: 1 },
    pulse: [{ key: "notification_failures", label: "Notification failures (window)", count: 24 }],
    incidents: [card("APPROVAL_PENDING", 6)], activity: []
  }
}

export const exampleError: ApiError = { error: { code: "STALE_GENERATION", message: "Demo was reset; refetch.", requestId: "req_ex" } }
