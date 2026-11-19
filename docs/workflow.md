# Workflow (Owner 02) · Merchant Reliability OS · SYNTHETIC DEMO

The workflow module owns the investigator, the deny-by-default policy, restricted
approvals, authorized mock execution and independent verification. It runs in the
same process as the platform. It writes only `wf_*` tables directly. Core tables
change through `CoreRuntime` ports.

- Entry point: `server/workflow/index.ts` exports `createWorkflow: WorkflowFactory`.
- Combined launch: `server/workflow/entry.ts` calls `startServer({ createWorkflow })` (`npm run dev:api`).
- Migration: `server/migrations/010_workflow.sql`. The statements are idempotent, and `createWorkflow` also ensures the schema.

## State machine

Status edges come from the shared `INCIDENT_TRANSITIONS` map. `server/workflow/machine.ts`
adds Owner 02 preconditions. It also writes a trace entry with mode and reason in the
same transaction as every transition.

| From → To | Owner 02 precondition | Who |
|---|---|---|
| DETECTED → INVESTIGATING | Initial investigate job (`investigate:<id>:initial`) | investigator |
| INVESTIGATING → ACTION_RUNNING | Accepted proposal passes the authoritative policy re-check at commit (sync or link). Execute job queued in the same transaction. | investigator |
| INVESTIGATING → INSUFFICIENT_EVIDENCE | No proposal, or the policy denied it at commit. Blocker lists the missing evidence. Retryable. | investigator |
| INVESTIGATING → ESCALATED | Settlement handoff or explicit escalation, with an owner | investigator |
| INVESTIGATING / PARTIALLY_RECOVERED → FAILED | Scripted step budget exhausted. Retryable. | investigator |
| ACTION_RUNNING → VERIFYING | Simulator write committed with per-target outcomes. Verify round 1 queued. | executor |
| ACTION_RUNNING → ESCALATED | Execution revalidation failed (approval, revision, target, scope). Zero effects. | executor |
| VERIFYING → (interim) | Some devices AWAITING and the window is still open. Snapshot stored and next round queued. No status change. | verifier |
| VERIFYING → RESOLVED | Every original cohort device PASSES. `verifiedCheckId` points to the snapshot inserted in the same transaction. | **verifier only** |
| VERIFYING → PARTIALLY_RECOVERED | Final snapshot after **sync** has failures. Continuation investigation queued. | verifier |
| VERIFYING → ESCALATED | Final snapshot after **restart** has failures (for example 23/24), or ticket links were not stored | verifier |
| VERIFYING → TASK_COMPLETED | All duplicate links are confirmed in storage (Scenario B) | verifier |
| PARTIALLY_RECOVERED → APPROVAL_PENDING | Restart proposal allowed by `DEVICE_RESTART_REQUIRES_APPROVAL`. The approval and its expiry job are created in the same transaction. | investigator |
| APPROVAL_PENDING → ACTION_RUNNING | Approver session approves the current `proposalRevision` before expiry. Execute job queued in the same transaction. | decision |
| APPROVAL_PENDING → ESCALATED | Rejected or expired. No target substitution and no automatic reproposal. | decision / expiry |
| INSUFFICIENT_EVIDENCE / retryable FAILED → INVESTIGATING | Operator `POST /incidents/:id/investigate` | investigator |

Soundbox success path: `DETECTED → INVESTIGATING → ACTION_RUNNING (sync 24) → VERIFYING → PARTIALLY_RECOVERED (20/24) → APPROVAL_PENDING (4 devices) → ACTION_RUNNING (restart) → VERIFYING → RESOLVED (24/24)`.

## Policy matrix (`server/workflow/policy.ts`)

| Action | Rule | Allowed when | Approval |
|---|---|---|---|
| `MOCK_SYNC_DEVICE_CONFIG` | `MOCK_SYNC_ELIGIBLE_COHORT` | The incident is Soundbox and `INVESTIGATING`. Targets are a non-empty subset of the frozen cohort, and each target's device record was read in this episode. | No |
| `MOCK_RESTART_DEVICE` | `DEVICE_RESTART_REQUIRES_APPROVAL` | The incident is Soundbox and `PARTIALLY_RECOVERED`. Targets are non-PASS in the verifier's latest final snapshot, in the cohort, and read in this episode. | **Yes** (approver, 5 min TTL) |
| `MOCK_RESTART_DEVICE` (again) | `NO_AUTOMATIC_REPROPOSAL` | Never after an approval already exists for the incident | n/a |
| `LINK_SUPPORT_TICKETS` | `LINK_ELIGIBLE_DUPLICATE_TICKETS` | The incident is duplicate-tickets and `INVESTIGATING`. The primary ticket and duplicates were read in this run, belong to the same merchant and are not linked elsewhere. | No |
| Settlement | `SETTLEMENT_READ_ONLY_HANDOFF` | A factual handoff to Settlement Operations that cites a settlement record that was read. No write. | n/a |
| Refund / settlement / payout / ledger actions | `NO_FINANCIAL_MUTATION` | Never | n/a |
| Anything else | `DENY_BY_DEFAULT` | Never | n/a |
| Approval decision | `APPROVAL_REQUIRES_APPROVER` | The session actor has role `approver`. A role in the body has no effect. | n/a |

