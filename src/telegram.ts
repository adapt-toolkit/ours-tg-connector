// Minimal Telegram Bot API client (fetch + a dedicated undici dispatcher).
//
// One TelegramClient per connection/bot. It long-polls getUpdates for inbound
// messages and sends outbound messages via sendMessage. Long polling (not
// webhooks) is used so the connector needs no public URL/TLS and works behind
// NAT — each bot keeps one outstanding getUpdates request open at a time.
//
// Networking hardening (the intermittent "fetch failed" bug):
// api.telegram.org publishes both an A (IPv4) and AAAA (IPv6) record. In some
// containers/VPSes IPv6 is *configured but unreachable*; getaddrinfo (RFC 6724)
// then returns the AAAA first, so undici's Happy Eyeballs races a dead IPv6
// attempt against the single IPv4 one and the whole fetch intermittently fails
// with `TypeError: fetch failed` (AggregateError ETIMEDOUT + ENETUNREACH). We
// pin every Telegram request to a dedicated undici Agent that forces IPv4
// (family:4 => only the A record is resolved), disables Happy Eyeballs, and
// fails a bad connect fast; transactional calls also retry transient errors.

import { Agent, type Dispatcher } from 'undici';

import {
  entitiesToMarkdown,
  isParseEntitiesError,
  toMarkdownV2,
  TELEGRAM_TEXT_LIMIT,
  type TelegramEntity,
} from './format';

const API_BASE = 'https://api.telegram.org';

// Init accepted by Node's global fetch plus undici's non-standard `dispatcher`
// (the @types/node fetch RequestInit already carries `dispatcher`, but we spell
// the type out so it is explicit and survives lib changes).
type FetchInit = RequestInit & { dispatcher?: Dispatcher };
export type FetchLike = (input: string, init?: FetchInit) => Promise<Response>;

// Tunables for the Telegram network path. Defaults are the robust path; the
// connector wires these from config.ts (env-overridable) — see loadConfig().
export interface TelegramNetOptions {
  forceIpv4: boolean;       // pin resolution to the IPv4 A record (default true)
  connectTimeoutMs: number; // fail a stalled connect fast instead of ~30s hang
  retries: number;          // extra attempts for transactional calls on transient errors
  retryBaseMs: number;      // base backoff; grows exponentially with jitter
}

export const DEFAULT_NET_OPTIONS: TelegramNetOptions = {
  forceIpv4: true,
  connectTimeoutMs: 10_000,
  retries: 3,
  retryBaseMs: 300,
};

// The undici `connect` options for the Telegram dispatcher. `family: 4` makes
// getaddrinfo return only the IPv4 A record so the unreachable IPv6 is never
// attempted; `autoSelectFamily: false` disables Happy Eyeballs entirely (belt +
// suspenders); `timeout` bounds the TCP/TLS connect. When forceIpv4 is off we
// leave family/Happy-Eyeballs at Node defaults and only bound the connect.
export function telegramConnectOptions(opts: TelegramNetOptions): Record<string, unknown> {
  if (opts.forceIpv4) {
    return { family: 4, autoSelectFamily: false, timeout: opts.connectTimeoutMs };
  }
  return { timeout: opts.connectTimeoutMs };
}

// A dedicated dispatcher for one Telegram client. Scoped (not a global
// dispatcher) so it can't affect the ADAPT SDK or STT calls. Keep-alive is
// short so a socket to a flaky path is recycled rather than reused half-open.
export function buildTelegramDispatcher(opts: TelegramNetOptions): Agent {
  return new Agent({
    connect: telegramConnectOptions(opts),
    connectTimeout: opts.connectTimeoutMs,
    keepAliveTimeout: 10_000,
    keepAliveMaxTimeout: 30_000,
    connections: 8,
  });
}

// undici/Node transport error codes worth retrying (connection-level, not HTTP).
const RETRIABLE_CODES = new Set([
  'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH',
  'EAI_AGAIN', 'EPIPE', 'ENOTFOUND',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET', 'UND_ERR_CLOSED', 'UND_ERR_DESTROYED',
]);

