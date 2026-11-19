// PROVISIONAL STUB for Owner 01's composition root (Shared agreement v1).
// Owner 01 owns this file and replaces it in the bootstrap/platform PR. It only
// pins the agreed signature so `server/workflow/entry.ts` type-checks.
import type { WorkflowFactory } from "../../shared/contracts/core.js"

export async function startServer(options?: { createWorkflow?: WorkflowFactory }): Promise<void> {
  void options
  throw new Error(
    "server/core/bootstrap.ts is a provisional stub. Merge Owner 01's platform PR to run the combined API.",
  )
}
