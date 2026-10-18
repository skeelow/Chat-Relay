# Test A — relay/store.ts

Task: Test A — `relay/store.ts` exactly to the Interfaces section: SQLite tables plus `insertMessage`, `markStatus`, `pendingDeliveries`, `isDuplicate`, with a test script.
Result: pass

Acceptance checks:

- [x] `npm test` passes on a fresh clone — fresh `git clone` of this repo into a temp dir, `npm install` (zero dependencies), `npm test`: 9 tests, 0 failures.
- [x] Inserting the same content from the same source twice within 10 minutes is rejected as a duplicate — store.test.ts; whitespace-only differences hash the same and are rejected too; same body from another source and 11 minutes later are both accepted.
- [x] Killing the process mid-delivery and restarting lists that message as `pending`, never as `delivered` — tests/crash-child.ts marks the delivery `delivering` then SIGKILLs itself; tests/restart-child.ts reopens the database in a new process and `pendingDeliveries()` returns that row.
- [x] Messages carrying the relay header are never stored as new captures — `insertMessage` rejects any body whose first line matches `^\[Relay ·` with `StoreError('relay_header')`; header mentions later in the text are normal content.

Files changed: `package.json`, `.gitignore`, `relay/store.ts`, `tests/store.test.ts`, `tests/crash-child.ts`, `tests/restart-child.ts`, `docs/status/test-a.md`

Surprises:

- Node on this machine is v26.7.0; the packet targets Node 22 LTS. The store uses `node:sqlite` (built in) instead of adding better-sqlite3, so `npm install` is a no-op and nothing native is compiled; on early 22.x releases `node:sqlite` needs the `--experimental-sqlite` flag.
- Interface decisions: `contentHash` is always computed by the store from the trimmed body; ids default to a generated ULID (engine may pass its own); `insertMessage` creates one `queued` delivery row per target; `attempts` increments each time `markStatus` sets `delivering`; the 10-minute duplicate window follows the message's `createdAt`.
- git had no author identity configured on this machine; a repo-local one was set (skeelow + GitHub noreply address).

Open questions for the publisher:

- Push access: work is committed locally; no github.com credentials exist on this machine (no gh CLI, no stored token).
- Runtime: stay on Node 26.7.0 here, or install Node 22 LTS as the packet targets?
- Delivery rows start `queued`; when the engine implements approve-each mode it should either mark them `pending_approval` itself or the store should take an initial status. Preference?