// Whether a thrown fetch error is a transient transport failure worth retrying.
// Node's global fetch wraps every transport failure as `TypeError: fetch failed`
// with the real error on `.cause`; undici's own fetch throws coded errors. HTTP
// status errors are never thrown by fetch (they come back as a Response), so a
// 4xx/5xx is *not* retried here — the caller decides. A caller-driven
// AbortError is never retried.
export function isRetriableFetchError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { name?: string; code?: string; message?: string; cause?: { code?: string } };
  if (e.name === 'AbortError') return false;
  if (e.name === 'AggregateError') return true; // Happy Eyeballs all-attempts-failed
  if (e.name === 'TypeError' && /fetch failed/i.test(e.message ?? '')) return true;
  const code = e.code ?? e.cause?.code;
  return code !== undefined && RETRIABLE_CODES.has(code);
}

// Strip the bot token from a Telegram URL before it reaches a log line.
function sanitizeUrl(url: string): string {
  return url.replace(/\/bot[^/]+\//, '/bot***/');
}

// Call fetch with bounded retries + exponential backoff (jittered) on transient
// transport errors. Returns the Response for the caller to inspect status; only
// thrown network errors are retried, so an HTTP error is surfaced immediately.
export async function fetchWithRetry(
  fetchImpl: FetchLike,
  input: string,
  init: FetchInit,
  opts: Pick<TelegramNetOptions, 'retries' | 'retryBaseMs'>,
  log?: (msg: string) => void,
): Promise<Response> {
  let attempt = 0;
  for (;;) {
    try {
      return await fetchImpl(input, init);
    } catch (err) {
      if (attempt >= opts.retries || !isRetriableFetchError(err)) throw err;
      const delay = opts.retryBaseMs * 2 ** attempt + Math.floor(Math.random() * opts.retryBaseMs);
      attempt += 1;
      log?.(`${sanitizeUrl(input)} failed (${(err as Error).message}); retry ${attempt}/${opts.retries} in ${delay}ms`);
      await sleep(delay);
    }
  }
}

// One supported piece of Telegram media, distilled from the raw update into a
// transport-neutral descriptor (envelope.ts turns it into the `attachment`
// field; connector.ts downloads its bytes). `file_name`/`mime_type` are only
// what Telegram supplied — envelope.ts synthesizes the rest.
export type AttachmentKind =
  | 'photo' | 'document' | 'video' | 'audio' | 'voice' | 'video_note' | 'animation' | 'sticker';

export interface AttachmentDescriptor {
  kind: AttachmentKind;
  file_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

// The message this one replies to (message_id + a snapshot of its text/caption,
// excerpted by envelope.ts), so an agent can see the thread of a group chat.
export interface ReplyRef {
  message_id: number;
  text?: string;
}

// Where a forwarded message originally came from. `user` carries a username;
// `hidden_user` is someone who hid their account (name only); `chat`/`channel`
// carry the source chat (channel forwards also carry the original message_id).
export interface ForwardOrigin {
  type: 'user' | 'hidden_user' | 'chat' | 'channel';
  name?: string;
  username?: string;
  message_id?: number;
}

export interface TelegramMessage {
  update_id: number;
  message_id: number; // per-chat Telegram message id (0 when absent — rare service messages)
  chat_id: number;
  chat_type?: string; // 'private' | 'group' | 'supergroup' | 'channel' — reported by the /id probe
  chat_username?: string; // public @username of the chat, when it has one
  thread_id?: number; // forum topic id (message_thread_id) when the chat is a forum and this is a topic message
  is_topic: boolean; // true if the message was posted inside a forum topic
  chat_title?: string; // group/channel title, used for auto-naming + bio context
  from: string; // best-effort human label of the sender
  from_id?: number; // numeric sender user id (reported by the /id probe)
  from_username?: string; // sender's public @username, when they have one
  text: string; // message text, or a media message's caption ('' when neither)
  date: number; // unix seconds
  reply_to?: ReplyRef; // the message this replies to, when any
  forwarded_from?: ForwardOrigin; // the original source, when forwarded
  attachment?: AttachmentDescriptor; // the media this message carries, when any
}

interface RawUser {
  id?: number;
  first_name?: string;
  last_name?: string;
  username?: string;
}

interface RawChat {
  id?: number;
  type?: string;
  title?: string;
  username?: string;
}

interface RawFile {
  file_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

interface RawForwardOrigin {
  type: string; // 'user' | 'hidden_user' | 'chat' | 'channel'
  sender_user?: RawUser;
  sender_user_name?: string;
  sender_chat?: RawChat;
  chat?: RawChat;
  message_id?: number;
}

interface RawMessage {
  message_id?: number;
  date: number;
  message_thread_id?: number;
  is_topic_message?: boolean;
  chat: { id: number; type?: string; title?: string; username?: string };
  from?: RawUser;
  text?: string;
  caption?: string;
  entities?: TelegramEntity[];
  caption_entities?: TelegramEntity[];
  reply_to_message?: {
    message_id: number;
    text?: string;
    caption?: string;
    entities?: TelegramEntity[];
    caption_entities?: TelegramEntity[];
  };
  // forward provenance — modern union (Bot API 7.0+) + legacy fields.
  forward_origin?: RawForwardOrigin;
  forward_from?: RawUser;
  forward_from_chat?: RawChat;
  forward_from_message_id?: number;
  forward_sender_name?: string;
  // media (at most one is meaningfully set; animation also shadows document).
  photo?: RawFile[];
  document?: RawFile;
  video?: RawFile;
  audio?: RawFile;
  voice?: RawFile;
  video_note?: RawFile;
  animation?: RawFile;
  sticker?: RawFile;
}

interface RawUpdate {
  update_id: number;
  message?: RawMessage;
}

function userLabel(u?: RawUser): string | undefined {
  if (!u) return undefined;
  const name = [u.first_name, u.last_name].filter(Boolean).join(' ').trim();
  return name || u.username || (u.id !== undefined ? String(u.id) : undefined);
}

function senderLabel(m?: RawMessage): string {
  return userLabel(m?.from) ?? 'telegram';
}

function fileDesc(kind: AttachmentKind, f: RawFile): AttachmentDescriptor {
  return { kind, file_id: f.file_id, file_name: f.file_name, mime_type: f.mime_type, file_size: f.file_size };
}

// Distill the one piece of media a message carries into a descriptor (or
// undefined for a text-only message). Order matters: an animation (GIF) also
// arrives as a `document`, so it is checked first; `document` is the fallback.
// A photo arrives as an ascending-size array — the largest (last) is chosen.
export function pickAttachment(m: {
  photo?: RawFile[];
  document?: RawFile;
  video?: RawFile;
  audio?: RawFile;
  voice?: RawFile;
  video_note?: RawFile;
  animation?: RawFile;
  sticker?: RawFile;
}): AttachmentDescriptor | undefined {
  if (m.animation) return fileDesc('animation', m.animation);
  if (m.video) return fileDesc('video', m.video);
  if (m.video_note) return fileDesc('video_note', m.video_note);
  if (m.voice) return fileDesc('voice', m.voice);
  if (m.audio) return fileDesc('audio', m.audio);
  if (m.photo && m.photo.length) {
    const largest = m.photo[m.photo.length - 1];
    return { kind: 'photo', file_id: largest.file_id, file_size: largest.file_size };
  }
  if (m.sticker) return fileDesc('sticker', m.sticker);
  if (m.document) return fileDesc('document', m.document);
  return undefined;
}

// The message this one replies to, with the replied text/caption snapshot. The
// snapshot keeps its own formatting: the replied message carries its own
// entities, folded into Markdown exactly like the message body.
export function parseReply(m: {
  reply_to_message?: {
    message_id: number;
    text?: string;
    caption?: string;
    entities?: TelegramEntity[];
    caption_entities?: TelegramEntity[];
  };
}): ReplyRef | undefined {
  const r = m.reply_to_message;
  if (!r) return undefined;
  const body = r.text ?? r.caption;
  if (body === undefined) return { message_id: r.message_id };
  return { message_id: r.message_id, text: entitiesToMarkdown(body, r.entities ?? r.caption_entities) };
}

// The message text with its Telegram entities folded back into Markdown, so the
// agent reads bold/code/links/quotes instead of losing them. A message with no
// entities comes back byte-for-byte unchanged.
export function messageMarkdown(m: { text?: string; caption?: string; entities?: TelegramEntity[]; caption_entities?: TelegramEntity[] }): string {
  const body = m.text ?? m.caption ?? '';
  if (body === '') return '';
  return entitiesToMarkdown(body, m.text !== undefined ? m.entities : m.caption_entities);
}

// The original source of a forwarded message. Prefers the modern
// `forward_origin` union and falls back to the legacy forward_* fields, so it
// works regardless of which the Bot API delivers.
export function parseForwardOrigin(m: {
  forward_origin?: RawForwardOrigin;
  forward_from?: RawUser;
  forward_from_chat?: RawChat;
  forward_from_message_id?: number;
  forward_sender_name?: string;
}): ForwardOrigin | undefined {
  const fo = m.forward_origin;
  if (fo) {
    if (fo.type === 'user') return { type: 'user', name: userLabel(fo.sender_user), username: fo.sender_user?.username };
    if (fo.type === 'hidden_user') return { type: 'hidden_user', name: fo.sender_user_name };
    if (fo.type === 'channel') return { type: 'channel', name: fo.chat?.title, username: fo.chat?.username, message_id: fo.message_id };
    if (fo.type === 'chat') return { type: 'chat', name: fo.sender_chat?.title, username: fo.sender_chat?.username };
    return undefined;
  }
  if (m.forward_from) return { type: 'user', name: userLabel(m.forward_from), username: m.forward_from.username };
  if (m.forward_from_chat) {
    const c = m.forward_from_chat;
    return { type: c.type === 'channel' ? 'channel' : 'chat', name: c.title, username: c.username, message_id: m.forward_from_message_id };
  }
  if (m.forward_sender_name) return { type: 'hidden_user', name: m.forward_sender_name };
  return undefined;
}

export class TelegramClient {
  private offset = 0;
  private aborter: AbortController | null = null;
  private stopped = false;
  private readonly net: TelegramNetOptions;
  private readonly dispatcher: Agent;
  private readonly fetchImpl: FetchLike;

  constructor(
    private readonly token: string,
    private readonly pollTimeoutSec: number,
    private readonly log: (msg: string) => void,
    net: Partial<TelegramNetOptions> = {},
    // Injectable for tests; defaults to Node's global fetch.
    fetchImpl: FetchLike = fetch as FetchLike,
  ) {
    this.net = { ...DEFAULT_NET_OPTIONS, ...net };
    this.dispatcher = buildTelegramDispatcher(this.net);
    this.fetchImpl = fetchImpl;
  }

  private url(method: string): string {
    return `${API_BASE}/bot${this.token}/${method}`;
  }

  // Every Telegram fetch goes through here so it uses the IPv4-forced dispatcher.
  // Transactional calls set retry=true so a transient "fetch failed" is retried
  // rather than dropping a message; the getUpdates long-poll passes retry=false
  // (it runs its own backoff loop and owns the abort signal).
  private tgFetch(url: string, init: FetchInit = {}, retry = true): Promise<Response> {
    const withDispatcher: FetchInit = { ...init, dispatcher: this.dispatcher };
    if (!retry) return this.fetchImpl(url, withDispatcher);
    return fetchWithRetry(this.fetchImpl, url, withDispatcher, this.net, this.log);
  }

  // Validate the token and return the bot's @username (throws on a bad token).
  async getMe(): Promise<{ id: number; username: string }> {
    const resp = await this.tgFetch(this.url('getMe'));
    const body = (await resp.json()) as { ok: boolean; result?: { id: number; username: string }; description?: string };
    if (!body.ok || !body.result) {
      throw new Error(`getMe failed: ${body.description ?? `HTTP ${resp.status}`}`);
    }
    return { id: body.result.id, username: body.result.username };
  }

  // Deliver text to a chat, optionally into a specific forum topic. Passing a
  // threadId routes the reply back into the same topic it came from; omitting it
  // posts to the chat's General/main thread. Returns the message_id of every
  // message actually posted, so the caller can map them back to a wire_id.
  //
  // `replyToMessageId` makes this a Telegram reply (reply_parameters), which is
  // how an agent's ours-level reply becomes a visible thread. `markdown` renders
  // the text as MarkdownV2 — with the mandatory fallback below.
  async sendMessage(
    chatId: number | string,
    text: string,
    threadId?: number | string,
    opts: { replyToMessageId?: number; markdown?: boolean } = {},
  ): Promise<number[]> {
    const thread = threadId === undefined || threadId === '' ? undefined : Number(threadId);
    // Telegram caps a single message at 4096 characters, counted on what is
    // actually sent — so a formatted message is split by its RENDERED length.
    const pieces = opts.markdown ? splitForMarkdownV2(text) : chunkText(text, 4000);
    const ids: number[] = [];
    for (let i = 0; i < pieces.length; i += 1) {
      const piece = pieces[i];
      // The reply pointer belongs on the first piece only — the rest continue it.
      const replyTo = i === 0 ? opts.replyToMessageId : undefined;
      if (opts.markdown) {
        try {
          ids.push(await this.postMessage(chatId, toMarkdownV2(piece), thread, replyTo, 'MarkdownV2'));
          continue;
        } catch (err) {
          // MANDATORY FALLBACK: Telegram rejected our markup. The message matters
          // more than its styling — resend the SAME text with no parse_mode and
          // log the original refusal. Any other failure is the caller's problem.
          if (!isParseEntitiesError(err)) throw err;
          this.log(`markdown rejected, resending as plain text: ${String(err)}`);
        }
      }
      ids.push(await this.postMessage(chatId, piece, thread, replyTo, undefined));
    }
    return ids;
  }

  // One sendMessage call. Returns the new message's id (0 if Telegram omitted it).
  private async postMessage(
    chatId: number | string,
    text: string,
    thread: number | undefined,
    replyToMessageId: number | undefined,
    parseMode: 'MarkdownV2' | undefined,
  ): Promise<number> {
    const resp = await this.tgFetch(this.url('sendMessage'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        ...(thread !== undefined ? { message_thread_id: thread } : {}),
        ...(parseMode ? { parse_mode: parseMode } : {}),
        // allow_sending_without_reply: the referenced message may have been
        // deleted; the reply is then posted unthreaded instead of failing.
        ...(replyToMessageId !== undefined
          ? { reply_parameters: { message_id: replyToMessageId, allow_sending_without_reply: true } }
          : {}),
      }),
    });
    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`sendMessage failed (HTTP ${resp.status}): ${body}`);
    }
    const parsed = (await resp.json().catch(() => null)) as { result?: { message_id?: number } } | null;
    return parsed?.result?.message_id ?? 0;
  }

  // Set (or, with a null emoji, clear) THE reaction on a message. A bot holds at
  // most one reaction per message, so this replaces whatever was there — which is
  // exactly why a read receipt overwrites the delivered one.
  //
  // Throws on refusal (reactions disabled in the chat, message deleted, emoji not
  // on Telegram's list) for the caller to log. A receipt is best-effort UX: it must
  // never affect message delivery.
  async setMessageReaction(chatId: number | string, messageId: number, emoji: string | null): Promise<void> {
    const resp = await this.tgFetch(this.url('setMessageReaction'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        reaction: emoji ? [{ type: 'emoji', emoji }] : [],
      }),
    });
    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`setMessageReaction failed (HTTP ${resp.status}): ${body}`);
    }
  }

  // Deliver a file to a chat as a document — preserves the original filename and
  // works for any media type (photos arrive uncompressed; see design D3/OQ4 for
  // per-type rendering). Optionally into a forum topic. Multipart/form-data, so
  // we let fetch set the Content-Type boundary (do not set it ourselves).
  async sendDocument(
    chatId: number | string,
    bytes: Buffer,
    filename: string,
    mime: string | undefined,
    threadId?: number | string,
  ): Promise<void> {
    const thread = threadId === undefined || threadId === '' ? undefined : Number(threadId);
    const form = new FormData();
    form.set('chat_id', String(chatId));
    if (thread !== undefined) form.set('message_thread_id', String(thread));
    // Copy into a fresh Uint8Array: a Buffer is typed ArrayBufferLike (possibly
    // SharedArrayBuffer-backed) which is not a valid BlobPart; the copy is a plain
    // ArrayBuffer-backed view and preserves the bytes exactly.
    const blob = new Blob([new Uint8Array(bytes)], mime ? { type: mime } : {});
    form.set('document', blob, filename);
    const resp = await this.tgFetch(this.url('sendDocument'), { method: 'POST', body: form });
    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`sendDocument failed (HTTP ${resp.status}): ${body}`);
    }
  }

  // Resolve a file_id to its temporary download path (and size, when Telegram
  // reports it). getFile is required before a media file can be fetched.
  async getFile(fileId: string): Promise<{ filePath: string; fileSize?: number }> {
    const resp = await this.tgFetch(this.url('getFile'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file_id: fileId }),
    });
    const body = (await resp.json()) as { ok: boolean; result?: { file_path?: string; file_size?: number }; description?: string };
    if (!body.ok || !body.result?.file_path) {
      throw new Error(`getFile failed: ${body.description ?? `HTTP ${resp.status}`}`);
    }
    return { filePath: body.result.file_path, fileSize: body.result.file_size };
  }

  // Download a media file's bytes (getFile → fetch the file endpoint). Throws on
  // any API/transport error; the caller decides how to degrade. Telegram's own
  // bot-API download limit is 20 MB — the connector's configured cap is applied
  // by the caller, not here.
  async downloadFile(fileId: string): Promise<Buffer> {
    const { filePath } = await this.getFile(fileId);
    const resp = await this.tgFetch(`${API_BASE}/file/bot${this.token}/${filePath}`);
    if (!resp.ok) {
      throw new Error(`file download failed: HTTP ${resp.status}`);
    }
    return Buffer.from(await resp.arrayBuffer());
  }

  // Long-poll loop. Calls `onMessage` for every inbound text message until
  // stop() is called. Network errors are logged and retried with a short
  // backoff so a transient outage never kills the bridge.
  async poll(onMessage: (m: TelegramMessage) => Promise<void> | void): Promise<void> {
    this.stopped = false;
    while (!this.stopped) {
      this.aborter = new AbortController();
      const timer = setTimeout(() => this.aborter?.abort(), (this.pollTimeoutSec + 10) * 1000);
      try {
        const resp = await this.tgFetch(this.url('getUpdates'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            offset: this.offset,
            timeout: this.pollTimeoutSec,
            allowed_updates: ['message'],
          }),
          signal: this.aborter.signal,
        }, false);
        clearTimeout(timer);
        if (!resp.ok) {
          this.log(`getUpdates HTTP ${resp.status}; backing off`);
          await sleep(3000);
          continue;
        }
        const body = (await resp.json()) as { ok: boolean; result?: RawUpdate[]; description?: string };
        if (!body.ok || !body.result) {
          this.log(`getUpdates not ok: ${body.description ?? 'unknown'}; backing off`);
          await sleep(3000);
          continue;
        }
        for (const u of body.result) {
          this.offset = Math.max(this.offset, u.update_id + 1);
          const m = u.message;
          if (!m) continue;
          const attachment = pickAttachment(m);
          // Forward a message with text, a caption, OR media — drop only the
          // truly empty (service messages, edits we did not subscribe to).
          if (typeof m.text !== 'string' && typeof m.caption !== 'string' && !attachment) continue;
          try {
            await onMessage({
              update_id: u.update_id,
              message_id: m.message_id ?? 0,
              chat_id: m.chat.id,
              chat_type: m.chat.type,
              chat_username: m.chat.username,
              thread_id: m.is_topic_message ? m.message_thread_id : undefined,
              is_topic: m.is_topic_message === true,
              chat_title: m.chat.title,
              from: senderLabel(m),
              from_id: m.from?.id,
              from_username: m.from?.username,
              // Entities folded into Markdown here, at the parse boundary, so
              // every consumer downstream (envelope, plain payload, STT) sees the
              // formatting as text rather than losing it.
              text: messageMarkdown(m),
              date: m.date,
              reply_to: parseReply(m),
              forwarded_from: parseForwardOrigin(m),
              attachment,
            });
          } catch (err) {
            this.log(`onMessage handler failed: ${String(err)}`);
          }
        }
      } catch (err) {
        clearTimeout(timer);
        if (this.stopped) break;
        // AbortError on our own timeout is expected when no updates arrive.
        const name = (err as { name?: string })?.name;
        if (name !== 'AbortError') {
          this.log(`getUpdates error: ${String(err)}; backing off`);
          await sleep(3000);
        }
      } finally {
        this.aborter = null;
      }
    }
  }

  stop(): void {
    this.stopped = true;
    this.aborter?.abort();
  }
}

