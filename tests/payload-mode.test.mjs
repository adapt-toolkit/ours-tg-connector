#!/usr/bin/env node

import { applyConfig, configValues, CONFIG_SCHEMA } from '../src/control.ts';

let failures = 0;
function assert(cond, msg) {
  if (cond) console.log(`  ✓ ${msg}`);
  else { console.log(`  ✗ ${msg}`); failures++; }
}

console.log('=== per-route Telegram payload mode ===');

const cfg = {
  name: 'channel', label: '', chatId: '529046075', deniedMessage: 'denied',
  payloadMode: 'envelope',
};

assert(CONFIG_SCHEMA.groups[0].fields.some((field) => field.key === 'payloadMode'),
  'control schema exposes payloadMode');
assert(configValues(cfg).payloadMode === 'envelope', 'envelope is represented explicitly');
assert(applyConfig(cfg, { payloadMode: 'plain' }) && cfg.payloadMode === 'plain',
  'control update enables plain payloads');
assert(!applyConfig(cfg, { payloadMode: 'plain' }), 'repeating the same mode is idempotent');
assert(!applyConfig(cfg, { payloadMode: 'unsafe' }) && cfg.payloadMode === 'plain',
  'unknown payload modes are ignored');
assert(applyConfig(cfg, { payloadMode: 'envelope' }) && cfg.payloadMode === 'envelope',
  'control update restores metadata envelopes');

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nALL PASSED');
