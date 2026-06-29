// The inbound message envelope: the JSON body the connector forwards to the
// agent over ::a2a_messaging::send_message. It wraps the user's text with
// structured metadata (sender / chat / reply / forward) and, for a media
// message, a descriptor of the file under `attachment`.
//
// envelope v2 (core 3.1): the file BYTES no longer ride the `text` field as
// base64 — they travel on the file channel via ::a2a_messaging::send_file. The
// envelope's `attachment` block carries only metadata plus the file's `wire_id`
// (under `transport: 'send_file'`), so the agent correlates the separately-
// arriving file (its on_file_received) to this message. The `v` field versions
// the shape; v1 (base64 inline) is superseded.
//
// Pure: message (+ optionally the resolved attachment outcome + the send_file
// wire_id) → string. No network, no disk — so the JSON shaping is unit-tested in
// isolation (test-envelope.mjs). Absent optional fields are left `undefined`,
// which JSON.stringify drops, keeping the envelope compact.

import type { TelegramMessage, AttachmentDescriptor } from './telegram';

export const ENVELOPE_VERSION = 2;

// The outcome of trying to fetch a media message's bytes. The connector
// produces this (network) and hands it to buildEnvelope (pure).
export type ResolvedAttachment =
  | { ok: true; bytes: Buffer }
  | { ok: false; reason: 'too_large' | 'error'; detail: string };

// How far we excerpt the replied-to message's text into reply_to.text.
const REPLY_EXCERPT_MAX = 200;

// Per-kind filename extension + mime, used when Telegram supplies neither
// (always for photos/voice/stickers; usually present for documents).
const KIND_DEFAULTS: Record<string, { ext: string; mime: string }> = {
  photo: { ext: 'jpg', mime: 'image/jpeg' },
  document: { ext: 'bin', mime: 'application/octet-stream' },
  video: { ext: 'mp4', mime: 'video/mp4' },
  audio: { ext: 'mp3', mime: 'audio/mpeg' },
  voice: { ext: 'ogg', mime: 'audio/ogg' },
  video_note: { ext: 'mp4', mime: 'video/mp4' },
  animation: { ext: 'mp4', mime: 'video/mp4' },
  sticker: { ext: 'webp', mime: 'image/webp' },
};

function isoDate(unixSec: number): string {
  return new Date(unixSec * 1000).toISOString();
}

function excerpt(text: string): string {
  return text.length <= REPLY_EXCERPT_MAX ? text : `${text.slice(0, REPLY_EXCERPT_MAX)}…`;
}

function buildReply(m: TelegramMessage): Record<string, unknown> | undefined {
  if (!m.reply_to) return undefined;
  const { message_id, text } = m.reply_to;
  return { message_id, text: text === undefined ? undefined : excerpt(text) };
}

// Synthesize the filename + mime for a media descriptor, identical to what
// connector.ts passes to send_file — so the envelope's attachment block and the
// file the agent receives agree. Telegram's own values win; otherwise per-kind
// defaults fill in (photos/voice/etc. never carry a name).
export function attachmentMeta(d: AttachmentDescriptor, messageId: number): { filename: string; mime: string } {
  const defaults = KIND_DEFAULTS[d.kind] ?? KIND_DEFAULTS.document;
  return {
    filename: d.file_name ?? `${d.kind}_${messageId}.${defaults.ext}`,
    mime: d.mime_type ?? defaults.mime,
  };
}

function buildAttachment(m: TelegramMessage, resolved?: ResolvedAttachment, fileWireId?: string): Record<string, unknown> | undefined {
  const d = m.attachment;
  if (!d) return undefined;
  const { filename, mime } = attachmentMeta(d, m.message_id);
  const base = { kind: d.kind, filename, mime, size: d.file_size };
  if (resolved?.ok) {
    // Bytes travel via send_file; the envelope only points at them by wire_id.
    return { ...base, size: d.file_size ?? resolved.bytes.length, transport: 'send_file', wire_id: fileWireId };
  }
  if (resolved && !resolved.ok) {
    return resolved.reason === 'too_large'
      ? { ...base, omitted: resolved.detail }
      : { ...base, error: resolved.detail };
  }
  // Descriptor present but nothing was resolved — should not happen, but never
  // claim bytes we do not have.
  return { ...base, error: 'attachment not resolved' };
}

// Build the JSON envelope for one inbound Telegram message. `resolved` is the
// attachment fetch outcome; `fileWireId` is the wire_id returned by send_file
// when the bytes were sent on the file channel (present only on a successful
// transfer).
export function buildEnvelope(m: TelegramMessage, resolved?: ResolvedAttachment, fileWireId?: string): string {
  const envelope = {
    v: ENVELOPE_VERSION,
    source: 'telegram',
    message_id: m.message_id,
    date: isoDate(m.date),
    from: { id: m.from_id, name: m.from, username: m.from_username },
    chat: {
      id: m.chat_id,
      type: m.chat_type,
      title: m.chat_title,
      username: m.chat_username,
      thread_id: m.thread_id,
    },
    reply_to: buildReply(m),
    forwarded_from: m.forwarded_from,
    text: m.text,
    attachment: buildAttachment(m, resolved, fileWireId),
  };
  return JSON.stringify(envelope);
}
