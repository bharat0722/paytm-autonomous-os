# Merchant Reliability OS demo and verification

The frontend uses the existing `/api/v1` endpoints, shared validators and server-issued cookie sessions. The session determines role, generation and mutation headers. Data fetched for an older generation cannot replace the active workspace. The server supplies evidence, approvals and verifier snapshots.

## Screen map and visual design

- **Mission Control** starts simulations, shows API-backed network counts and takes the operator to the incident.
- **Incident War Room** puts verified recovery first, followed by the findings, evidence, persisted work log, policy actions and audit.
- **Human Approval Center** puts exact targets, the policy rule, rationale and expected recovery check in front of the approver.

The layout uses a pale canvas, navy focus panels and restrained cyan accents. Status text accompanies color, with separate treatments for severity, recovery, and approval. The product has its own wordmark and component vocabulary. All counts retain the server distinction between affected merchants and devices. [Paytm for Business](https://business.paytm.com/retail) · [Paytm payment analytics](https://business.paytm.com/payment-analytics) · [Paytm visual identity case study](https://liquiddesigns.in/work/paytm-visual-identity-design/)

## Four-minute rehearsal

| Time | Show |
| --- | --- |
| 0:00–0:45 | Use separate Operator and Approver sessions. Reset in Mission Control, select Soundbox and start Complete recovery. Show the live incident and dashboard counts. |
| 0:45–1:45 | Open the War Room. Explain that payment success and Soundbox notification failure are distinct records. Open a linked record and inspect the persisted work log, including its scripted fallback label if present. |
| 1:45–2:45 | Show verified 20 / 24 and review the exact four target devices as Approver. Confirm the restart and show the queued receipt. |
| 2:45–3:30 | Return to the War Room. Show the persisted 24 / 24 result, recovery checks and audit. |
| 3:30–4:00 | Show rejection or the seeded 23 / 24 result from a separate rehearsal. Point out that the incident remains escalated. |

Use one simulation of a given scenario per generation. For a different Soundbox outcome, reset first. Duplicate tickets exercises verification of persisted links. Settlement discrepancy shows a read-only handoff and its owner.

## Verification procedure

Run the commands in the [README](../README.md) in order. The isolated web tests exercise request and response validation with shared contract examples. The Playwright tests use the built UI, real Express routes, the existing workers, and temporary SQLite. Only the network error scenario interrupts a browser request to test retry.

The browser suite covers three clean success runs with distinct browser sessions, retained approvals across a server restart, rejected and expired proposals, wrong-role denial, replay without duplicate restart, seeded partial recovery, reset during a queued job, stale generations, invalid sign-in, API retry, role switching and keyboard focus, supporting scenarios, and viewport widths 1440, 1280, 1024 and 390. Its fallback case runs the real workflow with the live provider unavailable; the server writes the labelled fallback trace. A live provider smoke test requires separate Sarvam credentials.

## Release check results

The product branch passed its TypeScript check and production build. The core, workflow and isolated web suites passed 27, 55 and 8 tests respectively. All 9 Playwright tests passed in Chromium. The browser rehearsed three complete Soundbox runs through 20 / 24 and paused for an exact four-device approval. Every approved success run reached verified 24 / 24. Rejection left 20 / 24, and the partial variant ended escalated at 23 / 24. Desktop and mobile screenshots were captured from these API-backed runs.

These checks used the scripted investigator and covered the visibly labelled provider fallback. Live Sarvam proof requires a separately configured provider run.


## Process playbook and call log

Every incident type has a defined process (`shared/contracts/playbooks.ts`). The **How this incident is solved** panel in the War Room shows each step with its status (done, running, waiting for a human, not needed) and who does it (automatic, allowed by policy, human decision, system check). Open a step to see every recorded call: the method and endpoint, the HTTP status, **what we sent** and **what came back**, with links to the evidence records.

| Incident | Steps |
| --- | --- |
| Paid order shows unpaid (`order-unpaid`) | Detect → read order, Status API and webhook log → policy → resend webhook → verify order is PAID → close or escalate to Payment Gateway Integration Support |
| Soundbox silent | Detect → read devices → policy → sync settings → verify → re-read failing devices → policy → human approval → restart → final verification → close |
| Settlement short | Detect → read settlements → policy (no financial change) → hand off to Settlement Operations → close |
| Duplicate tickets | Detect → read tickets → policy → link → verify links → close |

Run **Paid order shows unpaid** with *Complete recovery* (all 4 orders become PAID, case resolved) or *Partial recovery* (3 of 4 become PAID, one merchant endpoint still returns HTTP 502, escalated).

Endpoints marked "(simulated)" are mock systems in this prototype; each names the Paytm system it would map to in a pilot. The log is read from `GET /api/v1/incidents/:id/playbook` and is stored in `wf_process_log`.
