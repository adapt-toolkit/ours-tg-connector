// Focused HTTP fake for the connector's simple owned-name bookkeeping. The real
// daemon lifecycle is covered separately; here every SDK request and its order
// is observable without importing daemon internals.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { freePort } from './external-daemon.mjs';

const TG_STATE = mkdtempSync(join(tmpdir(), 'tg-owned-names-http-'));
const FAKE_DAEMON_STATE = join(TG_STATE, 'fake-daemon-state');
const fakePort = await freePort();
const controlPort = await freePort();
const fakeUrl = `http://127.0.0.1:${fakePort}`;
const controlUrl = `http://127.0.0.1:${controlPort}`;
const calls = [];

const routeRecords = [
  ['RestoredRoute', '101', 'lease-restored'],
  ['SnapshotMissing', '102', 'lease-snapshot-missing'],
  ['MissingRoute', '103', 'lease-missing'],
  ['BoundRoute', '104', 'lease-bound'],
  ['RemoveFails', '105', 'lease-remove-fails'],
];
const routeByLease = new Map(routeRecords.map(([name, , lease]) => [lease, name]));

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

const fakeDaemon = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', fakeUrl);
  if (req.method === 'GET' && url.pathname === '/state-dir') {
    return json(res, 200, { stateDir: FAKE_DAEMON_STATE, version: '2.0.1', compat: 2 });
  }
  if (req.method === 'GET' && url.pathname === '/identities') {
    calls.push({ op: 'globalIdentities', route: '', args: {}, lease: String(req.headers['x-ours-lease-token'] ?? '') });
    return json(res, 200, {
      identities: [
        { name: 'ForeignGlobal' },
        { name: 'RestoredRoute' },
        { name: 'BoundRoute' },
        { name: 'RemoveFails' },
      ],
    });
  }
  if (req.method === 'GET' && /\/identities\/[^/]+\/notifications/.test(url.pathname)) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    return json(res, 200, { cursor: 0, events: [] });
  }
  if (req.method !== 'POST' || !url.pathname.startsWith('/api/v1/')) return json(res, 404, { error: 'not found' });

  let body = '';
  for await (const chunk of req) body += chunk;
  const args = body ? JSON.parse(body) : {};
  const op = url.pathname.slice('/api/v1/'.length);
  const lease = String(req.headers['x-ours-lease-token'] ?? '');
  const route = routeByLease.get(lease) ?? '';
  calls.push({ op, route, args, lease });

  if (op === 'chooseIdentity') {
    if (route === 'MissingRoute') {
      return json(res, 400, { error: { code: 'NO_SUCH_IDENTITY', message: 'missing persisted route' } });
    }
    if (route === 'BoundRoute') {
      return json(res, 400, { error: { code: 'BOUND_ELSEWHERE', message: 'identity is held by another live session' } });
    }
    return json(res, 200, { name: args.name, cid: route.padEnd(64, 'A').slice(0, 64), switchedFrom: null });
  }
  if (op === 'releaseLease') return json(res, 200, { released: route ? [route] : [] });
  if (op === 'removeIdentity') {
    if (args.name === 'RemoveFails') {
      return json(res, 400, { error: { code: 'BOUND_ELSEWHERE', message: 'RemoveFails is held by another live session' } });
    }
    return json(res, 200, { name: args.name, kind: 'permanent' });
  }
  if (op === 'getMessages') return json(res, 200, { count: 0, messages: [] });
  if (op === 'getFiles') return json(res, 200, { files: [], text: '', mode: 'all_unread', requested: null });
  if (op === 'listContacts') return json(res, 200, { contacts: [], pending: [], roots: {}, degraded: [], renames: {} });
  return json(res, 500, { error: `unexpected operation ${op}` });
});
await new Promise((resolveListen, reject) => {
  fakeDaemon.once('error', reject);
  fakeDaemon.listen(fakePort, '127.0.0.1', resolveListen);
});

writeFileSync(join(TG_STATE, 'bots.json'), JSON.stringify({
  v: 1,
  bots: { fixture: { name: 'fixture', token: '1:test-token', username: 'fixture_bot', createdAt: new Date(0).toISOString() } },
}), { mode: 0o600 });

for (const [name, chatId, leaseToken] of routeRecords) {
  const dir = join(TG_STATE, name);
  mkdirSync(dir);
  writeFileSync(join(dir, 'connection.json'), JSON.stringify({
    v: 1, name, botName: 'fixture', chatId, threadId: '', label: '', bio: `${name} bio`,
    payloadMode: 'plain', deniedMessage: '', peerCid: '', leaseToken,
    createdAt: new Date(0).toISOString(),
  }), { mode: 0o600 });
}

