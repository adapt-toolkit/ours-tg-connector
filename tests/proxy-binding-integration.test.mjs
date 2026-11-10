// Real released-daemon integration for the route proxy binding: the restore and
// command wiring, legacy routes without a recorded binding, an
// ambiguous route, a failed metadata write, and widget-command authorization
// by the authenticated sender.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { attachOursClient } from '@ours.network/sdk';
import { freePort, startExternalDaemon } from './external-daemon.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

async function waitFor(label, fn, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result !== undefined) return result;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${label}`);
}

const DAEMON_STATE = mkdtempSync(join(tmpdir(), 'tg-binding-daemon-'));
const TG_STATE = mkdtempSync(join(tmpdir(), 'tg-binding-state-'));
const daemon = await startExternalDaemon({ stateDir: DAEMON_STATE });
const controlPort = await freePort();
const controlUrl = `http://127.0.0.1:${controlPort}`;

writeFileSync(join(TG_STATE, 'bots.json'), JSON.stringify({
  v: 1,
  bots: {
    fixture: {
      name: 'fixture', token: '1:test-token', username: 'fixture_bot',
      createdAt: new Date(0).toISOString(),
    },
  },
}), { mode: 0o600 });

const connectorEnv = {
  ...process.env,
  OURS_TG_DAEMON_URL: daemon.url,
  OURS_TG_DAEMON_STATE_DIR: DAEMON_STATE,
  OURS_TG_STATE_DIR: TG_STATE,
  OURS_TG_CONTROL_PORT: String(controlPort),
  OURS_TG_POLL_TIMEOUT: '1',
  OURS_TG_CONNECT_TIMEOUT_MS: '10',
  OURS_TG_FETCH_RETRIES: '0',
};

function startConnector() {
  // No request leaves the machine: the preload answers the Telegram API locally.
  const child = spawn(process.execPath, ['--import', 'tsx', '--import', './tests/fixtures/no-external-fetch.mjs', 'src/connector.ts'], {
    cwd: ROOT,
    env: connectorEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  let exited = null;
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const exit = new Promise((resolveExit) => child.once('exit', (code, signal) => {
    exited = { code, signal };
    resolveExit(exited);
  }));
  return {
    get output() { return output; },
    get exited() { return exited; },
    async stop() {
      if (exited) return;
      child.kill('SIGTERM');
      await Promise.race([exit, sleep(10_000)]);
    },
  };
}

async function waitForConnector(run, expectedRoutes, label) {
  await waitFor(label, async () => {
    if (run.exited) throw new Error(`connector exited early (${JSON.stringify(run.exited)}):\n${run.output}`);
    try {
      const response = await fetch(`${controlUrl}/health`);
      if (!response.ok) return undefined;
      const health = await response.json();
      return health.connections === expectedRoutes ? health : undefined;
    } catch {
      return undefined;
    }
  });
}

async function createRoute(run, name, chatId) {
  const response = await fetch(`${controlUrl}/connections`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, botName: 'fixture', chatId, threadId: '', label: '', bio: '', payloadMode: 'plain' }),
  });
  const created = await response.json();
  assert.equal(response.status, 201, `route creation failed: ${JSON.stringify(created)}\n${run.output}`);
  return created;
}

const metaPath = (route) => join(TG_STATE, route, 'connection.json');
const readMeta = (route) => JSON.parse(readFileSync(metaPath(route), 'utf8'));
const withoutPeer = ({ peerCid, ...rest }) => rest;
function clearBinding(route) {
  const meta = readMeta(route);
  meta.peerCid = '';
  writeFileSync(metaPath(route), JSON.stringify(meta, null, 2), { mode: 0o600 });
}

// Each agent is a separate client/lease, like a real proxy agent.
async function makeAgent(name) {
  const client = await attachOursClient({ endpoint: daemon.url, stateDir: DAEMON_STATE, leaseToken: `agent-${name}` });
  const created = await client.createIdentity({ name, bio: '', exposeLocal: false, localAutoAccept: true });
  return { name, client, cid: created.info.cid };
}
async function connect(agent, route) {
  await agent.client.addContact({ invite: route.invite });
  await waitFor(`${agent.name} contact with ${route.cid}`, async () => {
    const contacts = (await agent.client.listContacts()).contacts;
    return contacts.some((c) => c.container_id === route.cid) ? true : undefined;
  });
}

