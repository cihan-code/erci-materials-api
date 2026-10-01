# Intraday production feedback

## Behavior and ownership

The panel's **Operasyon Planı** accepts today's free-text reports for one selected
`uretimTakip.id`. A report becomes an immutable event after Claude extraction and
server validation. Partial quantities remain open, dispatch does not imply work
completion, and ambiguity asks a question without saving. Undo retains the event
as voided and recalculates the plan. Existing panel records are never rewritten.

`DATA_DIR/operations/journal.json` owns this workflow. It is separate from the
legacy `agent/uretim` progress ledger keyed by `jobs.id`; do not mix those IDs.
Use the existing single Node service with its persistent disk. Back up the journal
with other agent data. Corruption fails visibly instead of replacing history.

## API and concurrency

All routes use the existing `x-api-key` authentication:

- `GET /api/agent/operations`: versioned snapshot, history, rules and revision.
- `POST /api/agent/operations/report`: `record_id`, `text`, `request_id`,
  `revision`, `fingerprint`; returns `saved`, clarification or updated snapshot.
- `POST /api/agent/operations/undo`: `event_id`, `revision`.
- `POST /api/agent/operations/rule`: `issue`, `status`, `revision`.

Revision checks and record fingerprints reject stale writes, including panel
changes during extraction. Stable request IDs make network retries idempotent.
Reports use Istanbul's current date. Explicitly dated historical reports require
clarification. The UI requires saving any pending panel edits first.

## Production memory

Explicit obstacles build evidence across distinct production records. Three
records trigger a preparation-rule suggestion. Only accepted rules become
reminders on relevant unfinished work; repeated reports on one record do not
increase the sample count. Undo can deactivate a rule by reducing its evidence.
This is evidence-based application memory, not model fine-tuning. Initial rules
cover missing print paper/files, embroidery files and materials; they do not
estimate capacity, vendor reliability or manufacturing durations.

## Cost and configuration

Reuse `ANTHROPIC_API_KEY` and the shared Claude client. One saved submission uses
Haiku, up to 1,500 output tokens, one attempt and a 45-second timeout. Input is the
selected record, latest operations and a report capped at 2,000 characters.
Refresh, planning, undo and memory learning make no model calls. Repeated saved
reports reuse their result. Usage is logged under `production_feedback`.
Mock mode must never save fabricated completion.

## Validation and rollout

Run `npm run operations` and `npm run uretim`. HTTP tests use a stubbed Claude
response with real Express routes, temporary data and a dummy API key. They never
send business records or incur model charges.

Deploy the API first, then panel assets, then the daily Python agent. The Python
agent intentionally stops if the feedback endpoint is unavailable; the explicit
`--without-feedback` flag restores legacy planning. After deployment verify one
synthetic partial report against the real configured model, undo it, and inspect
`production_feedback` usage. Roll back application code without deleting the
journal. Merge each branch with Claude's concurrent changes; do not replace main.
