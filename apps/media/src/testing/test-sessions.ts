import { Clock, Context, Effect, Layer, Stream, SubscriptionRef } from "effect";

import * as SessionReports from "../playback/session-reports.ts";
import { SessionReport } from "../playback/stream-liveness.ts";

/** Playback sessions as a test scripts them: players' reports and session ends. */
export interface Interface {
  /** Records a player's report for `sessionId`, as a progress tick, a pause, or a resume would. */
  readonly report: (
    sessionId: string,
    state: "playing" | "paused",
    positionMs: number,
  ) => Effect.Effect<void>;
  /** Ends `sessionId`, as a stop, a sign-out, or an idle sweep would. */
  readonly end: (sessionId: string) => Effect.Effect<void>;
  /**
   * What a follower of `sessionId` hears: its session again on every change to any session. A
   * session exists once a test reports or ends it; before that it reads as ended, as an unknown
   * session does.
   */
  readonly follow: SessionReports.Interface["follow"];
}

export class Service extends Context.Service<Service, Interface>()(
  "@media/server/test/TestSessions",
) {}

interface Play {
  readonly state: "playing" | "paused";
  readonly positionMs: number;
  readonly endedAt: number | null;
}

const CREATED: Play = { state: "paused", positionMs: 0, endedAt: null };

const reportOf = (play: Play | undefined): SessionReport =>
  play === undefined || play.endedAt !== null
    ? SessionReport.Ended()
    : SessionReport.Active({ state: play.state, positionMs: play.positionMs });

/** The scripted sessions, with nothing following them. */
export const layer: Layer.Layer<Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const plays = yield* SubscriptionRef.make<ReadonlyMap<string, Play>>(new Map());

    const change = (sessionId: string, edit: (play: Play) => Play) =>
      SubscriptionRef.update(plays, (current) =>
        new Map(current).set(sessionId, edit(current.get(sessionId) ?? CREATED)),
      );

    return Service.of({
      report: Effect.fn("TestSessions.report")(function* (sessionId, state, positionMs) {
        yield* change(sessionId, (play) => ({ state, positionMs, endedAt: play.endedAt }));
      }),
      end: Effect.fn("TestSessions.end")(function* (sessionId) {
        const now = yield* Clock.currentTimeMillis;

        yield* change(sessionId, (play) => ({
          state: play.state,
          positionMs: play.positionMs,
          endedAt: now,
        }));
      }),
      follow: (sessionId) =>
        SubscriptionRef.changes(plays).pipe(
          Stream.map((current) => reportOf(current.get(sessionId))),
        ),
    });
  }),
);

/** Session reports that follow the scripted sessions. */
export const reportsLayer: Layer.Layer<SessionReports.Service, never, Service> = Layer.effect(
  SessionReports.Service,
  Effect.map(Service, (sessions) => SessionReports.Service.of({ follow: sessions.follow })),
);
