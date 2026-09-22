import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.ts';
const prior = process.env.OURS_TG_CONTROL_HOST;
try {
  delete process.env.OURS_TG_CONTROL_HOST;
  assert.equal(loadConfig().controlHost, '127.0.0.1');
  process.env.OURS_TG_CONTROL_HOST = '0.0.0.0';
  assert.equal(loadConfig().controlHost, '0.0.0.0');
  for (const value of ['', 'localhost', 'https://example.test', '0.0.0.0\n']) {
    process.env.OURS_TG_CONTROL_HOST = value;
    assert.throws(() => loadConfig(), /OURS_TG_CONTROL_HOST/);
  }
} finally {
  if (prior === undefined) delete process.env.OURS_TG_CONTROL_HOST;
  else process.env.OURS_TG_CONTROL_HOST = prior;
}
console.log('control-host OK — loopback default and explicit isolated gateway binding');
