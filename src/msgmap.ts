// The ours wire_id ⇄ Telegram message map, and the per-contact receipt settings
// that ride alongside it. One file per route, so it survives a daemon restart
// (the acceptance criterion) and disappears with the route.
//
// TWO CONSUMERS, ONE TABLE:
//   • reply threading — an inbound Telegram message is sent to the agent as
//     wire_id W; when the agent answers with reply_to.wire_id = W we look W up and
//     send to Telegram with reply_parameters.message_id. No row, no reply
//     parameter: a plain message goes out. We NEVER substitute a "similar" one.
//   • receipts — a delivered/read receipt for wire_id W is turned into a reaction
//     on exactly the Telegram message that produced W.
//
// SHAPE. The spec asked for two SQL tables (tg_message_map, tg_connection_settings).
// This repo has no database dependency and persists everything as per-route JSON
// (connection.json, ../bots.json), so the same two relations are one JSON document
// with the same columns. Nothing about the design needs a query engine: both
// lookups are by primary key.
//
// RETENTION. Rows older than RETENTION_DAYS are dropped, and the table is capped
// at MAX_ROWS (oldest first). Past that horizon an agent's reply arrives as a plain
// message with no reply parameter — deliberate degradation, not a failure.
//
// Message CONTENT is never stored here: only chat/message ids, the contact id, and
// the receipt state.

import * as fs from 'node:fs';
import { join } from 'node:path';
import {
  isReceiptUpgrade,
  normalizeSettings,
  defaultSettings,
  type ConnectionReceiptSettings,
  type ReceiptState,
} from './receipts';

export const RETENTION_DAYS = 30;
// Both directions are recorded (the spec's `direction` column), so the cap is set
// to leave the inbound half — the one reply threading and receipts actually read —
// the room it would have had on its own.
export const MAX_ROWS = 4000;

export interface MessageRow {
  chatId: string; // string, so a large/negative Telegram id never loses precision
  messageId: number;
  contactCid: string;
  direction: 'inbound' | 'outbound';
  receiptState: ReceiptState;
  createdAt: string; // ISO-8601
}

interface MapFile {
  v: 1;
  messages: Record<string, MessageRow>;
  settings: Record<string, ConnectionReceiptSettings>;
}

const FILE_NAME = 'messages.json';

function emptyFile(): MapFile {
  return { v: 1, messages: {}, settings: {} };
}

// Drop rows past the retention horizon, then the oldest rows over the cap.
// Returns how many rows were removed (0 => the caller can skip a write).
export function pruneRows(
  messages: Record<string, MessageRow>,
  nowMs: number,
  retentionDays = RETENTION_DAYS,
  maxRows = MAX_ROWS,
): number {
  const horizon = nowMs - retentionDays * 86_400_000;
  let removed = 0;
  for (const [wireId, row] of Object.entries(messages)) {
    const t = Date.parse(row.createdAt);
    if (!Number.isFinite(t) || t < horizon) {
      delete messages[wireId];
      removed += 1;
    }
  }
  const keys = Object.keys(messages);
  if (keys.length > maxRows) {
    keys
      .sort((a, b) => Date.parse(messages[a].createdAt) - Date.parse(messages[b].createdAt))
      .slice(0, keys.length - maxRows)
      .forEach((k) => { delete messages[k]; removed += 1; });
  }
  return removed;
}

// Validate one row read off disk. A hand-edited or truncated file must not be
// able to make us react on a garbage chat/message id.
function validRow(v: unknown): MessageRow | null {
  if (!v || typeof v !== 'object') return null;
  const r = v as Record<string, unknown>;
  if (typeof r.chatId !== 'string' || !r.chatId) return null;
  if (typeof r.messageId !== 'number' || !Number.isSafeInteger(r.messageId) || r.messageId <= 0) return null;
  const dir = r.direction === 'outbound' ? 'outbound' : 'inbound';
  const st = r.receiptState;
  const state: ReceiptState = st === 'read' || st === 'delivered' ? st : 'sent';
  return {
    chatId: r.chatId,
    messageId: r.messageId,
    contactCid: typeof r.contactCid === 'string' ? r.contactCid : '',
    direction: dir,
    receiptState: state,
    createdAt: typeof r.createdAt === 'string' ? r.createdAt : new Date(0).toISOString(),
  };
}

