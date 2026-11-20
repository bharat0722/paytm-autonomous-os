import { useMemo, useState, type FormEvent } from "react"
import type { DashboardView, DemoInject, IncidentCard, Scenario } from "../../../shared/contracts/http.js"
import { EmptyState, Icon, IncidentBadge, SectionHeader, StatusBadge, Time, type IconName } from "./ui.js"
import { incidentHref, label, modes, number, scenarios, traceSummary } from "./workspace.js"

const kpis = [
  { key: "activeIncidents", title: "Active incidents", icon: "incident", color: "blue" },
  { key: "affectedMerchants", title: "Currently affected merchants", icon: "users", color: "sky" },
  { key: "verifiedResolved", title: "Verified resolved incidents", icon: "verify", color: "green" },
  { key: "pendingApprovals", title: "Pending approvals", icon: "shield", color: "amber" },
] as const satisfies readonly { key: keyof DashboardView["kpis"]; title: string; icon: IconName; color: string }[]

export function SimulationForm({ run, pending }: {
  run: (scenario: Scenario, variant: DemoInject["variant"]) => void; pending: boolean
}) {
  const [scenario, setScenario] = useState<Scenario>("soundbox")
  const [variant, setVariant] = useState<DemoInject["variant"]>("success")

  function submit(event: FormEvent) {
    event.preventDefault()
    run(scenario, scenario === "soundbox" ? variant : "success")
  }

  return <form className="simulation" onSubmit={submit}>
    <label className="sr-only" htmlFor="scenario">Scenario</label>
    <select id="scenario" value={scenario} disabled={pending} onChange={(event) => setScenario(event.target.value as Scenario)}>
      {Object.entries(scenarios).map(([key, name]) => <option key={key} value={key}>{name}</option>)}
    </select>
    {scenario === "soundbox" && <>
      <label className="sr-only" htmlFor="outcome">Recovery variant</label>
      <select id="outcome" value={variant} disabled={pending} onChange={(event) => setVariant(event.target.value as DemoInject["variant"])}>
        <option value="success">Complete recovery</option><option value="partial">Partial recovery</option>
      </select>
    </>}
    <button className="button button--primary" disabled={pending} type="submit"><Icon name="play" size={16} />{pending ? "Starting…" : "Run Simulation"}</button>
  </form>
}

export function IncidentList({ incidents, picker = false }: { incidents: IncidentCard[]; picker?: boolean }) {
  const [query, setQuery] = useState("")
  const [filter, setFilter] = useState("all")
  const visible = useMemo(() => {
    const term = query.trim().toLowerCase()
    return incidents.filter((item) => {
      const completed = item.status === "RESOLVED" || item.status === "TASK_COMPLETED"
      const matchesFilter = filter === "all" || (filter === "closed" ? completed : !completed)
      return matchesFilter && (!term || [item.title, item.id, scenarios[item.scenario], label(item.status), item.severity]
        .some((part) => part.toLowerCase().includes(term)))
    })
  }, [filter, incidents, query])

  return <section className="card incident-list">
    <SectionHeader title={picker ? "Choose an incident" : "Incidents"}
      action={incidents.length > 0 && <span className="count-pill">{number.format(incidents.length)}</span>} />
    {incidents.length === 0 ? <EmptyState icon="incident" title="No incidents yet"
      action={picker ? <a className="button button--quiet" href="#/">Go to Mission Control</a> : undefined}>
      Run a simulation from Mission Control to populate the workspace.
    </EmptyState> : <>
      <div className="list-controls">
        <label className="search-field"><Icon name="search" size={16} /><input type="search" aria-label="Search incidents" placeholder="Search incidents"
          value={query} onChange={(event) => setQuery(event.target.value)} /></label>
        <label className="sr-only" htmlFor="incident-filter">Filter incidents</label>
        <select id="incident-filter" value={filter} onChange={(event) => setFilter(event.target.value)}>
          <option value="all">All statuses</option><option value="open">Open</option><option value="closed">Completed</option>
        </select>
      </div>
      {visible.length === 0 ? <EmptyState icon="search" title="No matching incidents"
        action={<button className="button button--quiet" onClick={() => { setQuery(""); setFilter("all") }}>Clear filters</button>}>
        Try another search or status.
      </EmptyState> : <ul className="incident-rows">
        {visible.map((incident) => <li key={incident.id}>
          <a href={incidentHref(incident.id)} className="incident-row">
            <span className="mini-icon"><Icon name="device" size={17} /></span>
            <span className="incident-row-main"><strong>{incident.title}</strong><small>{label(incident.severity)} severity · {incident.affectedDeviceCount} devices · <Time value={incident.updatedAt}/></small></span>
            <IncidentBadge status={incident.status} /><Icon name="chevron" size={16}/>
          </a>
        </li>)}
      </ul>}
    </>}
  </section>
}

