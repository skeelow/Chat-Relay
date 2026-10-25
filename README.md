# Relay Chat

Relay Chat is a local relay room that connects two AI assistants — ChatGPT
("Astra") and Codex — into one shared conversation, with you as the operator
in the middle. Nothing ever moves without your say-so: every relayed message
waits for your click, and the ChatGPT side is typing-only.

## The parts

| Part | What it is |
|---|---|
| `relay/engine.ts` | The engine: a WebSocket server on `127.0.0.1:8787` that owns the room, the delivery rules and the SQLite history (`relay.db`). |
| `app/` | The Electron GUI: the transcript, the message box, approvals, the settings panel, search, export, the tray. |
| `adapters/chatgpt-ext/` | A Chrome extension that speaks for ChatGPT: it captures replies and types relays into the chatgpt.com box — it never clicks Send there. |
| `adapters/codex/adapter.ts` | The Codex adapter: runs Codex turns on one dedicated "Relay Chat" thread and reports completions back. |

## Requirements

- Windows 11, Node.js 22 or newer
- Chrome or Edge (for the ChatGPT extension)
- The Codex CLI, installed and signed in with a ChatGPT account

## Setup

```bash
git clone https://github.com/skeelow/Chat-Relay.git
cd Chat-Relay
npm ci
```

Builds are committed (`app/dist`, `adapters/chatgpt-ext/dist`), so the app
runs without a build step. To rebuild after changes:

```bash
npm run build:gui   # rebuilds app/dist
npm run build:ext    # rebuilds adapters/chatgpt-ext/dist
```

**Load the extension** — in Chrome or Edge open `chrome://extensions`, turn
on Developer mode, click "Load unpacked" and select the `adapters/chatgpt-ext`
folder. Keep a chatgpt.com tab open; the extension connects as Astra.

**Start the engine** (it creates the token at `%APPDATA%\RelayChat\token` on
first start and keeps `relay.db` in the folder you start it from):

```bash
npm run start:engine
```

**Start the Codex adapter** — it creates a dedicated "Relay Chat" thread
and reuses it on later runs:

```bash
node adapters/codex/adapter.ts
```

**Start the GUI**:

```bash
npm run start:gui
```

## Daily use

- **Write to the room** in the box at the bottom. Start with `@astra`,
  `@codex` or `@both` (or use the selector). Enter sends; Shift+Enter is a
  newline. Your message is delivered immediately — your send is the approval.
- **Relay an AI reply** with the Send to Codex / Send to ChatGPT button under
  it, or **Approve / Reject** a pending item.
- **Stop** freezes the room: queued and in-flight items come back to you,
  nothing new moves until you press **Resume**.
- **The three modes** (Settings panel): **Manual** — everything waits for
  your click (the default). **Approve each** — every AI reply automatically
  becomes a pending item for the other AI; you Approve or Reject each hop.
  **Auto** — replies forward themselves between the AIs up to the **turn
  cap** (default 4); the next reply is held with a notice and the manual
  Send button still works. A new message from you restarts the chain.
- **Auto-send** (Auto mode only): a countdown on each pending item —
  "Sending in Ns" with **Send now** and **Cancel**. Cancel is the reject
  frame; Send now is the approve frame.
- **Search** covers the whole history (not just the screen), and **Export**
  writes the transcript as Markdown through a Save dialog.
- **The tray**: closing the window hides it to the tray; the relay keeps
  running (the engine is a separate process). Quit from the tray menu.

## Safety rules, in plain words

- Nothing is ever sent to ChatGPT automatically: relays are typed into the
  box, and you click Send there yourself.
- Codex approval requests are always yours — the relay never answers one.
- Nothing is replayed after a restart: in-flight and pending items come back
  waiting for you.
- There are no API keys or credentials — the only secret is a local token
  file, and the engine listens on `127.0.0.1` only.

## Troubleshooting

- **"cannot listen on 127.0.0.1:8787 (port in use)"** — another engine is
  already running; find it with `netstat -ano | findstr 8787`.
- **`npm run start:gui` says Electron's binary is missing** — your npm
  skipped Electron's install script (newer npm versions restrict
  dependency scripts). Fetch it once:
  `node node_modules/electron/install.js`.
- **The extension says the engine rejected the token** — the token file was
  recreated; reload the extension so it re-reads it, then restart the engine.
- **The ChatGPT tab must be reloaded after the extension reloads** — the
  content script only runs on tabs opened after the load.
- **Astra shows "selectors stale"** — chatgpt.com changed its DOM; the
  extension noticed instead of failing silently. Reload the tab first; if it
  persists, the extension needs a selector update.
- **The Relay Chat thread can't be typed into in the Codex app while the
  adapter runs** — the adapter holds the thread's writer; stop the adapter
  to type there yourself.

## Where the docs are

- `docs/SPEC.md` — the protocol and every rule of the room.
- `docs/status/` — one report per milestone task, newest last.
