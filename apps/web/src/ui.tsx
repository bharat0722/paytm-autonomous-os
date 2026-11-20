import { useEffect, useId, useRef, type ReactNode } from "react"
import type { IncidentStatus } from "../../../shared/contracts/http.js"
import { ApiProblem } from "./api.js"
import { formatTime, incidentPresentation, type Tone } from "./workspace.js"

const paths = {
  brand: "M3 13h4l3-7 4 13 3-6h4",
  grid: "M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z",
  incident: "M3 12h4l3-6 4 12 3-6h4",
  shield: "M12 22s8-4 8-11V6l-8-3-8 3v5c0 7 8 11 8 11z M9 12l2 2 4-4",
  user: "M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2 M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8",
  users: "M17 21v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2 M10 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8 M21 21v-2a4 4 0 0 0-3-3.87 M16 3.13a4 4 0 0 1 0 7.75",
  timer: "M12 8v4l3 2 M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20",
  check: "M5 12.5l4 4L19 6",
  verify: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20 M8 12l3 3 5-6",
  forward: "M5 12h14 M13 6l6 6-6 6",
  back: "M19 12H5 M11 18l-6-6 6-6",
  chevron: "m9 6 6 6-6 6",
  down: "m6 9 6 6 6-6",
  close: "m6 6 12 12 M18 6 6 18",
  reset: "M3 12a9 9 0 1 1 2.64 6.36 M3 4v8h8",
  play: "M8 5.5 19 12l-11 6.5z",
  search: "M10 17a7 7 0 1 0 0-14 7 7 0 0 0 0 14 M15 15l5 5",
  stack: "m12 2 9 5-9 5-9-5z M3 12l9 5 9-5 M3 17l9 5 9-5",
  file: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6 M8 13h8 M8 17h8",
  device: "M7 3h10a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z M9 8h6v4H9z M10 17h4",
  lock: "M5 10h14v11H5z M8 10V7a4 4 0 0 1 8 0v3 M12 14v3",
  alert: "M12 3 2 20h20z M12 9v4 M12 16h.01",
  copy: "M9 9h11v12H9z M15 6V3H4v12h3",
  bars: "M4 20v-5 M9 20v-9 M14 20V6 M19 20V3",
  list: "M8 6h12 M8 12h12 M8 18h12 M4 6h.01 M4 12h.01 M4 18h.01",
  link: "M10 13a4 4 0 0 0 5.7 0l3-3A4 4 0 0 0 13 4.3l-1 1 M14 11a4 4 0 0 0-5.7 0l-3 3A4 4 0 0 0 11 19.7l1-1",
  eye: "M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6",
  info: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20 M12 16v-4 M12 8h.01",
  clock: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20 M12 6v6l4 2",
} as const

export type IconName = keyof typeof paths

export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d={paths[name]} /></svg>
}

export function StatusBadge({ text, tone = "neutral" }: { text: string; tone?: Tone }) {
  return <span className={`badge badge--${tone}`}><i aria-hidden="true" />{text}</span>
}

export function IncidentBadge({ status }: { status: IncidentStatus }) {
  const [text, tone] = incidentPresentation[status]
  return <StatusBadge text={text} tone={tone} />
}

export function Time({ value, clock = false }: { value: string; clock?: boolean }) {
  return <time dateTime={value} title={value}>{formatTime(value, clock)}</time>
}

export function SectionHeader({ title, subtitle, action }: { title: string; subtitle?: string; action?: ReactNode }) {
  return <div className="section-heading"><div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div>{action}</div>
}

export function EmptyState({ icon = "stack", title, children, action }: {
  icon?: IconName; title: string; children: ReactNode; action?: ReactNode
}) {
  return <div className="empty-state">
    <span className="mini-icon"><Icon name={icon} size={21} /></span>
    <h3>{title}</h3><p>{children}</p>{action}
  </div>
}

export function InlineError({ problem, retry }: { problem: ApiProblem; retry?: () => void }) {
  const titles: Record<string, string> = {
    UNAUTHENTICATED: "Sign-in required", FORBIDDEN: "Action unavailable for this session",
    STALE_GENERATION: "The sandbox was reset", APPROVAL_CONFLICT: "Approval changed",
    APPROVAL_EXPIRED: "Approval expired", WORKFLOW_UNAVAILABLE: "Workflow unavailable",
    INJECTION_CONFLICT: "This scenario already ran", NOT_FOUND: "Record unavailable",
    CSRF_INVALID: "Session changed", INVALID_INPUT: "Check your input", INVALID_RESPONSE: "Unexpected API data",
    NETWORK: "Connection interrupted",
  }
  return <div className="inline-error" role="alert">
    <Icon name="alert" />
    <div><strong>{titles[problem.code] ?? "Something went wrong"}</strong><p>{problem.message}</p>
      {problem.requestId && <details><summary>Request details</summary><code>{problem.requestId}</code></details>}
    </div>
    {retry && <button className="button button--quiet" onClick={retry}>Try again</button>}
  </div>
}

export function Skeleton({ text = "Loading workspace…" }: { text?: string }) {
  return <div role="status" className="card loading-state"><span className="spinner" aria-hidden="true" />{text}</div>
}

export function Dialog({ title, children, onDismiss, busy = false, sheet = false }: {
  title: string; children: ReactNode; onDismiss: () => void; busy?: boolean; sheet?: boolean
}) {
  const id = useId()
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const dialog = ref.current
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    dialog?.showModal()
    return () => { dialog?.close(); if (previous?.isConnected) previous.focus({ preventScroll: true }) }
  }, [])
  return <dialog ref={ref} aria-labelledby={id} className={sheet ? "dialog dialog--sheet" : "dialog"}
    onCancel={(event) => { event.preventDefault(); if (!busy) onDismiss() }}>
    <div className="dialog-head">
      <h2 id={id}>{title}</h2>
      <button type="button" className="icon-button" onClick={onDismiss} disabled={busy} aria-label="Close dialog"><Icon name="close" /></button>
    </div>
    <div className="dialog-body">{children}</div>
  </dialog>
}

export function CopyId({ value }: { value: string }) {
  const status = useRef<HTMLSpanElement>(null)
  async function copy() {
    try { await navigator.clipboard.writeText(value); if (status.current) status.current.textContent = "Copied" }
    catch { if (status.current) status.current.textContent = "Select the ID to copy it." }
  }
  return <div className="copy-id"><code>{value}</code>
    <button className="icon-button" type="button" aria-label="Copy record ID" onClick={() => void copy()}><Icon name="copy" size={15}/></button>
    <span className="muted" ref={status} role="status" />
  </div>
}

export function EvidenceLinks({ ids, open }: { ids: string[]; open: (id: string) => void }) {
  if (!ids.length) return null
  return <details className="evidence-links">
    <summary><Icon name="link" size={14}/> {ids.length} evidence {ids.length === 1 ? "reference" : "references"}</summary>
    <ul>{ids.map((id) => <li key={id}><button className="text-button record-link" onClick={() => open(id)}>{id}</button></li>)}</ul>
  </details>
}

/** Small "i" that explains a function in plain words on hover or keyboard focus. */
export function Info({ text, pos = "bottom" }: { text: string; pos?: "top" | "bottom" }) {
  return <span className="info" tabIndex={0} role="note" aria-label={text} data-tip={text} data-tip-pos={pos}><Icon name="info" size={15}/></span>
}
