# Build prompt · Merchant Reliability OS release candidate

> Written as a brief from a senior software + product engineer to the implementer (me).
> Scope source: `Merchant_Reliability_OS_Complete_MVP_PRD_v2.docx` (v2.0, 19 Nov 2026).
> Constraint: **local only**: no pushes, PRs or remote changes.

## Role

You are the senior full-stack and product engineer who owns the release candidate of
Merchant Reliability OS. Teammates have already merged the platform (Owner 01), the workflow
(Owner 02) and the three-screen UI (Owner 03). Your job is to close every remaining gap
against the PRD and hand the internal team a product they can run and demo without help.

## Definition of the 10 features

FR-01 to FR-09 come from PRD §09. **FR-10** is PRD §10.4: use **Sarvam AI** for one meaningful,
clearly labelled step, with an honest scripted fallback.

## Known gaps to close (found by live testing on `main` @ 9f6c1ed)

| # | Gap | PRD reference | Owner area |
|---|---|---|---|
| G1 | "Why were these grouped?" is stored (`incidents.correlation_json`) but not returned by the API or shown | FR-03, §14 "expandable details for why cases were grouped" | core + UI |
| G2 | Incident creation is not in the visible chronology or audit | FR-08 | core read model |
| G3 | Scenario B links only one merchant's duplicates, then reports the task complete | §07 Scenario B | workflow |
| G4 | PRD endpoints missing: `POST /incidents/{id}/actions` (policy decides the path), `POST /incidents/{id}/verify`, `GET /incidents/{id}/audit` | §13, FR-06 test "restart endpoint returns denied/pending before approval" | workflow + core |
| G5 | Simulated success metrics (§15) are not computed or shown | §15 | core + UI |
| G6 | Sarvam has never run live; the model name must be current (`sarvam-105b` on `/v2/chat/completions`) | FR-10, §10.4 | workflow + config |
| G7 | Merchant detail drawer (P1) | §5.2 | UI |
| G8 | Complained vs silent merchants in the cohort (proactive outreach insight) | differentiator | core + UI |
| G9 | Internal-team runbook: how to run, demo, troubleshoot, configure Sarvam | §16 "Minimum demo deliverables" | docs |

## Engineering rules

1. **Contracts first, additive only.** Extend `shared/contracts/http.ts` with new fields and endpoints, and never break existing ones. Update `examples.ts`.
2. **The backend owns truth.** The UI never computes recovery, permission or resolution. Every new number comes from an API.
3. **Safety boundaries are untouchable.** Deny by default, approval for restart, verifier-only `RESOLVED`, no financial writes, generation fencing, CSRF.
4. **Honest AI labelling.** Show `live_ai` only when Sarvam actually produced the step, and label the fallback "Scripted fallback".
5. **Tests for every change.** Core (Vitest), workflow (Vitest), web (Vitest) and browser (Playwright). Keep the existing 99 tests green.
6. **Secrets stay server-side** in `.env`, never in the UI, Git or logs.
7. **Ship order:** G3 → G1/G2/G8 → G4 → G5 → UI (G1, G5, G7, G8) → G6 live proof → G9 → full regression → release rehearsal.

## Acceptance (release gate)

* `npm run check`, `test:core`, `test:workflow`, `test:web`, `build` and `test:e2e` all pass.
* The PRD §15 acceptance list holds on a live run: one incident for 24 devices; counters match the backend; at least one genuine tool call; sync gives 20/24; restart is blocked while pending, rejected or expired; approved restart runs once; `RESOLVED` only after fresh checks; failures stay visible; reset and repeat ×3.
* Scenario B links **every** eligible duplicate (7 across 6 merchants; 1 conflicting link left alone) and verifies them.
* `GET /incidents/{id}/audit` and the War Room audit start with **Incident detected** and include the approval decision.
* Grouping explanation, complained/silent split and simulated metrics are visible in the UI.
* Sarvam: a live run records `live_ai` trace steps with model `sarvam-105b`, or, without credentials, the UI clearly shows the labelled fallback and the reason.
* Single-origin production run (`npm run build && npm run start:api`) serves the full app on port 3001.
