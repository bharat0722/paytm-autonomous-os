import { useCallback, useEffect, useEffectEvent, useState } from "react"
import { asProblem, type ApiProblem } from "./api.js"
import type { ApprovalStatus, IncidentStatus, Mode, Scenario } from "../../../shared/contracts/http.js"

export type Route =
  | { view: "mission" }
  | { view: "incident"; id?: string; evidenceId?: string }
  | { view: "approvals"; id?: string }

export function readRoute(hash: string): Route {
  const [path = "", search = ""] = hash.replace(/^#\/?/, "").split("?")
  const [view, encodedId] = path.split("/")
  let id: string | undefined
  try { id = encodedId ? decodeURIComponent(encodedId) : undefined } catch { id = undefined }
  if (view === "incidents") return { view: "incident", id, evidenceId: new URLSearchParams(search).get("evidence") ?? undefined }
  if (view === "approvals") return { view: "approvals", id }
  return { view: "mission" }
}

export const missionHref = "#/"
export const incidentHref = (id?: string, evidenceId?: string) =>
  "#/incidents" + (id ? "/" + encodeURIComponent(id) : "") + (evidenceId ? "?evidence=" + encodeURIComponent(evidenceId) : "")
export const approvalsHref = (id?: string) => "#/approvals" + (id ? "/" + encodeURIComponent(id) : "")

export function useRoute(): Route {
  const [route, setRoute] = useState(() => readRoute(location.hash))
  useEffect(() => {
    function navigate() {
      setRoute(readRoute(location.hash))
      requestAnimationFrame(() => document.getElementById("main-content")?.focus({ preventScroll: true }))
      window.scrollTo(0, 0)
    }
    addEventListener("hashchange", navigate)
    return () => removeEventListener("hashchange", navigate)
  }, [])
  return route
}

type Resource<T> = { key: string; data?: T; fingerprint?: string; error?: ApiProblem }
type Read<T> = (signal: AbortSignal) => Promise<T>

// Each effect owns its requests and timers. Scope changes hide and abort the previous generation.
export function useResource<T>(
  key: string, read: Read<T>, isActive: (data: T) => boolean, onError: (problem: ApiProblem) => void,
) {
  const [result, setResult] = useState<Resource<T>>()
  const [refreshKey, setRefreshKey] = useState(0)
  const refresh = useCallback(() => setRefreshKey((value) => value + 1), [])
  const readLatest = useEffectEvent(read)
  const reportError = useEffectEvent(onError)
  const shouldPoll = useEffectEvent(isActive)

  useEffect(() => {
    if (!key) return
    let stopped = false
    let running = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let iterations = 0
    const controller = new AbortController()

    async function readOnce() {
      if (stopped || running || document.hidden) return
      clearTimeout(timer)
      running = true
      try {
        const data = await readLatest(controller.signal)
        if (stopped) return
        const fingerprint = JSON.stringify(data)
        setResult((previous) => previous?.key === key && previous.fingerprint === fingerprint && !previous.error
          ? previous : { key, data, fingerprint })
        if (shouldPoll(data)) {
          iterations += 1
          timer = setTimeout(readOnce, iterations > 30 ? 4500 : 900)
        }
      } catch (error) {
        if (stopped) return
        const problem = asProblem(error)
        setResult((previous) => previous?.key === key ? { ...previous, error: problem } : { key, error: problem })
        reportError(problem)
      } finally {
        running = false
      }
    }

    function wake() {
      if (document.hidden) clearTimeout(timer)
      else void readOnce()
    }

    void readOnce()
    document.addEventListener("visibilitychange", wake)
    window.addEventListener("focus", wake)
    window.addEventListener("online", wake)
    return () => {
      stopped = true
      clearTimeout(timer)
      controller.abort()
      document.removeEventListener("visibilitychange", wake)
      window.removeEventListener("focus", wake)
      window.removeEventListener("online", wake)
    }
  }, [key, refreshKey])

  const current = result?.key === key ? result : undefined
  return { data: current?.data, error: current?.error, loading: Boolean(key && !current), refresh }
}

export type Tone = "neutral" | "blue" | "green" | "amber" | "red"

export const incidentPresentation: Record<IncidentStatus, [string, Tone]> = {
  DETECTED: ["Detected", "blue"],
  INVESTIGATING: ["Investigating", "blue"],
  INSUFFICIENT_EVIDENCE: ["More evidence needed", "amber"],
  ACTION_RUNNING: ["Action running", "blue"],
  VERIFYING: ["Verifying recovery", "blue"],
  PARTIALLY_RECOVERED: ["Partially recovered", "amber"],
  APPROVAL_PENDING: ["Awaiting approval", "amber"],
  RESOLVED: ["Resolved", "green"],
  ESCALATED: ["Escalated", "red"],
  FAILED: ["Investigation failed", "red"],
  TASK_COMPLETED: ["Ticket linking complete", "green"],
}

export const approvalPresentation: Record<ApprovalStatus, [string, Tone]> = {
  PENDING: ["Pending", "amber"], APPROVED: ["Approved", "blue"], CONSUMED: ["Approval used", "blue"],
  REJECTED: ["Rejected", "red"], EXPIRED: ["Expired", "neutral"],
}

export const modes: Record<Mode, [string, Tone]> = {
  live_ai: ["Live AI", "blue"], scripted_fallback: ["Backup script", "neutral"], system: ["System", "neutral"],
}

export const scenarios: Record<Scenario, string> = {
  "payment-confirmation": "Payment confirmation",
  soundbox: "Soundbox", "order-unpaid": "Paid order shows unpaid", "duplicate-tickets": "Duplicate tickets", "settlement-discrepancy": "Settlement discrepancy",
}

export function isActive(status: IncidentStatus): boolean {
  return ["DETECTED", "INVESTIGATING", "ACTION_RUNNING", "VERIFYING", "PARTIALLY_RECOVERED", "APPROVAL_PENDING"].includes(status)
}

const dateFormat = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })
const clockFormat = new Intl.DateTimeFormat("en-IN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })

export function formatTime(value: string, timeOnly = false): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : (timeOnly ? clockFormat : dateFormat).format(date)
}

