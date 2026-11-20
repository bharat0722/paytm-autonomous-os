// Server-side settings. Access codes and keys never reach the browser or Git.
import { existsSync } from "node:fs"

export interface CoreConfig {
  port: number
  host?: string
  dbPath: string
  sessionSecret: string
  operatorCode: string
  approverCode: string
  investigatorMode: "scripted" | "sarvam"
  workerIntervalMs: number
  sessionTtlHours: number
  secureCookies?: boolean
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): CoreConfig {
  if (env === process.env && existsSync(".env")) {
    try { process.loadEnvFile(".env") } catch { /* ignore malformed .env; validation below reports */ }
  }
  const missing = ["DEMO_SESSION_SECRET", "DEMO_OPERATOR_CODE", "DEMO_APPROVER_CODE"].filter((k) => !env[k])
  if (missing.length) {
    throw new Error(`Missing server settings: ${missing.join(", ")}. Copy .env.example to .env and fill them in.`)
  }
  if ((env.DEMO_SESSION_SECRET ?? "").length < 32) throw new Error("DEMO_SESSION_SECRET must be at least 32 characters.")
  if (env.DEMO_OPERATOR_CODE === env.DEMO_APPROVER_CODE) throw new Error("Operator and approver access codes must differ.")
  return {
    port: Number(env.API_PORT ?? env.PORT ?? 3001),
    host: env.API_HOST,
    dbPath: env.DEMO_DB_PATH ?? "./data/demo.sqlite",
    sessionSecret: env.DEMO_SESSION_SECRET!,
    operatorCode: env.DEMO_OPERATOR_CODE!,
    approverCode: env.DEMO_APPROVER_CODE!,
    investigatorMode: env.INVESTIGATOR_MODE === "sarvam" ? "sarvam" : "scripted",
    workerIntervalMs: Number(env.WORKER_INTERVAL_MS ?? 250),
    sessionTtlHours: Number(env.SESSION_TTL_HOURS ?? 12),
    secureCookies: env.NODE_ENV === "production"
  }
}
