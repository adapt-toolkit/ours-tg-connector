#!/usr/bin/env node
// Live e2e for voice-note speech-to-text through the connector path. Mirrors
// test-sendfile.mjs: one AdaptHost (in-process test broker), two packets that
// become contacts — a "Connector" (the bot node) and an "Agent" (the proxy) —
// then drives the REAL inbound forward logic and asserts what the Agent actually
// receives (its get_messages envelope + get_files) for each Definition-of-Done
// scenario (SPEC §8.1–8.6).
//
// This exercises the real src/stt.ts transcribe() and src/envelope.ts
// buildEnvelope() over a real encrypted channel; only the STT provider HTTP call
// and Telegram download are stubbed (globalThis.fetch / fixed bytes), so it needs
// no Telegram bot and no real STT key. The send block below (forwardVoice) is a
// faithful mirror of the STT + send-decision in connector.ts forwardToNode — the
// `let transcription …` block through `buildEnvelope(m, sendAudio ? resolved : …,
// fileWireId, transcription)`. The repo tests the wire path by driving packets
// directly because connector.ts auto-runs main() on import, so forwardToNode
// cannot be imported (see test-sendfile.mjs). If forwardToNode's STT/sendAudio
// logic changes, update forwardVoice() below to match.
//
// REWRITTEN FOR THE DAEMON-ATTACHED CONNECTOR. It used to stand up an AdaptHost
// and two packets in-process. There is no AdaptHost here any more — so it starts
// a REAL DAEMON through the released operator CLI and drives two public SDK
// clients against it, which is also closer to production than the old version.
//
// WHAT IT COVERS IS UNCHANGED AND IS STILL THIS REPO'S OWN CODE: src/stt.ts and
// src/envelope.ts. Only the transport underneath moved. Deleting it with the
// engine tests would have lost the coverage of the two files the conversion did
// NOT touch.
//
// Run: node_modules/.bin/tsx tests/voice.test.mjs  (it imports .ts sources directly)
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildEnvelope, attachmentMeta, VOICE_MESSAGE_MIME } from '../src/envelope.ts';
import { transcribe } from '../src/stt.ts';
import { freePort, startExternalDaemon } from './external-daemon.mjs';

const DAEMON_STATE = mkdtempSync(join(tmpdir(), 'tg-voice-daemon-'));
const PORT = await freePort();
const { attachOursClient } = await import('@ours.network/sdk');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function assert(cond, msg) {
  if (cond) console.log(`  ✓ ${msg}`);
  else { console.log(`  ✗ ${msg}`); failures++; }
}
const log = (...p) => { if (process.env.VERBOSE) process.stderr.write(`[host] ${p.join(' ')}\n`); };

// Cosmetic label helper — a verbatim copy of connector.ts sttEngineLabel.
function sttEngineLabel(baseUrl) {
  try { return new URL(baseUrl).hostname.replace(/^api\./, '').split('.')[0]; } catch { return 'stt'; }
}

// Faithful mirror of connector.ts forwardToNode's STT + send decision, for one
// target. Uses the REAL transcribe()/buildEnvelope(); returns whether a file was
// sent so the test can cross-check against the Agent's file inbox.
async function forwardVoice(client, targetCid, m, resolved, CONFIG) {
  let transcription;
  const kind = m.attachment?.kind;
  if (CONFIG.sttEnabled && kind && CONFIG.sttKinds.includes(kind) && resolved?.ok) {
    const engine = sttEngineLabel(CONFIG.sttBaseUrl);
    if (resolved.bytes.length > CONFIG.sttMaxBytes) {
      transcription = { status: 'error', error: 'too_large', engine, model: CONFIG.sttModel };
    } else {
      const meta = attachmentMeta(m.attachment, m.message_id);
      globalThis.__connectorStt?.(true);
      let r;
      try {
        r = await transcribe(resolved.bytes, meta.filename, meta.mime, {
          baseUrl: CONFIG.sttBaseUrl, apiKey: CONFIG.sttApiKey, model: CONFIG.sttModel,
          language: CONFIG.sttLanguage || undefined, timeoutMs: CONFIG.sttTimeoutMs,
        });
      } finally {
        globalThis.__connectorStt?.(false);
      }
      transcription = r.ok
        ? { status: 'ok', text: r.text, engine, model: CONFIG.sttModel, lang: r.lang }
        : { status: 'error', error: r.error, engine, model: CONFIG.sttModel };
    }
  }
  const sendAudio = !!(resolved?.ok) && !(transcription?.status === 'ok' && !CONFIG.forwardVoiceAudio);
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
  const body = buildEnvelope(m, sendAudio ? resolved : undefined, fileWireId, transcription);
  await client.sendMessage({ contact: targetCid, text: body });
  return { sentFile: !!fileWireId };
}

