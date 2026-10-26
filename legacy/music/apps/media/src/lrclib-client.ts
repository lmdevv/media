/**
 * LRCLIB (https://lrclib.net/docs) as the lyrics worker asks it. Requests go out one at a time
 * across the whole service, with a gap between them. Each lookup tries `/api/get` with the song's
 * tags and length, then `/api/search`, whose results count only when the title, artist, and
 * length match.
 *
 * Failures come in two kinds. LRCLIB being unavailable (no connection, a timeout, a 5xx, a 429,
 * or any other refusal but 404) is no fault of the song: it pauses every request, for as long as
 * `Retry-After` says or for a backoff that doubles with each failure in a row, up to an hour in
 * production. A record LRCLIB returned that cannot be read is that song's failure alone.
 */
import { Buffer } from "node:buffer";

import { normalizeLyricsTag } from "@music/commands/lyrics";
import {
  Clock,
  Context,
  Data,
  Duration,
  Effect,
  Layer,
  Option,
  Ref,
  Result,
  Schema,
  Semaphore,
} from "effect";

import packageJson from "../package.json" with { type: "json" };
import { type LrclibLyrics, parseLrclibRecord } from "./lyrics/lrclib.ts";
import type { LookupQuery } from "./media-backend.ts";
import { MediaConfig } from "./media-config.ts";

/** LRCLIB could not answer: every request now waits `pauseMs`, and the song is asked again. */
export class LrclibUnavailable extends Schema.TaggedError<LrclibUnavailable>()(
  "LrclibUnavailable",
  {
    reason: Schema.Literals(["network", "timeout", "server_error", "rate_limited", "rejected"]),
    /** The HTTP status, when LRCLIB answered. */
    status: Schema.NullOr(Schema.Finite),
    /** How long the client holds every request: `Retry-After`, or its backoff. */
    pauseMs: Schema.Finite,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `LRCLIB unavailable: ${this.reason}${this.status === null ? "" : ` (HTTP ${String(this.status)})`}`;
  }
}

/** LRCLIB answered with a record for this song that cannot be read, or one too large to. */
class LrclibMalformed extends Schema.TaggedError<LrclibMalformed>()("LrclibMalformed", {
  path: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `LRCLIB sent an unreadable answer from ${this.path}`;
  }
}

/** How the client paces and bounds its requests. */
export interface Options {
  /** LRCLIB's address, without a trailing slash. */
  readonly baseUrl: string;
  readonly userAgent: string;
  /** The least time between the end of one request and the start of the next. */
  readonly gap: Duration.Duration;
  /** How long one request may take, its answer read to the end. */
  readonly timeout: Duration.Duration;
  /** The pause after LRCLIB was unavailable once, without a `Retry-After`; doubles each time. */
  readonly failurePause: Duration.Duration;
  /**
   * The longest pause, from the doubling or a `Retry-After`. A longer `Retry-After` would stop
   * every lookup for as long as the answer says; past this, LRCLIB is asked again, and a refusal
   * then pauses once more.
   */
  readonly maxFailurePause: Duration.Duration;
  /** The largest answer read; a larger one counts as unreadable. */
  readonly maxBodyBytes: number;
}

/** LRCLIB lookups for one song at a time. */
export interface Interface {
  /** Waits until a request may go out: the gap after the last one, or a pause, has passed. */
  readonly ready: Effect.Effect<void>;
  /**
   * The lyrics LRCLIB holds for a song, `None` when it has no matching record. A record without
   * lyrics comes back as `Empty`.
   */
  readonly lookup: (
    query: LookupQuery,
  ) => Effect.Effect<Option.Option<LrclibLyrics>, LrclibUnavailable | LrclibMalformed>;
}

/** The LRCLIB client. */
export class LrclibClient extends Context.Service<LrclibClient, Interface>()(
  "@music/media/LrclibClient",
) {}

/** The User-Agent LRCLIB asks clients to send: the app, its version, and where it lives. */
export const USER_AGENT = `music/${packageJson.version} (+https://github.com/lmdevv/music)`;

/** LRCLIB's `/api/get` matches lengths within this many seconds; search results must too. */
const DURATION_TOLERANCE_S = 2;

/** What one request got back, read no further than its status needs. */
type Fetched = Data.TaggedEnum<{
  /** A 200 and its body. */
  Body: { readonly text: string };
  /** A 200 whose body is larger than `maxBodyBytes`. */
  TooLarge: {};
  /** A 404: LRCLIB has no such record. */
  NotFound: {};
  /** Any other status, with its `Retry-After`; the body is never read. */
  Refused: { readonly status: number; readonly retryAfter: string | null };
}>;

const Fetched = Data.taggedEnum<Fetched>();