// Mint another invite for a route while the connector is stopped, through the
// route's own persisted lease (the connector holds no session then).
async function extraInvite(routeName) {
  const { leaseToken } = readMeta(routeName);
  const client = await attachOursClient({ endpoint: daemon.url, stateDir: DAEMON_STATE, leaseToken });
  try {
    await client.chooseIdentity({ name: routeName, force: false });
    const invite = await client.generateInvite({});
    return invite.blob;
  } finally {
    await client.close();
  }
}
async function connectWith(agent, routeCid, invite) {
  await agent.client.addContact({ invite });
  await waitFor(`${agent.name} contact with ${routeCid}`, async () => {
    const contacts = (await agent.client.listContacts()).contacts;
    return contacts.some((c) => c.container_id === routeCid) ? true : undefined;
  });
}

// Send a schema-valid telegram_widget_update for a widget that does not exist:
// an authorized sender gets unknown_widget (authorization passed, no Telegram
// call is made); anyone else gets not_authorized.
async function widgetVerdict(agent, route) {
  await waitFor(`${agent.name} sees widget commands of ${route.cid}`, async () => {
    try {
      const defs = await agent.client.listContactCommands({ contact: route.cid });
      return defs.some((d) => d.name === 'telegram_widget_update') ? true : undefined;
    } catch {
      return undefined;
    }
  });
  const sent = await agent.client.sendCommand({
    contact: route.cid, command: 'telegram_widget_update', arguments: { widget_ref: 'w_AAAAAAAAAAAA', chat_data: '{}' },
  });
  const wireId = sent.wire_id;
  return waitFor(`${agent.name} command result`, async () => {
    const page = await agent.client.getMessages();
    const hit = (page.command_results ?? []).find((r) => r.reply_to?.wire_id === wireId);
    if (!hit) return undefined;
    const text = String(hit.text ?? hit.body ?? '');
    const code = /not_authorized|unknown_widget|unsupported_route/.exec(text)?.[0];
    assert.ok(code, `unexpected command result: ${text}`);
    return code;
  });
}

