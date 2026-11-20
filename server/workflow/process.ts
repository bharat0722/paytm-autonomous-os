// Describes what each tool call, policy check, write and verification did, in the shape the process log
// stores: which system was hit, what was sent and what came back. Pure functions, no persistence.
import type { EvidenceView } from "../../shared/contracts/http.js"
import { truncate } from "./util.js"

export interface CallDescription {
  stepId: string
  system: string
  method: string
  endpoint: string
  request: unknown
  response: unknown
  httpStatus: number | null
  outcome: "OK" | "FAILED" | "INFO" | "BLOCKED"
  kind: "call" | "decision"
}

/** System, method and path for each read tool. "(simulated)" marks a mock endpoint in this prototype. */
const READ_CALLS: Record<string, { system: string; method: string; endpoint: string }> = {
  get_incident: { system: "MROS incident store", method: "GET", endpoint: "/incidents/{incidentId}" },
  get_recovery_snapshot: { system: "MROS verifier snapshots", method: "GET", endpoint: "/verifications/latest" },
  read_devices: { system: "Device fleet registry (simulated)", method: "GET", endpoint: "/v1/devices" },
  read_device_events: { system: "Device event stream (simulated)", method: "GET", endpoint: "/v1/device-events" },
  read_merchants: { system: "Merchant master (simulated)", method: "GET", endpoint: "/v1/merchants" },
  read_tickets: { system: "Support ticketing (simulated)", method: "GET", endpoint: "/v1/tickets" },
  read_payments: { system: "Payments ledger, read-only (simulated)", method: "GET", endpoint: "/v1/payments" },
  read_settlements: { system: "Settlement reports, read-only (simulated)", method: "GET", endpoint: "/v1/settlements" },
  read_orders: { system: "Merchant order store (simulated)", method: "GET", endpoint: "/v1/orders" },
  read_webhook_log: { system: "Paytm webhook delivery log (simulated)", method: "GET", endpoint: "/v1/webhook-attempts" },
  check_pg_status: { system: "Paytm Transaction Status API (simulated)", method: "POST", endpoint: "/v3/order/status" },
}

const POLICY = { system: "Policy engine", method: "EVALUATE", endpoint: "policy.evaluateAction" }

/** Step id for a read tool: the first pass is "investigate", the post-verification pass is "reinvestigate". */
export const readStepId = (stage: "triage" | "continuation") => (stage === "continuation" ? "reinvestigate" : "investigate")

/** Step id for a policy decision, by the proposal tool that triggered it. */
export const DECIDE_STEP: Record<string, string> = {
  propose_config_sync: "decide-sync",
  request_restart_approval: "decide-restart",
  propose_ticket_link: "decide-link",
  propose_webhook_resend: "decide",
  record_settlement_handoff: "decide-handoff",
  escalate: "decide",
}

export const ACT_STEP: Record<string, string> = {
  MOCK_SYNC_DEVICE_CONFIG: "act-sync", MOCK_RESTART_DEVICE: "act-restart", LINK_SUPPORT_TICKETS: "act-link", RESEND_WEBHOOK: "act",
}
export const VERIFY_STEP: Record<string, string> = {
  MOCK_SYNC_DEVICE_CONFIG: "verify-sync", MOCK_RESTART_DEVICE: "verify-restart", LINK_SUPPORT_TICKETS: "verify-link", RESEND_WEBHOOK: "verify",
}

/** The write endpoint each action kind would call in production (mock here). */
export const WRITE_CALLS: Record<string, { system: string; method: string; endpoint: string }> = {
  MOCK_SYNC_DEVICE_CONFIG: { system: "Device fleet API (simulated)", method: "POST", endpoint: "/v1/devices/config-sync" },
  MOCK_RESTART_DEVICE: { system: "Device fleet API (simulated)", method: "POST", endpoint: "/v1/devices/restart" },
  LINK_SUPPORT_TICKETS: { system: "Ticketing API (simulated)", method: "PATCH", endpoint: "/v1/tickets/link" },
  RESEND_WEBHOOK: { system: "Paytm webhook service (simulated)", method: "POST", endpoint: "/v1/webhooks/resend" },
}

