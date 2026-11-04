import type { PlaybackSessionId } from "@media/contracts/ids";
import { PLAYBACK_TOKEN_LIFETIME_MS } from "@media/contracts/playback-token";
import {
  Cache,
  Context,
  Deferred,
  Duration,
  Effect,
  Layer,
  Option,
  Ref,
  ScopedCache,
  Stream,
} from "effect";

import * as SessionReports from "./session-reports.ts";
import { SessionReport } from "./stream-liveness.ts";

/** Tells ended playback sessions apart. */
export interface Interface {
  /**
   * Whether `sessionId` ended, or the owner of playback sessions has no such session. Questions
   * asked within five seconds of the first about a session wait for the owner's answer; without
   * one they answer no, and a later question hears the answer once it comes.
   */
  readonly isEnded: (sessionId: PlaybackSessionId) => Effect.Effect<boolean>;
  /** Whether `sessionId` is already known to have ended, without asking the owner. */
  readonly isKnownEnded: (sessionId: PlaybackSessionId) => Effect.Effect<boolean>;
}

/** The ended-session registry. */
export class Service extends Context.Service<Service, Interface>()("@media/server/EndedSessions") {}

const ANSWER_WAIT = Duration.seconds(5);

/**
 * Sessions followed at once; past it, the one asked about least recently is forgotten and
 * followed again when next asked about.
 */
const CAPACITY = 4096;

/**
 * Ends remembered at once, about 8 MB; past it, the end heard longest ago is forgotten. An end
 * costs no subscription, so more are kept than sessions are followed, and a session forgotten to
 * make room for others stays refused while the owner is unreachable.
 */
const ENDS_CAPACITY = 16_384;

/**
 * Follows each session it is asked about through the owner's report on that session alone, until
 * the session ends. Following the session itself, rather than a feed of ends ordered by when they
 * were stamped, sees an end however late it commits and wherever a restore or a clock step puts
 * its stamp, and no end waits on another session's.
 */
export const layer: Layer.Layer<Service, never, SessionReports.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const reports = yield* SessionReports.Service;
    const context = yield* Effect.context();

    // Filled as ends are heard, never looked up. An end is kept for as long as a token minted
    // before it could still be valid.
    const ends = yield* Cache.make<PlaybackSessionId, void>({
      lookup: () => Effect.void,
      capacity: ENDS_CAPACITY,
      timeToLive: Duration.millis(PLAYBACK_TOKEN_LIFETIME_MS),
    });

    const follow = Effect.fnUntraced(function* (sessionId: PlaybackSessionId) {
      const ended = yield* Ref.make(false);
      // Settles on the first answer or when the first wait runs out. A flag, not a deadline on
      // the wall clock, so a clock stepped back cannot start the wait again.
      const settled = yield* Deferred.make<void>();

      yield* reports.follow(sessionId).pipe(
        Stream.takeUntil(SessionReport.$is("Ended")),
        Stream.runForEach((report) =>
          SessionReport.$is("Ended")(report)
            ? Ref.set(ended, true).pipe(
                Effect.andThen(Cache.set(ends, sessionId, undefined)),
                Effect.andThen(Deferred.succeed(settled, undefined)),
              )
            : Deferred.succeed(settled, undefined),
        ),
        Effect.forkScoped,
      );

      yield* Deferred.await(settled).pipe(
        Effect.timeoutOption(ANSWER_WAIT),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.logWarning("EndedSessions.unanswered").pipe(
                Effect.annotateLogs({ sessionId }),
                Effect.andThen(Deferred.succeed(settled, undefined)),
              ),
            onSome: () => Effect.void,
          }),
        ),
        Effect.forkScoped,
      );

      return { ended, settled };
    });

    const followed = yield* ScopedCache.make({ lookup: follow, capacity: CAPACITY });
    const isKnownEnded = (sessionId: PlaybackSessionId) => Cache.has(ends, sessionId);

    return Service.of({
      isEnded: Effect.fn("EndedSessions.isEnded")(function* (sessionId) {
        if (yield* isKnownEnded(sessionId)) return true;

        // A follow forks from the fiber that asks first and outlives it, so it runs in this
        // layer's context rather than keeping that request's span and annotations.
        const session = yield* ScopedCache.get(followed, sessionId).pipe(
          Effect.updateContext<never, never>(() => context),
        );

        yield* Deferred.await(session.settled).pipe(Effect.timeoutOption(ANSWER_WAIT));

        return yield* Ref.get(session.ended);
      }),
      isKnownEnded,
    });
  }),
);

/** Standalone mode: no one owns playback sessions, so none ends. */
export const layerNone: Layer.Layer<Service> = Layer.succeed(
  Service,
  Service.of({ isEnded: () => Effect.succeed(false), isKnownEnded: () => Effect.succeed(false) }),
);
