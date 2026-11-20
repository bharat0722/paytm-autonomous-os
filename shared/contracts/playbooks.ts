// The process each incident type follows, step by step. This is the "how it gets solved" definition the
// War Room renders. Entries recorded while the workflow runs (every read, policy check, write and
// verification) attach to these step ids. Systems named "(simulated)" are mock endpoints in this prototype;
// each step lists the production system it would map to in a pilot.
import type { Scenario, StepKind } from "./http.js"

export interface PlaybookStepDef {
  id: string
  kind: StepKind
  title: string
  description: string
  /** System touched in this prototype; null when the step is a decision with no external call. */
  system: string | null
  automation: "automatic" | "policy-gated" | "human" | "system"
  /** Skipped when the incident ends before the step is reached. */
}
export interface PlaybookDef { scenario: Scenario; title: string; summary: string; steps: PlaybookStepDef[] }

const detect = (rule: string): PlaybookStepDef => ({
  id: "detect", kind: "detect", title: "Detect and group", description: rule,
  system: "Correlation engine", automation: "system",
})
const close = (description: string): PlaybookStepDef => ({
  id: "close", kind: "close", title: "Close or escalate", description, system: null, automation: "system",
})

export const PLAYBOOKS: Record<Scenario, PlaybookDef> = {
  "order-unpaid": {
    scenario: "order-unpaid",
    title: "Payment succeeded, merchant order still unpaid",
    summary: "Payment Gateway integration issue: Paytm collected the money but the merchant never learned about it. Today the merchant must poll the status API or email integration support.",
    steps: [
      detect("Groups orders whose webhook failed with the same error signature across 3 or more merchants within 5 minutes. Orders with a different cause stay out."),
      { id: "investigate", kind: "investigate", title: "Read order, status and webhook evidence",
        description: "Reads the merchant order, asks the Transaction Status API what Paytm recorded, and reads the webhook delivery log. Read-only.",
        system: "Merchant order store · Paytm Status API · Webhook delivery log (all simulated)", automation: "automatic" },
      { id: "decide", kind: "decide", title: "Policy check: resend webhook",
        description: "Allowed only for orders the Status API confirmed as TXN_SUCCESS, still unpaid at the merchant, with a failed last webhook. Anything else is denied.",
        system: "Policy engine", automation: "policy-gated" },
      { id: "act", kind: "act", title: "Resend the payment webhook",
        description: "Re-delivers the final-status notification to each merchant's registered endpoint. No money moves.",
        system: "Paytm webhook service (simulated)", automation: "automatic" },
      { id: "verify", kind: "verify", title: "Verify the merchant order is now paid",
        description: "Reads each order again from the merchant side. Only a verified PAID order counts as fixed.",
        system: "Merchant order store (simulated)", automation: "system" },
      close("RESOLVED only when every targeted order is PAID. Orders still failing go to Payment Gateway Integration Support with the evidence."),
    ],
  },
  soundbox: {
    scenario: "soundbox",
    title: "Payment succeeded, Soundbox stayed silent",
    summary: "Device issue: the money arrived but the speaker did not announce it. Today this becomes one ticket per merchant, handled separately.",
    steps: [
      detect("Groups devices with the same model, settings version and error across 3 or more merchants within 5 minutes."),
      { id: "investigate", kind: "investigate", title: "Read devices, events, tickets and payments",
        description: "Reads the frozen device cohort and linked records. Confirms payments succeeded while notifications failed.",
        system: "Device fleet registry · Event stream · Ticketing · Payments ledger (all simulated)", automation: "automatic" },
      { id: "decide-sync", kind: "decide", title: "Policy check: settings sync",
        description: "A settings sync is allowed without a human only for devices whose records were read in this run.",
        system: "Policy engine", automation: "policy-gated" },
      { id: "act-sync", kind: "act", title: "Sync device settings",
        description: "Pushes the fixed settings version to every device in the cohort.",
        system: "Device fleet API (simulated)", automation: "automatic" },
      { id: "verify-sync", kind: "verify", title: "Verify with fresh device signals",
        description: "Requires a fresh heartbeat, settings check and test alert from each device after the change.",
        system: "Device health telemetry (simulated)", automation: "system" },
      { id: "reinvestigate", kind: "investigate", title: "Re-read the devices that still fail",
        description: "Reads the verifier's snapshot and the unresolved devices.",
        system: "Device fleet registry (simulated)", automation: "automatic" },
      { id: "decide-restart", kind: "decide", title: "Policy check: restart needs a human",
        description: "A device restart is never automatic. The policy only lets the AI request approval for the exact failing devices.",
        system: "Policy engine", automation: "policy-gated" },
      { id: "approve", kind: "approve", title: "Human approval",
        description: "A person with the approver role approves or rejects exactly these devices. The approval is single-use and expires in 5 minutes.",
        system: "Approval Center", automation: "human" },
      { id: "act-restart", kind: "act", title: "Restart the approved devices",
        description: "Runs once, only after a valid approval, on exactly the approved devices.",
        system: "Device fleet API (simulated)", automation: "policy-gated" },
      { id: "verify-restart", kind: "verify", title: "Final verification",
        description: "Fresh signals again. 24 of 24 means resolved; anything less escalates to the field team.",
        system: "Device health telemetry (simulated)", automation: "system" },
      close("RESOLVED only after the verifier confirms every device. Otherwise escalated to Field Operations."),
    ],
  },
  "settlement-discrepancy": {
    scenario: "settlement-discrepancy",
    title: "Settlement missing or short",
    summary: "Money issue: the merchant received less than expected. The agent investigates and hands over evidence; it can never change money.",
    steps: [
      detect("Groups SHORT settlements on the same bank batch across 3 or more merchants."),
      { id: "investigate", kind: "investigate", title: "Read settlements, complaints and payments",
        description: "Reads settlement records, gross, fees, expected and settled amounts, and linked tickets. Read-only.",
        system: "Settlement reports (read-only) · Ticketing · Payments ledger (all simulated)", automation: "automatic" },
      { id: "decide-handoff", kind: "decide", title: "Policy check: no financial change",
        description: "Any refund, payout or adjustment is denied by rule. The only allowed outcome is a factual handoff.",
        system: "Policy engine", automation: "policy-gated" },
      { id: "handoff", kind: "handoff", title: "Hand off to Settlement Operations",
        description: "Creates an evidence packet for the finance owner: which merchants, how much short, which bank batch.",
        system: "Escalation queue", automation: "automatic" },
      close("Always ends as ESCALATED to Settlement Operations. No settlement record is changed."),
    ],
  },
  "duplicate-tickets": {
    scenario: "duplicate-tickets",
    title: "Duplicate support tickets",
    summary: "Support noise: many tickets about the same issue. Today each is worked separately.",
    steps: [
      detect("Groups tickets with the same category and subject across 3 or more merchants within 5 minutes."),
      { id: "investigate", kind: "investigate", title: "Read tickets and merchants",
        description: "Reads the tickets and picks the earliest unlinked ticket per merchant as primary.",
        system: "Ticketing · Merchant master (simulated)", automation: "automatic" },
      { id: "decide-link", kind: "decide", title: "Policy check: link duplicates",
        description: "Allowed only for the same merchant, tickets not already linked elsewhere, and all tickets read in this run.",
        system: "Policy engine", automation: "policy-gated" },
      { id: "act-link", kind: "act", title: "Link duplicates to the primary ticket",
        description: "Writes the link on each duplicate. The primary stays open.",
        system: "Ticketing API (simulated)", automation: "automatic" },
      { id: "verify-link", kind: "verify", title: "Verify the links are stored",
        description: "Reads each ticket back and confirms the stored link.",
        system: "Ticketing API (simulated)", automation: "system" },
      close("TASK COMPLETED only when every link is confirmed in storage."),
    ],
  },
}
