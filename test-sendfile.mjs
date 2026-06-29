#!/usr/bin/env node
// Live e2e for core-3.1 file transfer through the connector packet. Mirrors
// test-roundtrip.mjs: one AdaptHost, two packets that become contacts, then
// send_file one way and assert the receiver's on_file_received deposited the
// bytes. The file SENDER is the inviter and the receiver redeems — the proven
// inviter→redeemer direction from test-roundtrip (channels are bidirectional).
//
// Prereq: broker on ws://localhost:9000 (ours-mcp/scripts/dev-broker.mjs).
// Run: OURS_TG_UNIT_DIR=./mufl_code node_modules/.bin/tsx test-sendfile.mjs

import { AdaptHost, wireHandlers, packInvite, unpackInvite, renderFiles, withScope, withScopeAsync } from './src/adapt.ts';

const BROKER = process.env.OURS_TG_BROKER_URL ?? 'ws://localhost:9000';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function assert(cond, msg) {
  if (cond) console.log(`  ✓ ${msg}`);
  else { console.log(`  ✗ ${msg}`); failures++; }
}
const log = (...p) => { if (process.env.VERBOSE) process.stderr.write(`[host] ${p.join(' ')}\n`); };

async function main() {
  console.log('=== ours-tg-connector send_file e2e ===\n');
  const host = new AdaptHost(BROKER, log);
  await host.boot();

  const sender = await host.createPacket('Sender', 'seed-sender-' + Date.now());
  const receiver = await host.createPacket('Receiver', 'seed-receiver-' + Date.now());
  let receiverNotifiedFile = false;
  wireHandlers(receiver, { onSaveState: () => {}, onNotify: (e) => { if (e === 'file_received') receiverNotifiedFile = true; } }, log);
  wireHandlers(sender, { onSaveState: () => {}, onNotify: () => {} }, log);

  await withScopeAsync((lt) => sender.mutatingTx('::a2a_messaging::set_my_name', { name: 'Sender' }, lt));
  await withScopeAsync((lt) => receiver.mutatingTx('::a2a_messaging::set_my_name', { name: 'Receiver' }, lt));

  // Become contacts (inviter→redeemer, like test-roundtrip): the sender invites,
  // the receiver redeems. After the leg-2 boxed redeem the sender has the receiver
  // registered by cid, so send_file can target receiver.cid directly.
  const blob = await withScopeAsync(async (lt) =>
    packInvite(Buffer.from((await sender.mutatingTx('::a2a_messaging::generate_invite', {}, lt)).Reduce('invite').GetBinary())));
  const raw = unpackInvite(blob);
  await withScopeAsync((lt) => receiver.mutatingTx('::a2a_messaging::add_contact', { invite: receiver.newBinary(raw, lt) }, lt));
  console.log('  waiting 6s for handshake + accept round trip…');
  await sleep(6000);

  // send_file: sender → receiver.
  const bytes = Buffer.from('THE-FILE-BYTES-✓-0123456789');
  await withScopeAsync((lt) => sender.mutatingTx('::a2a_messaging::send_file',
    { contact: receiver.cid, filename: 'report.txt', mime: 'text/plain', data: sender.newBinary(bytes, lt) }, lt));
  await sleep(3000); // let delivery settle

  const files = withScope((lt) => renderFiles(receiver.readonlyTx('::actor::list_incoming_files', lt)));
  assert(files.length === 1, `expected 1 incoming file, got ${files.length}`);
  assert(files[0]?.filename === 'report.txt', 'filename preserved');
  assert(files[0]?.mime === 'text/plain', 'mime preserved');
  assert(files[0]?.bytes.equals(bytes), 'file bytes intact across the wire');
  assert(files[0]?.wire_id.length > 0, 'wire_id stamped');
  assert(receiverNotifiedFile, 'file_received notify fired');

  // --- egress: get_files drains unread with bytes intact ---
  const drained = await withScopeAsync(async (lt) =>
    renderFiles((await receiver.mutatingTx('::actor::get_files', {}, lt)).Reduce('files')));
  assert(drained.length === 1 && drained[0]?.bytes.equals(bytes), 'get_files returns the file with bytes');
  // second drain is empty (status flipped to processed)
  const again = await withScopeAsync(async (lt) =>
    renderFiles((await receiver.mutatingTx('::actor::get_files', {}, lt)).Reduce('files')));
  assert(again.length === 0, 'get_files is exactly-once');
  // --- defer puts it back to unread ---
  await withScopeAsync((lt) => receiver.mutatingTx('::actor::defer_files', { file_ids: [drained[0].file_id] }, lt));
  const redrawn = await withScopeAsync(async (lt) =>
    renderFiles((await receiver.mutatingTx('::actor::get_files', {}, lt)).Reduce('files')));
  assert(redrawn.length === 1, 'defer_files re-queues the file');

  // --- persistence: export then import into a fresh packet preserves the file ---
  // Mirrors test-roundtrip's restart: Serialize -> bytes -> ParseValue -> import_state
  // into a fresh-seed packet (the file_inbox content is what matters, not the cid).
  const exported = withScope((lt) => Buffer.from(receiver.readonlyTx('::actor::export_state', lt).Serialize()));
  const receiver2 = await host.createPacket('Receiver2', 'seed-receiver2-' + Date.now());
  wireHandlers(receiver2, { onSaveState: () => {}, onNotify: () => {} }, log);
  await withScopeAsync(async (lt) => {
    const parsed = receiver2.pw.packet.ParseValue(new Uint8Array(exported)).Attach(lt);
    await receiver2.mutatingTx('::actor::import_state', parsed, lt);
  });
  const survived = withScope((lt) => renderFiles(receiver2.readonlyTx('::actor::list_incoming_files', lt)));
  assert(survived.length === 1 && survived[0]?.bytes.equals(bytes), 'file store survives export/import');

  // --- unknown-sender rejection (design D7) ---
  // A packet that is NOT a contact of the receiver cannot get a file deposited.
  // send_file resolves the contact on the SENDER side first: a stranger with no
  // channel/contact to the receiver aborts in resolve_contact, so nothing slips
  // through. (The receiver's on_file_received also aborts a NIL-name sender — the
  // second guard — but that path is unreachable without an established channel.)
  const stranger = await host.createPacket('Stranger', 'seed-stranger-' + Date.now());
  wireHandlers(stranger, { onSaveState: () => {}, onNotify: () => {} }, log);
  const before = withScope((lt) => renderFiles(receiver.readonlyTx('::actor::list_incoming_files', lt))).length;
  try {
    await withScopeAsync((lt) => stranger.mutatingTx('::a2a_messaging::send_file',
      { contact: 'nonexistent', filename: 'x', mime: '', data: stranger.newBinary(Buffer.from('x'), lt) }, lt));
  } catch { /* expected: resolve_contact aborts on a non-contact */ }
  await sleep(500);
  const after = withScope((lt) => renderFiles(receiver.readonlyTx('::actor::list_incoming_files', lt))).length;
  assert(after === before, 'no file deposited from a non-contact');

  console.log(`\n${failures === 0 ? 'ALL PASSED' : failures + ' FAILED'}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
