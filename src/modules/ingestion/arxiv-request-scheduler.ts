// Shared by arXiv adapters in this process. The cloud daily job already has an
// execution guard; this queue also covers concurrent local callers and retries.
let tail: Promise<unknown> = Promise.resolve();
let nextRequestAt = 0;
const REQUEST_INTERVAL_MS = 3_000;

export function scheduleArxivRequest<T>(request: () => Promise<T>): Promise<T> {
  const result = tail.then(async () => {
    const delay = nextRequestAt - Date.now();
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    try {
      return await request();
    } finally {
      // A full quiet interval after completion also prevents overlapping bodies.
      nextRequestAt = Date.now() + REQUEST_INTERVAL_MS;
    }
  });
  tail = result.catch(() => undefined);
  return result;
}
