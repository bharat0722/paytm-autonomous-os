// Atomic injection + correlation. One injection creates one batch, its source records,
// exactly one correlated incident, and one initial investigation job.
import type { InjectResult, Scenario } from "../../shared/contracts/http.js"
import { CORE_DEFAULTS, CoreError, initialInvestigationKey, type Sql } from "../../shared/contracts/core.js"
import type { CoreDb } from "./db.js"
import { advanceTelemetry, assertActive } from "./generations.js"
import { enqueueJob } from "./jobs.js"
import { NOTIFY_SIGNATURE, PRIVATE_FIXTURE, TELEMETRY_BASE } from "./seed.js"
import { addMs, newId, prng, type Clock } from "./util.js"

const WINDOW_MS = CORE_DEFAULTS.correlationWindowMinutes * 60_000
const MIN_MERCHANTS = CORE_DEFAULTS.correlationMinMerchants

export type Variant = "success" | "partial"

interface Ctx { tx: Sql; generation: number; batchId: string; now: string }

const deviceByRef = (tx: Sql, generation: number, seedRef: string) =>
  tx.get<{ id: string; merchant_id: string; model: string; config_version: string }>(
    "SELECT id, merchant_id, model, config_version FROM devices WHERE generation = ? AND seed_ref = ?", [generation, seedRef])!
const merchantByRef = (tx: Sql, generation: number, seedRef: string) =>
  tx.get<{ id: string }>("SELECT id FROM merchants WHERE generation = ? AND seed_ref = ?", [generation, seedRef])!.id

/** Generic correlation over candidate records. Pure function: easy to test. */
export interface Candidate { recordId: string; merchantId: string; key: string; at: string }
export interface Group { key: string; members: Candidate[]; merchants: string[]; windowStart: string; windowEnd: string }
export function correlate(candidates: Candidate[]): { groups: Group[]; excluded: { key: string; reason: string; count: number }[] } {
  const byKey = new Map<string, Candidate[]>()
  for (const c of candidates) byKey.set(c.key, [...(byKey.get(c.key) ?? []), c])
  const groups: Group[] = []
  const excluded: { key: string; reason: string; count: number }[] = []
  for (const [key, list] of byKey) {
    const sorted = [...list].sort((a, b) => a.at.localeCompare(b.at))
    // Densest 5-minute window anchored at each event.
    let best: Candidate[] = []
    for (let i = 0; i < sorted.length; i++) {
      const start = Date.parse(sorted[i]!.at)
      const inWindow = sorted.filter((c) => { const t = Date.parse(c.at); return t >= start && t <= start + WINDOW_MS })
      if (new Set(inWindow.map((c) => c.merchantId)).size > new Set(best.map((c) => c.merchantId)).size) best = inWindow
    }
    const outside = sorted.length - best.length
    if (outside > 0) excluded.push({ key, reason: "outside correlation window", count: outside })
    const merchants = [...new Set(best.map((c) => c.merchantId))]
    if (merchants.length < MIN_MERCHANTS) {
      if (best.length) excluded.push({ key, reason: `fewer than ${MIN_MERCHANTS} distinct merchants`, count: best.length })
      continue
    }
    groups.push({ key, members: best, merchants, windowStart: best[0]!.at, windowEnd: best[best.length - 1]!.at })
  }
  groups.sort((a, b) => b.merchants.length - a.merchants.length || b.members.length - a.members.length)
  return { groups, excluded }
}

function link(tx: Sql, incidentId: string, kind: string, ids: Iterable<string>) {
  for (const id of ids) tx.run("INSERT OR IGNORE INTO incident_evidence (incident_id, kind, record_id) VALUES (?,?,?)", [incidentId, kind, id])
}

function createIncident(ctx: Ctx, scenario: Scenario, title: string, severity: string, correlation: object): string {
  const id = newId("inc")
  ctx.tx.run(
    `INSERT INTO incidents (id, generation, batch_id, scenario, title, severity, status, version, owner, blocker, correlation_json, created_at, updated_at)
     VALUES (?,?,?,?,?,?,'DETECTED',1,NULL,NULL,?,?,?)`,
    [id, ctx.generation, ctx.batchId, scenario, title, severity, JSON.stringify(correlation), ctx.now, ctx.now])
  ctx.tx.run("UPDATE batches SET incident_id = ? WHERE id = ?", [id, ctx.batchId])
  return id
}

