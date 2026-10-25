// Relay Chat — SQLite store.
// Implements the Interfaces section of docs/SPEC.md (bake-off Test A / task M1.1):
//   tables:    messages, deliveries, settings, adapter_state (relay.db)
//   functions: insertMessage, markStatus, pendingDeliveries, isDuplicate
// Zero dependencies: node:sqlite + node:crypto only.

import { DatabaseSync } from 'node:sqlite';
import { createHash, randomInt } from 'node:crypto';

export type Participant = 'user' | 'astra' | 'codex';

export type Status =
  | 'captured'
  | 'pending_approval'
  | 'queued'
  | 'delivering'
  | 'delivered'
  | 'failed'
  | 'cancelled';

export interface RelayMessage {
  id: string;            // ULID, assigned by the engine
  source: Participant;
  targets: Participant[]; // who should receive it
  body: string;          // final Markdown only: no reasoning, tool logs or partial text
  contentHash: string;   // sha256 of body after trimming whitespace
  sourceRef?: string;    // Codex turn id, or ChatGPT message element id
  hop: number;           // 0 = written by the user; +1 each AI-to-AI relay
  createdAt: string;     // ISO 8601
}

export type StoreErrorCode =
  | 'duplicate'
  | 'relay_header'
  | 'echo'
  | 'not_found'
  | 'settled'
  | 'invalid_targets';

export class StoreError extends Error {
  readonly code: StoreErrorCode;
  constructor(code: StoreErrorCode, message: string) {
    super(message);
    this.name = 'StoreError';
    this.code = code;
  }
}

/** Crockford base32 — the ULID alphabet (no I, L, O, U). */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** ULID: 10 chars of millisecond timestamp + 16 chars of randomness = 26 chars.
 * Monotonic (M1.5 N1): within the same millisecond the previous random part
 * is incremented instead of drawing fresh randomness, so ids sort in
 * generation order even inside one ms — recentMessages' id ordering then
 * equals capture order. */
let lastUlidMs = -1;
let lastUlidRand = '';

/** Carry-increment over the Crockford alphabet (only used when the
 * millisecond repeats; a full 80-bit overflow wraps to zeros — that takes
 * 2^80 ids inside one millisecond). */
function incrementCrockford(value: string): string {
  const chars = value.split('');
  for (let i = chars.length - 1; i >= 0; i--) {
    const digit = CROCKFORD.indexOf(chars[i]);
    if (digit < 31) { chars[i] = CROCKFORD[digit + 1]; return chars.join(''); }
    chars[i] = '0'; // carry into the next position
  }
  return chars.join('');
}

export function ulid(epochMs: number = Date.now()): string {
  // B4: a backwards clock step must not sort new ids before old ones —
  // clamp to the last used millisecond and let the increment keep order.
  const effectiveMs = Math.max(epochMs, lastUlidMs);
  let t = effectiveMs;
  let time = '';
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  let rand: string;
  if (lastUlidRand !== '' && effectiveMs === lastUlidMs) {
    rand = incrementCrockford(lastUlidRand);
  } else {
    rand = '';
    for (let i = 0; i < 16; i++) rand += CROCKFORD[randomInt(0, 32)];
  }
  lastUlidMs = effectiveMs;
  lastUlidRand = rand;
  return time + rand;
}

/** sha256 of the body after trimming whitespace (SPEC: contentHash). */
export function hashBody(body: string): string {
  return createHash('sha256').update(body.trim(), 'utf8').digest('hex');
}

/** M3.2a (D11-2): the turn cap bounds machines, never the publisher — manual
 *  forwards pass regardless; M5's automatic routing is what checks this. */
export function isOverTurnCap(hop: number, cap: number): boolean {
  return hop >= cap;
}

// --- M4.2 (D16): the relay settings ---

/** The set_mode fields after validation — only the provided ones. */
export interface ModeUpdate {
  mode?: 'manual' | 'approve_each' | 'auto';
  turnCap?: number;
  autoSend?: boolean;
  autoSendDelaySec?: number;
}

/**
 * M4.2 (D16-2): validate a set_mode frame, pure. Only provided fields are
 * checked; any invalid value — a mode of 'auto' (not accepted until M5.1), a
 * turn cap outside 1..50, a non-boolean autoSend, a delay outside 3..1800 —
 * rejects the WHOLE frame (null). The engine logs and ignores it entirely.
 */
