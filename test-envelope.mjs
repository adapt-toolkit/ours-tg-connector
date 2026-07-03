#!/usr/bin/env node
// Unit test for the inbound message envelope (src/envelope.ts) and the pure
// Telegram-wire parsers it is fed by (src/telegram.ts: pickAttachment,
// parseForwardOrigin, parseReply). Pure — no broker, no network, no ADAPT.
//
// Run: node_modules/.bin/tsx test-envelope.mjs

import { buildEnvelope, attachmentMeta } from './src/envelope.ts';
import { pickAttachment, parseForwardOrigin, parseReply, TelegramClient } from './src/telegram.ts';

let failures = 0;
function assert(cond, msg) {
  if (cond) console.log(`  ✓ ${msg}`);
  else { console.log(`  ✗ ${msg}`); failures++; }
}
const env = (m, resolved) => JSON.parse(buildEnvelope(m, resolved));

// A minimal valid inbound text message.
const base = {
  update_id: 1, message_id: 4521, chat_id: 12345, chat_type: 'private',
  is_topic: false, from: 'Alice Smith', from_id: 12345, text: 'hello', date: 1750602602,
};

console.log('=== envelope unit test ===');

// ---- shape + always-present fields ----
{
  const e = env(base);
  assert(e.v === 2, 'envelope has version v:2');
  assert(e.source === 'telegram', 'source is "telegram"');
  assert(e.message_id === 4521, 'carries the Telegram message_id');
  assert(e.text === 'hello', 'carries the message text');
  assert(e.date === new Date(1750602602 * 1000).toISOString(), 'date is ISO 8601 UTC from the unix seconds');
  assert(e.from && e.from.id === 12345 && e.from.name === 'Alice Smith', 'from carries id + name');
  assert(e.chat && e.chat.id === 12345 && e.chat.type === 'private', 'chat carries id + type');
  assert(e.attachment === undefined, 'no attachment field when there is no media');
  assert(e.reply_to === undefined && e.forwarded_from === undefined, 'no reply_to/forwarded_from when absent');
}

// ---- omitted optionals ----
{
  const e = env(base); // no from_username, no chat_title
  assert(e.from.username === undefined, 'from.username omitted when the sender has none');
  assert(e.chat.title === undefined && e.chat.username === undefined, 'chat.title/username omitted for a private chat');
  assert(e.chat.thread_id === undefined, 'chat.thread_id omitted outside a forum topic');
}

// ---- group + topic + username metadata ----
{
  const e = env({
    ...base,
    chat_id: -1001234567890, chat_type: 'supergroup', chat_title: 'ACME Support',
    chat_username: 'acmesupport', thread_id: 7, is_topic: true,
    from: 'Alice Smith', from_id: 12345, from_username: 'alice',
  });
  assert(e.chat.id === -1001234567890, 'group chat id preserved');
  assert(e.chat.title === 'ACME Support' && e.chat.username === 'acmesupport', 'chat title + username present in a group');
  assert(e.chat.thread_id === 7, 'forum topic thread_id present');
  assert(e.from.username === 'alice', 'from.username present when the sender has one');
}

// ---- text is always present, "" for a caption-less media message ----
{
  const e = env({ ...base, text: '', attachment: { kind: 'photo', file_id: 'F', file_size: 10 } },
                 { ok: true, bytes: Buffer.from('hi') });
  assert(e.text === '', 'text is "" for a caption-less media message');
}

// ---- reply_to with excerpt + truncation ----
{
  const long = 'x'.repeat(500);
  const e = env({ ...base, reply_to: { message_id: 678, text: long } });
  assert(e.reply_to.message_id === 678, 'reply_to carries the replied message_id');
  assert(e.reply_to.text.length <= 201 && e.reply_to.text.endsWith('…'), 'reply_to excerpt is truncated to ~200 chars with an ellipsis');
  const e2 = env({ ...base, reply_to: { message_id: 9 } });
  assert(e2.reply_to.message_id === 9 && e2.reply_to.text === undefined, 'reply_to.text omitted when the replied message had none');
}

