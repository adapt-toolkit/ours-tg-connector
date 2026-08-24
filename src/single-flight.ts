// Coalesce overlapping wake-ups into one ordered drain per route. A wake that
// lands while the task is running requests one more pass after the current pass;
// it never starts a second consumer beside it.
export function singleFlight(task: () => Promise<void>): () => Promise<void> {
  let requested = false;
  let active: Promise<void> | null = null;

  return () => {
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
}