export function validateModeUpdate(update: {
  mode?: unknown; turnCap?: unknown; autoSend?: unknown; autoSendDelaySec?: unknown;
}): ModeUpdate | null {
  const result: ModeUpdate = {};
  if (update.mode !== undefined) {
    if (update.mode !== 'manual' && update.mode !== 'approve_each' && update.mode !== 'auto') return null;
    result.mode = update.mode;
  }
  if (update.turnCap !== undefined) {
    if (typeof update.turnCap !== 'number' || !Number.isInteger(update.turnCap) ||
        update.turnCap < 1 || update.turnCap > 50) return null;
    result.turnCap = update.turnCap;
  }
  if (update.autoSend !== undefined) {
    if (typeof update.autoSend !== 'boolean') return null;
    result.autoSend = update.autoSend;
  }
  if (update.autoSendDelaySec !== undefined) {
    if (typeof update.autoSendDelaySec !== 'number' || !Number.isInteger(update.autoSendDelaySec) ||
        update.autoSendDelaySec < 3 || update.autoSendDelaySec > 1800) return null;
    result.autoSendDelaySec = update.autoSendDelaySec;
  }
  return result;
}

/** SPEC relay header. Tested against the trimmed body, so leading blank
 *  lines or spaces cannot sneak copied text past the filter: a first line
 *  matching this means the relay itself injected the text. */
