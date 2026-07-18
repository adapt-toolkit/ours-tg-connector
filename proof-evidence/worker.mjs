// One ours packet in its own process (its own native wrapper) → real broker.
// Speaks JSON-lines on stdin/stdout so a coordinator can drive a cross-version
// 2-daemon migration proof. OURS_TG_UNIT_DIR selects the muflo (OLD vs NEW).
import { AdaptHost, wireHandlers, packInvite, unpackInvite, renderInbox, renderContacts, withScope, withScopeAsync } from '/home/fleet/work/dev2-migration-gap/src/adapt.ts';
import readline from 'node:readline';

const BROKER = process.env.PROOF_BROKER ?? 'wss://broker1.ours.network';
const NAME = process.env.PROOF_NAME ?? 'W';
const log = (...p) => { if (process.env.VERBOSE) process.stderr.write(`[${NAME}] ${p.join(' ')}\n`); };
const out = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');

const notifies = [];  // captured core notify events (the crypto-envelope evidence)
function onNotify(event, payload) {
  const rec = { event };
  const get = (k) => { const v = payload.Reduce(k); return v.IsNil() ? undefined : String(v.Visualize()); };
  const hex = (k) => { const v = payload.Reduce(k); return v.IsNil() ? undefined : Buffer.from(v.GetBinary()).toString('hex'); };
  if (event === 'migration_active') { rec.cid = get('cid'); rec.role = get('role'); rec.epoch = hex('epoch'); rec.session_id = hex('session_id'); }
  else if (event === 'e2e_app_send' || event === 'e2e_app_recv') { rec.cid = get('cid'); rec.session_id = hex('session_id'); rec.olm_type = get('olm_type'); rec.wire_id = get('wire_id'); rec.ok = get('ok'); }
  else if (event === 'message_received' || event === 'file_received') { /* legacy transport signal */ }
  else if (event === 'downgrade_refused') { rec.cid = get('cid'); rec.wire_id = get('wire_id'); }
  else return; // ignore unrelated notifies
  notifies.push(rec);
  log(`notify ${event} ${JSON.stringify(rec)}`);
}

const host = new AdaptHost(BROKER, log);
await host.boot();
const pkt = await host.createPacket(NAME, `seed-${NAME}-${Date.now()}`);
wireHandlers(pkt, { onSaveState: () => {}, onNotify }, log);
await withScopeAsync((lt) => pkt.mutatingTx('::a2a_messaging::set_my_name', { name: NAME }, lt));
out({ ready: true, name: NAME, unit: host.unit.hash, cid: pkt.cid });

let peerCid = null;
async function firstContactCid() {
  if (peerCid) return peerCid;
  return withScope((lt) => {
    const contacts = renderContacts(pkt.readonlyTx('::a2a_messaging::list_contacts', lt));
    peerCid = contacts.length ? contacts[0].container_id : null;
    return peerCid;
  });
}

const rl = readline.createInterface({ input: process.stdin });
for await (const line of rl) {
  if (!line.trim()) continue;
  let msg; try { msg = JSON.parse(line); } catch { continue; }
  const { id, cmd } = msg;
  try {
    if (cmd === 'invite') {
      const b64 = await withScopeAsync(async (lt) =>
        packInvite(Buffer.from((await pkt.mutatingTx('::a2a_messaging::generate_invite', {}, lt)).Reduce('invite').GetBinary())));
      out({ id, invite: b64 });
    } else if (cmd === 'add') {
      await withScopeAsync((lt) => pkt.mutatingTx('::a2a_messaging::add_contact', { invite: pkt.newBinary(unpackInvite(msg.invite), lt) }, lt));
      out({ id, added: true });
    } else if (cmd === 'contacts') {
      const cid = await firstContactCid();
      out({ id, count: cid ? 1 : 0, cid });
    } else if (cmd === 'send') {
      const cid = await firstContactCid();
      const route = await withScopeAsync(async (lt) => {
        const r = await pkt.mutatingTx('::a2a_messaging::send_message', { contact: cid, text: msg.text }, lt);
        const ra = r.Reduce('route');
        if (!ra.IsNil()) return String(ra.Visualize());
        if (!r.Reduce('migrating').IsNil()) return 'migrating';
        if (!r.Reduce('downgrade_refused').IsNil()) return 'downgrade_refused';
        return 'box';
      });
      out({ id, route });
    } else if (cmd === 'sweep') {
      const counts = await withScopeAsync(async (lt) => {
        const r = await pkt.mutatingTx('::a2a_messaging::sweep_e2e_migrations', {}, lt);
        return { initiated: Number(r.Reduce('initiated').Visualize()), redriven: Number(r.Reduce('redriven').Visualize()), superseded: Number(r.Reduce('superseded').Visualize()) };
      });
      out({ id, ...counts });
    } else if (cmd === 'advertise') {
      const r = await withScopeAsync(async (lt) => {
        const rr = await pkt.mutatingTx('::a2a_messaging::advertise_migrate', {}, lt);
        return { advertising: Boolean(rr.Reduce('advertising').Visualize?.() ?? true), offers: Number(rr.Reduce('offers_initiated').Visualize()) };
      });
      out({ id, ...r });
    } else if (cmd === 'drain') {
      const msgs = await withScopeAsync(async (lt) =>
        renderInbox((await pkt.mutatingTx('::actor::get_messages', {}, lt)).Reduce('messages')));
      out({ id, messages: msgs.map((m) => ({ text: m.text, sender: m.sender_name })) });
    } else if (cmd === 'notifies') {
      out({ id, notifies: notifies.splice(0, notifies.length) });
    } else if (cmd === 'quit') {
      out({ id, bye: true });
      process.exit(0);
    } else {
      out({ id, error: `unknown cmd ${cmd}` });
    }
  } catch (e) {
    out({ id, error: String(e && e.message ? e.message : e) });
  }
}
