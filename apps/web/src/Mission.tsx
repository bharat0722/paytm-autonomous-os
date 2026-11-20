import { useMemo, useState } from "react"
import type { DashboardView, DetectionJobView, DetectionJobsView, IncidentCard, MetricsView } from "../../../shared/contracts/http.js"
import { EmptyState, Icon, IncidentBadge, SectionHeader, StatusBadge, Time, type IconName } from "./ui.js"
import { incidentHref, isActive, label, modes, number, traceSummary } from "./workspace.js"

const severityRank = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 } as const
const severityTone = { CRITICAL: "red", HIGH: "red", MEDIUM: "amber", LOW: "neutral" } as const

const kpis = [
  { key: "activeIncidents", title: "Open incidents", icon: "incident", hint: "Not yet verified or closed" },
  { key: "affectedMerchants", title: "Merchants impacted now", icon: "users", hint: "From the latest verification" },
  { key: "verifiedResolved", title: "Resolved & verified", icon: "verify", hint: "Closed on fresh device signals" },
  { key: "pendingApprovals", title: "Awaiting approval", icon: "shield", hint: "Restricted actions on hold" },
] as const satisfies readonly { key: keyof DashboardView["kpis"]; title: string; icon: IconName; hint: string }[]

/** Open first, then by severity, then most recently updated. */
export function sortIncidents(items: IncidentCard[]): IncidentCard[] {
  return [...items].sort((a, b) =>
    Number(!isActive(a.status) && a.status !== "ESCALATED") - Number(!isActive(b.status) && b.status !== "ESCALATED")
    || severityRank[a.severity] - severityRank[b.severity]
    || b.updatedAt.localeCompare(a.updatedAt))
}

