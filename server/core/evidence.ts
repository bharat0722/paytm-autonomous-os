// Scoped evidence reads. Only records linked to the incident are visible, and private
// simulator behaviour is never exposed.
import type { EvidenceView, Scope } from "../../shared/contracts/http.js"
import { CORE_DEFAULTS, type Observation, type ReadRequest, type Sql } from "../../shared/contracts/core.js"

const rupees = (paise: number) => Math.round(paise) / 100

type Mapper = (q: Sql, ids: string[]) => EvidenceView[]
const ph = (n: number) => Array.from({ length: n }, () => "?").join(",")

const MAPPERS: Record<EvidenceView["kind"], Mapper> = {
  device: (q, ids) => q.all<{ id: string; seed_ref: string; merchant_id: string; model: string; config_version: string; firmware: string; revision: number; restarted_at: string | null; mname: string }>(
    `SELECT d.id, d.seed_ref, d.merchant_id, d.model, d.config_version, d.firmware, d.revision, d.restarted_at, m.name AS mname
     FROM devices d JOIN merchants m ON m.id = d.merchant_id WHERE d.id IN (${ph(ids.length)}) ORDER BY d.seed_ref`, ids
  ).map((d) => ({
    id: d.id, kind: "device", title: `Soundbox ${d.model} · ${d.mname}`, occurredAt: d.restarted_at,
    details: { deviceRef: d.seed_ref, merchantId: d.merchant_id, model: d.model, configVersion: d.config_version,
      firmware: d.firmware, revision: d.revision, restartedAt: d.restarted_at }
  })),
  device_event: (q, ids) => q.all<{ id: string; device_id: string; kind: string; error_signature: string | null; occurred_at: string }>(
    `SELECT id, device_id, kind, error_signature, occurred_at FROM device_events WHERE id IN (${ph(ids.length)}) ORDER BY occurred_at`, ids
  ).map((e) => ({
    id: e.id, kind: "device_event", title: `${e.kind} (${e.error_signature ?? "no signature"})`, occurredAt: e.occurred_at,
    details: { deviceId: e.device_id, eventKind: e.kind, errorSignature: e.error_signature }
  })),
  ticket: (q, ids) => q.all<{ id: string; merchant_id: string; device_id: string | null; category: string; subject: string; status: string; linked_to: string | null; created_at: string }>(
    `SELECT id, merchant_id, device_id, category, subject, status, linked_to, created_at FROM tickets WHERE id IN (${ph(ids.length)}) ORDER BY created_at, id`, ids
  ).map((t) => ({
    id: t.id, kind: "ticket", title: t.subject, occurredAt: t.created_at,
    details: { merchantId: t.merchant_id, deviceId: t.device_id, category: t.category, status: t.status, linkedTo: t.linked_to }
  })),
  payment: (q, ids) => q.all<{ id: string; merchant_id: string; device_id: string | null; amount_paise: number; method: string; status: string; occurred_at: string }>(
    `SELECT id, merchant_id, device_id, amount_paise, method, status, occurred_at FROM payments WHERE id IN (${ph(ids.length)}) ORDER BY occurred_at`, ids
  ).map((p) => ({
    id: p.id, kind: "payment", title: `${p.method} payment ${p.status} · ₹${rupees(p.amount_paise)}`, occurredAt: p.occurred_at,
    details: { merchantId: p.merchant_id, deviceId: p.device_id, amountRupees: rupees(p.amount_paise), method: p.method, status: p.status }
  })),
  settlement: (q, ids) => q.all<{ id: string; merchant_id: string; settlement_date: string; gross_paise: number; fees_paise: number; expected_paise: number; settled_paise: number; bank_ref: string; status: string; occurred_at: string }>(
    `SELECT id, merchant_id, settlement_date, gross_paise, fees_paise, expected_paise, settled_paise, bank_ref, status, occurred_at
     FROM settlements WHERE id IN (${ph(ids.length)}) ORDER BY merchant_id`, ids
  ).map((s) => ({
    id: s.id, kind: "settlement", title: `Settlement ${s.settlement_date} · ${s.status}`, occurredAt: s.occurred_at,
    details: { merchantId: s.merchant_id, settlementDate: s.settlement_date, grossRupees: rupees(s.gross_paise),
      feesRupees: rupees(s.fees_paise), expectedRupees: rupees(s.expected_paise), settledRupees: rupees(s.settled_paise),
      shortfallRupees: rupees(s.expected_paise - s.settled_paise), bankRef: s.bank_ref, status: s.status, readOnly: true }
  })),
  merchant: (q, ids) => q.all<{ id: string; name: string; city: string; category: string }>(
    `SELECT id, name, city, category FROM merchants WHERE id IN (${ph(ids.length)}) ORDER BY seed_ref`, ids
  ).map((m) => ({ id: m.id, kind: "merchant", title: m.name, occurredAt: null, details: { city: m.city, category: m.category } })),
  // Merchant-side order (what the merchant's own system shows).
  order: (q, ids) => q.all<{ id: string; merchant_id: string; merchant_order_ref: string; amount_paise: number; merchant_status: string; created_at: string; paid_at: string | null }>(
    `SELECT id, merchant_id, merchant_order_ref, amount_paise, merchant_status, created_at, paid_at FROM orders WHERE id IN (${ph(ids.length)}) ORDER BY created_at, id`, ids
  ).map((o) => ({
    id: o.id, kind: "order", title: `Order ${o.merchant_order_ref} · ${o.merchant_status} · ₹${rupees(o.amount_paise)}`, occurredAt: o.created_at,
    details: { merchantId: o.merchant_id, orderRef: o.merchant_order_ref, amountRupees: rupees(o.amount_paise), merchantStatus: o.merchant_status, paidAt: o.paid_at }
  })),
  // Paytm-side transaction (what the Transaction Status API returns for the order).
  pg_transaction: (q, ids) => q.all<{ id: string; order_id: string; txn_ref: string; bank_txn_ref: string | null; status: string; resp_code: string; resp_msg: string; payment_mode: string; occurred_at: string; merchant_order_ref: string }>(
    `SELECT t.id, t.order_id, t.txn_ref, t.bank_txn_ref, t.status, t.resp_code, t.resp_msg, t.payment_mode, t.occurred_at, o.merchant_order_ref
     FROM pg_transactions t JOIN orders o ON o.id = t.order_id WHERE t.id IN (${ph(ids.length)}) ORDER BY t.occurred_at, t.id`, ids
  ).map((t) => ({
    id: t.id, kind: "pg_transaction", title: `Status API ${t.status} · ${t.merchant_order_ref}`, occurredAt: t.occurred_at,
    details: { orderId: t.order_id, orderRef: t.merchant_order_ref, txnRef: t.txn_ref, bankTxnRef: t.bank_txn_ref, pgStatus: t.status,
      respCode: t.resp_code, respMsg: t.resp_msg, paymentMode: t.payment_mode }
  })),
  // Webhook delivery attempts to the merchant endpoint.
  webhook_attempt: (q, ids) => q.all<{ id: string; order_id: string; attempt_no: number; trigger: string; http_status: number; error: string | null; occurred_at: string; merchant_order_ref: string }>(
    `SELECT w.id, w.order_id, w.attempt_no, w.trigger, w.http_status, w.error, w.occurred_at, o.merchant_order_ref
     FROM webhook_attempts w JOIN orders o ON o.id = w.order_id WHERE w.id IN (${ph(ids.length)}) ORDER BY w.occurred_at, w.id`, ids
  ).map((w) => ({
    id: w.id, kind: "webhook_attempt", title: `Webhook attempt ${w.attempt_no} → HTTP ${w.http_status} · ${w.merchant_order_ref}`, occurredAt: w.occurred_at,
    details: { orderId: w.order_id, orderRef: w.merchant_order_ref, attemptNo: w.attempt_no, trigger: w.trigger, httpStatus: w.http_status, error: w.error }
  })),
}

