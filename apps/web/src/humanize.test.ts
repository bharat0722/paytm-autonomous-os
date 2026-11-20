import { describe, expect, it } from "vitest"
import { actorText, humanize, plainRule, plainSignal, traceSummary } from "./workspace.js"

describe("plain-language translator", () => {
  it("turns read tool results into sentences", () => {
    expect(humanize("read_device_events returned 0 device event records")).toBe("Found no device event records for this case")
    expect(humanize("read_tickets returned 14 support ticket records")).toBe("Read 14 ticket records")
    expect(humanize("read_settlements returned 8 settlement records")).toBe("Read 8 settlement records")
    expect(humanize("get_incident: soundbox incident with 24 cohort devices (INVESTIGATING)")).toBe("Opened the case")
  })

  it("turns proposals, rules and approvals into plain sentences", () => {
    expect(humanize("propose_config_sync: policy MOCK_SYNC_ELIGIBLE_COHORT allows mock config sync for 24 devices")).toBe("Rule check passed: a settings sync is allowed for 24 devices")
    expect(humanize("request_restart_approval: 4 devices require human approval (DEVICE_RESTART_REQUIRES_APPROVAL)")).toBe("Asked a person to approve restarting 4 devices")
    expect(humanize("record_settlement_handoff: factual handoff prepared for Settlement Operations")).toBe("Prepared the handoff for Settlement Operations")
    expect(humanize("Policy MOCK_SYNC_ELIGIBLE_COHORT authorized mock config sync of 24 devices.")).toBe("Policy the settings-sync rule authorized simulated config sync of 24 devices.")
  })

  it("never leaves a code name, tool name or internal phrase in a sentence", () => {
    const samples = [
      "read_payments returned 24 payment records", "Rejected step: Output was not a valid step: return one JSON tool step or one finding.",
      "Switched to scripted fallback: live provider failed: Provider call exceeded the episode budget.", "propose_webhook_resend: policy RESEND_ELIGIBLE_WEBHOOKS allows resending the webhook for 4 orders",
      "request_restart_approval denied by DEVICE_RESTART_REQUIRES_APPROVAL: Device records were not read in this run.",
    ]
    for (const s of samples) {
      const out = humanize(s)
      expect(out).not.toMatch(/\b(read|get|propose|request|record|check)_[a-z_]+\b/)
      expect(out).not.toMatch(/\b[A-Z]{2,}(?:_[A-Z0-9]+)+\b/)
      expect(out).not.toMatch(/scripted_fallback|live_ai/)
    }
  })

  it("keeps status changes readable and strips the engine suffix", () => {
    expect(traceSummary("INVESTIGATING → ESCALATED: Settlement discrepancy handed off to Settlement Operations (scripted_fallback: INVESTIGATOR_MODE=scripted)"))
      .toBe("Investigating → Escalated · Settlement discrepancy handed off to Settlement Operations")
  })

  it("explains rules, error codes and who acted in words", () => {
    expect(plainRule("DEVICE_RESTART_REQUIRES_APPROVAL")).toBe("the restart-needs-approval rule")
    expect(plainRule("SOMETHING_NEW")).toBe("a written safety rule")
    expect(plainSignal("WEBHOOK_FAILED|HTTP_502")).toMatch(/^Payment alert to the merchant failed/)
    expect(plainSignal("SBX-AI-2|7.4.1|NOTIFY_PUSH_DROPPED")).toMatch(/^Payment announcement not delivered/)
    expect(actorText("workflow:investigator(scripted_fallback)")).toBe("AI investigator (backup script)")
    expect(actorText("workflow:verifier")).toBe("Final check")
    expect(actorText("approver:usr_abc123")).toBe("Approver")
    expect(actorText("system:expiry")).toBe("Automatic timer")
  })
})