export function label(value: string): string {
  const spaced = value.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replaceAll(/[_-]/g, " ")
  return spaced ? spaced[0]!.toUpperCase() + spaced.slice(1).toLowerCase() : value
}

/** Plain names for the written safety rules, so no code name ever reaches a reader. */
export const RULE_TEXT: Record<string, string> = {
  MOCK_SYNC_ELIGIBLE_COHORT: "the settings-sync rule", DEVICE_RESTART_REQUIRES_APPROVAL: "the restart-needs-approval rule",
  LINK_ELIGIBLE_DUPLICATE_TICKETS: "the ticket-linking rule", RESEND_ELIGIBLE_WEBHOOKS: "the payment-alert resend rule",
  SETTLEMENT_READ_ONLY_HANDOFF: "the read-only settlement rule", NO_FINANCIAL_MUTATION: "the no-money-changes rule",
  DENY_BY_DEFAULT: "the deny-unless-allowed rule", NO_AUTOMATIC_REPROPOSAL: "the one-request-only rule", APPROVAL_REQUIRES_APPROVER: "the approver-only rule",
}
export const plainRule = (id: string) => RULE_TEXT[id] ?? "a written safety rule"

const KIND_TEXT: Record<string, string> = {
  devices: "device", device_events: "device event", merchants: "merchant", tickets: "ticket", payments: "payment",
  settlements: "settlement", orders: "order", webhook_log: "payment alert", pg_status: "Paytm status",
}