// ---------- Scenario A: Soundbox notification failures ----------
function injectSoundbox(ctx: Ctx, variant: Variant): string {
  const { tx, generation, batchId } = ctx
  const r = prng(7)
  const t0 = addMs(TELEMETRY_BASE, 60_000)
  const events: { device: string; merchant: string; model: string; config: string; sig: string; at: string }[] = []
  PRIVATE_FIXTURE.targetDeviceRefs.forEach((seedRef, i) => {
    const d = deviceByRef(tx, generation, seedRef)
    events.push({ device: d.id, merchant: d.merchant_id, model: d.model, config: d.config_version, sig: NOTIFY_SIGNATURE, at: addMs(t0, i * 9_000 + r.int(0, 4000)) })
  })
  // Distractors: same signature outside the window; other signature; same model on another config.
  for (const seedRef of PRIVATE_FIXTURE.outOfWindowRefs) {
    const d = deviceByRef(tx, generation, seedRef)
    events.push({ device: d.id, merchant: d.merchant_id, model: d.model, config: d.config_version, sig: NOTIFY_SIGNATURE, at: addMs(TELEMETRY_BASE, -40 * 60_000) })
  }
  for (const seedRef of PRIVATE_FIXTURE.otherSignatureRefs) {
    const d = deviceByRef(tx, generation, seedRef)
    events.push({ device: d.id, merchant: d.merchant_id, model: d.model, config: d.config_version, sig: "NOTIFY_TIMEOUT", at: addMs(t0, 30_000) })
  }
  for (const seedRef of PRIVATE_FIXTURE.otherConfigRefs) {
    const d = deviceByRef(tx, generation, seedRef)
    events.push({ device: d.id, merchant: d.merchant_id, model: d.model, config: d.config_version, sig: "AUDIO_DRIVER_ERR", at: addMs(t0, 45_000) })
  }
  const candidates: Candidate[] = []
  const eventIdByDevice = new Map<string, string>()
  for (const e of events) {
    const id = newId("evt")
    eventIdByDevice.set(e.device, id)
    tx.run("INSERT INTO device_events (id, generation, batch_id, device_id, kind, error_signature, occurred_at) VALUES (?,?,?,?,?,?,?)",
      [id, generation, batchId, e.device, "NOTIFICATION_FAILED", e.sig, e.at])
    candidates.push({ recordId: e.device, merchantId: e.merchant, key: `${e.model}|${e.config}|${e.sig}`, at: e.at })
    // Payment succeeded just before the failed announcement (money arrived, alert missing).
    tx.run("INSERT INTO payments (id, generation, merchant_id, device_id, amount_paise, method, status, occurred_at) VALUES (?,?,?,?,?,?,?,?)",
      [newId("pay"), generation, e.merchant, e.device, r.int(30, 1800) * 100, "UPI", "SUCCESS", addMs(e.at, -4_000)])
  }
  // Merchant tickets about silent Soundboxes.
  for (const m of PRIVATE_FIXTURE.soundboxTicketMerchants) {
    const mid = merchantByRef(tx, generation, m)
    const dev = deviceByRef(tx, generation, `D-${m}-1`)
    tx.run(`INSERT INTO tickets (id, generation, batch_id, seed_ref, merchant_id, device_id, category, subject, status, linked_to, created_at)
            VALUES (?,?,?,?,?,?,?,?,?,NULL,?)`,
      [newId("tkt"), generation, batchId, `T-SBX-${m}`, mid, dev.id, "SOUNDBOX_SILENT", "Payment received but Soundbox did not announce", "OPEN", addMs(t0, 5 * 60_000)])
  }
  // Private behaviour for this variant.
  if (variant === "partial") {
    const d = deviceByRef(tx, generation, PRIVATE_FIXTURE.partialFailRef)
    tx.run("UPDATE sim_device_behavior SET restart_fails = 1 WHERE device_id = ?", [d.id])
  }

  const { groups, excluded } = correlate(candidates)
  const group = groups[0]
  if (!group) throw new CoreError("INVALID_INPUT", "Injection produced no correlated group.")
  const [model, config, sig] = group.key.split("|")
  const deviceIds = group.members.map((m) => m.recordId)
  const incidentId = createIncident(ctx, "soundbox",
    `Soundbox payment notifications failing (${deviceIds.length} devices, model ${model}, config ${config})`, "HIGH", {
      rule: "same model + config version + error signature, >= 3 distinct merchants within 5 minutes",
      windowMinutes: CORE_DEFAULTS.correlationWindowMinutes, minMerchants: MIN_MERCHANTS,
      shared: { model, configVersion: config, errorSignature: sig },
      window: { start: group.windowStart, end: group.windowEnd },
      deviceCount: deviceIds.length, merchantCount: group.merchants.length, excluded,
      note: "The shared configuration is a correlation, not a proven root cause."
    })
  for (const devId of deviceIds) {
    const d = tx.get<{ merchant_id: string; revision: number }>("SELECT merchant_id, revision FROM devices WHERE id = ?", [devId])!
    tx.run("INSERT INTO incident_devices (incident_id, device_id, merchant_id, revision_at_freeze) VALUES (?,?,?,?)", [incidentId, devId, d.merchant_id, d.revision])
  }
  link(tx, incidentId, "device", deviceIds)
  link(tx, incidentId, "device_event", deviceIds.map((d) => eventIdByDevice.get(d)!))
  link(tx, incidentId, "merchant", group.merchants)
  const ph = deviceIds.map(() => "?").join(",")
  link(tx, incidentId, "payment", tx.all<{ id: string }>(
    `SELECT id FROM payments WHERE generation = ? AND device_id IN (${ph}) AND status = 'SUCCESS'`, [generation, ...deviceIds]).map((p) => p.id))
  const mph = group.merchants.map(() => "?").join(",")
  link(tx, incidentId, "ticket", tx.all<{ id: string }>(
    `SELECT id FROM tickets WHERE batch_id = ? AND merchant_id IN (${mph})`, [batchId, ...group.merchants]).map((t) => t.id))
  advanceTelemetry(tx, generation, 7 * 60_000)
  return incidentId
}

