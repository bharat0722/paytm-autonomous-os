import { useMemo, useState } from "react"
import type {
  ActionView, AuditEntry, DeviceCheck, EvidenceView, IncidentView, RecoveryView, TraceEntry,
} from "../../../shared/contracts/http.js"
import { CopyId, Dialog, EmptyState, Icon, IncidentBadge, SectionHeader, StatusBadge, Time } from "./ui.js"
import { approvalsHref, incidentHref, incidentPresentation, label, modes, scenarios, traceSummary } from "./workspace.js"

const actionTitle: Record<ActionView["kind"], string> = {
  MOCK_SYNC_DEVICE_CONFIG: "Configuration sync", MOCK_RESTART_DEVICE: "Simulated restart", LINK_SUPPORT_TICKETS: "Link support tickets",
}
const actionState: Record<ActionView["status"], string> = {
  PROPOSED: "Proposed", RUNNING: "Running", SUCCEEDED: "Executed", PARTIAL: "Partially executed", FAILED: "Failed", BLOCKED: "Blocked",
}
const evidenceKinds: Record<EvidenceView["kind"], string> = {
  device: "Devices", device_event: "Device events", ticket: "Support tickets", payment: "Payments", settlement: "Settlements", merchant: "Merchants",
}
const deviceCheck: Record<DeviceCheck["status"], string> = { PASS: "Passed", FAIL: "Failed", AWAITING: "Awaiting signal" }

