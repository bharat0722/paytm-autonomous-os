# Payment confirmation development on release/rc1

## Release candidate baseline

The starting commit was [2664391](https://github.com/bharat0722/paytm-autonomous-os/commit/2664391348710439c96d393cd283b2efbf19c2f8). It already contains the operations overview, five detection-job definitions with **Run now**, the incident tabs, exposed Soundbox verification observations, and simulated metrics. The scheduler catalogue computes planned fire times. A continuously running connector and automatic source cursor are still needed for a real pilot.

| Ownership | Next implementation |
| --- | --- |
| Platform | Extend sandbox payment intake with trusted source credentials, merchant enrollment, source cursors, and continued updates to open cases. |
| Workflow | Add fresh gateway and order reads, versioned action policy, exact approvals, and an idempotent synthetic merchant receiver with independent post-action verification. |
| Product | Add a payment drill to the operations overview, a gateway/order comparison in the incident, and synthetic pilot metrics from persisted outcomes. |

The proposed live pilot owner is **Payment Gateway Integration Support**. Pilot activation needs one consenting cohort and authorized gateway reads, merchant order reads, and a merchant-owned reconciliation operation. The existing Soundbox and settlement paths remain available in the sandbox.

## Current sandbox slice

Send normalized synthetic observations to `POST /api/v1/demo/payment-signals` with an operator session cookie, `X-CSRF-Token`, and the current `X-Demo-Generation`. The API persists each observation and schedules a check in the existing worker. It accepts exact replays and rejects conflicting event IDs or source revisions.

Send these two bodies as separate requests:

```json
{"source":"merchant-order","eventId":"order-1-unpaid","merchantRef":"M001","orderRef":"order-1","revision":1,"amountPaise":12500,"currency":"INR","status":"UNPAID"}
```

```json
{"source":"gateway","eventId":"txn-1-captured","merchantRef":"M001","orderRef":"order-1","transactionRef":"txn-1","revision":1,"amountPaise":12500,"currency":"INR","status":"CAPTURED"}
```

After the two-minute sandbox propagation window, open the new incident from the operations overview. The incident records which gateway and merchant-order observations were matched, the grading reason, and the assigned team. An exact match with an overdue unpaid order shows **L1 · Exact match**. An amount or transaction conflict shows **L3 · Specialist review**. An already-paid order with the correct transaction and amount raises no incident.

This slice ends at a human handoff. It creates one incident per merchant and order in the active sandbox; the case's detection evidence is a snapshot. It accepts no live Paytm callbacks and makes no merchant-order or financial mutations.

The integration tests exercise the route, background job and incident API with controlled time. Run `npm test -- tests/core/payment-confirmation.test.ts` or the full suite with `npm test`. The Playwright suite also checks that the resulting incident and both source observations are readable in the browser.
