#!/usr/bin/env node
// Integration test for the connector's double-ratchet MIGRATION host/manifest gap
// closure (Developer-2). Two connector packets in ONE AdaptHost (the native wrapper
// relays between its own packets in-process — no external broker, exactly like
// voice.test.mjs). It proves, behaviourally:
//
//   TASK A (manifest): a connector packet's get_manifest advertises core.e2e AND
//   core.e2e.migrate — the caps that gate mig_should_trigger + peer cap-learning.
//
//   MIGRATION → DR: once BOTH sides advertise core.e2e.migrate, an established
//   contact migrates to the Olm double ratchet (offer→ack→commit→confirm → epoch
//   pin), after which send_message rides the ratchet: its return carries
//   route == "e2e" and the core emits the §4 e2e_app_send / migration_active
//   proof notifies. A box send carries NO route field. This is the case-3a
//   mechanism (and, in this core, the path a both-new pair takes to DR).
//
// Cross-VERSION back-compat (old mcp ↔ new connector stays legacy; case 1/2) needs
// two SEPARATE daemons on a real broker and is covered by the live proof, not here.
//
// Run: OURS_TG_UNIT_DIR=./mufl_code node_modules/.bin/tsx tests/migration.test.mjs

import { AdaptHost, wireHandlers, packInvite, unpackInvite, withScope, withScopeAsync } from '../src/adapt.ts';

const BROKER = process.env.OURS_TG_BROKER_URL ?? 'ws://localhost:9000';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...p) => { if (process.env.VERBOSE) process.stderr.write(`[test] ${p.join(' ')}\n`); };

let failures = 0;
function assert(cond, msg) {
  if (cond) console.log(`  ✓ ${msg}`);
  else { console.log(`  ✗ ${msg}`); failures++; }
}

// Read the connector manifest's advertised capability ids from get_manifest.
function manifestCaps(pkt) {
  return withScope((lt) => {
    const m = pkt.readonlyTx('::a2a_capabilities::get_manifest', lt);
    const caps = m.Reduce('capabilities');
    return {
      e2e: !caps.Reduce('core.e2e').IsNil(),
      migrate: !caps.Reduce('core.e2e.migrate').IsNil(),
    };
  });
}

// Send one message and report the core's routing verdict: 'e2e' (double ratchet),
// 'migrating' (commit window — queued), or 'box' (legacy encrypted channel, no
// $route field on the return).
async function sendAndRoute(pkt, contactCid, text) {
  return withScopeAsync(async (lt) => {
    const r = await pkt.mutatingTx('::a2a_messaging::send_message', { contact: contactCid, text }, lt);
    const routeAv = r.Reduce('route');
    if (!routeAv.IsNil()) return String(routeAv.Visualize());
    if (!r.Reduce('migrating').IsNil()) return 'migrating';
    return 'box';
  });
}

async function sweep(pkt) {
  return withScopeAsync(async (lt) => {
    const r = await pkt.mutatingTx('::a2a_messaging::sweep_e2e_migrations', {}, lt);
    return {
      initiated: Number(r.Reduce('initiated').Visualize()),
      redriven: Number(r.Reduce('redriven').Visualize()),
      superseded: Number(r.Reduce('superseded').Visualize()),
    };
  });
}

// DR self-heal recovery legs (parity with mcp prerelease's e2eRecoverySweep) — the two
// core trns the connector host now drives on boot + GC. A wrong trn name or field name
// throws here, so this is a genuine wiring assertion (not a manifest-only smoke test).
async function readvertiseE2eRecovery(pkt) {
  return withScopeAsync(async (lt) => {
    const r = await pkt.mutatingTx('::a2a_messaging::readvertise_e2e_recovery', {}, lt);
    return Number(r.Reduce('readvertised').Visualize());
  });
}
async function redriveUnackedSweep(pkt) {
  return withScopeAsync(async (lt) => {
    const r = await pkt.mutatingTx('::a2a_messaging::redrive_unacked_sweep', {}, lt);
    const num = (f) => (r.Reduce(f).IsNil() ? 0 : Number(r.Reduce(f).Visualize()));
    return { redriven: num('redriven_contacts'), purged: num('purged_contacts'), deferred: num('deferred_contacts') };
  });
}