// ---- forwarded_from passthrough ----
{
  const e = env({ ...base, forwarded_from: { type: 'channel', name: 'ACME News', username: 'acmenews', message_id: 99 } });
  assert(e.forwarded_from.type === 'channel' && e.forwarded_from.message_id === 99, 'forwarded_from channel origin carried with message_id');
  const e2 = env({ ...base, forwarded_from: { type: 'hidden_user', name: 'Somebody' } });
  assert(e2.forwarded_from.type === 'hidden_user' && e2.forwarded_from.username === undefined, 'forwarded_from hidden_user omits username');
}

// ---- attachment v2: transferred file carries wire_id + transport, no b64 ----
{
  const bytes = Buffer.from('PDF-CONTENT');
  const e = JSON.parse(buildEnvelope(
    { ...base, text: 'see attached', attachment: { kind: 'document', file_id: 'F', file_name: 'receipt.pdf', mime_type: 'application/pdf', file_size: bytes.length } },
    { ok: true, bytes }, 'WIRE-123'));
  assert(e.v === 2, 'transferred-file envelope is v2');
  assert(e.attachment.kind === 'document', 'attachment kind carried');
  assert(e.attachment.filename === 'receipt.pdf', 'attachment uses the Telegram filename when given');
  assert(e.attachment.mime === 'application/pdf', 'attachment uses the Telegram mime when given');
  assert(e.attachment.size === bytes.length, 'attachment size carried');
  assert(e.attachment.wire_id === 'WIRE-123', 'attachment carries the send_file wire_id');
  assert(e.attachment.transport === 'send_file', 'transport marker present');
  assert(e.attachment.b64 === undefined, 'no base64 in v2');
  assert(e.attachment.omitted === undefined && e.attachment.error === undefined, 'no omit/error note on a transferred attachment');
}

// ---- attachment: synthesized filename + mime for a photo ----
{
  const bytes = Buffer.from('JPEGDATA');
  const e = env(
    { ...base, message_id: 7, text: '', attachment: { kind: 'photo', file_id: 'F', file_size: bytes.length } },
    { ok: true, bytes },
  );
  assert(e.attachment.filename === 'photo_7.jpg', 'photo filename synthesized from kind + message_id');
  assert(e.attachment.mime === 'image/jpeg', 'photo mime defaults to image/jpeg');
}

// ---- attachment: over-cap stub (no bytes) ----
{
  const e = env(
    { ...base, text: '', attachment: { kind: 'video', file_id: 'F', file_name: 'big.mp4', mime_type: 'video/mp4', file_size: 23847211 } },
    { ok: false, reason: 'too_large', detail: 'exceeds 10485760-byte cap (size 23847211)' },
  );
  assert(e.attachment.b64 === undefined, 'over-cap attachment carries no b64');
  assert(e.attachment.wire_id === undefined && e.attachment.transport === undefined, 'over-cap stub has no wire_id/transport (no file was sent)');
  assert(e.attachment.size === 23847211, 'over-cap attachment still reports its size');
  assert(typeof e.attachment.omitted === 'string' && e.attachment.omitted.includes('exceeds'), 'over-cap attachment explains the omission');
  assert(e.attachment.error === undefined, 'over-cap is omitted, not error');
}

// ---- attachment: download-error stub ----
{
  const e = env(
    { ...base, text: '', attachment: { kind: 'document', file_id: 'F', file_name: 'x.bin', file_size: 100 } },
    { ok: false, reason: 'error', detail: 'getFile failed: HTTP 400' },
  );
  assert(e.attachment.b64 === undefined, 'errored attachment carries no b64');
  assert(e.attachment.wire_id === undefined && e.attachment.transport === undefined, 'errored stub has no wire_id/transport');
  assert(e.attachment.error === 'getFile failed: HTTP 400', 'errored attachment explains the error');
  assert(e.attachment.omitted === undefined, 'download error is error, not omitted');
}

// ---- attachmentMeta synthesizes filename + mime consistently with send_file ----
{
  const meta = attachmentMeta({ kind: 'photo', file_id: 'F' }, 7);
  assert(meta.filename === 'photo_7.jpg' && meta.mime === 'image/jpeg', 'photo meta synthesized (kind + message_id)');
  const docMeta = attachmentMeta({ kind: 'document', file_id: 'D', file_name: 'a.zip', mime_type: 'application/zip' }, 3);
  assert(docMeta.filename === 'a.zip' && docMeta.mime === 'application/zip', 'document meta uses Telegram-supplied name + mime');
}

console.log('=== envelope transcription (voice STT) ===');

