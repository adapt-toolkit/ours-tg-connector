// Unit checks for the route proxy-binding reconciler (src/proxy-binding.ts):
// authoritative contact list only, exactly one valid contact, durable before
// visible, serialized, never replaces a binding.
import assert from 'node:assert/strict';
import { makeProxyBinder } from '../src/proxy-binding.ts';

const A = 'A'.repeat(64);
const B = 'B'.repeat(64);
const C = 'C'.repeat(64);
const contact = (cid, name = cid.slice(0, 1)) => ({ name, container_id: cid });

// A fake route: in-memory cfg.peerCid plus a "disk" copy, a scripted contact list.
function route({ peer = '', contacts = [], persistFails = 0, listGate = null } = {}) {
  const state = { mem: peer, disk: peer, contacts, persistFails, writes: 0, logs: [], lists: 0 };
  const bind = makeProxyBinder({
    current: () => state.mem,
    listContacts: async () => {
      state.lists++;
      const snapshot = [...state.contacts];
      if (listGate) await listGate();
      if (snapshot.some((c) => c === 'THROW')) throw new Error('daemon unavailable');
      return snapshot;
    },
    persist: (cid) => {
      if (state.persistFails > 0) { state.persistFails--; throw new Error('EACCES: disk full'); }
      state.writes++;
      state.disk = cid;
    },
    commit: (cid) => { state.mem = cid; },
    log: (m) => state.logs.push(m),
  });
  return { state, bind };
}
// A restart reloads memory from disk; a new binder instance, same rules.
function restart(r) {
  return route({ peer: r.state.disk, contacts: r.state.contacts });
}
// The widget command authorization in src/widgets.ts: non-empty binding and exact sender.
const authorized = (r, sender) => !!r.state.mem && r.state.mem === sender;

let checks = 0;
const check = async (name, fn) => { await fn(); checks++; console.log(`ok - ${name}`); };

await check('legacy route with one contact binds on restore, durable then visible', async () => {
  const r = route({ contacts: [contact(A, 'PersonalAssistant')] });
  assert.equal(await r.bind('restore'), 'bound');
  assert.equal(r.state.disk, A);
  assert.equal(r.state.mem, A);
  assert.ok(r.state.logs.some((l) => l.includes('"PersonalAssistant"') && l.includes(A)));
  const again = restart(r);
  assert.equal(again.state.mem, A, 'binding survives restart');
  assert.equal(await again.bind('restore'), 'kept');
  assert.equal(again.state.lists, 0, 'a bound route does not even list contacts');
  assert.ok(authorized(again, A));
  assert.ok(!authorized(again, B), 'another sender is refused');
});

await check('no contacts: stays unbound, silently', async () => {
  const r = route();
  assert.equal(await r.bind('restore'), 'none');
  assert.equal(r.state.mem, '');
  assert.equal(r.state.writes, 0);
  assert.ok(!authorized(r, A));
});

await check('ambiguous legacy route (2) stays unbound, and a third accepted contact does not bind', async () => {
  const r = route({ contacts: [contact(A), contact(B)] });
  assert.equal(await r.bind('restore'), 'ambiguous');
  r.state.contacts.push(contact(C));
  assert.equal(await r.bind('contact_accepted'), 'ambiguous', 'the event cannot pick the newest contact');
  assert.equal(r.state.mem, '');
  assert.equal(r.state.disk, '');
  assert.equal(r.state.writes, 0);
  for (const s of [A, B, C]) assert.ok(!authorized(r, s));
  assert.ok(r.state.logs.some((l) => l.includes('3 contacts')));
});

await check('existing binding is kept regardless of later contacts', async () => {
  const r = route({ peer: A, contacts: [contact(B)] });
  assert.equal(await r.bind('restore'), 'kept');
  r.state.contacts.push(contact(C));
  assert.equal(await r.bind('local_contact_added'), 'kept');
  assert.equal(r.state.mem, A);
  assert.equal(r.state.writes, 0);
  assert.ok(authorized(r, A) && !authorized(r, B));
});

