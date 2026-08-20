#!/usr/bin/env node
// Packet-level integration test for reply threading + core 0.7.0 receipts, using
// the same harness as migration.test.mjs: two connector packets inside ONE
// AdaptHost, relayed in-process by the native wrapper (no external broker).
//
// Both packets run THIS repo's actor.mu, so both advertise core.receipts.emit and
// core.receipts.receive — which is exactly what receipt_gate
// (mufl_code/core/a2a_messaging.mm:1408) requires before a single receipt moves.
// That makes the full loop observable here:
//
//   A → B message (wire_id W)                     ... the Telegram-inbound leg
//   B's receive path emits "delivered" [W]  → A's receipt_received notify
//   B's get_messages emits "read"      [W]  → A's receipt_received notify
//   B replies with reply_to = W              → A sees the reply pointer
//
// The daemon turns those two notifies into the 👀 / 👌 reactions and the reply
// pointer into reply_parameters.message_id; that half is unit-tested in
// tests/receipts.test.mjs. What this file proves is that the packet actually
// produces them.
//
// Run: OURS_TG_UNIT_DIR=./mufl_code node_modules/.bin/tsx tests/replies-receipts.test.mjs

import { AdaptHost, wireHandlers, packInvite, unpackInvite, renderInbox, renderReceipt, withScope, withScopeAsync } from '../src/adapt.ts';

const BROKER = process.env.OURS_TG_BROKER_URL ?? 'ws://localhost:9000';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...p) => { if (process.env.VERBOSE) process.stderr.write(`[test] ${p.join(' ')}\n`); };

