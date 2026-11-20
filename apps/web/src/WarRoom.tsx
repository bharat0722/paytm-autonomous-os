import { ProcessPlaybook } from "./Playbook.js"
import { RunsPanel } from "./Runs.js"
import { useMemo, useState, type ReactNode } from "react"
import type {
  ActionView, AuditEntry, DeviceCheck, EvidenceView, GroupingView, IncidentStatus, IncidentView, PlaybookView, RecoveryView, RunsView, TraceEntry,
} from "../../../shared/contracts/http.js"
import { CopyId, Dialog, EmptyState, Icon, IncidentBadge, Info, SectionHeader, StatusBadge, Time } from "./ui.js"
import { actorText, plainRule, plainSignal, approvalPresentation, approvalsHref, incidentHref, incidentPresentation, label, modes, number, scenarios, traceSummary } from "./workspace.js"

const actionTitle: Record<ActionView["kind"], string> = {
  MOCK_SYNC_DEVICE_CONFIG: "Configuration sync", MOCK_RESTART_DEVICE: "Remote device restart", LINK_SUPPORT_TICKETS: "Link support tickets",
  RESEND_WEBHOOK: "Resend payment alert",
}
const actionState: Record<ActionView["status"], string> = {
  PROPOSED: "Proposed", RUNNING: "Running", SUCCEEDED: "Executed", PARTIAL: "Partially executed", FAILED: "Failed", BLOCKED: "Blocked",
}
const evidenceKinds: Record<EvidenceView["kind"], string> = {
  order: "Orders", pg_transaction: "Paytm transactions", webhook_attempt: "Payment alerts", payment_signal: "Payment observation",
  device: "Device", device_event: "Device event", ticket: "Support ticket", payment: "Payment", settlement: "Settlement", merchant: "Merchant",
}
const deviceCheck: Record<DeviceCheck["status"], string> = { PASS: "Passed", FAIL: "Failed", AWAITING: "Awaiting signal" }
const severityTone = { CRITICAL: "red", HIGH: "red", MEDIUM: "amber", LOW: "neutral" } as const

/** Fallback kind for IDs that are referenced but not returned in this view. */
const prefixKinds: [string, string][] = [
  ["obs_", "Device signal"], ["chk_", "Verification"], ["act_", "Action"], ["apr_", "Approval"], ["aud_", "Audit entry"], ["trc_", "Trace step"],
]

/** Anything an ID in this incident can point at, flattened for one detail sheet. */
type Ref = {
  id: string; kind: string; title: string; at: string | null
  facts: [string, string][]; record?: EvidenceView
}
type Tab = "overview" | "evidence" | "investigation" | "jobs" | "actions" | "audit"

function useReferences(data: IncidentView): Map<string, Ref> {
  return useMemo(() => {
    const refs = new Map<string, Ref>()
    const put = (ref: Ref) => { if (!refs.has(ref.id)) refs.set(ref.id, ref) }
    for (const r of data.evidence) put({
      id: r.id, kind: evidenceKinds[r.kind], title: r.title, at: r.occurredAt, record: r,
      facts: Object.entries(r.details).map(([k, v]) => [label(k), v == null ? "—" : String(v)]),
    })
    for (const s of data.signals) put({
      id: s.id, kind: "Device signal", title: `${s.deviceId} · ${label(s.kind)} ${s.passed ? "passed" : "failed"}`, at: s.occurredAt,
      facts: [["Device", s.deviceId], ["Signal", label(s.kind)], ["Result", s.passed ? "Passed" : "Failed"], ["Sequence", String(s.sequence)],
        ...(s.actionId ? [["After action", s.actionId] as [string, string]] : [])],
    })
    for (const a of data.workflow.actions) put({
      id: a.id, kind: "Action", title: actionTitle[a.kind], at: null,
      facts: [["Status", actionState[a.status]], ["Rule that allowed it", plainRule(a.ruleId)], ["Targets", String(a.targetIds.length)], ["Summary", a.summary]],
    })
    for (const p of data.workflow.approvals) put({
      id: p.id, kind: "Approval", title: `Restart approval · ${approvalPresentation[p.status][0]}`, at: p.createdAt,
      facts: [["Status", approvalPresentation[p.status][0]], ["Devices", p.targetDeviceIds.join(", ")], ["Rule", plainRule(p.ruleId)],
        ["Decided by", p.decidedBy ?? "—"], ["Reason", p.reason ?? "—"], ["Expected check", p.expectedCheck]],
    })
    for (const e of data.workflow.audit) put({
      id: e.id, kind: "Audit entry", title: label(e.event), at: e.at,
      facts: [["Actor", e.actor], ["Summary", e.summary], ...(e.actionId ? [["Action", e.actionId] as [string, string]] : []),
        ...(e.approvalId ? [["Approval", e.approvalId] as [string, string]] : [])],
    })
    for (const t of data.workflow.trace) put({
      id: t.id, kind: "Trace step", title: label(t.stage), at: t.at,
      facts: [["Engine", modes[t.mode][0]], ["Summary", traceSummary(t.summary)], ],
    })
    const rec = data.workflow.recovery
    if (rec) put({
      id: rec.id, kind: "Verification", title: `${rec.recovered} of ${rec.total} verified`, at: rec.checkedAt,
      facts: [["Recovered", `${rec.recovered} / ${rec.total}`], ["Previous check", `${rec.beforeRecovered} / ${rec.total}`],
        ["Still failing", rec.remainingDeviceIds.join(", ") || "None"]],
    })
    return refs
  }, [data])
}

