// Cross-version live migration proof coordinator. Spawns TWO worker processes
// (separate native wrappers → real broker wss://broker1.ours.network), one per
// "daemon", and drives the 3 migration cases, capturing crypto-envelope evidence.
import { spawn } from 'node:child_process';
import readline from 'node:readline';

const OLD_UNIT = '/tmp/dev2-old-unit';   // 7518511B — does NOT advertise core.e2e.migrate (pre-DR-manifest)
const NEW_UNIT = '/tmp/dev2-new-unit';   // BD0FABB9 — my build: advertises core.e2e + core.e2e.migrate
const WORKER = '/tmp/dev2-proof/worker.mjs';
const TSX = '/home/fleet/work/dev2-migration-gap/node_modules/.bin/tsx';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startWorker(name, unitDir) {
  const cp = spawn(TSX, [WORKER], { env: { ...process.env, PROOF_NAME: name, OURS_TG_UNIT_DIR: unitDir }, stdio: ['pipe', 'pipe', 'inherit'] });
  const waiters = new Map();
  let ready = null; const readyP = new Promise((res) => { ready = res; });
  const rl = readline.createInterface({ input: cp.stdout });
  rl.on('line', (line) => {
    let m; try { m = JSON.parse(line); } catch { return; }
    if (m.ready) { ready(m); return; }
    if (m.id && waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id); }
  });
  let seq = 0;
  const call = (cmd, extra = {}) => new Promise((res) => { const id = ++seq; waiters.set(id, res); cp.stdin.write(JSON.stringify({ id, cmd, ...extra }) + '\n'); });
  return { name, cp, readyP, call, kill: () => { try { cp.kill('SIGKILL'); } catch {} } };
}

async function pair(a, b) {
  // a invites, b redeems → they become contacts; b can then send to a and vice-versa.
  const { invite } = await a.call('invite');
  await b.call('add', { invite });
  // real-broker handshake + accept round trip
  for (let i = 0; i < 20; i++) { await sleep(2000); const c = await b.call('contacts'); if (c.count > 0) break; }
}

// Drive migration to completion: sweep both, poll the A→B route until e2e (or give up).
async function driveMigration(a, b, rounds = 25) {
  let route = 'box';
  for (let i = 0; i < rounds && route !== 'e2e'; i++) {
    await a.call('sweep'); await b.call('sweep');
    await sleep(1500);
    route = (await a.call('send', { text: `probe-${i}` })).route;
  }
  return route;
}

const evidence = {};

async function scenario1() {
  console.log('\n===== S1 — Case 2: mixed OLD <-> NEW stays LEGACY BOX =====');
  const O = startWorker('O_old', OLD_UNIT); const N = startWorker('N_new', NEW_UNIT);
  const ro = await O.readyP; const rn = await N.readyP;
  console.log(`  O(old) unit=${ro.unit.slice(0,12)} cid=${ro.cid.slice(0,12)}`);
  console.log(`  N(new) unit=${rn.unit.slice(0,12)} cid=${rn.cid.slice(0,12)}`);
  await pair(O, N);
  await N.call('notifies'); await O.call('notifies'); // clear
  const rNO = (await N.call('send', { text: 'hello from new to old' })).route;
  const rON = (await O.call('send', { text: 'hello from old to new' })).route;
  await sleep(3000);
  const drainedAtO = await O.call('drain'); const drainedAtN = await N.call('drain');
  const nEv = (await N.call('notifies')).notifies; const oEv = (await O.call('notifies')).notifies;
  evidence.S1_case2_mixed = {
    route_new_to_old: rNO, route_old_to_new: rON,
    old_received: drainedAtO.messages, new_received: drainedAtN.messages,
    e2e_notifies: [...nEv, ...oEv].filter((e) => e.event.startsWith('e2e_') || e.event === 'migration_active'),
  };
  console.log(`  route N->O=${rNO}  O->N=${rON}  (expect box/box)`);
  console.log(`  delivered: O got ${drainedAtO.messages.length}, N got ${drainedAtN.messages.length}`);
  console.log(`  e2e notifies: ${evidence.S1_case2_mixed.e2e_notifies.length} (expect 0)`);
  O.kill(); N.kill(); await sleep(500);
}

