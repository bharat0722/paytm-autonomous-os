// Bounded, deterministic fallback investigator. It walks the same allowlisted tools,
// policy, writes and verifier as the live model, decided from evidence actually
// retrieved in this episode. It never reads ticket text as instructions.
import type { EvidenceView, Finding } from "../../../shared/contracts/http.js"
import { deviceEvidenceFor, ticketLinkTarget } from "../policy.js"
import type { Stage, Step } from "./provider.js"
import type { ToolState } from "./tools.js"

function byKind(state: ToolState, kind: EvidenceView["kind"]): EvidenceView[] {
  return [...state.retrieved.values()].filter((e) => e.kind === kind)
}

function tool(name: string, args: Record<string, unknown> = {}): Step {
  return { type: "tool", tool: name, args }
}

/** Tally of a detail key's values, e.g. "configVersion: 2.1.0 ×4, 2.4.0 ×20". */
function tally(records: EvidenceView[], key: string): string | null {
  const counts = new Map<string, number>()
  for (const r of records) {
    const v = r.details[key]
    if (v === undefined || v === null) continue
    counts.set(String(v), (counts.get(String(v)) ?? 0) + 1)
  }
  if (counts.size === 0) return null
  return `${key}: ${[...counts.entries()].sort((a, b) => b[1] - a[1]).map(([v, n]) => `${v} ×${n}`).join(", ")}`
}

function interestingKeys(records: EvidenceView[], pattern: RegExp): string[] {
  const keys = new Set<string>()
  for (const r of records) for (const k of Object.keys(r.details)) if (pattern.test(k)) keys.add(k)
  return [...keys].sort().slice(0, 4)
}

function finding(f: Partial<Finding> & { observations: string[] }): Step {
  return {
    type: "finding",
    finding: {
      observations: f.observations, hypothesis: f.hypothesis ?? null, evidenceIds: f.evidenceIds ?? [],
      uncertainty: f.uncertainty ?? "Scripted fallback: conclusions are limited to the retrieved records.",
      missingEvidence: f.missingEvidence ?? [],
    },
  }
}

function proposalDenied(state: ToolState, name: string): boolean {
  return state.deniedProposals.has(name) && !state.proposal
}

export function scriptedStep(state: ToolState, stage: Stage): Step {
  const scenario = state.incident.card.scenario
  if (scenario === "soundbox") return stage === "triage" ? soundboxTriage(state) : soundboxContinuation(state)
  if (scenario === "duplicate-tickets") return duplicateTickets(state)
  if (scenario === "order-unpaid") return orderUnpaid(state)
  return settlement(state)
}

