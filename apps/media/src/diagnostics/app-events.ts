/**
 * `POST /api/app-events`: a batch of an iOS app's launches, screen opens, and errors, written to
 * the retained log as `App.launched` and `App.screenOpened` at `INFO`, and `Client.error` at `WARN`,
 * or `ERROR` for an error that ended the app. The caller's core session token must belong to a
 * signed-in session. The body's size is settled before anything reads it: a body must declare its
 * length, which Node's parser then holds it to, and that length must be within
 * `MAX_APP_EVENTS_BYTES`; a chunked body is refused with 411 and a longer one with 413.
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
  MAX_APP_EVENTS_BYTES,
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

const refuseBody = (status: 411 | 413, message: string) =>
  Option.some(
    HttpServerResponse.jsonUnsafe(
      { code: status === 411 ? "length_required" : "too_large", message },
      { status, headers: { "cache-control": "no-store" } },
    ),
  );

/** Why `request`'s body is refused before it is read, or none when its declared length fits. */
const bodyRefusal = (request: HttpServerRequest.HttpServerRequest) => {
  if (request.headers["transfer-encoding"] !== undefined) {
    return refuseBody(411, "Send the batch with a Content-Length");
  }

  return Number(request.headers["content-length"] ?? "0") <= MAX_APP_EVENTS_BYTES
    ? Option.none()
    : refuseBody(413, "The batch is too large");
};

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
    Launched: ({ firstScreenVisibleMs, homeContent }) =>
      Effect.logInfo("App.launched").pipe(
        Effect.annotateLogs({
          source: "app",
          ...fields,
          launch: "cold",
          firstScreenVisibleMs,
          homeContentVisibleMs: homeContent?.ms ?? null,
          homeSource: homeContent?.source ?? null,
        }),
      ),
    ScreenOpened: ({ screen, id, cache, contentVisibleMs }) =>
      Effect.logInfo("App.screenOpened").pipe(
        Effect.annotateLogs({
          source: "app",
          ...fields,
          screen,
          recordId: id,
          cache,
          contentVisibleMs,
        }),
      ),
    ErrorCaught: ({ kind, fatal, route, errorClass, frames, requestId }) =>
      (fatal ? Effect.logError("Client.error") : Effect.logWarning("Client.error")).pipe(
        Effect.annotateLogs({
          source: "client",
          ...fields,
          kind,
          fatal,
          route,
          errorClass,
          frames: frames.map(
            ({ fn, file, line, column }) => `${fn} ${file}:${String(line)}:${String(column)}`,
          ),
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

        const refusal = bodyRefusal(request);

        if (Option.isSome(refusal)) return refusal.value;

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
