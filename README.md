# Paytm Autonomous OS

Merchant Reliability OS is a hackathon prototype for investigating synthetic merchant incidents, approving simulated device actions, and verifying recovery from recorded evidence. It has no live Paytm connections.

## Run the integrated app

Use Node 24 and npm 11. From the repository root:

```sh
npm ci
cp .env.example .env
```

Set `DEMO_SESSION_SECRET` to at least 32 random characters. Choose distinct values for `DEMO_OPERATOR_CODE` and `DEMO_APPROVER_CODE`. Keep them in the server environment. Set `INVESTIGATOR_MODE=scripted` for a repeatable demonstration. `API_PORT` and `DEMO_DB_PATH` control the local API and SQLite file. Live Sarvam requires a server-side `SARVAM_API_KEY` and `SARVAM_MODEL`.

```sh
npm run dev
```

Open [the local workspace](http://localhost:5173). Sign in as **Operator** to run or reset the demo. Use a second browser profile or separate private window as **Approver** for the human decision. The **Switch role** control establishes a new authenticated session when you have the code for that role.

For a single same-origin app, run `npm run build` and `npm run start:api`. The workflow server serves `dist/web` and `/api/v1` on port 3001 by default.

## Try the Soundbox incident

1. In **Mission Control**, keep Soundbox and Complete recovery selected, then click **Run Simulation**.
2. In **Incident War Room**, inspect the records, work log and recovery. The verifier should report **20 / 24** while the restart proposal waits.
3. In **Human Approval Center**, sign in as Approver, review the four exact targets, and confirm the simulated restart. Return to the incident to see the persisted **24 / 24** verification.
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
