/**
 * A media service with every seek transcode taken answers `503` with `Retry-After` (seconds): a
 * brief condition. Both engines wait that long and ask again, a bounded number of times.
 */

/** Waits for a busy media service in a row before the stream counts as failed. */
export const MAX_BUSY_RETRIES = 4;

/** The wait when `Retry-After` is missing or not a number of seconds. */
const DEFAULT_RETRY_MS = 2000;

/** Bounds on the wait, whatever the header says. */
const MIN_RETRY_MS = 250;

const MAX_RETRY_MS = 10_000;

/** A `Retry-After` in whole seconds; the media service never sends the HTTP-date form. */
const SECONDS = /^\d{1,6}$/u;

/**
 * How long to wait before asking again when `response` says the media service is busy (`503`),
 * in milliseconds; null for any other answer.
 */
export const retryAfterMs = (response: Response): number | null => {
  if (response.status !== 503) return null;
  const header = response.headers.get("Retry-After")?.trim() ?? "";

  if (!SECONDS.test(header)) return DEFAULT_RETRY_MS;

  return Math.min(MAX_RETRY_MS, Math.max(MIN_RETRY_MS, Number(header) * 1000));
};

/** Resolves after `ms`, or at once when `signal` aborts. */
export const delay = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) {
      resolve();

      return;
    }

    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };

    const timer = setTimeout(done, ms);

    signal.addEventListener("abort", done, { once: true });
  });