export function parseMapFile(raw: string, nowMs: number): MapFile {
  const out = emptyFile();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return out; // unreadable => start clean; threading degrades, nothing breaks
  }
  if (!parsed || typeof parsed !== 'object') return out;
  const p = parsed as Record<string, unknown>;
  if (p.messages && typeof p.messages === 'object') {
    for (const [wireId, v] of Object.entries(p.messages as Record<string, unknown>)) {
      if (!wireId) continue;
      const row = validRow(v);
      if (row) out.messages[wireId] = row;
    }
  }
  const now = new Date(nowMs).toISOString();
  if (p.settings && typeof p.settings === 'object') {
    for (const [cid, v] of Object.entries(p.settings as Record<string, unknown>)) {
      if (cid) out.settings[cid] = normalizeSettings(v, now);
    }
  }
  pruneRows(out.messages, nowMs);
  return out;
}

// One route's map. Every mutation persists synchronously (atomic tmp + rename):
// the table is small and a lost row only costs reply threading for that message.
export class MessageMap {
  private data: MapFile;
  private readonly path: string;

  constructor(private readonly dir: string, private readonly log: (msg: string) => void = () => {}) {
    this.path = join(dir, FILE_NAME);
    this.data = emptyFile();
    try {
      if (fs.existsSync(this.path)) this.data = parseMapFile(fs.readFileSync(this.path, 'utf8'), Date.now());
    } catch (err) {
      this.log(`message map unreadable, starting empty: ${String(err)}`);
    }
  }

  private persist(): void {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const tmp = `${this.path}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 });
      fs.renameSync(tmp, this.path);
    } catch (err) {
      // Best effort: an unwritable map costs reply threading after a restart, so
      // it must never take the message path down with it.
      this.log(`message map write failed: ${String(err)}`);
    }
  }

  // Remember the Telegram message a wire_id came from (or went to). Re-recording
  // the same wire_id keeps the earlier receiptState, which is what makes a retry
  // idempotent rather than a downgrade.
  record(wireId: string, row: Omit<MessageRow, 'receiptState' | 'createdAt'> & { receiptState?: ReceiptState }): void {
    if (!wireId) return;
    const prev = this.data.messages[wireId];
    this.data.messages[wireId] = {
      ...row,
      receiptState: prev?.receiptState ?? row.receiptState ?? 'sent',
      createdAt: prev?.createdAt ?? new Date().toISOString(),
    };
    const dropped = pruneRows(this.data.messages, Date.now());
    if (dropped > 0) this.log(`message map pruned ${dropped} row(s)`);
    this.persist();
  }

  get(wireId: string): MessageRow | undefined {
    return wireId ? this.data.messages[wireId] : undefined;
  }

  entries(direction?: MessageRow['direction']): Array<[string, MessageRow]> {
    return Object.entries(this.data.messages).filter(([, row]) => !direction || row.direction === direction);
  }

  findTelegramMessage(chatId: string, messageId: number): string | undefined {
    for (const [wireId, row] of Object.entries(this.data.messages)) {
      if (row.chatId === chatId && row.messageId === messageId) return wireId;
    }
    return undefined;
  }

  // Apply a receipt monotonically. Returns the row when the state actually moved
  // forward (the caller then sets the reaction), or null for a duplicate /
  // out-of-order / unknown wire_id — no reaction, no write.
  //
  // Only INBOUND rows can be confirmed: a receipt covers a message WE sent over
  // ours, which is a Telegram message forwarded to the agent. An outbound row is a
  // message the agent sent to us — we emit receipts for those, never receive them.
  applyReceipt(wireId: string, kind: ReceiptState): MessageRow | null {
    const row = this.data.messages[wireId];
    if (!row || row.direction !== 'inbound') return null;
    if (!isReceiptUpgrade(row.receiptState, kind)) return null;
    row.receiptState = kind;
    this.persist();
    return row;
  }

  // Settings for one contact, falling back to the route-wide bucket ('') before
  // the defaults. The fallback matters: `/receipts off` can be issued BEFORE an
  // agent has accepted the invite, when there is no contact id to key it by, and
  // that choice must still hold once the agent connects.
  settingsFor(contactCid: string): ConnectionReceiptSettings {
    return this.data.settings[contactCid || ''] ?? this.data.settings[''] ?? defaultSettings(new Date().toISOString());
  }

  updateSettings(contactCid: string, patch: Partial<ConnectionReceiptSettings>): ConnectionReceiptSettings {
    const key = contactCid || '';
    const next: ConnectionReceiptSettings = {
      ...this.settingsFor(key),
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    this.data.settings[key] = next;
    this.persist();
    return next;
  }

  resetSettings(contactCid: string): ConnectionReceiptSettings {
    const key = contactCid || '';
    const next = defaultSettings(new Date().toISOString());
    // /emoji reset restores the emoji pair only; it does not silently switch
    // receipts back on for someone who turned them off.
    next.receiptsEnabled = this.settingsFor(key).receiptsEnabled;
    this.data.settings[key] = next;
    this.persist();
    return next;
  }

  size(): number {
    return Object.keys(this.data.messages).length;
  }
}