export const VERIFY_CALLS: Record<string, { system: string; method: string; endpoint: string }> = {
  MOCK_SYNC_DEVICE_CONFIG: { system: "Device health telemetry (simulated)", method: "GET", endpoint: "/v1/devices/health" },
  MOCK_RESTART_DEVICE: { system: "Device health telemetry (simulated)", method: "GET", endpoint: "/v1/devices/health" },
  LINK_SUPPORT_TICKETS: { system: "Ticketing API (simulated)", method: "GET", endpoint: "/v1/tickets" },
  RESEND_WEBHOOK: { system: "Merchant order store (simulated)", method: "GET", endpoint: "/v1/orders" },
}

const SAMPLE = 6

/** A compact, readable preview of one evidence record for the call log. */
function preview(ev: EvidenceView): Record<string, unknown> {
  const d = ev.details
  switch (ev.kind) {
    case "order": return { orderId: d.orderRef, merchantStatus: d.merchantStatus, amountRupees: d.amountRupees, recordId: ev.id }
    case "pg_transaction": return { ORDERID: d.orderRef, TXNID: d.txnRef, BANKTXNID: d.bankTxnRef, STATUS: d.pgStatus, RESPCODE: d.respCode, RESPMSG: d.respMsg, recordId: ev.id }
    case "webhook_attempt": return { orderId: d.orderRef, attempt: d.attemptNo, trigger: d.trigger, httpStatus: d.httpStatus, error: d.error, recordId: ev.id }
    case "device": return { deviceRef: d.deviceRef, model: d.model, configVersion: d.configVersion, firmware: d.firmware, recordId: ev.id }
    case "device_event": return { event: d.eventKind, errorSignature: d.errorSignature, deviceId: d.deviceId, recordId: ev.id }
    case "ticket": return { subject: ev.title, category: d.category, status: d.status, linkedTo: d.linkedTo, recordId: ev.id }
    case "payment": return { amountRupees: d.amountRupees, method: d.method, status: d.status, recordId: ev.id }
    case "settlement": return { date: d.settlementDate, expectedRupees: d.expectedRupees, settledRupees: d.settledRupees, shortfallRupees: d.shortfallRupees, bankRef: d.bankRef, status: d.status, recordId: ev.id }
    default: return { title: ev.title, recordId: ev.id }
  }
}

export function describeRead(
  tool: string, args: Record<string, unknown>, records: EvidenceView[], summary: string, ok: boolean, stage: "triage" | "continuation",
  modelResult: Record<string, unknown>,
): CallDescription {
  const c = READ_CALLS[tool] ?? { system: "MROS", method: "GET", endpoint: `/${tool}` }
  const request: Record<string, unknown> = { ...args }
  if (tool === "check_pg_status") request.note = "One request per ORDERID in the incident; Paytm returns the status it recorded."
  if (tool === "get_incident" || tool === "get_recovery_snapshot") {
    return { stepId: readStepId(stage), kind: "call", system: c.system, method: c.method, endpoint: c.endpoint, request, response: modelResult, httpStatus: ok ? 200 : 404, outcome: ok ? "OK" : "FAILED" }
  }
  const response: Record<string, unknown> = { count: records.length, records: records.slice(0, SAMPLE).map(preview) }
  if (records.length > SAMPLE) response.more = records.length - SAMPLE
  if (!records.length) response.message = truncate(summary, 200)
  return { stepId: readStepId(stage), kind: "call", system: c.system, method: c.method, endpoint: c.endpoint, request, response, httpStatus: ok ? 200 : 400, outcome: ok ? "OK" : "FAILED" }
}

export function describeProposal(tool: string, args: Record<string, unknown>, modelResult: Record<string, unknown>, ok: boolean, summary: string): CallDescription {
  const request: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(args)) {
    request[k] = Array.isArray(v) && v.length > SAMPLE ? { count: v.length, sample: v.slice(0, SAMPLE) } : typeof v === "string" ? truncate(v, 300) : v
  }
  const response = ok ? modelResult : { ...modelResult, summary: truncate(summary, 300) }
  return { stepId: DECIDE_STEP[tool] ?? "decide", kind: "decision", ...POLICY, request, response, httpStatus: null, outcome: ok ? "OK" : "BLOCKED" }
}

export function sampleList<T>(items: readonly T[]): T[] | { count: number; sample: T[] } {
  return items.length <= SAMPLE ? [...items] : { count: items.length, sample: items.slice(0, SAMPLE) }
}
