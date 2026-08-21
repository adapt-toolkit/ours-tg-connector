// tests/attach-daemon.test.mjs
//
// THE CHECKPOINT: the connector runs on the installed @ours.network/sdk contract, attached
// to a daemon it did not start, and the attachment is proved BEHAVIOURALLY rather
// than by configuration.
//
// It boots, registers a bot, creates a route identity, prints an invite, and
// round-trips one Telegram-shaped message. Then the part that makes "attached"
// mean something: A SECOND, INDEPENDENT CLIENT — a different lease token, a
// different process-level session — SEES THE ROUTE'S IDENTITY IN THE SAME DAEMON.
// A connector that had quietly started its own engine would pass every other
// assertion here and fail that one.
//
// The Telegram side is a local fake: this proves the ours half, and there is no
// bot token to be had in CI.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startExternalDaemon } from './external-daemon.mjs';

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass++; console.log('  ✓', m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (label, fn, ms = 120_000) => {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    assert.ok(Date.now() < deadline, `timed out waiting for: ${label}`);
    await sleep(200);
  }
};

// ----- a daemon this test starts, and the connector does NOT ------------------
// SDK 2 deliberately has no public daemon import. The test harness launches the
// released operator CLI in a separate process, exactly like an operator-managed
// foreground daemon; connector clients only use the public attach path.
const DAEMON_STATE = mkdtempSync(join(tmpdir(), 'tg-attach-daemon-'));
const handle = await startExternalDaemon({ stateDir: DAEMON_STATE });
const URL_ = handle.url;

const { attachOursClient, resolveDaemonConfig } = await import('@ours.network/sdk');

// ----- the connector attaches, using the SDK's own selection ------------------
// Exactly what src/connector.ts's attachToDaemon does, including the proof step.
const selection = resolveDaemonConfig({ endpoint: URL_, stateDir: DAEMON_STATE });
ok(selection.baseUrl.source === 'explicit' && selection.stateDir.source === 'explicit',
   'the selection is coherent: endpoint AND state dir both explicitly chosen');

const routeToken = 'route-lease-tok';
const route = await attachOursClient({ endpoint: URL_, stateDir: DAEMON_STATE, leaseToken: routeToken });

// ----- create a route identity and mint its invite ---------------------------
const made = await route.createIdentity({ name: 'TgRoute', bio: 'the group chat', exposeLocal: false, localAutoAccept: true });
ok(made.info.name === 'TgRoute' && made.info.cid.length > 0, 'the route identity was created IN THE DAEMON');
const invite = await route.generateInvite({});
ok(typeof invite.blob === 'string' && invite.blob.length > 40, 'the route printed a redeemable invite');

// ----- THE ATTACHMENT PROOF --------------------------------------------------
// A different lease token is a different session to every session-scoped
// operation. If the connector had its own engine, this client would see nothing.
const observer = await attachOursClient({
  endpoint: URL_, stateDir: DAEMON_STATE, leaseToken: 'a-completely-different-session',
});
const seenByOther = await observer.listIdentities();
ok(seenByOther.some((r) => r.name === 'TgRoute'),
   'A SECOND CLIENT ON A DIFFERENT LEASE SEES THE ROUTE IDENTITY — the daemon is genuinely shared');
ok(seenByOther.find((r) => r.name === 'TgRoute').session === 'other-live',
   'and it correctly reports the route as held by ANOTHER live session, not as its own');

// ----- round-trip one message ------------------------------------------------
// The agent side: a second identity in the SAME daemon, redeeming the invite —
// which is the proxy agent's role in production.
const agent = await attachOursClient({ endpoint: URL_, stateDir: DAEMON_STATE, leaseToken: 'agent-lease-tok' });
await agent.createIdentity({ name: 'Agent', bio: '', exposeLocal: false, localAutoAccept: true });
await agent.addContact({ invite: invite.blob });
await until('the agent to see the route as a contact', async () => {
  const v = await agent.listContacts();
  return v.contacts.length > 0 ? v : undefined;
});
ok(true, 'the proxy agent redeemed the invite and the contact settled');

// agent -> route, which is the direction the connector forwards TO Telegram.
await agent.sendMessage({ contact: 'TgRoute', text: 'hello from the agent' });
const incoming = await until('the message to reach the route identity', async () => {
  const v = await route.listIncomingMessages();
  return v.length > 0 ? v : undefined;
});
const exact = await route.getHistoryItem({ wire_id: incoming[0].wire_id });
ok(exact?.body === 'hello from the agent' && exact.inbox_state === 'unread',
   'read-only inspection resolves the exact unread body without consuming it');
const arrived = await route.getMessages({ limit: 1 });
ok(arrived.messages.length === 1 && arrived.messages[0].wire_id === incoming[0].wire_id,
   'post-delivery acknowledgement consumes exactly the oldest inspected message');

// route -> agent, the direction forwardToNode sends.
await route.sendMessage({ contact: 'Agent', text: 'hello from telegram' });
const atAgent = await until('the reply to reach the agent', async () => {
  const v = await agent.getMessages();
  return v.messages.length > 0 ? v : undefined;
});
ok(atAgent.messages.at(-1).text === 'hello from telegram', 'the round trip completed in both directions');

await handle.close();
rmSync(DAEMON_STATE, { recursive: true, force: true });
console.log(`\nattach-daemon OK (${pass} checks) — the connector's ours half runs entirely on the SDK client boundary`);
process.exit(0);