function chunkText(text: string, size: number): string[] {
  if (text.length <= size) return [text];
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

// Split the agent's Markdown SOURCE into pieces whose RENDERED MarkdownV2 fits
// Telegram's limit. Splitting the source (not the rendered string) is what makes
// the plain-text fallback exact: each piece can be resent verbatim with no
// parse_mode. Escaping can nearly double a piece's length, so the boundary is
// found by bisecting on the rendered size, then backed off to a line or word
// boundary. A prefix that cuts through `**bold**` is still valid MarkdownV2 —
// the orphaned marker renders as an escaped literal.
export function splitForMarkdownV2(text: string, limit = TELEGRAM_TEXT_LIMIT): string[] {
  if (toMarkdownV2(text).length <= limit) return [text];
  const out: string[] = [];
  let rest = text;
  while (rest.length > 0 && toMarkdownV2(rest).length > limit) {
    let lo = 1;
    let hi = rest.length;
    let fit = 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (toMarkdownV2(rest.slice(0, mid)).length <= limit) { fit = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    const nl = rest.lastIndexOf('\n', fit);
    const sp = rest.lastIndexOf(' ', fit);
    const cut = nl > fit / 2 ? nl + 1 : sp > fit / 2 ? sp + 1 : fit;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest) out.push(rest);
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
