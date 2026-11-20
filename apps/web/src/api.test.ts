import { describe, expect, it, vi } from "vitest"
import { exampleApproval, exampleDashboard, exampleError, exampleSession } from "../../../shared/contracts/examples.js"
import { createApi } from "./api.js"
import { approvalsHref, incidentHref, readRoute } from "./workspace.js"

function harness(body: unknown, status = 200) {
  const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(body), {
    status, headers: { "Content-Type": "application/json", "X-Request-Id": "test-request" },
  }))
  return { fetcher, api: createApi(fetcher) }
}

const signal = AbortSignal.timeout(2000)

describe("browser API contract", () => {
  it("validates dashboard data without adding mutation headers", async () => {
    const { api, fetcher } = harness(exampleDashboard)
    expect(await api.dashboard(1, signal)).toEqual(exampleDashboard.data)
    expect(fetcher.mock.calls[0]?.[0]).toBe("/api/v1/dashboard")
    const init = fetcher.mock.calls[0]?.[1]
    expect(init).toMatchObject({ signal, credentials: "same-origin", cache: "no-store" })
    expect(new Headers(init?.headers).has("X-CSRF-Token")).toBe(false)
  })

  it("sends only credentials required by the sign-in endpoint", async () => {
    const { api, fetcher } = harness(exampleSession)
    const form = { role: "operator" as const, accessCode: "test-code" }
    await api.signIn(form)
    expect(fetcher.mock.calls[0]?.[0]).toBe("/api/v1/demo/session")
    expect(fetcher.mock.calls[0]?.[1]?.body).toBe(JSON.stringify(form))
    expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).has("X-Demo-Generation")).toBe(false)
  })

  it("binds approval decisions to the authenticated generation and exact revision", async () => {
    const result = { generation: 1, approval: exampleApproval, queued: true }
    const { api, fetcher } = harness({ data: result })
    const input = { decision: "approve" as const, proposalRevision: exampleApproval.proposalRevision }
    expect(await api.decide(exampleSession.data, "opaque/a", input)).toEqual(result)
    expect(fetcher.mock.calls[0]?.[0]).toBe("/api/v1/approvals/opaque%2Fa/decision")
    const init = fetcher.mock.calls[0]?.[1]
    expect(init?.method).toBe("POST")
    expect(init?.body).toBe(JSON.stringify(input))
    expect(new Headers(init?.headers).get("X-Demo-Generation")).toBe("1")
    expect(new Headers(init?.headers).get("X-CSRF-Token")).toBe("csrf_example")
  })

  it("blocks a mutation when the session does not have an actor or CSRF token", async () => {
    const { api, fetcher } = harness(exampleSession)
    await expect(api.reset({ generation: 1, actor: null, csrfToken: null })).rejects.toMatchObject({ code: "UNAUTHENTICATED" })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it("allows reset to advance the generation while rejecting an out-of-scope read", async () => {
    const { api, fetcher } = harness({ data: { generation: 2 } })
    expect(await api.reset(exampleSession.data)).toEqual({ generation: 2 })
    expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).get("X-Demo-Generation")).toBe("1")
    const dashboard = harness({ data: { ...exampleDashboard.data, generation: 2 } }).api
    await expect(dashboard.dashboard(1, signal)).rejects.toMatchObject({ code: "STALE_GENERATION" })
  })

  it("preserves server errors and rejects a malformed success envelope", async () => {
    await expect(harness(exampleError, 409).api.dashboard(1, signal)).rejects.toMatchObject({
      code: "STALE_GENERATION", requestId: "req_ex", status: 409,
    })
    await expect(harness({ data: { pending: 0 } }).api.approvals(1, signal)).rejects.toMatchObject({
      code: "INVALID_RESPONSE", requestId: "test-request",
    })
  })
})

describe("opaque deep links", () => {
  it("preserves encoded incident and evidence IDs across reload", () => {
    expect(readRoute(incidentHref("inc/A +", "obs/?+"))).toEqual({ view: "incident", id: "inc/A +", evidenceId: "obs/?+" })
  })

  it("supports selected approvals and safe fallback for incomplete links", () => {
    expect(readRoute(approvalsHref("apr/1"))).toEqual({ view: "approvals", id: "apr/1" })
    expect(readRoute("#/incidents/%BAD")).toEqual({ view: "incident", id: undefined, evidenceId: undefined })
    expect(readRoute("#/unknown")).toEqual({ view: "mission" })
  })
})
