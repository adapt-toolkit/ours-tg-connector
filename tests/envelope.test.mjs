#!/usr/bin/env node
// Pure unit test for src/envelope.ts — the voice-note shaping that survives now
// that the connector no longer transcribes anything. No broker, no Telegram, no
// network.
//
// WHAT THIS FILE USED TO TEST AND DELIBERATELY NO LONGER DOES: the transcript
// text-fold, the `transcription` block, and the attachment-omit that went with a
// text-only transcript. src/stt.ts is deleted; transcription belongs to the ours
// SDK on the receiving side. The cases below are the inverse assertions — that
// the envelope carries NO transcript and ALWAYS announces the forwarded audio —
// because that is what makes the SDK's own transcription reachable at all.
//
// Run: node_modules/.bin/tsx tests/envelope.test.mjs

import { attachmentMeta, buildEnvelope, buildPlainPayload, VOICE_MESSAGE_MIME } from '../src/envelope.ts';

let failures = 0;
function assert(cond, msg) {
  if (cond) console.log(`  ✓ ${msg}`);
  else { console.log(`  ✗ ${msg}`); failures++; }
}

// A minimal valid inbound message (mirrors the connector's TelegramMessage shape).
const base = {
  update_id: 1, message_id: 4521, chat_id: 12345, chat_type: 'private',
  is_topic: false, from: 'Alice Smith', from_id: 12345, text: 'hello', date: 1750602602,
};

console.log('=== envelope: voice notes travel as marked audio, never as a transcript ===');

{
  const voice = { ...base, text: '', attachment: { kind: 'voice', file_id: 'v1', file_size: 2048 } };
  const resolved = { ok: true, bytes: Buffer.from('x'.repeat(2048)) };

  // THE CORE OF THE CHANGE: a caption-less voice note keeps text '' and always
  // announces the audio it forwarded.
  const e1 = JSON.parse(buildEnvelope(voice, resolved, 'ours-file-abc'));
  assert(e1.text === '', 'caption-less voice note keeps text "" — no transcript is folded in');
  assert(e1.transcription === undefined, 'envelope has NO transcription block at all');
  assert(e1.attachment && e1.attachment.wire_id === 'ours-file-abc', 'forwarded audio is announced with its wire_id');
  assert(e1.attachment.transport === 'send_file', 'attachment declares the send_file transport');
  assert(e1.attachment.filename === 'voice_4521.ogg', 'voice attachment gets deterministic safe .ogg filename');
  assert(e1.attachment.mime === VOICE_MESSAGE_MIME,
    'voice envelope carries the exact marker the SDK isVoiceMessage() matches');

  // buildEnvelope takes three arguments now. A stale fourth argument from an
  // un-migrated caller must not resurrect a transcript field.
  const e2 = JSON.parse(buildEnvelope(voice, resolved, 'ours-file-abc',
    { status: 'ok', text: 'ship it friday', engine: 'openai', model: 'whisper-1' }));
  assert(e2.text === '' && e2.transcription === undefined,
    'a leftover transcription argument is ignored, not folded into text');

  // A failed send_file must not claim a transport or wire-id correlation.
  const e3 = JSON.parse(buildEnvelope(voice, resolved));
  assert(e3.attachment.error === 'file transfer failed', 'send_file failure is explicit in the envelope');
  assert(e3.attachment.transport === undefined && e3.attachment.wire_id === undefined,
    'send_file failure never advertises an unresolved transport correlation');
  assert(e3.text === '', 'send_file failure still leaves text empty');

  // Plain mode: the voice note is represented completely by the file, so there
  // is no companion text message to manufacture.
  assert(buildPlainPayload({ ...base, attachment: undefined }, undefined, undefined) === 'hello',
    'plain mode forwards direct-chat text without JSON wrapping');
  assert(buildPlainPayload(voice, resolved, 'ours-file-abc') === undefined,
    'plain mode sends no companion text for a caption-less voice file');
  assert(buildPlainPayload(voice, resolved, 'ours-file-abc', { status: 'ok', text: 'spoken words' }) === undefined,
    'plain mode ignores a leftover transcription argument rather than sending it as text');
  assert(buildPlainPayload(voice, { ok: false, reason: 'error', detail: 'download failed' }, undefined)
    === '[Telegram voice unavailable: download failed]',
  'plain mode reports a failed attachment without a JSON envelope');
  assert(buildPlainPayload(voice, resolved, undefined)
    === '[Telegram voice unavailable: file transfer failed]',
  'plain mode reports a failed file-channel transfer without a JSON envelope');
}

// A captioned audio file keeps its caption. This used to be a guard against the
// transcript overwriting it; it now simply asserts text is passed through.
{
  const audio = { ...base, text: 'my song', attachment: { kind: 'audio', file_id: 'a1', file_size: 10 } };
  const e = JSON.parse(buildEnvelope(audio, { ok: true, bytes: Buffer.from('x') }, 'ours-file-xyz'));
  assert(e.text === 'my song', 'a caption is forwarded verbatim');
  assert(e.transcription === undefined, 'a captioned audio file has no transcription block either');
}

// Semantic kind, not filename/MIME guessing, controls voice-message marking.
// This is now load-bearing rather than cosmetic: the marker is the ONLY thing
// that tells the receiving SDK to transcribe the file.
{
  const malformedVoice = {
    kind: 'voice', file_id: 'v2', file_name: '../../not-safe.exe',
    mime_type: 'application/octet-stream; x-ours-kind=not-voice',
  };
  const voiceMeta = attachmentMeta(malformedVoice, Number.NaN);
  assert(voiceMeta.filename === 'voice_unknown.ogg', 'malformed voice metadata cannot escape the safe .ogg filename');
  assert(voiceMeta.mime === VOICE_MESSAGE_MIME, 'malformed voice MIME is replaced by the exact marker');

  const ordinaryOgg = attachmentMeta({
    kind: 'audio', file_id: 'a2', file_name: 'recording.ogg', mime_type: 'audio/ogg',
  }, 99);
  assert(ordinaryOgg.filename === 'recording.ogg' && ordinaryOgg.mime === 'audio/ogg',
    'ordinary non-voice OGG remains unmarked — and is therefore transcribed by nobody');
}

console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