// ---------- Scenario B: duplicate support tickets ----------
function injectDuplicateTickets(ctx: Ctx): string {
  const { tx, generation, batchId } = ctx
  const t0 = addMs(TELEMETRY_BASE, 2 * 60_000)
  const subject = "Settlement not received for 19 Nov"
  const candidates: Candidate[] = []
  let i = 0
  for (const [m, count] of Object.entries(PRIVATE_FIXTURE.duplicateTicketPlan)) {
    const mid = merchantByRef(tx, generation, m)
    for (let k = 0; k < count; k++) {
      const id = newId("tkt")
      const at = addMs(t0, (i++) * 11_000)
      // One M042 duplicate is already linked to an older, different case (conflict guard).
      const linkedTo = m === "M042" && k === 2
        ? tx.get<{ id: string }>("SELECT id FROM tickets WHERE generation = ? AND seed_ref = 'T-HIST-M042'", [generation])!.id : null
      tx.run(`INSERT INTO tickets (id, generation, batch_id, seed_ref, merchant_id, device_id, category, subject, status, linked_to, created_at)
              VALUES (?,?,?,?,?,NULL,?,?,?,?,?)`,
        [id, generation, batchId, `T-DUP-${m}-${k + 1}`, mid, "SETTLEMENT_QUERY", subject, "OPEN", linkedTo, at])
      candidates.push({ recordId: id, merchantId: mid, key: `SETTLEMENT_QUERY|${subject.toLowerCase()}`, at })
    }
  }
  for (const [m, cat, subj] of [["M046", "KYC_UPDATE", "Update PAN details"], ["M047", "DEVICE_RETURN", "Return old Soundbox"], ["M048", "KYC_UPDATE", "Change bank account"]] as const) {
    const id = newId("tkt")
    const mid = merchantByRef(tx, generation, m)
    tx.run(`INSERT INTO tickets (id, generation, batch_id, seed_ref, merchant_id, device_id, category, subject, status, linked_to, created_at)
            VALUES (?,?,?,?,?,NULL,?,?,?,NULL,?)`, [id, generation, batchId, `T-OTH-${m}`, mid, cat, subj, "OPEN", addMs(t0, 20_000)])
    candidates.push({ recordId: id, merchantId: mid, key: `${cat}|${subj.toLowerCase()}`, at: addMs(t0, 20_000) })
  }
  const { groups, excluded } = correlate(candidates)
  const group = groups[0]
  if (!group) throw new CoreError("INVALID_INPUT", "Injection produced no correlated group.")
  const ticketIds = group.members.map((m) => m.recordId)
  const incidentId = createIncident(ctx, "duplicate-tickets",
    `Duplicate support tickets: "${subject}" (${ticketIds.length} tickets, ${group.merchants.length} merchants)`, "LOW", {
      rule: "same category + subject, >= 3 distinct merchants within 5 minutes",
      windowMinutes: CORE_DEFAULTS.correlationWindowMinutes, minMerchants: MIN_MERCHANTS,
      window: { start: group.windowStart, end: group.windowEnd }, ticketCount: ticketIds.length,
      merchantCount: group.merchants.length, excluded, note: "Grouping by text similarity is a correlation, not proof of one issue."
    })
  link(tx, incidentId, "ticket", ticketIds)
  link(tx, incidentId, "merchant", group.merchants)
  advanceTelemetry(tx, generation, 5 * 60_000)
  return incidentId
}

