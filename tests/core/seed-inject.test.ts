import { afterEach, describe, expect, it } from "vitest"
import { correlate, injectScenario } from "../../server/core/inject.js"
import { activeGeneration } from "../../server/core/generations.js"
import { PRIVATE_FIXTURE } from "../../server/core/seed.js"
import { CoreError, initialInvestigationKey } from "../../shared/contracts/core.js"
import { makeCore } from "./helpers.js"

const cores: { cleanup(): void }[] = []
const core = () => { const c = makeCore(); cores.push(c); return c }
afterEach(() => { while (cores.length) cores.pop()!.cleanup() })

const relationships = (c: ReturnType<typeof makeCore>) => c.db.read((q) => {
  const g = activeGeneration(q)
  return q.all<{ d: string; m: string; model: string; cfg: string }>(
    `SELECT d.seed_ref AS d, m.seed_ref AS m, d.model, d.config_version AS cfg FROM devices d JOIN merchants m ON m.id = d.merchant_id
     WHERE d.generation = ? ORDER BY d.seed_ref`, [g])
})

describe("seed", () => {
  it("is deterministic: same relationships on every clean run, fresh opaque IDs", () => {
    const a = core(); const b = core()
    expect(relationships(a)).toEqual(relationships(b))
    const count = a.db.read((q) => q.get<{ c: number }>("SELECT COUNT(*) AS c FROM merchants")!.c)
    expect(count).toBeGreaterThanOrEqual(100)
    expect(count).toBeLessThanOrEqual(150)
    const idA = a.db.read((q) => q.get<{ id: string }>("SELECT id FROM merchants WHERE seed_ref = 'M001'")!.id)
    const idB = b.db.read((q) => q.get<{ id: string }>("SELECT id FROM merchants WHERE seed_ref = 'M001'")!.id)
    expect(idA).not.toEqual(idB)
  })
})

describe("correlation", () => {
  it("needs >= 3 distinct merchants inside a 5-minute window", () => {
    const at = (s: number) => new Date(Date.UTC(2026, 10, 20, 6, 0, s)).toISOString()
    const { groups, excluded } = correlate([
      { recordId: "a", merchantId: "m1", key: "k", at: at(0) }, { recordId: "b", merchantId: "m2", key: "k", at: at(10) },
      { recordId: "c", merchantId: "m3", key: "k", at: at(20) }, { recordId: "z", merchantId: "m9", key: "k", at: at(0) },
      { recordId: "x", merchantId: "m4", key: "j", at: at(0) }, { recordId: "y", merchantId: "m5", key: "j", at: at(5) }
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0]!.merchants).toHaveLength(4)
    expect(excluded.some((e) => e.key === "j")).toBe(true)
  })
})

