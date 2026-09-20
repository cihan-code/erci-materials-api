# Whole-order stages and preparation checks

The existing "Ajana söyle" action records operation states, not partial piece
counts. "A dikildi" completes sewing for the whole order. "B kesilemedi" keeps
cutting open for the next day's plan. No completed/remaining quantity is requested.

Action: record_production_progress. Envelope: {date, entries}.
Operation entry: {job_id, kind: "operation", op_id, status, note?}; status is
not_started, in_progress, completed, blocked. A blocked stage requires a reason.
Check entry: {job_id, kind: "check", check_id, status, note?}; status is confirmed,
missing, unknown. Initial checks are print_files_sent and embroidery_files_sent.

The complete batch is validated and saved atomically in the agent-owned
DATA_DIR/uretim/progress.json (schema v2), never panel-data.json. Schema v1 was an
undeployed quantity prototype and is rejected rather than guessed or overwritten.

The daily generator reads stage/check reports automatically. File reminders appear
when the relevant handoff/work is due today or next working day. Confirmation
persists. Unknown is a question; explicitly missing means an action is required.
Sending files does not send bundles or complete decoration. Sending bundles does
not confirm file delivery. Completed decoration needs no retroactive file reminder.

Output fields: today_plan[].progress_status, progress_date, progress_note,
carried_over, readiness, actionable, preflight_checks; top-level progress_rows,
check_rows, reminders, needs_attention. Preserve descriptive order quantity.
No remaining_quantity field. Display conditional operations distinctly; do not
present actionable:false as ready to execute. Dates remain provisional while
preparation checks or ongoing-stage durations are unresolved.

Backend branch: codex/aksam-ilerleme. Operations branch: codex/atolye-plani.
Claude integration handoff:
/private/tmp/mercitex-codex-atolye-plani/uretim/PROGRESS-HANDOFF.md

Test: npm run uretim. Uses temporary data and a model stub, no paid API request.
Actual language extraction remains an acceptance check. This branch is not deployed.
Existing panel result rendering works; its generic "Panel verisi güncellendi"
notice can later be specialized because this action only changes the agent ledger.