async function scenario2() {
  console.log('\n===== S2 — Case 3 (both NEW): auto-migrate to DOUBLE RATCHET =====');
  const A = startWorker('A_new', NEW_UNIT); const B = startWorker('B_new', NEW_UNIT);
  const ra = await A.readyP; const rb = await B.readyP;
  console.log(`  A(new) unit=${ra.unit.slice(0,12)} cid=${ra.cid.slice(0,12)}`);
  console.log(`  B(new) unit=${rb.unit.slice(0,12)} cid=${rb.cid.slice(0,12)}`);
  await pair(A, B);
  await A.call('notifies'); await B.call('notifies');
  const route = await driveMigration(A, B);
  const routeBack = (await B.call('send', { text: 'dr-back' })).route;
  await sleep(2500);
  const drainB = await B.call('drain'); const drainA = await A.call('drain');
  const aEv = (await A.call('notifies')).notifies; const bEv = (await B.call('notifies')).notifies;
  evidence.S2_case3_both_new = {
    route_a_to_b: route, route_b_to_a: routeBack,
    b_received: drainB.messages, a_received: drainA.messages,
    migration_active: [...aEv, ...bEv].filter((e) => e.event === 'migration_active'),
    e2e_app_send: [...aEv, ...bEv].filter((e) => e.event === 'e2e_app_send'),
    e2e_app_recv: [...aEv, ...bEv].filter((e) => e.event === 'e2e_app_recv'),
  };
  console.log(`  route A->B=${route}  B->A=${routeBack}  (expect e2e/e2e)`);
  console.log(`  migration_active: ${evidence.S2_case3_both_new.migration_active.length}, e2e_app_send: ${evidence.S2_case3_both_new.e2e_app_send.length}, e2e_app_recv: ${evidence.S2_case3_both_new.e2e_app_recv.length}`);
  console.log(`  delivered over DR: B got ${drainB.messages.length}, A got ${drainA.messages.length}`);
  A.kill(); B.kill(); await sleep(500);
}

async function scenario3() {
  console.log('\n===== S3 — Case 3a UPGRADE: EXISTING legacy contact flips box→DR on upgrade =====');
  // Faithful symmetric upgrade: BOTH sides start on a build that does NOT advertise
  // the migrate cap (7518511B) — an established LEGACY contact. Then BOTH "upgrade"
  // (advertise_migrate = the runtime analog of restarting on the NEW build that
  // advertises at boot). The existing contact must auto-migrate to the double ratchet.
  const A = startWorker('A_up', OLD_UNIT); const B = startWorker('B_up', OLD_UNIT);
  const ra = await A.readyP; const rb = await B.readyP;
  console.log(`  A unit=${ra.unit.slice(0,12)} (pre-upgrade)  B unit=${rb.unit.slice(0,12)} (pre-upgrade)`);
  await pair(A, B);
  await A.call('notifies'); await B.call('notifies');
  const preRoute = (await A.call('send', { text: 'pre-upgrade' })).route;
  await sleep(2000);
  const preDrainB = await B.call('drain');
  console.log(`  BEFORE upgrade: route A->B=${preRoute}, B delivered ${preDrainB.messages.length} (expect box, delivered)`);
  // Both upgrade (enable migrate at runtime).
  const advA = await A.call('advertise'); const advB = await B.call('advertise');
  console.log(`  A.advertise_migrate offers=${advA.offers}; B.advertise_migrate offers=${advB.offers}`);
  const postRoute = await driveMigration(A, B);
  await sleep(2500);
  const postDrainB = await B.call('drain');
  const aEv = (await A.call('notifies')).notifies; const bEv = (await B.call('notifies')).notifies;
  evidence.S3_case3a_upgrade = {
    route_before: preRoute, pre_delivered: preDrainB.messages,
    route_after: postRoute, post_delivered_over_dr: postDrainB.messages,
    migration_active: [...aEv, ...bEv].filter((e) => e.event === 'migration_active'),
    e2e_app_send: [...aEv, ...bEv].filter((e) => e.event === 'e2e_app_send'),
    e2e_app_recv: [...aEv, ...bEv].filter((e) => e.event === 'e2e_app_recv'),
  };
  console.log(`  AFTER upgrade: route A->B=${postRoute}  (expect e2e — existing contact migrated)`);
  console.log(`  migration_active: ${evidence.S3_case3a_upgrade.migration_active.length}, e2e_app_send: ${evidence.S3_case3a_upgrade.e2e_app_send.length}, delivered over DR: ${postDrainB.messages.length}`);
  A.kill(); B.kill(); await sleep(500);
}

async function main() {
  const only = process.argv[2];
  if (!only || only === 's1') await scenario1();
  if (!only || only === 's2') await scenario2();
  if (!only || only === 's3') await scenario3();
  console.log('\n===== EVIDENCE (JSON) =====');
  console.log(JSON.stringify(evidence, null, 2));
  process.exit(0);
}
main().catch((e) => { console.error('COORDINATOR FATAL', e); process.exit(1); });
