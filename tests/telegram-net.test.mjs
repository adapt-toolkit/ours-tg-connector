#!/usr/bin/env node
// Unit tests for the Telegram network hardening (src/telegram.ts): the IPv4-forced
// undici dispatcher config, transient-error classification, the retry wrapper, and
// that TelegramClient applies the dispatcher to every API call. No real network.
//
// Root cause context: api.telegram.org resolves to both an A (IPv4) and AAAA (IPv6)
// record; in a configured-but-unreachable-IPv6 env, getaddrinfo (RFC 6724) returns
// the AAAA first, so undici Happy Eyeballs races a dead IPv6 attempt and fetch
// intermittently throws `TypeError: fetch failed`. family:4 removes IPv6 entirely.
//
// Run: node_modules/.bin/tsx tests/telegram-net.test.mjs

import { Agent } from 'undici';
import {
  telegramConnectOptions,
  isRetriableFetchError,
  fetchWithRetry,
  buildTelegramDispatcher,
  DEFAULT_NET_OPTIONS,
  TelegramClient,
} from '../src/telegram.ts';

let failures = 0;
function assert(cond, msg) {
  if (cond) console.log(`  ✓ ${msg}`);
  else { console.log(`  ✗ ${msg}`); failures++; }
}

// A canned Telegram JSON response, mirroring the shape each method parses.
function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
}
function typeErrorFetchFailed() {
  const cause = new Error('connect ETIMEDOUT'); cause.code = 'ETIMEDOUT';
  const e = new TypeError('fetch failed'); e.cause = cause; return e;
}

console.log('=== telegram connect options (IPv4 forcing) ===');
{
  const on = telegramConnectOptions({ ...DEFAULT_NET_OPTIONS, forceIpv4: true, connectTimeoutMs: 9000 });
  assert(on.family === 4, 'forceIpv4 => family:4 (only the A record is resolved)');
  assert(on.autoSelectFamily === false, 'forceIpv4 => autoSelectFamily:false (Happy Eyeballs disabled)');
  assert(on.timeout === 9000, 'connect timeout is applied');

  const off = telegramConnectOptions({ ...DEFAULT_NET_OPTIONS, forceIpv4: false, connectTimeoutMs: 5000 });
  assert(off.family === undefined, 'opt-out => no family pin (Node default resolution)');
  assert(off.autoSelectFamily === undefined, 'opt-out => Happy Eyeballs left at Node default');
  assert(off.timeout === 5000, 'opt-out still bounds the connect');

  assert(buildTelegramDispatcher(DEFAULT_NET_OPTIONS) instanceof Agent, 'buildTelegramDispatcher returns an undici Agent');
}

console.log('=== transient-error classification ===');
{
  assert(isRetriableFetchError(typeErrorFetchFailed()) === true, 'TypeError: fetch failed is retriable');
  const agg = new AggregateError([new Error('ENETUNREACH'), new Error('ETIMEDOUT')], 'all attempts failed');
  assert(isRetriableFetchError(agg) === true, 'AggregateError (Happy Eyeballs) is retriable');
  const reset = new Error('socket reset'); reset.code = 'ECONNRESET';
  assert(isRetriableFetchError(reset) === true, 'ECONNRESET is retriable');
  const abort = new Error('aborted'); abort.name = 'AbortError';
  assert(isRetriableFetchError(abort) === false, 'AbortError is NOT retried (caller-driven)');
  assert(isRetriableFetchError(new Error('boom')) === false, 'a plain error is not retried');
  assert(isRetriableFetchError(undefined) === false, 'undefined is not retried');
}

console.log('=== fetchWithRetry (bounded backoff on transient errors) ===');
{
  // fails twice, then succeeds -> returns the eventual Response, 3 calls total.
  let calls = 0;
  const flaky = async () => { calls++; if (calls < 3) throw typeErrorFetchFailed(); return jsonResponse({ ok: true }); };
  const r = await fetchWithRetry(flaky, 'https://api.telegram.org/bot123:tok/getMe', {}, { retries: 3, retryBaseMs: 1 });
  assert(calls === 3 && r.status === 200, 'transient failures are retried until success');

  // always fails -> throws after exactly retries+1 attempts.
  let calls2 = 0;
  const dead = async () => { calls2++; throw typeErrorFetchFailed(); };
  let threw = false;
  try { await fetchWithRetry(dead, 'https://api.telegram.org/bot123:tok/getMe', {}, { retries: 2, retryBaseMs: 1 }); }
  catch { threw = true; }
  assert(threw && calls2 === 3, 'exhausts bounded retries (retries+1 attempts) then throws');

  // non-retriable error -> throws immediately, no retry.
  let calls3 = 0;
  const badReq = async () => { calls3++; const e = new Error('nope'); e.name = 'AbortError'; throw e; };
  let threw3 = false;
  try { await fetchWithRetry(badReq, 'https://api.telegram.org/bot123:tok/getMe', {}, { retries: 5, retryBaseMs: 1 }); }
  catch { threw3 = true; }
  assert(threw3 && calls3 === 1, 'non-retriable error is not retried');
}

console.log('=== dispatcher applied to every TelegramClient call ===');
{
  const seen = [];
  const fakeFetch = async (url, init) => {
    seen.push({ url, dispatcher: init?.dispatcher });
    if (url.includes('/getMe')) return jsonResponse({ ok: true, result: { id: 1, username: 'bot' } });
    if (url.includes('/sendMessage')) return jsonResponse({ ok: true });
    if (url.includes('/getFile')) return jsonResponse({ ok: true, result: { file_path: 'photos/x.jpg', file_size: 3 } });
    if (url.includes('/file/bot')) return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    return jsonResponse({ ok: true });
  };
  const c = new TelegramClient('123:tok', 30, () => {}, DEFAULT_NET_OPTIONS, fakeFetch);

  await c.getMe();
  await c.sendMessage(42, 'hi');
  await c.downloadFile('file-1'); // getFile + file download

  assert(seen.length === 4, 'getMe + sendMessage + getFile + download all issued through the client');
  assert(seen.every((s) => s.dispatcher instanceof Agent), 'every call carries the IPv4-forced undici Agent as dispatcher');
  const dispatchers = new Set(seen.map((s) => s.dispatcher));
  assert(dispatchers.size === 1, 'all calls share the one scoped dispatcher instance');
}

console.log('=== retry integrated into a transactional call (sendMessage) ===');
{
  let n = 0;
  const flaky = async (url) => {
    if (url.includes('/sendMessage')) { n++; if (n < 2) throw typeErrorFetchFailed(); }
    return jsonResponse({ ok: true });
  };
  const c = new TelegramClient('123:tok', 30, () => {}, { ...DEFAULT_NET_OPTIONS, retryBaseMs: 1 }, flaky);
  await c.sendMessage(42, 'hi'); // one transient failure then success — must not throw
  assert(n === 2, 'sendMessage retried the transient failure and then succeeded');
}

console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
