import { MEDIA_ROUTES } from "@media/contracts/media-playback";
import { Effect, Schedule, Schema } from "effect";

const PROBE_TIMEOUT = "5 seconds";

const STREAM_PATH = "/media/music/stream/";

/**
 * The media server's address a song's stream URL points at: everything before
 * `/media/music/stream/`. Null when the URL does not have that form.
 */
export const mediaBaseUrl = (streamUrl: string): string | null => {
  const at = streamUrl.indexOf(STREAM_PATH);

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
 * One `GET <base>/api/health`; succeeds on any 2xx answer within the probe timeout. Uses `fetch`
 * directly because Effect's HTTP client is still an unstable module in the pinned version.
 */
export const probeMediaHealth = (baseUrl: string): Effect.Effect<void, MediaUnreachable> =>
  Effect.tryPromise({
    try: (signal) => fetch(`${baseUrl}${MEDIA_ROUTES.health}`, { signal, cache: "no-store" }),
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

/**
 * True when the media server refuses the stream's ticket (`401`), as it does once the ticket has
 * expired. Asks for the two bytes a media element opens a source with, which every profile
 * answers at once; an answer that does not come in time, or any other answer, is not a refusal.
 */
export const isStreamRefused = (streamUrl: string): Effect.Effect<boolean> =>
  Effect.tryPromise({
    try: async (signal) => {
      const response = await fetch(streamUrl, {
        signal,
        cache: "no-store",
        headers: { Range: "bytes=0-1" },
      });

      await response.body?.cancel();

      return response.status === 401;
    },
    catch: (cause) => new MediaUnreachable({ baseUrl: streamUrl, status: null, cause }),
  }).pipe(
    Effect.timeoutOrElse({ duration: PROBE_TIMEOUT, orElse: () => Effect.succeed(false) }),
    Effect.orElseSucceed(() => false),
    Effect.withSpan("MediaHealth.isStreamRefused"),
  );

const healthRetrySchedule = Schedule.min([
  Schedule.exponential("1 second"),
  Schedule.spaced("30 seconds"),
]).pipe(Schedule.jittered);

/** Probes until the media service answers. Interrupt the fiber to stop probing. */
export const waitForMedia = (
  baseUrl: string,
  schedule: Schedule.Schedule<unknown, MediaUnreachable> = healthRetrySchedule,
): Effect.Effect<void, MediaUnreachable> => probeMediaHealth(baseUrl).pipe(Effect.retry(schedule));
