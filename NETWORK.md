# Telegram networking: the IPv4-forced dispatcher

## Symptom

The daemon intermittently threw `TypeError: fetch failed` on Telegram Bot API
calls — both `sendMessage` (`telegram delivery failed for #N: TypeError: fetch
failed`) and the `getUpdates` long-poll (`getUpdates error: TypeError: fetch
failed; backing off`). `curl` to the same host never failed.

## Root cause

`api.telegram.org` publishes **both** an `A` (IPv4 `149.154.166.110`) and an
`AAAA` (IPv6) record. In some containers / VPSes IPv6 is **configured but
unreachable** (an IPv6 address/route exists, but packets get `ENETUNREACH` or
time out).

Node's global `fetch` (undici) uses **Happy Eyeballs** (`autoSelectFamily`,
default `true` on Node 20+): for a dual-stack host it races connects to both
families, staggered by `autoSelectFamilyAttemptTimeout` (~250 ms). When the IPv6
attempt fails/hangs and the single IPv4 attempt is also briefly slow, undici
surfaces the combined failure as `TypeError: fetch failed` whose `.cause` is an
`AggregateError [ETIMEDOUT]` (IPv4 timed out) interleaved with the IPv6
`ENETUNREACH`.

Why the reporter's `NODE_OPTIONS=--no-network-family-autoselection` wasn't
enough for the long-lived daemon:

- That flag only **disables the race** — undici then makes a single attempt to
  the **first** resolved address. But `getaddrinfo` orders addresses per RFC
  6724, which **prefers IPv6**, so the first address is the unreachable AAAA.
  Verified locally:

  ```
  dns.lookup('api.telegram.org', {all:true})
    => [ {address:'2001:67c:4e8:f004::9', family:6},   // AAAA first
         {address:'149.154.166.110',      family:4} ]  // A second
  ```

  So one-off calls succeeded or failed depending on address ordering/luck; the
  long-lived poll loop kept hitting the dead family intermittently.
- Keep-alive makes it worse: a pooled socket to a flaky path can go half-open
  (idle/NAT timeout across the 30 s long-poll) and a later reuse fails, while a
  fresh `curl` always reconnects cleanly.

## Fix

A **dedicated undici `Agent`** (scoped to the Telegram client, not a global
dispatcher) passed as the `dispatcher` option to every Telegram `fetch`
(`src/telegram.ts`):

- `connect: { family: 4 }` — `getaddrinfo` returns **only** the IPv4 `A` record,
  so the unreachable IPv6 is never attempted. Verified:
  `dns.lookup(..., {family:4}) => [{address:'149.154.166.110', family:4}]`.
- `connect: { autoSelectFamily: false }` — Happy Eyeballs off (belt +
  suspenders).
- `connect.timeout` / `connectTimeout` (10 s) — a bad connect fails **fast**
  (~2 s on a blackhole in testing) instead of a ~30 s hang.
- Short keep-alive (`keepAliveTimeout` 10 s) so a stale socket is recycled
  rather than reused half-open.

This is strictly stronger than the process-wide `NODE_OPTIONS` flag: it removes
IPv6 from resolution entirely (the flag did not), it is scoped so it can't affect
the ADAPT SDK or STT calls, and it can't be lost across a restart wrapper that
forgets the env var.

**Retries.** The transactional calls (`sendMessage`, `sendDocument`, `getFile`,
file download) now retry transient transport errors with bounded exponential
backoff + jitter, so a single `fetch failed` no longer drops a message. Only
thrown network errors are retried — an HTTP status error (a `Response`) is
surfaced immediately, never retried. `getUpdates` keeps its own backoff loop and
owns its abort signal, so it is not double-retried.

## Configuration

All defaults are the robust path. Override via env (see the README config table):
`OURS_TG_FORCE_IPV4` (`0`/`false` to opt out), `OURS_TG_CONNECT_TIMEOUT_MS`,
`OURS_TG_FETCH_RETRIES`, `OURS_TG_FETCH_RETRY_BASE_MS`.

## Tests

`tests/telegram-net.test.mjs` covers the connect options (`family:4` /
`autoSelectFamily:false` present and applied), transient-error classification,
the retry wrapper (retried-to-success, bounded-failure, non-retriable), and that
`TelegramClient` applies the dispatcher to every API call.
