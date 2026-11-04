import { Playback } from "@media/sdk/effect";
import { Data, Option, Schema } from "effect";

/** What Convex says about a playback session, parsed at the adapter. */
export type SessionReport = Data.TaggedEnum<{
  Active: { readonly state: "playing" | "paused"; readonly positionMs: number };
  /** Ended, or no such session. */
  Ended: {};
}>;

/** Constructors and matchers for `SessionReport`. */
export const SessionReport = Data.taggedEnum<SessionReport>();

/**
 * What this service last heard about a stream's session. `progressAt` is when the reported
 * position last moved while playing, kept through a pause or an end so a close can say how long
 * ago the player last made progress.
 */
export type Liveness = Data.TaggedEnum<{
  /** Standalone mode, or no answer yet. */
  Unknown: {};
  Playing: { readonly positionMs: number; readonly progressAt: number };
  Paused: { readonly progressAt: Option.Option<number> };
  Ended: { readonly progressAt: Option.Option<number> };
}>;

/** Constructors and matchers for `Liveness`. */
export const Liveness = Data.taggedEnum<Liveness>();

const progressOf = Liveness.$match({
  Unknown: () => Option.none<number>(),
  Playing: ({ progressAt }) => Option.some(progressAt),
  Paused: ({ progressAt }) => progressAt,
  Ended: ({ progressAt }) => progressAt,
});

/**
 * Folds a report into what was known, at local time `now`. A re-delivered or unchanged report
 * changes nothing, and progress means the reported position moved: Convex's own timestamps are
 * never compared with this service's clock.
 */
export const hear = (previous: Liveness, report: SessionReport, now: number): Liveness =>
  SessionReport.$match(report, {
    Ended: () =>
      Liveness.$is("Ended")(previous)
        ? previous
        : Liveness.Ended({ progressAt: progressOf(previous) }),
    Active: ({ state, positionMs }) => {
      if (state === "paused") {
        return Liveness.$is("Paused")(previous)
          ? previous
          : Liveness.Paused({ progressAt: progressOf(previous) });
      }

      return Liveness.$is("Playing")(previous) && previous.positionMs === positionMs
        ? previous
        : Liveness.Playing({ positionMs, progressAt: now });
    },
  });

/**
 * A stream's requests. Requests count themselves in before they read the encoder and out after
 * they answer, stamping `lastRequestAt` both times.
 */
export interface Use {
  readonly inFlight: number;
  readonly lastRequestAt: number;
  /** The latest expiry of any token that reached the stream; no request can arrive after it. */
  readonly expiresAt: number;
}

/**
 * Three missed progress reports make progress stale. Players report every
 * `Playback.PROGRESS_INTERVAL_MS` while playing.
 */
export const PROGRESS_FRESH_MS = 3 * Playback.PROGRESS_INTERVAL_MS;

/** The strongest evidence that someone uses a stream, strongest first. */
export const LivenessState = Schema.Literals([
  "requesting",
  "recent",
  "playing",
  "paused",
  "stale",
  "ended",
  "unknown",
]);

/** The strongest evidence that someone uses a stream. */
export type LivenessState = typeof LivenessState.Type;

/** A stream's liveness at one moment, logged on every encoder release and every stream close. */
export const Snapshot = Schema.Struct({
  liveness: LivenessState,
  inFlight: Schema.Finite,
  lastRequestAgeMs: Schema.Finite,
  /** Since the reported position last moved; null unless Convex reported playing at least once. */
  lastProgressAgeMs: Schema.NullOr(Schema.Finite),
});

/** A stream's liveness at one moment. */
export interface Snapshot extends Schema.Schema.Type<typeof Snapshot> {}

const stateOf = (use: Use, liveness: Liveness, now: number, idleMs: number): LivenessState => {
  if (use.inFlight > 0) return "requesting";

  if (now - use.lastRequestAt < idleMs) return "recent";

  return Liveness.$match(liveness, {
    Playing: ({ progressAt }): LivenessState =>
      now - progressAt < PROGRESS_FRESH_MS ? "playing" : "stale",
    Paused: (): LivenessState => "paused",
    Ended: (): LivenessState => "ended",
    Unknown: (): LivenessState => "unknown",
  });
};

/** The stream's liveness at `now`; `idleMs` is `STREAM_IDLE_SECONDS`. */
export const snapshot = (use: Use, liveness: Liveness, now: number, idleMs: number): Snapshot => ({
  liveness: stateOf(use, liveness, now, idleMs),
  inFlight: use.inFlight,
  lastRequestAgeMs: now - use.lastRequestAt,
  lastProgressAgeMs: Option.getOrNull(Option.map(progressOf(liveness), (at) => now - at)),
});

const HOLDING: ReadonlySet<LivenessState> = new Set(["requesting", "recent", "playing"]);

/** Whether the snapshot keeps the encoder running. Throttling never enters into it. */
export const holdsEncoder = (moment: Snapshot): boolean => HOLDING.has(moment.liveness);

/**
 * Whether the stream can close as expired: nothing uses it and every token that reached it has
 * expired, so no request can arrive.
 */
export const isExpired = (use: Use, now: number): boolean =>
  use.inFlight === 0 && now >= use.expiresAt;

const UNATTENDED_IDLE_PERIODS = 10;

/**
 * Whether a stream released at `releasedAt` can close as unattended: no session report ever
 * reached it, as in standalone mode, and nothing used it for `UNATTENDED_IDLE_PERIODS` idle
 * periods since the release. A paused or stale session is left to Convex, which ends abandoned
 * sessions itself.
 */
export const isUnattended = (
  use: Use,
  liveness: Liveness,
  releasedAt: number,
  now: number,
  idleMs: number,
): boolean =>
  use.inFlight === 0 &&
  Liveness.$is("Unknown")(liveness) &&
  now - Math.max(releasedAt, use.lastRequestAt) >= UNATTENDED_IDLE_PERIODS * idleMs;
