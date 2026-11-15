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
  /** The session followed; another one starts a new follower, as its clock starts over. */
  readonly sessionId: string | null;
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
 * away or the screen unmounts, putting the player back at the session's rate. A follower started
 * again for the same screen, as after a stream reload, takes over its predecessor's hold on the
 * session.
 */
export const useSessionFollower = ({
  player,
  sessionId,
  clock,
  durationMs,
  controls,
  hosting,
}: FollowingInput): Following => {
  const platform = usePlatform();
  const [state, setState] = useState<FollowerState | null>(null);
  const follower = useRef<Follower<SessionCallFailed> | null>(null);
  const hold = useRef<number | null>(null);
  const latest = useLatest({ clock, controls, durationMs });
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

  const heldIn = useRef<string | null>(null);

  useEffect(() => {
    if (player === null || !known || sessionId === null) return undefined;

    // A hold belongs to its session: a follower of another one starts without it.
    if (heldIn.current !== sessionId) hold.current = null;
    heldIn.current = sessionId;

    const fiber = Effect.runFork(
      Effect.scoped(
        Effect.gen(function* () {
          const running = yield* run({
            player,
            port,
            clock: latest.current.clock,
            durationMs: () => latest.current.durationMs,
            controls: latest.current.controls,
            pausesForStalls: hosting,
            resumeHold: hold.current,
          });

          follower.current = running;
          yield* running.allow(latest.current.controls);
          yield* running.apply(latest.current.clock);
          yield* Stream.runForEach(running.state, (next) =>
            Effect.sync(() => {
              hold.current = next.holding?.kind === "held" ? next.holding.revision : null;
              setState(next);
            }),
          );
        }),
      ),
    );

    return () => {
      follower.current = null;
      setState(null);
      Effect.runFork(Fiber.interrupt(fiber));
    };
  }, [player, port, known, hosting, sessionId, latest]);

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
