#!/usr/bin/env node
// Unit test for src/stt.ts — the speech-to-text client. Pure: stubbed
// globalThis.fetch, no network. Covers success, HTTP error, unparseable body,
// abort/timeout, and the keyless short-circuit.
//
// Run: node_modules/.bin/tsx test-stt.mjs

import { transcribe } from './src/stt.ts';

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
      return { ok: true, status: 200, json: async () => ({ text: 'hello world', language: 'en' }) };
    };
    const r = await transcribe(bytes, 'voice_1.ogg', 'audio/ogg', opts);
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
    globalThis.fetch = async () => ({ ok: false, status: 401, text: async () => 'unauthorized' });
    const r = await transcribe(bytes, 'v.ogg', 'audio/ogg', opts);
    assert(!r.ok && /401/.test(r.error), 'returns {ok:false} with status on HTTP error');
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

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
