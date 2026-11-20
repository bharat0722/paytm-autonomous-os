// Deny-by-default action policy. Inputs are server-derived only: scenario, incident
// status and cohort from core, evidence actually retrieved in the current episode,
// and the verifier's saved snapshot. Nothing from model text or ticket content is trusted.
import type { CoreIncident } from "../../shared/contracts/core.js"
import type { Actor, DeviceCheck, EvidenceView } from "../../shared/contracts/http.js"
import { sortedUnique } from "./util.js"

export const RULES = {
  SYNC: "MOCK_SYNC_ELIGIBLE_COHORT",
  RESTART: "DEVICE_RESTART_REQUIRES_APPROVAL",
  LINK: "LINK_ELIGIBLE_DUPLICATE_TICKETS",
  SETTLEMENT: "SETTLEMENT_READ_ONLY_HANDOFF",
  DENY: "DENY_BY_DEFAULT",
  NO_FINANCIAL: "NO_FINANCIAL_MUTATION",
  NO_REPROPOSAL: "NO_AUTOMATIC_REPROPOSAL",
  APPROVER_ONLY: "APPROVAL_REQUIRES_APPROVER",
} as const

export type ActionRequest =
  | { kind: "MOCK_SYNC_DEVICE_CONFIG"; targetIds: string[] }
  | { kind: "MOCK_RESTART_DEVICE"; targetIds: string[] }
  | { kind: "LINK_SUPPORT_TICKETS"; primaryTicketId?: string; duplicateTicketIds?: string[]; groups?: LinkGroup[] }
  | { kind: string; targetIds?: string[] }

/** One merchant's duplicate set: the primary stays open, duplicates link to it. */
export interface LinkGroup { primaryTicketId: string; duplicateTicketIds: string[] }

/** Normalizes the legacy single-group form and the multi-group form. */
export function linkGroupsOf(r: { primaryTicketId?: string; duplicateTicketIds?: string[]; groups?: LinkGroup[] }): LinkGroup[] {
  const raw = r.groups?.length ? r.groups : r.primaryTicketId ? [{ primaryTicketId: r.primaryTicketId, duplicateTicketIds: r.duplicateTicketIds ?? [] }] : []
  return raw.map((g) => ({ primaryTicketId: g.primaryTicketId, duplicateTicketIds: sortedUnique(g.duplicateTicketIds ?? []) }))
    .sort((a, b) => a.primaryTicketId.localeCompare(b.primaryTicketId))
}

export interface PolicyContext {
  incident: CoreIncident
  /** Evidence returned by tools in the current episode, keyed by evidence id. */
  retrieved: ReadonlyMap<string, EvidenceView>
  /** Device checks from the verifier's latest final snapshot, if any. */
  latestChecks: DeviceCheck[] | null
  /** Restart approvals already requested for this incident in this generation. */
  existingRestartApprovals: number
}

export interface PolicyDecision {
  allowed: boolean
  requiresApproval: boolean
  ruleId: string
  reason: string
  /** Normalized, sorted targets the decision applies to (LINK: each group's primary first). */
  targetIds: string[]
  /** LINK only: the validated duplicate groups. */
  groups?: LinkGroup[]
}

const FINANCIAL = /SETTLEMENT|REFUND|PAYOUT|PAYMENT|LEDGER|ADJUST|TRANSFER|REVERSAL/i

function deny(ruleId: string, reason: string, targetIds: string[] = []): PolicyDecision {
  return { allowed: false, requiresApproval: false, ruleId, reason, targetIds }
}

export function deviceEvidenceFor(retrieved: ReadonlyMap<string, EvidenceView>, deviceId: string): EvidenceView | undefined {
  for (const ev of retrieved.values()) {
    if (ev.kind === "device" && (ev.id === deviceId || ev.details.deviceId === deviceId)) return ev
  }
  return undefined
}

/** Stored link keys the platform may use to record a duplicate-ticket link. */
export const TICKET_LINK_KEYS = ["duplicateOf", "linkedTo", "primaryTicketId", "linkedTicketId"] as const
export function ticketLinkTarget(ev: EvidenceView): string | null {
  for (const key of TICKET_LINK_KEYS) {
    const v = ev.details[key]
    if (typeof v === "string" && v.length > 0) return v
  }
  return null
}

