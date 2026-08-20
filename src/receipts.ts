// Delivery / read receipts rendered as Telegram message reactions, plus the
// per-connection settings and the chat commands that drive them. Pure (no
// network, no disk, no ADAPT) — see tests/receipts.test.mjs.
//
// WHERE THE RECEIPTS COME FROM. Core 0.7.0 owns the mechanism; the connector only
// consumes it. `::a2a_messaging::receive_receipt` ingests a peer's confirmation and
// fires the `on_receipt_received($sender_id, $kind, $wire_ids, $date)` hook
// (mufl_code/core/a2a_messaging.mm:499-506), which actor.mu forwards to the daemon
// as a `receipt_received` notify. Nothing here invents an ordering: the hook's
// contract is MONOTONIC per (peer, wire_id) over unknown < sent < delivered <
// read, and duplicates / out-of-order arrivals collapse to no-ops. RECEIPT_RANK +
// isReceiptUpgrade below are exactly that rule, applied to the stored row so the
// reaction we already put on the message is never walked backwards.
//
// WHY "read REPLACES delivered". A bot holds AT MOST ONE reaction per message
// (setMessageReaction with a single-element list; multiple reactions are a premium
// account feature). So the two states cannot sit side by side — the read emoji
// overwrites the delivered one. That is the whole shape of the feature.
//
// Receipts are best-effort by core's own contract and never load-bearing: a
// missing reaction does NOT mean the message failed to arrive, and a Telegram
// refusal on a reaction must never touch message delivery.

// ----- Telegram's allowed reaction emoji -------------------------------------
// A bot may only react with an emoji from Telegram's fixed list. Encoded here so
// a bad `/emoji` setting is refused BEFORE it is persisted, with the valid set in
// the error, instead of failing invisibly on every later reaction.
//
// NOTE the canonical spellings carry NO variation selector (U+FE0F). Human input
// usually does, so comparison strips it — see normalizeEmoji.
export const ALLOWED_REACTIONS: readonly string[] = [
  '👍', '👎', '❤', '🔥', '🥰', '👏', '😁', '🤔', '🤯', '😱', '🤬', '😢', '🎉', '🤩',
  '🤮', '💩', '🙏', '👌', '🕊', '🤡', '🥱', '🥴', '😍', '🐳', '❤‍🔥', '🌚', '🌭',
  '💯', '🤣', '⚡', '🍌', '🏆', '💔', '🤨', '😐', '🍓', '🍾', '💋', '🖕', '😈', '😴',
  '😭', '🤓', '👻', '👨‍💻', '👀', '🎃', '🙈', '😇', '😨', '🤝', '✍', '🤗', '🫡', '🎅',
  '🎄', '☃', '💅', '🤪', '🗿', '🆒', '💘', '🙉', '🦄', '😘', '💊', '🙊', '😎', '👾',
  '🤷‍♂', '🤷', '🤷‍♀', '😡',
];

// Strip variation selectors so '❤️' (as typed) matches '❤' (as Telegram lists it).
export function normalizeEmoji(s: string): string {
  return s.trim().replace(/️/g, '');
}

const ALLOWED_INDEX = new Map(ALLOWED_REACTIONS.map((e) => [normalizeEmoji(e), e]));

// Resolve user input to the canonical allowed spelling, or null if Telegram would
// not accept it as a bot reaction.
export function canonicalReaction(input: string): string | null {
  return ALLOWED_INDEX.get(normalizeEmoji(input)) ?? null;
}

// Defaults. Delivered is the spec's 👀.
//
// READ IS 👌, NOT THE SPEC'S ✅ — DELIBERATE. ✅ (U+2705) is not in Telegram's
// bot-reaction list above, so setMessageReaction would refuse it on every single
// read receipt: the owner would see no read marker and only a log line saying so.
// 👌 ("got it") is in the list and carries the same meaning. Configurable either
// way with `/emoji read <emoji>`, so this is a working default, not a decision
// taken away from the owner.
export const DEFAULT_EMOJI_DELIVERED = '👀';
export const DEFAULT_EMOJI_READ = '👌';

// ----- per-connection settings ------------------------------------------------
// Scoped per ours CONTACT (the proxy agent a route talks to), never globally per
// bot: `/receipts off` on one connection leaves every other one alone.
export interface ConnectionReceiptSettings {
  receiptsEnabled: boolean;
  emojiDelivered: string;
  emojiRead: string;
  updatedAt: string;
}

