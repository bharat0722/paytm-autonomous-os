// Standalone core entry (`npm run dev:core`). Workflow routes report WORKFLOW_UNAVAILABLE.
import { startServer } from "./bootstrap.js"

startServer().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
