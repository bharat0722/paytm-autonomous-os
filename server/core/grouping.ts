// Grouping explanation + the detection entry that opens every incident's chronology.
// Built only from persisted state (incidents.correlation_json and linked evidence).
import type { AuditEntry, GroupingView, Scope, TraceEntry } from "../../shared/contracts/http.js"
import type { Sql } from "../../shared/contracts/core.js"

interface Correlation {
  rule?: string; windowMinutes?: number; minMerchants?: number
  shared?: Record<string, string>; window?: { start: string; end: string }
  deviceCount?: number; merchantCount?: number; ticketCount?: number
  excluded?: { key: string; reason: string; count: number }[]; note?: string
}

const SIGNAL_LABELS: Record<string, string> = { model: "Device model", configVersion: "Config version", errorSignature: "Error signature" }

function loadCorrelation(q: Sql, scope: Scope): { c: Correlation; scenario: string; createdAt: string } | null {
  const row = q.get<{ correlation_json: string; scenario: string; created_at: string }>(
    "SELECT correlation_json, scenario, created_at FROM incidents WHERE id = ? AND generation = ?", [scope.incidentId, scope.generation])
  if (!row) return null
  try { return { c: JSON.parse(row.correlation_json) as Correlation, scenario: row.scenario, createdAt: row.created_at } } catch { return null }
}

const linkedIds = (q: Sql, incidentId: string, kind: string) =>
  q.all<{ record_id: string }>("SELECT record_id FROM incident_evidence WHERE incident_id = ? AND kind = ? ORDER BY record_id", [incidentId, kind]).map((r) => r.record_id)

export function groupingView(q: Sql, scope: Scope): GroupingView | null {
  const loaded = loadCorrelation(q, scope)
  if (!loaded) return null
  const { c, scenario } = loaded
  const merchants = linkedIds(q, scope.incidentId, "merchant")
  const devices = linkedIds(q, scope.incidentId, "device")
  const signals = Object.entries(c.shared ?? {}).map(([k, v]) => ({ label: SIGNAL_LABELS[k] ?? k, value: String(v) }))
  if (scenario === "duplicate-tickets") signals.push({ label: "Shared complaint", value: "Same ticket category and subject" })
  if (scenario === "settlement-discrepancy") signals.push({ label: "Shared batch", value: "Same bank settlement batch with SHORT status" })
  const records = scenario === "soundbox" ? linkedIds(q, scope.incidentId, "device_event").length
    : scenario === "order-unpaid" ? linkedIds(q, scope.incidentId, "order").length
    : scenario === "duplicate-tickets" ? linkedIds(q, scope.incidentId, "ticket").length : linkedIds(q, scope.incidentId, "settlement").length

  let outreach: GroupingView["outreach"] = null
  if (scenario === "soundbox" && merchants.length) {
    const tickets = linkedIds(q, scope.incidentId, "ticket")
    const complained = new Set(tickets.length ? q.all<{ merchant_id: string }>(
      `SELECT DISTINCT merchant_id FROM tickets WHERE id IN (${tickets.map(() => "?").join(",")})`, tickets).map((r) => r.merchant_id) : [])
    const silent = merchants.filter((m) => !complained.has(m))
    outreach = { complainedMerchants: merchants.length - silent.length, silentMerchants: silent.length, silentMerchantIds: silent }
  }
  return {
    rule: c.rule ?? "Rule-based correlation",
    signals,
    window: c.window ?? null,
    windowMinutes: c.windowMinutes ?? null,
    minMerchants: c.minMerchants ?? 3,
    counts: { records, merchants: merchants.length, devices: devices.length },
    excluded: c.excluded ?? [],
    note: c.note ?? "Grouping is a correlation, not a proven root cause.",
    outreach
  }
}

/** Synthetic-but-persisted first entries: the incident detection (FR-08 "incident creation"). */
export function detectionEntries(q: Sql, scope: Scope): { trace: TraceEntry; audit: AuditEntry } | null {
  const loaded = loadCorrelation(q, scope)
  const g = groupingView(q, scope)
  if (!loaded || !g) return null
  const excludedCount = g.excluded.reduce((n, e) => n + e.count, 0)
  const fingerprint = g.signals.map((s) => s.value).join(" · ")
  const what = loaded.scenario === "soundbox" ? `${g.counts.records} notification failures on ${g.counts.devices} devices`
    : loaded.scenario === "order-unpaid" ? `${g.counts.records} paid orders that still show unpaid`
    : loaded.scenario === "duplicate-tickets" ? `${g.counts.records} support tickets` : `${g.counts.records} short settlements`
  const summary = `Incident detected: grouped ${what} from ${g.counts.merchants} merchants (${fingerprint}).` +
    (excludedCount ? ` ${excludedCount} unrelated record(s) kept separate.` : "")
  const evidenceKind = loaded.scenario === "soundbox" ? "device_event" : loaded.scenario === "order-unpaid" ? "order" : loaded.scenario === "duplicate-tickets" ? "ticket" : "settlement"
  const evidenceIds = linkedIds(q, scope.incidentId, evidenceKind).slice(0, 50)
  const auditId = `aud_detect_${scope.incidentId}`
  return {
    trace: { id: `trc_detect_${scope.incidentId}`, at: loaded.createdAt, mode: "system", stage: "detection", summary, tool: "correlate_events", evidenceIds, auditId },
    audit: { id: auditId, at: loaded.createdAt, actor: "system:correlator", event: "INCIDENT_DETECTED", summary, actionId: null, approvalId: null, evidenceIds }
  }
}