function soundboxTriage(state: ToolState): Step {
  const cohort = state.incident.devices.map((d) => d.id)
  if (!state.used.has("get_incident")) return tool("get_incident")
  if (!state.used.has("read_devices")) return tool("read_devices", { ids: cohort })
  if (!state.used.has("read_device_events")) return tool("read_device_events", { limit: 100 })
  if (!state.used.has("read_merchants")) return tool("read_merchants", { limit: 100 })
  if (!state.used.has("read_tickets")) return tool("read_tickets", { limit: 50 })
  if (!state.used.has("read_payments")) return tool("read_payments", { limit: 100 })

  const devices = byKind(state, "device")
  const events = byKind(state, "device_event")
  const payments = byKind(state, "payment")
  const tickets = byKind(state, "ticket")
  const merchants = byKind(state, "merchant")
  const covered = cohort.filter((id) => deviceEvidenceFor(state.retrieved, id))
  const deviceEvidenceIds = covered.map((id) => deviceEvidenceFor(state.retrieved, id)!.id)

  if (!state.proposal && !proposalDenied(state, "propose_config_sync") && covered.length > 0) {
    return tool("propose_config_sync", {
      deviceIds: covered,
      rationale: `Device records for ${covered.length} cohort devices were read; a mock config sync is the policy-allowed first remediation.`,
      evidenceIds: deviceEvidenceIds,
    })
  }

  const observations = [
    `Read ${devices.length} of ${cohort.length} cohort device records.`,
    `Read ${events.length} device events, ${tickets.length} support tickets and ${merchants.length} merchant records.`,
    `Read ${payments.length} payment records linked to the incident.`,
  ]
  for (const key of interestingKeys(devices, /config|notif|firmware/i)) {
    const t = tally(devices, key)
    if (t) observations.push(`Device ${t}.`)
  }
  const ok = payments.filter((p) => /success/i.test(String(p.details.status ?? "")))
  if (ok.length) observations.push(`${ok.length} payments are recorded as successful while notifications failed.`)

  const missing = cohort.filter((id) => !deviceEvidenceFor(state.retrieved, id))
  return finding({
    observations,
    hypothesis: state.proposal
      ? "Payment notifications failed on the cohort devices while payments succeeded; a device configuration fault is the leading hypothesis. Config sync is proposed; the verifier will establish recovery."
      : null,
    evidenceIds: [...deviceEvidenceIds, ...events.slice(0, 10).map((e) => e.id), ...ok.slice(0, 5).map((p) => p.id)],
    uncertainty: "Hypothesis only. Recovery is not claimed until fresh verifier observations pass.",
    missingEvidence: missing.length ? [`Device records missing for: ${missing.join(", ")}`] : state.proposal ? [] : ["Config sync was not permitted by policy."],
  })
}

function soundboxContinuation(state: ToolState): Step {
  if (!state.used.has("get_recovery_snapshot")) return tool("get_recovery_snapshot")
  const snap = state.latestSnapshot
  const remaining = snap?.remainingDeviceIds ?? []
  if (remaining.length > 0 && !state.used.has("read_devices")) return tool("read_devices", { ids: remaining })
  if (snap && remaining.length > 0 && !state.proposal && !proposalDenied(state, "request_restart_approval")) {
    const devEvidence = remaining.map((id) => deviceEvidenceFor(state.retrieved, id)?.id).filter((x): x is string => Boolean(x))
    return tool("request_restart_approval", {
      deviceIds: remaining,
      rationale: `Verifier snapshot ${snap.id} shows ${snap.recovered}/${snap.total} recovered after config sync; ${remaining.length} devices still fail notification checks.`,
      evidenceIds: [snap.id, ...devEvidence],
    })
  }
  return finding({
    observations: snap
      ? [`Verifier snapshot ${snap.id}: ${snap.recovered}/${snap.total} devices recovered after config sync.`, `${remaining.length} devices remain unresolved: ${remaining.join(", ")}.`]
      : ["No verifier snapshot is available."],
    hypothesis: state.proposal ? "The remaining devices may need a restart to apply the synced configuration. A human approval is requested." : null,
    evidenceIds: snap ? [snap.id] : [],
    uncertainty: "Restart outcome is unknown until the verifier observes fresh passing signals.",
    missingEvidence: state.proposal ? [] : ["A policy-eligible restart proposal could not be formed."],
  })
}

