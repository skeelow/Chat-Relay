# Store fixes — five publisher changes to relay/store.ts

Task: The five store fixes from the publisher, applied before Test B.
Result: pass

Acceptance checks (one test per fix):

- [x] Message and delivery rows save together — `insertMessage` wraps both inserts in one `BEGIN`/`COMMIT` transaction with rollback on failure; verified by 'a failure while writing deliveries rolls the message back' (a forced delivery-insert failure leaves no orphan message, and the same body inserts cleanly afterwards).
- [x] Deliveries start `pending_approval` — default changed from `queued`; `insertMessage` takes an optional `initialStatus`; the insert test covers both the default and an explicit `queued` start.
- [x] Delivered/cancelled deliveries never change again — `markStatus` rejects any change to a settled row with `StoreError('settled')` (distinct from `not_found`); 'a delivered or cancelled delivery never changes again' asserts queued, delivering, failed and even a repeated cancelled all bounce, while 'failed may retry' confirms `failed` rows stay requeueable with `attempts` reaching 2.
- [x] Relay header caught after leading whitespace — the check now tests the trimmed body; the header test feeds `'  \n[Relay · …'` and expects `relay_header`, while `'   \nindented, but no header'` stores normally.
- [x] Timestamps normalized; empty targets rejected — `createdAt` converts through `new Date(x).toISOString()` ('2026-10-18T10:00:00-04:00' → '2026-10-18T14:00:00.000Z'), invalid timestamps throw and store nothing, and an empty `targets` list throws `StoreError('invalid_targets')`.

Suite: 13 tests, 0 failures on the working tree; re-verified on a fresh clone from github.com.

Files changed: `relay/store.ts`, `tests/store.test.ts`, `docs/status/store-fixes.md`

Surprises:

- Two new error codes were needed to keep rejections diagnosable: `settled` (row exists, delivered/cancelled) and `invalid_targets` (empty target list).
- `failed` deliberately stays re-enterable so the planned M3.2 retry (max 2) still fits; only `delivered` and `cancelled` are terminal.
- SQLite CHECK constraints on `deliveries.target` double as a clean way to force a mid-transaction failure in the rollback test.

Open questions for the publisher:

- With `pending_approval` as the default start, the engine (M2.1) should approve into `queued`/`delivering` — confirm that is the intended hand-off.
- Crash-during-transaction durability (as opposed to in-process failure) relies on SQLite's journal recovery, same as before.