function RefChips({ ids, refs, open }: { ids: string[]; refs: Map<string, Ref>; open: (id: string) => void }) {
  const [all, setAll] = useState(false)
  if (!ids.length) return null
  const shown = all ? ids : ids.slice(0, 6)
  return <ul className="ref-chips" aria-label="Linked references">
    {shown.map((id) => {
      const ref = refs.get(id)
      if (!ref) {
        const kind = prefixKinds.find(([p]) => id.startsWith(p))?.[1] ?? "Reference"
        return <li key={id}><span className="ref-chip ref-chip--muted" title="Recorded in the workflow; details are not part of this view">{kind} <code>{id}</code></span></li>
      }
      return <li key={id}><button className="ref-chip" title={ref.title} onClick={() => open(id)}><span>{ref.kind}</span> {ref.title ? (ref.title.length > 40 ? ref.title.slice(0, 39) + "…" : ref.title) : "record"}</button></li>
    })}
    {ids.length > 6 && <li><button className="ref-chip ref-chip--muted" aria-expanded={all} onClick={() => setAll(!all)}>{all ? "Show fewer" : `+${ids.length - 6} more`}</button></li>}
  </ul>
}

function RecoveryProgress({ recovery, closed }: { recovery: RecoveryView; closed: boolean }) {
  const remaining = recovery.remainingDeviceIds.length
  const ratio = recovery.total ? Math.min(100, recovery.recovered / recovery.total * 100) : 0
  return <section className={`recovery-band${closed ? " recovery-band--resolved" : ""}`} aria-label="Verified device recovery">
    <div className="recovery-number">
      <div className="recovery-label"><Icon name="verify" size={18}/> Verified recovery</div>
      <strong data-testid="recovery-count" aria-label={`${recovery.recovered} of ${recovery.total} devices verified recovered`}>{recovery.recovered} <span>/ {recovery.total}</span></strong>
      <div className="recovery-track" role="progressbar" aria-label="Devices verified recovered" aria-valuenow={recovery.recovered}
        aria-valuemin={0} aria-valuemax={Math.max(1, recovery.total)}><span style={{ width: `${ratio}%` }}/></div>
    </div>
    <div className="recovery-info">
      <div><strong>{remaining === 0 ? "All device checks passed" : `${remaining} ${remaining === 1 ? "device" : "devices"} still need attention`}</strong>
      <p>Previous check {recovery.beforeRecovered} / {recovery.total} · Last verified <Time value={recovery.checkedAt} clock/></p></div>
      {remaining > 0 && <details><summary>Remaining device IDs</summary><ul className="code-list">{recovery.remainingDeviceIds.map((id) => <li key={id}><code>{id}</code></li>)}</ul></details>}
    </div>
  </section>
}

function GroupingPanel({ grouping, openMerchant }: { grouping: GroupingView; openMerchant: (id: string) => void }) {
  const excluded = grouping.excluded.reduce((n, e) => n + e.count, 0)
  return <section className="card grouping" aria-label="Why these were grouped">
    <SectionHeader title="Why these were grouped" subtitle="Rule-based correlation from stored records: a lead, not a proven cause"/>
    <ul className="grouping-signals" data-testid="grouping-signals">{grouping.signals.map((s) => <li key={s.label}><span>{s.label}</span><strong>{plainSignal(s.value)}</strong></li>)}</ul>
    <dl className="fact-list grouping-facts">
      <div><dt>Grouped</dt><dd data-testid="grouping-counts">{grouping.counts.records} records · {grouping.counts.merchants} merchants{grouping.counts.devices ? ` · ${grouping.counts.devices} devices` : ""}</dd></div>
      <div><dt>Rule</dt><dd>{grouping.rule}</dd></div>
      {grouping.window && <div><dt>Time window</dt><dd><Time value={grouping.window.start} clock/> – <Time value={grouping.window.end} clock/>{grouping.windowMinutes ? ` (limit ${grouping.windowMinutes} min)` : ""}</dd></div>}
      <div><dt>Kept separate</dt><dd data-testid="grouping-excluded">{excluded ? `${excluded} unrelated record(s)` : "None"}</dd></div>
    </dl>
    {grouping.excluded.length > 0 && <details><summary>Why other records were not merged</summary>
      <ul>{grouping.excluded.map((e, i) => <li key={i}>{plainSignal(e.key)}: {e.reason} ({e.count})</li>)}</ul></details>}
    {grouping.outreach && <div className="outreach" data-testid="outreach">
      <div><strong>{grouping.outreach.complainedMerchants}</strong><span>merchants complained</span></div>
      <div className="outreach-silent"><strong>{grouping.outreach.silentMerchants}</strong><span>affected but silent</span></div>
      <p>Silent merchants are affected but have not raised a ticket. They can be told proactively before they call support.</p>
      {grouping.outreach.silentMerchantIds.length > 0 && <details><summary>Silent merchants</summary>
        <ul className="code-list">{grouping.outreach.silentMerchantIds.map((id) => <li key={id}><button className="text-button record-link" onClick={() => openMerchant(id)}>{id}</button></li>)}</ul></details>}
    </div>}
    <p className="muted small-note">{grouping.note}</p>
  </section>
}