function duplicateTickets(state: ToolState): Step {
  if (!state.used.has("get_incident")) return tool("get_incident")
  if (!state.used.has("read_tickets")) return tool("read_tickets", { limit: 50 })
  if (!state.used.has("read_merchants")) return tool("read_merchants", { limit: 50 })
  const tickets = byKind(state, "ticket").slice().sort((a, b) => String(a.occurredAt ?? "").localeCompare(String(b.occurredAt ?? "")) || a.id.localeCompare(b.id))
  const groups = new Map<string, EvidenceView[]>()
  for (const t of tickets) {
    const key = String(t.details.merchantId ?? "unknown")
    groups.set(key, [...(groups.get(key) ?? []), t])
  }
  // One group per merchant: earliest unlinked ticket is primary; tickets already linked
  // to a different case are left alone (reported, never overwritten).
  const linkGroups: { primaryTicketId: string; duplicateTicketIds: string[] }[] = []
  const skipped: string[] = []
  for (const group of groups.values()) {
    const primary = group.find((t) => !ticketLinkTarget(t))
    if (!primary) continue
    const dups = group.filter((t) => t.id !== primary.id && !ticketLinkTarget(t))
    skipped.push(...group.filter((t) => t.id !== primary.id && ticketLinkTarget(t) && ticketLinkTarget(t) !== primary.id).map((t) => t.id))
    if (dups.length) linkGroups.push({ primaryTicketId: primary.id, duplicateTicketIds: dups.map((d) => d.id) })
  }
  const dupCount = linkGroups.reduce((n, g) => n + g.duplicateTicketIds.length, 0)
  if (linkGroups.length && !state.proposal && !proposalDenied(state, "propose_ticket_link")) {
    return tool("propose_ticket_link", {
      groups: linkGroups,
      rationale: `${dupCount} open duplicate tickets across ${linkGroups.length} merchants repeat an existing complaint; each merchant's earliest open ticket stays primary.`,
      evidenceIds: linkGroups.flatMap((g) => [g.primaryTicketId, ...g.duplicateTicketIds]),
    })
  }
  return finding({
    observations: [
      `Read ${tickets.length} support tickets from ${groups.size} merchants.`,
      linkGroups.length ? `${dupCount} duplicates across ${linkGroups.length} merchant groups are eligible for linking.` : "No unlinked duplicate set was found.",
      ...(skipped.length ? [`${skipped.length} ticket(s) already linked to a different case were left unchanged: ${skipped.join(", ")}.`] : []),
    ],
    hypothesis: state.proposal ? "Merchants re-raised the same complaint; linking duplicates to one primary per merchant removes repeated handling." : null,
    evidenceIds: tickets.map((t) => t.id).slice(0, 30),
    uncertainty: "Duplicate status is inferred from merchant, category and timing; stored links are verified after execution.",
    missingEvidence: state.proposal ? [] : ["No eligible duplicate set was found."],
  })
}

function settlement(state: ToolState): Step {
  if (!state.used.has("get_incident")) return tool("get_incident")
  if (!state.used.has("read_settlements")) return tool("read_settlements", { limit: 20 })
  if (!state.used.has("read_tickets")) return tool("read_tickets", { limit: 20 })
  if (!state.used.has("read_payments")) return tool("read_payments", { limit: 50 })
  if (!state.used.has("read_merchants")) return tool("read_merchants", { limit: 20 })
  const settlements = byKind(state, "settlement")
  const tickets = byKind(state, "ticket")
  const short = settlements.filter((s) => Number(s.details.shortfallRupees ?? s.details.differenceInr ?? 0) > 0)
  const total = short.reduce((sum, s) => sum + Number(s.details.shortfallRupees ?? s.details.differenceInr ?? 0), 0)
  const amounts = short.map((s) => Number(s.details.shortfallRupees ?? s.details.differenceInr ?? 0))
  const batchRef = short[0]?.details.bankRef ?? short[0]?.details.batchRef
  const onBatch = batchRef ? `on bank batch ${String(batchRef)}` : "on one bank batch"
  const who = `${short.length} merchant${short.length === 1 ? " was" : "s were"}`
  const inr = (n: number) => `\u20b9${new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 }).format(n)}`
  const range = amounts.length && Math.min(...amounts) !== Math.max(...amounts) ? `${inr(Math.min(...amounts))} to ${inr(Math.max(...amounts))} each` : `${inr(amounts[0] ?? 0)} each`
  const plain = `${who} paid less than expected ${onBatch}: ${inr(total)} short in total (${range}). Evidence is attached. No settlement record was changed.`
  if (settlements.length && !state.proposal && !proposalDenied(state, "record_settlement_handoff")) {
    return tool("record_settlement_handoff", {
      summary: plain,
      evidenceIds: [...settlements.map((s) => s.id), ...tickets.map((t) => t.id)].slice(0, 50),
    })
  }
  return finding({
    observations: [
      `${short.length} of ${settlements.length} settlements were paid less than expected ${onBatch}.`,
      `Total shortfall: ${inr(total)} (${range}).`,
      `${tickets.length} merchant complaints are linked to this batch.`,
    ],
    hypothesis: null,
    evidenceIds: [...settlements.map((s) => s.id), ...tickets.map((t) => t.id)].slice(0, 50),
    uncertainty: "The cause is not known. A person in Settlement Operations must investigate; the AI cannot change money.",
    missingEvidence: settlements.length ? [] : ["No linked settlement record was found."],
  })
}

