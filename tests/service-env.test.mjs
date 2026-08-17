// tests/service-env.test.mjs
//
// WHAT THIS PROTECTS: `ours-tg-connector install-service` used to bake
// OURS_TG_DAEMON_URL and OURS_TG_DAEMON_STATE_DIR unconditionally, including when
// the operator had chosen neither and both were ''.
//
// `Environment=OURS_TG_DAEMON_URL=` does not leave a variable unset — systemd sets
// it to the EMPTY STRING (unsetting needs UnsetEnvironment=), and launchd's
// <string></string> does the same. loadConfig resolves with `??`, which falls back
// only on null/undefined, so `'' ?? file.daemonUrl` is `''`. The empty baked value
// therefore BEATS ~/.ours-telegram/config.json for ever after: install the service
// first, set daemonUrl/daemonStateDir in the config afterwards, and the connector
// silently ignores both and stays on the SDK's default selection — the
// wrong-daemon attachment the SDK integration exists to prevent — repairable only
// by hand-editing the unit.
//
// Pure and hermetic: no daemon, no systemd, no launchd, no network. It asserts on
// the environment map the service definition is built from, which is the same
// reason ours-mcp keeps buildSystemdUnit in its own module.
import assert from 'node:assert/strict';
import { serviceEnvironment } from '../src/service-definition.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass++; console.log('  ✓', m); };

// ---- 1. no selection ⇒ no line, so config.json stays authoritative -----------
{
  const env = serviceEnvironment({ ...DEFAULT_CONFIG }, '/home/u/.ours-telegram');
  ok(!('OURS_TG_DAEMON_URL' in env),
    'an unchosen daemon URL is absent from the unit, not baked as an empty string');
  ok(!('OURS_TG_DAEMON_STATE_DIR' in env),
    'an unchosen daemon state dir is absent from the unit, not baked as an empty string');
  // Not blanket omission: the fields with real defaults must still be pinned, or a
  // lingering unit would resolve a different control port than the CLI just did.
  ok(env.OURS_TG_CONTROL_PORT === String(DEFAULT_CONFIG.controlPort),
    'the control port is still baked — it has a real value, not an absent one');
  ok(env.OURS_TG_STATE_DIR === '/home/u/.ours-telegram',
    "the connector's own state dir is still baked");
  ok(env.OURS_TG_POLL_TIMEOUT === String(DEFAULT_CONFIG.pollTimeoutSec),
    'the poll timeout is still baked');
}

// ---- 2. a real selection IS baked, exactly as chosen -------------------------
{
  const env = serviceEnvironment(
    { ...DEFAULT_CONFIG, daemonUrl: 'http://127.0.0.1:3085', daemonStateDir: '/home/u/.ours-work' },
    '/home/u/.ours-telegram',
  );
  ok(env.OURS_TG_DAEMON_URL === 'http://127.0.0.1:3085',
    'a chosen daemon URL is pinned into the unit');
  ok(env.OURS_TG_DAEMON_STATE_DIR === '/home/u/.ours-work',
    'and so is the state directory whose token belongs to it');
}

// ---- 3. one half chosen is still one half baked ------------------------------
// The SDK refuses an endpoint without a state directory (INCOHERENT_SELECTION) and
// that refusal is its job, not this one's. What must not happen here is the empty
// half being written as a line that outranks a config file the operator may be
// about to fix.
{
  const env = serviceEnvironment({ ...DEFAULT_CONFIG, daemonUrl: 'http://127.0.0.1:3085' }, '/s');
  ok(env.OURS_TG_DAEMON_URL === 'http://127.0.0.1:3085', 'the chosen half is baked');
  ok(!('OURS_TG_DAEMON_STATE_DIR' in env), 'the unchosen half is still absent, not empty');
}

console.log(`\n${pass} assertions passed`);
