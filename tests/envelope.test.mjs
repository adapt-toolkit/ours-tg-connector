#!/usr/bin/env node
// Pure unit test for the transcription behaviour of src/envelope.ts buildEnvelope()
// — the text-fold, attachment-omit, error-shape, off-path, and caption-guard cases
// that back the voice-STT DoD (SPEC §8.1–8.6). No broker, no Telegram, no network.
//
// (The broader envelope shaping lived in the root test-envelope.mjs, removed on
// main as a scratch script; this keeps the STT-specific envelope coverage under
// tests/ without resurrecting that file.)
//
// Run: node_modules/.bin/tsx tests/envelope.test.mjs

import { buildEnvelope } from '../src/envelope.ts';

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

console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
