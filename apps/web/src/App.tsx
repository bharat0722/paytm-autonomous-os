import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react"
import type {
  ApprovalDecision, DecisionResult, DemoInject, Role, Scenario, SessionView,
} from "../../../shared/contracts/http.js"
import { api, ApiProblem, asProblem, needsSessionRefresh } from "./api.js"
import { IncidentList, MissionControl, SimulationForm } from "./Mission.js"
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
    <span className="login-prompt">Use the demo access code for your role.</span>
    <label className="field">Role<select value={role} onChange={(event) => { setRole(event.target.value as Role); setError(undefined) }} disabled={busy}>
      <option value="operator">Operator</option><option value="approver">Approver</option>
    </select></label>
    <label className="field">Access code<input type="password" name="demo-code" autoComplete="current-password" value={code}
      onChange={(event) => setCode(event.target.value)} required maxLength={200} disabled={busy}/></label>
    {error && <InlineError problem={error}/>}
    <button className="button button--primary" type="submit" disabled={busy}>{busy ? "Signing in…" : button}</button>
  </form>
}

const nav: { view: "mission" | "incident" | "approvals"; name: string; icon: IconName }[] = [
  { view: "mission", name: "Mission Control", icon: "grid" },
  { view: "incident", name: "Incident War Room", icon: "incident" },
  { view: "approvals", name: "Human Approval Center", icon: "shield" },
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
      <nav aria-label="Workspace">{nav.map((item) => <a key={item.view} href={names[item.view]} aria-current={view === item.view ? "page" : undefined}>
        <Icon name={item.icon}/><span>{item.name}</span>
      </a>)}</nav>
      <div className="sidebar-note"><Icon name="lock" size={15}/><span>Hackathon prototype<br/>Synthetic data only</span></div>
    </aside>
    <div className="surface">
      <header className="topbar">
        <div className="breadcrumb"><span>Workspace</span><Icon name="chevron" size={13}/><strong>{nav.find((item) => item.view === view)?.name}</strong></div>
        <div className="top-actions">
          {view !== "mission" && role === "operator" && <button className="button button--quiet top-reset" onClick={onReset}><Icon name="reset" size={16}/>Reset demo</button>}
          <span className="synthetic"><i aria-hidden="true"/>SYNTHETIC DEMO</span>
          <span className="role-label"><Icon name="user" size={16}/>{role ? label(role) : "Not signed in"}</span>
          {role && <button className="button button--quiet switch-role" onClick={onSwitch}>Switch role</button>}
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

  function inject(scenario: Scenario, variant: DemoInject["variant"]) {
    void operate("inject", (scope) => api.inject(scope, scenario, { variant }), (result) => {
      setLastIncident({ id: result.incidentId, generation: result.generation })
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
        <p>Investigate merchant incidents, review simulated actions, and verify recovery from recorded evidence.</p>
      </section>
      <section className="card signin-card"><h2>Sign in to the demo</h2><Login initialRole="operator" onSignIn={signIn}/></section>
    </div>}
    {session?.actor && <>
      {notice && <div className="callout callout--blue receipt" role="status"><Icon name="check"/><p>{notice}</p>
        <button type="button" className="icon-button" aria-label="Dismiss update" onClick={() => setNotice("")}><Icon name="close" size={15}/></button></div>}
      {error && dialog !== "reset" && <InlineError problem={error}/>}
      {route.view === "mission" && <>
        <div className="page-heading mission-heading">
          <div><h1>Mission Control</h1><p>Monitor incidents and verified recovery across the synthetic merchant network.</p></div>
          {canOperate && <div className="mission-controls">
            <button className="button button--quiet" onClick={() => { setError(undefined); setDialog("reset") }} disabled={Boolean(busy)}><Icon name="reset" size={16}/> Reset Demo</button>
            <SimulationForm run={inject} pending={Boolean(busy)}/>
          </div>}
        </div>
        {dashboard.error && <InlineError problem={dashboard.error} retry={dashboard.refresh}/>}
        {dashboard.loading && <Skeleton text="Loading network activity…"/>}
        {dashboard.data && <MissionControl data={dashboard.data}/>}
      </>}
      {route.view === "incident" && (!incidentId ? <>
        <div className="page-heading"><div><h1>Incident War Room</h1><p>Open an incident to see its investigation, evidence and recovery.</p></div></div>
        {dashboard.error && <InlineError problem={dashboard.error} retry={dashboard.refresh}/>}
        {dashboard.loading && <Skeleton text="Loading incidents…"/>}
        {dashboard.data && <IncidentList incidents={dashboard.data.incidents} picker/>}
      </> : <>
        {incident.error && <InlineError problem={incident.error} retry={incident.refresh}/>}
        {incident.error?.status === 404 && <div className="card"><EmptyState title="No incident at this link" action={<a href={incidentHref()} className="button button--quiet">Browse incidents</a>}>
          The link may belong to an earlier demo generation.
        </EmptyState></div>}
        {incident.loading && <Skeleton text="Loading incident evidence…"/>}
        {incident.data && <WarRoom key={sessionKey + incidentId} data={incident.data} deepEvidence={route.evidenceId}
          resuming={busy === "resume"} canResume={Boolean(canOperate && (incident.data.incident.status === "INSUFFICIENT_EVIDENCE" ||
            (incident.data.incident.status === "FAILED" && incident.data.blocker?.includes("Retryable:"))))}
          resume={() => void operate("resume", (scope) => api.investigate(scope, incidentId), () => setNotice("Investigation queued."))}/>}
      </>)}
      {route.view === "approvals" && <>
        <div className="page-heading"><div><h1>Human Approval Center</h1><p>Review exact actions, their evidence, and how recovery will be verified.</p></div></div>
        {approvals.error && <InlineError problem={approvals.error} retry={approvals.refresh}/>}
        {approvals.loading && <Skeleton text="Loading approval history…"/>}
        {approvals.data && <ApprovalCenter key={sessionKey + (route.id ?? "/queue")} data={approvals.data} selectedId={route.id}
          role={session.actor.role} onDecide={decide} onDone={onDecision}/>}
      </>}
      <footer className="workspace-footer">Hackathon prototype · No live Paytm connections</footer>
    </>}
    {dialog === "role" && session?.actor && <Dialog title="Switch demo role" onDismiss={() => setDialog(undefined)}>
      <Login initialRole={session.actor.role === "operator" ? "approver" : "operator"} onSignIn={signIn} button="Sign in with this role"/>
    </Dialog>}
    {dialog === "reset" && session?.actor && <Dialog title="Reset this demo?" onDismiss={() => setDialog(undefined)} busy={busy === "reset"}>
      <p>Start a fresh demo generation and clear this workspace’s current incidents and approval requests.</p>
      {error && <InlineError problem={error}/>}
      <div className="dialog-actions">
        <button className="button button--secondary" disabled={Boolean(busy)} onClick={() => setDialog(undefined)}>Cancel</button>
        <button className="button button--primary" disabled={Boolean(busy)} onClick={reset}>{busy === "reset" ? "Resetting…" : "Confirm reset"}</button>
      </div>
    </Dialog>}
  </WorkspaceFrame>
}
