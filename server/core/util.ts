import { randomBytes } from "node:crypto"

/** Opaque, globally unique, externally routable ID (unique across generations). */
export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(9).toString("base64url")}`
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url")
}

export interface Clock {
  /** Server wall-clock time (approval expiry, sessions, jobs). */
  now(): string
}

export const systemClock: Clock = { now: () => new Date().toISOString() }

/** Controllable clock for tests. */
export function fakeClock(start = "2026-11-20T06:00:00.000Z") {
  let t = Date.parse(start)
  return {
    now: () => new Date(t).toISOString(),
    advance(ms: number) { t += ms },
    set(iso: string) { t = Date.parse(iso) }
  }
}

export const addMs = (iso: string, ms: number) => new Date(Date.parse(iso) + ms).toISOString()

/** Deterministic PRNG (mulberry32) so the same seed gives the same relationships. */
export function prng(seed: number) {
  let a = seed >>> 0
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return {
    next,
    int: (min: number, max: number) => min + Math.floor(next() * (max - min + 1)),
    pick: <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)]!
  }
}