function orderUnpaid(state: ToolState): Step {
  if (!state.used.has("get_incident")) return tool("get_incident")
  if (!state.used.has("read_orders")) return tool("read_orders", { limit: 50 })
  if (!state.used.has("read_webhook_log")) return tool("read_webhook_log", { limit: 100 })
  if (!state.used.has("check_pg_status")) return tool("check_pg_status", { limit: 50 })
  if (!state.used.has("read_merchants")) return tool("read_merchants", { limit: 50 })
  if (!state.used.has("read_tickets")) return tool("read_tickets", { limit: 50 })

  const orders = byKind(state, "order")
  const txns = byKind(state, "pg_transaction")
  const attempts = byKind(state, "webhook_attempt")
  const eligible = orders.filter((o) => {
    const txn = txns.find((t) => t.details.orderId === o.id)
    const mine = attempts.filter((a) => a.details.orderId === o.id).sort((a, b) => Number(a.details.attemptNo ?? 0) - Number(b.details.attemptNo ?? 0))
    const last = mine[mine.length - 1]
    return o.details.merchantStatus === "UNPAID" && txn?.details.pgStatus === "TXN_SUCCESS" && last && last.details.httpStatus !== 200
  })
  if (eligible.length && !state.proposal && !proposalDenied(state, "propose_webhook_resend")) {
    const cite = [...eligible.map((o) => o.id), ...eligible.flatMap((o) => txns.filter((t) => t.details.orderId === o.id).map((t) => t.id)),
      ...eligible.flatMap((o) => attempts.filter((a) => a.details.orderId === o.id).map((a) => a.id))]
    return tool("propose_webhook_resend", {
      orderIds: eligible.map((o) => o.id),
      rationale: `${eligible.length} orders are UNPAID at the merchant while the Transaction Status API reports TXN_SUCCESS and the last webhook failed; resending the webhook is the policy-allowed fix.`,
      evidenceIds: cite,
    })
  }
  const statuses = new Map<string, number>()
  for (const t of txns) statuses.set(String(t.details.pgStatus), (statuses.get(String(t.details.pgStatus)) ?? 0) + 1)
  const codes = new Map<string, number>()
  for (const a of attempts) codes.set(String(a.details.httpStatus), (codes.get(String(a.details.httpStatus)) ?? 0) + 1)
  return finding({
    observations: [
      `${eligible.length} of ${orders.length} orders are paid at Paytm but still unpaid at the merchant.`,
      `Paytm's status check: ${[...statuses.entries()].map(([k, v]) => `${k} ×${v}`).join(", ") || "no results"}.`,
      `Payment alerts to the merchants failed with HTTP ${[...codes.keys()].join(", ") || "n/a"}.`,
    ],
    hypothesis: state.proposal
      ? "Paytm collected the payments but the merchants' endpoints rejected the success webhook, so the merchants never marked the orders paid. Resending the webhook is proposed; the verifier will check each merchant order."
      : null,
    evidenceIds: [...eligible.map((o) => o.id), ...txns.slice(0, 6).map((t) => t.id), ...attempts.slice(0, 6).map((a) => a.id)],
    uncertainty: "The failing merchant endpoint is the leading hypothesis, not proven. An order is fixed only when the verifier reads it back as PAID.",
    missingEvidence: state.proposal ? [] : ["No order met the resend policy."],
  })
}