/** Merchant 360 inside the detail sheet: everything in this incident linked to one merchant. */
function MerchantRecords({ merchantId, records, open }: { merchantId: string; records: EvidenceView[]; open: (id: string) => void }) {
  const devices = records.filter((r) => r.kind === "device" && r.details.merchantId === merchantId)
  const deviceIds = new Set(devices.map((d) => d.id))
  const related = records.filter((r) => r.id !== merchantId && (r.details.merchantId === merchantId || (r.kind === "device_event" && deviceIds.has(String(r.details.deviceId)))))
  if (!related.length) return <p className="muted">No other records in this incident reference this merchant.</p>
  return <div className="merchant-360" data-testid="merchant-360"><h3>Linked records for this merchant</h3>
    <ul className="record-list">{related.map((r) => <li key={r.id}><button onClick={() => open(r.id)}>
      <Icon name="file" size={16}/><span><strong>{r.title}</strong><small>{evidenceKinds[r.kind]}{r.occurredAt ? " · " : ""}{r.occurredAt && <Time value={r.occurredAt}/>}</small></span><Icon name="chevron" size={15}/>
    </button></li>)}</ul></div>
}

/** The order a reviewer follows to check one case, and what each tab shows and asks of them. */
const REVIEW: Record<Tab, { name: string; shows: string; doThis: string }> = {
  overview: { name: "Overview", shows: "The summary: what broke, which monitor caught it, who is affected, and the AI's one-line diagnosis.", doThis: "Read the header and what the monitor found." },
  evidence: { name: "Evidence", shows: "The raw records behind the diagnosis. Every AI claim links to evidence, so nothing is invented.", doThis: "Click any ID to open the record." },
  investigation: { name: "Process", shows: "How the fix was automated, step by step, with every system call saved: what we sent and what came back.", doThis: "Open a step to see the proof." },
  jobs: { name: "Jobs and runs", shows: "The automation machinery: the monitor that caught it, background jobs with IDs, AI runs, and safety limits.", doThis: "Check the job finished." },
  actions: { name: "Actions & approvals", shows: "Every fix the AI ran, the written rule that allowed it, and any human sign-off. This is the control layer.", doThis: "Check each action has a rule." },
  audit: { name: "Audit log", shows: "The permanent record for compliance: who did what, and when.", doThis: "Confirm who approved and when." },
}
const ORDER: Tab[] = ["overview", "evidence", "investigation", "jobs", "actions", "audit"]

function ReviewStrip({ tab, setTab }: { tab: Tab; setTab: (t: Tab) => void }) {
  const [hidden, setHidden] = useState(() => { try { return localStorage.getItem("mros.review.hidden") === "1" } catch { return false } })
  const i = ORDER.indexOf(tab)
  const prev = ORDER[i - 1]
  const next = ORDER[i + 1]
  function toggle(h: boolean) { setHidden(h); try { localStorage.setItem("mros.review.hidden", h ? "1" : "0") } catch { /* ignore */ } }
  if (hidden) return <button className="text-button review-show" onClick={() => toggle(false)}>Show review steps</button>
  return <section className="review-strip" aria-label="Review guide">
    <span className="review-step">Step {i + 1} of {ORDER.length}</span>
    <span className="review-line"><strong>{REVIEW[tab].name}</strong> · {REVIEW[tab].doThis}</span>
    <span className="review-nav">
      {prev && <button className="button button--quiet button--small" onClick={() => setTab(prev)}>← {REVIEW[prev].name}</button>}
      {next ? <button className="button button--primary button--small" onClick={() => setTab(next)}>{REVIEW[next].name} →</button> : <span className="muted">Review complete</span>}
      <button className="text-button" onClick={() => toggle(true)} data-tip="Hide the step guide." data-tip-pos="bottom-end">Hide</button>
    </span>
  </section>
}