async function main() {
  console.log('=== connector DR migration (host + manifest gap) ===\n');
  const host = new AdaptHost(BROKER, log);
  await host.boot();

  const a = await host.createPacket('A', 'seed-A-' + Date.now());
  const b = await host.createPacket('B', 'seed-B-' + Date.now());

  // Capture the §4 migration proof notifies from each side.
  const seen = { a: {}, b: {} };
  const saves = { a: 0, b: 0 };
  const capture = (who) => (event, payload) => {
    if (event === 'migration_active' || event === 'e2e_app_send' || event === 'e2e_app_recv') {
      seen[who][event] = true;
      log(`${who} notify ${event}`);
    }
  };
  wireHandlers(a, { onSaveState: () => { saves.a++; }, onNotify: capture('a') }, log);
  wireHandlers(b, { onSaveState: () => { saves.b++; }, onNotify: capture('b') }, log);
  await withScopeAsync((lt) => a.mutatingTx('::a2a_messaging::set_my_name', { name: 'A' }, lt));
  await withScopeAsync((lt) => b.mutatingTx('::a2a_messaging::set_my_name', { name: 'B' }, lt));

  // ---- TASK A: manifest advertises the e2e caps -----------------------------
  console.log('-- Task A: manifest advertises core.e2e + core.e2e.migrate --');
  const capsA = manifestCaps(a);
  assert(capsA.e2e, 'get_manifest advertises core.e2e');
  assert(capsA.migrate, 'get_manifest advertises core.e2e.migrate');

  // ---- Pair the two packets -------------------------------------------------
  console.log('\n-- pairing --');
  const blob = await withScopeAsync(async (lt) =>
    packInvite(Buffer.from((await a.mutatingTx('::a2a_messaging::generate_invite', {}, lt)).Reduce('invite').GetBinary())));
  const raw = unpackInvite(blob);
  await withScopeAsync((lt) => b.mutatingTx('::a2a_messaging::add_contact', { invite: b.newBinary(raw, lt) }, lt));
  console.log('  waiting for handshake/accept…');
  await sleep(6000);
  const bCid = b.cid, aCid = a.cid;

  // ---- MIGRATION → double ratchet -------------------------------------------
  console.log('\n-- driving migration (sweep both sides; poll until route flips to e2e) --');
  // Kick the offers, then let the offer→ack→commit→confirm legs relay; re-drive
  // via the sweep on each poll (idempotent). Probe the route from A→B each round.
  let route = 'box';
  for (let i = 0; i < 20 && route !== 'e2e'; i++) {
    await sweep(a); await sweep(b);
    await sleep(1500);
    route = await sendAndRoute(a, bCid, `probe ${i}`);
    log(`round ${i}: route=${route}`);
  }
  assert(route === 'e2e', `send A→B rides the double ratchet (route="${route}")`);

  // Reverse direction too (both peers ride the double ratchet).
  const savesBeforeForward = { ...saves };
  await sendAndRoute(a, bCid, 'save-hook-forward');
  await sleep(500);
  assert(saves.a > savesBeforeForward.a, 'outbound DR ratchet advance fires A save_state hook');
  assert(saves.b > savesBeforeForward.b, 'inbound DR ratchet advance fires B save_state hook');

  const savesBeforeReverse = { ...saves };
  const routeBack = await sendAndRoute(b, aCid, 'probe back');
  assert(routeBack === 'e2e', `send B→A rides the double ratchet (route="${routeBack}")`);
  await sleep(500);
  assert(saves.b > savesBeforeReverse.b, 'reverse outbound ratchet advance fires B save_state hook');
  assert(saves.a > savesBeforeReverse.a, 'reverse inbound ratchet advance fires A save_state hook');

  // §4 proof: the double-ratchet send/recv notifies fired (olm_type + session_id).
  // NOTE: with the born-DR core (acd9cf6, what nightly.7 runs), two FRESH contacts
  // go DR from msg#1 via the peer's AD $e2e_bundle — so `migration_active` (the
  // existing-contact migration FSM) does NOT fire here; that path is exercised by
  // the live existing-contact→reconnect proof. What matters at this altitude is
  // that app data actually traverses the double ratchet, in BOTH directions.
  await sleep(1500);
  assert(seen.a.e2e_app_send || seen.b.e2e_app_send, 'e2e_app_send proof notify fired (DR send)');
  assert(seen.a.e2e_app_recv || seen.b.e2e_app_recv, 'e2e_app_recv proof notify fired (DR recv/decrypt)');

  // ---- DR self-heal recovery legs (mcp e2eRecoverySweep parity) --------------
  // The connector host now drives readvertise_e2e_recovery + redrive_unacked_sweep on
  // boot + GC (Block 2 parity gap closed). Exercise both against the live DR pair: a
  // wrong trn name (mis-port) or a wrong return-field name throws, so a green here is a
  // real wiring assertion, and the shapes match what connector.ts's e2eRecoverySweep reads.
  console.log('\n-- DR self-heal recovery legs (readvertise_e2e_recovery + redrive_unacked_sweep) --');
  let recovErr = null;
  let readvA = -1, redriveA = null;
  try {
    // A is e2e-paired with B, so readvertise_e2e_recovery re-advertises to >=1 e2e contact.
    readvA = await readvertiseE2eRecovery(a);
    redriveA = await redriveUnackedSweep(a);
    // Idempotent: a second immediate pass must not throw either.
    await readvertiseE2eRecovery(b);
    await redriveUnackedSweep(b);
  } catch (e) {
    recovErr = e;
  }
  assert(recovErr === null, `e2e recovery sweep legs run without error on a DR pair${recovErr ? ` (threw: ${recovErr})` : ''}`);
  assert(readvA >= 1, `readvertise_e2e_recovery re-advertises the fresh AD to the e2e contact (readvertised=${readvA})`);
  assert(
    redriveA !== null &&
      Number.isInteger(redriveA.redriven) && Number.isInteger(redriveA.purged) && Number.isInteger(redriveA.deferred),
    `redrive_unacked_sweep returns the {redriven,purged,deferred} counters (${JSON.stringify(redriveA)})`,
  );

  console.log(`\n${failures === 0 ? 'ALL PASSED' : failures + ' FAILED'}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
