# Platform (Owner 01) · Merchant Reliability OS

**SYNTHETIC DEMO.** No live Paytm, device or financial integrations exist. Settlements are read-only.

## Stack (chosen in the bootstrap)

| Item | Choice |
|---|---|
| Node | 24 LTS (`.nvmrc`), npm 11, one root `package-lock.json` |
| API | Express 5 on `127.0.0.1:3001`, prefix `/api/v1` |
| UI | React 19 + Vite 8 on `5173`, proxies `/api` to 3001 (`vite.config.ts`, root `apps/web`) |
| DB | SQLite (better-sqlite3), WAL, foreign keys, 5 s busy timeout, path `DEMO_DB_PATH` |
| Validation | zod 4 (`shared/contracts/http.ts`, `<Type>Schema`) |
| Tests | Vitest 5 + supertest (core/workflow/web), Playwright for combined browser checks |

## Scripts

| Script | What it does |
|---|---|
| `npm run dev:core` | Standalone platform (workflow routes return `WORKFLOW_UNAVAILABLE`) |
| `npm run dev:api` | Assembled API via Owner 02's `server/workflow/entry.ts` (**pending** until feat/workflow lands) |
| `npm run dev:web` | Vite UI alone |
| `npm run dev` | Assembled API + Vite |
| `npm run seed` | Bootstrap the DB; `npm run seed -- --reset` starts a new generation |
| `npm run build` | Builds the UI to `dist/web` (served same-origin by the API when present) |
| `npm run check` | TypeScript type check (all paths) |
| `npm run test:core` | Platform tests (temporary SQLite + real HTTP) |
| `npm run test:workflow` | Owner 02 tests. **Fails with "no test files" until they exist; never counts as passed.** |
| `npm run test:web` | Owner 03 isolated UI tests (`apps/web/**/*.test.tsx`), **pending** |
| `npm run test:e2e` | Combined browser checks (`tests/acceptance`), **pending**; run `npx playwright install chromium` once |

## Local setup

```powershell
copy .env.example .env   # then fill DEMO_SESSION_SECRET (32+ chars) and two different access codes
npm ci
npm run dev:core
```

Sign in (the role is granted only if the access code matches the server setting):

```http
POST /api/v1/demo/session
Content-Type: application/json

{ "role": "operator", "accessCode": "<DEMO_OPERATOR_CODE>" }
```

The response sets an `HttpOnly; SameSite=Strict` cookie and returns `SessionView` with `csrfToken`.
Every non-session mutation must send **both** headers:

```
X-CSRF-Token: <csrfToken from SessionView>
X-Demo-Generation: <generation from SessionView / reset>
```

Errors: `401 UNAUTHENTICATED`, `403 FORBIDDEN` (role or CSRF), `409 STALE_GENERATION`, `409 INJECTION_CONFLICT`,
`404 NOT_FOUND`, `400 INVALID_INPUT`, `503 WORKFLOW_UNAVAILABLE`. Shape: `{ error: { code, message, requestId } }`.

Example responses for consumers: `shared/contracts/examples.ts` (pending 20/24 and final 24/24).
Never feed those fixtures to the investigator.

## Data and correlation

* Seed: 120 merchants, 125 devices, historical payments/settlements; deterministic relationships (`SEED = 20261120`), fresh opaque IDs per generation.
* `POST /demo/inject/soundbox` adds 24 `NOTIFICATION_FAILED` events (model SBX-AI-2, config 7.4.1, signature `NOTIFY_PUSH_DROPPED`) plus distractors: same signature 40 min earlier, a different signature, the same model on another config. Also 24 successful payments (money arrived, alert missing) and 9 merchant tickets.
* Correlation: same model + config + signature, ≥ 3 distinct merchants within a 5-minute window. The cohort is frozen at creation, and the reason is stored in `incidents.correlation_json` with the note that the shared config is **not** a proven root cause.
* Scenario B (`duplicate-tickets`): 14 settlement-query tickets from 6 merchants. One is already linked to an older case (conflict guard).
* Scenario C (`settlement-discrepancy`): 8 `SHORT` settlements on batch `NEFT-B1119-07`. Read-only; no mutation port exists.
* Private simulator truth (which 4 devices need a restart, which one fails in `partial`) lives in `sim_device_behavior` and `server/core/seed.ts`. It is never exposed through evidence or tools.

## Ports for Owner 02 (`shared/contracts/core.ts`)

`createApp` builds `CoreRuntime` and passes it to `createWorkflow`. Notes:

* `incidents.transition` checks active generation, expected version and the published `INCIDENT_TRANSITIONS` edge. `RESOLVED` requires `verifiedCheckId`.
* `simulation.apply` is idempotent per `actionId` (a replay returns the stored result; changed parameters → `CoreError("CONFLICT")`). Device actions enqueue `core.telemetry` (key `telemetry:<actionId>`) in the same transaction. The telemetry job emits `heartbeat`, `config` and `notification_probe` observations with a monotonic per-generation `sequence`.
* `jobs.enqueue` deduplicates `(generation, key)`. The initial key is `investigate:<incidentId>:initial`. Handlers must call `jobs.assertLease` inside their effect transaction; a reset or lost lease throws `CoreError("FENCED")` and the job is cancelled.
* `clock.now()` is server time (approval expiry). `clock.telemetryNow()` is simulated device time.

Core FK keys available to `010_workflow.sql`: `generations(id)`, `incidents(id)`, `devices(id)`, `merchants(id)`, `tickets(id)`, `jobs(id)`.
Migrations load by filename order, so `010_workflow.sql` is picked up automatically.

## Integration seams (pending)

* `server/workflow/entry.ts` must call `startServer({ createWorkflow })` (Owner 02).
* Combined checks (`test:e2e`, the assembled `dev`) are **not run** until feat/workflow and feat/product exist.
* Live Sarvam investigator proof is reported separately from core readiness (Owner 02).
