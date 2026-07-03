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
// no Telegram bot and no real STT key. The send block below is a faithful mirror
// of connector.ts forwardToNode — the repo tests the wire path by driving packets
// directly because connector.ts auto-runs main() on import (see test-sendfile.mjs).
//
// Run: node_modules/.bin/tsx test-voice.mjs

import { AdaptHost, wireHandlers, packInvite, unpackInvite, renderInbox, renderFiles, withScope, withScopeAsync } from './src/adapt.ts';
import { buildEnvelope, attachmentMeta } from './src/envelope.ts';
import { transcribe } from './src/stt.ts';

const BROKER = process.env.OURS_TG_BROKER_URL ?? 'ws://localhost:9000';
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
async function forwardVoice(pkt, targetCid, m, resolved, CONFIG) {
  let transcription;
  const kind = m.attachment?.kind;
  if (CONFIG.sttEnabled && kind && CONFIG.sttKinds.includes(kind) && resolved?.ok) {
    const engine = sttEngineLabel(CONFIG.sttBaseUrl);
    if (resolved.bytes.length > CONFIG.sttMaxBytes) {
      transcription = { status: 'error', error: 'too_large', engine, model: CONFIG.sttModel };
    } else {
      const meta = attachmentMeta(m.attachment, m.message_id);
      const r = await transcribe(resolved.bytes, meta.filename, meta.mime, {
        baseUrl: CONFIG.sttBaseUrl, apiKey: CONFIG.sttApiKey, model: CONFIG.sttModel,
        language: CONFIG.sttLanguage || undefined, timeoutMs: CONFIG.sttTimeoutMs,
      });
      transcription = r.ok
        ? { status: 'ok', text: r.text, engine, model: CONFIG.sttModel, lang: r.lang }
        : { status: 'error', error: r.error, engine, model: CONFIG.sttModel };
    }
  }
  const sendAudio = !!(resolved?.ok) && !(transcription?.status === 'ok' && !CONFIG.forwardVoiceAudio);
  let fileWireId;
  if (m.attachment && resolved?.ok && sendAudio) {
    const meta = attachmentMeta(m.attachment, m.message_id);
    fileWireId = await withScopeAsync(async (lt) =>
      (await pkt.mutatingTx('::a2a_messaging::send_file',
        { contact: targetCid, filename: meta.filename, mime: meta.mime, data: pkt.newBinary(resolved.bytes, lt) }, lt)).Reduce('wire_id').Visualize());
  }
  const body = buildEnvelope(m, sendAudio ? resolved : undefined, fileWireId, transcription);
  await withScopeAsync((lt) => pkt.mutatingTx('::a2a_messaging::send_message', { contact: targetCid, text: body }, lt));
  return { sentFile: !!fileWireId };
}