/** The headline of the product: how the fix was automated, in four beats. */
function AutomatedFix({ data }: { data: IncidentView }) {
  const { incident, workflow, profile, evidence } = data
  const action = workflow.actions[0]
  const needed = workflow.approvals.length > 0 || workflow.actions.some((a) => a.ruleId.includes("REQUIRES_APPROVAL"))
  const approved = workflow.approvals.some((a) => ["APPROVED", "CONSUMED"].includes(a.status))
  const proof = workflow.recovery
  const closed = ["RESOLVED", "TASK_COMPLETED"].includes(incident.status)
  const escalated = incident.status === "ESCALATED"
  const title = action ? actionTitle[action.kind] : incident.scenario === "settlement-discrepancy" ? "Evidence packet (no money moved)" : "No safe fix found"
  const beats: [string, string, string][] = [
    ["1", "Spotted", `${profile?.detectedBy.jobName ?? "Monitor"} grouped ${number.format(incident.affectedMerchantCount)} merchants into one case`],
    ["2", "Checked", `${number.format(evidence.length)} records read by the AI. Read-only.`],
    ["3", needed ? (approved ? "Fixed, human approved" : "Fix needs approval") : "Fixed automatically", action ? `${title} · ${action.targetIds.length} targets` : title],
    ["4", closed ? "Proven" : escalated ? "Handed over" : "Proving", proof ? `${proof.recovered} of ${proof.total} verified from fresh evidence` : escalated ? `Now with ${incident.owner ?? "a person"}` : "Waiting for the final check"],
  ]
  const tone = closed ? "green" : escalated ? "amber" : "blue"
  return <section className={`autofix autofix--${tone}`} aria-label="How the fix was automated">
    <div className="autofix-head"><h2>How the fix was automated</h2>
      <span className="autofix-chip" data-tip="Autonomy with a control layer: the AI acts alone only where a written rule allows it; anything risky waits for a person." data-tip-pos="bottom-end">{needed ? "Human in the loop" : "No human needed"}</span></div>
    <ol className="autofix-flow">{beats.map(([n, name, text], i) => <li key={n} className={i === 3 ? "last" : ""}>
      <span className="autofix-n">{n}</span><strong>{name}</strong><p>{text}</p></li>)}</ol>
  </section>
}

/** Which job found what: record counts by type and the tickets involved, in plain words. */
function FoundByJob({ data, open }: { data: IncidentView; open: (id: string) => void }) {
  const [all, setAll] = useState(false)
  const { profile, evidence } = data
  const names = new Map(evidence.filter((e) => e.kind === "merchant").map((e) => [e.id, e.title]))
  const counts = new Map<string, number>()
  for (const e of evidence) counts.set(e.kind, (counts.get(e.kind) ?? 0) + 1)
  const words: Record<string, string> = { ticket: "tickets", settlement: "settlements", merchant: "merchants", device: "devices", device_event: "device events", payment: "payments", order: "orders", pg_transaction: "Paytm transactions", webhook_attempt: "payment alerts" }
  const tickets = evidence.filter((e) => e.kind === "ticket")
  const shown = all ? tickets : tickets.slice(0, 5)
  if (!profile) return null
  return <section className="card found-by">
    <SectionHeader title={`What ${profile.detectedBy.jobName} found`} subtitle={`Job ID ${profile.detectedBy.jobId}`}
      action={<Info text="The monitor ran on its schedule, grouped related records and opened this incident."/>}/>
    <p className="found-counts">{[...counts].filter(([k]) => words[k]).map(([k, n]) => `${n} ${words[k]}`).join(" · ")}</p>
    {tickets.length > 0 ? <div className="table-wrap"><table><thead><tr><th scope="col">Ticket</th><th scope="col">Merchant</th><th scope="col">What they reported</th><th scope="col">Status</th></tr></thead>
      <tbody>{shown.map((e) => <tr key={e.id}>
        <td><button className="text-button record-link" onClick={() => open(e.id)} title="Open the full record">Ticket {tickets.indexOf(e) + 1}</button></td>
        <td>{names.get(String(e.details.merchantId)) ?? "—"}</td><td>{e.title}</td><td>{String(e.details.status ?? "—")}</td></tr>)}</tbody></table>
      {tickets.length > 5 && <button className="text-button" onClick={() => setAll(!all)}>{all ? "Show fewer tickets" : `Show all ${tickets.length} tickets`}</button>}</div>
      : <p className="muted">No support tickets are linked to this incident.</p>}
  </section>
}

function aiEngine(trace: TraceEntry[]): [string, "green" | "amber" | "neutral"] {
  if (trace.some((t) => t.mode === "live_ai")) return ["Sarvam AI", "green"]
  if (trace.some((t) => t.mode === "scripted_fallback")) return ["Backup script (fixed steps)", "amber"]
  return ["System", "neutral"]
}

