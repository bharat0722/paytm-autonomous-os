// Combined API launch (npm run dev:api): the platform with the real workflow factory.
import { startServer } from "../core/bootstrap.js"
import { createWorkflow } from "./index.js"

await startServer({ createWorkflow })
