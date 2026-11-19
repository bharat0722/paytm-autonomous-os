import type { ModelProvider } from "./investigator/provider.js"
import { createSarvamProvider } from "./investigator/sarvam.js"

export interface WorkflowOptions {
  /** `scripted` for reproducible CI; `sarvam` for a live model with scripted fallback. */
  investigatorMode: "scripted" | "sarvam"
  /** Live provider (null when not configured: the run falls back to the scripted path, visibly). */
  provider: ModelProvider | null
  /** Why `provider` is null in sarvam mode; shown in the trace as the fallback reason. */
  providerUnavailableReason: string | null
  approvalTtlMs: number
  verifyIntervalMs: number
  verifyWindowMs: number
  maxModelTurns: number
  episodeBudgetMs: number
  maxScriptedSteps: number
  /** Monotonic milliseconds for the active-episode budget. */
  monotonicNow: () => number
}

export const DEFAULT_OPTIONS: Omit<WorkflowOptions, "provider" | "providerUnavailableReason" | "investigatorMode"> = {
  approvalTtlMs: 5 * 60_000,
  verifyIntervalMs: 2_000,
  verifyWindowMs: 60_000,
  maxModelTurns: 8,
  episodeBudgetMs: 45_000,
  maxScriptedSteps: 16,
  monotonicNow: () => performance.now(),
}

function intEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]
  if (!raw) return fallback
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

/** Server-side configuration. Provider secrets are read here and never leave the server. */
export function optionsFromEnv(env: NodeJS.ProcessEnv = process.env): WorkflowOptions {
  const mode = env.INVESTIGATOR_MODE === "sarvam" ? "sarvam" : "scripted"
  let provider: ModelProvider | null = null
  let reason: string | null = null
  if (mode === "sarvam") {
    if (!env.SARVAM_API_KEY || !env.SARVAM_MODEL) {
      reason = "INVESTIGATOR_MODE=sarvam but SARVAM_API_KEY or SARVAM_MODEL is not configured on the server"
    } else {
      provider = createSarvamProvider({
        apiKey: env.SARVAM_API_KEY,
        model: env.SARVAM_MODEL,
        baseUrl: env.SARVAM_BASE_URL,
        reasoningEffort: env.SARVAM_REASONING_EFFORT,
      })
    }
  }
  return {
    ...DEFAULT_OPTIONS,
    investigatorMode: mode,
    provider,
    providerUnavailableReason: reason,
    approvalTtlMs: intEnv(env, "WORKFLOW_APPROVAL_TTL_SECONDS", 300) * 1000,
    verifyIntervalMs: intEnv(env, "WORKFLOW_VERIFY_INTERVAL_MS", DEFAULT_OPTIONS.verifyIntervalMs),
    verifyWindowMs: intEnv(env, "WORKFLOW_VERIFY_WINDOW_MS", DEFAULT_OPTIONS.verifyWindowMs),
  }
}
