// Deterministic synthetic seed (SYNTHETIC DEMO). Same seed => same relationships and
// the same canonical cohort on every clean run. IDs are fresh per generation (opaque).
import type { Sql } from "../../shared/contracts/core.js"
import { addMs, newId, prng } from "./util.js"

export const SEED = 20261120
export const TELEMETRY_BASE = "2026-11-20T05:30:00.000Z"
export const MERCHANT_COUNT = 120

export const TARGET_MODEL = "SBX-AI-2"
export const AFFECTED_CONFIG = "7.4.1"
export const FIXED_CONFIG = "7.4.2"
export const NOTIFY_SIGNATURE = "NOTIFY_PUSH_DROPPED"

const ref = (n: number) => `M${String(n).padStart(3, "0")}`
const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i)

/** Private simulator truth. Kept in server-side test data only. */
export const PRIVATE_FIXTURE = Object.freeze({
  // 24 target devices: primary devices of M001..M021 + second devices of M001..M003.
  targetDeviceRefs: [...range(1, 21).map((n) => `D-${ref(n)}-1`), ...range(1, 3).map((n) => `D-${ref(n)}-2`)],
  // Four devices still fail after config sync and need a restart.
  needsRestartRefs: ["D-M005-1", "D-M011-1", "D-M017-1", "D-M002-2"],
  // In the `partial` variant this one still fails after restart.
  partialFailRef: "D-M011-1",
  outOfWindowRefs: ["D-M022-1", "D-M023-1"],
  otherSignatureRefs: ["D-M070-1", "D-M071-1"],
  otherConfigRefs: ["D-M050-1", "D-M051-1"],
  soundboxTicketMerchants: ["M002", "M004", "M005", "M008", "M011", "M013", "M016", "M019", "M021"],
  duplicateTicketPlan: { M040: 3, M041: 2, M042: 3, M043: 2, M044: 2, M045: 2 } as Record<string, number>,
  shortSettlementMerchants: range(60, 67).map(ref),
  // Payment Gateway scenario: four paid orders whose webhook failed (merchants M080-M082).
  orderCohort: [
    { merchant: "M080", ref: "ORD-1001", rupees: 1240 },
    { merchant: "M080", ref: "ORD-1002", rupees: 560 },
    { merchant: "M081", ref: "ORD-2001", rupees: 2100 },
    { merchant: "M082", ref: "ORD-3001", rupees: 899 },
  ],
  // In the `partial` variant this merchant endpoint still rejects a resent webhook.
  orderPartialFailRef: "ORD-3001",
  orderTicketMerchants: ["M080", "M081", "M082"],
})

const SHOP = ["Kirana", "Medical", "General Store", "Sweets", "Mobile Shop", "Dairy", "Bakery", "Hardware", "Tea Stall", "Stationery"]
const NAMES = ["Sharma", "Gupta", "Patel", "Verma", "Yadav", "Singh", "Iyer", "Reddy", "Khan", "Das", "Joshi", "Nair"]
const CITIES = ["Indore", "Lucknow", "Jaipur", "Patna", "Nagpur", "Surat", "Bhopal", "Kanpur", "Ranchi", "Vadodara"]

export function seedGeneration(tx: Sql, generation: number): void {
  const r = prng(SEED)
  const merchantIds = new Map<string, string>()
  for (const n of range(1, MERCHANT_COUNT)) {
    const id = newId("mer")
    const shop = r.pick(SHOP)
    merchantIds.set(ref(n), id)
    tx.run("INSERT INTO merchants (id, generation, seed_ref, name, city, category) VALUES (?,?,?,?,?,?)",
      [id, generation, ref(n), `${r.pick(NAMES)} ${shop} ${String(n).padStart(3, "0")}`, r.pick(CITIES), shop])
  }

  const deviceSpecs: { seedRef: string; merchant: string; model: string; config: string; firmware: string }[] = []
  for (const n of range(1, MERCHANT_COUNT)) {
    const m = ref(n)
    let model = TARGET_MODEL
    let config = FIXED_CONFIG
    if (n <= 23) config = AFFECTED_CONFIG
    if (n >= 61) { model = "SBX-LITE"; config = n % 2 ? "3.1" : "3.2" }
    deviceSpecs.push({ seedRef: `D-${m}-1`, merchant: m, model, config, firmware: model === TARGET_MODEL ? "fw-2.9.0" : "fw-1.4.2" })
  }
  for (const n of [1, 2, 3]) deviceSpecs.push({ seedRef: `D-${ref(n)}-2`, merchant: ref(n), model: TARGET_MODEL, config: AFFECTED_CONFIG, firmware: "fw-2.9.0" })
  for (const n of [90, 91]) deviceSpecs.push({ seedRef: `D-${ref(n)}-2`, merchant: ref(n), model: "SBX-LITE", config: "3.2", firmware: "fw-1.4.2" })

  const needsRestart = new Set(PRIVATE_FIXTURE.needsRestartRefs)
  for (const d of deviceSpecs) {
    const id = newId("dev")
    tx.run("INSERT INTO devices (id, generation, seed_ref, merchant_id, model, config_version, firmware, revision) VALUES (?,?,?,?,?,?,?,1)",
      [id, generation, d.seedRef, merchantIds.get(d.merchant)!, d.model, d.config, d.firmware])
    tx.run("INSERT INTO sim_device_behavior (device_id, generation, needs_restart, restart_fails) VALUES (?,?,?,0)",
      [id, generation, needsRestart.has(d.seedRef) ? 1 : 0])
  }

  // Historical payments, tickets and settlements (context, all healthy).
  for (const n of range(1, MERCHANT_COUNT)) {
    const m = merchantIds.get(ref(n))!
    for (let k = 0; k < 4; k++) {
      tx.run("INSERT INTO payments (id, generation, merchant_id, device_id, amount_paise, method, status, occurred_at) VALUES (?,?,?,?,?,?,?,?)",
        [newId("pay"), generation, m, null, r.int(20, 2500) * 100, r.pick(["UPI", "UPI", "UPI", "CARD"]), "SUCCESS",
          addMs(TELEMETRY_BASE, -(k + 1) * 86_400_000 - r.int(0, 36_000) * 1000)])
    }
    for (const day of [17, 18]) {
      const gross = r.int(2000, 30000) * 100
      const fees = Math.round(gross * 0.004)
      tx.run(`INSERT INTO settlements (id, generation, batch_id, merchant_id, settlement_date, gross_paise, fees_paise, expected_paise,
              settled_paise, bank_ref, status, occurred_at) VALUES (?,?,NULL,?,?,?,?,?,?,?,?,?)`,
        [newId("stl"), generation, m, `2026-11-${day}`, gross, fees, gross - fees, gross - fees, `NEFT-B11${day}-0${(n % 9) + 1}`,
          "SETTLED", `2026-11-${day}T12:30:00.000Z`])
    }
  }
  // A historical ticket for M042 that one of the scenario-B duplicates is already linked to (conflict guard).
  tx.run(`INSERT INTO tickets (id, generation, batch_id, seed_ref, merchant_id, device_id, category, subject, status, linked_to, created_at)
          VALUES (?,?,NULL,?,?,NULL,?,?,?,NULL,?)`,
    [newId("tkt"), generation, "T-HIST-M042", merchantIds.get("M042")!, "SETTLEMENT_QUERY", "Settlement query (older case)", "OPEN",
      addMs(TELEMETRY_BASE, -3 * 86_400_000)])
}
