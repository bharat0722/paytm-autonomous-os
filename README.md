# Paytm Autonomous OS

Merchant Reliability OS is a hackathon prototype for investigating synthetic merchant incidents, approving simulated device actions, and verifying recovery from recorded evidence. It has no live Paytm connections.

## Run the integrated app

Use Node 24 and npm 11. From the repository root:

```sh
npm ci            # on Windows without C++ build tools: npm ci --ignore-scripts
cp .env.example .env
```

Set `DEMO_SESSION_SECRET` to at least 32 random characters. Choose distinct values for `DEMO_OPERATOR_CODE` and `DEMO_APPROVER_CODE`. Keep them in the server environment. Set `INVESTIGATOR_MODE=scripted` for a repeatable demonstration. `API_PORT` and `DEMO_DB_PATH` control the local API and SQLite file. Live Sarvam requires a server-side `SARVAM_API_KEY` and `SARVAM_MODEL`.

```sh
npm run dev
```

Open [the local workspace](http://localhost:5173). Sign in as **Operator** to run or reset the demo. Use a second browser profile or separate private window as **Approver** for the human decision. The **Switch role** control establishes a new authenticated session when you have the code for that role.

For a single same-origin app, run `npm run build` and `npm run start:api`. The workflow server serves `dist/web` and `/api/v1` on port 3001 by default.

**Internal team guide:** [docs/INTERNAL_RUNBOOK.md](docs/INTERNAL_RUNBOOK.md) covers setup, roles, the 4-minute demo, turning on Sarvam AI, the API reference and troubleshooting.

## PRD feature coverage (FR-01 to FR-10)

| Feature | Where to see it |
|---|---|
| FR-01 Seeded synthetic network | Same relationships after every Reset sandbox |
| FR-02 Event injection | Run now on a detection job creates its batch; a repeat run returns the same incident |
| FR-03 Correlation | War Room → **Why these were grouped** (shared fingerprint, window, records kept separate) |
| FR-04 AI investigator | AI work log with real read-tool calls and an evidence-backed finding |
| FR-05 Autonomous safe action | Mock config sync changes stored device records |
| FR-06 Restricted action approval | Approvals page; `POST /incidents/:id/actions` returns pending or denied |
| FR-07 Recovery verifier | 20 / 24 → approved restart → 24 / 24 from fresh signals only |
| FR-08 Audit and memory | Audit opens with *Incident detected*; `GET /incidents/:id/audit` |
| FR-09 Reliable demo | Reset, loading and error states, labelled scripted fallback, 3× rehearsal |
| FR-10 Sarvam AI | `INVESTIGATOR_MODE=sarvam` + key; the engine badge shows **Sarvam live AI** |

Also included: complained-vs-silent merchant outreach, a merchant view, simulated PRD §15 success metrics, and Scenario B linking every merchant's duplicates.

## Try the Soundbox incident

1. In **Operations overview**, click **Run now** on the *Payment voice-alert health sweep* detection job.
2. In **Incident War Room**, inspect the records, work log and recovery. The verifier should report **20 / 24** while the restart proposal waits.
3. In **Approvals page**, sign in as Approver, review the four exact targets, and confirm the remote restart. Return to the incident to see the persisted **24 / 24** verification.
4. Reset and repeat with **Reject** or **Partial recovery**. The case stays escalated with **20 / 24** or **23 / 24** respectively.

[Demo guide and verification details](docs/demo.md)

## Checks

```sh
npm run check
npm run test:core
npm run test:workflow
npm run test:web
npm run build
npx playwright install chromium
npm run test:e2e
```

The browser suite starts the real application with a separate temporary SQLite database and generated test access codes for each test. Set `E2E_SCREENSHOT_DIR` to an output directory to capture the demo screens during the run.

## Static preview

The root [index.html](index.html) is the earlier self-contained preview. It is also available as a [static Vercel demo](https://merchant-reliability-demo.vercel.app/). Use the integrated app above to exercise persisted workflow and approval state.