export function defaultSettings(now: string): ConnectionReceiptSettings {
  return {
    receiptsEnabled: true,
    emojiDelivered: DEFAULT_EMOJI_DELIVERED,
    emojiRead: DEFAULT_EMOJI_READ,
    updatedAt: now,
  };
}

// Repair a settings record read off disk (older/hand-edited file, or an emoji
// Telegram has since dropped) back to something sendable.
export function normalizeSettings(raw: unknown, now: string): ConnectionReceiptSettings {
  const d = defaultSettings(now);
  if (!raw || typeof raw !== 'object') return d;
  const r = raw as Record<string, unknown>;
  return {
    receiptsEnabled: typeof r.receiptsEnabled === 'boolean' ? r.receiptsEnabled : d.receiptsEnabled,
    emojiDelivered: (typeof r.emojiDelivered === 'string' ? canonicalReaction(r.emojiDelivered) : null) ?? d.emojiDelivered,
    emojiRead: (typeof r.emojiRead === 'string' ? canonicalReaction(r.emojiRead) : null) ?? d.emojiRead,
    updatedAt: typeof r.updatedAt === 'string' ? r.updatedAt : d.updatedAt,
  };
}

// ----- monotonic receipt state ------------------------------------------------
export type ReceiptState = 'sent' | 'delivered' | 'read';

const RECEIPT_RANK: Record<string, number> = { unknown: 0, sent: 1, delivered: 2, read: 3 };

export function receiptRank(state: string): number {
  return RECEIPT_RANK[state] ?? 0;
}

// The core hook's normative rule, applied to our stored row: a receipt only ever
// moves the state FORWARD. A duplicate `delivered`, or a `delivered` arriving
// after `read` (reordered on the wire), is a no-op — never a downgrade.
export function isReceiptUpgrade(current: string, incoming: string): boolean {
  return receiptRank(incoming) > receiptRank(current);
}

// The emoji a state should show, or null when the state has no reaction of its
// own ('sent' is our own bookkeeping, not a peer confirmation).
export function emojiFor(state: ReceiptState, s: ConnectionReceiptSettings): string | null {
  if (state === 'delivered') return s.emojiDelivered;
  if (state === 'read') return s.emojiRead;
  return null;
}

// ----- per-connection commands ------------------------------------------------
// Parsed deterministically HERE, in connector code — never handed to the agent as
// a prompt, so `/receipts off` cannot be talked out of by a message body.

export type ReceiptCommand =
  | { kind: 'receipts'; on: boolean }
  | { kind: 'status' }
  | { kind: 'emoji'; slot: 'delivered' | 'read'; emoji: string }
  | { kind: 'reset' }
  | { kind: 'help' }
  | { kind: 'error'; message: string };

const CMD_RE = /^\/(receipts|emoji|help)(?:@([A-Za-z0-9_]+))?$/i;

// ----- the connector's own command list ---------------------------------------
// THE single source of truth for "which commands are the connector's": it drives
// both the `/help` listing and the setMyCommands registration that puts them in
// the client's slash menu, so the menu can never advertise a command the parser
// does not implement. `/id` is parsed in routing.ts (it answers before route
// resolution) but is listed here because it is the same surface to a user.
//
// `command` is bare (no slash) and must satisfy Telegram's rule for a command
// name — 1-32 chars of [a-z0-9_]; `description` is what the slash menu shows and
// is capped at 256 chars. Both are asserted in tests/receipts.test.mjs.
export interface ConnectorCommand {
  command: string;
  args?: string; // argument shape — shown by /help, not by the slash menu
  description: string;
}

export const CONNECTOR_COMMANDS: readonly ConnectorCommand[] = [
  { command: 'help', description: 'What this connector handles here, and the current receipt settings' },
  { command: 'id', description: "This chat's ids, for wiring up a new connection" },
  { command: 'receipts', args: 'on | off | status', description: 'Delivery/read receipts, shown as reactions' },
  { command: 'emoji', args: 'delivered <emoji> | read <emoji> | reset', description: 'Which emoji a receipt reacts with' },
];

// What setMyCommands wants: bare name + description, nothing else.
export function telegramCommandList(): { command: string; description: string }[] {
  return CONNECTOR_COMMANDS.map((c) => ({ command: c.command, description: c.description }));
}

function invalidEmoji(input: string): ReceiptCommand {
  return {
    kind: 'error',
    message:
      `"${input}" is not an emoji Telegram lets a bot react with.\n\n` +
      `Pick one of:\n${ALLOWED_REACTIONS.join(' ')}`,
  };
}