// ---- transcription (voice) ----
{
  const voice = { ...base, text: '', attachment: { kind: 'voice', file_id: 'v1', file_size: 2048 } };
  // transcribed, audio NOT forwarded => text folded, no attachment block
  const e1 = JSON.parse(buildEnvelope(voice, undefined, undefined,
    { status: 'ok', text: 'ship it friday', engine: 'openai', model: 'whisper-1', lang: 'en' }));
  assert(e1.text === 'ship it friday', 'transcript folds into top-level text');
  assert(e1.attachment === undefined, 'attachment omitted when audio not forwarded');
  assert(e1.transcription && e1.transcription.status === 'ok' && e1.transcription.model === 'whisper-1', 'transcription block present');
  assert(e1.transcription.engine === 'openai' && e1.transcription.lang === 'en', 'transcription carries engine + lang');

  // transcribed AND forwarded => both blocks
  const resolved = { ok: true, bytes: Buffer.from('x'.repeat(2048)) };
  const e2 = JSON.parse(buildEnvelope(voice, resolved, 'ours-file-abc',
    { status: 'ok', text: 'hi', engine: 'openai', model: 'whisper-1' }));
  assert(e2.text === 'hi', 'text folded in forward mode');
  assert(e2.attachment && e2.attachment.wire_id === 'ours-file-abc', 'attachment kept in forward mode');
  assert(e2.transcription.status === 'ok', 'transcription kept in forward mode');

  // STT error => attachment kept (file fallback), transcription.status error, text stays ''
  const e3 = JSON.parse(buildEnvelope(voice, resolved, 'ours-file-def',
    { status: 'error', error: 'STT HTTP 401' }));
  assert(e3.text === '', 'text unchanged on STT error');
  assert(e3.transcription.status === 'error' && /401/.test(e3.transcription.error), 'error captured in transcription');
  assert(e3.attachment && e3.attachment.wire_id === 'ours-file-def', 'file still announced on STT error');

  // no transcription arg => byte-identical to today (no transcription field)
  const e4 = JSON.parse(buildEnvelope(voice, resolved, 'ours-file-ghi'));
  assert(e4.transcription === undefined, 'no transcription field when STT was not attempted');
  assert(e4.text === '' && e4.attachment && e4.attachment.wire_id === 'ours-file-ghi', 'off-path is today’s output exactly');
}
// caption guard: an audio file WITH a caption keeps its caption as text
{
  const audio = { ...base, text: 'my song', attachment: { kind: 'audio', file_id: 'a1', file_size: 10 } };
  const e = JSON.parse(buildEnvelope(audio, undefined, undefined, { status: 'ok', text: 'lyrics here', model: 'whisper-1' }));
  assert(e.text === 'my song', 'existing caption is NOT overwritten by transcript');
  assert(e.transcription.text === 'lyrics here', 'transcript still available in transcription block');
}

console.log('=== telegram pure parsers ===');

// ---- pickAttachment precedence + photo-largest ----
{
  assert(pickAttachment({ text: 'hi' }) === undefined, 'plain text message has no attachment');

  const photo = pickAttachment({ photo: [ { file_id: 'small', file_size: 100 }, { file_id: 'big', file_size: 9000 } ] });
  assert(photo.kind === 'photo' && photo.file_id === 'big', 'photo picks the largest size (last element)');

  const doc = pickAttachment({ document: { file_id: 'D', file_name: 'a.zip', mime_type: 'application/zip', file_size: 5 } });
  assert(doc.kind === 'document' && doc.file_name === 'a.zip' && doc.mime_type === 'application/zip', 'document descriptor carries name + mime');

  // An animation arrives as BOTH animation and document — animation must win.
  const anim = pickAttachment({ animation: { file_id: 'A', file_size: 7 }, document: { file_id: 'D', file_size: 7 } });
  assert(anim.kind === 'animation' && anim.file_id === 'A', 'animation wins over its shadow document');

  const voice = pickAttachment({ voice: { file_id: 'V', mime_type: 'audio/ogg', file_size: 3 } });
  assert(voice.kind === 'voice' && voice.file_id === 'V', 'voice descriptor recognized');

  const sticker = pickAttachment({ sticker: { file_id: 'S', file_size: 2 } });
  assert(sticker.kind === 'sticker', 'sticker descriptor recognized');
}