const connector = spawn(process.execPath, ['--import', 'tsx', 'src/connector.ts'], {
  cwd: new URL('..', import.meta.url),
  env: {
    ...process.env,
    OURS_TG_DAEMON_URL: fakeUrl,
    OURS_TG_DAEMON_STATE_DIR: FAKE_DAEMON_STATE,
    OURS_TG_STATE_DIR: TG_STATE,
    OURS_TG_CONTROL_PORT: String(controlPort),
    OURS_TG_POLL_TIMEOUT: '1',
    OURS_TG_CONNECT_TIMEOUT_MS: '10',
    OURS_TG_FETCH_RETRIES: '0',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
connector.stdout.on('data', (chunk) => { output += chunk; });
connector.stderr.on('data', (chunk) => { output += chunk; });
let exited = null;
const exit = new Promise((resolveExit) => connector.once('exit', (code, signal) => {
  exited = { code, signal };
  resolveExit(exited);
}));
const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

try {
  const deadline = Date.now() + 30_000;
  let healthBody = null;
  while (Date.now() < deadline) {
    if (exited) throw new Error(`connector exited early (${JSON.stringify(exited)}):\n${output}`);
    try {
      const health = await fetch(`${controlUrl}/health`);
      if (health.ok) {
        healthBody = await health.json();
        if (healthBody.connections === 3) break;
      }
    } catch { /* still starting */ }
    await sleep(100);
  }
  assert.equal(healthBody?.connections, 3, `expected three restored siblings:\n${output}`);

  assert.equal(calls.filter((call) => call.op === 'globalIdentities').length, 1,
    'connector takes exactly one daemon-global GET /identities snapshot');
  assert.match(output, /daemon inventory includes connector routes:/);
  assert.doesNotMatch(output, /ForeignGlobal/, 'global inventory is filtered through persisted route names before reporting');

  const chooses = calls.filter((call) => call.op === 'chooseIdentity');
  assert.deepEqual(new Set(chooses.map((call) => call.route)), new Set(routeRecords.map(([name]) => name)),
    'every persisted route gets authoritative chooseIdentity, including names absent from the snapshot');
  for (const call of chooses) {
    assert.equal(call.lease, routeRecords.find(([name]) => name === call.route)?.[2],
      `${call.route} uses its exact persisted lease token`);
  }
  const boundChoose = chooses.find((call) => call.route === 'BoundRoute');
  assert.deepEqual(boundChoose?.args, { name: 'BoundRoute', force: false },
    'BOUND_ELSEWHERE is surfaced without ever sending force:true');
  assert.equal(calls.some((call) => call.op === 'createIdentity'), false,
    'NO_SUCH restore never silently recreates a persisted identity');
  assert.match(output, /failed to restore "MissingRoute".*has no identity in the daemon.*NOT being recreated/s,
    'NO_SUCH is surfaced as an explicit operator error and never silently recreated');
  assert.match(output, /failed to restore "BoundRoute".*held by another live session/s);
  assert.ok(calls.some((call) => call.route === 'RestoredRoute' && call.op === 'getMessages'),
    'one NO_SUCH sibling does not prevent a healthy route from restoring and draining');
  assert.ok(calls.some((call) => call.route === 'SnapshotMissing' && call.op === 'getMessages'),
    'a route missing only from the snapshot remains functional after chooseIdentity succeeds');

  const restoredResponse = await fetch(`${controlUrl}/connections/RestoredRoute`, { method: 'DELETE' });
  assert.equal(restoredResponse.status, 200, JSON.stringify(await restoredResponse.json()));
  const restoredOps = calls.filter((call) => call.route === 'RestoredRoute').map((call) => call.op);
  assert.ok(restoredOps.lastIndexOf('releaseLease') < restoredOps.lastIndexOf('removeIdentity'),
    'owned-name removal releases the exact route lease before removeIdentity');

  const failedResponse = await fetch(`${controlUrl}/connections/RemoveFails`, { method: 'DELETE' });
  const failed = await failedResponse.json();
  assert.equal(failedResponse.status, 409);
  assert.equal(failed.removed, 'RemoveFails');
  assert.equal(failed.identityLeftBehind, true);
  assert.match(failed.error, /identity "RemoveFails" was left behind/,
    'hard removal failure names the identity left behind');
  assert.equal(existsSync(join(TG_STATE, 'RemoveFails')), false,
    'hard removal failure still deletes the local route metadata');

  const missingResponse = await fetch(`${controlUrl}/connections/MissingRoute`, { method: 'DELETE' });
  const missing = await missingResponse.json();
  assert.equal(missingResponse.status, 409);
  assert.equal(missing.removed, 'MissingRoute');
  assert.match(missing.error, /identity "MissingRoute" was left behind/);
  assert.equal(existsSync(join(TG_STATE, 'MissingRoute')), false,
    'an unrestorable route can be discarded locally without touching a global identity');

  console.log('ownership-http OK — name filter, authoritative restore, stable leases, and removal ordering verified');
} finally {
  if (!exited) {
    connector.kill('SIGTERM');
    await Promise.race([exit, sleep(10_000)]);
  }
  await new Promise((resolveClose) => fakeDaemon.close(resolveClose));
  rmSync(TG_STATE, { recursive: true, force: true });
}
