# Evening production progress

Branch: `codex/aksam-ilerleme`. This is an additive integration with the existing
panel `POST /api/agent/act` and scheduled production-plan generator.

The language model extracts `record_production_progress` parameters. The backend
calculates cumulative totals and remaining pieces, validates job/operation IDs,
and atomically saves the whole report in `DATA_DIR/uretim/progress.json`.
Panel production/order/stock records are not changed by this action.

Example panel instruction: "TEST-101 dikiminde toplam 120 adet tamamlandı."
For a 300-piece order, the saved response reports 120 completed and 180 remaining.
The next day's sewing queue uses 180; packing still covers the order's 300 pieces.

The action supports `total`, `increment`, and `all` quantity modes. Daily increments
require a known baseline or explicit `first_progress: true`. Missing quantities or
ambiguous jobs must be clarified, not inferred. `not_started` records zero only
when the operation truly has never started. `blocked` requires a reason and holds
the job until a subsequent report releases it.

Same-day identical instructions are treated as retries; use an updated total for
additional identical production. Cumulative totals cannot decrease in this version.
Whole-operation completion does not mean other operations are complete.

`planSignals.js` loads the progress ledger on every scheduled run and preview.
It supplies the model with `remaining_quantity`, carryover dates/notes, and blocked
orders. Remaining quantity is not a daily target. Partial non-sewing operations
retain full route durations. Existing panel stages take precedence over old partial
reports when they already mark an operation complete.

Claude's table rendering work should consume the added fields and include the
attention list. Operations-repository handoff:
`/private/tmp/mercitex-codex-atolye-plani/uretim/PROGRESS-HANDOFF.md`.

Test: `npm run uretim`. Tests use temporary storage and a stubbed model. No live API
or paid model request is needed. Real-model language interpretation remains an
acceptance check, not a property proved by the deterministic tests.

Deployment: merge this backend branch and deploy using the existing process.
No frontend changes or new environment variables are needed. DATA_DIR must retain
its existing persistent volume. No deploy has been performed by this change.
