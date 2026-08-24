#!/usr/bin/env node
// Unit test for src/stt.ts — the speech-to-text client — plus a secret
// hygiene guard for src/config.ts writeConfig(). Pure: stubbed globalThis.fetch,
// no network, no broker. Covers STT success, HTTP error, unparseable body,
// abort/timeout, the keyless short-circuit, and that writeConfig masks sttApiKey.
//
// Run: node_modules/.bin/tsx tests/stt.test.mjs

import { transcribe } from '../src/stt.ts';
import { DEFAULT_CONFIG, writeConfig } from '../src/config.ts';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';

let failures = 0;
function assert(cond, msg) {
  if (cond) console.log(`  ✓ ${msg}`);
  else { console.log(`  ✗ ${msg}`); failures++; }
}
const opts = { baseUrl: 'https://api.example/v1', apiKey: 'sk-test', model: 'whisper-1', timeoutMs: 5000 };
const bytes = Buffer.from('fake-opus');

console.log('=== stt unit test ===');

const realFetch = globalThis.fetch;
try {
  // success
  {
    globalThis.fetch = async (url, init) => {
      assert(String(url).endsWith('/audio/transcriptions'), 'posts to /audio/transcriptions');
      assert(init.headers.Authorization === 'Bearer sk-test', 'sends bearer key');
      assert(init.body instanceof FormData, 'sends multipart FormData');
      assert(init.body.get('model') === 'whisper-1', 'model field set');
      assert(init.body.get('response_format') === 'json', 'response_format json');
      assert(init.body.get('file').type === 'audio/ogg', 'strips ours MIME parameters from the STT upload part');
      return { ok: true, status: 200, json: async () => ({ text: 'hello world', language: 'en' }) };
    };
    const r = await transcribe(bytes, 'voice_1.ogg', 'audio/ogg; x-ours-kind=voice-message', opts);
    assert(r.ok && r.text === 'hello world', 'returns transcript text on 200');
    assert(r.ok && r.lang === 'en', 'passes through provider language when present');
  }
  // language only sent when configured
  {
    let sawLang = 'unset';
    globalThis.fetch = async (_url, init) => { sawLang = init.body.get('language'); return { ok: true, status: 200, json: async () => ({ text: 'x' }) }; };
    await transcribe(bytes, 'v.ogg', 'audio/ogg', opts);
    assert(sawLang === null, 'omits language field when not configured (provider auto-detects)');
    await transcribe(bytes, 'v.ogg', 'audio/ogg', { ...opts, language: 'de' });
    assert(sawLang === 'de', 'sends language field when configured');
  }
  // HTTP error
  {
    globalThis.fetch = async () => ({ ok: false, status: 401, text: async () => `unauthorized token ${opts.apiKey}` });
    const r = await transcribe(bytes, 'v.ogg', 'audio/ogg', opts);
    assert(!r.ok && /401/.test(r.error), 'returns {ok:false} with status on HTTP error');
    assert(!r.ok && !r.error.includes(opts.apiKey) && r.error.includes('[redacted]'),
      'redacts a configured key echoed in an HTTP error');
  }
  // bad JSON
  {
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => { throw new Error('bad json'); } });
    const r = await transcribe(bytes, 'v.ogg', 'audio/ogg', opts);
    assert(!r.ok, 'returns {ok:false} on unparseable body');
  }
  // missing text field
  {
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ foo: 'bar' }) });
    const r = await transcribe(bytes, 'v.ogg', 'audio/ogg', opts);
    assert(!r.ok && /text/.test(r.error), 'returns {ok:false} when the body has no text field');
  }
  // timeout / abort
  {
    globalThis.fetch = async (_url, _init) => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; };
    const r = await transcribe(bytes, 'v.ogg', 'audio/ogg', { ...opts, timeoutMs: 1 });
    assert(!r.ok && /timeout|abort/i.test(r.error), 'returns {ok:false} on abort/timeout');
  }
  // thrown provider/network errors cannot echo the configured key into logs
  {
    globalThis.fetch = async () => { throw new Error(`request rejected for ${opts.apiKey}`); };
    const r = await transcribe(bytes, 'v.ogg', 'audio/ogg', opts);
    assert(!r.ok && !r.error.includes(opts.apiKey) && r.error.includes('[redacted]'),
      'redacts a configured key echoed in a thrown error');
  }
  // no key => never calls fetch
  {
    let called = false;
    globalThis.fetch = async () => { called = true; return { ok: true, status: 200, json: async () => ({ text: '' }) }; };
    const r = await transcribe(bytes, 'v.ogg', 'audio/ogg', { ...opts, apiKey: '' });
    assert(!r.ok && !called, 'short-circuits with {ok:false} and no fetch when apiKey is empty');
  }
} finally {
  globalThis.fetch = realFetch;
}

// ---- writeConfig() masks the STT secret (regression guard) ------------------
// This pure guard keeps the secret-hygiene invariant covered without a broker.
console.log('=== config secret hygiene ===');
{
  const SECRET = 'sk-livekey-abcdef0123456789';
  const tmp = join(fs.mkdtempSync(join(os.tmpdir(), 'ours-cfg-')), 'config.json');
  const prev = process.env.OURS_TG_CONFIG;
  process.env.OURS_TG_CONFIG = tmp;
  try {
    const path = writeConfig({ ...DEFAULT_CONFIG, sttEnabled: true, sttApiKey: SECRET });
    const raw = fs.readFileSync(path, 'utf8');
    assert(!raw.includes(SECRET), 'writeConfig never persists the full sttApiKey');
    assert(raw.includes('set via env'), 'writeConfig writes a masked placeholder for a non-empty sttApiKey');
    assert((fs.statSync(path).mode & 0o777) === 0o600, 'config.json is written mode 0600');
    fs.rmSync(path, { force: true });
  } finally {
    if (prev === undefined) delete process.env.OURS_TG_CONFIG; else process.env.OURS_TG_CONFIG = prev;
  }
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
