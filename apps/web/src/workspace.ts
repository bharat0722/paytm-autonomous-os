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
  live_ai: ["AI model", "blue"], scripted_fallback: ["Scripted fallback", "neutral"], system: ["System", "neutral"],
}

export const scenarios: Record<Scenario, string> = {
  "payment-confirmation": "Payment confirmation",
  soundbox: "Soundbox", "duplicate-tickets": "Duplicate tickets", "settlement-discrepancy": "Settlement discrepancy",
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

export function traceSummary(summary: string): string {
  return summary.replace(/^([A-Z_]+) → ([A-Z_]+): /, (prefix: string, from: string, to: string) => {
    const left = incidentPresentation[from as IncidentStatus]?.[0]
    const right = incidentPresentation[to as IncidentStatus]?.[0]
    return left && right ? `${left} → ${right} · ` : prefix
  })
}

export const number = new Intl.NumberFormat("en-IN")
