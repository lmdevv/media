import { MediaFileId, PlaybackSessionId } from "@media/contracts/ids";
import type { SessionStatus } from "@media/contracts/models/scan";
import { EpochMillis, Milliseconds } from "@media/contracts/units";
import { Clock, Context, Effect, Layer, Stream, SubscriptionRef } from "effect";

import type * as MediaBackend from "../convex/media-backend.ts";
import * as MemoryBackend from "./memory-backend.ts";

/** Convex as a test scripts it: players' reports and session ends, as subscriptions see them. */
export interface Interface {
  /** Records a player's report for `sessionId`, as a progress tick, a pause, or a resume would. */
  readonly report: (
    sessionId: string,
    state: "playing" | "paused",
    positionMs: number,
  ) => Effect.Effect<void>;
  /** Ends `sessionId`, as a stop, a sign-out, or the idle sweep would. */
  readonly end: (sessionId: string) => Effect.Effect<void>;
}

/** The scripted Convex. */
export class Service extends Context.Service<Service, Interface>()(
  "@media/server/test/TestConvex",
) {}

interface Play {
  readonly state: "playing" | "paused";
  readonly positionMs: number;
  readonly endedAt: number | null;
}

const FILE = MediaFileId.make("test-file");

const CREATED: Play = { state: "paused", positionMs: 0, endedAt: null };

const statusOf = (sessionId: string, play: Play): SessionStatus => ({
  sessionId: PlaybackSessionId.make(sessionId),
  status: play.endedAt === null ? "active" : "ended",
  fileId: FILE,
  endedAt: play.endedAt === null ? null : EpochMillis.make(play.endedAt),
  state: play.state,
  positionMs: Milliseconds.make(play.positionMs),
});

/**
 * The scripted Convex and a connected backend whose `sessionStatus` subscriptions follow it. A
 * session exists once a test reports or ends it; before that `sessionStatus` answers null, as
 * Convex does for no such session.
 */
export const layer: Layer.Layer<Service | MediaBackend.Service> = Layer.unwrap(
  Effect.gen(function* () {
    const plays = yield* SubscriptionRef.make<ReadonlyMap<string, Play>>(new Map());

    const change = (sessionId: string, edit: (play: Play) => Play) =>
      SubscriptionRef.update(plays, (current) =>
        new Map(current).set(sessionId, edit(current.get(sessionId) ?? CREATED)),
      );

    const control = Service.of({
      report: Effect.fn("TestConvex.report")(function* (sessionId, state, positionMs) {
        yield* change(sessionId, (play) => ({ state, positionMs, endedAt: play.endedAt }));
      }),
      end: Effect.fn("TestConvex.end")(function* (sessionId) {
        const now = yield* Clock.currentTimeMillis;

        yield* change(sessionId, (play) => ({
          state: play.state,
          positionMs: play.positionMs,
          endedAt: now,
        }));
      }),
    });

    const backend = MemoryBackend.layer(
      {},
      {
        "mediaService.sessionStatus": ({ sessionId }) =>
          SubscriptionRef.changes(plays).pipe(
            Stream.map((current) => {
              const play = current.get(sessionId);

              return play === undefined ? null : statusOf(sessionId, play);
            }),
          ),
      },
    );

    return Layer.merge(Layer.succeed(Service, control), backend);
  }),
);
