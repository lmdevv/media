/**
 * Media service reachability. The player marks the media service offline when a stream fails to
 * load, then probes `<media base>/health` with backoff until it answers.
 */
import { Effect, Schedule, Schema } from "effect";

/** How long one health probe may take before it counts as a failure. */
const PROBE_TIMEOUT = "5 seconds";

/**
 * The media service base URL a signed stream URL points at: everything before `/stream/`.
 * Null when the URL does not have that form.
 */
export const mediaBaseUrl = (streamUrl: string): string | null => {
  const at = streamUrl.indexOf("/stream/");

  return at > 0 ? streamUrl.slice(0, at) : null;
};

/** The media service health check did not answer with a success status in time. */
export class MediaUnreachable extends Schema.TaggedError<MediaUnreachable>()("MediaUnreachable", {
  baseUrl: Schema.String,
  /** The HTTP status when the service answered with an error, else null. */
  status: Schema.NullOr(Schema.Finite),
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `Media service unreachable at ${this.baseUrl}`;
  }
}

/**
 * One `GET <base>/health`; succeeds on any 2xx answer within the probe timeout. Uses `fetch`
 * directly because Effect's HTTP client is still an unstable module in the pinned version.
 */
export const probeMediaHealth = (baseUrl: string): Effect.Effect<void, MediaUnreachable> =>
  Effect.tryPromise({
    try: (signal) => fetch(`${baseUrl}/health`, { signal, cache: "no-store" }),
    catch: (cause) => new MediaUnreachable({ baseUrl, status: null, cause }),
  }).pipe(
    Effect.timeoutOrElse({
      duration: PROBE_TIMEOUT,
      orElse: () =>
        Effect.fail(new MediaUnreachable({ baseUrl, status: null, cause: "probe timed out" })),
    }),
    Effect.filterOrFail(
      (response) => response.ok,
      (response) => new MediaUnreachable({ baseUrl, status: response.status, cause: null }),
    ),
    Effect.asVoid,
    Effect.withSpan("MediaHealth.probe"),
  );

/** Retry delays between probes: 1 s, 2 s, 4 s, ... capped at 30 s, with jitter. */
const healthRetrySchedule = Schedule.min([
  Schedule.exponential("1 second"),
  Schedule.spaced("30 seconds"),
]).pipe(Schedule.jittered);

/** Probes until the media service answers. Interrupt the fiber to stop probing. */
export const waitForMedia = (
  baseUrl: string,
  schedule: Schedule.Schedule<unknown, MediaUnreachable> = healthRetrySchedule,
): Effect.Effect<void, MediaUnreachable> => probeMediaHealth(baseUrl).pipe(Effect.retry(schedule));
