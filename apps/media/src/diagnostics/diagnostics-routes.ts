import { type LogQuery, MAX_LOG_LIMIT } from "@media/contracts/diagnostics";
import { NotFound, RateLimited } from "@media/contracts/errors";
import { EpochMillis } from "@media/contracts/units";
import {
  Clock,
  Duration,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Predicate,
  References,
  Struct,
} from "effect";
import type { HttpRouter } from "effect/http";

import * as CoreCallers from "../core/core-callers.ts";
import { commandRoute } from "../http/command-routes.ts";
import { makeLimiter } from "../http/rate-limit.ts";
import * as LogReader from "../logging/log-reader.ts";
import * as RetainedLogs from "../logging/retained-logs.ts";
import { driftFor, ownersOf, sessionsOf, timelineOf } from "./timeline.ts";

const RECENT = Duration.days(1);

const MAX_SESSIONS = 50;

const READ_BUDGET = { burst: 10, perSecond: 0.2 };

const namesSession: LogReader.Keep = (record) =>
  Predicate.isString(record.annotations["sessionId"]);

/** Adds the routes. */
export const layer: Layer.Layer<
  never,
  never,
  | HttpRouter.HttpRouter
  | CoreCallers.Service
  | RetainedLogs.Service
  | FileSystem.FileSystem
  | Path.Path
> = Layer.effectDiscard(
  Effect.gen(function* () {
    const retained = yield* RetainedLogs.Service;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const take = makeLimiter();

    const allowRead = (caller: CoreCallers.Caller) =>
      Clock.currentTimeMillis.pipe(
        Effect.flatMap((now) =>
          Option.match(
            CoreCallers.isAdmin(caller) ? Option.none() : take([[caller.userId, READ_BUDGET]], now),
            {
              onNone: () => Effect.void,
              onSome: (seconds) =>
                Effect.fail(
                  new RateLimited({
                    message: `Too many diagnostics reads: try again in ${String(seconds)} s`,
                    retryAfterSeconds: seconds,
                  }),
                ),
            },
          ),
        ),
      );

    const read = (filter: Pick<LogQuery, "sessionId" | "since" | "grep">, keep?: LogReader.Keep) =>
      LogReader.read(
        {
          sessionId: filter.sessionId,
          since: filter.since,
          grep: filter.grep,
          level: "INFO",
          limit: MAX_LOG_LIMIT,
        },
        keep,
      ).pipe(
        Effect.scoped,
        Effect.provideService(RetainedLogs.Service, retained),
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
      );

    yield* commandRoute(
      "diagnostics.playback",
      Effect.fn("DiagnosticsRoutes.playback")(function* ({ sessionId, measuredDrift }, caller) {
        yield* allowRead(caller);
        const found = yield* read({ sessionId });
        const records = found.matches.map((match) => match.record);
        const owners = ownersOf(records);

        const allowed =
          CoreCallers.isAdmin(caller) ||
          (owners.size > 0 && [...owners].every((id) => id === caller.userId));

        const logLevel = yield* References.MinimumLogLevel;

        const timeline = allowed
          ? timelineOf(sessionId, records, found.truncated, logLevel)
          : Option.none();

        if (Option.isNone(timeline)) {
          return yield* new NotFound({
            message: `No playback records for session ${sessionId} in the retained logs`,
          });
        }

        return Struct.evolve(timeline.value, {
          drift: (drift) => driftFor(drift, measuredDrift === true),
        });
      }),
    );

    yield* commandRoute(
      "diagnostics.sessions",
      Effect.fn("DiagnosticsRoutes.sessions")(function* ({ since }, caller) {
        yield* allowRead(caller);
        const now = yield* Clock.currentTimeMillis;

        const found = yield* read(
          {
            since: since ?? EpochMillis.make(Math.max(0, now - Duration.toMillis(RECENT))),
            grep: CoreCallers.isAdmin(caller) ? '"sessionId"' : caller.userId,
          },
          namesSession,
        );

        return sessionsOf(found.matches.map((match) => match.record))
          .filter((session) => CoreCallers.isAdmin(caller) || session.userId === caller.userId)
          .slice(0, MAX_SESSIONS);
      }),
    );
  }),
);
