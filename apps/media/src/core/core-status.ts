import { serverFunctions } from "@media/contracts/server-functions";
import type { ServerReport } from "@media/contracts/server-functions";
import { EpochMillis } from "@media/contracts/units";
import { Clock, Duration, Effect, Layer, Option, Ref, Schedule } from "effect";

import packageJson from "../../package.json" with { type: "json" };
import * as BackendHealth from "../backend-health.ts";
import * as HardwareAcceleration from "../playback/hardware-acceleration.ts";
import * as StreamSessions from "../playback/stream-sessions.ts";
import * as CoreSession from "./core-session.ts";

const LOOK_EVERY = Duration.seconds(15);

/** A report goes out when anything changed, and at least this often so admins see it is current. */
const HEARTBEAT = Duration.minutes(5);

const same = (left: ServerReport, right: ServerReport): boolean =>
  left.version === right.version &&
  left.hardwareAcceleration === right.hardwareAcceleration &&
  left.activeStreams === right.activeStreams &&
  left.runsAwaitingExit === right.runsAwaitingExit &&
  left.startedAt === right.startedAt;

/**
 * Reports the server's version, hardware transcoding, streams, and unexited runs to the core
 * for admins' `core.server.status`, in place of old movies' server page reading `/api/health`.
 */
export const layer: Layer.Layer<
  never,
  never,
  CoreSession.Service | StreamSessions.Service | HardwareAcceleration.Service
> = Layer.effectDiscard(
  Effect.gen(function* () {
    const session = yield* CoreSession.Service;
    const sessions = yield* StreamSessions.Service;
    const hardware = yield* HardwareAcceleration.Service;
    const startedAt = EpochMillis.make(yield* Clock.currentTimeMillis);

    const sent = yield* Ref.make<{ readonly report: ServerReport; readonly at: number } | null>(
      null,
    );

    const look = Effect.gen(function* () {
      const report: ServerReport = {
        version: packageJson.version,
        hardwareAcceleration: (yield* hardware.encoder) ?? "none",
        activeStreams: yield* sessions.activeCount,
        runsAwaitingExit: yield* sessions.runsAwaitingExit,
        startedAt,
      };

      const now = yield* Clock.currentTimeMillis;
      const last = yield* Ref.get(sent);

      if (
        last !== null &&
        same(last.report, report) &&
        now - last.at < Duration.toMillis(HEARTBEAT)
      ) {
        return;
      }

      yield* session.call(serverFunctions.reportStatus, report);
      yield* Ref.set(sent, { report, at: now });
    }).pipe(Effect.catch((error) => Effect.logDebug("CoreStatus.report_failed", error)));

    yield* look.pipe(Effect.repeat(Schedule.spaced(LOOK_EVERY)), Effect.forkScoped);
  }),
);

const PROBE_EVERY = Duration.seconds(30);

const PROBE_TIMEOUT = Duration.seconds(10);

/**
 * The health route's `backend`: `connected` while the core accepts the server's key and answered
 * its latest probe, `connecting` otherwise. The probe asks about a session that cannot exist, a
 * new one each time, so the core answers it itself rather than from a cached subscription.
 */
export const healthLayer: Layer.Layer<BackendHealth.Service, never, CoreSession.Service> =
  Layer.effect(
    BackendHealth.Service,
    Effect.gen(function* () {
      const session = yield* CoreSession.Service;
      const answered = yield* Ref.make(false);

      const probe = Effect.gen(function* () {
        const at = yield* Clock.currentTimeMillis;

        const answer = yield* session
          .call(serverFunctions.sessionStatus, { userId: "probe", sessionId: `probe${String(at)}` })
          .pipe(Effect.timeoutOption(PROBE_TIMEOUT), Effect.option);

        yield* Ref.set(answered, Option.isSome(Option.flatten(answer)));
      });

      yield* probe.pipe(Effect.repeat(Schedule.spaced(PROBE_EVERY)), Effect.forkScoped);

      return BackendHealth.Service.of({
        status: Effect.gen(function* () {
          const signedIn = (yield* session.status) === "signed-in";

          return signedIn && (yield* Ref.get(answered)) ? "connected" : "connecting";
        }),
      });
    }),
  );
