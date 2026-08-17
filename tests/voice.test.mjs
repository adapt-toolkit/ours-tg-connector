#!/usr/bin/env node
// Live e2e for the voice-note path through the connector, now that the connector
// does NOT transcribe. It starts a REAL DAEMON from the published
// @ours.network/sdk and drives two clients against it — a "Connector" (the bot
// node) and an "Agent" (the proxy) — then asserts what the Agent actually
// receives.
//
// WHAT CHANGED AND WHY THIS FILE LOOKS SMALLER: it used to drive src/stt.ts and
// assert the transcript-in-envelope DoD scenarios (SPEC §8.1–8.6). src/stt.ts is
// deleted. The scenarios that remain are the ones that decide whether the SDK's
// own transcription is reachable at all:
//
//   1. THE AUDIO IS ALWAYS FORWARDED. The old default (forwardVoiceAudio:false)
//      suppressed the bytes whenever the connector's own STT succeeded. Deleting
//      the STT client without deleting that suppression would have delivered
//      NOTHING to the receiver — no transcript and no audio. This is the single
//      most important assertion in the file.
//   2. The forwarded file carries the exact x-ours-kind=voice-message marker,
//      because that marker is the only thing that tells the receiving daemon to
//      transcribe it.
//   3. The envelope carries no transcript and no transcription block.
//
// THE DAEMON'S OWN STT IS NOT STUBBED AND NOT ASSERTED HERE. It runs on the
// AGENT's getFiles() under the agent's own `stt` config, which is absent in this
// test environment — so the SDK records an "unconfigured" outcome and the bytes
// still land. Asserting the transcript itself belongs to the SDK's own suite
// (ours-sdk test/transcribe-stt.test.mjs), not to this repo: there is exactly one
// transcription client now and this repo does not own it.
//
// The send block below (forwardVoice) mirrors connector.ts forwardToNode's
// remaining send decision, because connector.ts auto-runs main() on import and
// forwardToNode cannot be imported (see tests/attach-daemon.test.mjs).
//
// Run: node_modules/.bin/tsx tests/voice.test.mjs  (it imports .ts sources directly)
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildEnvelope, attachmentMeta, VOICE_MESSAGE_MIME } from '../src/envelope.ts';

// Env before the first SDK import: the SDK reads its config at MODULE LOAD, so
// importing first and configuring after silently boots against ~/.ours and the
// PUBLIC BROKER. See tests/attach-daemon.test.mjs.
const DAEMON_STATE = mkdtempSync(join(tmpdir(), 'tg-voice-daemon-'));
process.env.OURS_STATE_DIR = DAEMON_STATE;
process.env.OURS_BROKER_URL = 'wss://invalid.local/none';
process.env.OURS_API_VISIBILITY = 'open';
const freePort = () => new Promise((res) => { const sv = createServer(); sv.listen(0, () => { const pt = sv.address().port; sv.close(() => res(pt)); }); });
const PORT = await freePort();
process.env.OURS_PORT = String(PORT);
const { OursClient } = await import('@ours.network/sdk');
// startDaemon boots the wrapper ITSELF — calling bootWrapper() as well is a
// double init that dies naming neither call.
const { startDaemon } = await import('@ours.network/sdk/daemon');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function assert(cond, msg) {
  if (cond) console.log(`  ✓ ${msg}`);
  else { console.log(`  ✗ ${msg}`); failures++; }
}

// Mirror of connector.ts forwardToNode's send decision for one target. `sendAudio`
// is now simply "the bytes resolved" — if this ever grows a condition again,
// something has re-introduced a reason to withhold audio and that is the bug this
// test exists to catch.
async function forwardVoice(client, targetCid, m, resolved) {
  const sendAudio = !!(resolved?.ok);
  let fileWireId;
  if (m.attachment && resolved?.ok && sendAudio) {
    const meta = attachmentMeta(m.attachment, m.message_id);
    // data_base64, not a path — the bytes came off Telegram and are in memory.
    const r = await client.sendFile({
      contact: targetCid,
      data_base64: Buffer.from(resolved.bytes).toString('base64'),
      filename: meta.filename,
      mime: meta.mime,
    });
    fileWireId = 'wireId' in r ? r.wireId : undefined;
  }
  const body = buildEnvelope(m, sendAudio ? resolved : undefined, fileWireId);
  await client.sendMessage({ contact: targetCid, text: body });
  return { sentFile: !!fileWireId };
}

