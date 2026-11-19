// Bootstrap placeholder only. Owner 03 (feat/product) owns everything under apps/web.
import { StrictMode, useEffect, useState } from "react"
import { createRoot } from "react-dom/client"
import type { SessionView } from "../../../shared/contracts/http.js"

function App() {
  const [session, setSession] = useState<SessionView | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    fetch("/api/v1/session")
      .then((r) => r.json())
      .then((body: { data?: SessionView; error?: { message: string } }) => (body.data ? setSession(body.data) : setError(body.error?.message ?? "error")))
      .catch(() => setError("API not reachable on /api (start npm run dev:core)"))
  }, [])
  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: 24 }}>
      <div style={{ background: "#b42318", color: "#fff", padding: "6px 12px", fontWeight: 700, display: "inline-block" }}>SYNTHETIC DEMO</div>
      <h1>Merchant Reliability OS</h1>
      <p>Platform bootstrap is running. The product UI is built in <code>apps/web</code> by Owner 03.</p>
      <p>API: {error ? `unavailable (${error})` : session ? `generation ${session.generation}, signed in: ${session.actor ? session.actor.role : "no"}` : "checking…"}</p>
    </main>
  )
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>)