export function evaluateAction(ctx: PolicyContext, request: ActionRequest): PolicyDecision {
  const { incident } = ctx
  const scenario = incident.card.scenario
  const status = incident.card.status

  if (FINANCIAL.test(request.kind)) return deny(RULES.NO_FINANCIAL, "No financial mutation is available; settlement access is read-only.")

  switch (request.kind) {
    case "MOCK_SYNC_DEVICE_CONFIG": {
      const r = request as { targetIds: string[] }
      const targets = sortedUnique(r.targetIds ?? [])
      if (scenario !== "soundbox") return deny(RULES.DENY, "Config sync applies only to the Soundbox incident.", targets)
      if (status !== "INVESTIGATING") return deny(RULES.DENY, `Config sync is not eligible while the incident is ${status}.`, targets)
      const cohortCheck = checkCohort(incident, targets)
      if (cohortCheck) return deny(RULES.SYNC, cohortCheck, targets)
      const unread = targets.filter((id) => !deviceEvidenceFor(ctx.retrieved, id))
      if (unread.length) return deny(RULES.SYNC, `Device records were not read in this run for: ${unread.join(", ")}.`, targets)
      return { allowed: true, requiresApproval: false, ruleId: RULES.SYNC, reason: "Eligible mock config sync over read cohort devices.", targetIds: targets }
    }
    case "MOCK_RESTART_DEVICE": {
      const r = request as { targetIds: string[] }
      const targets = sortedUnique(r.targetIds ?? [])
      if (scenario !== "soundbox") return deny(RULES.DENY, "Restart applies only to the Soundbox incident.", targets)
      if (status !== "PARTIALLY_RECOVERED") return deny(RULES.RESTART, `Restart can be requested only after verified partial recovery (status is ${status}).`, targets)
      if (ctx.existingRestartApprovals > 0) return deny(RULES.NO_REPROPOSAL, "A restart was already requested for this incident; no automatic reproposal.", targets)
      const cohortCheck = checkCohort(incident, targets)
      if (cohortCheck) return deny(RULES.RESTART, cohortCheck, targets)
      if (!ctx.latestChecks) return deny(RULES.RESTART, "No saved verifier snapshot identifies unresolved devices.", targets)
      const unresolved = new Set(ctx.latestChecks.filter((c) => c.status !== "PASS").map((c) => c.deviceId))
      const notUnresolved = targets.filter((id) => !unresolved.has(id))
      if (notUnresolved.length) return deny(RULES.RESTART, `Targets are not unresolved in the verifier snapshot: ${notUnresolved.join(", ")}.`, targets)
      const unread = targets.filter((id) => !deviceEvidenceFor(ctx.retrieved, id))
      if (unread.length) return deny(RULES.RESTART, `Device records were not read in this run for: ${unread.join(", ")}.`, targets)
      return { allowed: true, requiresApproval: true, ruleId: RULES.RESTART, reason: "Restart of unresolved verified devices requires human approval.", targetIds: targets }
    }
    case "LINK_SUPPORT_TICKETS": {
      const groups = linkGroupsOf(request as { primaryTicketId?: string; duplicateTicketIds?: string[]; groups?: LinkGroup[] })
      const targets = groups.flatMap((g) => [g.primaryTicketId, ...g.duplicateTicketIds])
      if (scenario !== "duplicate-tickets") return deny(RULES.DENY, "Ticket linking applies only to the duplicate-ticket incident.", targets)
      if (status !== "INVESTIGATING") return deny(RULES.DENY, `Ticket linking is not eligible while the incident is ${status}.`, targets)
      if (groups.length === 0) return deny(RULES.LINK, "A primary ticket and at least one duplicate are required.", targets)
      if (new Set(targets).size !== targets.length) return deny(RULES.LINK, "A ticket may appear in only one duplicate group.", targets)
      for (const g of groups) {
        if (!g.primaryTicketId || g.duplicateTicketIds.length === 0) return deny(RULES.LINK, "Each group needs a primary ticket and at least one duplicate.", targets)
        if (g.duplicateTicketIds.includes(g.primaryTicketId)) return deny(RULES.LINK, "The primary ticket cannot be linked to itself.", targets)
        const primary = ctx.retrieved.get(g.primaryTicketId)
        if (!primary || primary.kind !== "ticket") return deny(RULES.LINK, `Primary ticket ${g.primaryTicketId} was not read in this run.`, targets)
        const primaryLink = ticketLinkTarget(primary)
        if (primaryLink) return deny(RULES.LINK, `Primary ticket ${g.primaryTicketId} is itself linked to ${primaryLink}.`, targets)
        for (const id of g.duplicateTicketIds) {
          const ev = ctx.retrieved.get(id)
          if (!ev || ev.kind !== "ticket") return deny(RULES.LINK, `Ticket ${id} was not read in this run.`, targets)
          const linked = ticketLinkTarget(ev)
          if (linked && linked !== g.primaryTicketId) return deny(RULES.LINK, `Ticket ${id} is already linked to ${linked}.`, targets)
          const m1 = primary.details.merchantId, m2 = ev.details.merchantId
          if (m1 != null && m2 != null && m1 !== m2) return deny(RULES.LINK, `Ticket ${id} belongs to a different merchant.`, targets)
        }
      }
      const dupCount = groups.reduce((n, g) => n + g.duplicateTicketIds.length, 0)
      return {
        allowed: true, requiresApproval: false, ruleId: RULES.LINK, targetIds: targets, groups,
        reason: `Eligible duplicate tickets: ${dupCount} duplicates across ${groups.length} merchant ${groups.length === 1 ? "issue" : "issues"}.`,
      }
    }
    default:
      return deny(RULES.DENY, `Action ${String(request.kind).slice(0, 60)} is not on the allowlist.`)
  }
}

function checkCohort(incident: CoreIncident, targets: string[]): string | null {
  if (targets.length === 0) return "No targets supplied."
  const cohort = new Set(incident.devices.map((d) => d.id))
  const outside = targets.filter((id) => !cohort.has(id))
  return outside.length ? `Targets outside the incident cohort: ${outside.join(", ")}.` : null
}

/** Decisions are made only by a session-authenticated approver. A submitted role has no effect. */
export function canDecideApproval(actor: Actor | null | undefined): PolicyDecision {
  if (!actor) return deny(RULES.APPROVER_ONLY, "Sign in as the approver to decide.")
  if (actor.role !== "approver") return deny(RULES.APPROVER_ONLY, "Only the approver role can decide a restricted action.")
  return { allowed: true, requiresApproval: false, ruleId: RULES.APPROVER_ONLY, reason: "Approver session.", targetIds: [] }
}