// ---- parseReply ----
{
  assert(parseReply({ text: 'hi' }) === undefined, 'no reply_to_message -> undefined');
  const r = parseReply({ reply_to_message: { message_id: 50, text: 'earlier' } });
  assert(r.message_id === 50 && r.text === 'earlier', 'reply pulls id + replied text');
  const rc = parseReply({ reply_to_message: { message_id: 51, caption: 'a caption' } });
  assert(rc.text === 'a caption', 'reply falls back to the replied caption');
  const rn = parseReply({ reply_to_message: { message_id: 52 } });
  assert(rn.message_id === 52 && rn.text === undefined, 'reply with no text/caption omits text');
}

// ---- parseForwardOrigin: modern forward_origin union ----
{
  assert(parseForwardOrigin({ text: 'hi' }) === undefined, 'not forwarded -> undefined');

  const u = parseForwardOrigin({ forward_origin: { type: 'user', sender_user: { id: 9, first_name: 'Bob', last_name: 'Jones', username: 'bob' } } });
  assert(u.type === 'user' && u.name === 'Bob Jones' && u.username === 'bob', 'forward_origin user -> name + username');

  const h = parseForwardOrigin({ forward_origin: { type: 'hidden_user', sender_user_name: 'Hidden Person' } });
  assert(h.type === 'hidden_user' && h.name === 'Hidden Person' && h.username === undefined, 'forward_origin hidden_user -> name only');

  const ch = parseForwardOrigin({ forward_origin: { type: 'channel', chat: { title: 'ACME News', username: 'acmenews' }, message_id: 99 } });
  assert(ch.type === 'channel' && ch.name === 'ACME News' && ch.username === 'acmenews' && ch.message_id === 99, 'forward_origin channel -> title + username + message_id');

  const c = parseForwardOrigin({ forward_origin: { type: 'chat', sender_chat: { title: 'Some Group', username: 'somegroup' } } });
  assert(c.type === 'chat' && c.name === 'Some Group', 'forward_origin chat -> title');
}

// ---- parseForwardOrigin: legacy fields ----
{
  const u = parseForwardOrigin({ forward_from: { id: 9, first_name: 'Bob', username: 'bob' } });
  assert(u.type === 'user' && u.name === 'Bob' && u.username === 'bob', 'legacy forward_from -> user origin');

  const ch = parseForwardOrigin({ forward_from_chat: { type: 'channel', title: 'ACME News', username: 'acmenews' }, forward_from_message_id: 12 });
  assert(ch.type === 'channel' && ch.name === 'ACME News' && ch.message_id === 12, 'legacy forward_from_chat channel -> channel origin');

  const hid = parseForwardOrigin({ forward_sender_name: 'Hidden Person' });
  assert(hid.type === 'hidden_user' && hid.name === 'Hidden Person', 'legacy forward_sender_name -> hidden_user origin');
}

console.log('=== telegram sendDocument ===');

// ---- sendDocument: multipart fields are correct (injected fetch, no network) ----
{
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200, text: async () => '' }; };
  try {
    const tg = new TelegramClient('TOKEN', 30, () => {});
    await tg.sendDocument(12345, Buffer.from('PDFBYTES'), 'receipt.pdf', 'application/pdf', 7);
    assert(calls.length === 1, 'one sendDocument call');
    assert(String(calls[0].url).endsWith('/sendDocument'), 'hits the sendDocument endpoint');
    const form = calls[0].init.body;
    assert(form.get('chat_id') === '12345', 'chat_id set');
    assert(form.get('message_thread_id') === '7', 'message_thread_id set');
    const doc = form.get('document');
    assert(doc && doc.name === 'receipt.pdf', 'filename preserved on the document part');
    assert(Buffer.from(await doc.arrayBuffer()).toString() === 'PDFBYTES', 'document bytes preserved');
  } finally {
    globalThis.fetch = realFetch;
  }
  // No thread → no message_thread_id field.
  {
    const calls = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200, text: async () => '' }; };
    try {
      const tg = new TelegramClient('TOKEN', 30, () => {});
      await tg.sendDocument('-100999', Buffer.from('X'), 'note.txt', undefined);
      assert(calls[0].init.body.get('message_thread_id') === null, 'no message_thread_id when threadId omitted');
    } finally {
      globalThis.fetch = realFetch;
    }
  }
}

console.log(failures === 0 ? 'ALL PASSED' : `${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
