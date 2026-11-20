# Merchant Reliability OS · Internal team runbook

**SYNTHETIC DEMO.** Every merchant, device, payment, ticket and settlement is generated. No Paytm system,
real device or real money is touched. Device sync/restart are mock actions; settlements are read-only.

## 1. Start it (5 minutes)

Needs Node 24 and npm 11.

```powershell
npm ci --ignore-scripts      # Windows without C++ build tools (prebuilt SQLite driver is used)
copy .env.example .env       # then edit .env (see below)
npm run build                # builds the web app into dist/web
npm run start:api            # one server: UI + API on http://localhost:3001
```

`.env` must contain a session secret of 32+ characters and **two different** access codes:

```
DEMO_SESSION_SECRET=<32+ random characters>
DEMO_OPERATOR_CODE=<code you give operators>
DEMO_APPROVER_CODE=<code you give approvers>
INVESTIGATOR_MODE=scripted   # or sarvam (see §4)
```

For development with hot reload, use `npm run dev` (API on 3001, UI on http://localhost:5173).

## 2. Roles

| Role | Can do | Cannot do |
|---|---|---|
| **Operator** | Run detection jobs, Reset sandbox, request investigation/verification, view everything | Approve or reject a restart |
| **Approver** | Approve/reject a restricted action in the Approvals page, view everything | Inject, reset |

Use two browser profiles (or one normal and one private window) to demo both roles.

## 3. The 4-minute demo (PRD §18)

| Time | Do | Say |
|---|---|---|
| 0:00 | Operations overview, signed in as Operator. Point to the **Sandbox** badge, the incident queue and the **Detection jobs** table. | "One closed-loop workflow, end to end, on synthetic data." |
| 0:30 | **Reset sandbox** → **Run now** on *Payment voice-alert health sweep*. | "24 alerts collapse into one incident." |
| 1:00 | War Room → **Why these were grouped** (model, config, error, 5-min window, 6 records kept separate). Show **9 complained / 12 silent** and open one silent merchant. | "We group on evidence, not wording, and we find the merchants who haven't called yet." |
| 1:30 | **AI work log**: read tools, policy, mock config sync. Note the engine label (Sarvam live AI or Scripted fallback). | "The AI reads records, then policy lets it run the safe step." |
| 2:00 | Recovery **20 / 24**; "Human approval required". | "We don't fake success." |
| 2:40 | Approver window → Approvals page → review the 4 exact devices → **Approve**. | "One specific, single-use, expiring permission." |
| 3:25 | Back to the War Room → **24 / 24 Resolved**; open **audit history** (starts with Incident detected). | "Done means verified by fresh device signals." |
| Optional | Reset → **Reject** (stays 20/24, escalated) or **Partial recovery** (23/24, escalated). Then Duplicate tickets (**7 / 7** links across 6 merchants) and Settlement (read-only handoff). | "It also knows when to stop." |

## 4. Turning on Sarvam AI (FR-10)

1. Put your key in `.env` on the server machine. Never put it in the UI, Git or chat:
   ```
   INVESTIGATOR_MODE=sarvam
   SARVAM_API_KEY=<your key>
   SARVAM_MODEL=sarvam-105b
   ```
2. Check connectivity: `npm run smoke:live`. It passes when Sarvam itself selects at least one database read tool. The output lists every step with `[live_ai]` or `[scripted_fallback]`.
3. Restart the server. In the War Room, the **Investigator engine** badge shows **Sarvam live AI**, and live steps are labelled in the work log.
4. If Sarvam is down, slow (45 s budget, one retry) or returns invalid output, the run continues on the deterministic path, and the UI labels it **Scripted fallback** with the reason. The backend owns every rule and action in both modes.

Sarvam endpoint: `POST https://api.sarvam.ai/v2/chat/completions` with header `api-subscription-key`.
`sarvam-m` is deprecated; use `sarvam-105b` (or `sarvam-30b` if your account has it).

## 5. API quick reference (`/api/v1`)

| Method | Path | Who | Notes |
|---|---|---|---|
| GET | `/session` | anyone | Generation, actor, CSRF token |
| POST | `/demo/session` | anyone | `{role, accessCode}`; sets an HttpOnly cookie |
| POST | `/demo/reset` · `/demo/inject/:scenario` | operator | Scenarios: `soundbox` (`success`/`partial`), `duplicate-tickets`, `settlement-discrepancy` |
| GET | `/dashboard` · `/metrics` | signed in | KPIs, pulse, incidents, activity · simulated PRD §15 metrics |
| GET | `/incidents/:id` · `/incidents/:id/audit` | signed in | Evidence, grouping, trace, actions, approvals, recovery · durable audit |
| POST | `/incidents/:id/investigate` | operator | Start/resume (202) |
| POST | `/incidents/:id/actions` | operator | `{kind, targetIds?}`. Policy decides: restart → 202 `APPROVAL_PENDING` or 403 `POLICY_DENIED`; financial/unknown → 403. **Never executes directly.** |
| POST | `/incidents/:id/verify` | operator | Queues a verifier check while VERIFYING; otherwise returns the verifier's latest result |
| GET | `/approvals` · POST `/approvals/:id/decision` | signed in · approver | `{decision, proposalRevision, reason?}` |

Every POST except sign-in needs the headers `X-CSRF-Token` and `X-Demo-Generation`.

## 6. Checks before any demo

```powershell
npm run check; npm run test:core; npm run test:workflow; npm run test:web
npm run build; npx playwright install chromium; npm run test:e2e
```
Expected: 27 + 57 + 8 unit tests and 10 browser tests pass.

## 7. Troubleshooting

| Symptom | Fix |
|---|---|
| "Missing server settings" on start | `.env` is missing the secret or codes, or the two codes are identical. |
| `npm ci` fails building better-sqlite3 | Use `npm ci --ignore-scripts`. |
| "Demo generation is stale" (409) | Someone reset the demo; the page refetches. Refresh if needed. |
| Restart stays pending | Only the **Approver** can decide; approvals expire after 5 minutes (reset and rerun). |
| Engine shows Scripted fallback in sarvam mode | Run `npm run smoke:live`; check the key, model name and network. The trace states the reason. |
| Port 3001 busy | Set `API_PORT` in `.env`. |

## 8. What is real vs. simulated

Real: the workflow engine, policy checks, approvals, single-use execution, verifier, audit, persistence and
Sarvam calls (when enabled). Simulated: all data, device actions and telemetry. Metrics come from these synthetic runs.