function EvidenceLinks({ ids, open }: { ids: string[]; open: (id: string) => void }) {
  if (!ids.length) return null
  return <details className="evidence-links">
    <summary><Icon name="link" size={14}/> {ids.length} evidence {ids.length === 1 ? "reference" : "references"}</summary>
    <ul>{ids.map((id) => <li key={id}><button className="text-button record-link" onClick={() => open(id)}>{id}</button></li>)}</ul>
  </details>
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

function WorkLog({ entries, openEvidence }: { entries: TraceEntry[]; openEvidence: (id: string) => void }) {
  const [all, setAll] = useState(false)
  const shown = all ? entries : entries.slice(-5)
  return <section className="card worklog"><SectionHeader title="AI work log" subtitle="Chronology from the stored investigation trace"
    action={<span className="mini-icon"><Icon name="list" size={17}/></span>}/>
    {!entries.length ? <EmptyState icon="list" title="No workflow activity yet">The work log appears as the investigation runs.</EmptyState> : <>
      <ol className="work-steps">{shown.map((entry) => {
        const [mode, tone] = modes[entry.mode]
        return <li key={entry.id}>
          <span className="step-indicator" aria-hidden="true"/>
          <div><div className="step-meta"><StatusBadge text={mode} tone={tone}/><Time value={entry.at} clock/></div>
            <strong>{label(entry.stage)}</strong><p>{traceSummary(entry.summary)}</p>
            {entry.tool && <code className="tool-code">{entry.tool}</code>}
            <EvidenceLinks ids={entry.evidenceIds} open={openEvidence}/>
          </div>
        </li>
      })}</ol>
      {entries.length > 5 && <button className="button button--quiet" onClick={() => setAll(!all)} aria-expanded={all}>{all ? "Show recent activity" : "Show all activity"}</button>}
    </>}
  </section>
}

function RecordBrowser({ records, open }: { records: EvidenceView[]; open: (id: string) => void }) {
  const [selected, setSelected] = useState<EvidenceView["kind"]>()
  const [expanded, setExpanded] = useState(false)
  const groups = useMemo(() => {
    const byKind = new Map<EvidenceView["kind"], EvidenceView[]>()
    for (const entry of records) {
      const group = byKind.get(entry.kind)
      if (group) group.push(entry)
      else byKind.set(entry.kind, [entry])
    }
    return byKind
  }, [records])
  const active = selected && groups.has(selected) ? selected : groups.keys().next().value
  const group = active ? groups.get(active) ?? [] : []
  return <section className="card">
    <SectionHeader title="Linked records" subtitle="Records associated with this incident" action={<span className="mini-icon"><Icon name="stack" size={17}/></span>}/>
    {records.length === 0 ? <EmptyState title="No linked records yet">Evidence appears when the workspace finds related records.</EmptyState> : <>
      <div className="filter-chips" aria-label="Evidence type">
        {[...groups].map(([kind, items]) => <button key={kind} onClick={() => { setSelected(kind); setExpanded(false) }}
          aria-pressed={active === kind}>{evidenceKinds[kind]} <span>{items.length}</span></button>)}
      </div>
      <ul className="record-list">{(expanded ? group : group.slice(0, 4)).map((record) => <li key={record.id}>
        <button onClick={() => open(record.id)}>
          <Icon name="file" size={16}/><span><strong>{record.title}</strong><small>{record.id}</small></span><Icon name="chevron" size={15}/>
        </button>
      </li>)}</ul>
      {group.length > 4 && <button className="button button--quiet" onClick={() => setExpanded(!expanded)} aria-expanded={expanded}>
        {expanded ? "Show fewer records" : `Show all ${group.length} records`}
      </button>}
    </>}
  </section>
}

function AuditHistory({ entries, openEvidence, focusedId }: { entries: AuditEntry[]; openEvidence: (id: string) => void; focusedId?: string }) {
  if (!entries.length) return <p className="muted">No audit entries yet.</p>
  const shown = focusedId ? [...entries].sort((left, right) => Number(right.id === focusedId) - Number(left.id === focusedId)) : entries
  return <ol className="audit-list">{shown.map((entry) => <li key={entry.id} className={entry.id === focusedId ? "audit-focus" : undefined}>
    <div><strong>{label(entry.event)}</strong> <Time value={entry.at}/></div><p>{entry.summary}</p>
    <dl className="fact-list">
      <div><dt>Actor</dt><dd>{entry.actor}</dd></div>
      {entry.actionId && <div><dt>Action</dt><dd><code>{entry.actionId}</code></dd></div>}
      {entry.approvalId && <div><dt>Approval</dt><dd><code>{entry.approvalId}</code></dd></div>}
    </dl><EvidenceLinks ids={entry.evidenceIds} open={openEvidence}/>
  </li>)}</ol>
}

export function WarRoom({ data, deepEvidence, canResume, resuming, resume }: {
  data: IncidentView; deepEvidence?: string; canResume: boolean; resuming: boolean; resume: () => void
}) {
  const { incident, evidence, blocker, owner, workflow } = data
  const [evidenceId, setEvidence] = useState<string>()
  const [auditId, setAudit] = useState<string | null>(null)
  const [expandedChecks, setExpandedChecks] = useState(false)
  const selectedEvidence = evidenceId ?? deepEvidence
  const selectedRecord = useMemo(() => new Map(evidence.map((record) => [record.id, record])), [evidence]).get(selectedEvidence ?? "")
  const pending = workflow.approvals.find(({ status }) => status === "PENDING")
  const recovery = incident.scenario === "soundbox" ? workflow.recovery : null
  const ticketChecks = incident.scenario === "duplicate-tickets" ? workflow.recovery : null
  const inconsistent = incident.status === "RESOLVED" && (!recovery || recovery.total === 0 ||
    recovery.recovered !== recovery.total || recovery.remainingDeviceIds.length > 0 ||
    recovery.devices.length !== recovery.total || recovery.devices.some(({ status }) => status !== "PASS"))

  function closeEvidence() {
    setEvidence(undefined)
    if (deepEvidence) location.replace(incidentHref(incident.id))
  }

  function openFromAudit(id: string) {
    setAudit(null)
    setEvidence(id)
  }

  return <>
    <p className="sr-only" role="status">
      {inconsistent ? "Verification needs review" : incidentPresentation[incident.status][0]}
      {recovery && !inconsistent && `. ${recovery.recovered} of ${recovery.total} devices verified recovered.`}
    </p>
    <div className="incident-summary">
      <div><a className="back-link" href="#/"><Icon name="back" size={15}/> Mission Control</a>
        <h1>{incident.title}</h1><p>{scenarios[incident.scenario]} · <code>{incident.id}</code></p></div>
      <div className="incident-summary-meta">
        <div className="chip-row">{inconsistent ? <StatusBadge text="Verification needs review" tone="red"/> : <span data-testid="incident-status"><IncidentBadge status={incident.status}/></span>}
          <StatusBadge text={`${label(incident.severity)} severity`} tone={["HIGH", "CRITICAL"].includes(incident.severity) ? "amber" : "neutral"}/></div>
        <p>{incident.affectedDeviceCount > 0 ? `${incident.affectedDeviceCount} devices across ` : ""}{incident.affectedMerchantCount} merchants · Updated <Time value={incident.updatedAt}/></p>
        {canResume && <button className="button button--quiet" onClick={resume} disabled={resuming}>{resuming ? "Queuing…" : "Resume Investigation"}</button>}
      </div>
    </div>

    {inconsistent && <div role="alert" className="callout callout--red"><Icon name="alert"/><div><strong>Recovery could not be confirmed</strong><p>The latest stored verification is incomplete.</p></div></div>}
    {recovery ? <RecoveryProgress recovery={recovery} closed={incident.status === "RESOLVED" && !inconsistent}/> :
      <section className="card outcome-placeholder"><Icon name={incident.scenario === "soundbox" ? "verify" : "stack"}/>
        <div><h2>{incident.scenario === "soundbox" ? "Awaiting verification" : incident.scenario === "duplicate-tickets" ? "Ticket linkage" : "Read-only settlement handoff"}</h2>
        <p>{ticketChecks ? <><strong data-testid="ticket-check-count">{ticketChecks.recovered} / {ticketChecks.total} ticket links verified</strong> · Checked <Time value={ticketChecks.checkedAt}/></> :
          incident.scenario === "soundbox" ? "Recovery appears after the first completed device check." :
            incident.scenario === "duplicate-tickets" ? "The workflow verifies links saved between support tickets." : "The workflow records the discrepancy and assigns it for human review."}</p></div>
      </section>}
    {pending && <div className="callout callout--amber"><Icon name="shield"/><div><strong>Human approval required</strong>
      <p>{pending.targetDeviceIds.length} {pending.targetDeviceIds.length === 1 ? "device needs" : "devices need"} a simulated restart.</p></div>
      <a className="button button--secondary" href={approvalsHref(pending.id)}>Review approval <Icon name="forward" size={15}/></a></div>}
    {!pending && (blocker || owner) && <div className="callout"><Icon name="alert"/><div><strong>{owner ? `Assigned to ${owner}` : "Investigation note"}</strong>{blocker && <p>{blocker}</p>}</div></div>}

    <div className="war-grid">
      <div className="section-stack">
        <section className="card findings">
          <SectionHeader title="What the AI found" action={<span className="mini-icon"><Icon name="incident" size={17}/></span>}/>
          {!workflow.finding ? <EmptyState icon="search" title="Findings are pending">The investigator publishes a summary when it has supporting records.</EmptyState> :
            <div className="finding-content">
              {workflow.finding.hypothesis && <div className="hypothesis"><h3>Working hypothesis</h3><p>{workflow.finding.hypothesis}</p></div>}
              {!!workflow.finding.observations.length && <><h3>Observed facts</h3><ul>{workflow.finding.observations.map((entry, index) => <li key={index}>{entry}</li>)}</ul></>}
              {workflow.finding.uncertainty && <div className="finding-note"><h3>Uncertainty</h3><p>{workflow.finding.uncertainty}</p></div>}
              {!!workflow.finding.missingEvidence.length && <details><summary>Missing evidence</summary><ul>{workflow.finding.missingEvidence.map((line, index) => <li key={index}>{line}</li>)}</ul></details>}
              <EvidenceLinks ids={workflow.finding.evidenceIds} open={setEvidence}/>
            </div>}
        </section>
        <RecordBrowser records={evidence} open={setEvidence}/>
      </div>
      <div className="section-stack">
        <WorkLog entries={workflow.trace} openEvidence={setEvidence}/>
        <section className="card actions"><SectionHeader title="Actions and policy"
          action={<span className="mini-icon"><Icon name="lock" size={17}/></span>}/>
          {workflow.actions.length === 0 && <p className="muted">No actions recorded.</p>}
          <ul>{workflow.actions.map((action) => <li key={action.id}><div className="action-title"><strong>{actionTitle[action.kind]}</strong>
            <StatusBadge text={actionState[action.status]} tone={action.status === "FAILED" || action.status === "BLOCKED" ? "red" : "neutral"}/></div>
            <p>{action.summary}</p><details><summary>{action.targetIds.length} targets · Policy details</summary>
              <code>{action.ruleId}</code><ul className="code-list">{action.targetIds.map((id) => <li key={id}><code>{id}</code></li>)}</ul>
            </details>{action.auditId && <button className="text-button" onClick={() => setAudit(action.auditId)}>View action audit</button>}
          </li>)}</ul>
          <button className="button button--quiet" onClick={() => setAudit("")}>Open audit history</button>
        </section>
      </div>
    </div>
    {recovery && <section className="card device-checks">
      <SectionHeader title="Device checks" subtitle="Per-device results from the latest verification"
        action={<button className="button button--quiet" aria-expanded={expandedChecks} onClick={() => setExpandedChecks(!expandedChecks)}>{expandedChecks ? "Hide device checks" : "View device checks"}</button>}/>
      {expandedChecks && <div className="table-wrap"><table><thead><tr><th scope="col">Device ID</th><th scope="col">Result</th><th scope="col">Check detail</th></tr></thead>
        <tbody>{recovery.devices.map((device) => <tr key={device.deviceId}>
          <td><code>{device.deviceId}</code></td>
          <td><StatusBadge text={deviceCheck[device.status]} tone={device.status === "PASS" ? "green" : device.status === "FAIL" ? "red" : "amber"}/></td>
          <td>{device.reason}<EvidenceLinks ids={device.evidenceIds} open={setEvidence}/></td>
        </tr>)}</tbody>
      </table></div>}
    </section>}
    {selectedEvidence && <Dialog title="Evidence record" onDismiss={closeEvidence} sheet>
      <CopyId value={selectedEvidence}/>
      {selectedRecord ? <><h3 className="sheet-title">{selectedRecord.title}</h3><p className="muted">{evidenceKinds[selectedRecord.kind]}{selectedRecord.occurredAt && <> · <Time value={selectedRecord.occurredAt}/></>}</p>
        <dl className="fact-list">{Object.entries(selectedRecord.details).map(([key, value]) => <div key={key}><dt>{label(key)}</dt><dd>{value == null ? "—" : String(value)}</dd></div>)}</dl></> :
        <p className="muted">This ID is recorded in the workflow. No record details are available in the incident response.</p>}
    </Dialog>}
    {auditId !== null && <Dialog title="Audit history" onDismiss={() => setAudit(null)} sheet>
      <AuditHistory entries={workflow.audit} openEvidence={openFromAudit} focusedId={auditId || undefined}/>
    </Dialog>}
  </>
}
