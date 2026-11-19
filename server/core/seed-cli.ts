// `npm run seed` — bootstraps the DB, or with `--reset` starts a fresh generation.
import { loadConfig } from "./config.js"
import { openDb } from "./db.js"
import { activeGeneration, ensureBootstrapped, resetDemo } from "./generations.js"
import { systemClock } from "./util.js"

const config = loadConfig()
const db = openDb(config.dbPath)
let generation = ensureBootstrapped(db, systemClock)
if (process.argv.includes("--reset")) generation = resetDemo(db, systemClock, db.read((q) => activeGeneration(q)))
const counts = db.read((q) => ({
  merchants: q.get<{ c: number }>("SELECT COUNT(*) AS c FROM merchants WHERE generation = ?", [generation])!.c,
  devices: q.get<{ c: number }>("SELECT COUNT(*) AS c FROM devices WHERE generation = ?", [generation])!.c
}))
console.log(`[seed] SYNTHETIC DEMO generation ${generation} at ${config.dbPath}:`, counts)
db.close()