let failures = 0;
function assert(cond, msg) {
  if (cond) console.log(`  ✓ ${msg}`);
  else { console.log(`  ✗ ${msg}`); failures++; }
}
function eq(actual, expected, msg) {
  assert(actual === expected, `${msg}${actual === expected ? '' : ` — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`);
}

function manifestCaps(pkt) {
  return withScope((lt) => {
    const caps = pkt.readonlyTx('::a2a_capabilities::get_manifest', lt).Reduce('capabilities');
    return caps.IsNil() ? [] : caps.GetKeys().map((k) => k.Visualize());
  });
}

// Send a message, optionally as a reply to a wire_id. Returns the new wire_id.
async function send(pkt, contactCid, text, replyToWireId) {
  return withScopeAsync(async (lt) => {
    const targ = { contact: contactCid, text, ...(replyToWireId ? { reply_to: { wire_id: replyToWireId } } : {}) };
    const r = await pkt.mutatingTx('::a2a_messaging::send_message', targ, lt);
    return String(r.Reduce('wire_id').Visualize());
  });
}

async function getMessages(pkt) {
  return withScopeAsync(async (lt) => renderInbox((await pkt.mutatingTx('::actor::get_messages', {}, lt)).Reduce('messages')));
}

// Poll until `probe` returns something truthy, or give up.
async function until(probe, tries = 20, waitMs = 500) {
  for (let i = 0; i < tries; i += 1) {
    const v = probe();
    if (v) return v;
    await sleep(waitMs);
  }
  return null;
}

async function main() {
  console.log('=== connector reply threading + core 0.7.0 receipts ===\n');
  const host = new AdaptHost(BROKER, log);
  await host.boot();

  const a = await host.createPacket('A', 'seed-A-' + Date.now());
  const b = await host.createPacket('B', 'seed-B-' + Date.now());

  // Collect every receipt_received notify, decoded exactly the way the daemon
  // decodes it (renderReceipt) — so a payload the host cannot read is a failure
  // here rather than a silent no-op in production.
  const receipts = { a: [], b: [] };
  const inboxNotify = { a: 0, b: 0 };
  const capture = (who) => (event, payload) => {
    if (event === 'receipt_received') {
      const ev = renderReceipt(payload);
      if (ev) receipts[who].push(ev);
      else { console.log('  ✗ receipt_received payload could not be decoded'); failures += 1; }
    } else if (event === 'message_received') {
      inboxNotify[who] += 1;
    }
  };
  wireHandlers(a, { onSaveState: () => {}, onNotify: capture('a') }, log);
  wireHandlers(b, { onSaveState: () => {}, onNotify: capture('b') }, log);
  await withScopeAsync((lt) => a.mutatingTx('::a2a_messaging::set_my_name', { name: 'A' }, lt));
  await withScopeAsync((lt) => b.mutatingTx('::a2a_messaging::set_my_name', { name: 'B' }, lt));

  // ---- the caps that open the gate ------------------------------------------
  console.log('-- capabilities --');
  const caps = manifestCaps(a);
  assert(caps.includes('core.receipts.emit'), 'the manifest advertises core.receipts.emit (required before we may emit any receipt)');
  assert(caps.includes('core.receipts.receive'), 'the manifest advertises core.receipts.receive (required before a peer sends us any)');
  assert(caps.includes('core.e2e') && caps.includes('core.e2e.migrate'), 'the pre-existing e2e caps are untouched');

  // ---- pair ------------------------------------------------------------------
  console.log('\n-- pairing --');
  const blob = await withScopeAsync(async (lt) =>
    packInvite(Buffer.from((await a.mutatingTx('::a2a_messaging::generate_invite', {}, lt)).Reduce('invite').GetBinary())));
  const raw = unpackInvite(blob);
  await withScopeAsync((lt) => b.mutatingTx('::a2a_messaging::add_contact', { invite: b.newBinary(raw, lt) }, lt));
  await sleep(6000);
  const contacted = await until(() => inboxNotify.b >= 0 && withScope((lt) => !b.readonlyTx('::a2a_messaging::list_contacts', lt).IsNil()));
  assert(contacted !== null, 'the two packets are contacts');

  // ---- A → B: the Telegram-inbound leg --------------------------------------
  console.log('\n-- A→B message: DELIVERED receipt on B\'s receive path --');
  const wireId = await send(a, b.cid, 'hello from the telegram side');
  assert(wireId.length > 0, `send_message returns the wire_id the map is keyed by (${wireId.slice(0, 12)}…)`);

  const delivered = await until(() => receipts.a.find((r) => r.kind === 'delivered' && r.wireIds.includes(wireId)));
  assert(delivered !== null, 'A receives a "delivered" receipt naming that exact wire_id');
  if (delivered) {
    eq(delivered.senderId, b.cid, 'the receipt is attributed to the peer that received the message');
    eq(delivered.wireIds.length, 1, 'the receipt covers the one message');
  }
  assert(!receipts.a.some((r) => r.kind === 'read'), 'no "read" receipt yet — B has not called get_messages');

  // ---- B's get path: the READ receipt ---------------------------------------
  console.log('\n-- B get_messages: READ receipt on the consumer path --');
  const fresh = await getMessages(b);
  eq(fresh.length, 1, 'B drains exactly the one message');
  eq(fresh[0].wire_id, wireId, 'the drained message carries the sender-stamped wire_id');
  eq(fresh[0].reply_to, undefined, 'a non-reply has no reply pointer');

  const read = await until(() => receipts.a.find((r) => r.kind === 'read' && r.wireIds.includes(wireId)));
  assert(read !== null, 'A receives a "read" receipt for the same wire_id after B\'s get_messages');

  // Exact-once: the read event IS the unread→processed transition, so a second
  // get_messages has nothing to confirm and must emit nothing.
  const readsBefore = receipts.a.filter((r) => r.kind === 'read').length;
  eq((await getMessages(b)).length, 0, 'a second get_messages drains nothing');
  await sleep(2000);
  eq(receipts.a.filter((r) => r.kind === 'read').length, readsBefore, 'and emits no second read receipt (exact-once)');

  // ---- B → A: the reply pointer ---------------------------------------------
  console.log('\n-- B→A reply: the pointer the Telegram thread is built from --');
  await send(b, a.cid, 'answering that', wireId);
  const replies = await until(async () => null, 1, 1500); // let the leg relay
  const aInbox = await getMessages(a);
  eq(aInbox.length, 1, 'A drains the reply');
  assert(aInbox[0].reply_to !== undefined, 'the reply carries a reply pointer');
  if (aInbox[0].reply_to) {
    eq(aInbox[0].reply_to.wire_id, wireId, 'the pointer names the ORIGINAL wire_id — what the map resolves to a Telegram message_id');
  }
  void replies;

  // A plain (non-reply) message must stay pointer-free, so the daemon never
  // invents a thread for it.
  await send(b, a.cid, 'unrelated follow-up');
  await sleep(1500);
  const plain = await getMessages(a);
  eq(plain.length, 1, 'A drains the follow-up');
  eq(plain[0].reply_to, undefined, 'a non-reply stays pointer-free (no guessed thread)');

  console.log(`\n${failures === 0 ? 'ALL PASSED' : failures + ' FAILED'}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
