/**
 * `POST /api/app-events`: a batch of an iOS app's launches, screen opens, and errors, written to
 * the retained log as `App.launched` and `App.screenOpened` at `INFO`, and `Client.error` at `WARN`,
 * or `ERROR` for an error that ended the app. The caller's core session token must belong to a
 * signed-in session.
 *
 * Three budgets keep a crash loop or a stuck reporter from rotating the log's history out: one for
 * requests from anyone, checked before the core is asked who is calling; one per account; and one
 * for every account together. The last two count events, not batches. Every 30 s
 * `AppEvents.suppressed` counts the events each account, or anyone not yet known, sent over.
 */
import {
  AppEvent,
  AppEventsRequest,
  DIAGNOSTICS_ROUTES,
  type QueuedAppEvent,
} from "@media/contracts/diagnostics";
import { RateLimited } from "@media/contracts/errors";
import type { UserId } from "@media/contracts/ids";
import { Clock, Duration, Effect, Layer, Option, Schedule } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import * as CoreCallers from "../core/core-callers.ts";
import { bearerOf, bodyDecoder, failureResponse } from "../http/command-routes.ts";
import { makeLimiter } from "../http/rate-limit.ts";

const ATTEMPT_BUDGET = { burst: 120, perSecond: 2 };

const ACCOUNT_BUDGET = { burst: 200, perSecond: 1 };

const ALL_ACCOUNTS_BUDGET = { burst: 600, perSecond: 4 };

const SUPPRESSED_REPORT_INTERVAL = Duration.seconds(30);

const decodeRequest = bodyDecoder(AppEventsRequest, "Invalid app events");

const commonFields = (
  request: AppEventsRequest,
  queued: QueuedAppEvent,
  caller: CoreCallers.Caller,
  receivedAt: number,
) => ({
  userId: caller.userId,
  platform: request.platform,
  app: request.app,
  appVersion: request.release,
  development: request.development,
  occurredAt: new Date(receivedAt - queued.ageMs).toISOString(),
});

const logEvent = (event: AppEvent, fields: ReturnType<typeof commonFields>) =>
  AppEvent.match(event, {
    Launched: ({ kind, firstFrameMs, home }) =>
      Effect.logInfo("App.launched").pipe(
        Effect.annotateLogs({
          source: "app",
          ...fields,
          launch: kind,
          firstFrameMs,
          homeMs: home?.ms ?? null,
          homeSource: home?.source ?? null,
        }),
      ),
    ScreenOpened: ({ screen, id, durationMs }) =>
      Effect.logInfo("App.screenOpened").pipe(
        Effect.annotateLogs({ source: "app", ...fields, screen, recordId: id, openMs: durationMs }),
      ),
    ErrorCaught: ({ kind, fatal, route, name, message, stack, requestId }) =>
      (fatal ? Effect.logError("Client.error") : Effect.logWarning("Client.error")).pipe(
        Effect.annotateLogs({
          source: "client",
          ...fields,
          kind,
          fatal,
          route,
          errorName: name,
          errorMessage: message,
          stack: stack ?? null,
          failedRequestId: requestId ?? null,
        }),
      ),
  });

/** Adds the route. */
export const layer: Layer.Layer<never, never, HttpRouter.HttpRouter | CoreCallers.Service> =
  Layer.effectDiscard(
    Effect.gen(function* () {
      const router = yield* HttpRouter.HttpRouter;
      const auth = yield* CoreCallers.Service;
      const take = makeLimiter();
      const suppressed = new Map<UserId | null, number>();

      const refuse = (userId: UserId | null, events: number, seconds: number) => {
        suppressed.set(userId, (suppressed.get(userId) ?? 0) + events);

        return new RateLimited({
          message: `Too many app events: try again in ${String(seconds)} s`,
          retryAfterSeconds: seconds,
        });
      };

      const reportSuppressed = Effect.suspend(() => {
        const counted = [...suppressed];

        suppressed.clear();

        return Effect.forEach(
          counted,
          ([userId, events]) =>
            Effect.logWarning("AppEvents.suppressed").pipe(Effect.annotateLogs({ userId, events })),
          { discard: true },
        );
      });

      yield* Effect.forkScoped(
        Effect.repeat(Effect.delay(reportSuppressed, SUPPRESSED_REPORT_INTERVAL), Schedule.forever),
      );

      const route = Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const attempt = take([["attempts", ATTEMPT_BUDGET]], yield* Clock.currentTimeMillis);

        if (Option.isSome(attempt)) return yield* refuse(null, 1, attempt.value);

        const caller = yield* auth.authorize(yield* bearerOf(request), "authenticated");
        const batch = yield* decodeRequest(request);
        const receivedAt = yield* Clock.currentTimeMillis;

        const wait = take(
          [
            [`account\u0000${caller.userId}`, ACCOUNT_BUDGET],
            ["all-accounts", ALL_ACCOUNTS_BUDGET],
          ],
          receivedAt,
          batch.events.length,
        );

        if (Option.isSome(wait)) {
          return yield* refuse(caller.userId, batch.events.length, wait.value);
        }

        yield* Effect.forEach(
          batch.events,
          (queued) => logEvent(queued.event, commonFields(batch, queued, caller, receivedAt)),
          { discard: true },
        );

        return HttpServerResponse.empty({ status: 204 });
      }).pipe(
        Effect.catch((error) => Effect.succeed(failureResponse(error))),
        Effect.withSpan("AppEvents.report"),
      );

      yield* router.add("POST", DIAGNOSTICS_ROUTES.appEvents, route);
    }),
  );
