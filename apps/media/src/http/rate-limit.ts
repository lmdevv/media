import { Clock, Effect, Layer, Option } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

interface Budget {
  readonly burst: number;
  readonly perSecond: number;
}

const BUDGETS: ReadonlyArray<readonly [prefix: string, budget: Budget]> = [
  ["/artwork/", { burst: 600, perSecond: 100 }],
  ["/api/health", { burst: 60, perSecond: 10 }],
  ["/api/client-config", { burst: 60, perSecond: 10 }],
];

const MAX_BUCKETS = 10_000;

interface Bucket {
  readonly tokens: number;
  readonly updatedAt: number;
}

/**
 * Token buckets by key, refilled lazily. At `maxBuckets` the least recently used bucket is
 * forgotten (a quiet address, which has refilled anyway), so many new addresses cannot reset the
 * busy ones.
 */
export const makeLimiter = (maxBuckets = MAX_BUCKETS) => {
  const buckets = new Map<string, Bucket>();

  return (
    keyed: ReadonlyArray<readonly [key: string, budget: Budget]>,
    now: number,
    cost = 1,
  ): Option.Option<number> => {
    const refilled = keyed.map(([key, budget]) => {
      const previous = buckets.get(key) ?? { tokens: budget.burst, updatedAt: now };

      buckets.delete(key);

      if (buckets.size >= maxBuckets) {
        const oldest = buckets.keys().next();

        if (oldest.done !== true) buckets.delete(oldest.value);
      }

      const tokens = Math.min(
        budget.burst,
        previous.tokens + ((now - previous.updatedAt) / 1000) * budget.perSecond,
      );

      return { key, budget, tokens };
    });

    const waits = refilled.flatMap(({ budget, tokens }) =>
      tokens < cost ? [Math.ceil((cost - tokens) / budget.perSecond)] : [],
    );

    for (const { key, tokens } of refilled) {
      buckets.set(key, { tokens: waits.length === 0 ? tokens - cost : tokens, updatedAt: now });
    }

    return waits.length === 0 ? Option.none() : Option.some(Math.max(...waits));
  };
};

/** `response` telling its client to wait `seconds` before it tries again. */
export const retryAfter = (
  response: HttpServerResponse.HttpServerResponse,
  seconds: number,
): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.setHeader(response, "retry-after", String(seconds));

const isLoopback = (address: string): boolean =>
  address === "::1" || address.startsWith("127.") || address.startsWith("::ffff:127.");

/**
 * The client a request came from. The installs put Caddy in front on loopback, and Caddy replaces
 * `X-Forwarded-For` with the address it accepted the connection from, so the header is trusted
 * only from a loopback peer, and only its last entry, the one the proxy wrote. A client that
 * reaches the service directly is its own peer, whatever header it sends.
 */
const clientAddress = (peer: Option.Option<string>, forwardedFor: string | undefined): string => {
  const direct = Option.getOrElse(peer, () => "unknown");

  if (!isLoopback(direct) || forwardedFor === undefined) return direct;
  const appended = forwardedFor.split(",").at(-1)?.trim() ?? "";

  return appended === "" ? direct : appended;
};

interface LimitedRequest {
  readonly pathname: string;
  readonly peer: Option.Option<string>;
  readonly forwardedFor: string | undefined;
}

/**
 * The seconds `request` must wait, or none. Requests from inside the install, such as the
 * container's health check, are never limited: no remote client can appear as loopback.
 */
export const limitRequest = (
  take: ReturnType<typeof makeLimiter>,
  request: LimitedRequest,
  now: number,
): Option.Option<number> => {
  const limited = BUDGETS.find(([prefix]) => request.pathname.startsWith(prefix));

  if (limited === undefined) return Option.none();
  const address = clientAddress(request.peer, request.forwardedFor);

  if (isLoopback(address)) return Option.none();
  const [prefix, budget] = limited;

  return take([[`${prefix}\u0000${address}`, budget]], now);
};

/** Limits the unauthenticated routes by client address. */
export const layer: Layer.Layer<never, never, HttpRouter.HttpRouter> = Layer.unwrap(
  Effect.sync(() => {
    const take = makeLimiter();

    return HttpRouter.middleware(
      (httpEffect) =>
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;

          const wait = limitRequest(
            take,
            {
              pathname: new URL(request.url, "http://media.invalid").pathname,
              peer: request.remoteAddress,
              forwardedFor: request.headers["x-forwarded-for"],
            },
            yield* Clock.currentTimeMillis,
          );

          return Option.isSome(wait)
            ? retryAfter(
                HttpServerResponse.text("Too many requests", {
                  status: 429,
                  headers: { "cache-control": "no-store" },
                }),
                wait.value,
              )
            : yield* httpEffect;
        }),
      { global: true },
    );
  }),
);
