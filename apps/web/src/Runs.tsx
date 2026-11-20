import type { JobView, RunsView } from "../../../shared/contracts/http.js"
import { EmptyState, Icon, Info, SectionHeader, StatusBadge, Time } from "./ui.js"
import { label, modes, type Tone } from "./workspace.js"

const jobStatus: Record<JobView["status"], [string, Tone, string]> = {
  PENDING: ["Scheduled", "blue", "Waiting for its start time or a free worker."],
  LEASED: ["Running", "blue", "A worker is doing this right now."],
  DONE: ["Done", "green", "Finished."],
  FAILED: ["Failed", "red", "Gave up after several tries."],
  CANCELLED: ["Cancelled", "neutral", "Stopped because the demo was reset."],
}
const jobTip: Record<string, string> = {
  "AI investigation": "The AI reads the records and decides the next step.",
  "Run the approved action": "Carries out one approved fix, exactly once.",
  "Check that it worked": "Reads fresh evidence to prove the fix worked.",
  "Approval timeout": "Cancels the request if no person decides in time.",
  "Device signal report": "The simulated devices report back after a change.",
}
const outcomeText: Record<string, string> = {
  SYNC_QUEUED: "Queued a settings fix", RESEND_QUEUED: "Queued a payment-alert resend", LINK_QUEUED: "Queued ticket linking",
  APPROVAL_REQUESTED: "Asked a person to approve", HANDOFF: "Handed over to a person", ESCALATED: "Escalated to a person",
  NO_ACTION: "No safe action found", FAILED: "Could not finish",
}

export function RunsPanel({ view }: { view?: RunsView }) {
  if (!view) return <div className="card"><EmptyState icon="clock" title="Loading runs…">Jobs and schedules appear here.</EmptyState></div>
  return <div className="section-stack runs">
    <section className="card">
      <SectionHeader title="Schedules and limits" subtitle="The timers and safety limits behind this case"
        action={<Info text="Every automatic step has a timer or a cap, so nothing runs forever or without a limit."/>}/>
      <ul className="tiles">{view.schedules.map((s) => <li key={s.id}><span>{s.title}</span><strong>{s.value}</strong><small>{s.detail}</small></li>)}</ul>
    </section>

    <section className="card">
      <SectionHeader title="AI investigations" subtitle="Each time the AI looked into this case"
        action={<Info text="A run is one go at investigating. The AI has a step and time budget for each."/>}/>
      {view.runs.length === 0 ? <EmptyState icon="search" title="No investigation yet">It starts as soon as the case is created.</EmptyState> :
        <ol className="run-list">{view.runs.map((r) => {
          const [mode, tone] = modes[r.mode]
          return <li key={r.id}>
            <div><strong>{r.stage === "triage" ? "First investigation" : "Follow-up after the check"}</strong>
              <small>{r.stepsUsed} steps · {(r.activeMs / 1000).toFixed(1)} s · started <Time value={r.startedAt} clock/></small></div>
            <div className="chip-row"><StatusBadge text={mode} tone={tone}/>
              <StatusBadge text={r.outcome ? (outcomeText[r.outcome] ?? label(r.outcome)) : label(r.status)} tone={r.status === "RUNNING" ? "blue" : r.outcome === "FAILED" ? "red" : "green"}/></div>
          </li>
        })}</ol>}
    </section>

    <section className="card">
      <SectionHeader title="Background jobs" subtitle="The work list the system runs for this case"
        action={<Info text="Jobs run in the background. Each is retried if it crashes and never runs twice by mistake."/>}/>
      {view.jobs.length === 0 ? <EmptyState icon="list" title="No jobs yet">Jobs appear when the case starts.</EmptyState> :
        <div className="table-wrap"><table><thead><tr><th scope="col">Job</th><th scope="col">Job ID</th><th scope="col">Status</th><th scope="col">Scheduled</th><th scope="col">Tries</th></tr></thead>
          <tbody>{view.jobs.map((j) => {
            const [text, tone, tip] = jobStatus[j.status]
            return <tr key={j.id}>
              <td><span title={jobTip[j.label] ?? j.kind}>{j.label}</span></td>
              <td><code>{j.id}</code></td>
              <td><span title={tip}><StatusBadge text={text} tone={tone}/></span>{j.lastError && <small className="muted"> {j.lastError}</small>}</td>
              <td><Time value={j.runAfter} clock/></td>
              <td>{j.attempt}</td>
            </tr>
          })}</tbody></table></div>}
    </section>
  </div>
}