export function IncidentList({ incidents, picker = false }: { incidents: IncidentCard[]; picker?: boolean }) {
  const [query, setQuery] = useState("")
  const [status, setStatus] = useState("open")
  const [type, setType] = useState("all")
  const types = useMemo(() => [...new Set(incidents.map((i) => i.typeLabel ?? label(i.scenario)))].sort(), [incidents])
  const visible = useMemo(() => {
    const term = query.trim().toLowerCase()
    return sortIncidents(incidents).filter((item) => {
      const open = isActive(item.status) || item.status === "ESCALATED" || item.status === "INSUFFICIENT_EVIDENCE" || item.status === "FAILED"
      const statusOk = status === "all" || (status === "open" ? open : !open)
      const typeOk = type === "all" || (item.typeLabel ?? label(item.scenario)) === type
      return statusOk && typeOk && (!term || [item.title, item.displayId ?? item.id, item.typeLabel ?? "", item.zone ?? "", label(item.status)]
        .some((part) => part.toLowerCase().includes(term)))
    })
  }, [incidents, query, status, type])

  return <section className="card queue" aria-label="Incident queue">
    <SectionHeader title={picker ? "Choose an incident" : "Incident queue"} subtitle="Open incidents first, ordered by severity and latest update"
      action={incidents.length > 0 && <span className="count-pill">{number.format(visible.length)} of {number.format(incidents.length)}</span>}/>
    {incidents.length === 0 ? <EmptyState icon="incident" title="No incidents detected">
      Detection jobs raise incidents here when a threshold is crossed. Use <strong>Run now</strong> on a detection job to start one.
    </EmptyState> : <>
      <div className="list-controls">
        <label className="search-field"><Icon name="search" size={16}/><input type="search" aria-label="Search incidents" placeholder="Search ID, type, zone…"
          value={query} onChange={(event) => setQuery(event.target.value)}/></label>
        <label className="sr-only" htmlFor="incident-status-filter">Status</label>
        <select id="incident-status-filter" value={status} onChange={(event) => setStatus(event.target.value)}>
          <option value="open">Open</option><option value="closed">Closed</option><option value="all">All statuses</option>
        </select>
        <label className="sr-only" htmlFor="incident-type-filter">Incident type</label>
        <select id="incident-type-filter" value={type} onChange={(event) => setType(event.target.value)}>
          <option value="all">All types</option>{types.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
      </div>
      {visible.length === 0 ? <EmptyState icon="search" title="No incidents match these filters"
        action={<button className="button button--quiet" onClick={() => { setQuery(""); setStatus("all"); setType("all") }}>Show all incidents</button>}>
        Change the status or type filter.
      </EmptyState> : <div className="table-wrap"><table className="data-table queue-table">
        <thead><tr><th scope="col">Incident</th><th scope="col">Type</th><th scope="col">Severity</th><th scope="col">Status</th>
          <th scope="col" className="num">Impact</th><th scope="col">Detected</th><th scope="col">Owner</th></tr></thead>
        <tbody>{visible.map((i) => <tr key={i.id} className={`sev-${i.severity.toLowerCase()}`}>
          <td><a className="row-link" href={incidentHref(i.id)}><strong>{i.displayId ?? i.id}</strong><span>{i.title}</span></a></td>
          <td><span className="type-cell">{i.typeLabel ?? label(i.scenario)}</span>{i.zone && <small className="muted">{i.zone}</small>}</td>
          <td><StatusBadge text={label(i.severity)} tone={severityTone[i.severity]}/></td>
          <td><IncidentBadge status={i.status}/></td>
          <td className="num">{number.format(i.affectedMerchantCount)} merchants{i.affectedDeviceCount > 0 && <small className="muted">{number.format(i.affectedDeviceCount)} devices</small>}</td>
          <td>{i.detectedAt ? <Time value={i.detectedAt}/> : "—"}</td>
          <td>{i.owner ?? <span className="muted">AI teammate</span>}</td>
        </tr>)}</tbody>
      </table></div>}
    </>}
  </section>
}

function DetectionJobs({ data, canRun, busy, run }: {
  data?: DetectionJobsView; canRun: boolean; busy: boolean; run: (job: DetectionJobView, drill: boolean) => void
}) {
  const [drill, setDrill] = useState(false)
  return <section className="card jobs" aria-label="Detection jobs">
    <SectionHeader title="Detection jobs" subtitle={data ? `Scheduled monitors · times in IST (${data.timezone})` : "Scheduled monitors"}
      action={canRun && <label className="drill-toggle"><input type="checkbox" checked={drill} onChange={(e) => setDrill(e.target.checked)}/> Failure drill</label>}/>
    {!data ? <p className="muted">Loading schedules…</p> : <div className="table-wrap"><table className="data-table jobs-table">
      <thead><tr><th scope="col">Job</th><th scope="col">Detects</th><th scope="col">Severity</th><th scope="col">Schedule</th><th scope="col">Last run</th><th scope="col">Next run</th>{canRun && <th scope="col"><span className="sr-only">Run</span></th>}</tr></thead>
      <tbody>{data.jobs.map((job) => <tr key={job.id}>
        <td><strong>{job.name}</strong><small className="muted">{job.zone}</small></td>
        <td>{job.typeLabel}<small className="muted"><code>{job.incidentType}</code></small></td>
        <td><StatusBadge text={label(job.severity)} tone={severityTone[job.severity]}/></td>
        <td><code>{job.cron}</code><small className="muted">{job.scheduleLabel}</small></td>
        <td>{job.lastRun ? <a href={incidentHref(job.lastRun.incidentId)} className="job-run"><Time value={job.lastRun.ranAt} clock/>
          <small>{job.lastRun.displayId}{job.lastRun.status && ` · ${label(job.lastRun.status)}`}</small></a> : <span className="muted">No run yet</span>}</td>
        <td><Time value={job.nextFireAt} clock/></td>
        {canRun && <td><button className="button button--quiet button--small" disabled={busy || Boolean(job.lastRun)} onClick={() => run(job, drill && job.supportsPartial)}
          aria-label={`Run ${job.name} now`}>{job.lastRun ? "Done" : "Run now"}</button></td>}
      </tr>)}</tbody>
    </table></div>}
    {canRun && <p className="small-note muted">Failure drill makes one device ignore its restart so the escalation path can be rehearsed.</p>}
  </section>
}

function IncidentTypes({ data }: { data?: DetectionJobsView }) {
  return <section className="card types" aria-label="Incident types and thresholds">
    <SectionHeader title="Incident types & thresholds" subtitle="What each monitor looks for and when it raises an incident"/>
    {!data ? <p className="muted">Loading…</p> : <ul className="type-list">{data.jobs.map((job) => <li key={job.id}>
      <div className="type-head"><strong>{job.typeLabel}</strong><StatusBadge text={label(job.severity)} tone={severityTone[job.severity]}/></div>
      <p>{job.description}</p>
      <dl className="type-facts"><div><dt>Threshold</dt><dd>{job.threshold}</dd></div><div><dt>Zone</dt><dd>{job.zone}</dd></div><div><dt>Code</dt><dd><code>{job.incidentType}</code></dd></div></dl>
    </li>)}</ul>}
  </section>
}

function Performance({ data }: { data?: MetricsView }) {
  return <section className="card performance" aria-label="Performance">
    <SectionHeader title="Performance" subtitle="Measured from incidents in this sandbox"/>
    {!data ? <p className="muted">Loading measurements…</p> :
      <ul className="metric-grid">{data.metrics.map((m) => <li key={m.key} data-testid={`metric-${m.key}`}>
        <span className="metric-grid-label">{m.label}</span>
        <strong>{m.value}</strong>
        {m.numerator !== null && m.denominator !== null && m.denominator > 0 && <span className="metric-ratio">{number.format(m.numerator)} / {number.format(m.denominator)}</span>}
        <small>{m.detail}</small>
      </li>)}</ul>}
  </section>
}

function Activity({ data }: { data: DashboardView }) {
  const byId = new Map(data.incidents.map((i) => [i.id, i]))
  return <section className="card activity" aria-label="Recent activity">
    <SectionHeader title="Recent activity" subtitle="Latest detection, investigation, action and verification steps"/>
    {data.activity.length === 0 ? <EmptyState icon="list" title="No activity yet">Steps appear here as incidents are handled.</EmptyState> :
      <ol className="timeline">{data.activity.slice(0, 8).map((entry) => {
        const [name, tone] = modes[entry.mode]
        const inc = byId.get(entry.incidentId)
        return <li key={entry.id}><a href={incidentHref(entry.incidentId)}>
          <span className="timeline-time"><Time value={entry.at} clock/></span>
          <span className="timeline-body"><strong>{traceSummary(entry.summary)}</strong>
            <small>{inc?.displayId ?? entry.incidentId} · {label(entry.stage)} · <StatusBadge text={name} tone={tone}/></small></span>
        </a></li>
      })}</ol>}
  </section>
}

export function MissionControl({ data, metrics, jobs, canRun, busy, runJob }: {
  data: DashboardView; metrics?: MetricsView; jobs?: DetectionJobsView; canRun: boolean; busy: boolean
  runJob: (job: DetectionJobView, drill: boolean) => void
}) {
  return <>
    <section className="metrics" aria-label="Key figures">
      {kpis.map((item) => <article className="card metric" key={item.key}>
        <span className="mini-icon"><Icon name={item.icon} size={18}/></span>
        <div><div className="metric-label">{item.title}</div><strong data-testid={`kpi-${item.key}`}>{number.format(data.kpis[item.key])}</strong>
          <small className="muted">{item.hint}</small></div>
      </article>)}
    </section>
    <IncidentList incidents={data.incidents}/>
    <DetectionJobs data={jobs} canRun={canRun} busy={busy} run={runJob}/>
    <div className="overview-grid">
      <Performance data={metrics}/>
      <Activity data={data}/>
    </div>
    <IncidentTypes data={jobs}/>
  </>
}
