// Real released-daemon integration for the connector's name-only identity list
// and stable per-route session lease.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

const DAEMON_STATE = mkdtempSync(join(tmpdir(), 'tg-owned-daemon-'));
const TG_STATE = mkdtempSync(join(tmpdir(), 'tg-owned-state-'));
const daemon = await startExternalDaemon({ stateDir: DAEMON_STATE });
const controlPort = await freePort();
const controlUrl = `http://127.0.0.1:${controlPort}`;

// Bypass add_bot's real Telegram getMe call. The short timeouts make delivery
// to the deliberately bogus token fail quickly and observably after restart.
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
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/connector.ts'], {
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

// This identity is deliberately created and held by a DIFFERENT session/lease
// from every connector route, so surviving releaseLease proves there is no
// lease-scoped cleanup sweep over unrelated global identities.
const observer = await attachOursClient({
  endpoint: daemon.url,
  stateDir: DAEMON_STATE,
  leaseToken: 'unrelated-observer-lease',
});
const unrelated = await observer.createIdentity({
  name: 'UnrelatedGlobal', bio: 'must survive connector cleanup',
  exposeLocal: false, localAutoAccept: true,
});
const agent = await attachOursClient({
  endpoint: daemon.url,
  stateDir: DAEMON_STATE,
  leaseToken: 'proxy-agent-separate-lease',
});
await agent.createIdentity({ name: 'ProxyAgent', bio: '', exposeLocal: false, localAutoAccept: true });

let connector = startConnector();
try {
  await waitForConnector(connector, 0, 'first connector control API');

  const createdResponse = await fetch(`${controlUrl}/connections`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'OwnedRoute', botName: 'fixture', chatId: '123', threadId: '',
      label: 'owned-name regression', bio: 'owned route', payloadMode: 'plain',
    }),
  });
  const created = await createdResponse.json();
  assert.equal(createdResponse.status, 201, `route creation failed: ${JSON.stringify(created)}\n${connector.output}`);
  assert.match(created.cid, /^[0-9A-F]{64}$/);

  const metadataPath = join(TG_STATE, 'OwnedRoute', 'connection.json');
  const persistedBeforeRestart = JSON.parse(readFileSync(metadataPath, 'utf8'));
  assert.equal(persistedBeforeRestart.name, 'OwnedRoute');
  assert.match(persistedBeforeRestart.leaseToken, /^[0-9a-f]{48}$/,
    'route stores one stable application-session lease token');
  assert.equal('identityState' in persistedBeforeRestart, false);
  assert.equal('identityCid' in persistedBeforeRestart, false,
    'route metadata carries only name-based ownership bookkeeping, not CID provenance');

  const before = await observer.listIdentities();
  assert.equal(before.find((row) => row.name === 'UnrelatedGlobal')?.cid, unrelated.info.cid);
  assert.equal(before.find((row) => row.name === 'OwnedRoute')?.cid, created.cid);

  await agent.addContact({ invite: created.invite });
  await waitFor('proxy agent contact handshake', async () => {
    const contacts = (await agent.listContacts()).contacts;
    return contacts.some((contact) => contact.container_id === created.cid) ? true : undefined;
  });

  // Stop only the connector; the released CLI 1.0.1 daemon and both unrelated
  // clients stay up. Restart must resume the same daemon session from metadata.
  await connector.stop();
  connector = startConnector();
  await waitForConnector(connector, 1, 'restarted connector to restore route');
  await waitFor('restore log', () => connector.output.includes('[OwnedRoute] route restored') ? true : undefined);

  const persistedAfterRestart = JSON.parse(readFileSync(metadataPath, 'utf8'));
  assert.equal(persistedAfterRestart.leaseToken, persistedBeforeRestart.leaseToken,
    'restart reuses the exact persisted per-route lease token');
  const afterRestart = await observer.listIdentities();
  assert.equal(afterRestart.filter((row) => row.name === 'OwnedRoute').length, 1,
    'restart re-binds the existing identity instead of creating a replacement');
  assert.equal(afterRestart.find((row) => row.name === 'OwnedRoute')?.cid, created.cid);

  const outputBeforeMessage = connector.output.length;
  await agent.sendMessage({ contact: created.cid, text: 'delivery after stable-lease restart' });
  await waitFor('post-restart delivery to reach connector', () => {
    const freshOutput = connector.output.slice(outputBeforeMessage);
    return /\[OwnedRoute\] telegram delivery failed for #\d+:/.test(freshOutput) ? true : undefined;
  });

  const removedResponse = await fetch(`${controlUrl}/connections/OwnedRoute`, { method: 'DELETE' });
  const removed = await removedResponse.json();
  assert.equal(removedResponse.status, 200, `route removal failed: ${JSON.stringify(removed)}\n${connector.output}`);
  assert.equal(removed.identityRemoved, true);
  assert.equal(removed.identityLeftBehind, false);

  const after = await observer.listIdentities();
  assert.equal(after.find((row) => row.name === 'UnrelatedGlobal')?.cid, unrelated.info.cid,
    'identity held by a different client/lease survives connector release and removal');
  assert.equal(after.some((row) => row.name === 'OwnedRoute'), false,
    'connector-owned route identity is removed by its persisted name');

  console.log('ownership-integration OK — separate identity survived and stable lease resumed across restart');
} finally {
  await connector.stop();
  await daemon.close();
  rmSync(TG_STATE, { recursive: true, force: true });
  rmSync(DAEMON_STATE, { recursive: true, force: true });
}
