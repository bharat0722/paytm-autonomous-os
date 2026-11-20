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
  await expect(page.getByText("SYNTHETIC DEMO", { exact: true })).toBeVisible()
  await page.getByRole("combobox", { name: "Role", exact: true }).selectOption(role)
  await page.getByLabel("Access code", { exact: true }).fill(app.codes[role])
  await page.getByRole("button", { name: "Sign in", exact: true }).click()
  await expect(page.getByRole("heading", { name: "Mission Control", exact: true })).toBeVisible()
  return page
}

function nav(page: Page) { return page.getByRole("navigation", { name: "Workspace" }) }
async function mission(page: Page) { await nav(page).getByRole("link", { name: "Mission Control" }).click() }
async function approvalCenter(page: Page) { await nav(page).getByRole("link", { name: "Human Approval Center" }).click() }

async function apiRead<T>(page: Page, origin: string, path: string): Promise<T> {
  const response = await page.request.get(origin + "/api/v1" + path)
  expect(response.ok()).toBe(true)
  return (await response.json()).data as T
}

async function reset(page: Page) {
  await mission(page)
  await page.getByRole("button", { name: "Reset Demo", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "Reset this demo?" })
  await dialog.getByRole("button", { name: "Confirm reset" }).click()
  await expect(dialog).toBeHidden()
  await expect(page.getByTestId("kpi-activeIncidents")).toHaveText("0")
}

async function startSoundbox(page: Page, variant: "success" | "partial" = "success") {
  await page.getByLabel("Recovery variant").selectOption(variant)
  await page.getByRole("button", { name: "Run Simulation", exact: true }).click()
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
  const name = decision === "approve" ? "Approve simulated restart" : "Reject"
  await detail.getByRole("button", { name, exact: true }).click()
  const dialog = page.getByRole("dialog", { name: decision === "approve" ? "Confirm simulated restart" : "Reject restart request" })
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
      await expect(operator.getByText("Scripted fallback", { exact: true }).first()).toBeVisible()

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
        await expect(operator.getByRole("button", { name: "Approve simulated restart" })).toHaveCount(0)
        const session = await apiRead<SessionView>(operator, app.origin, "/session")
        const denied = await operator.request.post(app.origin + "/api/v1/approvals/" + proposal.id + "/decision", {
          data: { decision: "approve", proposalRevision: proposal.proposalRevision },
          headers: { "X-Demo-Generation": String(session.generation), "X-CSRF-Token": session.csrfToken! },
        })
        expect(denied.status()).toBe(403)
        await operator.goto(url)
        await approvalCenter(approver)
        await expect(approver.getByRole("button", { name: "Approve simulated restart" })).toBeVisible()
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
  await approver.getByRole("button", { name: "Approve simulated restart" }).click()
  const dialog = approver.getByRole("dialog", { name: "Confirm simulated restart" })
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
  await operator.getByRole("button", { name: "Run Simulation", exact: true }).click()
  await expect(operator.getByTestId("incident-status")).toHaveText("Detected")
  const oldUrl = operator.url()
  await operator.getByRole("button", { name: "Reset demo", exact: true }).click()
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
  await expect(page.getByRole("heading", { name: "Sign in to the demo" })).toBeVisible()
  expect((await page.request.get(app.origin + "/api/v1/approvals")).status()).toBe(401)
  await page.getByLabel("Access code").fill("invalid-code")
  await page.getByRole("button", { name: "Sign in", exact: true }).click()
  await expect(page.getByRole("alert")).toContainText("Invalid access code")
  await page.getByLabel("Access code").fill(app.codes.operator)
  await page.getByRole("button", { name: "Sign in", exact: true }).click()
  await expect(page.getByRole("heading", { name: "Human Approval Center", exact: true })).toBeVisible()
  await page.route("**/api/v1/dashboard", (route) => route.abort("failed"), { times: 1 })
  await mission(page)
  await expect(page.getByRole("alert")).toContainText("Connection interrupted")
  await page.getByRole("button", { name: "Try again" }).click()
  await expect(page.getByTestId("kpi-activeIncidents")).toHaveText("0")
  await expect(page.getByRole("alert")).toHaveCount(0)
})

test("support ticket linking and read-only settlement escalation have their own outcomes", async ({ browser, app }) => {
  const page = await openAs(browser, app, "operator")
  const select = page.getByLabel("Scenario", { exact: true })
  await select.selectOption("duplicate-tickets")
  await page.getByRole("button", { name: "Run Simulation", exact: true }).click()
  await expect(page.getByTestId("incident-status")).toHaveText("Ticket linking complete")
  await expect(page.getByTestId("recovery-count")).toHaveCount(0)
  await expect(page.getByTestId("ticket-check-count")).toContainText("ticket links verified")
  await mission(page)
  await select.selectOption("settlement-discrepancy")
  await page.getByRole("button", { name: "Run Simulation", exact: true }).click()
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
      await expect(page.getByText("SYNTHETIC DEMO", { exact: true })).toBeVisible()
      await expect(page.getByRole("main").getByRole("heading", { level: 1 })).toBeVisible()
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
    }
  }
  await page.reload()
  await expect(page.getByRole("heading", { name: "Human Approval Center", exact: true })).toBeVisible()
  await page.keyboard.press("Tab")
  await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused()
  await page.keyboard.press("Enter")
  await expect(page.getByRole("main")).toBeFocused()
  await page.getByRole("button", { name: "Switch role" }).click()
  await expect(page.getByRole("dialog", { name: "Switch demo role" })).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(page.getByRole("button", { name: "Switch role" })).toBeFocused()
  await page.getByRole("button", { name: "Switch role" }).click()
  const roleDialog = page.getByRole("dialog", { name: "Switch demo role" })
  await roleDialog.getByLabel("Access code").fill(app.codes.approver)
  await roleDialog.getByRole("button", { name: "Sign in with this role" }).click()
  await expect(roleDialog).toBeHidden()
  await expect(page.getByRole("button", { name: "Approve simulated restart" })).toBeVisible()
})

test.describe("scripted fallback", () => {
  test.use({ unavailableProvider: true })
  test("failed provider configuration is visible in the real persisted trace", async ({ browser, app }) => {
    const page = await openAs(browser, app, "operator")
    const { id } = await startSoundbox(page)
    const incident = await apiRead<IncidentView>(page, app.origin, "/incidents/" + id)
    expect(incident.workflow.trace.some((entry) => entry.mode === "scripted_fallback")).toBe(true)
    await expect(page.getByText("Scripted fallback", { exact: true }).first()).toBeVisible()
    await page.getByRole("button", { name: "Show all activity" }).click()
    await expect(page.getByText(/No model configured for this test/).first()).toBeVisible()
  })
})
