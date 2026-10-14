/**
 * Streams that start part-way into a song: the media service's `&start=<ms>` on a transcoded
 * profile, which encodes from that point at once instead of making a seek wait for the whole
 * transcode. See `StreamTimingHeader.start` for the timeline.
 */
import { Data } from "effect";

import { retryAfterMs } from "./busy-retry";

/** The query parameter that starts a transcoded stream at an offset, in milliseconds. */
const START_PARAMETER = "start";

/**
 * `url` (a signed stream URL) asking for the stream from `startMs` into the song. The signature
 * does not cover the offset, so the URL stays valid.
 */
export const offsetUrl = (url: string, startMs: number): string => {
  const parsed = new URL(url, globalThis.location.href);

  parsed.searchParams.set(START_PARAMETER, String(Math.max(0, Math.round(startMs))));

  return parsed.toString();
};

/**
 * A stream that ends this far before the song's catalogued length was cut off rather than
 * finished. Catalogued lengths of some files (VBR MP3 without a header) are estimates, so a
 * stream that ends a little early counts as the end.
 */
const EARLY_END_MS = 1500;

/** True when a stream that ended at `positionMs` stopped short of a song `durationMs` long. */
export const endedEarly = (positionMs: number, durationMs: number): boolean =>
  positionMs < durationMs - EARLY_END_MS;

/** What the media service has at an offset stream URL (see `probeOffset`). */
export type OffsetProbe = Data.TaggedEnum<{
  /** A `200` with an empty body, as for an offset past the song's real end: the song is over. */
  Empty: {};
  /** Audio: a stream that failed to play there may play when opened again. */
  Audio: {};
  /** Every seek transcode is taken (`503`); asking again after `retryAfterMs` may work. */
  Busy: { readonly retryAfterMs: number };
  /** The signed URL was refused (`403`), as once it expires: a fresh URL may work. */
  Expired: {};
  /** An error status, or no answer within `PROBE_TIMEOUT_MS`. */
  Failed: {};
}>;

/** Constructors and matchers for `OffsetProbe`. */
export const OffsetProbe = Data.taggedEnum<OffsetProbe>();

/** How long `probeOffset` waits for the start of an answer. */
const PROBE_TIMEOUT_MS = 10_000;

/**
 * Asks the media service what it has at `url`, reading at most its first bytes. Gives up (as
 * `Failed`) after `PROBE_TIMEOUT_MS`, or at once when `signal` aborts.
 */
export const probeOffset = async (url: string, signal: AbortSignal): Promise<OffsetProbe> => {
  const abort = new AbortController();

  const stop = (): void => {
    abort.abort();
  };

  const timer = setTimeout(stop, PROBE_TIMEOUT_MS);

  signal.addEventListener("abort", stop, { once: true });

  try {
    const response = await fetch(url, { signal: abort.signal });
    const busy = retryAfterMs(response);

    if (busy !== null) {
      void response.body?.cancel().catch(() => undefined);

      return OffsetProbe.Busy({ retryAfterMs: busy });
    }

    if (response.status === 403) {
      void response.body?.cancel().catch(() => undefined);

      return OffsetProbe.Expired();
    }

    if (!response.ok || response.body === null) return OffsetProbe.Failed();
    const reader = response.body.getReader();
    const first = await reader.read();

    await reader.cancel();

    return first.done ? OffsetProbe.Empty() : OffsetProbe.Audio();
  } catch {
    return OffsetProbe.Failed();
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", stop);
  }
};