// ---------- Scenario C: settlement discrepancy (read-only) ----------
function injectSettlement(ctx: Ctx): string {
  const { tx, generation, batchId } = ctx
  const r = prng(11)
  const candidates: Candidate[] = []
  const at = "2026-11-19T12:30:00.000Z"
  for (const m of PRIVATE_FIXTURE.shortSettlementMerchants) {
    const mid = merchantByRef(tx, generation, m)
    const gross = r.int(5000, 40000) * 100
    const fees = Math.round(gross * 0.004)
    const id = newId("stl")
    tx.run(`INSERT INTO settlements (id, generation, batch_id, merchant_id, settlement_date, gross_paise, fees_paise, expected_paise,
            settled_paise, bank_ref, status, occurred_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, generation, batchId, mid, "2026-11-19", gross, fees, gross - fees, gross - fees - 45_000, "NEFT-B1119-07", "SHORT", at])
    candidates.push({ recordId: id, merchantId: mid, key: "NEFT-B1119-07|SHORT", at })
  }
  for (const m of ["M068", "M069"]) {
    const mid = merchantByRef(tx, generation, m)
    const gross = r.int(5000, 40000) * 100
    const fees = Math.round(gross * 0.004)
    const id = newId("stl")
    tx.run(`INSERT INTO settlements (id, generation, batch_id, merchant_id, settlement_date, gross_paise, fees_paise, expected_paise,
            settled_paise, bank_ref, status, occurred_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, generation, batchId, mid, "2026-11-19", gross, fees, gross - fees, gross - fees, "NEFT-B1119-02", "SETTLED", at])
  }
  const { groups, excluded } = correlate(candidates)
  const group = groups[0]
  if (!group) throw new CoreError("INVALID_INPUT", "Injection produced no correlated group.")
  const ids = group.members.map((m) => m.recordId)
  const incidentId = createIncident(ctx, "settlement-discrepancy",
    `Settlement shortfall on batch NEFT-B1119-07 (${group.merchants.length} merchants)`, "MEDIUM", {
      rule: "same bank batch + SHORT status, >= 3 distinct merchants", minMerchants: MIN_MERCHANTS,
      merchantCount: group.merchants.length, excluded, accessMode: "read-only",
      note: "Settlement records are read-only; resolution requires a human finance handoff."
    })
  link(tx, incidentId, "settlement", ids)
  link(tx, incidentId, "merchant", group.merchants)
  advanceTelemetry(tx, generation, 5 * 60_000)
  return incidentId
}

/**
 * Inject a scenario once per generation. An identical replay returns the existing IDs;
 * a different variant for the same scenario is a conflict until reset.
 */
export function injectScenario(db: CoreDb, clock: Clock, expectedGeneration: number, scenario: Scenario, variant: Variant): InjectResult {
  if (variant === "partial" && scenario !== "soundbox") throw new CoreError("INVALID_INPUT", "Only the soundbox scenario accepts the partial variant.")
  return db.write((tx) => {
    assertActive(tx, expectedGeneration)
    const existing = tx.get<{ id: string; variant: string; incident_id: string }>(
      "SELECT id, variant, incident_id FROM batches WHERE generation = ? AND scenario = ?", [expectedGeneration, scenario])
    if (existing) {
      if (existing.variant !== variant) throw new CoreError("CONFLICT", `Scenario ${scenario} was already injected with variant ${existing.variant}; reset first.`)
      return { generation: expectedGeneration, batchId: existing.id, incidentId: existing.incident_id }
    }
    const batchId = newId("bat")
    const now = clock.now()
    tx.run("INSERT INTO batches (id, generation, scenario, variant, created_at, incident_id) VALUES (?,?,?,?,?,NULL)",
      [batchId, expectedGeneration, scenario, variant, now])
    const ctx: Ctx = { tx, generation: expectedGeneration, batchId, now }
    const incidentId = scenario === "soundbox" ? injectSoundbox(ctx, variant)
      : scenario === "duplicate-tickets" ? injectDuplicateTickets(ctx) : injectSettlement(ctx)
    enqueueJob(tx, clock, { generation: expectedGeneration, incidentId, key: initialInvestigationKey(incidentId), kind: "workflow.investigate", runAfter: now, payload: {} })
    return { generation: expectedGeneration, batchId, incidentId }
  })
}
