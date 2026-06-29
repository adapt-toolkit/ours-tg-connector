// Minimal Telegram Bot API client (no external deps — plain fetch).
//
// One TelegramClient per connection/bot. It long-polls getUpdates for inbound
// messages and sends outbound messages via sendMessage. Long polling (not
// webhooks) is used so the connector needs no public URL/TLS and works behind
// NAT — each bot keeps one outstanding getUpdates request open at a time.

const API_BASE = 'https://api.telegram.org';

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
  reply_to_message?: { message_id: number; text?: string; caption?: string };
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

// The message this one replies to, with the replied text/caption snapshot.
export function parseReply(m: { reply_to_message?: { message_id: number; text?: string; caption?: string } }): ReplyRef | undefined {
  const r = m.reply_to_message;
  if (!r) return undefined;
  return { message_id: r.message_id, text: r.text ?? r.caption };
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

  constructor(
    private readonly token: string,
    private readonly pollTimeoutSec: number,
    private readonly log: (msg: string) => void,
  ) {}

  private url(method: string): string {
    return `${API_BASE}/bot${this.token}/${method}`;
  }

  // Validate the token and return the bot's @username (throws on a bad token).
  async getMe(): Promise<{ id: number; username: string }> {
    const resp = await fetch(this.url('getMe'));
    const body = (await resp.json()) as { ok: boolean; result?: { id: number; username: string }; description?: string };
    if (!body.ok || !body.result) {
      throw new Error(`getMe failed: ${body.description ?? `HTTP ${resp.status}`}`);
    }
    return { id: body.result.id, username: body.result.username };
  }

  // Deliver text to a chat, optionally into a specific forum topic. Passing a
  // threadId routes the reply back into the same topic it came from; omitting it
  // posts to the chat's General/main thread.
  async sendMessage(chatId: number | string, text: string, threadId?: number | string): Promise<void> {
    const thread = threadId === undefined || threadId === '' ? undefined : Number(threadId);
    // Telegram caps a single text message at 4096 chars; split conservatively.
    for (const chunk of chunkText(text, 4000)) {
      const resp = await fetch(this.url('sendMessage'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: chunk, ...(thread !== undefined ? { message_thread_id: thread } : {}) }),
      });
      if (!resp.ok) {
        const body = await resp.text();
        throw new Error(`sendMessage failed (HTTP ${resp.status}): ${body}`);
      }
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
    const resp = await fetch(this.url('sendDocument'), { method: 'POST', body: form });
    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`sendDocument failed (HTTP ${resp.status}): ${body}`);
    }
  }

  // Resolve a file_id to its temporary download path (and size, when Telegram
  // reports it). getFile is required before a media file can be fetched.
  async getFile(fileId: string): Promise<{ filePath: string; fileSize?: number }> {
    const resp = await fetch(this.url('getFile'), {
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
    const resp = await fetch(`${API_BASE}/file/bot${this.token}/${filePath}`);
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
        const resp = await fetch(this.url('getUpdates'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            offset: this.offset,
            timeout: this.pollTimeoutSec,
            allowed_updates: ['message'],
          }),
          signal: this.aborter.signal,
        });
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
              text: m.text ?? m.caption ?? '',
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
