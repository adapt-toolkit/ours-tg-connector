import assert from 'node:assert/strict';
import { DaemonSelectionError, resolveDaemonConfig } from '@ours.network/sdk';
import { loadConfig } from '../src/config.ts';

const endpoint = 'http://127.0.0.1:3999';
const stateDir = '/tmp/ours-sdk2-config-test';

const envBefore = { ...process.env };
try {
  process.env.OURS_TG_CONFIG = '/tmp/ours-tg-config-that-does-not-exist.json';
  process.env.OURS_TG_DAEMON_URL = endpoint;
  delete process.env.OURS_TG_DAEMON_STATE_DIR;
  const half = loadConfig();
  assert.equal(half.daemonUrl, endpoint);
  assert.equal(half.daemonStateDir, '');
  assert.throws(
    () => resolveDaemonConfig({ endpoint: half.daemonUrl, env: {} }),
    (err) => err instanceof DaemonSelectionError && err.code === 'INCOHERENT_SELECTION',
    'SDK 2 rejects a connector endpoint without its paired state directory',
  );

  process.env.OURS_TG_DAEMON_STATE_DIR = stateDir;
  const paired = loadConfig();
  const resolved = resolveDaemonConfig({ endpoint: paired.daemonUrl, stateDir: paired.daemonStateDir, env: {} });
  assert.equal(resolved.baseUrl.value, endpoint);
  assert.equal(resolved.stateDir.value, stateDir);

  assert.throws(
    () => resolveDaemonConfig({ endpoint, stateDir, env: { OURS_INSTANCE: 'legacy-instance' } }),
    (err) => err instanceof DaemonSelectionError && err.code === 'INCOHERENT_SELECTION',
    'SDK 2 rejects OURS_INSTANCE instead of silently selecting the wrong daemon',
  );

  const normal = resolveDaemonConfig({ stateDir, env: {} });
  const legacyAutostart = resolveDaemonConfig({ stateDir, env: { OURS_AUTOSTART: '1' } });
  assert.deepEqual(legacyAutostart, normal, 'OURS_AUTOSTART is ignored and never starts an embedded daemon');

  console.log('config-sdk2 OK — coherent pair, OURS_INSTANCE refusal, and no autostart behavior verified');
} finally {
  for (const key of Object.keys(process.env)) if (!(key in envBefore)) delete process.env[key];
  Object.assign(process.env, envBefore);
}
