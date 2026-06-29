#!/usr/bin/env node
// E2E round-trip over a local broker, driving the connector's own adapt.ts layer.
// One AdaptHost, two packets: "Connector" (the bot side) and "Proxy" (the ours
// node a human would paste the invite into). Validates exactly the transactions
// connector.ts relies on: set_my_name, generate_invite, add_contact, send_message,
// get_messages, the message_received notify, and export/import_state.
//
// Prereq: broker on ws://localhost:9000 (ours-mcp/scripts/dev-broker.mjs).
// Run:    OURS_TG_UNIT_DIR=./mufl_code node_modules/.bin/tsx test-roundtrip.mjs

import { AdaptHost, wireHandlers, packInvite, unpackInvite, renderInbox, renderContacts, withScope, withScopeAsync } from './src/adapt.ts';

const BROKER = process.env.OURS_TG_BROKER_URL ?? 'ws://localhost:9000';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function assert(cond, msg) {
  if (cond) console.log(`  ✓ ${msg}`);
  else { console.log(`  ✗ ${msg}`); failures++; }
}
const log = (...p) => { if (process.env.VERBOSE) process.stderr.write(`[host] ${p.join(' ')}\n`); };

// Minimal notify recorder: collect message_received + contact_accepted per packet.
function attach(pkt) {
  const recv = [];
  let peerCid = '';
  wireHandlers(pkt, {
    onSaveState: () => {},
    onNotify: (event, payload) => {
      if (event === 'message_received') recv.push(payload.Reduce('msg_id').Visualize());
      else if (event === 'contact_accepted' || event === 'sibling_contact_added') peerCid = payload.Reduce('container_id').Visualize();
    },
  }, log);
  return { recv, getPeer: () => peerCid };
}

async function drain(pkt) {
  return withScopeAsync(async (lt) => renderInbox((await pkt.mutatingTx('::actor::get_messages', {}, lt)).Reduce('messages')));
}

async function main() {
  console.log('=== ours-tg-connector round-trip e2e ===\n');
  const host = new AdaptHost(BROKER, log);
  await host.boot();

  const connector = await host.createPacket('Connector', 'seed-connector-' + Date.now());
  const proxy = await host.createPacket('Proxy', 'seed-proxy-' + Date.now());
  const connState = attach(connector);
  const proxyState = attach(proxy);

  await withScopeAsync((lt) => connector.mutatingTx('::a2a_messaging::set_my_name', { name: 'Connector' }, lt));
  await withScopeAsync((lt) => proxy.mutatingTx('::a2a_messaging::set_my_name', { name: 'Proxy' }, lt));
  assert(true, 'both packets created + named');

  // Connector mints an invite (what add_new_connection prints), packed exactly
  // as the CLI packs it; the proxy unpacks + redeems it.
  const blob = await withScopeAsync(async (lt) =>
    packInvite(Buffer.from((await connector.mutatingTx('::a2a_messaging::generate_invite', {}, lt)).Reduce('invite').GetBinary())));
  assert(blob.length > 0, `invite generated + packed (${blob.length} b64 chars)`);
  const raw = unpackInvite(blob);
  assert(raw.length > 0, 'invite unpacks (format round-trips)');

  await withScopeAsync((lt) => proxy.mutatingTx('::a2a_messaging::add_contact', { invite: proxy.newBinary(raw, lt) }, lt));
  console.log('  waiting 6s for handshake + accept round trip…');
  await sleep(6000);

  const connContacts = withScope((lt) => renderContacts(connector.readonlyTx('::a2a_messaging::list_contacts', lt)));
  // core 3.0 (slim ephemeral invite, responder-first disclosure): the inviter
  // registers the responder on the leg-2 boxed redeem but no longer learns its
  // self-asserted display name — the contact is keyed/named by cid. The connector
  // routes purely by cid (peerCid), so cid-registration is what matters here.
  assert(connContacts.some((c) => c.container_id === proxy.cid), 'connector registered the proxy contact by cid (leg-2 boxed redeem)');
  assert(connState.getPeer() !== '', `connector captured peer cid via contact_accepted (${connState.getPeer().slice(0, 12)}…)`);

  // Telegram → node: connector sends to the proxy.
  await withScopeAsync((lt) => connector.mutatingTx('::a2a_messaging::send_message', { contact: proxy.cid, text: 'tg->node hello' }, lt));
  await sleep(3000);
  assert(proxyState.recv.length >= 1, 'proxy got a message_received notify (tg->node)');
  const proxyMsgs = await drain(proxy);
  assert(proxyMsgs.some((m) => m.text === 'tg->node hello'), 'proxy get_messages surfaces the forwarded telegram text');

  // node → Telegram: proxy sends back; connector pulls it to hand to Telegram.
  await withScopeAsync((lt) => proxy.mutatingTx('::a2a_messaging::send_message', { contact: connector.cid, text: 'node->tg reply' }, lt));
  await sleep(3000);
  assert(connState.recv.length >= 1, 'connector got a message_received notify (node->tg)');
  const connMsgs = await drain(connector);
  assert(connMsgs.some((m) => m.text === 'node->tg reply'), 'connector get_messages surfaces the node reply (would be sent to Telegram)');

  // Persistence: export the connector state and re-import into a fresh packet
  // (mirrors restoreConnection across a daemon restart).
  const bytes = withScope((lt) => Buffer.from(connector.readonlyTx('::actor::export_state', lt).Serialize()));
  const reborn = await host.createPacket('Connector2', 'seed-connector2-' + Date.now());
  attach(reborn);
  await withScopeAsync(async (lt) => {
    const parsed = reborn.pw.packet.ParseValue(new Uint8Array(bytes)).Attach(lt);
    await reborn.mutatingTx('::actor::import_state', parsed, lt);
  });
  const rebornContacts = withScope((lt) => renderContacts(reborn.readonlyTx('::a2a_messaging::list_contacts', lt)));
  assert(rebornContacts.some((c) => c.container_id === proxy.cid), 'state export/import preserves the proxy contact by cid (restart-safe)');

  console.log(`\n${failures === 0 ? 'ALL PASSED' : failures + ' FAILED'}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
