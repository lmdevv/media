import { admit } from "@media/contracts/rate-limit";
import type { Admission, AddressBucket, Door } from "@media/contracts/rate-limit";
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
const makeBucketStore = <B>(maxBuckets: number) => {
  const buckets = new Map<string, B>();

  return {
    /** Takes `key`'s bucket out, making room for it as the most recently used. */
    take: (key: string): B | undefined => {
      const previous = buckets.get(key);

      buckets.delete(key);

      if (buckets.size >= maxBuckets) {
        const oldest = buckets.keys().next();

        if (oldest.done !== true) buckets.delete(oldest.value);
      }

      return previous;
    },
    keep: (key: string, bucket: B): void => {
      buckets.set(key, bucket);
    },
  };
};

export const makeLimiter = (maxBuckets = MAX_BUCKETS) => {
  const buckets = makeBucketStore<Bucket>(maxBuckets);

  return (
    keyed: ReadonlyArray<readonly [key: string, budget: Budget]>,
    now: number,
    cost = 1,
  ): Option.Option<number> => {
    const refilled = keyed.map(([key, budget]) => {
      const previous = buckets.take(key) ?? { tokens: budget.burst, updatedAt: now };

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
      buckets.keep(key, { tokens: waits.length === 0 ? tokens - cost : tokens, updatedAt: now });
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
 * The client a request came from. The installs put Caddy in front on loopback, and Caddy always
 * sets `X-Forwarded-For` to the client it resolved (through MEDIA_TRUSTED_PROXIES), so the header
 * counts only from a loopback peer, and only its last entry. A client that reaches the service
 * directly is its own peer, whatever header it sends.
 */
export const clientAddress = (
  peer: Option.Option<string>,
  forwardedFor: string | undefined,
): string => {
  const direct = Option.getOrElse(peer, () => "unknown");
  const forwarded = isLoopback(direct) ? forwardedFor?.split(",").at(-1)?.trim() : undefined;

  return forwarded === undefined || forwarded === "" ? direct : forwarded;
};

interface LimitedRequest {
  readonly pathname: string;
  readonly peer: Option.Option<string>;
  readonly forwardedFor: string | undefined;
}

/**
 * The seconds `request` must wait, or none, by its `clientAddress`. The one caller never limited
 * is a loopback peer without the header: the container's health check, which bypasses Caddy, since
 * every request through Caddy carries it.
 */
export const limitRequest = (
  take: ReturnType<typeof makeLimiter>,
  request: LimitedRequest,
  now: number,
): Option.Option<number> => {
  const limited = BUDGETS.find(([prefix]) => request.pathname.startsWith(prefix));

  if (limited === undefined) return Option.none();

  if (
    isLoopback(Option.getOrElse(request.peer, () => "unknown")) &&
    request.forwardedFor === undefined
  ) {
    return Option.none();
  }

  const [prefix, budget] = limited;

  return take(
    [[`${prefix}\u0000${clientAddress(request.peer, request.forwardedFor)}`, budget]],
    now,
  );
};

/**
 * One bucket per door of `@media/contracts/rate-limit` and client address, kept as `makeLimiter`
 * keeps its buckets, deciding each call with the contract's `admit`.
 */
export const makeDoors = (maxBuckets = MAX_BUCKETS) => {
  const buckets = makeBucketStore<AddressBucket>(maxBuckets);

  return (door: Door, address: string, now: number): Admission => {
    const key = `${door}\u0000${address}`;
    const admission = admit(door, buckets.take(key), now);

    buckets.keep(key, admission.bucket);

    return admission;
  };
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