async function main() {
  console.log('=== ours-tg-connector voice STT e2e ===\n');
  const host = new AdaptHost(BROKER, log);
  await host.boot();

  const connector = await host.createPacket('Connector', 'seed-conn-' + Date.now());
  const agent = await host.createPacket('Agent', 'seed-agent-' + Date.now());
  wireHandlers(connector, { onSaveState: () => {}, onNotify: () => {} }, log);
  wireHandlers(agent, { onSaveState: () => {}, onNotify: () => {} }, log);
  await withScopeAsync((lt) => connector.mutatingTx('::a2a_messaging::set_my_name', { name: 'Connector' }, lt));
  await withScopeAsync((lt) => agent.mutatingTx('::a2a_messaging::set_my_name', { name: 'Agent' }, lt));

  // Become contacts (connector invites, agent redeems) — connector can then send
  // to agent.cid directly, exactly like a route → proxy agent.
  const blob = await withScopeAsync(async (lt) =>
    packInvite(Buffer.from((await connector.mutatingTx('::a2a_messaging::generate_invite', {}, lt)).Reduce('invite').GetBinary())));
  const raw = unpackInvite(blob);
  await withScopeAsync((lt) => agent.mutatingTx('::a2a_messaging::add_contact', { invite: agent.newBinary(raw, lt) }, lt));
  console.log('  waiting 6s for handshake + accept round trip…');
  await sleep(6000);

  // Drain the agent's message + file inboxes and return what arrived for the last send.
  async function drainAgent() {
    await sleep(2500); // let delivery settle
    const msgs = await withScopeAsync(async (lt) =>
      renderInbox((await agent.mutatingTx('::actor::get_messages', {}, lt)).Reduce('messages')));
    const files = await withScopeAsync(async (lt) =>
      renderFiles((await agent.mutatingTx('::actor::get_files', {}, lt)).Reduce('files')));
    const env = msgs.length === 1 ? JSON.parse(msgs[0].text) : null;
    return { count: msgs.length, env, files };
  }

  // A caption-less Telegram voice note (m.text === '') with resolved Opus bytes.
  const voiceMsg = (id = 700) => ({
    update_id: id, message_id: id, chat_id: 555, chat_type: 'private', is_topic: false,
    from: 'Alice', from_id: 555, text: '', date: 1750602602,
    attachment: { kind: 'voice', file_id: `vf-${id}`, mime_type: 'audio/ogg', file_size: 2048 },
  });
  const opus = Buffer.from('OPUS-BYTES-'.repeat(64)); // ~700 B of fake audio
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
    let r = await forwardVoice(connector, agent.cid, voiceMsg(701), resolvedOk, { ...baseCfg, sttEnabled: true });
    let a = await drainAgent();
    assert(a.env && a.env.text === 'ship it friday', 'DoD1: agent envelope text equals the spoken phrase');
    assert(a.env && a.env.transcription?.status === 'ok' && a.env.transcription.engine === 'groq' && a.env.transcription.model === 'whisper-large-v3-turbo', 'DoD1: transcription block ok with engine + model');
    assert(!r.sentFile && a.files.length === 0, 'DoD2: no send_file for the message');
    assert(a.env && a.env.attachment === undefined, 'DoD2: envelope has no attachment block');

    // DoD 3: forwardVoiceAudio:true → both send_file and attachment + transcription.
    console.log('\n-- DoD 3: forwardVoiceAudio:true --');
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ text: 'hello there' }) });
    r = await forwardVoice(connector, agent.cid, voiceMsg(702), resolvedOk, { ...baseCfg, sttEnabled: true, forwardVoiceAudio: true });
    a = await drainAgent();
    assert(a.env && a.env.text === 'hello there', 'DoD3: text still folded in forward mode');
    assert(r.sentFile && a.files.length === 1 && a.files[0].bytes.equals(opus), 'DoD3: audio also delivered via send_file (bytes intact)');
    assert(a.env && a.env.attachment && a.env.attachment.wire_id && a.env.attachment.transport === 'send_file', 'DoD3: envelope carries the attachment block with a wire_id');
    assert(a.env && a.env.transcription?.status === 'ok', 'DoD3: transcription block also present');

    // DoD 4: graceful failure on invalid key / provider error → .ogg forwarded, status:error.
    console.log('\n-- DoD 4: STT failure (HTTP 401) degrades to file forward --');
    globalThis.fetch = async () => ({ ok: false, status: 401, text: async () => 'invalid api key' });
    r = await forwardVoice(connector, agent.cid, voiceMsg(703), resolvedOk, { ...baseCfg, sttEnabled: true, sttApiKey: 'sk-bad' });
    a = await drainAgent();
    assert(r.sentFile && a.files.length === 1, 'DoD4: .ogg still delivered on STT failure');
    assert(a.env && a.env.transcription?.status === 'error' && /401/.test(a.env.transcription.error), 'DoD4: transcription.status:error captured');
    assert(a.env && a.env.text === '', 'DoD4: text stays empty (nothing dropped)');
    assert(a.env && a.env.attachment && a.env.attachment.wire_id, 'DoD4: attachment block announces the forwarded audio');

    // DoD 6: size guard — bytes over sttMaxBytes skip STT, forward the .ogg.
    console.log('\n-- DoD 6: size guard (over sttMaxBytes) --');
    let fetched = false;
    globalThis.fetch = async () => { fetched = true; return { ok: true, status: 200, json: async () => ({ text: 'should not run' }) }; };
    r = await forwardVoice(connector, agent.cid, voiceMsg(704), resolvedOk, { ...baseCfg, sttEnabled: true, sttMaxBytes: 100 });
    a = await drainAgent();
    assert(!fetched, 'DoD6: STT endpoint not called when over the size guard');
    assert(a.env && a.env.transcription?.status === 'error' && a.env.transcription.error === 'too_large', 'DoD6: transcription.status:error error:too_large');
    assert(r.sentFile && a.files.length === 1, 'DoD6: .ogg forwarded despite skipped STT');

    // DoD 5: sttEnabled:false → today's output exactly (file + text:'' + attachment, no transcription).
    console.log('\n-- DoD 5: sttEnabled:false ⇒ unchanged --');
    let fetched2 = false;
    globalThis.fetch = async () => { fetched2 = true; return { ok: true, status: 200, json: async () => ({ text: 'x' }) }; };
    r = await forwardVoice(connector, agent.cid, voiceMsg(705), resolvedOk, { ...baseCfg, sttEnabled: false });
    a = await drainAgent();
    assert(!fetched2, 'DoD5: no STT call when disabled');
    assert(a.env && a.env.text === '' && a.env.transcription === undefined, 'DoD5: text:"" and NO transcription field');
    assert(r.sentFile && a.files.length === 1 && a.env.attachment && a.env.attachment.wire_id, 'DoD5: .ogg forwarded with an attachment block, exactly as today');
  } finally {
    globalThis.fetch = realFetch;
  }

  console.log(`\n${failures === 0 ? 'ALL PASSED' : failures + ' FAILED'}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
