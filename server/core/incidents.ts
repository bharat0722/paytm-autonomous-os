// Incident store: frozen roster, cards and version-checked transitions.
import type { IncidentCard, IncidentStatus, Scenario, Scope } from "../../shared/contracts/http.js"
import {
  CoreError, isLegalTransition, type CohortDevice, type CoreIncident, type CoreTransition, type Sql
} from "../../shared/contracts/core.js"
import { assertActive } from "./generations.js"
import { displayIdFor, jobForIncident } from "./profile.js"
import type { Clock } from "./util.js"

interface IncidentRow {
  id: string; generation: number; scenario: Scenario; title: string; severity: IncidentCard["severity"];
  status: IncidentStatus; version: number; owner: string | null; blocker: string | null; updated_at: string
}

const SELECT = "SELECT id, generation, scenario, title, severity, status, version, owner, blocker, updated_at FROM incidents"

export function linkedMerchantIds(q: Sql, incidentId: string): string[] {
  return q.all<{ record_id: string }>(
    "SELECT record_id FROM incident_evidence WHERE incident_id = ? AND kind = 'merchant' ORDER BY record_id", [incidentId]
  ).map((r) => r.record_id)
}

function rosterDevices(q: Sql, incidentId: string): CohortDevice[] {
  return q.all<{ id: string; merchant_id: string; revision: number }>(
    `SELECT d.id, d.merchant_id, d.revision FROM incident_devices i JOIN devices d ON d.id = i.device_id
     WHERE i.incident_id = ? ORDER BY d.seed_ref`, [incidentId]
  ).map((d) => ({ id: d.id, merchantId: d.merchant_id, revision: String(d.revision) }))
}

function toCard(q: Sql, row: IncidentRow): IncidentCard {
  const deviceCount = q.get<{ c: number }>("SELECT COUNT(*) AS c FROM incident_devices WHERE incident_id = ?", [row.id])!.c
  const job = jobForIncident(q, row.id)
  const detectedAt = q.get<{ t: string }>("SELECT created_at AS t FROM incidents WHERE id = ?", [row.id])?.t
  return {
    id: row.id, scenario: row.scenario, title: row.title, severity: row.severity, status: row.status,
    version: row.version, affectedMerchantCount: linkedMerchantIds(q, row.id).length,
    affectedDeviceCount: deviceCount, updatedAt: row.updated_at,
    displayId: displayIdFor(q, row.id) ?? undefined, typeLabel: job?.typeLabel, zone: job?.zone, detectedAt, owner: row.owner
  }
}

/** Returns the incident only if it belongs to the scope's generation. */
export function getIncident(q: Sql, scope: Scope): CoreIncident | null {
  const row = q.get<IncidentRow>(`${SELECT} WHERE id = ? AND generation = ?`, [scope.incidentId, scope.generation])
  if (!row) return null
  return { card: toCard(q, row), devices: rosterDevices(q, row.id), blocker: row.blocker, owner: row.owner }
}

export function listIncidentCards(q: Sql, generation: number): IncidentCard[] {
  return q.all<IncidentRow>(`${SELECT} WHERE generation = ? ORDER BY created_at, id`, [generation]).map((r) => toCard(q, r))
}

export function transitionIncident(tx: Sql, clock: Clock, scope: Scope, change: CoreTransition): CoreIncident {
  assertActive(tx, scope.generation)
  const current = tx.get<IncidentRow>(`${SELECT} WHERE id = ? AND generation = ?`, [scope.incidentId, scope.generation])
  if (!current) throw new CoreError("NOT_FOUND", "Incident not found in this generation.")
  if (current.version !== change.expectedVersion) {
    throw new CoreError("CONFLICT", `Incident version is ${current.version}, expected ${change.expectedVersion}.`)
  }
  if (!isLegalTransition(current.status, change.status)) {
    throw new CoreError("INVALID_INPUT", `Illegal transition ${current.status} -> ${change.status}.`)
  }
  if (change.status === "RESOLVED" && !change.verifiedCheckId?.trim()) {
    throw new CoreError("INVALID_INPUT", "RESOLVED requires a verifier-owned check reference.")
  }
  tx.run(
    `UPDATE incidents SET status = ?, owner = ?, blocker = ?, version = version + 1, updated_at = ?,
       verified_check_id = COALESCE(?, verified_check_id)
     WHERE id = ? AND version = ?`,
    [change.status, change.owner, change.blocker, clock.now(), change.verifiedCheckId ?? null, scope.incidentId, change.expectedVersion]
  )
  return getIncident(tx, scope)!
}