/** Reads only records linked to the incident in this generation. Unknown IDs are ignored. */
export function readEvidence(q: Sql, scope: Scope, request: ReadRequest): EvidenceView[] {
  const owned = q.get<{ id: string }>("SELECT id FROM incidents WHERE id = ? AND generation = ?", [scope.incidentId, scope.generation])
  if (!owned) return []
  let ids = q.all<{ record_id: string }>("SELECT record_id FROM incident_evidence WHERE incident_id = ? AND kind = ?",
    [scope.incidentId, request.kind]).map((r) => r.record_id)
  if (request.ids) {
    const wanted = new Set(request.ids)
    ids = ids.filter((id) => wanted.has(id))
  }
  const limit = Math.min(Math.max(1, request.limit ?? CORE_DEFAULTS.evidenceReadLimit), CORE_DEFAULTS.evidenceReadMaxLimit)
  if (!ids.length) return []
  return MAPPERS[request.kind](q, ids).slice(0, limit)
}

export function readAllEvidence(q: Sql, scope: Scope): EvidenceView[] {
  const kinds: EvidenceView["kind"][] = ["device", "device_event", "merchant", "ticket", "payment", "settlement", "order", "pg_transaction", "webhook_attempt"]
  return kinds.flatMap((kind) => readEvidence(q, scope, { kind, limit: CORE_DEFAULTS.evidenceReadMaxLimit }))
}

/** Scoped observations for roster devices, ordered by monotonic sequence. */
export function readObservations(q: Sql, scope: Scope, deviceIds: string[]): Observation[] {
  if (!deviceIds.length) return []
  const rows = q.all<{ id: string; device_id: string; action_id: string | null; sequence: number; occurred_at: string; kind: Observation["kind"]; passed: number }>(
    `SELECT o.id, o.device_id, o.action_id, o.sequence, o.occurred_at, o.kind, o.passed
     FROM observations o JOIN incident_devices i ON i.device_id = o.device_id AND i.incident_id = ?
     WHERE o.generation = ? AND o.device_id IN (${ph(deviceIds.length)}) ORDER BY o.sequence`,
    [scope.incidentId, scope.generation, ...deviceIds])
  return rows.map((o) => ({ id: o.id, deviceId: o.device_id, actionId: o.action_id, sequence: o.sequence, occurredAt: o.occurred_at, kind: o.kind, passed: o.passed === 1 }))
}
