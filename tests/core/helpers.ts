import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { CoreConfig } from "../../server/core/config.js"
import { createApp, type CoreApp } from "../../server/core/app.js"
import { openDb } from "../../server/core/db.js"
import { fakeClock } from "../../server/core/util.js"
import type { WorkflowFactory } from "../../shared/contracts/core.js"

export const TEST_CODES = { operator: "op-test-code-1", approver: "ap-test-code-2" }

export function tempDbPath(): { path: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), "mros-"))
  return { path: join(dir, "demo.sqlite"), cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

export function testConfig(dbPath: string): CoreConfig {
  return {
    port: 0, dbPath, sessionSecret: "x".repeat(40), operatorCode: TEST_CODES.operator, approverCode: TEST_CODES.approver,
    investigatorMode: "scripted", workerIntervalMs: 10, sessionTtlHours: 12
  }
}

export function makeCore(opts: { dbPath?: string; createWorkflow?: WorkflowFactory } = {}): CoreApp & { clock: ReturnType<typeof fakeClock>; cleanup(): void } {
  const tmp = opts.dbPath ? null : tempDbPath()
  const dbPath = opts.dbPath ?? tmp!.path
  const clock = fakeClock()
  const core = createApp({ config: testConfig(dbPath), clock, db: openDb(dbPath), webDistDir: join(tmpdir(), "mros-no-web"),
    ...(opts.createWorkflow ? { createWorkflow: opts.createWorkflow } : {}) })
  return Object.assign(core, { clock, cleanup: () => { core.close(); tmp?.cleanup() } })
}

export const scopeOf = (generation: number, incidentId: string) => ({ generation, incidentId })
