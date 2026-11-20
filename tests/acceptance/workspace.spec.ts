import { existsSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { randomBytes, randomUUID } from "node:crypto"
import type { Server } from "node:http"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { expect, test as base, type Browser, type Page } from "@playwright/test"
import type { ApprovalQueue, DashboardView, IncidentView, Role, SessionView } from "../../shared/contracts/http.js"
import { createApp } from "../../server/core/app.js"
import { createWorkflowWith } from "../../server/workflow/index.js"
import { DEFAULT_OPTIONS } from "../../server/workflow/config.js"

type AppFixture = {
  origin: string
  codes: Record<Role, string>
  advance: (milliseconds: number) => void
  pause: () => void
  resume: () => void
  restart: () => Promise<void>
}

const test = base.extend<{ app: AppFixture; unavailableProvider: boolean }>({
  unavailableProvider: [false, { option: true }],
  app: async ({ unavailableProvider }, use) => {
    const webDistDir = resolve("dist/web")
    if (!existsSync(join(webDistDir, "index.html"))) throw new Error("Run npm run build before the combined browser suite.")
    const temp = await mkdtemp(join(tmpdir(), "mros-browser-"))
    const codes = { operator: randomUUID(), approver: randomUUID() }
    const config = {
      port: 0, dbPath: join(temp, "e2e.sqlite"), sessionSecret: randomBytes(32).toString("hex"),
      operatorCode: codes.operator, approverCode: codes.approver, investigatorMode: "scripted" as const,
      workerIntervalMs: 35, sessionTtlHours: 12,
    }
    let offset = 0
    let port = 0
    let server: Server | undefined
    let core: ReturnType<typeof createApp> | undefined

    async function start() {
      core = createApp({
        config, webDistDir, clock: { now: () => new Date(Date.now() + offset).toISOString() },
        createWorkflow: (runtime) => createWorkflowWith(runtime, {
          ...DEFAULT_OPTIONS, verifyIntervalMs: 140, investigatorMode: unavailableProvider ? "sarvam" : "scripted",
          provider: null, providerUnavailableReason: unavailableProvider ? "No model configured for this test" : null,
        }),
      })
      core.runner.start(config.workerIntervalMs)
      const app = core.app
      server = await new Promise<Server>((resolveListen, reject) => {
        const listener = app.listen(port, "127.0.0.1", () => resolveListen(listener))
        listener.once("error", reject)
      })
      const address = server.address()
      if (!address || typeof address === "string") throw new Error("Expected a local HTTP port")
      port = address.port
    }

    async function stop() {
      const listener = server
      if (listener) await new Promise<void>((resolveClose) => {
        listener.close(() => resolveClose())
        listener.closeAllConnections()
      })
      server = undefined
      core?.close()
      core = undefined
    }

    try {
      await start()
      await use({
        origin: `http://127.0.0.1:${port}`, codes,
        advance: (ms) => { offset += ms },
        pause: () => core?.runner.stop(),
        resume: () => core?.runner.start(config.workerIntervalMs),
        restart: async () => { await stop(); await start() },
      })
    } finally {
      await stop()
      await rm(temp, { recursive: true, force: true })
    }
  },
})

test.use({ actionTimeout: 8_000 })

test.afterEach(async ({ browser }) => {
  await Promise.all(browser.contexts().map((context) => context.close()))
})

async function openAs(browser: Browser, app: AppFixture, role: Role, viewport = { width: 1440, height: 900 }) {
  const context = await browser.newContext({ viewport, reducedMotion: "reduce" })
  const page = await context.newPage()
  await page.goto(app.origin)
  await expect(page.locator(".env-badge")).toBeVisible()
  await page.getByRole("combobox", { name: "Role", exact: true }).selectOption(role)
  await page.getByLabel("Access code", { exact: true }).fill(app.codes[role])
  await page.getByRole("button", { name: "Sign in", exact: true }).click()
  await expect(page.getByRole("heading", { name: "Operations overview", exact: true })).toBeVisible()
  return page
}

function nav(page: Page) { return page.getByRole("navigation", { name: "Workspace" }) }
async function mission(page: Page) { await nav(page).getByRole("link", { name: "Overview" }).click() }
async function approvalCenter(page: Page) { await nav(page).getByRole("link", { name: "Approvals" }).click() }

async function apiRead<T>(page: Page, origin: string, path: string): Promise<T> {
  const response = await page.request.get(origin + "/api/v1" + path)
  expect(response.ok()).toBe(true)
  return (await response.json()).data as T
}

test("payment intake raises an incident with readable source evidence and a human owner", async ({ browser, app }) => {
  const operator = await openAs(browser, app, "operator")
  const session = await apiRead<SessionView>(operator, app.origin, "/session")
  const common = { merchantRef: "M001", orderRef: "checkout-1", amountPaise: 12500, currency: "INR", revision: 1 }
  for (const signal of [
    { ...common, eventId: "order-unpaid", source: "merchant-order", status: "UNPAID" },
    { ...common, eventId: "transaction-captured", source: "gateway", status: "CAPTURED", transactionRef: "txn-1" },
  ]) {
    const response = await operator.request.post(app.origin + "/api/v1/demo/payment-signals", {
      headers: { "X-CSRF-Token": session.csrfToken!, "X-Demo-Generation": String(session.generation) },
      data: signal,
    })
    expect(response.status()).toBe(202)
  }
  app.advance(120_001)
  await expect.poll(async () => (await apiRead<DashboardView>(operator, app.origin, "/dashboard")).incidents.length).toBe(1)
  await operator.reload()
  await operator.getByRole("link", { name: /Captured payment, unpaid order/ }).click()
  await expect(operator.getByText("Assigned to Payment Gateway Integration Support")).toBeVisible()
  await expect(operator.getByText("L1 · Exact match")).toBeVisible()
  const evidence = operator.getByRole("region", { name: "Payment and order evidence" })
  await expect(evidence.getByRole("button", { name: "Merchant order · UNPAID" })).toBeVisible()
  await evidence.getByRole("button", { name: "Gateway status · CAPTURED" }).click()
  await expect(operator.getByRole("dialog").getByText("txn-1")).toBeVisible()
})

async function reset(page: Page) {
  await mission(page)
  await page.getByRole("button", { name: "Reset sandbox", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "Reset the sandbox?" })
  await dialog.getByRole("button", { name: "Confirm reset" }).click()
  await expect(dialog).toBeHidden()
  await expect(page.getByTestId("kpi-activeIncidents")).toHaveText("0")
}

async function runJob(page: Page, name: string, drill = false) {
  const jobs = page.getByRole("region", { name: "Detection jobs" })
  if (drill) await jobs.getByLabel("Failure drill").check()
  await jobs.getByRole("button", { name: `Run ${name} now` }).click()
  await expect(page).toHaveURL(/#\/incidents\/[^/]+$/)
}

async function startSoundbox(page: Page, variant: "success" | "partial" = "success") {
  await runJob(page, "Payment voice-alert health sweep", variant === "partial")
  await expect(page).toHaveURL(/#\/incidents\/[^/]+$/)
  const url = page.url()
  const id = decodeURIComponent(url.slice(url.lastIndexOf("/") + 1))
  await expect(page.getByTestId("incident-status")).toHaveText("Awaiting approval", { timeout: 12000 })
  await expect(page.getByTestId("recovery-count")).toHaveText("20 / 24")
  return { id, url }
}

async function recordDecision(page: Page, decision: "approve" | "reject", note?: string) {
  await approvalCenter(page)
  const detail = page.getByRole("region", { name: "Approval details" })
  const name = decision === "approve" ? "Approve remote restart" : "Reject"
  await detail.getByRole("button", { name, exact: true }).click()
  const dialog = page.getByRole("dialog", { name: decision === "approve" ? "Confirm remote restart" : "Reject restart request" })
  await expect(dialog.getByRole("list", { name: "Exact target devices" }).getByRole("listitem")).toHaveCount(4)
  if (note) await dialog.getByLabel(/Reason/).fill(note)
  await dialog.getByRole("button", { name: decision === "approve" ? "Confirm approval" : "Confirm rejection" }).click()
  await expect(dialog).toBeHidden()
}

async function capture(page: Page, name: string) {
  if (!process.env.E2E_SCREENSHOT_DIR) return
  await page.screenshot({ path: join(process.env.E2E_SCREENSHOT_DIR, name + ".jpg"), fullPage: !name.endsWith("-mobile"), type: "jpeg", quality: 83 })
}

test("three clean Soundbox runs recover 20 of 24, preserve the pending decision, and close at 24 of 24", async ({ browser, app }, info) => {
  const operator = await openAs(browser, app, "operator")
  const approver = await openAs(browser, app, "approver")
  const errors: string[] = []
  operator.on("pageerror", (error) => errors.push(error.message))
  approver.on("pageerror", (error) => errors.push(error.message))

  for (let run = 0; run < 3; run += 1) {
    await test.step(`Clean run ${run + 1}`, async () => {
      await reset(operator)
      await approver.reload()
      await mission(approver)
      await expect(approver.getByTestId("kpi-pendingApprovals")).toHaveText("0")
      const { id, url } = await startSoundbox(operator)
      const pending = await apiRead<IncidentView>(operator, app.origin, "/incidents/" + id)
      const queue = await apiRead<ApprovalQueue>(approver, app.origin, "/approvals")
      expect(pending.workflow.recovery).toMatchObject({ total: 24, recovered: 20 })
      expect(queue.approvals).toHaveLength(1)
      const proposal = queue.approvals[0]!
      expect(proposal.targetDeviceIds).toEqual(pending.workflow.recovery!.remainingDeviceIds)
      await expect(operator.getByRole("heading", { name: "What the AI found" })).toBeVisible()
      await expect(operator.getByTestId("ai-engine")).toHaveText(/Scripted fallback/)

      if (run === 0) {
        await app.restart()
        await operator.reload()
        await expect(operator.getByTestId("recovery-count")).toHaveText("20 / 24")
        await capture(operator, "war-room-desktop")
        await operator.setViewportSize({ width: 390, height: 844 })
        await capture(operator, "war-room-mobile")
        await operator.setViewportSize({ width: 1440, height: 900 })
        await approvalCenter(operator)
        await expect(operator.getByText("A signed-in approver can record a decision.")).toBeVisible()
        await expect(operator.getByRole("button", { name: "Approve remote restart" })).toHaveCount(0)
        const session = await apiRead<SessionView>(operator, app.origin, "/session")
        const denied = await operator.request.post(app.origin + "/api/v1/approvals/" + proposal.id + "/decision", {
          data: { decision: "approve", proposalRevision: proposal.proposalRevision },
          headers: { "X-Demo-Generation": String(session.generation), "X-CSRF-Token": session.csrfToken! },
        })
        expect(denied.status()).toBe(403)
        await operator.goto(url)
        await approvalCenter(approver)
        await expect(approver.getByRole("button", { name: "Approve remote restart" })).toBeVisible()
        await capture(approver, "approval-desktop")
        await approver.setViewportSize({ width: 390, height: 844 })
        await capture(approver, "approval-mobile")
        await approver.setViewportSize({ width: 1440, height: 900 })
        await mission(operator)
        await expect(operator.getByTestId("kpi-pendingApprovals")).toHaveText("1")
        await capture(operator, "mission-control-desktop")
        await operator.setViewportSize({ width: 390, height: 844 })
        await capture(operator, "mission-control-mobile")
        await operator.setViewportSize({ width: 1440, height: 900 })
        await operator.goto(url)
      }

      await recordDecision(approver, "approve")
      await expect(approver.getByRole("status").getByText("Approval recorded. Execution queued.")).toBeVisible()
      await operator.goto(url)
      await expect(operator.getByTestId("incident-status")).toHaveText("Resolved")
      await expect(operator.getByTestId("recovery-count")).toHaveText("24 / 24")
      const complete = await apiRead<IncidentView>(operator, app.origin, "/incidents/" + id)
      expect(complete.workflow.recovery).toMatchObject({ total: 24, recovered: 24, remainingDeviceIds: [] })
      expect(complete.workflow.actions.filter(({ kind }) => kind === "MOCK_RESTART_DEVICE")).toHaveLength(1)
      if (run === 0) {
        const session = await apiRead<SessionView>(approver, app.origin, "/session")
        const replay = await approver.request.post(app.origin + "/api/v1/approvals/" + proposal.id + "/decision", {
          data: { decision: "approve", proposalRevision: proposal.proposalRevision },
          headers: { "X-Demo-Generation": String(session.generation), "X-CSRF-Token": session.csrfToken! },
        })
        expect(replay.status()).toBe(200)
        const afterReplay = await apiRead<IncidentView>(operator, app.origin, "/incidents/" + id)
        expect(afterReplay.workflow.actions.filter(({ kind }) => kind === "MOCK_RESTART_DEVICE")).toHaveLength(1)
        await operator.getByRole("tab", { name: /Actions & approvals/ }).click()
        await expect(operator.getByRole("button", { name: "View device checks" })).toBeVisible()
        await operator.getByRole("button", { name: "View device checks" }).click()
        await expect(operator.getByRole("row").filter({ hasText: "Passed" })).toHaveCount(24)
        await operator.getByRole("button", { name: "Hide device checks" }).click()
        await capture(operator, "war-room-resolved")
      }

      await mission(operator)
      const dashboard = await apiRead<DashboardView>(operator, app.origin, "/dashboard")
      await expect(operator.getByTestId("kpi-verifiedResolved")).toHaveText(String(dashboard.kpis.verifiedResolved))
      await expect(operator.getByTestId("kpi-activeIncidents")).toHaveText("0")
    })
  }
  expect(errors).toEqual([])
  await info.attach("workflow-result", { contentType: "text/plain", body: "Three real SQLite runs reached 20/24, recorded one exact approval, and verified 24/24." })
})

test("a rejection leaves 20 of 24 verified and never executes the proposed restart", async ({ browser, app }) => {
  const operator = await openAs(browser, app, "operator")
  const approver = await openAs(browser, app, "approver")
  const { id, url } = await startSoundbox(operator)
  await recordDecision(approver, "reject", "Escalate to field operations.")
  await expect(approver.getByText("Rejection recorded. The incident remains open.")).toBeVisible()
  await expect(approver.getByText("Escalate to field operations.")).toBeVisible()
  await operator.goto(url)
  await expect(operator.getByTestId("incident-status")).toHaveText("Escalated")
  await expect(operator.getByTestId("recovery-count")).toHaveText("20 / 24")
  const incident = await apiRead<IncidentView>(operator, app.origin, "/incidents/" + id)
  expect(incident.workflow.actions.find(({ kind }) => kind === "MOCK_RESTART_DEVICE")?.status).not.toMatch(/^(SUCCEEDED|PARTIAL)$/)
})

test("partial recovery stays escalated at 23 of 24 after approval", async ({ browser, app }) => {
  const operator = await openAs(browser, app, "operator")
  const approver = await openAs(browser, app, "approver")
  const { id, url } = await startSoundbox(operator, "partial")
  await recordDecision(approver, "approve")
  await operator.goto(url)
  await expect(operator.getByTestId("incident-status")).toHaveText("Escalated")
  await expect(operator.getByTestId("recovery-count")).toHaveText("23 / 24")
  const incident = await apiRead<IncidentView>(operator, app.origin, "/incidents/" + id)
  expect(incident.workflow.recovery?.remainingDeviceIds).toHaveLength(1)
  await capture(operator, "war-room-partial")
})

test("expired confirmation reports the API error and keeps the incident unresolved", async ({ browser, app }) => {
  const operator = await openAs(browser, app, "operator")
  const approver = await openAs(browser, app, "approver")
  const { url } = await startSoundbox(operator)
  await approvalCenter(approver)
  await approver.getByRole("button", { name: "Approve remote restart" }).click()
  const dialog = approver.getByRole("dialog", { name: "Confirm remote restart" })
  await expect(dialog).toBeVisible()
  app.advance(DEFAULT_OPTIONS.approvalTtlMs + 1)
  await dialog.getByRole("button", { name: "Confirm approval" }).click()
  await expect(dialog.getByRole("alert")).toContainText(/expired/i)
  await dialog.getByRole("button", { name: "Cancel" }).click()
  await expect(approver.getByRole("region", { name: "Approval details" }).getByText("Expired", { exact: true })).toBeVisible()
  await operator.goto(url)
  await expect(operator.getByTestId("incident-status")).toHaveText("Escalated")
  await expect(operator.getByTestId("recovery-count")).toHaveText("20 / 24")
})

test("reset during a queued run clears current views and fences the old generation", async ({ browser, app }) => {
  const operator = await openAs(browser, app, "operator")
  app.pause()
  const previous = await apiRead<SessionView>(operator, app.origin, "/session")
  await runJob(operator, "Payment voice-alert health sweep")
  await expect(operator.getByTestId("incident-status")).toHaveText("Detected")
  const oldUrl = operator.url()
  await operator.getByRole("button", { name: "Reset sandbox", exact: true }).click()
  await operator.getByRole("button", { name: "Confirm reset" }).click()
  await expect(operator).toHaveURL(/#\/$/)
  await expect(operator.getByTestId("kpi-activeIncidents")).toHaveText("0")
  app.resume()
  const stale = await operator.request.post(app.origin + "/api/v1/demo/inject/soundbox", {
    data: { variant: "success" },
    headers: { "X-Demo-Generation": String(previous.generation), "X-CSRF-Token": previous.csrfToken! },
  })
  expect(stale.status()).toBe(409)
  await operator.goto(oldUrl)
  await expect(operator.getByText("No incident at this link")).toBeVisible()
  await mission(operator)
  await expect(operator.getByTestId("kpi-activeIncidents")).toHaveText("0")
})

test("anonymous users and API failures have clear recovery actions", async ({ browser, app }) => {
  const context = await browser.newContext()
  const page = await context.newPage()
  await page.goto(app.origin + "/#/approvals")
  await expect(page.getByRole("heading", { name: "Sign in", exact: true })).toBeVisible()
  expect((await page.request.get(app.origin + "/api/v1/approvals")).status()).toBe(401)
  await page.getByLabel("Access code").fill("invalid-code")
  await page.getByRole("button", { name: "Sign in", exact: true }).click()
  await expect(page.getByRole("alert")).toContainText("Invalid access code")
  await page.getByLabel("Access code").fill(app.codes.operator)
  await page.getByRole("button", { name: "Sign in", exact: true }).click()
  await expect(page.getByRole("heading", { name: "Approvals", exact: true })).toBeVisible()
  await page.route("**/api/v1/dashboard", (route) => route.abort("failed"), { times: 1 })
  await mission(page)
  await expect(page.getByRole("alert")).toContainText("Connection interrupted")
  await page.getByRole("button", { name: "Try again" }).click()
  await expect(page.getByTestId("kpi-activeIncidents")).toHaveText("0")
  await expect(page.getByRole("alert")).toHaveCount(0)
})

test("support ticket linking and read-only settlement escalation have their own outcomes", async ({ browser, app }) => {
  const page = await openAs(browser, app, "operator")
  await runJob(page, "Support queue de-duplication")
  await expect(page.getByTestId("incident-status")).toHaveText("Ticket linking complete")
  await expect(page.getByTestId("recovery-count")).toHaveCount(0)
  await expect(page.getByTestId("ticket-check-count")).toContainText("ticket links verified")
  await mission(page)
  await runJob(page, "Daily settlement reconciliation")
  await expect(page.getByTestId("incident-status")).toHaveText("Escalated")
  await expect(page.getByRole("heading", { name: "Read-only settlement handoff" })).toBeVisible()
  await expect(page.getByText(/Assigned to/)).toBeVisible()
})

test("the three views fit the brief’s viewport sizes and visible focus works", async ({ browser, app }) => {
  const page = await openAs(browser, app, "operator")
  const { url } = await startSoundbox(page)
  for (const width of [1440, 1280, 1024, 390]) {
    await page.setViewportSize({ width, height: 900 })
    for (const path of ["/#/", new URL(url).hash, "/#/approvals"]) {
      await page.goto(app.origin + path)
      await expect(page.locator(".env-badge")).toBeVisible()
      await expect(page.getByRole("main").getByRole("heading", { level: 1 })).toBeVisible()
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
    }
  }
  await page.reload()
  await expect(page.getByRole("heading", { name: "Approvals", exact: true })).toBeVisible()
  await page.keyboard.press("Tab")
  await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused()
  await page.keyboard.press("Enter")
  await expect(page.getByRole("main")).toBeFocused()
  await page.getByRole("button", { name: "Switch role" }).click()
  await expect(page.getByRole("dialog", { name: "Switch role" })).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(page.getByRole("button", { name: "Switch role" })).toBeFocused()
  await page.getByRole("button", { name: "Switch role" }).click()
  const roleDialog = page.getByRole("dialog", { name: "Switch role" })
  await roleDialog.getByLabel("Access code").fill(app.codes.approver)
  await roleDialog.getByRole("button", { name: "Sign in with this role" }).click()
  await expect(roleDialog).toBeHidden()
  await expect(page.getByRole("button", { name: "Approve remote restart" })).toBeVisible()
})

test.describe("scripted fallback", () => {
  test.use({ unavailableProvider: true })
  test("failed provider configuration is visible in the real persisted trace", async ({ browser, app }) => {
    const page = await openAs(browser, app, "operator")
    const { id } = await startSoundbox(page)
    const incident = await apiRead<IncidentView>(page, app.origin, "/incidents/" + id)
    expect(incident.workflow.trace.some((entry) => entry.mode === "scripted_fallback")).toBe(true)
    await expect(page.getByTestId("ai-engine")).toHaveText(/Scripted fallback/)
    await page.getByRole("tab", { name: /Investigation/ }).click()
    await expect(page.getByText(/No model configured for this test/).first()).toBeVisible()
  })
})

test("release candidate: grouping explanation, silent merchants, merchant view, honest AI label, measured metrics and full Scenario B linking", async ({ browser, app }) => {
  const operator = await openAs(browser, app, "operator")
  await reset(operator)
  const { id } = await startSoundbox(operator)

  const grouping = operator.getByRole("region", { name: "Why these were grouped" })
  await expect(grouping.getByTestId("grouping-signals")).toContainText("SBX-AI-2")
  await expect(grouping.getByTestId("grouping-signals")).toContainText("7.4.1")
  await expect(grouping.getByTestId("grouping-counts")).toHaveText(/24 records · 21 merchants · 24 devices/)
  await expect(grouping.getByTestId("grouping-excluded")).toHaveText("6 unrelated record(s)")
  await expect(grouping.getByTestId("outreach")).toContainText("9merchants complained")
  await expect(grouping.getByTestId("outreach")).toContainText("12affected but silent")
  await expect(operator.getByTestId("ai-engine")).toHaveText(/Scripted fallback/)

  // Merchant 360 from a silent merchant.
  await grouping.getByText("Silent merchants", { exact: true }).click()
  await grouping.getByTestId("outreach").locator("button.record-link").first().click()
  await expect(operator.getByTestId("merchant-360")).toContainText("NOTIFICATION_FAILED")
  await expect(operator.getByTestId("merchant-360")).toContainText("payment SUCCESS")
  await operator.keyboard.press("Escape")

  // Detection opens the chronology; the audit API starts with INCIDENT_DETECTED.
  const audit = await apiRead<{ audit: { event: string }[] }>(operator, app.origin, `/incidents/${id}/audit`)
  expect(audit.audit[0]!.event).toBe("INCIDENT_DETECTED")

  // Restart request through the PRD action endpoint is pending, never executed.
  const session = await apiRead<SessionView>(operator, app.origin, "/session")
  const pendingReq = await operator.request.post(`${app.origin}/api/v1/incidents/${id}/actions`, {
    headers: { "X-CSRF-Token": session.csrfToken!, "X-Demo-Generation": String(session.generation) }, data: { kind: "MOCK_RESTART_DEVICE" },
  })
  expect(pendingReq.status()).toBe(202)
  expect((await pendingReq.json()).data.path).toBe("APPROVAL_PENDING")

  const approver = await openAs(browser, app, "approver")
  await recordDecision(approver, "approve")
  await operator.goto(app.origin + "/#/incidents/" + encodeURIComponent(id))
  await expect(operator.getByTestId("recovery-count")).toHaveText("24 / 24", { timeout: 12000 })

  await mission(operator)
  await expect(operator.getByTestId("metric-verified_recovery")).toContainText("24 / 24")
  await expect(operator.getByTestId("metric-grouping_quality")).toContainText("100%")
  await expect(operator.getByTestId("metric-policy_compliance")).toContainText("100%")
  await expect(operator.getByTestId("metric-demo_reproducibility")).toContainText("1 / 1")

  // Scenario B: every merchant's duplicates linked and verified.
  await runJob(operator, "Support queue de-duplication")
  await expect(operator.getByTestId("ticket-check-count")).toHaveText("7 / 7 ticket links verified", { timeout: 12000 })
})