The executor rechecks everything at execution time (`authorizeExecution`):

- the incident is `ACTION_RUNNING`
- the approval exists, is `APPROVED` and is in scope
- its revision hash still matches the stored parameters
- its targets equal the action's targets
- it was decided before it expired
- every device revision is unchanged since the approval
- every target is still unresolved in the latest snapshot

Any failure means zero effects, the action is `BLOCKED` and the incident is escalated.

### Approval binding

`proposalRevision = sha256(stable JSON of {generation, incidentId, actionId, kind, sorted targetIds, per-target revisions, args, checkpoint})`.
The checkpoint is the verifier snapshot ID that justified the proposal. Decisions use one
conditional `UPDATE … WHERE status='PENDING' AND proposal_revision=?`. An identical replay
(same decision and revision) returns the stored outcome. Any other decision on a decided
approval returns `409 APPROVAL_CONFLICT`. A decision after `expiresAt` commits the expiry
and escalation first, then returns `409 APPROVAL_EXPIRED`.

## Workflow jobs

| Kind | Key | Payload | Effect transaction |
|---|---|---|---|
| `workflow.investigate` | `investigate:<incidentId>:initial` (core enqueues it at injection) | `{}` | Each step commits with lease and generation guards. The finding, proposal, transition and follow-up job commit in one transaction. |
| `workflow.investigate` | `investigate:<incidentId>:resume:v<version>` | `{ resume: true }` | Operator resume from INSUFFICIENT_EVIDENCE or a retryable FAILED |
| `workflow.investigate` | `investigate:<incidentId>:continuation:<checkId>` | `{ stage: "continuation", checkId }` | Proposes the restart approval from the saved snapshot |
| `workflow.execute` | `execute:<actionId>` | `{ actionId, approvalId? }` | Revalidates, consumes the approval, runs `simulation.apply`, records outcomes and audit, moves to VERIFYING and queues verify round 1 |
| `workflow.verify` | `verify:<actionId>:<round>` | `{ actionId, round }` | Stores the snapshot. Interim rounds queue the next round, and the final round transitions. |
| `workflow.expire` | `expire:<approvalId>` (`:retry:<n>` if delivered early) | `{ approvalId }` | PENDING → EXPIRED and the incident escalates |

Every effect transaction starts with `core.jobs.assertLease` plus an active-generation check.
Old-generation jobs stop with no effect. A redelivered job finds its committed result
(the action is no longer `PROPOSED`, the snapshot round exists, or the episode is `COMPLETED`)
and replays it without a second effect. Stable `op_key`s make trace and audit inserts idempotent.

## Investigator

- **Tools** (`investigator/tools.ts`) are allowlisted and incident-scoped, and each takes strict zod arguments:
  - Reads: `get_incident`, `read_devices`, `read_device_events`, `read_merchants`, `read_tickets`, `read_payments`, `read_settlements`, `get_recovery_snapshot`
  - Proposals: `propose_config_sync`, `request_restart_approval`, `propose_ticket_link`, `record_settlement_handoff`, `escalate`

  There are no SQL, shell, network or financial tools. The model sees only the eligible tools for the next stage. Proposals unlock only after a real read, and after an accepted proposal the only valid step is the finding.
- **Step contract.** The model returns exactly one `{type:"tool",tool,args}` or `{type:"finding",finding}`. If a step uses an unknown or ineligible tool, has malformed output or invalid arguments, or cites an ID not retrieved in this episode, it is rejected. The rejection is recorded as a `guardrail` trace entry, fed back to the model, and counted against the budget.
- **Untrusted data.** Records reach the model only under `untrusted_records`, with truncated strings. The system prompt carries the runtime instruction from the brief. Ticket text cannot widen the tool set or bypass policy.
- **Budgets.** An episode allows 8 live model turns and 45 s of active time, with one transient retry per call inside that budget. `turns_used`, `active_ms` and every validated step persist in `wf_episodes` and `wf_steps`, so lease recovery resumes and does not reset the budget. Approval waits happen between episodes.
- **Fallback.** The scripted path (`investigator/scripted.ts`) is deterministic and bounded (16 steps). It uses the same tools, policy, writes and verifier. A switch (`INVESTIGATOR_MODE=scripted`, provider not configured, provider error, or budget exhausted) is traced with its reason. Transitions are labelled `scripted_fallback` even when the full workflow completes.
- **Provider.** Sarvam Chat Completion V2 (`POST https://api.sarvam.ai/v2/chat/completions`) with `api-subscription-key`, `response_format: json_object` and low temperature. `reasoning_content` and error bodies are never read into storage or logs.