describe("injection", () => {
  it("soundbox/success creates exactly one incident linking the intended 24 devices", () => {
    const c = core()
    const gen = c.db.read((q) => activeGeneration(q))
    const r = injectScenario(c.db, c.clock, gen, "soundbox", "success")
    const inc = c.runtime.db.read((q) => c.runtime.incidents.get(q, { generation: gen, incidentId: r.incidentId }))!
    expect(inc.devices).toHaveLength(24)
    expect(inc.card.status).toBe("DETECTED")
    expect(inc.card.affectedDeviceCount).toBe(24)
    expect(inc.card.affectedMerchantCount).toBe(21)
    const refs = c.db.read((q) => inc.devices.map((d) => q.get<{ s: string }>("SELECT seed_ref AS s FROM devices WHERE id = ?", [d.id])!.s)).sort()
    expect(refs).toEqual([...PRIVATE_FIXTURE.targetDeviceRefs].sort())
    // Distractors are not in the roster.
    for (const ref of [...PRIVATE_FIXTURE.outOfWindowRefs, ...PRIVATE_FIXTURE.otherSignatureRefs, ...PRIVATE_FIXTURE.otherConfigRefs]) expect(refs).not.toContain(ref)
    const incidents = c.db.read((q) => q.get<{ c: number }>("SELECT COUNT(*) AS c FROM incidents WHERE generation = ?", [gen])!.c)
    expect(incidents).toBe(1)
    // Evidence: tickets and successful payment context are linked; correlation reason persisted.
    const kinds = c.db.read((q) => q.all<{ kind: string; c: number }>("SELECT kind, COUNT(*) AS c FROM incident_evidence WHERE incident_id = ? GROUP BY kind", [r.incidentId]))
    const byKind = Object.fromEntries(kinds.map((k) => [k.kind, k.c]))
    expect(byKind).toMatchObject({ device: 24, device_event: 24, merchant: 21, ticket: 9, payment: 24 })
    const corr = JSON.parse(c.db.read((q) => q.get<{ j: string }>("SELECT correlation_json AS j FROM incidents WHERE id = ?", [r.incidentId])!.j))
    expect(corr.note).toMatch(/not a proven root cause/)
    expect(corr.excluded.length).toBeGreaterThan(0)
    // Initial investigation job enqueued with the agreed key.
    const job = c.db.read((q) => q.get<{ kind: string; status: string }>("SELECT kind, status FROM jobs WHERE key = ?", [initialInvestigationKey(r.incidentId)]))
    expect(job).toEqual({ kind: "workflow.investigate", status: "PENDING" })
  })

  it("identical replay returns existing IDs; a different variant conflicts until reset", () => {
    const c = core()
    const gen = c.db.read((q) => activeGeneration(q))
    const a = injectScenario(c.db, c.clock, gen, "soundbox", "success")
    const b = injectScenario(c.db, c.clock, gen, "soundbox", "success")
    expect(b).toEqual(a)
    expect(() => injectScenario(c.db, c.clock, gen, "soundbox", "partial")).toThrow(CoreError)
    expect(() => injectScenario(c.db, c.clock, gen, "duplicate-tickets", "partial")).toThrow(/partial/)
    const jobs = c.db.read((q) => q.get<{ c: number }>("SELECT COUNT(*) AS c FROM jobs WHERE generation = ?", [gen])!.c)
    expect(jobs).toBe(1)
  })

  it("scenario B links duplicate tickets; scenario C links short settlements read-only", () => {
    const c = core()
    const gen = c.db.read((q) => activeGeneration(q))
    const b = injectScenario(c.db, c.clock, gen, "duplicate-tickets", "success")
    const tickets = c.runtime.db.read((q) => c.runtime.evidence.read(q, { generation: gen, incidentId: b.incidentId }, { kind: "ticket", limit: 200 }))
    expect(tickets).toHaveLength(14)
    const s = injectScenario(c.db, c.clock, gen, "settlement-discrepancy", "success")
    const stl = c.runtime.db.read((q) => c.runtime.evidence.read(q, { generation: gen, incidentId: s.incidentId }, { kind: "settlement" }))
    expect(stl).toHaveLength(8)
    expect(stl.every((x) => x.details.readOnly === true && x.details.status === "SHORT")).toBe(true)
  })

  it("evidence reads are scoped to the incident and never expose simulator behaviour", () => {
    const c = core()
    const gen = c.db.read((q) => activeGeneration(q))
    const a = injectScenario(c.db, c.clock, gen, "soundbox", "success")
    const b = injectScenario(c.db, c.clock, gen, "duplicate-tickets", "success")
    const foreign = c.runtime.db.read((q) => c.runtime.evidence.read(q, { generation: gen, incidentId: b.incidentId }, { kind: "device" }))
    expect(foreign).toHaveLength(0)
    const devices = c.runtime.db.read((q) => c.runtime.evidence.read(q, { generation: gen, incidentId: a.incidentId }, { kind: "device", limit: 500 }))
    expect(devices).toHaveLength(24)
    expect(JSON.stringify(devices)).not.toMatch(/needs_restart|restart_fails|needsRestart/)
  })
})
