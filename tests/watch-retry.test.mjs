#!/usr/bin/env node
//
// The notification watch must survive a transient daemon failure.
//
// Route events arrive through a long poll, and the SDK's
// `watchNotifications` throws out of `for await` on any fetch failure or
// daemon-side error. A watch that gave up there would leave the route READING
// Telegram (the bot poll has its own backoff) and never ANSWERING it.
//
// The assertions that make this behavioural rather than cosmetic:
//   - a throw re-opens the stream and the NEXT event is still delivered;
//   - a re-arm drains the gap, because it primes at `tip` and will not replay;
//   - abort is a clean stop with no retry and no drain.
//
// Run: node_modules/.bin/tsx tests/watch-retry.test.mjs

import { watchWithRetry } from '../src/watch.ts';

let failures = 0;
function assert(cond, msg) {
  if (cond) console.log(`  ✓ ${msg}`);
  else { console.log(`  ✗ ${msg}`); failures++; }
}

// Never sleeps in real time; records what the backoff asked for.
function fakeSleep(slept) {
  return async (ms) => { slept.push(ms); };
}

console.log('=== notification watch retry ===');

// --- 1. a throw mid-stream is retried, and later events still arrive ---------
{
  const events = [];
  const errors = [];
  const resumes = [];
  const slept = [];
  const ctrl = new AbortController();
  let attempt = 0;

  await watchWithRetry(
    async function* open() {
      attempt += 1;
      if (attempt === 1) {
        yield { event: 'message_received' };
        throw new Error('socket hang up'); // what a daemon restart looks like
      }
      yield { event: 'file_received' };
      ctrl.abort(); // stop the test once the retry has proved itself
    },
    {
      signal: ctrl.signal,
      sleep: fakeSleep(slept),
      onEvent: (ev) => { events.push(ev.event); },
      onResume: () => { resumes.push(attempt); },
      onError: (err, delayMs) => { errors.push([String(err), delayMs]); },
    },
  );

  assert(attempt === 2, 'the stream was re-opened after it threw');
  assert(events.join(',') === 'message_received,file_received',
    'the event after the failure was still delivered');
  assert(errors.length === 1 && errors[0][0].includes('socket hang up'),
    'the failure was reported once, with its cause');
  assert(slept.length === 1 && slept[0] === 1000, 'it backed off before re-opening');
  assert(resumes.length === 1, 'the re-arm drained the gap exactly once');
}

// --- 2. abort is a clean stop: no retry, no drain, no error -----------------
{
  const errors = [];
  const resumes = [];
  const slept = [];
  const ctrl = new AbortController();
  let attempt = 0;

  await watchWithRetry(
    async function* open() {
      attempt += 1;
      ctrl.abort();
      // The SDK rejects with AbortError when the signal lands mid-request; the
      // watch must read that as a stop rather than as something to retry.
      throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    },
    {
      signal: ctrl.signal,
      sleep: fakeSleep(slept),
      onEvent: () => {},
      onResume: () => { resumes.push(attempt); },
      onError: (err, delayMs) => { errors.push([String(err), delayMs]); },
    },
  );

  assert(attempt === 1, 'an aborted watch is not re-opened');
  assert(errors.length === 0, 'an abort is not reported as a failure');
  assert(slept.length === 0, 'an abort does not back off');
  assert(resumes.length === 0, 'an abort does not drain');
}

// --- 3. repeated failures escalate the backoff and cap it -------------------
{
  const slept = [];
  const ctrl = new AbortController();
  let attempt = 0;

  await watchWithRetry(
    async function* open() {
      attempt += 1;
      if (attempt >= 8) ctrl.abort();
      throw new Error('daemon down');
      // eslint-disable-next-line no-unreachable
      yield {};
    },
    {
      signal: ctrl.signal,
      sleep: fakeSleep(slept),
      baseMs: 1000,
      maxMs: 8000,
      onEvent: () => {},
      onResume: () => {},
      onError: () => {},
    },
  );

  assert(slept.slice(0, 4).join(',') === '1000,2000,4000,8000',
    'consecutive failures double the delay');
  assert(slept.every((ms) => ms <= 8000), 'the delay never exceeds the cap');
}

// --- 4. a healthy event resets the backoff ----------------------------------
{
  const slept = [];
  const ctrl = new AbortController();
  let attempt = 0;

  await watchWithRetry(
    async function* open() {
      attempt += 1;
      // Fail twice to escalate, then deliver an event, then fail again. The
      // delay after the healthy stretch must be the base one, not the escalated
      // one — otherwise one bad hour makes every later blip slow to recover.
      if (attempt <= 2) throw new Error('blip');
      if (attempt === 3) {
        yield { event: 'message_received' };
        throw new Error('blip again');
      }
      ctrl.abort();
    },
    {
      signal: ctrl.signal,
      sleep: fakeSleep(slept),
      onEvent: () => {},
      onResume: () => {},
      onError: () => {},
    },
  );

  assert(slept[0] === 1000 && slept[1] === 2000, 'the delay escalated while failing');
  assert(slept[2] === 1000, 'a delivered event reset the delay to base');
}

// --- 5. a clean return without abort re-arms rather than going quiet ---------
{
  const resumes = [];
  const ctrl = new AbortController();
  let attempt = 0;

  await watchWithRetry(
    async function* open() {
      attempt += 1;
      if (attempt >= 3) { ctrl.abort(); return; }
      return; // ends with no events and no error, and no abort
    },
    {
      signal: ctrl.signal,
      sleep: fakeSleep([]),
      onEvent: () => {},
      onResume: () => { resumes.push(attempt); },
      onError: () => {},
    },
  );

  assert(attempt === 3, 'a stream that ended without an abort was re-opened');
  assert(resumes.length === 2, 'each re-arm drained the gap');
}

// --- 6. a handler error does not tear down the stream -----------------------
// The connector's onEvent swallows its own errors, but the contract matters:
// if one ever escapes, it is a stream failure and must be retried, not fatal.
{
  const errors = [];
  const ctrl = new AbortController();
  let attempt = 0;

  await watchWithRetry(
    async function* open() {
      attempt += 1;
      if (attempt >= 2) { ctrl.abort(); return; }
      yield { event: 'message_received' };
    },
    {
      signal: ctrl.signal,
      sleep: fakeSleep([]),
      onEvent: () => { throw new Error('handler blew up'); },
      onResume: () => {},
      onError: (err) => { errors.push(String(err)); },
    },
  );

  assert(attempt === 2, 'an escaping handler error re-opened the stream');
  assert(errors.length === 1 && errors[0].includes('handler blew up'),
    'the handler error was reported, not swallowed');
}

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nALL PASSED');
