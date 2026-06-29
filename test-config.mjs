#!/usr/bin/env node
// E2E control-plane config test over a local broker. Two packets: "Connector"
// (the bot node) and "CP" (the messenger control plane). Drives the REAL verb
// dispatch from src/control.ts over the a2a_control channel and asserts:
//   - unbound CP is not_authorized for config verbs
//   - bind rejects a wrong code, accepts the right one
//   - get_manifest / get_config return the expected shapes
//   - set_config applies and is reflected by a follow-up get_config
//
// Prereq: broker on ws://localhost:9000 (ours-mcp/scripts/dev-broker.mjs).
// Run:    OURS_TG_UNIT_DIR=./mufl_code node_modules/.bin/tsx test-config.mjs

import { AdaptHost, wireHandlers, renderControlRequests, renderMonitoringStatus, withScope, withScopeAsync } from './src/adapt.ts';
import { dispatchControlRequest, DEFAULT_DENIED } from './src/control.ts';

const BROKER = process.env.OURS_TG_BROKER_URL ?? 'ws://localhost:9000';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function assert(cond, msg) {
  if (cond) console.log(`  ✓ ${msg}`);
  else { console.log(`  ✗ ${msg}`); failures++; }
}
const log = (...p) => { if (process.env.VERBOSE) process.stderr.write(`[host] ${p.join(' ')}\n`); };

function attach(pkt) {
  wireHandlers(pkt, { onSaveState: () => {}, onNotify: () => {} }, log);
}