## Verifier

For each original cohort device, the verifier compares observations against the device's
most recent committed remediation attempt (`wf_action_targets`). A signal kind
(heartbeat, config or notification probe) passes when:

- the newest observation of that kind newer than the attempt passed, and
- a passing observation of that kind is attributed to that action and device, occurred after `appliedAt` and within the window (default 60 s), has `sequence > priorSequence` (the pre-action watermark), and is at or before the evidence cutoff (`clock.telemetryNow`).

Newer failures contradict earlier passes even after the window closes. Old (watermark),
pre-execution, wrong-action and post-cutoff observations are ignored. The 20 synced devices
keep their still-valid sync passes, and the 4 restarted devices need fresh restart passes.
While devices are `AWAITING`, the verifier rechecks every 2 s. When the window closes,
missing evidence becomes a FAIL.

## HTTP routes

| Route | Role | Result |
|---|---|---|
| `POST /api/v1/incidents/:id/investigate` | operator | `202 { data: StartResult }`. Idempotent: DETECTED or in-flight statuses queue nothing new, INSUFFICIENT_EVIDENCE or retryable FAILED queue a resume, and terminal statuses return `409 WORKFLOW_CONFLICT`. |
| `GET /api/v1/approvals` | any session | `200 { data: ApprovalQueue }` with pending requests and history for the active generation. A pending approval past its expiry is reported as `EXPIRED`. |
| `POST /api/v1/approvals/:id/decision` | approver | `200 { data: DecisionResult }`. Errors: `400 INVALID_INPUT`, `401`/`403`, `404 NOT_FOUND`, `409 STALE_GENERATION`/`APPROVAL_CONFLICT`/`APPROVAL_EXPIRED`. |

## Configuration (server only)

| Variable | Default | Meaning |
|---|---|---|
| `INVESTIGATOR_MODE` | `scripted` | Use `scripted` for CI. `sarvam` uses the live model with visible fallback. |
| `SARVAM_API_KEY`, `SARVAM_MODEL` | (none) | Required for `sarvam`. Without them the run falls back, and the trace gives the reason. |
| `SARVAM_BASE_URL`, `SARVAM_REASONING_EFFORT` | (none) | Optional |
| `WORKFLOW_APPROVAL_TTL_SECONDS` | `300` | Approval TTL on the server clock |
| `WORKFLOW_VERIFY_INTERVAL_MS`, `WORKFLOW_VERIFY_WINDOW_MS` | `2000`, `60000` | Verification cadence and observation window |

## Smoke instructions

```bash
npm ci
npm run check            # TypeScript
npm run test:workflow    # Workflow suites on temporary SQLite with a fake CoreRuntime
# Live model proof (optional, server-side key):
INVESTIGATOR_MODE=sarvam SARVAM_API_KEY=… SARVAM_MODEL=sarvam-105b npm run smoke:live
# Combined API (after Owner 01's platform merges):
DEMO_DB_PATH=./data/demo.db DEMO_SESSION_SECRET=… DEMO_OPERATOR_CODE=… DEMO_APPROVER_CODE=… npm run dev:api
```

## Contract notes for Owner 01

These are assumptions the workflow relies on. Each is handled defensively, and each is
listed here for confirmation.

1. Device `EvidenceView` has `id === deviceId` or `details.deviceId`. `ReadRequest.ids` for `kind: "device"` are device IDs.
2. `LINK_SUPPORT_TICKETS` passes `targetIds = [primaryTicketId, ...duplicateIds]`, because `SimulationInput` has no args. The stored link is one of `details.duplicateOf | linkedTo | primaryTicketId | linkedTicketId`.
3. `simulation.apply` raises an exception rather than double-applying when the same `actionId` is replayed. The workflow never replays it, because it checks its committed result first.
4. Confirmed on the combined build: the platform's session middleware sets `res.locals.session` (with `actor`), and `requireRole` sets `res.locals.actor`. Workflow routes read `res.locals.actor` first and fall back to `res.locals.session.actor`, so `GET /approvals` works for both roles. Without a session it returns 401.