// Recognize and parse a per-connection command. Returns null when the text is not
// one of ours, so an ordinary message falls straight through to the agent.
// `botUsername` makes `/receipts@thisbot` work — and `/receipts@otherbot` not —
// in a group with several bots, matching how /id is handled in routing.ts.
export function parseReceiptCommand(text: string, botUsername = ''): ReceiptCommand | null {
  const tokens = text.trim().split(/\s+/);
  const m = CMD_RE.exec(tokens[0] ?? '');
  if (!m) return null;
  const [, verb, addressed] = m;
  if (addressed && botUsername && addressed.toLowerCase() !== botUsername.toLowerCase()) return null;
  const args = tokens.slice(1);

  // `/help` — and ONLY a bare `/help`. Anything after the verb ("/help me write
  // the release note") is a message for the agent that happens to start with a
  // slash, so it falls through untouched rather than being swallowed here. This
  // is deliberately stricter than /receipts and /emoji, which own their whole
  // argument space and answer a bad argument with a usage line.
  if (verb.toLowerCase() === 'help') {
    if (args.length) return null;
    return { kind: 'help' };
  }

  if (verb.toLowerCase() === 'receipts') {
    const a = (args[0] ?? '').toLowerCase();
    if (a === 'on') return { kind: 'receipts', on: true };
    if (a === 'off') return { kind: 'receipts', on: false };
    if (a === 'status' || a === '') return { kind: 'status' };
    return { kind: 'error', message: 'Usage: /receipts on | /receipts off | /receipts status' };
  }

  // /emoji delivered <e> | /emoji read <e> | /emoji reset
  const slot = (args[0] ?? '').toLowerCase();
  if (slot === 'reset') return { kind: 'reset' };
  if (slot !== 'delivered' && slot !== 'read') {
    return { kind: 'error', message: 'Usage: /emoji delivered <emoji> | /emoji read <emoji> | /emoji reset' };
  }
  const raw = args[1] ?? '';
  if (!raw) return { kind: 'error', message: `Usage: /emoji ${slot} <emoji>` };
  const canon = canonicalReaction(raw);
  if (!canon) return invalidEmoji(raw);
  return { kind: 'emoji', slot, emoji: canon };
}

// The settings block, shared by `/receipts status` and `/help` so the two can
// never drift apart.
function settingsLines(s: ConnectionReceiptSettings, routeName: string, peerKnown: boolean): string[] {
  const lines = [
    `Receipts for this connection ("${routeName}"):`,
    `• delivery/read reactions: ${s.receiptsEnabled ? 'on' : 'off'}`,
    `• delivered: ${s.emojiDelivered}`,
    `• read: ${s.emojiRead}`,
  ];
  if (!peerKnown) lines.push('• no agent connected yet — nothing to receive receipts from');
  return lines;
}

// The reply to `/receipts status`. Plain text on purpose (no parse_mode) so a
// stray character in it can never fail its own send.
export function formatStatus(s: ConnectionReceiptSettings, routeName: string, peerKnown: boolean): string {
  const lines = settingsLines(s, routeName, peerKnown);
  lines.push('', 'Change with: /receipts on|off, /emoji delivered <emoji>, /emoji read <emoji>, /emoji reset');
  return lines.join('\n');
}

// The reply to `/help`: what the CONNECTOR itself handles, then the live
// settings for this connection. Answered locally — it is never forwarded, so it
// costs the agent nothing and works even when no agent is connected yet.
//
// `settings` is null when the message came from a chat with no route (the same
// chats where `/id` still answers): there is no connection to report on, so the
// command list is all we can honestly show.
//
// Plain text, same as formatStatus — the usage lines are full of MarkdownV2
// metacharacters and must not be able to fail their own send.
export function formatHelp(
  settings: ConnectionReceiptSettings | null,
  routeName: string,
  peerKnown: boolean,
): string {
  const lines = ['Commands handled by this connector (answered here, never sent to the agent):'];
  for (const c of CONNECTOR_COMMANDS) {
    lines.push(`• /${c.command}${c.args ? ` ${c.args}` : ''} — ${c.description}`);
  }
  lines.push('', 'Anything else you send is relayed to the agent exactly as typed — including text that starts with a slash.', '');
  if (settings) lines.push(...settingsLines(settings, routeName, peerKnown));
  else lines.push('This chat has no route yet, so there are no receipt settings to show. Run /id to get the ids needed to add one.');
  return lines.join('\n');
}
