import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react"
import type {
  ApprovalDecision, DecisionResult, DetectionJobView, Role, SessionView,
} from "../../../shared/contracts/http.js"
import { api, ApiProblem, asProblem, needsSessionRefresh } from "./api.js"
import { IncidentList, MissionControl } from "./Mission.js"
import { WarRoom } from "./WarRoom.js"
import { ApprovalCenter } from "./Approvals.js"
import { Dialog, EmptyState, Icon, InlineError, Skeleton, type IconName } from "./ui.js"
import { approvalsHref, incidentHref, isActive, label, missionHref, useResource, useRoute } from "./workspace.js"

function Login({ initialRole, onSignIn, button = "Sign in" }: {
  initialRole: Role; onSignIn: (role: Role, code: string) => Promise<void>; button?: string
}) {
  const [role, setRole] = useState<Role>(initialRole)
  const [code, setCode] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<ApiProblem>()
  const locked = useRef(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (locked.current) return
    locked.current = true
    setBusy(true)
    setError(undefined)
    try { await onSignIn(role, code) }
    catch (problem) { setError(asProblem(problem)); setCode("") }
    finally { locked.current = false; setBusy(false) }
  }

  return <form className="dialog-form login-form" onSubmit={(event) => void submit(event)}>
    <span className="login-prompt">Sign in with your team access code.</span>
    <label className="field">Role<select value={role} onChange={(event) => { setRole(event.target.value as Role); setError(undefined) }} disabled={busy}>
      <option value="operator">Operator</option><option value="approver">Approver</option>
    </select></label>
    <label className="field">Access code<input type="password" name="access-code" autoComplete="current-password" value={code}
      onChange={(event) => setCode(event.target.value)} required maxLength={200} disabled={busy}/></label>
    {error && <InlineError problem={error}/>}
    <button className="button button--primary" type="submit" disabled={busy}>{busy ? "Signing in…" : button}</button>
  </form>
}

const navTips: Record<string, string> = {
  mission: "The command center: every merchant problem caught, what was fixed automatically, and what needs a person.",
  incident: "One case end to end: what broke, how the AI fixed it, and the proof it worked.",
  approvals: "The human-in-the-loop gate. Risky fixes wait here for sign-off. Nothing risky runs without it.",
}
const nav: { view: "mission" | "incident" | "approvals"; name: string; icon: IconName }[] = [
  { view: "mission", name: "Overview", icon: "grid" },
  { view: "incident", name: "Incidents", icon: "incident" },
  { view: "approvals", name: "Approvals", icon: "shield" },
]

function WorkspaceFrame({ view, session, lastIncident, onSwitch, onReset, children }: {
  view: "mission" | "incident" | "approvals"; session?: SessionView; lastIncident?: string
  onSwitch: () => void; onReset: () => void; children: ReactNode
}) {
  const names = { mission: missionHref, incident: incidentHref(lastIncident), approvals: approvalsHref() }
  const role = session?.actor?.role
  return <div className="workspace">
    <a className="skip-link" href="#main-content" onClick={(event) => {
      event.preventDefault()
      document.getElementById("main-content")?.focus()
    }}>Skip to content</a>
    <aside className="sidebar">
      <a href={missionHref} className="wordmark">
        <span className="brand-icon"><Icon name="brand" size={23}/></span>
        <strong>Merchant<span>Reliability OS</span></strong>
      </a>
      <nav aria-label="Workspace">{nav.map((item) => <a key={item.view} href={names[item.view]} aria-current={view === item.view ? "page" : undefined} data-tip={navTips[item.view]} data-tip-pos="right">
        <Icon name={item.icon}/><span>{item.name}</span>
      </a>)}</nav>
      <div className="sidebar-note"><Icon name="lock" size={15}/><span>Merchant operations<br/>Device · Support · Settlement</span></div>
    </aside>
    <div className="surface">
      <header className="topbar">
        <div className="breadcrumb"><span>Workspace</span><Icon name="chevron" size={13}/><strong>{nav.find((item) => item.view === view)?.name}</strong></div>
        <div className="top-actions">
          {view !== "mission" && role === "operator" && <button className="button button--quiet top-reset" onClick={onReset} data-tip="Wipe the demo data and start a clean run. For rehearsals." data-tip-pos="bottom-end"><Icon name="reset" size={16}/>Reset sandbox</button>}
          <span className="env-badge" data-tip="Demo environment: synthetic data only. No real Paytm system, device or money is touched." data-tip-pos="bottom-end"><i aria-hidden="true"/>Sandbox</span>
          <span className="role-label"><Icon name="user" size={16}/>{role ? label(role) : "Not signed in"}</span>
          {role && <button className="button button--quiet switch-role" onClick={onSwitch} data-tip="Two roles, separate people: the Operator runs cases, the Approver signs off risky fixes. Separation of duties." data-tip-pos="bottom-end">Switch role</button>}
        </div>
      </header>
      <main className="main-content" id="main-content" tabIndex={-1}>{children}</main>
    </div>
  </div>
}