function EvidenceTab({ data, refs, open }: { data: IncidentView; refs: Map<string, Ref>; open: (id: string) => void }) {
  const [kind, setKind] = useState("all")
  const [query, setQuery] = useState("")
  const [sort, setSort] = useState<"time" | "kind">("time")
  const rows = useMemo(() => {
    const all = [...data.evidence.map((r) => refs.get(r.id)!), ...data.signals.map((s) => refs.get(s.id)!)].filter(Boolean)
    const term = query.trim().toLowerCase()
    return all.filter((r) => (kind === "all" || r.kind === kind) && (!term || `${r.id} ${r.title}`.toLowerCase().includes(term)))
      .sort((a, b) => sort === "kind" ? a.kind.localeCompare(b.kind) || (b.at ?? "").localeCompare(a.at ?? "") : (b.at ?? "").localeCompare(a.at ?? ""))
  }, [data, refs, kind, query, sort])
  const kinds = useMemo(() => {
    const counts = new Map<string, number>()
    for (const r of [...data.evidence.map((e) => evidenceKinds[e.kind]), ...data.signals.map(() => "Device signal")]) counts.set(r, (counts.get(r) ?? 0) + 1)
    return [...counts].sort(([a], [b]) => a.localeCompare(b))
  }, [data])
  return <section className="card" aria-label="Evidence">
    <SectionHeader title="Evidence" subtitle="Every stored record and device signal tied to this incident"
      action={<span className="count-pill">{number.format(rows.length)} shown</span>}/>
    <div className="list-controls">
      <label className="search-field"><Icon name="search" size={16}/><input type="search" aria-label="Search evidence" placeholder="Search ID or title…" value={query} onChange={(e) => setQuery(e.target.value)}/></label>
      <label className="sr-only" htmlFor="evidence-kind">Evidence type</label>
      <select id="evidence-kind" value={kind} onChange={(e) => setKind(e.target.value)}>
        <option value="all">All types</option>{kinds.map(([k, n]) => <option key={k} value={k}>{k} ({n})</option>)}
      </select>
      <label className="sr-only" htmlFor="evidence-sort">Sort</label>
      <select id="evidence-sort" value={sort} onChange={(e) => setSort(e.target.value as "time" | "kind")}>
        <option value="time">Newest first</option><option value="kind">By type</option>
      </select>
    </div>
    {rows.length === 0 ? <EmptyState icon="search" title="No evidence matches">Change the search or type filter.</EmptyState> :
      <div className="table-wrap"><table className="data-table">
        <thead><tr><th scope="col">Type</th><th scope="col">Record</th><th scope="col">ID</th><th scope="col">Time</th></tr></thead>
        <tbody>{rows.map((r) => <tr key={r.id} className="clickable" onClick={() => open(r.id)}>
          <td><span className="type-cell">{r.kind}</span></td>
          <td><button className="text-button" onClick={(e) => { e.stopPropagation(); open(r.id) }}>{r.title}</button></td>
          <td><code>{r.id}</code></td>
          <td>{r.at ? <Time value={r.at}/> : "—"}</td>
        </tr>)}</tbody>
      </table></div>}
  </section>
}

function InvestigationTab({ entries, refs, open }: { entries: TraceEntry[]; refs: Map<string, Ref>; open: (id: string) => void }) {
  return <section className="card worklog" aria-label="Investigation trace">
    <SectionHeader title="How this incident was traced" subtitle="Every step from detection to verification, oldest first"/>
    {!entries.length ? <EmptyState icon="list" title="No steps yet">Steps appear as the investigation runs.</EmptyState> :
      <ol className="trace-steps">{entries.map((entry, index) => {
        const [mode, tone] = modes[entry.mode]
        return <li key={entry.id}>
          <span className="trace-index">{index + 1}</span>
          <div className="trace-body">
            <div className="step-meta"><strong>{label(entry.stage)}</strong><StatusBadge text={mode} tone={tone}/><span className="muted"><Time value={entry.at} clock/></span></div>
            <p>{traceSummary(entry.summary)}</p>
            <RefChips ids={entry.evidenceIds} refs={refs} open={open}/>
          </div>
        </li>
      })}</ol>}
  </section>
}

