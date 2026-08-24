// tests/dist-attaches.test.mjs
//
// THE BUILT ARTIFACT ATTACHES TO A REAL DAEMON — not just parses.
//
// There was a gap between the two tests either side of this one:
//
//   bundle-loads.test.mjs   dist/connector.js PARSES, and `dist/cli.js --help`
//                           exits 0. Neither statement reaches attachToDaemon.
//   attach-daemon.test.mjs  the ours half works — but it drives @ours.network/sdk
//                           DIRECTLY. It never loads this repo's bundle.
//
// So nothing ran the shipped connector against a daemon, and that is precisely
// where this repo has already been bitten once: 534e99a fixed a bundle that
// `npm run build` produced with exit 0 and that then died at load with
// `SyntaxError: Identifier 'createRequire' has already been declared`. A parse
// check would not have caught the class of failure that follows a bad banner,
// an unbundled dependency, or a require that resolves only from src/.
//
// SDK 2's root export is client-only, so the bundle must attach without importing
// any package-private daemon runtime. The daemon is a separate operator-CLI
// process in this test, matching production ownership.
//
// The assertion: the bundle boots, resolves and PROVES a daemon, opens its
// control API, and stays up.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { freePort, startExternalDaemon } from './external-daemon.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUNDLE = join(ROOT, 'dist/connector.js');
// A missing artefact is a failure, not a skip — same rule as bundle-loads: a
// suite that skips when dist/ is absent is green on a bundle nobody built.
statSync(BUNDLE);

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass++; console.log('  ✓', m); };
const DAEMON_STATE = mkdtempSync(join(tmpdir(), 'tg-dist-daemon-'));
const PORT = await freePort();
const handle = await startExternalDaemon({ stateDir: DAEMON_STATE, port: PORT });

const TG_STATE = mkdtempSync(join(tmpdir(), 'tg-dist-state-'));
const CTL_PORT = await freePort();
let child;

const cleanup = async () => {
  try { child?.kill('SIGTERM'); } catch { /* already gone */ }
  await handle.close?.();
  rmSync(DAEMON_STATE, { recursive: true, force: true });
  rmSync(TG_STATE, { recursive: true, force: true });
};

try {
  // THE BUNDLE, not src/. `node dist/connector.js` is what an npm install runs.
  child = spawn(process.execPath, [BUNDLE], {
    cwd: ROOT,
    env: {
      ...process.env,
      OURS_TG_DAEMON_URL: `http://127.0.0.1:${PORT}`,
      OURS_TG_DAEMON_STATE_DIR: DAEMON_STATE,
      OURS_TG_STATE_DIR: TG_STATE,
      OURS_TG_CONTROL_PORT: String(CTL_PORT),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });

  const exited = new Promise((r) => child.on('exit', (code, signal) => r({ code, signal })));
  const ready = new Promise((r) => {
    const t = setInterval(() => { if (out.includes('ready (bots=')) { clearInterval(t); r('ready'); } }, 100);
    setTimeout(() => { clearInterval(t); r('timeout'); }, 60_000);
  });

  const result = await Promise.race([ready, exited]);
  assert.equal(result, 'ready',
    `dist/connector.js did not reach "ready" (got ${JSON.stringify(result)}). Output:\n${out}`);

  ok(true, 'dist/connector.js booted — the bundle loads and runs, not just parses');
  ok(out.includes('attached to daemon'),
    'it resolved AND proved the daemon through the bundled SDK (attachToDaemon ran)');
  ok(out.includes(`"baseUrl":"http://127.0.0.1:${PORT}"`) && out.includes('"baseUrlSource":"explicit"'),
    'it attached to the daemon THIS TEST started, by explicit selection');
  ok(out.includes('"stateDirSource":"explicit"'),
    'the state dir was explicitly chosen too — the coherence rule was satisfied, not bypassed');
  ok(out.includes(`control API on http://127.0.0.1:${CTL_PORT}`),
    'the control API came up on loopback');

  // The engine belongs only to the separately spawned operator daemon.
  ok(!out.includes('wrapper: packet ready') && !out.includes('wrapper ready (identities='),
    'the connector did NOT boot an engine — it stayed a client of the daemon');

  // Still alive: a bundle that loads and then dies on its first real call would
  // have satisfied every check above.
  const stillUp = await Promise.race([
    exited.then((e) => e),
    new Promise((r) => setTimeout(() => r('alive'), 3_000)),
  ]);
  ok(stillUp === 'alive', 'and it was still running afterwards, not exiting behind the log line');
} finally {
  await cleanup();
}

console.log(`\ndist-attaches OK (${pass} checks) — the SHIPPED bundle attaches to a daemon`);
process.exit(0);