const evidence = [];
const keep = (run) => evidence.push(...run.output.split('\n').filter((l) => /proxy agent|contact added|route restored|NO_EXTERNAL_FETCH/.test(l)));
let connector = startConnector();
try {
  await waitForConnector(connector, 0, 'connector control API');
  const observer = await attachOursClient({ endpoint: daemon.url, stateDir: DAEMON_STATE, leaseToken: 'binding-observer' });
  await observer.createRootIdentity({ name: 'Binding Human', bio: '', exposeLocal: false });

  const pa = await makeAgent('PersonalAssistant');
  const linda = await makeAgent('PersonalAssistantLinda');
  const other = await makeAgent('OtherAgent');
  const late = await makeAgent('LateAgent');

  // 1. A new route. The released daemon announces an accepted invite only as a
  //    human notification (no typed contact event), so the route stays unbound
  //    until a trigger reads the contact list: here, the agent's first command.
  const owner = await createRoute(connector, 'owner-dm', '101');
  const shared = await createRoute(connector, 'shared-dm', '202');
  await connect(pa, owner);
  await connect(linda, shared);
  await sleep(300);
  assert.equal(readMeta('owner-dm').peerCid, '', 'no binding from the contact notification alone');
  assert.equal(await widgetVerdict(pa, owner), 'unknown_widget', 'first command binds the sole contact and passes');
  assert.equal(readMeta('owner-dm').peerCid, pa.cid);
  assert.match(connector.output, /\[owner-dm\] proxy agent bound \(command\): "PersonalAssistant"/);

  // 2. Offline: make owner-dm legacy (binding cleared), give shared-dm a second
  //    contact (ambiguous), and keep invites for later contacts.
  keep(connector); await connector.stop();
  clearBinding('owner-dm');
  await connectWith(other, shared.cid, await extraInvite('shared-dm'));
  const lateSharedInvite = await extraInvite('shared-dm');
  const otherOwnerInvite = await extraInvite('owner-dm');
  const ownerBytes = readFileSync(metaPath('owner-dm'));
  const sharedBytes = readFileSync(metaPath('shared-dm'));
  const canDenyWrites = typeof process.getuid === 'function' && process.getuid() !== 0;
  if (canDenyWrites) {
    chmodSync(join(TG_STATE, 'owner-dm'), 0o500);
    connector = startConnector();
    await waitForConnector(connector, 2, 'restart with unwritable owner-dm');
    await waitFor('owner-dm restored', () => connector.output.includes('[owner-dm] route restored') ? true : undefined);
    assert.match(connector.output, /\[owner-dm\] proxy agent not bound \(restore\): saving the binding failed/);
    assert.deepEqual(readFileSync(metaPath('owner-dm')), ownerBytes, 'failed write leaves the metadata bytes unchanged');
    assert.equal(await widgetVerdict(pa, owner), 'not_authorized', 'authorization stays closed after a failed write');
    assert.match(connector.output, /\[owner-dm\] proxy agent not bound \(command\): saving the binding failed/);
    assert.deepEqual(readFileSync(metaPath('owner-dm')), ownerBytes, 'still unchanged after the command retry');
    keep(connector); await connector.stop();
    chmodSync(join(TG_STATE, 'owner-dm'), 0o700);
  } else {
    console.log('# skipped unwritable-metadata check (running as root)');
  }

  // 3. Restore: the legacy one-contact route binds; the ambiguous one does not.
  connector = startConnector();
  await waitForConnector(connector, 2, 'restart restoring legacy routes');
  await waitFor('both routes restored', () =>
    connector.output.includes('[owner-dm] route restored') && connector.output.includes('[shared-dm] route restored') ? true : undefined);
  assert.match(connector.output, /\[owner-dm\] proxy agent bound \(restore\): "PersonalAssistant"/);
  assert.match(connector.output, /\[shared-dm\] proxy agent not bound \(restore\): the route has 2 contacts/);
  const ownerAfter = readMeta('owner-dm');
  assert.equal(ownerAfter.peerCid, pa.cid);
  assert.deepEqual(withoutPeer(ownerAfter), withoutPeer(JSON.parse(ownerBytes)), 'only peerCid changed');
  assert.deepEqual(readFileSync(metaPath('shared-dm')), sharedBytes, 'ambiguous route metadata untouched');

  assert.equal(await widgetVerdict(pa, owner), 'unknown_widget', 'the bound PA passes authorization');
  assert.equal(await widgetVerdict(linda, shared), 'not_authorized', 'ambiguous route refuses its former agent');
  assert.equal(await widgetVerdict(other, shared), 'not_authorized', 'ambiguous route refuses the other contact');

  // 4. A third accepted contact on the ambiguous route does not bind it.
  await connectWith(late, shared.cid, lateSharedInvite);
  assert.equal(await widgetVerdict(late, shared), 'not_authorized', 'the newest contact is not adopted');
  assert.match(connector.output, /\[shared-dm\] proxy agent not bound \(command\): the route has 3 contacts/);
  assert.equal(readMeta('shared-dm').peerCid, '');

  // 5. A new contact on the bound route never replaces it, and is refused.
  await connectWith(other, owner.cid, otherOwnerInvite);
  await sleep(300);
  assert.equal(readMeta('owner-dm').peerCid, pa.cid);
  assert.equal(await widgetVerdict(other, owner), 'not_authorized', 'another contact of the bound route is refused');

  // 6. The binding survives restart.
  keep(connector); await connector.stop();
  connector = startConnector();
  await waitForConnector(connector, 2, 'final restart');
  await waitFor('owner-dm restored again', () => connector.output.includes('[owner-dm] route restored') ? true : undefined);
  assert.doesNotMatch(connector.output, /\[owner-dm\] proxy agent bound/, 'a bound route is not re-bound');
  assert.equal(readMeta('owner-dm').peerCid, pa.cid);
  assert.equal(await widgetVerdict(pa, owner), 'unknown_widget');

  keep(connector);
  const blocked = evidence.filter((l) => l.includes('NO_EXTERNAL_FETCH'));
  assert.ok(blocked.length > 0, 'the Telegram API was answered locally');
  assert.ok(blocked.every((l) => /blocked api\.telegram\.org\/bot<token>\/(getMe|getUpdates|setMyCommands|deleteWebhook)$/.test(l)),
    `only read/setup Bot API methods were attempted:\n${[...new Set(blocked)].join('\n')}`);
  assert.ok(!blocked.some((l) => /sendWidget|editMessageWidgetData|answerWidgetQuery|sendMessage/.test(l)), 'no widget or message mutation reached the Bot API');
  console.log([...new Set(evidence)].map((l) => `# ${l}`).join('\n'));
  console.log('proxy-binding-integration OK — restore + command wiring, legacy, ambiguous, failed write, isolation');
} finally {
  keep(connector); await connector.stop();
  try { chmodSync(join(TG_STATE, 'owner-dm'), 0o700); } catch {}
  await daemon.close();
  rmSync(TG_STATE, { recursive: true, force: true });
  rmSync(DAEMON_STATE, { recursive: true, force: true });
}