function Pulse({ points }: { points: DashboardView["pulse"] }) {
  const max = Math.max(1, ...points.map(({ count }) => count))
  return <section className="card pulse">
    <SectionHeader title="Network pulse" subtitle="Counts from the current demo dataset" action={<span className="mini-icon"><Icon name="bars" size={17}/></span>}/>
    {points.length === 0 && <p className="muted">No network observations yet.</p>}
    <ul>{points.map((point) => <li key={point.key}>
      <div><span>{point.label}</span><strong>{number.format(point.count)}</strong></div>
      <div className="pulse-track" aria-hidden="true"><span style={{ width: `${point.count / max * 100}%` }}/></div>
    </li>)}</ul>
  </section>
}

export function MissionControl({ data }: { data: DashboardView }) {
  const attention = data.incidents.find(({ status }) => !["RESOLVED", "TASK_COMPLETED"].includes(status))
  const last = data.incidents[0]

  return <>
    <section className="metrics" aria-label="Workspace metrics">
      {kpis.map((item) => <article className="card metric" key={item.key}>
        <span className={`mini-icon icon--${item.color}`}><Icon name={item.icon} size={18}/></span>
        <div><div className="metric-label">{item.title}</div><strong data-testid={`kpi-${item.key}`}>{number.format(data.kpis[item.key])}</strong></div>
      </article>)}
    </section>
    <div className="mission-grid">
      <section className="focus card">
        <div className="focus-kicker"><Icon name="incident" size={17}/>{attention ? "Needs attention" : "Network overview"}</div>
        {attention ? <>
          <div className="focus-content"><IncidentBadge status={attention.status}/><h2>{attention.title}</h2>
          <p>{attention.affectedDeviceCount} devices · {attention.affectedMerchantCount} merchants · {label(attention.severity)} severity</p></div>
          <a className="button button--white" href={incidentHref(attention.id)}>Open War Room <Icon name="forward" size={16}/></a>
        </> : <>
          <div className="focus-content"><h2>{last ? "No open incidents" : "Ready to run a simulation"}</h2>
          <p>{last ? "Open the most recent incident to review its evidence and outcome." : "Choose a scenario to see how the workspace detects and tracks an incident."}</p></div>
          {last && <a className="button button--white" href={incidentHref(last.id)}>View last incident <Icon name="forward" size={16}/></a>}
        </>}
      </section>
      <Pulse points={data.pulse}/>
      <IncidentList incidents={data.incidents}/>
      <section className="card activity">
        <SectionHeader title="Recent activity" action={<span className="mini-icon"><Icon name="list" size={17}/></span>}/>
        {data.activity.length === 0 ? <EmptyState icon="incident" title="No activity yet">Investigation and recovery updates appear here.</EmptyState> :
          <ul className="activity-list">{data.activity.slice(0, 4).map((entry) => {
            const [name, tone] = modes[entry.mode]
            return <li key={entry.id}><a href={incidentHref(entry.incidentId)}>
              <span className="activity-dot" aria-hidden="true"/>
              <span><strong>{traceSummary(entry.summary)}</strong><small><StatusBadge text={name} tone={tone}/> <Time value={entry.at} clock/></small></span>
              <Icon name="chevron" size={15}/>
            </a></li>
          })}</ul>}
      </section>
    </div>
  </>
}