/** Turns machine phrases (tool names, rule codes, error codes) into a sentence a person can read. */
export function humanize(text: string): string {
  let s = text.replace(/\s*\((?:scripted_fallback|live_ai|system)[^)]*\)/g, "").trim()
  s = s.replace(/\b[A-Z]{2,}(?:_[A-Z0-9]+)+\b/g, (m) => RULE_TEXT[m] ?? m)
  const rules: [RegExp, (m: RegExpMatchArray) => string][] = [
    [/^get_incident:.*$/, () => "Opened the case"],
    [/^read_(\w+) returned 0 .*$/, (m) => `Found no ${KIND_TEXT[m[1]!] ?? m[1]} records for this case`],
    [/^read_(\w+) returned (\d+) .*$/, (m) => `Read ${m[2]} ${KIND_TEXT[m[1]!] ?? m[1]} records`],
    [/^check_pg_status returned (\d+) .*$/, (m) => `Checked Paytm's own record of ${m[1]} payments`],
    [/^get_recovery_snapshot: (\d+)\/(\d+) recovered.*$/, (m) => `Checked the latest result: ${m[1]} of ${m[2]} recovered`],
    [/^propose_config_sync: .*?(\d+) devices.*$/, (m) => `Rule check passed: a settings sync is allowed for ${m[1]} devices`],
    [/^request_restart_approval: (\d+) devices.*$/, (m) => `Asked a person to approve restarting ${m[1]} devices`],
    [/^propose_ticket_link: .*$/, () => "Rule check passed: duplicate tickets can be linked"],
    [/^propose_webhook_resend: .*?(\d+) orders.*$/, (m) => `Rule check passed: the payment alert can be resent for ${m[1]} orders`],
    [/^record_settlement_handoff: .*$/, () => "Prepared the handoff for Settlement Operations"],
    [/^(\w+) denied by (.+?): (.*)$/, (m) => `A rule stopped it: ${m[3]}`],
    [/^Rejected step: .*$/, () => "The AI's answer was malformed, so it was asked again"],
    [/^Guardrail caught a malformed AI output.*$/, () => "The AI's answer was malformed, so it was asked again"],
    [/^Switched to scripted fallback: .*$/, () => "The live AI needed help, so the backup script took over"],
    [/^Investigator (?:triage|continuation) episode started with live model.*$/, () => "The live AI started investigating"],
    [/^Investigator (?:triage|continuation) episode started in scripted fallback.*$/, () => "The backup script started investigating"],
  ]
  for (const [re, fn] of rules) { const m = s.match(re); if (m) { s = fn(m); break } }
  return s.replace(/\bmock /gi, "simulated ").replace(/\bcohort\b/gi, "group").replace(/\bverifier\b/gi, "final check").replace(/\bscripted fallback\b/gi, "backup script")
}

const SIGNAL_TEXT: [RegExp, string][] = [
  [/NOTIFY_PUSH_DROPPED/, "Payment announcement not delivered"], [/NOTIFY_TIMEOUT/, "Announcement timed out"], [/AUDIO_CODEC_FAULT/, "Speaker or audio fault"],
  [/AUDIO_DRIVER_ERR/, "Audio driver error"], [/NET_SIM_DROPOUT/, "Mobile data connection dropped"], [/LOW_BATTERY/, "Low battery"], [/HEARTBEAT_LATE/, "Device check-in late"],
  [/WEBHOOK_FAILED\|HTTP_502/, "Payment alert to the merchant failed (their server was down)"], [/PG_STATUS_PENDING/, "Payment still pending at the bank"],
  [/LATE_SUCCESS_ORDER_CANCELLED/, "Paid late, order already cancelled"], [/SHORT/, "Paid less than expected"],
]
/** Plain wording for a grouping key or error code such as SBX-AI-2|7.4.1|NOTIFY_PUSH_DROPPED. */
export function plainSignal(value: string): string {
  const hit = SIGNAL_TEXT.find(([re]) => re.test(value))
  if (hit) return hit[1] + (value.includes("|") && !/WEBHOOK/.test(value) ? ` · ${value.split("|").slice(0, 2).join(" ")}` : "")
  return value.replaceAll("|", " · ").replaceAll("_", " ").toLowerCase()
}

/** Who did a step, in words: AI, fix runner, final check, a person. */
export function actorText(actor: string): string {
  if (actor.startsWith("workflow:investigator")) return actor.includes("live_ai") ? "AI investigator (live)" : "AI investigator (backup script)"
  if (actor.startsWith("workflow:executor")) return "Fix runner"
  if (actor.startsWith("workflow:verifier")) return "Final check"
  if (actor.startsWith("system")) return "Automatic timer"
  if (actor.startsWith("operator")) return "Operator"
  if (actor.startsWith("approver")) return "Approver"
  return actor.replace(/^[a-z]+:/, "")
}

export function traceSummary(summary: string): string {
  const stepped = summary.replace(/^([A-Z_]+) → ([A-Z_]+): /, (prefix: string, from: string, to: string) => {
    const left = incidentPresentation[from as IncidentStatus]?.[0]
    const right = incidentPresentation[to as IncidentStatus]?.[0]
    return left && right ? `${left} → ${right} · ` : prefix
  })
  const [head, ...rest] = stepped.split(" · ")
  return rest.length ? `${head} · ${humanize(rest.join(" · "))}` : humanize(stepped)
}

export const number = new Intl.NumberFormat("en-IN")

export const rupees = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2, minimumFractionDigits: 0 })