const RELAY_HEADER = /^\[Relay ·/;

/** Same source + content_hash counts as a duplicate inside this window (SPEC: duplicate rule). */
export const DUPLICATE_WINDOW_MS = 10 * 60 * 1000;

export interface InsertInput {
  source: Participant;
  targets: Participant[];
  body: string;
  /** Codex turn id, or ChatGPT message element id. */
  sourceRef?: string;
  hop: number;
  /** Set when the engine already assigned one; otherwise a ULID is generated. */
  id?: string;
  /** ISO 8601, defaults to now. Normalized to UTC on the way in;
   *  the duplicate window follows this timestamp. */
  createdAt?: string;
  /** Starting status for each delivery row. Defaults to 'pending_approval':
   *  nothing is ever sent unless something deliberately asks for it. */
  initialStatus?: Status;
  /** M4.1: the user's deliberate resend is stored even when the 10-minute
   *  duplicate rule would reject it — the outbound dedupe then fails the
   *  delivery row instead ("identical text was already sent…"). Adapter
   *  captures never set this; the duplicate rule still guards them. */
  allowDuplicate?: boolean;
}

export interface PendingDelivery {
  messageId: string;
  target: Participant;
  status: Status;
  attempts: number;
  updatedAt: string;
  source: Participant;
  body: string;
  contentHash: string;
  sourceRef: string | null;
  hop: number;
  createdAt: string;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS messages (
    id           TEXT PRIMARY KEY,
    source       TEXT NOT NULL CHECK (source IN ('user','astra','codex')),
    body         TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    source_ref   TEXT,
    hop          INTEGER NOT NULL CHECK (hop >= 0),
    created_at   TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS messages_source_ref
    ON messages (source_ref) WHERE source_ref IS NOT NULL;
  CREATE INDEX IF NOT EXISTS messages_dedupe
    ON messages (source, content_hash, created_at);

  CREATE TABLE IF NOT EXISTS deliveries (
    message_id TEXT NOT NULL REFERENCES messages (id),
    target     TEXT NOT NULL CHECK (target IN ('user','astra','codex')),
    status     TEXT NOT NULL CHECK (status IN
      ('captured','pending_approval','queued','delivering','delivered','failed','cancelled')),
    attempts   INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    error      TEXT,
    PRIMARY KEY (message_id, target)
  );

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS adapter_state (
    adapter       TEXT PRIMARY KEY,
    last_seen_ref TEXT,
    updated_at    TEXT NOT NULL
  );
`;

export interface RelayStore {
  /** Store one captured message and its delivery rows in one transaction.
   *  Delivery rows start as 'pending_approval' unless initialStatus says otherwise.
   *  Throws StoreError('relay_header') if the trimmed body starts with the relay header,
   *  StoreError('echo') when the body matches a message delivered to this source
   *  within the echo window (a delivery bouncing back, M2.1),
   *  StoreError('duplicate') per the SPEC duplicate rule,
   *  StoreError('invalid_targets') when targets is empty. */
  insertMessage(input: InsertInput): RelayMessage;
  /** Update one delivery row. Attempts increment each time status becomes 'delivering'.
   *  `error` is stored for 'failed' and as an informational note on 'pending_approval'
   *  (the M3.2b stop notes, like the restart notes); it is cleared for every other status.
   *  Delivered and cancelled are final — any further change is rejected. */
  markStatus(messageId: string, target: Participant, status: Status, error?: string | null): void;
  /** One delivery row by key, or null. */
  getDelivery(messageId: string, target: Participant): DeliveryView | null;
  /** One stored message by id (targets rebuilt from delivery rows), or null. */
  getMessage(messageId: string): RelayMessage | null;
  /** M2.1: the GUI forwards an existing message to a new target — this
   *  creates its delivery row as 'pending_approval'. Nothing ever sends itself. */
  insertDelivery(messageId: string, target: Participant): void;
  /** Every delivery row of the given messages whose target is not 'user',
   *  ordered by message id then target (the snapshot's deliveries array). */
  deliveriesOf(messageIds: string[]): DeliveryView[];
  /** Delivery rows joined with their message data, filtered by target and
   *  status — how the engine finds what to send on hello (queued) or fail
   *  on disconnect (delivering). Oldest first. */
  deliveriesForTarget(target: Participant, ...statuses: Status[]): PendingDelivery[];
  /** M2.1 no-replay: on engine start, queued/delivering rows go back to
   *  pending_approval. Returns how many rows were reset. */
  resetInFlightToPending(): number;
  /** M2.2: settings table accessors (SPEC Interfaces: relay mode, turn cap,
   *  codex thread id...). A missing key reads back null. */
  getSetting(key: string): string | null;
  setSetting(key: string, value: string): void;
  /** M3.2a (D11-2): the turn_cap setting; 4 unless a positive integer is stored. */
  turnCap(): number;
  /** M4.2 (D16-1) + M5.1 (D18-1): the relay_mode setting — 'manual'
   *  (default), 'approve_each' or 'auto'; anything else reads back as
   *  manual. */
  relayMode(): 'manual' | 'approve_each' | 'auto';
  setRelayMode(mode: 'manual' | 'approve_each' | 'auto'): void;
  setTurnCap(cap: number): void;
  /** M4.2: the auto_send setting — "1" or absent (off). Stored and shown
   *  only until M5.1 gives it an effect. */
  autoSend(): boolean;
  setAutoSend(value: boolean): void;
  /** M4.2: the auto-send delay in seconds, 3 to 1800 (default 10). */
  autoSendDelaySec(): number;
  setAutoSendDelaySec(seconds: number): void;
  /** M3.2b (D12-1): the persisted stopped state. "1" means stopped; the key's
   *  absence (or any other value) means running. It survives restarts. */
  paused(): boolean;
  /** M3.2b: set the stopped state — stored as "1", removed entirely when cleared. */
  setPaused(value: boolean): void;
  /** M3.2a (D11-1): the hop for a new capture from `participant` — the last
   *  delivered hop to it + 1 when it has captured nothing since that delivery
   *  was marked delivered, else 0 (as if written by the user). */
  hopForCapture(participant: Participant): number;
  /** M3.2a (D11-3): another delivery of the same content to the same target
   *  that is delivering/delivered inside the 10-minute window, or null. */
  recentIdenticalDelivery(contentHash: string, target: Participant, excludeMessageId: string): DeliveryView | null;
  /** Every delivery not yet settled: queued, pending_approval or delivering. */
  pendingDeliveries(): PendingDelivery[];
  /** M4.3 (D17-2): case-insensitive substring search over message bodies,
   *  parameterised, with %, _ and the escape character escaped so they all
   *  match literally. Newest `limit` matches, newest first, plus the total
   *  count across the whole history. */
  searchMessages(query: string, limit: number): { messages: RelayMessage[]; total: number };
  /** The newest `limit` messages, oldest first (ids are ULIDs, so id order is
   *  time order). Targets are rebuilt from the deliveries rows, sorted.
   *  A limit <= 0 returns nothing (SQLite would read a negative LIMIT as
   *  unlimited, which is never what a caller wants here). */
  recentMessages(limit: number): RelayMessage[];
  /** SPEC duplicate rule: same source + content_hash within 10 minutes, or a source_ref already stored. */
  isDuplicate(source: Participant, contentHash: string, sourceRef?: string): boolean;
  close(): void;
}

/** A delivery row as the GUI sees it (delivery_update / snapshot deliveries). */
export interface DeliveryView {
  messageId: string;
  target: Participant;
  status: Status;
  attempts: number;
  updatedAt: string;
  error: string | null;
}

export function openStore(dbPath: string = 'relay.db'): RelayStore {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  // M2.1: relay.db files created before the error column cannot be extended
  // by CREATE TABLE IF NOT EXISTS — add the column once, keeping old files valid.
  const columns = db.prepare('PRAGMA table_info(deliveries)').all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === 'error')) {
    db.exec('ALTER TABLE deliveries ADD COLUMN error TEXT');
  }

  const now = (): string => new Date().toISOString();

  const isDuplicate = (source: Participant, contentHash: string, sourceRef?: string): boolean => {
    const cutoff = new Date(Date.now() - DUPLICATE_WINDOW_MS).toISOString();
    const recent =
      db.prepare('SELECT 1 FROM messages WHERE source = ? AND content_hash = ? AND created_at >= ? LIMIT 1')
        .get(source, contentHash, cutoff);
    if (recent !== undefined) return true;
    if (sourceRef !== undefined) {
      const known = db.prepare('SELECT 1 FROM messages WHERE source_ref = ? LIMIT 1').get(sourceRef);
      if (known !== undefined) return true;
    }
    return false;
  };

  const insertMessage = (input: InsertInput): RelayMessage => {
    if (input.targets.length === 0) {
      throw new StoreError('invalid_targets', 'a message needs at least one target');
    }
    // Copied text often starts with blank lines or spaces: check the trimmed body.
    if (RELAY_HEADER.test(input.body.trim())) {
      throw new StoreError('relay_header',
        'message carries the relay header; it is never stored as a new capture');
    }
    const contentHash = hashBody(input.body);
    // M2.1 echo rule: a capture from P whose body matches a message recently
    // delivered TO P is that delivery bouncing back, not a new reply. Same
    // 10-minute window as the duplicate rule, keyed on the delivery's update.
    const echoCutoff = new Date(Date.now() - DUPLICATE_WINDOW_MS).toISOString();
    const echo = db.prepare(
      `SELECT 1 FROM deliveries d JOIN messages m ON m.id = d.message_id
        WHERE m.content_hash = ? AND d.target = ? AND d.updated_at >= ?
          AND d.status IN ('delivering', 'delivered') LIMIT 1`
    ).get(contentHash, input.source, echoCutoff);
    if (echo !== undefined) {
      throw new StoreError('echo',
        'capture matches a message delivered to this adapter within the echo window');
    }
    if (!input.allowDuplicate && isDuplicate(input.source, contentHash, input.sourceRef)) {
      throw new StoreError('duplicate',
        'same source and content_hash within 10 minutes, or a source_ref already stored');
    }
    // The duplicate window compares ISO strings, so normalize any input to UTC.
    const createdAt = input.createdAt !== undefined ? new Date(input.createdAt).toISOString() : now();
    const message: RelayMessage = {
      id: input.id ?? ulid(),
      source: input.source,
      targets: input.targets,
      body: input.body,
      contentHash,
      sourceRef: input.sourceRef,
      hop: input.hop,
      createdAt,
    };
    const stamp = now();
    const insertRow =
      db.prepare('INSERT INTO messages (id, source, body, content_hash, source_ref, hop, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
    const addDelivery =
      db.prepare('INSERT INTO deliveries (message_id, target, status, attempts, updated_at) VALUES (?, ?, ?, 0, ?)');
    // One transaction for the message and its delivery rows: a crash or a
    // failed insert can never leave a message saved with nowhere to go.
    db.exec('BEGIN');
    try {
      insertRow.run(message.id, message.source, message.body, message.contentHash,
                   message.sourceRef ?? null, message.hop, message.createdAt);
      for (const target of new Set(input.targets)) {
        addDelivery.run(message.id, target, input.initialStatus ?? 'pending_approval', stamp);
      }
      db.exec('COMMIT');
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch { /* the transaction was already closed */ }
      throw err;
    }
    return message;
  };

  const markStatus = (messageId: string, target: Participant, status: Status, error: string | null = null): void => {
    // Delivered and cancelled are final: a finished delivery must never go
    // back to pending, or the message could be sent twice. The error column
    // holds the failure text while the row is failed, and an informational
    // note while it is pending_approval (M3.2b: the stop notes — the same
    // shape resetInFlightToPending's restart notes already give pending rows).
    // Every other status clears it.
    const keepError = status === 'failed' || status === 'pending_approval';
    const result = db.prepare(
      `UPDATE deliveries
         SET status = ?, updated_at = ?, attempts = attempts + ?, error = ?
       WHERE message_id = ? AND target = ?
         AND status NOT IN ('delivered', 'cancelled')`
    ).run(status, now(), status === 'delivering' ? 1 : 0,
          keepError ? error : null, messageId, target);
    if (result.changes === 0) {
      const row = db.prepare('SELECT status FROM deliveries WHERE message_id = ? AND target = ?')
        .get(messageId, target);
      if (row === undefined) {
        throw new StoreError('not_found', `no delivery of ${messageId} to ${target}`);
      }
      throw new StoreError('settled',
        `delivery of ${messageId} to ${target} is ${(row as { status: Status }).status}; it can no longer change`);
    }
  };

  const rowToDelivery = (row: Record<string, unknown>): DeliveryView => ({
    messageId: row.message_id as string,
    target: row.target as Participant,
    status: row.status as Status,
    attempts: row.attempts as number,
    updatedAt: row.updated_at as string,
    error: (row.error as string | null) ?? null,
  });

  const getDelivery = (messageId: string, target: Participant): DeliveryView | null => {
    const row = db.prepare(
      'SELECT message_id, target, status, attempts, updated_at, error FROM deliveries WHERE message_id = ? AND target = ?'
    ).get(messageId, target) as Record<string, unknown> | undefined;
    return row === undefined ? null : rowToDelivery(row);
  };

  const getMessage = (messageId: string): RelayMessage | null => {
    const row = db.prepare(
      'SELECT id, source, body, content_hash, source_ref, hop, created_at FROM messages WHERE id = ?'
    ).get(messageId) as Record<string, unknown> | undefined;
    if (row === undefined) return null;
    const targets = (db.prepare('SELECT target FROM deliveries WHERE message_id = ? ORDER BY target')
      .all(messageId) as Record<string, unknown>[]).map((t) => t.target as Participant);
    return {
      id: row.id as string,
      source: row.source as Participant,
      targets,
      body: row.body as string,
      contentHash: row.content_hash as string,
      ...(row.source_ref !== null ? { sourceRef: row.source_ref as string } : {}),
      hop: row.hop as number,
      createdAt: row.created_at as string,
    };
  };

  const insertDelivery = (messageId: string, target: Participant): void => {
    db.prepare('INSERT INTO deliveries (message_id, target, status, attempts, updated_at) VALUES (?, ?, ?, 0, ?)')
      .run(messageId, target, 'pending_approval', now());
  };

  const deliveriesOf = (messageIds: string[]): DeliveryView[] => {
    if (messageIds.length === 0) return [];
    const placeholders = messageIds.map(() => '?').join(', ');
    return (db.prepare(
      `SELECT message_id, target, status, attempts, updated_at, error FROM deliveries
        WHERE message_id IN (${placeholders}) AND target != 'user'
        ORDER BY message_id, target`
    ).all(...messageIds) as Record<string, unknown>[]).map(rowToDelivery);
  };

  const deliveriesForTarget = (target: Participant, ...statuses: Status[]): PendingDelivery[] => {
    if (statuses.length === 0) return [];
    const statusPlaces = statuses.map(() => '?').join(', ');
    return (db.prepare(
      `SELECT d.message_id, d.target, d.status, d.attempts, d.updated_at,
              m.source, m.body, m.content_hash, m.source_ref, m.hop, m.created_at
         FROM deliveries d JOIN messages m ON m.id = d.message_id
        WHERE d.target = ? AND d.status IN (${statusPlaces})
        ORDER BY m.created_at, d.message_id`
    ).all(target, ...statuses) as Record<string, unknown>[]).map(rowToPending);
  };

  const resetInFlightToPending = (): number => {
    // M3.2a (D11-5): a queued row restarts clean — nothing had been sent. A
    // delivering row may have partly happened on the far side, so it comes
    // back pending with an honest note instead of a bare reset.
    const queued = db.prepare(
      `UPDATE deliveries SET status = 'pending_approval', error = NULL
        WHERE status = 'queued'`
    ).run();
    const delivering = db.prepare(
      `UPDATE deliveries SET status = 'pending_approval',
          error = 'interrupted by a restart — it may already have arrived'
        WHERE status = 'delivering'`
    ).run();
    return Number(queued.changes) + Number(delivering.changes);
  };

  const getSetting = (key: string): string | null => {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?')
      .get(key) as Record<string, unknown> | undefined;
    return row === undefined ? null : row.value as string;
  };

  const setSetting = (key: string, value: string): void => {
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  };

  const turnCap = (): number => {
    const raw = getSetting('turn_cap');
    const parsed = raw === null ? NaN : Number(raw);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : 4; // SPEC default
  };

  const setTurnCap = (cap: number): void => {
    setSetting('turn_cap', String(cap));
  };

  const relayMode = (): 'manual' | 'approve_each' | 'auto' => {
    const raw = getSetting('relay_mode');
    return raw === 'approve_each' || raw === 'auto' ? raw : 'manual';
  };

  const setRelayMode = (mode: 'manual' | 'approve_each' | 'auto'): void => {
    setSetting('relay_mode', mode);
  };

  const autoSend = (): boolean => getSetting('auto_send') === '1';

  const setAutoSend = (value: boolean): void => {
    if (value) setSetting('auto_send', '1');
    else db.prepare('DELETE FROM settings WHERE key = ?').run('auto_send'); // "1" or absent, never another value
  };

  const autoSendDelaySec = (): number => {
    const parsed = Number(getSetting('auto_send_delay_sec'));
    return Number.isInteger(parsed) && parsed >= 3 && parsed <= 1800 ? parsed : 10; // SPEC default
  };

  const setAutoSendDelaySec = (seconds: number): void => {
    setSetting('auto_send_delay_sec', String(seconds));
  };

  const paused = (): boolean => getSetting('paused') === '1';

  const setPaused = (value: boolean): void => {
    if (value) setSetting('paused', '1');
    else db.prepare('DELETE FROM settings WHERE key = ?').run('paused'); // "1" or absent, never another value
  };

  const hopForCapture = (participant: Participant): number => {
    const delivery = db.prepare(
      `SELECT message_id, updated_at FROM deliveries
        WHERE target = ? AND status = 'delivered'
        ORDER BY updated_at DESC, rowid DESC LIMIT 1`
    ).get(participant) as { message_id: string; updated_at: string } | undefined;
    if (delivery === undefined) return 0;
    // The chain broke if this participant said anything since that delivery:
    const spokeSince = db.prepare(
      'SELECT 1 FROM messages WHERE source = ? AND created_at > ? LIMIT 1'
    ).get(participant, delivery.updated_at);
    if (spokeSince !== undefined) return 0;
    const message = db.prepare('SELECT hop FROM messages WHERE id = ?')
      .get(delivery.message_id) as { hop: number } | undefined;
    return message === undefined ? 0 : message.hop + 1;
  };

  const recentIdenticalDelivery = (
    contentHash: string,
    target: Participant,
    excludeMessageId: string,
  ): DeliveryView | null => {
    const cutoff = new Date(Date.now() - DUPLICATE_WINDOW_MS).toISOString();
    const row = db.prepare(
      `SELECT d.message_id, d.target, d.status, d.attempts, d.updated_at, d.error
         FROM deliveries d JOIN messages m ON m.id = d.message_id
        WHERE m.content_hash = ? AND d.target = ? AND d.message_id != ?
          AND d.status IN ('delivering', 'delivered') AND d.updated_at >= ?
        ORDER BY d.updated_at DESC LIMIT 1`
    ).get(contentHash, target, excludeMessageId, cutoff) as Record<string, unknown> | undefined;
    return row === undefined ? null : rowToDelivery(row);
  };

  const rowToPending = (row: Record<string, unknown>): PendingDelivery => ({
    messageId: row.message_id as string,
    target: row.target as Participant,
    status: row.status as Status,
    attempts: row.attempts as number,
    updatedAt: row.updated_at as string,
    source: row.source as Participant,
    body: row.body as string,
    contentHash: row.content_hash as string,
    sourceRef: (row.source_ref as string | null) ?? null,
    hop: row.hop as number,
    createdAt: row.created_at as string,
  });

  const pendingDeliveries = (): PendingDelivery[] =>
    (db.prepare(
      `SELECT d.message_id, d.target, d.status, d.attempts, d.updated_at,
              m.source, m.body, m.content_hash, m.source_ref, m.hop, m.created_at
         FROM deliveries d JOIN messages m ON m.id = d.message_id
        WHERE d.status IN ('queued', 'pending_approval', 'delivering')
        ORDER BY m.created_at, d.message_id, d.target`
    ).all() as Record<string, unknown>[]).map(rowToPending);

  const recentMessages = (limit: number): RelayMessage[] => {
    if (limit <= 0) return [];
    // Newest first by id (ULIDs are time-ordered), then reversed to oldest
    // first — the order a GUI replays them into the transcript.
    const rows = db.prepare(
      `SELECT id, source, body, content_hash, source_ref, hop, created_at
         FROM messages ORDER BY id DESC LIMIT ?`
    ).all(limit) as Record<string, unknown>[];
    if (rows.length === 0) return [];
    // Targets live in the deliveries table (SPEC interfaces); one grouped
    // query rebuilds them, sorted per message.
    const placeholders = rows.map(() => '?').join(', ');
    const deliveryRows = db.prepare(
      `SELECT message_id, target FROM deliveries
        WHERE message_id IN (${placeholders}) ORDER BY message_id, target`
    ).all(...rows.map((row) => row.id as string)) as Record<string, unknown>[];
    const targetsById = new Map<string, Participant[]>();
    for (const row of deliveryRows) {
      const id = row.message_id as string;
      const list = targetsById.get(id);
      if (list !== undefined) list.push(row.target as Participant);
      else targetsById.set(id, [row.target as Participant]);
    }
    return rows.reverse().map((row) => ({
      id: row.id as string,
      source: row.source as Participant,
      targets: targetsById.get(row.id as string) ?? [],
      body: row.body as string,
      contentHash: row.content_hash as string,
      ...(row.source_ref !== null ? { sourceRef: row.source_ref as string } : {}),
      hop: row.hop as number,
      createdAt: row.created_at as string,
    }));
  };

  const searchMessages = (query: string, limit: number): { messages: RelayMessage[]; total: number } => {
    if (limit <= 0) return { messages: [], total: 0 };
    // M4.3 (D17-2): a parameterised LIKE — %, _ and the escape character in
    // the user's text are escaped, so they always match literally. LIKE
    // folds case for ASCII; ULID order is time order, so id DESC is
    // newest-first without touching created_at formatting.
    const pattern = `%${query.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
    const total = (db.prepare(
      `SELECT COUNT(*) AS n FROM messages WHERE body LIKE ? ESCAPE '\\'`
    ).get(pattern) as { n: number }).n;
    const rows = db.prepare(
      `SELECT id, source, body, content_hash, source_ref, hop, created_at
         FROM messages WHERE body LIKE ? ESCAPE '\\' ORDER BY id DESC LIMIT ?`
    ).all(pattern, limit) as Record<string, unknown>[];
    if (rows.length === 0) return { messages: [], total };
    const placeholders = rows.map(() => '?').join(', ');
    const deliveryRows = db.prepare(
      `SELECT message_id, target FROM deliveries
        WHERE message_id IN (${placeholders}) ORDER BY message_id, target`
    ).all(...rows.map((row) => row.id as string)) as Record<string, unknown>[];
    const targetsById = new Map<string, Participant[]>();
    for (const row of deliveryRows) {
      const id = row.message_id as string;
      const list = targetsById.get(id);
      if (list !== undefined) list.push(row.target as Participant);
      else targetsById.set(id, [row.target as Participant]);
    }
    const messages = rows.map((row) => ({
      id: row.id as string,
      source: row.source as Participant,
      targets: targetsById.get(row.id as string) ?? [],
      body: row.body as string,
      contentHash: row.content_hash as string,
      ...(row.source_ref !== null ? { sourceRef: row.source_ref as string } : {}),
      hop: row.hop as number,
      createdAt: row.created_at as string,
    }));
    return { messages, total };
  };

  return {
    insertMessage,
    markStatus,
    getDelivery,
    getMessage,
    insertDelivery,
    deliveriesOf,
    deliveriesForTarget,
    resetInFlightToPending,
    getSetting,
    setSetting,
    turnCap,
    setTurnCap,
    relayMode,
    setRelayMode,
    autoSend,
    setAutoSend,
    autoSendDelaySec,
    setAutoSendDelaySec,
    paused,
    setPaused,
    hopForCapture,
    recentIdenticalDelivery,
    pendingDeliveries,
    recentMessages,
    searchMessages,
    isDuplicate,
    close: () => db.close(),
  };
}
