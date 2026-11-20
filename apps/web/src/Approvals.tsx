import { useRef, useState, type FormEvent } from "react"
import type { ApprovalDecision, ApprovalQueue, ApprovalView, DecisionResult, Role } from "../../../shared/contracts/http.js"
import { asProblem, type ApiProblem } from "./api.js"
import { Dialog, EmptyState, Icon, InlineError, SectionHeader, StatusBadge, Time } from "./ui.js"
import { approvalPresentation, approvalsHref, incidentHref, label } from "./workspace.js"

function ApprovalBadge({ status }: { status: ApprovalView["status"] }) {
  const [name, tone] = approvalPresentation[status]
  return <StatusBadge text={name} tone={tone}/>
}

function Queue({ items, selected }: { items: ApprovalView[]; selected?: string }) {
  return <ul className="approval-rows">{items.map((item) => <li key={item.id}>
    <a href={approvalsHref(item.id)} aria-current={selected === item.id ? "location" : undefined}>
      <span className="mini-icon"><Icon name="shield" size={16}/></span>
      <span className="approval-row-main"><strong>Remote device restart</strong><small>{item.targetDeviceIds.length} devices · <Time value={item.createdAt}/></small></span>
      <ApprovalBadge status={item.status}/>
    </a>
  </li>)}</ul>
}

function Targets({ ids }: { ids: string[] }) {
  return <ul className="target-list" aria-label="Exact target devices">{ids.map((id) => <li key={id}><Icon name="device" size={14}/><code>{id}</code></li>)}</ul>
}

function DecisionDialog({ proposal, decision, dismiss, onDecide, onDone }: {
  proposal: ApprovalView; decision: ApprovalDecision["decision"]; dismiss: () => void
  onDecide: (id: string, input: ApprovalDecision) => Promise<DecisionResult>; onDone: (result: DecisionResult) => void
}) {
  const [reason, setReason] = useState("")
  const [error, setError] = useState<ApiProblem>()
  const [busy, setBusy] = useState(false)
  const locked = useRef(false)
  const approve = decision === "approve"

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (locked.current) return
    locked.current = true
    setBusy(true)
    setError(undefined)
    try {
      const result = await onDecide(proposal.id, {
        decision, proposalRevision: proposal.proposalRevision, ...(!approve && reason.trim() ? { reason: reason.trim() } : {}),
      })
      onDone(result)
    } catch (problem) {
      setError(asProblem(problem))
    } finally {
      locked.current = false
      setBusy(false)
    }
  }

  return <Dialog title={approve ? "Confirm remote restart" : "Reject restart request"} onDismiss={dismiss} busy={busy}>
    <form className="dialog-form" onSubmit={(event) => void submit(event)}>
      <p>{approve ? "Approve a restart for these exact devices." : "The incident will remain open for follow-up."}</p>
      <Targets ids={proposal.targetDeviceIds}/>
      <div className="policy-note"><Icon name="lock" size={16}/><div><strong>Policy</strong><code>{proposal.ruleId}</code></div></div>
      {!approve && <label className="field">Reason <span className="muted">(optional)</span><textarea rows={3} maxLength={500}
        value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Add a note for the incident owner"/></label>}
      {error && <InlineError problem={error}/>}
      <div className="dialog-actions">
        <button className="button button--secondary" type="button" onClick={dismiss} disabled={busy}>Cancel</button>
        <button className={`button ${approve ? "button--primary" : "button--danger"}`} disabled={busy || Boolean(error && error.status === 409)} type="submit">
          {busy ? "Recording…" : approve ? "Confirm approval" : "Confirm rejection"}
        </button>
      </div>
    </form>
  </Dialog>
}

