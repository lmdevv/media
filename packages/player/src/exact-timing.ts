import { Data } from "effect";

import { delay, retryAfterMs } from "./busy-retry";
import type { EngineErrorReason } from "./engine";
import { parseStreamTiming } from "./gapless-timeline";
import type { StreamTiming } from "./gapless-timeline";

/** How long to keep asking while the song transcodes: the media service's own limit on one. */
const EXACT_TIMING_PATIENCE_MS = 10 * 60_000;

const TICKET_REFUSED = 401;

/** What the media service said about a stream's exact timing (see `askExactTiming`). */
export type ExactTiming = Data.TaggedEnum<{
  /** The finished transcode's measured timing. */
  Known: { readonly timing: StreamTiming };
  /** No timing: why, as the engine reports it. */
  Failed: { readonly reason: EngineErrorReason; readonly message: string };
}>;

/** Constructors and matchers for `ExactTiming`. */
export const ExactTiming = Data.taggedEnum<ExactTiming>();

const unsupported = (status: number) =>
  ExactTiming.Failed({
    reason: "unsupported",
    message: `The finished stream answered ${String(status)}`,
  });

/**
 * Asks with `HEAD` for the exact timing of the transcoded stream at `url` (with its ticket). While
 * the song is still transcoding the media service answers `503` with `Retry-After`, and this asks
 * again then, for up to `patienceMs`.
 *
 * @param signal - Aborting it, as a song that moves on does, ends the wait at once.
 * @returns The measured timing, or why there is none: `network` when a request fails or `signal`
 *   aborts, `expired` when the ticket is refused, and `unsupported` for any other answer, a `503`
 *   without `Retry-After` among them, or once `patienceMs` has passed.
 */
export const askExactTiming = (
  url: string,
  signal: AbortSignal,
  patienceMs: number = EXACT_TIMING_PATIENCE_MS,
): Promise<ExactTiming> => {
  const giveUpAt = performance.now() + patienceMs;

  const ask = async (): Promise<ExactTiming> => {
    let response: Response;

    try {
      response = await fetch(url, { method: "HEAD", signal });
    } catch (error) {
      return ExactTiming.Failed({
        reason: "network",
        message: error instanceof Error ? error.message : String(error),
      });
    }

    if (response.status === TICKET_REFUSED) {
      return ExactTiming.Failed({ reason: "expired", message: "The stream's ticket has expired" });
    }

    const preparing = response.headers.has("Retry-After") ? retryAfterMs(response) : null;

    if (preparing !== null) {
      const left = giveUpAt - performance.now();

      if (left <= 0) return unsupported(response.status);

      await delay(Math.min(preparing, left), signal);

      return ask();
    }

    const timing = parseStreamTiming((name) => response.headers.get(name));

    return !response.ok || timing === null || timing.estimated
      ? unsupported(response.status)
      : ExactTiming.Known({ timing });
  };

  return ask();
};