function ActionsTab({ data, refs, open, closed }: { data: IncidentView; refs: Map<string, Ref>; open: (id: string) => void; closed: boolean }) {
  const [checks, setChecks] = useState(false)
  const { actions, approvals, recovery } = data.workflow
  return <div className="section-stack">
    <section className="card" aria-label="Actions">
      <SectionHeader title="Actions" subtitle="Every action proposed or executed, with the policy rule that allowed it"/>
      {actions.length === 0 ? <p className="muted">No actions recorded.</p> : <div className="table-wrap"><table className="data-table">
        <thead><tr><th scope="col">Action</th><th scope="col">Status</th><th scope="col" className="num">Targets</th><th scope="col">Policy rule</th><th scope="col">Summary</th></tr></thead>
        <tbody>{actions.map((a) => <tr key={a.id}>
          <td><button className="text-button" onClick={() => open(a.id)}><strong>{actionTitle[a.kind]}</strong></button></td>
          <td><StatusBadge text={actionState[a.status]} tone={a.status === "FAILED" || a.status === "BLOCKED" ? "red" : a.status === "SUCCEEDED" ? "green" : "neutral"}/></td>
          <td className="num">{a.targetIds.length}</td>
          <td>{plainRule(a.ruleId)}</td>
          <td>{a.summary}</td>
        </tr>)}</tbody>
      </table></div>}
    </section>
    <section className="card" aria-label="Approvals for this incident">
      <SectionHeader title="Approvals" subtitle="Restricted actions need a human decision before they run"/>
      {approvals.length === 0 ? <p className="muted">No approval was needed.</p> : <ul className="approval-cards">{approvals.map((p) => {
        const [text, tone] = approvalPresentation[p.status]
        return <li key={p.id}>
          <div className="type-head"><strong>Remote device restart · {p.targetDeviceIds.length} devices</strong><StatusBadge text={text} tone={tone}/></div>
          <dl className="type-facts">
            <div><dt>Requested</dt><dd><Time value={p.createdAt}/></dd></div>
            <div><dt>Decided by</dt><dd>{p.decidedBy ?? "—"}</dd></div>
            <div><dt>Expected check</dt><dd>{p.expectedCheck}</dd></div>
          </dl>
          {p.reason && <p>Reason: {p.reason}</p>}
          <RefChips ids={p.evidenceIds} refs={refs} open={open}/>
          {p.status === "PENDING" && <a className="button button--secondary button--small" href={approvalsHref(p.id)}>Review approval <Icon name="forward" size={14}/></a>}
        </li>
      })}</ul>}
    </section>
    {recovery && data.incident.scenario === "soundbox" && <section className="card device-checks">
      <SectionHeader title="Device checks" subtitle={`Per-device results from the latest verification${closed ? "" : " (in progress)"}`}
        action={<button className="button button--quiet" aria-expanded={checks} onClick={() => setChecks(!checks)}>{checks ? "Hide device checks" : "View device checks"}</button>}/>
      {checks && <div className="table-wrap"><table className="data-table"><thead><tr><th scope="col">Device ID</th><th scope="col">Result</th><th scope="col">Check detail</th></tr></thead>
        <tbody>{recovery.devices.map((device) => <tr key={device.deviceId}>
          <td><code>{device.deviceId}</code></td>
          <td><StatusBadge text={deviceCheck[device.status]} tone={device.status === "PASS" ? "green" : device.status === "FAIL" ? "red" : "amber"}/></td>
          <td>{device.reason}<RefChips ids={device.evidenceIds} refs={refs} open={open}/></td>
        </tr>)}</tbody>
      </table></div>}
    </section>}
  </div>
}

function AuditTab({ entries, refs, open }: { entries: AuditEntry[]; refs: Map<string, Ref>; open: (id: string) => void }) {
  return <section className="card" aria-label="Audit log">
    <SectionHeader title="Audit log" subtitle="Durable record of who or what did each step"/>
    {!entries.length ? <p className="muted">No audit entries yet.</p> : <div className="table-wrap"><table className="data-table audit-table">
      <thead><tr><th scope="col">Time</th><th scope="col">Event</th><th scope="col">Actor</th><th scope="col">Detail</th></tr></thead>
      <tbody>{entries.map((e) => <tr key={e.id}>
        <td><Time value={e.at}/></td>
        <td><strong>{label(e.event)}</strong></td>
        <td>{actorText(e.actor)}</td>
        <td>{e.summary}<RefChips ids={[...(e.actionId ? [e.actionId] : []), ...(e.approvalId ? [e.approvalId] : []), ...e.evidenceIds]} refs={refs} open={open}/></td>
      </tr>)}</tbody>
    </table></div>}
  </section>
}