async function main() {
  console.log('=== ours-tg-connector voice forwarding e2e (no connector-side STT) ===\n');
  const handle = await startDaemon({ version: 'test' });
  const URL_ = `http://127.0.0.1:${PORT}`;
  // Two sessions in ONE daemon: the route ("Connector") and the proxy agent.
  // Different lease tokens, because the token IS the session.
  const connector = new OursClient({ url: URL_, leaseToken: 'voice-connector-tok' });
  const agent = new OursClient({ url: URL_, leaseToken: 'voice-agent-tok' });
  await connector.createIdentity({ name: 'Connector', bio: '', exposeLocal: false, localAutoAccept: true });
  await agent.createIdentity({ name: 'Agent', bio: '', exposeLocal: false, localAutoAccept: true });

  // Become contacts (connector invites, agent redeems) — connector can then send
  // to the agent by name, exactly like a route → proxy agent.
  const AGENT_NAME = 'Agent';
  const inv = await connector.generateInvite({});
  await agent.addContact({ invite: inv.blob });
  console.log('  waiting for handshake + accept round trip…');
  for (let i = 0; i < 600; i++) {
    if ((await agent.listContacts()).contacts.length > 0) break;
    await sleep(200);
  }

  // THE BYTES ARE NOT IN THE RESULT: getFiles() writes each file into the
  // daemon-owned identity folder and reports metadata; GET /files/<wire_id>
  // serves it back, scoped to THIS session's bound identity.
  const contentOf = async (row) => Buffer.from(await agent.fetchFile(row.wire_id));

  async function drainAgent() {
    await sleep(2500); // let delivery settle
    const msgs = (await agent.getMessages()).messages;
    const files = (await agent.getFiles()).files;
    const env = msgs.length === 1 ? JSON.parse(msgs[0].text) : null;
    return { count: msgs.length, env, files };
  }

  // A caption-less Telegram voice note (m.text === '') with resolved Opus bytes.
  const voiceMsg = (id = 700) => ({
    update_id: id, message_id: id, chat_id: 555, chat_type: 'private', is_topic: false,
    from: 'Alice', from_id: 555, text: '', date: 1750602602,
    attachment: { kind: 'voice', file_id: `vf-${id}`, mime_type: 'audio/ogg', file_size: 2048 },
  });
  // Placeholder bytes with the expected container/codec signatures; no real
  // Telegram media or user content is used by this test.
  const opus = Buffer.concat([Buffer.from('OggS'), Buffer.alloc(24), Buffer.from('OpusHead'), Buffer.alloc(640)]);
  const resolvedOk = { ok: true, bytes: opus };

  // A fetch spy over the WHOLE process, used only to prove a negative: this
  // connector must not call ANY transcription endpoint. Scoping it by URL would
  // be wrong here — the point is that the connector makes no such call at all.
  const realFetch = globalThis.fetch;
  let transcriptionCalls = 0;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : String(input?.url ?? input);
    if (/audio\/transcriptions|speech-to-text|\/v1\/listen/.test(url)) transcriptionCalls++;
    return realFetch(input, init);
  };

  try {
    // THE REGRESSION THIS FILE EXISTS FOR.
    console.log('\n-- a voice note is always forwarded as audio --');
    let r = await forwardVoice(connector, AGENT_NAME, voiceMsg(701), resolvedOk);
    let a = await drainAgent();
    assert(r.sentFile && a.files.length === 1, 'the audio IS delivered (nothing suppresses it any more)');
    assert((await contentOf(a.files[0])).equals(opus), 'the forwarded bytes are intact');
    assert(a.files[0].mime === VOICE_MESSAGE_MIME,
      'the file carries the exact marker the receiving SDK transcribes on');
    assert(a.files[0].filename === 'voice_701.ogg', 'the file gets the safe deterministic .ogg filename');

    console.log('\n-- the envelope carries no transcript --');
    assert(a.env && a.env.text === '', 'a caption-less voice note arrives with text ""');
    assert(a.env && a.env.transcription === undefined, 'there is no transcription block in the envelope');
    assert(a.env && a.env.attachment && a.env.attachment.wire_id && a.env.attachment.transport === 'send_file',
      'the envelope correlates the separately-arriving file by wire_id');
    assert(a.env.attachment.mime === a.files[0].mime && a.env.attachment.filename === a.files[0].filename,
      'file and envelope metadata agree exactly');

    console.log('\n-- the connector never calls a transcription provider --');
    assert(transcriptionCalls === 0, 'no transcription endpoint was called by this process');

    // The receiving SDK is what decides about transcription now. With no `stt`
    // key configured for the agent, it records an unconfigured outcome — and,
    // critically, still delivers the audio.
    console.log('\n-- transcription is the receiving SDK\'s call, not the connector\'s --');
    assert(a.files[0].kind === 'voice_message',
      'the receiving SDK classified it as a voice message from the marker alone');
    assert(a.files[0].transcription !== undefined,
      'the receiving SDK attached its OWN transcription outcome to the file');
    assert(a.files[0].transcription?.configured === false,
      'with no stt key on the receiving side, the outcome is "not configured" rather than a silent drop');

    // Ordinary audio is NOT marked, and is therefore transcribed by nobody. This
    // is the capability an operator with sttKinds:["audio"] loses; it is asserted
    // here so the loss stays visible in the test suite rather than only in a
    // startup warning.
    console.log('\n-- ordinary non-voice OGG stays ordinary audio (transcribed by nobody) --');
    const ordinaryOgg = {
      ...voiceMsg(707), text: 'music clip',
      attachment: {
        kind: 'audio', file_id: 'audio-707', file_name: 'recording.ogg',
        mime_type: 'audio/ogg', file_size: opus.length,
      },
    };
    r = await forwardVoice(connector, AGENT_NAME, ordinaryOgg, resolvedOk);
    a = await drainAgent();
    assert(r.sentFile && a.files[0].mime === 'audio/ogg' && a.files[0].filename === 'recording.ogg',
      'ordinary OGG send_file metadata remains unmarked');
    assert(a.env.attachment.kind === 'audio' && a.env.attachment.mime === 'audio/ogg',
      'ordinary OGG envelope metadata remains non-voice');
    assert(a.files[0].kind !== 'voice_message',
      'the receiving SDK does NOT treat it as a voice message — so nothing transcribes it');

    // Voice metadata is never trusted for the filename or base MIME: Telegram's
    // semantic `voice` field is enough to select the fixed OGG/Opus contract.
    console.log('\n-- malformed voice metadata is normalized safely --');
    const malformedVoice = {
      ...voiceMsg(708),
      attachment: {
        kind: 'voice', file_id: 'voice-708', file_name: '../../escape.bin',
        mime_type: 'application/octet-stream', file_size: opus.length,
      },
    };
    r = await forwardVoice(connector, AGENT_NAME, malformedVoice, resolvedOk);
    a = await drainAgent();
    assert(r.sentFile && a.files[0].filename === 'voice_708.ogg' && a.files[0].mime === VOICE_MESSAGE_MIME,
      'malformed semantic voice gets a safe .ogg filename and exact MIME');
    assert(a.env.attachment.filename === a.files[0].filename && a.env.attachment.mime === a.files[0].mime,
      'normalized malformed metadata agrees across file and envelope channels');
  } finally {
    globalThis.fetch = realFetch;
    await handle.close?.();
    rmSync(DAEMON_STATE, { recursive: true, force: true });
  }

  console.log(`\n${failures === 0 ? 'ALL PASSED' : failures + ' FAILED'}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