/** A request that got no answer. */
class NoAnswer extends Data.TaggedError("NoAnswer")<{
  readonly reason: "network" | "timeout";
  readonly cause: unknown;
}> {}

/** `Retry-After` as seconds or an HTTP date, in milliseconds from `now`. */
const retryAfterOf = (value: string, now: number): number | null => {
  const seconds = Number(value.trim());

  if (value.trim() !== "" && Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(value);

  return Number.isNaN(at) ? null : Math.max(0, at - now);
};

/** Reads `body` to its end, or gives up and returns null once it passes `limit` bytes. */
const readBounded = async (
  body: ReadableStream<Uint8Array> | null,
  limit: number,
): Promise<string | null> => {
  if (body === null) return "";
  const reader = body.getReader();
  const chunks: Array<Uint8Array> = [];

  const read = async (size: number): Promise<boolean> => {
    const chunk = await reader.read();

    if (chunk.done) return true;

    if (size + chunk.value.byteLength > limit) {
      await reader.cancel();

      return false;
    }

    chunks.push(chunk.value);

    return read(size + chunk.value.byteLength);
  };

  return (await read(0)) ? new TextDecoder().decode(Buffer.concat(chunks)) : null;
};

/**
 * One GET to LRCLIB. Its status decides at once whether the body is read at all, and the request
 * and the reading of its body share one abort signal, so a timeout hangs up on both.
 */
const fetchOnce = (options: Options, path: string, urlParams: Record<string, string>) =>
  Effect.tryPromise({
    try: async (signal): Promise<Fetched> => {
      const url = `${options.baseUrl}${path}?${new URLSearchParams(urlParams).toString()}`;

      const response = await fetch(url, {
        signal,
        headers: { "user-agent": options.userAgent, accept: "application/json" },
      });

      if (response.status !== 200) {
        await response.body?.cancel();

        return response.status === 404
          ? Fetched.NotFound()
          : Fetched.Refused({
              status: response.status,
              retryAfter: response.headers.get("retry-after"),
            });
      }

      const text = await readBounded(response.body, options.maxBodyBytes);

      return text === null ? Fetched.TooLarge() : Fetched.Body({ text });
    },
    catch: (cause) => new NoAnswer({ reason: "network", cause }),
  }).pipe(
    Effect.timeoutOrElse({
      duration: options.timeout,
      orElse: () => Effect.fail(new NoAnswer({ reason: "timeout", cause: null })),
    }),
  );

const SearchResult = Schema.Struct({
  trackName: Schema.String,
  artistName: Schema.String,
  duration: Schema.Finite,
  syncedLyrics: Schema.optionalKey(Schema.NullOr(Schema.String)),
});

const decodeSearch = Schema.decodeUnknownResult(
  Schema.fromJsonString(Schema.Array(Schema.Unknown)),
);

const decodeSearchResult = Schema.decodeUnknownResult(SearchResult);

/**
 * Whether a search result is the queried song: the same title and artist once normalized, and a
 * length within `DURATION_TOLERANCE_S`. Live, acoustic, and edit labels stay in titles, so those
 * recordings never match the studio song. Artists compare whole, featured artists aside:
 * punctuation inside a name, as in `AC/DC` or `Earth, Wind & Fire`, is no list of artists.
 */
const isStrictMatch = (
  query: LookupQuery,
  result: { readonly trackName: string; readonly artistName: string; readonly duration: number },
): boolean =>
  Math.abs(result.duration - query.durationS) <= DURATION_TOLERANCE_S &&
  normalizeLyricsTag(result.trackName) === normalizeLyricsTag(query.title) &&
  normalizeLyricsTag(result.artistName) === normalizeLyricsTag(query.artist);

/** Reads a record LRCLIB returned. Text it cannot read is a failure, never a miss. */
const parseRecord = (path: string, json: string) =>
  Effect.fromResult(parseLrclibRecord(json)).pipe(
    Effect.mapError((cause) => new LrclibMalformed({ path, cause })),
  );

/** The search results that are the queried song, with synced lyrics first; none unreadable. */
const searchMatches = (query: LookupQuery, text: string) => {
  const results = decodeSearch(text);

  if (Result.isFailure(results)) return Result.fail(results.failure);
  const decoded = Result.all(results.success.map((raw) => decodeSearchResult(raw)));

  if (Result.isFailure(decoded)) return Result.fail(decoded.failure);

  const matches = results.success.flatMap((raw, position) => {
    const result = decoded.success[position];

    return result !== undefined && isStrictMatch(query, result)
      ? [{ raw, synced: (result.syncedLyrics ?? "").trim() !== "" }]
      : [];
  });

  return Result.succeed([
    ...matches.filter((match) => match.synced),
    ...matches.filter((match) => !match.synced),
  ]);
};

/**
 * Builds the client. It calls `fetch` directly: the lint policy forbids Effect's unstable
 * `effect/http` modules, and one GET with a timeout needs none of their transforms.
 */
export const make = (options: Options) =>
  Effect.gen(function* () {
    const permit = yield* Semaphore.make(1);
    // When the next request may start, in epoch milliseconds.
    const nextAt = yield* Ref.make(0);
    // Requests in a row that found LRCLIB unavailable.
    const failures = yield* Ref.make(0);

    const untilTurn = Effect.gen(function* () {
      const wait = (yield* Ref.get(nextAt)) - (yield* Clock.currentTimeMillis);

      if (wait > 0) yield* Effect.sleep(Duration.millis(wait));
    });

    const holdFor = (pauseMs: number) =>
      Clock.currentTimeMillis.pipe(Effect.flatMap((now) => Ref.set(nextAt, now + pauseMs)));

    const answered = Ref.set(failures, 0).pipe(
      Effect.andThen(holdFor(Duration.toMillis(options.gap))),
    );

    /** Pauses every request after LRCLIB was unavailable, and says for how long. */
    const unavailable = (
      reason: LrclibUnavailable["reason"],
      status: number | null,
      retryAfter: string | null,
      cause: unknown,
    ) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const inARow = yield* Ref.updateAndGet(failures, (count) => count + 1);
        const retryAfterMs = retryAfter === null ? null : retryAfterOf(retryAfter, now);

        const backoff = Duration.toMillis(options.failurePause) * 2 ** (inARow - 1);

        const pauseMs = Math.max(
          Duration.toMillis(options.gap),
          Math.min(retryAfterMs ?? backoff, Duration.toMillis(options.maxFailurePause)),
        );

        yield* holdFor(pauseMs);

        return yield* new LrclibUnavailable({ reason, status, pauseMs, cause });
      });

    /** One request in turn: the body of a 200, or none for a 404. */
    const paced = (path: string, urlParams: Record<string, string>) =>
      permit.withPermits(1)(
        Effect.gen(function* () {
          yield* untilTurn;

          const fetched = yield* fetchOnce(options, path, urlParams).pipe(
            Effect.catchTag("NoAnswer", (error) =>
              unavailable(error.reason, null, null, error.cause),
            ),
          );

          return yield* Fetched.$match(fetched, {
            Body: ({ text }) => answered.pipe(Effect.as(Option.some(text))),
            NotFound: () => answered.pipe(Effect.as(Option.none<string>())),
            TooLarge: () =>
              answered.pipe(Effect.andThen(Effect.fail(new LrclibMalformed({ path })))),
            Refused: ({ status, retryAfter }) =>
              unavailable(
                status === 429 ? "rate_limited" : status >= 500 ? "server_error" : "rejected",
                status,
                retryAfter,
                null,
              ),
          });
        }),
      );

    const search = Effect.fn("LrclibClient.search")(function* (query: LookupQuery) {
      const path = "/api/search";
      const text = yield* paced(path, { track_name: query.title, artist_name: query.artist });

      if (Option.isNone(text)) return Option.none();
      const matches = searchMatches(query, text.value);

      if (Result.isFailure(matches)) {
        return yield* new LrclibMalformed({ path, cause: matches.failure });
      }

      const [match] = matches.success;

      if (match === undefined) return Option.none();

      return Option.some(yield* parseRecord(path, JSON.stringify(match.raw)));
    });

    const lookup = Effect.fn("LrclibClient.lookup")(function* (query: LookupQuery) {
      const path = "/api/get";

      const text = yield* paced(path, {
        track_name: query.title,
        artist_name: query.artist,
        album_name: query.album,
        duration: String(query.durationS),
      });

      if (Option.isSome(text)) return Option.some(yield* parseRecord(path, text.value));

      return yield* search(query);
    });

    return LrclibClient.of({ ready: permit.withPermits(1)(untilTurn), lookup });
  });

/** The pacing and bounds the service uses with LRCLIB at `baseUrl`: about three requests a second. */
export const productionOptions = (baseUrl: string): Options => ({
  baseUrl,
  userAgent: USER_AGENT,
  gap: Duration.millis(350),
  timeout: Duration.seconds(10),
  failurePause: Duration.seconds(30),
  maxFailurePause: Duration.hours(1),
  maxBodyBytes: 4 * 1024 * 1024,
});

/** `LrclibClient` over `fetch`, at the address `MediaConfig` names. */
export const layer: Layer.Layer<LrclibClient, never, MediaConfig> = Layer.effect(
  LrclibClient,
  Effect.gen(function* () {
    const config = yield* MediaConfig;

    return yield* make(productionOptions(config.lrclibUrl));
  }),
);
