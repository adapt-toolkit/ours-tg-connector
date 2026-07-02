// Pure routing helpers for the shared-bot demultiplexer.
//
// One Telegram bot (one getUpdates poll) fans out to MANY routes, each route an
// independent ours identity pinned to one chat-key. A chat-key is either a
// whole chat (`chatId`) or a single forum topic within it (`chatId:threadId`).
// Reverse delivery is structural: the identity that received an agent's reply is
// the chat-key it is pinned to, so a reply can only ever go back to its origin.
//
// Kept dependency-free (no ADAPT, no Telegram) so the demux logic is unit-tested
// in isolation.

export const CATCH_ALL = ''; // a route whose chatId is '' or '0' catches anything unmatched

// A Telegram bot token is `<bot_id>:<secret>` — digits, a colon, then url-safe
// characters. Lets `add_bot` accept its two positionals (<name> <token>) in
// either order by telling a token apart from a friendly bot name.
export function looksLikeBotToken(s: string): boolean {
  return /^\d+:[A-Za-z0-9_-]+$/.test(s);
}

// ----- the /id chat-id probe -------------------------------------------------
// An out-of-band command, handled by the bot's poll loop BEFORE route resolution
// so it answers even in a chat that has no route yet (the whole point — you run it
// to discover the chat id you then pass to add_new_connection).

const ID_COMMAND_RE = /^\/id(?:@([A-Za-z0-9_]+))?$/i;

// True when a message is the /id probe addressed to THIS bot. Matches bare `/id`
// (delivered in DMs and privacy-off groups) and `/id@<botUsername>` (the form
// Telegram delivers in privacy-mode groups), but never `/id@<otherbot>` — in a
// multi-bot group only the addressed bot replies. Trailing args are ignored, and
// the command must be the first token (Telegram puts bot commands at offset 0).
export function isIdCommand(text: string, botUsername: string): boolean {
  const tok = text.trim().split(/\s+/)[0] ?? '';
  const m = ID_COMMAND_RE.exec(tok);
  if (!m) return false;
  const at = m[1];
  if (!at) return true; // bare /id
  if (!botUsername) return true; // username unknown (getMe failed) — accept best-effort
  return at.toLowerCase() === botUsername.toLowerCase();
}

// The identifiers the /id probe reports back. Kept primitive (no Telegram/ADAPT
// types) so the reply builder stays pure and unit-testable.
export interface ChatIdReport {
  chatId: number | string;
  chatType?: string;
  chatTitle?: string;
  chatUsername?: string;
  threadId?: number | string; // set only for a forum-topic message
  isTopic?: boolean;
  fromId?: number | string;
  fromLabel?: string;
  botName?: string; // the registry name, for the ready-to-paste hint
  botUsername?: string;
}

// Build the plain-text reply for an /id probe: the chat's identifiers plus a
// ready-to-paste add_new_connection line. Plain text (no parse_mode) on purpose —
// it sidesteps HTML-entity escaping of user-derived fields (chat title, names).
export function formatChatIdReply(r: ChatIdReport): string {
  const lines: string[] = [];
  lines.push(`Chat identifiers${r.botUsername ? ` for @${r.botUsername}` : ''}:`);
  lines.push(`• chat id: ${r.chatId}`);
  if (r.chatType) lines.push(`• type: ${r.chatType}`);
  if (r.chatTitle) lines.push(`• title: ${r.chatTitle}`);
  if (r.chatUsername) lines.push(`• @username: @${r.chatUsername}`);
  if (r.isTopic && r.threadId !== undefined && r.threadId !== '') lines.push(`• topic (message_thread_id): ${r.threadId}`);
  if (r.fromId !== undefined && r.fromId !== '') lines.push(`• your user id: ${r.fromId}${r.fromLabel ? ` (${r.fromLabel})` : ''}`);
  const bot = r.botName || '<bot>';
  const thread = r.isTopic && r.threadId !== undefined && r.threadId !== '' ? ` --thread-id ${r.threadId}` : '';
  lines.push('');
  lines.push('Bridge this chat to an agent:');
  lines.push(`  add_new_connection --name <route> --bot ${bot} --chat-id ${r.chatId}${thread}`);
  return lines.join('\n');
}

// Normalize a Telegram chat id (always present) + optional forum topic thread id
// into the stable string key the demux indexes routes by.
export function chatKey(chatId: string | number, threadId?: string | number | null): string {
  const c = String(chatId);
  const t = threadId === undefined || threadId === null ? '' : String(threadId);
  return t ? `${c}:${t}` : c;
}

// True when a route config addresses "any chat the bot can see" rather than a
// specific chat (the catch-all / former `--chat-id 0` escape hatch).
export function isCatchAll(chatId: string): boolean {
  return chatId === '' || chatId === '0';
}

// Resolve an inbound (chatId, threadId) to the route that owns it. Most specific
// wins, falling back to broader scopes:
//
//   • a topic message (threadId set) prefers an exact `chatId:threadId` route;
//     failing that it falls to a whole-chat `chatId` route (a single identity for
//     the whole forum), then the bot's catch-all;
//   • a non-topic message matches the whole-chat `chatId` route, then catch-all.
//
// A topic-pinned route always answers into its own topic, so it is unambiguous; a
// whole-chat route serving several topics answers into the last topic it heard
// from (best-effort — see deliveryTarget in connector.ts). Generic over the route
// value so it can be exercised with plain strings in tests.
export function resolveRoute<R>(
  exact: Map<string, R>,
  catchAll: R | null,
  chatId: string | number,
  threadId?: string | number | null,
): R | null {
  const t = threadId === undefined || threadId === null ? '' : String(threadId);
  if (t) {
    return exact.get(chatKey(chatId, t)) ?? exact.get(chatKey(chatId)) ?? catchAll ?? null;
  }
  return exact.get(chatKey(chatId)) ?? catchAll ?? null;
}

export interface ChatRef {
  chatId: string;
  threadId: string;
}

// Where a route delivers an agent's reply, given the chat-key it is pinned to and
// the most recent inbound origin it saw. Counterpart to resolveRoute:
//
//   • a topic-pinned route (real chatId + threadId) ALWAYS answers into its own
//     topic — fixed and unambiguous, regardless of what last spoke;
//   • a whole-chat or catch-all route answers into the last inbound chat/topic
//     (correct for request/response; one route per topic is the unambiguous setup);
//   • a catch-all that has seen no inbound yet has nowhere to go -> null.
export function deliveryTarget(chatId: string, threadId: string, lastChat: ChatRef | null): ChatRef | null {
  if (!isCatchAll(chatId) && threadId) return { chatId, threadId };
  if (lastChat) return lastChat;
  if (!isCatchAll(chatId)) return { chatId, threadId: '' };
  return null;
}