async function main() {
  console.log('=== ours-tg-connector voice STT e2e (daemon-attached) ===\n');
  const handle = await startExternalDaemon({ stateDir: DAEMON_STATE, port: PORT });
  const URL_ = handle.url;
  // Two sessions in ONE daemon: the route ("Connector") and the proxy agent.
  // Different lease tokens, because the token IS the session.
  const connector = await attachOursClient({
    endpoint: URL_, stateDir: DAEMON_STATE, leaseToken: 'voice-connector-tok',
  });
  const agent = await attachOursClient({
    endpoint: URL_, stateDir: DAEMON_STATE, leaseToken: 'voice-agent-tok',
  });
  await connector.createIdentity({ name: 'Connector', bio: '', exposeLocal: false, localAutoAccept: true });
  await agent.createIdentity({ name: 'Agent', bio: '', exposeLocal: false, localAutoAccept: true });

  // Become contacts (connector invites, agent redeems) — connector can then send
  // to the agent by name, exactly like a route → proxy agent.
  // A client addresses a contact by NAME, not by container id — the daemon
  // resolves it. `agent.cid` no longer exists here: there is no packet object.
  const AGENT_NAME = 'Agent';
  const inv = await connector.generateInvite({});
  await agent.addContact({ invite: inv.blob });
  console.log('  waiting for handshake + accept round trip…');
  for (let i = 0; i < 600; i++) {
    if ((await agent.listContacts()).contacts.length > 0) break;
    await sleep(200);
  }

  // Drain the agent's message + file inboxes and return what arrived for the last send.
  // THE BYTES ARE NOT IN THE RESULT ANY MORE, and the difference is a trap worth
  // naming: the old renderFiles() returned `bytes` as a Buffer of CONTENT; the
  // typed getFiles() returns `bytes` as the byte COUNT and writes the content into
  // the daemon-owned identity folder, where GET /files/<wire_id> serves it back.
  // Same field name, different meaning — `.bytes.equals(opus)` failed with
  // "Cannot read properties of undefined" rather than a type error, because a
  // string has no .equals.
  const contentOf = async (row) => Buffer.from(await agent.fetchFile(row.wire_id));

  // A fetch spy that counts ONLY the CONNECTOR's own STT call.
  //
  // TWO THINGS BROKE THE OLD BLANKET SPY, and the second one is a finding rather
  // than a test problem.
  //
  // 1. OursClient talks to the daemon over fetch, so a wholesale stub intercepts
  //    daemon traffic too. (In practice OursClient captures globalThis.fetch at
  //    CONSTRUCTION, so it escaped — but that is luck, not design, and a spy that
  //    depends on it is a spy waiting to invert.)
  //
  // 2. THE DAEMON RUNS ITS OWN SPEECH-TO-TEXT. When the agent's getFiles() pulls
  //    a received voice note, the SDK transcribes it daemon-side through its own
  //    openai-compatible provider — the stack says so:
  //        at Object.O [as openai-compatible] (@ours.network/sdk/dist/…)
  //    It hits the SAME provider URL as the connector's src/stt.ts, so a
  //    URL-matching spy cannot tell the two apart and "the provider was never
  //    called" fails against a connector that correctly did not call it.
  //
  //    THE CONSEQUENCE IS BIGGER THAN THIS TEST AND IS REPORTED SEPARATELY: the
  //    connector's `sttEnabled: false` no longer means "this audio is not sent to
  //    an STT provider". It means "the CONNECTOR does not send it"; the daemon
  //    may still, on the receiving side, under its own configuration. That is a
  //    privacy-relevant behaviour change of the host->client conversion and it is
  //    NOT something to fix by loosening an assertion.
  //
  // So the spy is scoped by ORIGIN, not by URL: `connectorSttInFlight` is set
  // only around the connector's own transcribe() call.
  let connectorSttInFlight = false;
  globalThis.__connectorStt = (on) => { connectorSttInFlight = on; };
  const sttSpy = (respond) => {
    let called = false;
    const real = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : String(input?.url ?? input);
      if (connectorSttInFlight && url.startsWith(baseCfg.sttBaseUrl)) {
        called = true;
        return respond();
      }
      return real(input, init);
    };
    return { was: () => called, restore: () => { globalThis.fetch = real; } };
  };

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

  const realFetch = globalThis.fetch;
  // Base config = spec defaults; each scenario overrides.
  const baseCfg = {
    sttEnabled: false, sttApiKey: 'sk-dummy-test', sttBaseUrl: 'https://api.groq.com/openai/v1',
    sttModel: 'whisper-large-v3-turbo', sttLanguage: '', sttKinds: ['voice'],
    sttMaxBytes: 5 * 1024 * 1024, sttTimeoutMs: 5000, forwardVoiceAudio: false,
  };

  try {
    // DoD 1 + 2: transcript reaches agent as text; audio omitted by default.
    console.log('\n-- DoD 1 & 2: transcribe, text-only (forwardVoiceAudio:false) --');
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ text: 'ship it friday', language: 'en' }) });
    let r = await forwardVoice(connector, AGENT_NAME, voiceMsg(701), resolvedOk, { ...baseCfg, sttEnabled: true });
    let a = await drainAgent();
    assert(a.env && a.env.text === 'ship it friday', 'DoD1: agent envelope text equals the spoken phrase');
    assert(a.env && a.env.transcription?.status === 'ok' && a.env.transcription.engine === 'groq' && a.env.transcription.model === 'whisper-large-v3-turbo', 'DoD1: transcription block ok with engine + model');
    assert(!r.sentFile && a.files.length === 0, 'DoD2: no send_file for the message');
    assert(a.env && a.env.attachment === undefined, 'DoD2: envelope has no attachment block');

    // DoD 3: forwardVoiceAudio:true → both send_file and attachment + transcription.
    console.log('\n-- DoD 3: forwardVoiceAudio:true --');
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ text: 'hello there' }) });
    r = await forwardVoice(connector, AGENT_NAME, voiceMsg(702), resolvedOk, { ...baseCfg, sttEnabled: true, forwardVoiceAudio: true });
    a = await drainAgent();
    assert(a.env && a.env.text === 'hello there', 'DoD3: text still folded in forward mode');
    assert(r.sentFile && a.files.length === 1 && (await contentOf(a.files[0])).equals(opus), 'DoD3: audio also delivered via send_file (bytes intact)');
    assert(a.env && a.env.attachment && a.env.attachment.wire_id && a.env.attachment.transport === 'send_file', 'DoD3: envelope carries the attachment block with a wire_id');
    assert(a.files[0].filename === 'voice_702.ogg' && a.env.attachment.filename === a.files[0].filename,
      'DoD3: send_file and envelope share the safe .ogg filename');
    assert(a.files[0].mime === VOICE_MESSAGE_MIME && a.env.attachment.mime === a.files[0].mime,
      'DoD3: send_file and envelope share the exact ours-mcp voice MIME');
    assert(a.env && a.env.transcription?.status === 'ok', 'DoD3: transcription block also present');

    // DoD 4: graceful failure on invalid key / provider error → .ogg forwarded, status:error.
    console.log('\n-- DoD 4: STT failure (HTTP 401) degrades to file forward --');
    globalThis.fetch = async () => ({ ok: false, status: 401, text: async () => 'invalid api key' });
    r = await forwardVoice(connector, AGENT_NAME, voiceMsg(703), resolvedOk, { ...baseCfg, sttEnabled: true, sttApiKey: 'sk-bad' });
    a = await drainAgent();
    assert(r.sentFile && a.files.length === 1, 'DoD4: .ogg still delivered on STT failure');
    assert(a.env && a.env.transcription?.status === 'error' && /401/.test(a.env.transcription.error), 'DoD4: transcription.status:error captured');
    assert(a.env && a.env.text === '', 'DoD4: text stays empty (nothing dropped)');
    assert(a.env && a.env.attachment && a.env.attachment.wire_id, 'DoD4: attachment block announces the forwarded audio');
    assert(a.files[0].mime === VOICE_MESSAGE_MIME && a.env.attachment.mime === VOICE_MESSAGE_MIME,
      'DoD4: STT failure fallback remains recognizable as a voice message');

    // Enabled STT with no local/provider key is another graceful fallback: the
    // STT client short-circuits and the original bytes remain available.
    console.log('\n-- no local STT credential degrades to file forward --');
    const spyNoKey = sttSpy(() => ({ ok: true, status: 200, json: async () => ({ text: 'must not run' }) }));
    r = await forwardVoice(connector, AGENT_NAME, voiceMsg(706), resolvedOk,
      { ...baseCfg, sttEnabled: true, sttApiKey: '' });
    a = await drainAgent();
    spyNoKey.restore();
    assert(!spyNoKey.was(), 'missing local STT credential never calls the provider');
    assert(a.env?.transcription?.status === 'error' && /no STT api key/i.test(a.env.transcription.error),
      'missing local STT credential is reported without a secret');
    assert(r.sentFile && (await contentOf(a.files[0])).equals(opus) && a.files[0].mime === VOICE_MESSAGE_MIME,
      'missing local STT credential forwards unchanged marked OGG/Opus bytes');

    // DoD 6: size guard — bytes over sttMaxBytes skip STT, forward the .ogg.
    console.log('\n-- DoD 6: size guard (over sttMaxBytes) --');
    const spySize = sttSpy(() => ({ ok: true, status: 200, json: async () => ({ text: 'should not run' }) }));
    r = await forwardVoice(connector, AGENT_NAME, voiceMsg(704), resolvedOk, { ...baseCfg, sttEnabled: true, sttMaxBytes: 100 });
    a = await drainAgent();
    spySize.restore();
    assert(!spySize.was(), 'DoD6: STT endpoint not called when over the size guard');
    assert(a.env && a.env.transcription?.status === 'error' && a.env.transcription.error === 'too_large', 'DoD6: transcription.status:error error:too_large');
    assert(r.sentFile && a.files.length === 1, 'DoD6: .ogg forwarded despite skipped STT');
    assert(a.files[0].mime === VOICE_MESSAGE_MIME && a.env.attachment.mime === VOICE_MESSAGE_MIME,
      'DoD6: oversized-for-STT fallback carries the exact voice MIME');

    // DoD 5: sttEnabled:false → file + text:'' + attachment, no transcription.
    console.log('\n-- DoD 5: sttEnabled:false ⇒ marked file fallback --');
    const spyOff = sttSpy(() => ({ ok: true, status: 200, json: async () => ({ text: 'x' }) }));
    r = await forwardVoice(connector, AGENT_NAME, voiceMsg(705), resolvedOk, { ...baseCfg, sttEnabled: false });
    a = await drainAgent();
    spyOff.restore();
    assert(!spyOff.was(), 'DoD5: no STT call when disabled');
    assert(a.env && a.env.text === '' && a.env.transcription === undefined, 'DoD5: text:"" and NO transcription field');
    assert(r.sentFile && a.files.length === 1 && a.env.attachment && a.env.attachment.wire_id,
      'DoD5: .ogg forwarded with a correlated attachment block');
    assert((await contentOf(a.files[0])).equals(opus) && a.files[0].mime === VOICE_MESSAGE_MIME,
      'DoD5: disabled STT forwards unchanged bytes with the exact voice MIME');
    assert(a.env.attachment.mime === a.files[0].mime && a.env.attachment.filename === a.files[0].filename,
      'DoD5: disabled-STT file and envelope metadata correlate exactly');

    // Semantic kind is the source of truth. A normal audio attachment can also
    // be OGG, but must not opt into ours-mcp voice-message handling.
    console.log('\n-- ordinary non-voice OGG stays ordinary audio --');
    const ordinaryOgg = {
      ...voiceMsg(707), text: 'music clip',
      attachment: {
        kind: 'audio', file_id: 'audio-707', file_name: 'recording.ogg',
        mime_type: 'audio/ogg', file_size: opus.length,
      },
    };
    r = await forwardVoice(connector, AGENT_NAME, ordinaryOgg, resolvedOk,
      { ...baseCfg, sttEnabled: false });
    a = await drainAgent();
    assert(r.sentFile && a.files[0].mime === 'audio/ogg' && a.files[0].filename === 'recording.ogg',
      'ordinary OGG send_file metadata remains unmarked');
    assert(a.env.attachment.kind === 'audio' && a.env.attachment.mime === 'audio/ogg',
      'ordinary OGG envelope metadata remains non-voice');

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
    r = await forwardVoice(connector, AGENT_NAME, malformedVoice, resolvedOk,
      { ...baseCfg, sttEnabled: false });
    a = await drainAgent();
    assert(r.sentFile && a.files[0].filename === 'voice_708.ogg' && a.files[0].mime === VOICE_MESSAGE_MIME,
      'malformed semantic voice gets a safe .ogg filename and exact MIME');
    assert(a.env.attachment.filename === a.files[0].filename && a.env.attachment.mime === a.files[0].mime,
      'normalized malformed metadata agrees across file and envelope channels');
  } finally {
    globalThis.fetch = realFetch;
    await handle.close();
    rmSync(DAEMON_STATE, { recursive: true, force: true });
  }

  console.log(`\n${failures === 0 ? 'ALL PASSED' : failures + ' FAILED'}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
