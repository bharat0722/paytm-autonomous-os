// Demo cookie sessions + CSRF. Sessions are persisted, and the cookie carries an
// HMAC-signed session ID, so a browser session survives an app restart.
import { createHmac, timingSafeEqual } from "node:crypto"
import type { Actor, Role } from "../../shared/contracts/http.js"
import type { CoreDb } from "./db.js"
import { addMs, newId, randomToken, type Clock } from "./util.js"

export const SESSION_COOKIE = "mros_sid"

export interface SessionRecord { id: string; actor: Actor; csrfToken: string }

const sign = (secret: string, value: string) => createHmac("sha256", secret).update(value).digest("base64url")

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  return ab.length === bb.length && timingSafeEqual(ab, bb)
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=")
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim())
  }
  return out
}

export class SessionStore {
  constructor(private readonly db: CoreDb, private readonly clock: Clock, private readonly secret: string, private readonly ttlHours: number) {}

  /** Server-side role check: the role is granted only if the access code matches. */
  create(role: Role): { record: SessionRecord; cookieValue: string } {
    const id = newId("ses")
    const actor: Actor = { id: newId("usr"), role }
    const csrfToken = randomToken(24)
    const now = this.clock.now()
    this.db.write((tx) => tx.run("INSERT INTO sessions (id, actor_id, role, csrf_token, created_at, expires_at) VALUES (?,?,?,?,?,?)",
      [id, actor.id, role, csrfToken, now, addMs(now, this.ttlHours * 3_600_000)]))
    return { record: { id, actor, csrfToken }, cookieValue: `${id}.${sign(this.secret, id)}` }
  }

  fromCookie(cookieHeader: string | undefined): SessionRecord | null {
    const raw = parseCookies(cookieHeader)[SESSION_COOKIE]
    if (!raw) return null
    const dot = raw.lastIndexOf(".")
    if (dot < 1) return null
    const id = raw.slice(0, dot)
    if (!safeEqual(raw.slice(dot + 1), sign(this.secret, id))) return null
    const row = this.db.read((q) => q.get<{ id: string; actor_id: string; role: Role; csrf_token: string; expires_at: string }>(
      "SELECT id, actor_id, role, csrf_token, expires_at FROM sessions WHERE id = ?", [id]))
    if (!row || row.expires_at < this.clock.now()) return null
    return { id: row.id, actor: { id: row.actor_id, role: row.role }, csrfToken: row.csrf_token }
  }

  cookieHeader(value: string): string {
    return `${SESSION_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${this.ttlHours * 3600}`
  }
}
