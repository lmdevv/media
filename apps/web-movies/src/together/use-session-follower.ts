import type { SessionClock } from "@media/contracts/clock";
import { run } from "@media/contracts/follower";
import type {
  Follower,
  FollowerPlayer,
  FollowerState,
  SessionPort,
  ViewerMove,
} from "@media/contracts/follower";
import { usePlatform } from "@media/sdk/react";
import { describeFailure } from "@media/ui/lib/failure";
import { Data, Effect, Exit, Fiber, Option, Stream } from "effect";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useLatest } from "@/lib/use-latest";

import { MOVIES } from "./session";

/** The session refused or could not take a call; `message` says why, for the viewer. */
class SessionCallFailed extends Data.TaggedError("SessionCallFailed")<{
  readonly message: string;
}> {}

const failed = (cause: unknown): SessionCallFailed =>
  new SessionCallFailed({ message: describeFailure(cause) });

/** What the player hands the follower. */
export interface FollowingInput {
  /** The player once its playback runs; null before, which stops following. */
  readonly player: FollowerPlayer | null;
  /** The session's newest clock. */
  readonly clock: SessionClock;
  /** The length of the playing media, or null while unknown. */
  readonly durationMs: number | null;
  /** Whether the viewer may control the session now. */
  readonly controls: boolean;
  /** Whether the viewer hosts the session, whose player pauses it while it stalls. */
  readonly hosting: boolean;
}

/** The player's follower, for the screen. */
export interface Following {
  /** Where it stands, or null until it has started. */
  readonly state: FollowerState | null;
  /**
   * Plays, pauses, or seeks for everyone at once. Resolves with why the session refused the move,
   * whose player returns to the session's clock, or null once it moved.
   */
  readonly move: (move: ViewerMove) => Promise<SessionCallFailed | null>;
}

/**
 * Follows the session's clock with `player` while it plays (ADR 0017). Each new clock the session
 * delivers is applied in revision order; an older one changes nothing. Stops when the player goes
 * away or the screen unmounts, putting the player back at the session's rate.
 */
export const useSessionFollower = ({
  player,
  clock,
  durationMs,
  controls,
  hosting,
}: FollowingInput): Following => {
  const platform = usePlatform();
  const [state, setState] = useState<FollowerState | null>(null);
  const follower = useRef<Follower<SessionCallFailed> | null>(null);
  const latest = useLatest({ clock, controls });
  const known = durationMs !== null && durationMs > 0;

  const port = useMemo(
    (): SessionPort<SessionCallFailed> => ({
      heartbeat: Effect.tryPromise({
        try: () => platform.core.together.heartbeat({ domain: MOVIES }),
        catch: failed,
      }),
      control: (move) =>
        Effect.tryPromise({
          try: () => platform.core.together.control({ domain: MOVIES, op: move }),
          catch: failed,
        }),
    }),
    [platform],
  );

  useEffect(() => {
    if (player === null || !known) return undefined;

    const fiber = Effect.runFork(
      Effect.scoped(
        Effect.gen(function* () {
          const running = yield* run({
            player,
            port,
            clock: latest.current.clock,
            durationMs,
            controls: latest.current.controls,
            pausesForStalls: hosting,
          });

          follower.current = running;
          yield* running.apply(latest.current.clock);
          yield* Stream.runForEach(running.state, (next) => Effect.sync(() => setState(next)));
        }),
      ),
    );

    return () => {
      follower.current = null;
      setState(null);
      Effect.runFork(Fiber.interrupt(fiber));
    };
  }, [player, port, durationMs, known, hosting, latest]);

  useEffect(() => {
    const running = follower.current;

    if (running !== null) Effect.runFork(running.apply(clock));
  }, [clock]);

  useEffect(() => {
    const running = follower.current;

    if (running !== null) Effect.runFork(running.allow(controls));
  }, [controls]);

  const move = useCallback(async (next: ViewerMove): Promise<SessionCallFailed | null> => {
    const running = follower.current;

    if (running === null) return null;

    const exit = await Effect.runPromiseExit(running.move(next));

    return Exit.isSuccess(exit) ? null : Option.getOrNull(Exit.findErrorOption(exit));
  }, []);

  return { state, move };
};
