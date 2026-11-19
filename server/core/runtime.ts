// CoreRuntime: the trusted in-process ports handed to the workflow factory.
import type { CoreRuntime } from "../../shared/contracts/core.js"
import type { CoreDb } from "./db.js"
import { readEvidence, readObservations } from "./evidence.js"
import { activeGeneration, telemetryNow } from "./generations.js"
import { getIncident, transitionIncident } from "./incidents.js"
import { assertLease, enqueueJob } from "./jobs.js"
import { applySimulation } from "./simulation.js"
import type { Clock } from "./util.js"

export function createCoreRuntime(db: CoreDb, clock: Clock): CoreRuntime {
  return {
    db: { read: (fn) => db.read(fn), write: (fn) => db.write(fn) },
    clock: { now: () => clock.now(), telemetryNow: (q, scope) => telemetryNow(q, scope.generation) },
    activeGeneration: (q) => activeGeneration(q),
    jobs: { enqueue: (tx, input) => enqueueJob(tx, clock, input), assertLease: (tx, job) => assertLease(tx, job) },
    incidents: {
      get: (q, scope) => getIncident(q, scope),
      transition: (tx, scope, change) => transitionIncident(tx, clock, scope, change)
    },
    evidence: {
      read: (q, scope, request) => readEvidence(q, scope, request),
      observations: (q, scope, deviceIds) => readObservations(q, scope, deviceIds)
    },
    simulation: { apply: (tx, scope, input) => applySimulation(tx, clock, scope, input) }
  }
}