export function ApprovalCenter({ data, selectedId, role, onDecide, onDone }: {
  data: ApprovalQueue; selectedId?: string; role: Role
  onDecide: (id: string, input: ApprovalDecision) => Promise<DecisionResult>; onDone: (result: DecisionResult) => void
}) {
  const [confirmation, setConfirmation] = useState<{ proposal: ApprovalView; decision: ApprovalDecision["decision"] }>()
  const pending = data.approvals.filter((item) => item.status === "PENDING")
  const history = data.approvals.filter((item) => item.status !== "PENDING")
  const proposal = selectedId ? data.approvals.find((item) => item.id === selectedId) : pending[0] ?? history[0]

  return <div className="approval-grid">
    <section className="card approval-queue">
      <SectionHeader title="Pending approvals" action={<span className="count-pill">{pending.length}</span>}/>
      {pending.length ? <Queue items={pending} selected={proposal?.id}/> :
        <EmptyState icon="shield" title="No approvals need attention" action={<a href="#/" className="button button--quiet">Go to overview</a>}>
          Requests appear here when the workflow needs a decision.
        </EmptyState>}
    </section>
    <section className="card approval-detail" aria-label="Approval details">
      {!proposal ? <EmptyState icon="file" title={selectedId ? "Approval unavailable" : "Select an approval"}>
        {selectedId ? "This approval is no longer available in the current sandbox run." : "Select a request to review its targets and supporting evidence."}
      </EmptyState> : <>
        <div className="approval-detail-header">
          <span className="mini-icon icon--amber"><Icon name="shield" size={22}/></span>
          <div><h2>Remote device restart</h2><p>{proposal.targetDeviceIds.length} target devices · <a href={incidentHref(proposal.incidentId)}>Open incident</a></p></div>
          <ApprovalBadge status={proposal.status}/>
        </div>
        <div className="approval-detail-body">
          <div className="approval-rationale"><h3>Why approval is needed</h3><p>{proposal.rationale}</p></div>
          <div className="approval-facts">
            <div><h3>Impact</h3><p>{proposal.impact}</p></div>
            <div><h3>How recovery is checked</h3><p>{proposal.expectedCheck}</p></div>
          </div>
          <div className="approval-targets"><h3>Exact target devices</h3><Targets ids={proposal.targetDeviceIds}/></div>
          <div className="policy-note"><Icon name="lock" size={16}/><div><strong>Policy</strong><code>{proposal.ruleId}</code></div></div>
          <dl className="fact-list">
            <div><dt>Requested</dt><dd><Time value={proposal.createdAt}/></dd></div>
            <div><dt>Expires</dt><dd><Time value={proposal.expiresAt}/></dd></div>
            {proposal.decidedAt && <div><dt>Decided</dt><dd><Time value={proposal.decidedAt}/></dd></div>}
            {proposal.decidedBy && <div><dt>Decision actor</dt><dd><code>{proposal.decidedBy}</code></dd></div>}
            {proposal.reason && <div><dt>Decision note</dt><dd>{proposal.reason}</dd></div>}
          </dl>
          <details><summary>Request parameters and evidence</summary>
            <pre className="parameter-block">{JSON.stringify(proposal.args, null, 2)}</pre>
            {proposal.evidenceIds.length > 0 && <ul className="code-list">{proposal.evidenceIds.map((id) =>
              <li key={id}><a className="text-button record-link" href={incidentHref(proposal.incidentId, id)}>{id}</a></li>)}</ul>}
          </details>
        </div>
        <div className="approval-decision">
          {proposal.status === "PENDING" && role === "approver" ? <>
            <button className="button button--primary" onClick={() => setConfirmation({ proposal, decision: "approve" })}>
              <Icon name="check" size={17}/> Approve remote restart
            </button>
            <button className="button button--secondary" onClick={() => setConfirmation({ proposal, decision: "reject" })}>Reject</button>
          </> : <p>{proposal.status === "PENDING" ? "A signed-in approver can record a decision." :
            proposal.status === "APPROVED" || proposal.status === "CONSUMED" ? "Follow the incident to see execution and verification." :
              "This request is closed. Follow the incident for next steps."}</p>}
        </div>
      </>}
    </section>
    <section className="card approval-history"><SectionHeader title="History"/>
      {history.length ? <Queue items={history} selected={proposal?.id}/> : <p className="muted">No decisions recorded yet.</p>}
    </section>
    {confirmation && <DecisionDialog {...confirmation} dismiss={() => setConfirmation(undefined)} onDecide={onDecide}
      onDone={(result) => { setConfirmation(undefined); onDone(result) }}/>}
  </div>
}
