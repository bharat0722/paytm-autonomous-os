import { describe, expect, it } from "vitest"
import { INCIDENT_TRANSITIONS, isLegalTransition, TERMINAL_STATUSES } from "../../shared/contracts/core.js"
import {
  exampleDashboard, exampleError, examplePendingIncident, exampleResolvedIncident, exampleSession
} from "../../shared/contracts/examples.js"
import {
  ApiErrorSchema, DashboardViewSchema, IncidentViewSchema, okEnvelope, SessionViewSchema
} from "../../shared/contracts/http.js"

describe("shared contracts", () => {
  it("example envelopes validate against the runtime schemas", () => {
    expect(okEnvelope(IncidentViewSchema).parse(examplePendingIncident)).toBeTruthy()
    expect(okEnvelope(IncidentViewSchema).parse(exampleResolvedIncident)).toBeTruthy()
    expect(okEnvelope(DashboardViewSchema).parse(exampleDashboard)).toBeTruthy()
    expect(okEnvelope(SessionViewSchema).parse(exampleSession)).toBeTruthy()
    expect(ApiErrorSchema.parse(exampleError)).toBeTruthy()
  })

  it("pending example is 20/24 and final is 24/24", () => {
    expect(examplePendingIncident.data.workflow.recovery?.recovered).toBe(20)
    expect(examplePendingIncident.data.workflow.approvals[0]?.targetDeviceIds).toHaveLength(4)
    expect(exampleResolvedIncident.data.workflow.recovery?.recovered).toBe(24)
  })

  it("transition map matches the agreement", () => {
    expect(isLegalTransition("DETECTED", "INVESTIGATING")).toBe(true)
    expect(isLegalTransition("DETECTED", "RESOLVED")).toBe(false)
    expect(isLegalTransition("VERIFYING", "VERIFYING")).toBe(true)
    expect(isLegalTransition("APPROVAL_PENDING", "ACTION_RUNNING")).toBe(true)
    expect(isLegalTransition("FAILED", "INVESTIGATING")).toBe(true)
    for (const t of TERMINAL_STATUSES) expect(INCIDENT_TRANSITIONS[t]).toHaveLength(0)
  })
})
