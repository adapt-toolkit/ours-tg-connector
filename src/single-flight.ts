// Coalesce overlapping wake-ups into one ordered drain per route. A wake that
// lands while the task is running requests one more pass after the current pass;
// it never starts a second consumer beside it.
export type SingleFlight = (() => Promise<void>) & { idle(): Promise<void> };

export function singleFlight(task: () => Promise<void>): SingleFlight {
  let requested = false;
  let active: Promise<void> | null = null;

  const run = () => {
    requested = true;
    if (!active) {
      active = (async () => {
        try {
          while (requested) {
            requested = false;
            await task();
          }
        } finally {
          active = null;
        }
      })();
    }
    return active;
  };
  return Object.assign(run, { idle: () => active ?? Promise.resolve() });
}
