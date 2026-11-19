// Owner 02 workflow module: investigator, policy + approvals, authorized mock
// execution and independent verification. Composed into the core by startServer.
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import type { CoreRuntime, WorkflowFactory, WorkflowModule } from "../../shared/contracts/core.js"
import { makeExpireHandler } from "./approvals.js"
import { optionsFromEnv, type WorkflowOptions } from "./config.js"
import { makeExecuteHandler } from "./executor.js"
import { makeInvestigateHandler } from "./investigator/runner.js"
import { registerWorkflowRoutes } from "./routes.js"
import { makeVerifyHandler } from "./verifier.js"
import { countPendingApprovals, getIncidentWorkflow } from "./view.js"

export const MIGRATION_PATH = fileURLToPath(new URL("../migrations/010_workflow.sql", import.meta.url))

/** Splits the idempotent migration into single statements (the Sql port runs one at a time). */
export function workflowMigrationStatements(): string[] {
  return readFileSync(MIGRATION_PATH, "utf8")
    .split("\n").filter((l) => !l.trim().startsWith("--")).join("\n")
    .split(";").map((s) => s.trim()).filter(Boolean)
}

export function ensureWorkflowSchema(core: CoreRuntime): void {
  core.db.write((tx) => {
    for (const stmt of workflowMigrationStatements()) tx.run(stmt)
  })
}

export function createWorkflowWith(core: CoreRuntime, options: WorkflowOptions): WorkflowModule {
  ensureWorkflowSchema(core)
  return {
    handlers: {
      "workflow.investigate": makeInvestigateHandler(core, options),
      "workflow.execute": makeExecuteHandler(core, options),
      "workflow.verify": makeVerifyHandler(core, options),
      "workflow.expire": makeExpireHandler(core),
    },
    getIncidentWorkflow: (q, scope) => getIncidentWorkflow(core, q, scope),
    countPendingApprovals: (q, generation) => countPendingApprovals(core, q, generation),
    registerRoutes: (router, requireRole) => registerWorkflowRoutes(core, router, requireRole),
  }
}

export const createWorkflow: WorkflowFactory = (core) => createWorkflowWith(core, optionsFromEnv())

export type { WorkflowOptions }
