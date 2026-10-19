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

export type StoreErrorCode = 'duplicate' | 'relay_header' | 'not_found' | 'settled' | 'invalid_targets';

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

/** ULID: 10 chars of millisecond timestamp + 16 chars of randomness = 26 chars. */
export function ulid(epochMs: number = Date.now()): string {
  let t = epochMs;
  let time = '';
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  let rand = '';
  for (let i = 0; i < 16; i++) rand += CROCKFORD[randomInt(0, 32)];
  return time + rand;
}

/** sha256 of the body after trimming whitespace (SPEC: contentHash). */
export function hashBody(body: string): string {
  return createHash('sha256').update(body.trim(), 'utf8').digest('hex');
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
   *  StoreError('duplicate') per the SPEC duplicate rule,
   *  StoreError('invalid_targets') when targets is empty. */
  insertMessage(input: InsertInput): RelayMessage;
  /** Update one delivery row. Attempts increment each time status becomes 'delivering'.
   *  Delivered and cancelled are final — any further change is rejected. */
  markStatus(messageId: string, target: Participant, status: Status): void;
  /** Every delivery not yet settled: queued, pending_approval or delivering. */
  pendingDeliveries(): PendingDelivery[];
  /** The newest `limit` messages, oldest first (ids are ULIDs, so id order is
   *  time order). Targets are rebuilt from the deliveries rows, sorted.
   *  A limit <= 0 returns nothing (SQLite would read a negative LIMIT as
   *  unlimited, which is never what a caller wants here). */
  recentMessages(limit: number): RelayMessage[];
  /** SPEC duplicate rule: same source + content_hash within 10 minutes, or a source_ref already stored. */
  isDuplicate(source: Participant, contentHash: string, sourceRef?: string): boolean;
  close(): void;
}

export function openStore(dbPath: string = 'relay.db'): RelayStore {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);

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
    if (isDuplicate(input.source, contentHash, input.sourceRef)) {
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

  const markStatus = (messageId: string, target: Participant, status: Status): void => {
    // Delivered and cancelled are final: a finished delivery must never go
    // back to pending, or the message could be sent twice.
    const result = db.prepare(
      `UPDATE deliveries
         SET status = ?, updated_at = ?, attempts = attempts + ?
       WHERE message_id = ? AND target = ?
         AND status NOT IN ('delivered', 'cancelled')`
    ).run(status, now(), status === 'delivering' ? 1 : 0, messageId, target);
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

  return {
    insertMessage,
    markStatus,
    pendingDeliveries,
    recentMessages,
    isDuplicate,
    close: () => db.close(),
  };
}
