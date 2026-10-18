# Test B — M0.1 Codex spike

Task: Test B — task M0.1, `spikes/codex-resume.ts`: generate protocol types, spawn `codex app-server`, confirm ChatGPT login, list the 10 most recent threads, resume a thread and print its last turns, start a `[Relay · test]` PONG turn and stream every event.
Result: partial — every script-verifiable acceptance check passes; one check needs the publisher's eyes in the ChatGPT desktop app.

Acceptance checks:

- [x] Resumed thread shows the user's real earlier history — resumed `01a1424e-…` ("Run Scout Chapter 9 cold read"); `thread/turns/list` returned the prior turn with genuine content: user messages ("verify scout works the way we intend"), agent messages, reasoning items, tool calls, file changes.
- [x] The script detects turn completion from an event, not a timer — it resolves on the `turn/completed` notification (status=`completed`); the only timer is a 180s safety guard that FAILS the spike rather than completing it.
- [x] Final text is separated from reasoning and tool events — the final assistant text is printed on its own section (`=== final assistant text ===` → `PONG`); the event stream lists item types as they arrive, and the completed turn's item types are reported separately (`[agentMessage]`).
- [ ] Opening the same thread in the ChatGPT desktop app shows the PONG turn (live vs only after reopen) — needs the publisher: open thread `01a1424e-8e67-7d93-9f9a-6700ac34c538` ("Run Scout Chapter 9 cold read") in the ChatGPT desktop app and look for the `[Relay · test]` turn answering PONG.
- [x] No API key was used — `getAuthStatus` (called with `includeToken: false`, `refreshToken: false`; the token is never requested or printed) returned `authMethod: chatgpt`.

How it ran (codex-cli 0.161.0):

- `codex app-server generate-ts --out spikes/codex-schema` produced the protocol types; the spike type-imports only those — no protocol shape hand-written.
- Wire format confirmed by experiment: newline-delimited JSON over stdio. Requests `{method, id, params}`, responses `{id, result}`, server notifications `{method, params}`. Server-originated requests (approvals) carry an `id` — the spike prints them and never answers (hard rule: no automatic approvals).
- Resume uses the recommended paginated path: `thread/resume {threadId, excludeTurns: true}` → `thread/turns/list {limit: 3, itemsView: "full"}`.
- The PONG turn: `turn/start` with `input: [{type: "text", text: "[Relay · test] Reply with the word PONG and nothing else.", text_elements: []}]` → 2x `item/agentMessage/delta` (PONG streamed live), `item/completed: agentMessage`, then `turn/completed` with status `completed`. Final text: **PONG**.

Files changed: `spikes/codex-resume.ts`, `spikes/codex-schema/` (generated; pinned to codex-cli 0.161.0), `docs/status/test-b.md`

Surprises:

- The resumed thread's `approvalPolicy` is `never`, and no approval requests arrived during the spike — simple reply-only turns run clean.
- `thread/turns/list` with `limit: 3` returned only 1 turn: that thread's whole session is one long turn. Threads with more turns would print 3.
- Reasoning items in the OLD history come back with empty summary/content through this API; the fresh PONG turn emitted no reasoning items at all. Reasoning capture may not round-trip in history views.
- The first user message in that thread embeds a "Referenced ChatGPT conversation" block — codex threads can carry ChatGPT conversation references (relevant to the relay's capture rules later).
- Resume emits a burst of lifecycle notifications before the response (9x `mcpServer/startupStatus/updated`, `thread/status/changed`, `thread/goal/cleared`, `thread/tokenUsage/updated`) — an adapter must tolerate the noise.
- The user's `~/.codex/config.toml` has 2 unrecognized legacy settings; app-server logs warnings to stderr. Cosmetic, not ours.
- Node logs DEP0190 for `spawn(..., {shell: true})` on Windows (needed for the npm `.cmd` shim). Cosmetic; the adapter can resolve the shim path directly to silence it.

Open questions for the publisher:

- The desktop-app check above: does the PONG turn appear live or only after reopening?
- The PONG turn now permanently sits in the "Run Scout Chapter 9 cold read" thread. Acceptable, or should future test turns use a dedicated `thread/start` test thread?
- The generated schema is committed for reproducibility. Keep it pinned in the repo, or ignore it and regenerate per machine?
