// Keep a long-poll watch alive across transient failures.
//
// WHY THIS EXISTS. As a host, the connector got its route events from in-process
// packet callbacks (`wireHandlers`). An in-process callback cannot "stop". As a
// client it long-polls the daemon instead, and the SDK's `watchNotifications`
// generator THROWS out of its `for await` on any fetch failure, any daemon-side
// `{error}` body, and any non-JSON response:
//
//     } catch (o) { if (s.signal?.aborted) return; throw o; }
//
// so a single socket reset — a daemon restart, a reverse proxy 502, a suspended
// laptop — ends the watch for the life of the process. The route then still
// RECEIVES from Telegram (the bot poll loop has its own backoff, src/telegram.ts)
// but never delivers the agent's replies: a bot that reads and never answers,
// with one log line an hour earlier to say why.
//
// The Telegram poll loop already treats a transient failure as something to
// sleep through rather than die on. This is the same rule for the other side.
//
// Aborting is still a clean stop, never a retry: shutdown and `removeConnection`
// abort the signal, and both the SDK generator and this loop return on it.

/** Injected so tests do not sleep in real time. */
export type Sleep = (ms: number) => Promise<void>;

export interface WatchRetryOptions {
  /** Aborted on shutdown / route removal. Abort is a clean stop, not an error. */
  signal: AbortSignal;
  /** First backoff, doubling per consecutive failure. */
  baseMs?: number;
  /** Backoff ceiling — a daemon can be down for hours; do not hammer it. */
  maxMs?: number;
  /** Handle one event. Errors escaping here are treated as stream failures. */
  onEvent: (ev: Record<string, unknown>) => Promise<void> | void;
  /**
   * Run on every RE-arm (never the first attach), before re-reading the stream.
   *
   * The re-armed watch primes at `tip` exactly as the first one does, so events
   * that landed while it was down are not replayed. They are not lost either —
   * they are in the daemon, and `getMessages`/`getFiles` are the source of truth.
   * This is where the caller drains that gap, the same drain `restoreConnection`
   * does on boot for the messages that arrived while the process was down.
   */
  onResume?: () => Promise<void> | void;
  /** Reported per failure, with the delay about to be slept. */
  onError: (err: unknown, delayMs: number) => void;
  sleep?: Sleep;
}

const defaultSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Consume `open()` forever, re-opening it after a failure with capped
 * exponential backoff. Returns only when the signal is aborted.
 *
 * `open` is called afresh per attempt: an async generator is single-use, so a
 * retry needs a new one rather than a re-entry into the dead one.
 */
export async function watchWithRetry(
  open: () => AsyncIterable<Record<string, unknown>>,
  opts: WatchRetryOptions,
): Promise<void> {
  const baseMs = opts.baseMs ?? 1_000;
  const maxMs = opts.maxMs ?? 30_000;
  const sleep = opts.sleep ?? defaultSleep;
  let delay = baseMs;
  let attached = false;

  while (!opts.signal.aborted) {
    try {
      if (attached) {
        // A re-arm. Catch up on the gap before trusting the stream again.
        //
        // Completing this is NOT proof the daemon recovered and must not reset
        // the backoff: the caller's drain reports its own failures and returns
        // normally either way, so resetting here would hold every retry at the
        // base delay and hammer a daemon that is still down. Only a delivered
        // event resets it.
        await opts.onResume?.();
      }
      attached = true;
      for await (const ev of open()) {
        delay = baseMs; // a delivered event proves the stream is healthy
        await opts.onEvent(ev);
      }
      // A clean return with no abort means the daemon closed the stream. The
      // current SDK only returns on abort, but a watch that went quiet because
      // a future one returns instead of throwing is the exact failure this
      // module exists to prevent — so re-arm rather than fall out of the loop.
      if (opts.signal.aborted) return;
    } catch (err) {
      if (opts.signal.aborted) return;
      opts.onError(err, delay);
    }
    if (opts.signal.aborted) return;
    await sleep(delay);
    delay = Math.min(delay * 2, maxMs);
  }
}