export function WarRoom({ data, playbook, runs, deepEvidence, canResume, resuming, resume }: {
  data: IncidentView; playbook?: PlaybookView; runs?: RunsView; deepEvidence?: string; canResume: boolean; resuming: boolean; resume: () => void
}) {
  const { incident, blocker, owner, workflow, grouping, profile } = data
  const refs = useReferences(data)
  const [engineName, engineTone] = aiEngine(workflow.trace)
  const [refId, setRef] = useState<string>()
  const [tab, setTab] = useState<Tab>("overview")
  const selectedId = refId ?? deepEvidence
  const selected = selectedId ? refs.get(selectedId) : undefined
  const pending = workflow.approvals.find(({ status }) => status === "PENDING")
  const paymentConfirmation = incident.scenario === "payment-confirmation"
  const recovery = incident.scenario === "soundbox" ? workflow.recovery : null
  const ticketChecks = incident.scenario === "duplicate-tickets" ? workflow.recovery : null
  const orderChecks = incident.scenario === "order-unpaid" ? workflow.recovery : null
  const proof = recovery ?? orderChecks
  const inconsistent = incident.status === "RESOLVED" && (!proof || proof.total === 0 ||
    proof.recovered !== proof.total || proof.remainingDeviceIds.length > 0 ||
    proof.devices.length !== proof.total || proof.devices.some(({ status }) => status !== "PASS"))
  const closed = incident.status === "RESOLVED" && !inconsistent

  function closeSheet() {
    setRef(undefined)
    if (deepEvidence) location.replace(incidentHref(incident.id))
  }

  const tabs: [Tab, string, number | null][] = [
    ["overview", "Overview", null],
    ["evidence", "Evidence", data.evidence.length + data.signals.length],
    ["investigation", "Process", playbook ? playbook.steps.reduce((n, s) => n + s.entries.length, 0) : null],
    ["jobs", "Jobs and runs", runs ? runs.jobs.length : null],
    ["actions", "Actions & approvals", workflow.actions.length + workflow.approvals.length],
    ["audit", "Audit log", workflow.audit.length],
  ]

  return <>
    <p className="sr-only" role="status">
      {inconsistent ? "Verification needs review" : incidentPresentation[incident.status][0]}
      {recovery && !inconsistent && `. ${recovery.recovered} of ${recovery.total} devices verified recovered.`}
    </p>
    <header className="incident-header">
      <a className="back-link" href={incidentHref()}><Icon name="back" size={15}/> All incidents</a>
      <div className="incident-title-row">
        <div>
          <p className="incident-id">{profile?.displayId ?? incident.displayId ?? incident.id} · {profile?.typeLabel ?? scenarios[incident.scenario]}</p>
          <h1>{incident.title}</h1>
        </div>
        <div className="chip-row">
          {inconsistent ? <StatusBadge text="Verification needs review" tone="red"/> : <span data-testid="incident-status"><IncidentBadge status={incident.status}/></span>}
          <StatusBadge text={`${label(incident.severity)} severity`} tone={severityTone[incident.severity]}/>
          {canResume && <button className="button button--quiet button--small" onClick={resume} disabled={resuming} data-tip="Ask the AI to try this case again. It picks up where it stopped." data-tip-pos="bottom-end">{resuming ? "Queuing…" : "Resume investigation"}</button>}
        </div>
      </div>
      {profile && <p className="incident-description">{profile.description}</p>}
      <dl className="incident-facts">
        {profile && <div><dt>Detected by job</dt><dd data-tip="The scheduled monitor that caught this on its own. In production it runs continuously, so problems are found before merchants call." data-tip-pos="bottom">{profile.detectedBy.jobName}<small>Job ID <code>{profile.detectedBy.jobId}</code></small><small>{profile.detectedBy.scheduleLabel}</small></dd></div>}
        <div><dt>Detected at</dt><dd>{profile ? <Time value={profile.detectedBy.ranAt}/> : incident.detectedAt ? <Time value={incident.detectedAt}/> : "—"}</dd></div>
        {profile && <div><dt>Threshold</dt><dd>{profile.threshold}</dd></div>}
        <div><dt>Impact</dt><dd>{number.format(incident.affectedMerchantCount)} merchants{incident.affectedDeviceCount > 0 && <small>{number.format(incident.affectedDeviceCount)} devices</small>}</dd></div>
        <div><dt>Zone</dt><dd>{profile?.zone ?? incident.zone ?? "—"}</dd></div>
        <div><dt>Owner</dt><dd>{owner ?? incident.owner ?? "AI teammate"}<small>Updated <Time value={incident.updatedAt}/></small></dd></div>
      </dl>
    </header>

    <div className="tabs" role="tablist" aria-label="Incident sections">
      {tabs.map(([key, name, count]) => <button key={key} role="tab" id={`tab-${key}`} aria-selected={tab === key} aria-controls={`panel-${key}`}
        className={tab === key ? "tab tab--active" : "tab"} onClick={() => setTab(key)}
        data-tip={REVIEW[key].shows} data-tip-pos="top"><span className="tab-n">{ORDER.indexOf(key) + 1}</span>{name}{count !== null && <span className="tab-count">{count}</span>}</button>)}
    </div>

    <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} className="tab-panel">
      <ReviewStrip tab={tab} setTab={setTab}/>
      {tab === "overview" && <>
        {inconsistent && <div role="alert" className="callout callout--red"><Icon name="alert"/><div><strong>Recovery could not be confirmed</strong><p>The latest stored verification is incomplete.</p></div></div>}
        {pending && <div className="callout callout--amber"><Icon name="shield"/><div><strong>Human approval required</strong>
          <p>{pending.targetDeviceIds.length} {pending.targetDeviceIds.length === 1 ? "device needs" : "devices need"} a remote restart before recovery can complete.</p></div>
          <a className="button button--secondary" href={approvalsHref(pending.id)} data-tip="Risky fixes wait for a person. Open the sign-off screen. Only the Approver role can decide." data-tip-pos="bottom-end">Review approval <Icon name="forward" size={15}/></a></div>}
        {!pending && (blocker || owner) && <div className="callout"><Icon name="alert"/><div><strong>{owner ? `Assigned to ${owner}` : "Investigation note"}</strong>{blocker && <p>{blocker}</p>}</div></div>}
        {paymentConfirmation ? <section className="card" aria-label="Payment and order evidence">
          <SectionHeader title="Payment and order evidence" subtitle="Sandbox records used to route this incident"/>
          <ul className="ref-chips">{data.evidence.filter(record => record.kind === "payment_signal").map(record =>
            <li key={record.id}><button className="ref-chip" onClick={() => setRef(record.id)}>{record.title}</button></li>)}</ul>
        </section> : recovery ? <RecoveryProgress recovery={recovery} closed={closed}/> :
          <section className="card outcome-placeholder"><Icon name={incident.scenario === "soundbox" ? "verify" : "stack"}/>
            <div><h2>{incident.scenario === "soundbox" ? "Awaiting verification" : incident.scenario === "order-unpaid" ? "Merchant order status" : incident.scenario === "duplicate-tickets" ? "Ticket linkage" : "Read-only settlement handoff"}</h2>
            <p>{orderChecks ? <><strong data-testid="order-check-count">{orderChecks.recovered} / {orderChecks.total} orders verified PAID</strong> · Checked <Time value={orderChecks.checkedAt}/></> : incident.scenario === "order-unpaid" ? "After the payment alert is resent, each order is read back from the merchant side." : ticketChecks ? <><strong data-testid="ticket-check-count">{ticketChecks.recovered} / {ticketChecks.total} ticket links verified</strong> · Checked <Time value={ticketChecks.checkedAt}/></> :
              incident.scenario === "soundbox" ? "Recovery appears after the first completed device check." :
                incident.scenario === "duplicate-tickets" ? "Links saved between support tickets are verified after they are written." : "The discrepancy is recorded and assigned to a person for review. No money is moved."}</p></div>
          </section>}
        <FoundByJob data={data} open={setRef}/>
        <div className="overview-grid">
          {!paymentConfirmation && <section className="card findings">
            <SectionHeader title="What the AI found" subtitle="Findings from the investigator, with their supporting records"
              action={<span data-testid="ai-engine"><StatusBadge text={engineName} tone={engineTone}/></span>}/>
            {!workflow.finding ? <EmptyState icon="search" title="Findings are pending">The investigator publishes a summary when it has supporting records.</EmptyState> :
              <div className="finding-content">
                {workflow.finding.hypothesis && <div className="hypothesis"><h3>Working hypothesis</h3><p>{workflow.finding.hypothesis}</p></div>}
                {!!workflow.finding.observations.length && <><h3>Observed facts</h3><ul>{workflow.finding.observations.map((entry, index) => <li key={index}>{entry}</li>)}</ul></>}
                {workflow.finding.uncertainty && <div className="finding-note"><h3>Uncertainty</h3><p>{workflow.finding.uncertainty}</p></div>}
                {!!workflow.finding.missingEvidence.length && <details><summary>Missing evidence</summary><ul>{workflow.finding.missingEvidence.map((line, index) => <li key={index}>{line}</li>)}</ul></details>}
                <h3>Supporting records</h3>
                <RefChips ids={workflow.finding.evidenceIds} refs={refs} open={setRef}/>
              </div>}
          </section>}
          {grouping && <GroupingPanel grouping={grouping} openMerchant={setRef}/>}
        </div>
      </>}
      {tab === "evidence" && <EvidenceTab data={data} refs={refs} open={setRef}/>}
      {tab === "investigation" && <div className="section-stack">
        <AutomatedFix data={data}/>
        {playbook ? <ProcessPlaybook view={playbook} openEvidence={setRef}/> : <div className="card"><EmptyState icon="list" title="Loading the process…">The steps appear here.</EmptyState></div>}
      </div>}
      {tab === "jobs" && <RunsPanel view={runs}/>}
      {tab === "actions" && <ActionsTab data={data} refs={refs} open={setRef} closed={closed}/>}
      {tab === "audit" && <AuditTab entries={workflow.audit} refs={refs} open={setRef}/>}
    </div>

    {selectedId && <Dialog title={selected ? selected.kind : "Reference"} onDismiss={closeSheet} sheet>
      <CopyId value={selectedId}/>
      {selected ? <><h3 className="sheet-title">{selected.title}</h3>{selected.at && <p className="muted"><Time value={selected.at}/></p>}
        <dl className="fact-list">{selected.facts.map(([k, v]) => <div key={k}><dt>{k}</dt>
          <dd>{refs.has(v) && v !== selected.id ? <button className="text-button record-link" onClick={() => setRef(v)}>{v}</button> : v}</dd></div>)}</dl>
        {selected.record?.kind === "merchant" && <MerchantRecords merchantId={selected.id} records={data.evidence} open={setRef}/>}
        {selected.record && selected.record.kind !== "merchant" && typeof selected.record.details.merchantId === "string" &&
          <button className="button button--quiet" onClick={() => setRef(String(selected.record!.details.merchantId))}>Open merchant view</button>}</> :
        <p className="muted">This ID is recorded in the workflow, but its details are not part of this incident view.</p>}
    </Dialog>}
  </>
}
