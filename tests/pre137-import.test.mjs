#!/usr/bin/env node
// Consumer-level regression gate for ours-mufl-core PR #14. The fixture was
// exported by the real pre-#137 tg packet tuple documented in the JSON file.
// Core 5887dec fails this import at meta.mm:1549 because $e2e_sessions is absent;
// b608099 must import it without losing the identity or app state.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { AdaptHost, wireHandlers, withScope, withScopeAsync } from '../src/adapt.ts';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/pre-137-tg-state.json', import.meta.url), 'utf8'));
const state = Buffer.from(fixture.state_base64, 'base64');
let failures = 0;
const assert = (condition, message) => {
  console.log(`  ${condition ? '✓' : '✗'} ${message}`);
  if (!condition) failures++;
};

assert(createHash('sha256').update(state).digest('hex') === fixture.state_sha256, 'fixture checksum matches its recorded old-build export');

const host = new AdaptHost('ws://127.0.0.1:1', () => {});
await host.boot();
const packet = await host.createPacket('Pre137Fixture', 'unused after signing-secret reseed', fixture.identity_key);
wireHandlers(packet, { onSaveState: () => {}, onNotify: () => {} }, () => {});
assert(packet.cid === fixture.cid, 'identity.key reseed preserves the pre-#137 container id');

let imported = false;
try {
  await withScopeAsync(async (lt) => {
    const parsed = packet.pw.packet.ParseValue(new Uint8Array(state)).Attach(lt);
    await packet.mutatingTx('::actor::import_state', parsed, lt);
  });
  imported = true;
} catch (error) {
  console.error(String(error));
}
assert(imported, 'pre-#137 tg state imports without the $e2e_sessions safe-cast failure');

if (imported) {
  const restoredName = withScope((lt) => packet.readonlyTx('::actor::export_state', lt).Reduce('my_name').Visualize());
  assert(restoredName === 'Pre137Fixture', 'pre-#137 application state survives import');
}

console.log(`\n${failures === 0 ? 'ALL PASSED' : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
