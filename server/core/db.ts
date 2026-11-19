// SQLite access for the core runtime. Synchronous, parameterized, short transactions.
import Database from "better-sqlite3"
import { mkdirSync, readdirSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type { Sql, SqlValue } from "../../shared/contracts/core.js"

export const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "migrations")

export interface CoreDb {
  raw: Database.Database
  sql: Sql
  read<T>(fn: (q: Sql) => T): T
  write<T>(fn: (tx: Sql) => T): T
  close(): void
}

function makeSql(db: Database.Database): Sql {
  const cache = new Map<string, Database.Statement>()
  const stmt = (text: string) => {
    let s = cache.get(text)
    if (!s) {
      s = db.prepare(text)
      cache.set(text, s)
    }
    return s
  }
  return {
    get<T>(text: string, args: SqlValue[] = []) {
      return stmt(text).get(...args) as T | undefined
    },
    all<T>(text: string, args: SqlValue[] = []) {
      return stmt(text).all(...args) as T[]
    },
    run(text: string, args: SqlValue[] = []) {
      const r = stmt(text).run(...args)
      return { changes: r.changes }
    }
  }
}

/** Opens the DB (":memory:" allowed), applies pragmas and migrations in filename order. */
export function openDb(path: string, migrationsDir = MIGRATIONS_DIR): CoreDb {
  if (path !== ":memory:") mkdirSync(dirname(resolve(path)), { recursive: true })
  const raw = new Database(path)
  raw.pragma("journal_mode = WAL")
  raw.pragma("foreign_keys = ON")
  raw.pragma("busy_timeout = 5000")
  raw.pragma("synchronous = NORMAL")
  migrate(raw, migrationsDir)
  const sql = makeSql(raw)
  return {
    raw,
    sql,
    read: (fn) => fn(sql),
    // Immediate transaction: one transaction per local effect.
    write: (fn) => raw.transaction(() => fn(sql)).immediate(),
    close: () => raw.close()
  }
}

/** Applies every *.sql file not yet recorded, sorted by filename (001_, 010_, ...). */
export function migrate(raw: Database.Database, dir: string): string[] {
  raw.exec("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)")
  const done = new Set((raw.prepare("SELECT name FROM schema_migrations").all() as { name: string }[]).map((r) => r.name))
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()
  const applied: string[] = []
  for (const f of files) {
    if (done.has(f)) continue
    const text = readFileSync(join(dir, f), "utf8")
    raw.transaction(() => {
      raw.exec(text)
      raw.prepare("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)").run(f, new Date().toISOString())
    }).immediate()
    applied.push(f)
  }
  return applied
}