export function App() {
  const route = useRoute()
  const [session, setSession] = useState<SessionView>()
  const [sessionError, setSessionError] = useState<ApiProblem>()
  const [notice, setNotice] = useState("")
  const [error, setError] = useState<ApiProblem>()
  const [dialog, setDialog] = useState<"role" | "reset">()
  const [busy, setBusy] = useState<string>()
  const [lastIncident, setLastIncident] = useState<{ id: string; generation: number }>()
  const currentSession = useRef<SessionView>(undefined)
  const sessionRequest = useRef<AbortController>(undefined)
  const mutation = useRef(false)

  const setWorkspaceSession = useCallback((next: SessionView) => {
    const previous = currentSession.current
    if (previous && previous.generation !== next.generation) {
      setLastIncident(undefined)
      setDialog(undefined)
      setError(undefined)
      if (location.hash !== missionHref) location.replace(missionHref)
    }
    currentSession.current = next
    setSession(next)
    setSessionError(undefined)
  }, [])

  const renew = useCallback(async () => {
    sessionRequest.current?.abort()
    const request = new AbortController()
    sessionRequest.current = request
    try {
      const next = await api.session(request.signal)
      if (!request.signal.aborted) setWorkspaceSession(next)
    } catch (problem) {
      if (!request.signal.aborted) setSessionError(asProblem(problem))
    }
  }, [setWorkspaceSession])

  useEffect(() => {
    function wake() { if (!document.hidden) void renew() }
    void renew()
    addEventListener("focus", wake)
    addEventListener("online", wake)
    document.addEventListener("visibilitychange", wake)
    return () => {
      sessionRequest.current?.abort()
      removeEventListener("focus", wake)
      removeEventListener("online", wake)
      document.removeEventListener("visibilitychange", wake)
    }
  }, [renew])

  const sessionKey = session?.actor ? `${session.generation}:${session.actor.id}` : ""
  const incidentId = route.view === "incident" ? route.id : undefined
  const reportReadError = (problem: ApiProblem) => {
    if (needsSessionRefresh(problem) || problem.code === "NOT_FOUND") void renew()
  }
  const dashboard = useResource(
    sessionKey && (route.view === "mission" || (route.view === "incident" && !incidentId)) ? sessionKey + "/dashboard" : "",
    (signal) => api.dashboard(session!.generation, signal),
    (data) => data.incidents.some(({ status }) => isActive(status)), reportReadError,
  )
  const incident = useResource(
    sessionKey && incidentId ? sessionKey + "/incident/" + incidentId : "",
    (signal) => api.incident(incidentId!, session!.generation, signal),
    (data) => isActive(data.incident.status), reportReadError,
  )
  const playbook = useResource(
    sessionKey && incidentId ? sessionKey + "/playbook/" + incidentId : "",
    (signal) => api.playbook(incidentId!, session!.generation, signal),
    (data) => data.steps.some(({ status }) => status === "active" || status === "waiting"), reportReadError,
  )
  const runs = useResource(
    sessionKey && incidentId ? sessionKey + "/runs/" + incidentId : "",
    (signal) => api.runs(incidentId!, session!.generation, signal),
    (data) => data.jobs.some(({ status }) => status === "PENDING" || status === "LEASED"), reportReadError,
  )
  const metrics = useResource(
    sessionKey && route.view === "mission" ? sessionKey + "/metrics" : "",
    (signal) => api.metrics(session!.generation, signal), () => false, reportReadError,
  )
  const metricsRefresh = metrics.refresh
  const dashboardFingerprint = dashboard.data ? JSON.stringify([dashboard.data.kpis, dashboard.data.incidents.map((i) => i.status)]) : ""
  useEffect(() => { if (dashboardFingerprint) metricsRefresh() }, [dashboardFingerprint, metricsRefresh])
  const jobs = useResource(
    sessionKey && route.view === "mission" ? sessionKey + "/jobs" : "",
    (signal) => api.jobs(session!.generation, signal), () => false, reportReadError,
  )
  const jobsRefresh = jobs.refresh
  useEffect(() => { if (dashboardFingerprint) jobsRefresh() }, [dashboardFingerprint, jobsRefresh])
  const approvals = useResource(
    sessionKey && route.view === "approvals" ? sessionKey + "/approvals" : "",
    (signal) => api.approvals(session!.generation, signal),
    (data) => data.approvals.some(({ status }) => status === "PENDING" || status === "APPROVED"), reportReadError,
  )

  useEffect(() => {
    if (incidentId && incident.data) setLastIncident({ id: incidentId, generation: incident.data.generation })
  }, [incidentId, incident.data?.generation])

  const routeView = route.view
  useEffect(() => {
    setError(undefined)
    setNotice("")
  }, [routeView, incidentId])

  async function signIn(role: Role, code: string) {
    const next = await api.signIn({ role, accessCode: code })
    sessionRequest.current?.abort()
    setWorkspaceSession(next)
    setDialog(undefined)
    setNotice(`Signed in as ${label(role)}.`)
    setError(undefined)
  }

  function refreshViews() {
    dashboard.refresh()
    incident.refresh()
    playbook.refresh()
    runs.refresh()
    approvals.refresh()
  }

  async function operate<T>(name: string, command: (session: SessionView) => Promise<T>, done: (result: T) => void) {
    const scope = currentSession.current
    if (mutation.current || !scope?.actor) return
    mutation.current = true
    setBusy(name)
    setError(undefined)
    setNotice("")
    try {
      const result = await command(scope)
      if (currentSession.current?.generation === scope.generation && currentSession.current?.actor?.id === scope.actor.id) {
        done(result)
        refreshViews()
      }
    } catch (failure) {
      const problem = asProblem(failure)
      setError(problem)
      if (needsSessionRefresh(problem)) void renew()
      if (problem.status === 409) refreshViews()
    } finally {
      mutation.current = false
      setBusy(undefined)
    }
  }

  function runJob(job: DetectionJobView, drill: boolean) {
    void operate("inject", (scope) => api.runJob(scope, job.id, { variant: drill ? "partial" : "success" }), (result) => {
      setLastIncident({ id: result.incidentId, generation: result.generation })
      setNotice(`${job.name} ran and raised an incident.`)
      location.hash = incidentHref(result.incidentId)
    })
  }

  function reset() {
    void operate("reset", api.reset, ({ generation }) => {
      const current = currentSession.current
      if (current) setWorkspaceSession({ ...current, generation })
      setDialog(undefined)
      void renew()
    })
  }

  async function decide(id: string, body: ApprovalDecision) {
    const scope = currentSession.current
    if (!scope?.actor) throw new ApiProblem("UNAUTHENTICATED", "Sign in before recording a decision.", 401)
    try {
      const result = await api.decide(scope, id, body)
      if (currentSession.current?.generation !== scope.generation || currentSession.current?.actor?.id !== scope.actor.id) {
        throw new ApiProblem("STALE_GENERATION", "The workspace changed while recording the decision.", 409)
      }
      approvals.refresh()
      return result
    } catch (failure) {
      const problem = asProblem(failure)
      if (needsSessionRefresh(problem)) void renew()
      approvals.refresh()
      throw problem
    }
  }

  function onDecision(result: DecisionResult) {
    setNotice(result.queued ? "Approval recorded. Execution queued." :
      result.approval.status === "REJECTED" ? "Rejection recorded. The incident remains open." : `Decision recorded. ${label(result.approval.status)}.`)
  }

  const canOperate = session?.actor?.role === "operator"
  const lastId = lastIncident?.generation === session?.generation ? lastIncident?.id : undefined

  return <WorkspaceFrame view={route.view} session={session} lastIncident={lastId} onSwitch={() => setDialog("role")} onReset={() => { setError(undefined); setDialog("reset") }}>
    {sessionError && <InlineError problem={sessionError} retry={() => void renew()}/>}
    {!session && !sessionError && <Skeleton text="Checking your session…"/>}
    {session && !session.actor && <div className="signin-layout">
      <section className="signin-intro">
        <span className="brand-icon"><Icon name="brand" size={25}/></span>
        <h1>Merchant Reliability OS</h1>
        <p>Detect, investigate and resolve merchant device, support and settlement incidents, with human approval for restricted actions and verified recovery.</p>
      </section>
      <section className="card signin-card"><h2>Sign in</h2><Login initialRole="operator" onSignIn={signIn}/></section>
    </div>}
    {session?.actor && <>
      {notice && <div className="callout callout--blue receipt" role="status"><Icon name="check"/><p>{notice}</p>
        <button type="button" className="icon-button" aria-label="Dismiss update" onClick={() => setNotice("")}><Icon name="close" size={15}/></button></div>}
      {error && dialog !== "reset" && <InlineError problem={error}/>}
      {route.view === "mission" && <>
        <div className="page-heading mission-heading">
          <div><h1>Operations overview</h1><p>Merchant device, support and settlement incidents across all zones.</p></div>
          {canOperate && <div className="mission-controls">
            <button className="button button--quiet" onClick={() => { setError(undefined); setDialog("reset") }} disabled={Boolean(busy)} data-tip="Wipe the demo data and start a clean run. For rehearsals." data-tip-pos="bottom"><Icon name="reset" size={16}/> Reset sandbox</button>
          </div>}
        </div>
        {dashboard.error && <InlineError problem={dashboard.error} retry={dashboard.refresh}/>}
        {dashboard.loading && <Skeleton text="Loading operations overview…"/>}
        {dashboard.data && <MissionControl data={dashboard.data} metrics={metrics.data} jobs={jobs.data} canRun={canOperate} busy={Boolean(busy)} runJob={runJob}/>}
      </>}
      {route.view === "incident" && (!incidentId ? <>
        <div className="page-heading"><div><h1>Incidents</h1><p>Open an incident to see what was detected, how it was traced, and whether it recovered.</p></div></div>
        {dashboard.error && <InlineError problem={dashboard.error} retry={dashboard.refresh}/>}
        {dashboard.loading && <Skeleton text="Loading incidents…"/>}
        {dashboard.data && <IncidentList incidents={dashboard.data.incidents} picker/>}
      </> : <>
        {incident.error && <InlineError problem={incident.error} retry={incident.refresh}/>}
        {incident.error?.status === 404 && <div className="card"><EmptyState title="No incident at this link" action={<a href={incidentHref()} className="button button--quiet">Browse incidents</a>}>
          The incident may belong to an earlier sandbox run.
        </EmptyState></div>}
        {incident.loading && <Skeleton text="Loading incident evidence…"/>}
        {incident.data && <WarRoom key={sessionKey + incidentId} data={incident.data} playbook={playbook.data} runs={runs.data} deepEvidence={route.evidenceId}
          resuming={busy === "resume"} canResume={Boolean(canOperate && (incident.data.incident.status === "INSUFFICIENT_EVIDENCE" ||
            (incident.data.incident.status === "FAILED" && incident.data.blocker?.includes("Retryable:"))))}
          resume={() => void operate("resume", (scope) => api.investigate(scope, incidentId), () => setNotice("Investigation queued."))}/>}
      </>)}
      {route.view === "approvals" && <>
        <div className="page-heading"><div><h1>Approvals</h1><p>Restricted actions waiting for a human decision, with the exact targets, evidence and recovery check.</p></div></div>
        {approvals.error && <InlineError problem={approvals.error} retry={approvals.refresh}/>}
        {approvals.loading && <Skeleton text="Loading approval history…"/>}
        {approvals.data && <ApprovalCenter key={sessionKey + (route.id ?? "/queue")} data={approvals.data} selectedId={route.id}
          role={session.actor.role} onDecide={decide} onDone={onDecision}/>}
      </>}
      <footer className="workspace-footer">Merchant Reliability OS · Sandbox environment</footer>
    </>}
    {dialog === "role" && session?.actor && <Dialog title="Switch role" onDismiss={() => setDialog(undefined)}>
      <Login initialRole={session.actor.role === "operator" ? "approver" : "operator"} onSignIn={signIn} button="Sign in with this role"/>
    </Dialog>}
    {dialog === "reset" && session?.actor && <Dialog title="Reset the sandbox?" onDismiss={() => setDialog(undefined)} busy={busy === "reset"}>
      <p>Start a fresh sandbox run. Current incidents, approvals and job runs are archived and the merchant network is restored.</p>
      {error && <InlineError problem={error}/>}
      <div className="dialog-actions">
        <button className="button button--secondary" disabled={Boolean(busy)} onClick={() => setDialog(undefined)}>Cancel</button>
        <button className="button button--primary" disabled={Boolean(busy)} onClick={reset}>{busy === "reset" ? "Resetting…" : "Confirm reset"}</button>
      </div>
    </Dialog>}
  </WorkspaceFrame>
}
