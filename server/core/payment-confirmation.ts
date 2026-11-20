import { CoreError, type Job, type Sql } from "../../shared/contracts/core.js"
import type { EvidenceView } from "../../shared/contracts/http.js"
import type { SandboxPaymentSignal } from "../../shared/contracts/payment-confirmation.js"
import type { CoreDb } from "./db.js"
import { assertActive } from "./generations.js"
import { assertLease, enqueueJob } from "./jobs.js"
import { addMs, newId, type Clock } from "./util.js"

const PROPAGATION_MS = 2 * 60_000
const OWNER = "Payment Gateway Integration Support"

interface SignalRow {
  id: string
  merchant_id: string
  received_at: string
  payload_json: string
}

export function acceptSandboxPaymentSignal(db: CoreDb, clock: Clock, generation: number, actorId: string, signal: SandboxPaymentSignal) {
  return db.write((tx) => {
    assertActive(tx, generation)
    const payload = JSON.stringify(signal)
    const prior = tx.get<SignalRow>(
      "SELECT id, payload_json FROM sandbox_payment_signals WHERE generation = ? AND source = ? AND source_event_id = ?",
      [generation, signal.source, signal.eventId])
    if (prior) {
      if (prior.payload_json !== payload) throw new CoreError("CONFLICT", "This source event ID already has different data.")
      return { generation, signalId: prior.id, replay: true }
    }
    const merchant = tx.get<{ id: string }>(
      "SELECT id FROM merchants WHERE generation = ? AND seed_ref = ?", [generation, signal.merchantRef])
    if (!merchant) throw new CoreError("NOT_FOUND", "Merchant not found in the active sandbox.")
    const subject = signal.source === "gateway" ? signal.transactionRef : signal.orderRef
    const id = newId("pgsig")
    const now = clock.now()
    const inserted = tx.run(
      `INSERT INTO sandbox_payment_signals
         (id, generation, merchant_id, order_ref, source, source_event_id, subject_ref, revision, actor_id, received_at, payload_json)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT (generation, merchant_id, order_ref, source, subject_ref, revision) DO NOTHING`,
      [id, generation, merchant.id, signal.orderRef, signal.source, signal.eventId, subject, signal.revision, actorId, now, payload])
    if (!inserted.changes) throw new CoreError("CONFLICT", "This source revision is already recorded.")
    enqueueJob(tx, clock, {
      generation, incidentId: id, key: `payment-detect:${id}`, kind: "core.payment_detect",
      runAfter: addMs(now, PROPAGATION_MS), payload: {},
    })
    return { generation, signalId: id, replay: false }
  })
}

export function detectPaymentMismatch(tx: Sql, clock: Clock, job: Job): void {
  assertLease(tx, job)
  const event = tx.get<{ merchant_id: string; order_ref: string }>(
    "SELECT merchant_id, order_ref FROM sandbox_payment_signals WHERE generation = ? AND id = ?", [job.generation, job.incidentId])
  if (!event) return
  const { merchant_id: merchantId, order_ref: orderRef } = event
  const batchKey = `payment-confirmation:${JSON.stringify([merchantId, orderRef])}`
  if (tx.get("SELECT id FROM batches WHERE generation = ? AND scenario = ?", [job.generation, batchKey])) return

  const latest = tx.all<SignalRow>(
    `SELECT s.id, s.received_at, s.payload_json FROM sandbox_payment_signals s
      WHERE s.generation = ? AND s.merchant_id = ? AND s.order_ref = ?
        AND NOT EXISTS (SELECT 1 FROM sandbox_payment_signals newer
          WHERE newer.generation = s.generation AND newer.merchant_id = s.merchant_id AND newer.order_ref = s.order_ref
            AND newer.source = s.source AND newer.subject_ref = s.subject_ref AND newer.revision > s.revision)`,
    [job.generation, merchantId, orderRef]).map(row => ({
    id: row.id, receivedAt: row.received_at, signal: JSON.parse(row.payload_json) as SandboxPaymentSignal,
  }))
  const order = latest.find(item => item.signal.source === "merchant-order")?.signal
  const captures = latest.filter(item => item.signal.source === "gateway" && item.signal.status === "CAPTURED")
  const now = clock.now()
  if (!order || !captures.length || captures.some(item => addMs(item.receivedAt, PROPAGATION_MS) > now)) return
  const capture = captures[0]!.signal
  if (capture.source !== "gateway" || order.source !== "merchant-order") return

  const competingAttempts = latest.filter(item => item.signal.source === "gateway" && item.signal.status !== "FAILED").length > 1
  const amountMismatch = order.amountPaise !== capture.amountPaise
  if (!competingAttempts && !amountMismatch && order.status === "PAID" && order.transactionRef === capture.transactionRef) return
  const conflict = competingAttempts ? "Multiple active payment attempts" : amountMismatch ? "Gateway and order amounts differ"
    : order.status === "PAID" ? "Order records a different transaction" : null
  const reason = conflict ?? "Captured payment matches an unpaid order after the propagation window"
  const complexity = conflict ? "L3 · Specialist review" : "L1 · Exact match"
  const blocker = conflict ? `${reason}. Review the linked records before reconciliation.`
    : `${reason}. Merchant reconciliation requires an authorized operator workflow.`
  const incidentId = newId("inc")
  const batchId = newId("batch")
  const correlation = {
    rule: "Match gateway and merchant-order observations for the same merchant and order",
    minMerchants: 1,
    shared: { "Order reference": orderRef, "Complexity": complexity },
    note: blocker,
  }
  tx.run("INSERT INTO batches (id, generation, scenario, variant, created_at, incident_id) VALUES (?,?,?,?,?,?)",
    [batchId, job.generation, batchKey, "success", now, incidentId])
  tx.run(
    `INSERT INTO incidents (id, generation, batch_id, scenario, title, severity, status, owner, blocker, correlation_json, created_at, updated_at)
     VALUES (?,?,?,'payment-confirmation',?,'MEDIUM','ESCALATED',?,?,?,?,?)`,
    [incidentId, job.generation, batchId, conflict ? "Payment confirmation needs review" : "Captured payment, unpaid order",
      OWNER, blocker, JSON.stringify(correlation), now, now])
  tx.run("INSERT INTO incident_evidence (incident_id, kind, record_id) VALUES (?,'merchant',?)", [incidentId, merchantId])
  for (const item of latest) {
    tx.run("INSERT INTO incident_evidence (incident_id, kind, record_id) VALUES (?,'payment_signal',?)", [incidentId, item.id])
  }
}

export function readPaymentSignals(q: Sql, ids: string[]): EvidenceView[] {
  return q.all<SignalRow>(
    `SELECT id, merchant_id, received_at, payload_json FROM sandbox_payment_signals WHERE id IN (${ids.map(() => "?").join(",")})
      ORDER BY received_at, id`, ids).map(row => {
    const signal = JSON.parse(row.payload_json) as SandboxPaymentSignal
    const title = signal.source === "gateway" ? "Gateway status" : "Merchant order"
    return {
      id: row.id,
      kind: "payment_signal",
      title: `${title} · ${signal.status}`,
      occurredAt: row.received_at,
      details: { ...signal, merchantId: row.merchant_id, environment: "sandbox" },
    }
  })
}
