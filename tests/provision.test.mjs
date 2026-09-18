import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyProvision } from '../src/provision.ts';

const state = mkdtempSync(join(tmpdir(), 'tg-provision-'));
const bots = new Map(), connections = new Map();
let createdBots = 0, createdConnections = 0;
const operations = {
  bots, connections,
  async addBot(name, token) { createdBots++; bots.set(name, { token }); },
  async createConnection(cfg) {
    createdConnections++; connections.set(cfg.name, cfg);
    return { cid: 'fixture-cid', invite: 'fixture-invite', botUsername: 'fixture_bot' };
  },
};
const input = { bots: [{ name: 'primary', botToken: '12345678:full-secret' }],
  connections: [{ name: 'alerts', botName: 'primary', chatId: '100', payloadMode: 'plain' }] };
function save(value) { writeFileSync(join(state, 'provision.json'), JSON.stringify(value), { mode: 0o600 }); }
try {
  assert.equal(await applyProvision(state, operations), false, 'no input preserves ordinary startup');
  save(input);
  writeFileSync(join(state, 'provision-output.json.tmp'), 'stale', { mode: 0o644 });
  assert.equal(await applyProvision(state, operations), true);
  assert.equal(createdBots, 1); assert.equal(createdConnections, 1);
  const output = readFileSync(join(state, 'provision-output.json'), 'utf8');
  assert.equal(statSync(join(state, 'provision-output.json')).mode & 0o777, 0o600);
  assert.equal(readFileSync(join(state, 'provision-output.json.tmp'), 'utf8'), 'stale');
  assert.equal(JSON.parse(output).connections[0].result.invite, 'fixture-invite');
  await applyProvision(state, operations);
  assert.equal(createdBots, 1); assert.equal(createdConnections, 1, 'repeat must not recreate identities/invites');
  assert.equal(readFileSync(join(state, 'provision-output.json'), 'utf8'), output);
  save({ ...input, bots: [{ name: 'primary', botToken: '12345678:different-secret' }] });
  await assert.rejects(() => applyProvision(state, operations), /conflict/i, 'masked prefix is insufficient');
  save({ ...input, connections: [{ ...input.connections[0], chatId: 'other' }] });
  await assert.rejects(() => applyProvision(state, operations), /conflict/i);
  assert.equal(connections.get('alerts').chatId, '100');
  save({ bots: [...input.bots, { ...input.bots[0], name: ' primary ' }], connections: [] });
  await assert.rejects(() => applyProvision(state, operations), /unique/i);
  save({ bots: [], connections: input.connections });
  await assert.rejects(() => applyProvision(state, operations), /undeclared/i);
  save(input);
  operations.createConnection = async () => { throw new Error('creation failed'); };
  connections.clear();
  await assert.rejects(() => applyProvision(state, operations), /creation failed/);
  console.log('PASS optional provisioning, repeat, complete-token/route conflicts and creation failure');
} finally { rmSync(state, { recursive: true, force: true }); }
