import { useState } from "react"
import type { PlaybookStepView, PlaybookView, ProcessEntry, StepStatus } from "../../../shared/contracts/http.js"
import { EvidenceLinks, Icon, Info, SectionHeader, StatusBadge, Time, type IconName } from "./ui.js"
import type { Tone } from "./workspace.js"

const statusText: Record<StepStatus, [string, Tone]> = {
  done: ["Done", "green"], failed: ["Needs attention", "red"], active: ["Running now", "blue"], waiting: ["Waiting for a person", "amber"],
  pending: ["Not started", "neutral"], skipped: ["Not needed", "neutral"],
}
const automationText: Record<PlaybookStepView["automation"], [string, string]> = {
  automatic: ["Automatic", "The AI does this step by itself. No human needed."],
  "policy-gated": ["Rules decide", "A written rule must allow this first. This is the control layer."],
  human: ["A person decides", "Risky actions wait here for human sign-off."],
  system: ["System check", "The system checks this on its own, without the AI."],
}
const statusIcon: Record<StepStatus, IconName> = { done: "check", failed: "alert", active: "timer", waiting: "user", pending: "list", skipped: "back" }
const segTone: Record<StepStatus, string> = { done: "done", failed: "failed", active: "active", waiting: "waiting", pending: "pending", skipped: "pending" }

function json(value: unknown): string {
  if (value === null || value === undefined) return "—"
  return typeof value === "string" ? value : JSON.stringify(value, null, 2)
}

function HttpChip({ status }: { status: number | null }) {
  if (status === null) return null
  const tone = status >= 400 ? "red" : status === 207 || status === 202 ? "amber" : "green"
  return <span className={`http http--${tone}`} data-tip="The answer code the system gave back. 2xx is success." data-tip-pos="top">HTTP {status}</span>
}

function Call({ entry, openEvidence }: { entry: ProcessEntry; openEvidence: (id: string) => void }) {
  const guard = entry.system === "Guardrail"
  const tone: Tone = guard ? "neutral" : entry.outcome === "FAILED" ? "red" : entry.outcome === "BLOCKED" ? "amber" : entry.outcome === "INFO" ? "neutral" : "green"
  const chip = guard ? "Caught · safe" : entry.outcome === "OK" ? "OK" : entry.outcome === "INFO" ? "Info" : entry.outcome === "BLOCKED" ? "Stopped by rule" : "Failed"
  return <li className="call">
    <div className="call-head">
      <span className="method">{entry.method}</span>
      <code className="endpoint">{entry.endpoint}</code>
      <HttpChip status={entry.httpStatus}/>
      <StatusBadge text={chip} tone={tone}/>
      <Time value={entry.at} clock/>
    </div>
    <p className="call-summary"><strong>{entry.system}</strong> · {entry.summary}</p>
    <div className="call-io">
      <div><h4>What we sent</h4><pre tabIndex={0}>{json(entry.request)}</pre></div>
      <div><h4>What came back</h4><pre tabIndex={0}>{json(entry.response)}</pre></div>
    </div>
    <EvidenceLinks ids={entry.evidenceIds} open={openEvidence}/>
  </li>
}

function Step({ step, expandAll, openEvidence }: { step: PlaybookStepView; expandAll: boolean; openEvidence: (id: string) => void }) {
  const [label, tone] = statusText[step.status]
  const [auto, autoTip] = automationText[step.automation]
  const calls = step.entries
  return <li className={`pb-step pb-step--${step.status}`} data-testid={`step-${step.id}`} data-status={step.status}>
    <details key={String(expandAll)} open={expandAll} className="pb-details">
      <summary className="pb-row">
        <span className="pb-marker" aria-hidden="true">{step.status === "pending" || step.status === "skipped" ? step.order : <Icon name={statusIcon[step.status]} size={16}/>}</span>
        <span className="pb-name">{step.title}</span>
        <StatusBadge text={label} tone={tone}/>
        <span className="pb-auto" data-tip={autoTip} data-tip-pos="top">{auto}</span>
        {calls.length > 0 && <span className="pb-count" data-tip="Open for the proof: exactly what the system sent and what came back." data-tip-pos="top">{calls.length} {calls.length === 1 ? "call" : "calls"}</span>}
      </summary>
      <div className="pb-inner">
        <p className="pb-desc">{step.description}</p>
        {step.system && <p className="pb-system"><Icon name="stack" size={13}/> {step.system}</p>}
        {calls.length > 0 && <ol className="pb-calls">{calls.map((entry) => <Call key={entry.id} entry={entry} openEvidence={openEvidence}/>)}</ol>}
      </div>
    </details>
  </li>
}

export function ProcessPlaybook({ view, openEvidence }: { view: PlaybookView; openEvidence: (id: string) => void }) {
  const [expandAll, setExpandAll] = useState(false)
  const calls = view.steps.reduce((n, s) => n + s.entries.length, 0)
  const done = view.steps.filter((s) => s.status === "done").length
  return <section className="card playbook" aria-label="How this incident is solved">
    <SectionHeader title="How this incident is solved"
      subtitle={`${done} of ${view.steps.length} steps done · ${calls} calls saved`}
      action={<span className="header-actions"><Info text={view.summary}/>
        <button className="button button--quiet" aria-pressed={expandAll} onClick={() => setExpandAll(!expandAll)}
          data-tip="Open or close every step to see what we sent and what came back." data-tip-pos="bottom-end">{expandAll ? "Collapse all" : "Expand all"}</button></span>}/>
    <div className="pb-progress" role="img" aria-label={`${done} of ${view.steps.length} steps done`}>
      {view.steps.map((s) => <span key={s.id} className={`seg seg--${segTone[s.status]}`} title={s.title}/>)}
    </div>
    <ol className="pb-steps">{view.steps.map((step) => <Step key={step.id} step={step} expandAll={expandAll} openEvidence={openEvidence}/>)}</ol>
  </section>
}