await check('new route binds its first accepted contact; a second contact never replaces it', async () => {
  const r = route();
  assert.equal(await r.bind('restore'), 'none');
  r.state.contacts.push(contact(A));
  assert.equal(await r.bind('contact_accepted'), 'bound');
  r.state.contacts.push(contact(B));
  assert.equal(await r.bind('sibling_contact_added'), 'kept');
  assert.equal(r.state.mem, A);
  assert.equal(r.state.writes, 1);
});

await check('malformed container id is refused', async () => {
  for (const bad of ['a'.repeat(64), 'A'.repeat(63), '', 'Z'.repeat(64), A + ' ']) {
    const r = route({ contacts: [contact(bad)] });
    assert.equal(await r.bind('restore'), 'invalid', JSON.stringify(bad));
    assert.equal(r.state.mem, '');
    assert.equal(r.state.writes, 0);
  }
});

await check('contact list error: unbound, no write; a later trigger re-evaluates', async () => {
  const r = route({ contacts: ['THROW'] });
  assert.equal(await r.bind('restore'), 'error');
  assert.equal(r.state.mem, '');
  r.state.contacts = [contact(A)];
  assert.equal(await r.bind('contact_accepted'), 'bound');
  assert.equal(r.state.mem, A);
});

await check('failed persist leaves memory and disk unbound; queued event retries; restart authorizes', async () => {
  const r = route({ contacts: [contact(A)], persistFails: 1 });
  const first = r.bind('restore');
  const queued = r.bind('contact_accepted'); // queued behind the failing evaluation
  assert.equal(await first, 'error');
  assert.equal(r.state.mem, '', 'not visible in memory after a failed write');
  assert.equal(r.state.disk, '', 'old metadata intact');
  assert.ok(!authorized(r, A), 'authorization stays closed after the failure');
  assert.equal(await queued, 'bound', 'the queued event re-evaluates and binds');
  const again = restart(r);
  assert.equal(again.state.mem, A);
  assert.ok(authorized(again, A) && !authorized(again, B));
});

await check('persist failing every time keeps the route closed across restart', async () => {
  const r = route({ contacts: [contact(A)], persistFails: 99 });
  assert.equal(await r.bind('restore'), 'error');
  assert.equal(await r.bind('contact_accepted'), 'error');
  const again = restart(r);
  assert.equal(again.state.mem, '');
  assert.ok(!authorized(again, A));
});

await check('competing evaluations are serialized: one list at a time, one write, first binding wins', async () => {
  const gates = [];
  const gate = () => new Promise((res) => gates.push(res));
  const r = route({ contacts: [contact(A)], listGate: gate });
  const p1 = r.bind('restore');
  const p2 = r.bind('contact_accepted');
  await new Promise((res) => setImmediate(res));
  assert.equal(r.state.lists, 1, 'the second evaluation waits for the first');
  // A second contact arrives while the first read is in flight: the first read's
  // snapshot (one contact) binds A; the queued evaluation then sees A bound.
  r.state.contacts.push(contact(B));
  gates.shift()();
  assert.equal(await p1, 'bound');
  assert.equal(await p2, 'kept');
  assert.equal(r.state.lists, 1, 'the queued evaluation re-checks the binding before listing');
  assert.equal(r.state.mem, A);
  assert.equal(r.state.writes, 1);
});

await check('re-check after the await: binding set while listing is not overwritten', async () => {
  let resolveGate;
  const r = route({ contacts: [contact(B)], listGate: () => new Promise((res) => { resolveGate = res; }) });
  const p = r.bind('restore');
  await new Promise((res) => setImmediate(res));
  r.state.mem = A; // bound by some other path while the list was in flight
  resolveGate();
  assert.equal(await p, 'kept');
  assert.equal(r.state.mem, A);
  assert.equal(r.state.writes, 0);
});

await check('two routes bind only their own contact (isolation)', async () => {
  const r1 = route({ contacts: [contact(A, 'PersonalAssistant')] });
  const r2 = route({ contacts: [contact(B, 'PersonalAssistantLinda')] });
  await Promise.all([r1.bind('restore'), r2.bind('restore')]);
  assert.equal(r1.state.mem, A);
  assert.equal(r2.state.mem, B);
  assert.ok(authorized(r1, A) && !authorized(r1, B));
  assert.ok(authorized(r2, B) && !authorized(r2, A));
});

console.log(`proxy-binding: ${checks} checks passed`);