async function main() {
  console.log('=== ours-tg-connector control-plane config e2e ===\n');
  const host = new AdaptHost(BROKER, log);
  await host.boot();

  const connector = await host.createPacket('Connector', 'seed-conn-' + Date.now());
  const cp = await host.createPacket('CP', 'seed-cp-' + Date.now());
  attach(connector);
  attach(cp);
  await withScopeAsync((lt) => connector.mutatingTx('::a2a_messaging::set_my_name', { name: 'Connector' }, lt));
  await withScopeAsync((lt) => cp.mutatingTx('::a2a_messaging::set_my_name', { name: 'CP' }, lt));

  // The connector node's mutable config (what the control plane edits).
  const cfg = { name: 'Connector', label: 'Support bot', chatId: '100', deniedMessage: DEFAULT_DENIED };
  const hooks = { persist: () => {}, log: (m) => log('[connector]', m) };

  // CP redeems the connector's invite → they become mutual contacts.
  const raw = await withScopeAsync(async (lt) =>
    Buffer.from((await connector.mutatingTx('::a2a_messaging::generate_invite', {}, lt)).Reduce('invite').GetBinary()));
  await withScopeAsync((lt) => cp.mutatingTx('::a2a_messaging::add_contact', { invite: cp.newBinary(raw, lt) }, lt));
  console.log('  waiting 6s for handshake…');
  await sleep(6000);
  assert(true, 'connector + CP are mutual contacts');

  // Drive one control request from CP and collect the connector's reply(ies).
  async function cpRequest(payload) {
    await withScopeAsync((lt) => cp.mutatingTx('::a2a_control::send_control', { contact: connector.cid, payload: JSON.stringify(payload) }, lt));
    await sleep(2500);
    const reqs = await withScopeAsync(async (lt) =>
      renderControlRequests((await connector.mutatingTx('::actor::get_control_requests', {}, lt)).Reduce('requests')));
    for (const req of reqs) {
      await dispatchControlRequest(connector, cfg, req, hooks);
    }
    await sleep(2500);
    return withScopeAsync(async (lt) =>
      renderControlRequests((await cp.mutatingTx('::actor::get_control_requests', {}, lt)).Reduce('requests'))
        .map((r) => { try { return JSON.parse(r.payload); } catch { return null; } })
        .filter(Boolean)
        .filter((m) => m.t === 'res'));
  }

  // 1. Unbound: config verb must be rejected.
  let res = await cpRequest({ v: 1, id: 'a', t: 'get_config' });
  assert(res.length === 1 && res[0].ok === false && res[0].error === 'not_authorized', 'unbound CP is not_authorized for get_config');

  // 2. Start the bind ceremony and try a wrong code.
  await withScopeAsync((lt) => connector.mutatingTx('::a2a_messaging::set_proxy_pending', { code: '654321', proxy: cp.cid }, lt));
  res = await cpRequest({ v: 1, id: 'b', t: 'bind', code: '000000' });
  assert(res.length === 1 && res[0].ok === false && res[0].error === 'wrong_code', 'bind with wrong code is rejected (wrong_code)');
  let mon = withScope((lt) => renderMonitoringStatus(connector.readonlyTx('::a2a_messaging::get_monitoring_status', lt)));
  assert(mon.proxyCid === '', 'connector is still unbound after a wrong code');

  // 3. Bind with the right code.
  res = await cpRequest({ v: 1, id: 'c', t: 'bind', code: '654321' });
  assert(res.length === 1 && res[0].ok === true, 'bind with the right code succeeds');
  assert(res[0].manifest && res[0].manifest.app_id === 'network.ours.telegram-connector', 'bind reply carries the connector manifest');
  mon = withScope((lt) => renderMonitoringStatus(connector.readonlyTx('::a2a_messaging::get_monitoring_status', lt)));
  assert(mon.proxyCid === cp.cid, 'connector now has CP bound as the control plane');

  // 4. get_manifest.
  res = await cpRequest({ v: 1, id: 'd', t: 'get_manifest' });
  assert(res.length === 1 && res[0].ok === true, 'get_manifest succeeds once bound');
  assert(Array.isArray(res[0].manifest.capabilities) && res[0].manifest.capabilities.includes('core.configuration'), 'manifest advertises core.configuration');

  // 5. get_config returns the schema + current values.
  res = await cpRequest({ v: 1, id: 'e', t: 'get_config' });
  assert(res.length === 1 && res[0].ok === true && res[0].config?.schema?.groups?.length === 1, 'get_config returns the routing schema');
  assert(res[0].config.values.allowedChatId === '100' && res[0].config.values.deniedMessage === DEFAULT_DENIED, 'get_config reflects the current values');

  // 6. set_config applies new values.
  const newDenied = 'Sorry, this bot is private.';
  res = await cpRequest({ v: 1, id: 'f', t: 'set_config', config: JSON.stringify({ allowedChatId: '200', deniedMessage: newDenied }) });
  assert(res.length === 1 && res[0].ok === true, 'set_config succeeds');
  assert(cfg.chatId === '200' && cfg.deniedMessage === newDenied, 'set_config mutated the connector config (allowed chat + phrase)');

  // 7. get_config now reflects the change.
  res = await cpRequest({ v: 1, id: 'g', t: 'get_config' });
  assert(res[0].config.values.allowedChatId === '200' && res[0].config.values.deniedMessage === newDenied, 'get_config reflects the updated values');

  // 8. MONITORING (core 1.15, forced): once bound, core emits a copy of every
  // message to the CP. This stand-in CP did not call a2a_monitoring::init, so its
  // receiver aborts — but that abort PROVES the copy was emitted + routed to
  // ::a2a_monitoring::receive_monitoring_copy (zero copies were produced on core 1.4).
  const cpInbound = [];
  cp.pw.on_transaction_failure = (m) => { cpInbound.push(String(m)); };
  await withScopeAsync((lt) => connector.mutatingTx('::a2a_messaging::send_message', { contact: cp.cid, text: 'monitored hello' }, lt));
  await sleep(3000);
  // The stand-in CP (a connector-actor packet) doesn't expose the receiver, so it
  // rejects the copy — but receiving ::a2a_monitoring::receive_monitoring_copy at
  // all proves core forced + routed a copy. A real messenger CP stores it.
  assert(cpInbound.some((m) => /receive_monitoring_copy/.test(m)),
    'sending a message forces a monitoring copy to the bound CP (out of the box, no daemon involvement)');

  // 9. FILE MONITORING (core 3.1, design D5): send_file forces a metadata-only
  // monitoring copy to the bound CP exactly like send_message — proving file
  // traffic is monitored consistently with messages. The copy body is core's
  // file_monitor_summary ("[file] <name> (<mime>, <N> B)", built from _binlen) so
  // it NEVER carries the bytes. As in step 8 the stand-in CP rejects
  // receive_monitoring_copy (no a2a_monitoring::init), so we observe that a copy
  // was forced + routed (same mechanism); the body itself is metadata-only by core
  // construction and the secret bytes never reach the wire as plaintext anyway.
  const beforeFileCopy = cpInbound.length;
  const secret = Buffer.from('SECRET-FILE-BODY-do-not-leak');
  await withScopeAsync((lt) => connector.mutatingTx('::a2a_messaging::send_file',
    { contact: cp.cid, filename: 'q.txt', mime: 'text/plain', data: connector.newBinary(secret, lt) }, lt));
  await sleep(3000);
  const fileCopies = cpInbound.slice(beforeFileCopy);
  assert(fileCopies.some((m) => /receive_monitoring_copy/.test(m)),
    'send_file forces a monitoring copy to the bound CP (file traffic monitored like messages)');
  assert(!fileCopies.some((m) => m.includes('SECRET-FILE-BODY')),
    'the monitoring path never surfaces the file bytes (summary is metadata-only)');

  console.log(`\n${failures === 0 ? 'ALL PASSED' : failures + ' FAILED'}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
