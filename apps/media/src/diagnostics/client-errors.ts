/**
 * `POST /api/client-errors`: an app's unexpected error, written to the retained log at `WARN` as
 * `Client.error`. The caller's Convex auth token must belong to a signed-in session.
 *
 * Three budgets keep crash loops from rotating the log's history out: one for requests from
 * anyone, checked before Convex is asked who is calling; one per account; and one for every
 * account together, so many accounts at once still cannot. Every 30 s
 * `ClientErrors.suppressed` counts the reports each account, or anyone not yet known, sent over.
 */
import { ClientErrorReport, DIAGNOSTICS_ROUTES } from "@media/contracts/diagnostics";
import { RateLimited } from "@media/contracts/errors";
import type { UserId } from "@media/contracts/ids";
import type { Viewer } from "@media/contracts/models/account";
import { Clock, Duration, Effect, Layer, Option, Schedule } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import * as ViewerAuth from "../convex/viewer-auth.ts";
import { bearerOf, bodyDecoder, failureResponse } from "../http/command-routes.ts";
import { makeLimiter } from "../http/rate-limit.ts";

const ATTEMPT_BUDGET = { burst: 120, perSecond: 2 };

const ACCOUNT_BUDGET = { burst: 20, perSecond: 0.1 };

const ALL_ACCOUNTS_BUDGET = { burst: 50, perSecond: 0.2 };

const SUPPRESSED_REPORT_INTERVAL = Duration.seconds(30);

const decodeReport = bodyDecoder(ClientErrorReport, "Invalid error report");

const annotationsOf = (report: ClientErrorReport, viewer: Viewer) => ({
  source: "client",
  userId: viewer.user.id,
  platform: report.platform,
  appVersion: report.appVersion,
  kind: report.kind,
  route: report.route,
  errorName: report.name,
  errorMessage: report.message,
  stack: report.stack ?? null,
  failedRequestId: report.requestId ?? null,
  claimedSessionId: report.sessionId ?? null,
});

/** Adds the route. */
export const layer: Layer.Layer<never, never, HttpRouter.HttpRouter | ViewerAuth.Service> =
  Layer.effectDiscard(
    Effect.gen(function* () {
      const router = yield* HttpRouter.HttpRouter;
      const auth = yield* ViewerAuth.Service;
      const take = makeLimiter();
      const suppressed = new Map<UserId | null, number>();

      const refuse = (userId: UserId | null, seconds: number) => {
        suppressed.set(userId, (suppressed.get(userId) ?? 0) + 1);

        return new RateLimited({
          message: `Too many error reports: try again in ${String(seconds)} s`,
          retryAfterSeconds: seconds,
        });
      };

      const reportSuppressed = Effect.suspend(() => {
        const counted = [...suppressed];

        suppressed.clear();

        return Effect.forEach(
          counted,
          ([userId, reports]) =>
            Effect.logWarning("ClientErrors.suppressed").pipe(
              Effect.annotateLogs({ userId, reports }),
            ),
          { discard: true },
        );
      });

      yield* Effect.forkScoped(
        Effect.repeat(Effect.delay(reportSuppressed, SUPPRESSED_REPORT_INTERVAL), Schedule.forever),
      );

      const route = Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const attempt = take([["attempts", ATTEMPT_BUDGET]], yield* Clock.currentTimeMillis);

        if (Option.isSome(attempt)) return yield* refuse(null, attempt.value);

        const viewer = yield* auth.authorize(yield* bearerOf(request), "authenticated");

        const wait = take(
          [
            [`account\u0000${viewer.user.id}`, ACCOUNT_BUDGET],
            ["all-accounts", ALL_ACCOUNTS_BUDGET],
          ],
          yield* Clock.currentTimeMillis,
        );

        if (Option.isSome(wait)) return yield* refuse(viewer.user.id, wait.value);

        const report = yield* decodeReport(request);

        yield* Effect.logWarning("Client.error").pipe(
          Effect.annotateLogs(annotationsOf(report, viewer)),
        );

        return HttpServerResponse.empty({ status: 204 });
      }).pipe(
        Effect.catch((error) => Effect.succeed(failureResponse(error))),
        Effect.withSpan("ClientErrors.report"),
      );

      yield* router.add("POST", DIAGNOSTICS_ROUTES.clientErrors, route);
    }),
  );
