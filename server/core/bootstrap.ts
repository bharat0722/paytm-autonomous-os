// startServer: the single server factory. The standalone core entry calls startServer();
// Owner 02's server/workflow/entry.ts calls startServer({ createWorkflow }).
import type { WorkflowFactory } from "../../shared/contracts/core.js"
import { createApp } from "./app.js"
import { loadConfig } from "./config.js"

export async function startServer(options?: { createWorkflow?: WorkflowFactory }): Promise<void> {
  const config = loadConfig()
  const host = config.host ?? "127.0.0.1"
  const core = createApp({ config, ...(options?.createWorkflow ? { createWorkflow: options.createWorkflow } : {}) })
  core.runner.start(config.workerIntervalMs)
  await new Promise<void>((resolveListen) => {
    const server = core.app.listen(config.port, host, () => {
      console.log(`[mros] SYNTHETIC DEMO API on http://${host}:${config.port}/api/v1 · db=${config.dbPath} · workflow=${core.workflow ? "assembled" : "unavailable"}`)
      resolveListen()
    })
    const shutdown = () => { server.close(); core.close(); process.exit(0) }
    process.once("SIGINT", shutdown)
    process.once("SIGTERM", shutdown)
  })
}
