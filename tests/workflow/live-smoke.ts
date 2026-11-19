// Live provider smoke (npm run smoke:live). Runs only when configured:
//   INVESTIGATOR_MODE=sarvam SARVAM_API_KEY=... SARVAM_MODEL=... npm run smoke:live
// Uses the test fake core over temporary SQLite, so it proves the investigator's live
// read-selection and grounded finding without the platform. Prints sanitized trace only.
import { optionsFromEnv } from "../../server/workflow/config.js"
import { makeHarness } from "./support/harness.js"

const options = optionsFromEnv()
if (options.investigatorMode !== "sarvam" || !options.provider) {
  console.log(`SKIPPED live smoke: ${options.providerUnavailableReason ?? "INVESTIGATOR_MODE is not sarvam"}`)
  process.exit(0)
}

const h = makeHarness({ provider: options.provider, monotonicNow: () => performance.now() })
const id = h.inject("soundbox")
const status = await h.runUntil(id, ["APPROVAL_PENDING", "INSUFFICIENT_EVIDENCE", "ESCALATED", "FAILED"])
const view = h.view(id)
for (const t of view.trace) {
  console.log(`[${t.mode}] ${t.stage}${t.tool ? ` ${t.tool}` : ""}: ${t.summary} (${t.evidenceIds.length} evidence)`)
}
const liveRead = view.trace.find((t) => t.mode === "live_ai" && t.tool?.startsWith("read_"))
console.log("\nstatus:", status)
console.log("finding:", JSON.stringify(view.finding, null, 2))
console.log("live provider-selected DB read:", liveRead ? `${liveRead.tool} → ${liveRead.evidenceIds.length} records` : "NONE")
console.log("fallback used:", view.trace.some((t) => t.mode === "scripted_fallback"))
process.exit(liveRead ? 0 : 1)
