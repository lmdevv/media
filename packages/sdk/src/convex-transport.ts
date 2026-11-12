import type { FunctionPath } from "@media/contracts/command";
import {
  CommandFailure,
  commandError,
  Internal,
  NotFound,
  Unauthenticated,
} from "@media/contracts/errors";
import { ConvexClient, ConvexHttpClient } from "convex/browser";
import type { AuthTokenFetcher } from "convex/browser";
import type { FunctionReference } from "convex/server";
import { makeFunctionReference } from "convex/server";
import { ConvexError } from "convex/values";
import {
  Cause,
  Context,
  Data,
  Duration,
  Effect,
  Equivalence,
  Layer,
  Option,
  Queue,
  Result,
  Schema,
  Stream,
} from "effect";

import type { CallError } from "./sdk-errors";
import { ProtocolError, TransportError } from "./sdk-errors";

/** How a Convex function runs. */
export type FunctionKind = "query" | "mutation" | "action";

/** Encoded arguments: every command takes one JSON object. */
export type WireArgs = Schema.JsonObject;

/**
 * A token as the session handed it out: the session it belongs to and the session's generation
 * then. A refusal is read back against it, so a refusal of an older token never refreshes or ends
 * a newer session, and a request one person made is never sent again as another.
 */
export interface IssuedToken {
  readonly token: string;
  /** The session the token was minted for, named by its subject; none for a token without one. */
  readonly session: Option.Option<string>;
  /** The session's generation when it handed the token out. */
  readonly generation: number;
}

/**
 * Supplies the token for a request, or null when signed out. With `refused`, the server rejected
 * that token: the source renews the session unless it has moved on since, then answers the token
 * to send now.
 */
export type AuthTokenSource = (refused: Option.Option<IssuedToken>) => Promise<IssuedToken | null>;

/** A source that always answers `token`, for a caller that holds one token of its own. */
export const fixedToken =
  (token: string): AuthTokenSource =>
  () =>
    Promise.resolve({ token, session: Option.none(), generation: 0 });

/** The token a request carried, as far as its connection can tell. */
export type SentWith = Data.TaggedEnum<{
  /** The request carried `issued`, or went out signed out when none. */
  Token: { readonly issued: Option.Option<IssuedToken> };
  /**
   * The connection's token changed, or was being fetched, while the request was out, so which
   * token it carried is not known. A refusal of it says nothing about the session held now.
   */
  Unsettled: {};
}>;

/** Constructors and matchers for `SentWith`. */
export const SentWith = Data.taggedEnum<SentWith>();

/**
 * Told the token a request carried, each time the connection learns it. A connection that cannot
 * tell yet says nothing.
 */
export type Attached = (sent: SentWith) => void;

const attachNothing: Attached = () => undefined;

/**
 * Whether two tokens' subjects name one session. Tokens without a subject cannot be told apart,
 * so they count as one session.
 */
export const sameSession = Option.makeEquivalence(Equivalence.strictEqual<string>());

/** Stops a subscription. */
export type Unsubscribe = () => void;

/**
 * The calls one Convex client offers, as plain Promises and callbacks. Adapters reject with
 * whatever the client threw; `ConvexTransport` translates it.
 */
export interface ClientAdapter {
  /** Runs a function once; a query stops once `signal` aborts. */
  readonly call: (
    kind: FunctionKind,
    path: FunctionPath,
    args: WireArgs,
    signal: AbortSignal,
    attached: Attached,
  ) => Promise<Schema.Json>;
  /** Every result of a query; `attached` hears the token each result or failure answered. */
  readonly subscribe: (
    path: FunctionPath,
    args: WireArgs,
    onValue: (value: Schema.Json) => void,
    onError: (error: Error) => void,
    attached: Attached,
  ) => Unsubscribe;
  /** Resolves once the client uses `source`, or no source when null. */
  readonly setAuth: (source: AuthTokenSource | null) => Promise<void>;
  /**
   * Resolves once the server has answered the client's current token source, accepting or
   * refusing it; at once for a client that authenticates each request, or that has no source.
   */
  readonly authenticated: () => Promise<void>;
  readonly close: () => Promise<void>;
}

/** Calls Convex functions by path with typed failures. */
export interface Interface {
  /** Runs a query, mutation, or action once; `attached` hears the token it was sent with. */
  readonly call: (
    kind: FunctionKind,
    path: FunctionPath,
    args: WireArgs,
    attached?: Attached,
  ) => Effect.Effect<Schema.Json, CallError>;
  /**
   * Every result of a query as it changes; `attached` hears the token each result or failure
   * answered. The stream ends only by failing or being interrupted.
   */
  readonly subscribe: (
    path: FunctionPath,
    args: WireArgs,
    attached?: Attached,
  ) => Stream.Stream<Schema.Json, CallError>;
  /** Uses `source` for the auth token of every later call; null signs the connection out. */
  readonly setAuth: (source: AuthTokenSource | null) => Effect.Effect<void>;
  /**
   * Waits until the server has answered the connection's current token source, so a call made
   * then runs as that session and no answer from before reaches it. A connection that
   * authenticates each request, or has no source, does not wait.
   */
  readonly authenticated: Effect.Effect<void>;
}

/** The connection to the [movies] Convex deployment. */
export class ConvexTransport extends Context.Service<ConvexTransport, Interface>()(
  "@media/sdk/ConvexTransport",
) {}

const HttpFailure = Schema.Struct({ code: Schema.String, message: Schema.String });

const decodeHttpFailure = Schema.decodeUnknownOption(Schema.fromJsonString(HttpFailure));

const decodeCommandFailure = Schema.decodeUnknownResult(CommandFailure);

const AUTH_FAILURE = /auth|token|jwt|identity/iu;

const isTokenRejection = (error: Error): boolean => {
  const http = decodeHttpFailure(error.message);

  return Option.isSome(http) && AUTH_FAILURE.test(http.value.code);
};

const ID_VALIDATION_FAILURES = [
  /ArgumentValidationError[\s\S]*^Validator: v\.id\("[^"]+"\)$/mu,
  /ArgumentValidationError: Found ID "[^"]*" from table `[^`]*`, which does not match the table name in validator `v\.id\("[^"]+"\)`/u,
] as const;

const isRejectedId = (message: string): boolean =>
  ID_VALIDATION_FAILURES.some((pattern) => pattern.test(message));

/**
 * Translates what a Convex client threw. `ConvexError` data carries a command failure; a token
 * Convex could not verify means the session is gone; an argument that is not an ID of its table
 * names no record, so the call is not found, whichever of its ID arguments it was (screens
 * that pass several IDs check the others first, as `RequireProfile` does for the profile); any
 * other "Server Error" is a function that crashed; anything else is the network.
 */
export const translateFailure = (operation: string, cause: unknown): CallError => {
  if (cause instanceof ConvexError) {
    const failure = decodeCommandFailure(cause.data);

    return Result.isSuccess(failure)
      ? commandError(failure.success)
      : new ProtocolError({
          operation,
          message: `Protocol error in ${operation}: the server's failure carries no known code`,
          cause,
        });
  }

  if (!(cause instanceof Error)) {
    return new TransportError({
      operation,
      message: `Transport failed during ${operation}`,
      cause,
    });
  }

  if (isTokenRejection(cause)) {
    return new Unauthenticated({ message: "The server rejected the session; sign in again" });
  }

  if (isRejectedId(cause.message)) {
    return new NotFound({ message: "No such item: nothing has that ID" });
  }

  if (cause.message.includes("Server Error")) {
    return new Internal({ message: `The server failed while running ${operation}` });
  }

  return new TransportError({
    operation,
    message: `Transport failed during ${operation}: ${cause.message}`,
    cause,
  });
};

const toError = (cause: unknown): Error =>
  cause instanceof Error ? cause : new Error("Convex client failure", { cause });

/** Builds the transport over one client adapter. The adapter closes when the scope does. */
export const make = (adapter: ClientAdapter): Effect.Effect<Interface> =>
  Effect.succeed(
    ConvexTransport.of({
      call: Effect.fn("ConvexTransport.call")(function* (
        kind,
        path,
        args,
        attached = attachNothing,
      ) {
        return yield* Effect.tryPromise({
          try: (signal) => adapter.call(kind, path, args, signal, attached),
          catch: (cause) => translateFailure(path, cause),
        });
      }),
      subscribe: (path, args, attached = attachNothing) =>
        Stream.callback<Schema.Json, CallError>((queue) =>
          Effect.acquireRelease(
            Effect.sync(() =>
              adapter.subscribe(
                path,
                args,
                (value) => {
                  Queue.offerUnsafe(queue, value);
                },
                (error) => {
                  Queue.failCauseUnsafe(queue, Cause.fail(translateFailure(path, error)));
                },
                attached,
              ),
            ),
            (unsubscribe) => Effect.sync(unsubscribe),
          ),
        ),
      setAuth: (source) => Effect.promise(() => adapter.setAuth(source)),
      authenticated: Effect.promise(() => adapter.authenticated()),
    }),
  );

/** A reference to the public function at `path`, for calling it by path. */
export const reference = <Kind extends FunctionKind>(
  kind: Kind,
  path: FunctionPath,
): FunctionReference<Kind, "public", WireArgs, Schema.Json> =>
  makeFunctionReference<Kind, WireArgs, Schema.Json>(path);

interface OneShotClient {
  readonly query: (
    query: FunctionReference<"query", "public", WireArgs, Schema.Json>,
    args: WireArgs,
  ) => Promise<Schema.Json>;
  readonly mutation: (
    mutation: FunctionReference<"mutation", "public", WireArgs, Schema.Json>,
    args: WireArgs,
  ) => Promise<Schema.Json>;
  readonly action: (
    action: FunctionReference<"action", "public", WireArgs, Schema.Json>,
    args: WireArgs,
  ) => Promise<Schema.Json>;
}

/** Runs the function at `path` once on `client`, as the `kind` of function it is. */
export const callByKind = (
  client: OneShotClient,
  kind: FunctionKind,
  path: FunctionPath,
  args: WireArgs,
): Promise<Schema.Json> => {
  if (kind === "query") return client.query(reference("query", path), args);

  if (kind === "mutation") return client.mutation(reference("mutation", path), args);

  return client.action(reference("action", path), args);
};

/**
 * The first result of the query at `path`, read through `subscribe`. A Convex WebSocket client
 * keeps a query until it is answered or unsubscribed, and sends it again each time it reconnects,
 * so the query is unsubscribed as soon as `signal` aborts, as when its caller stops waiting.
 */
export const queryOnce = (
  subscribe: ClientAdapter["subscribe"],
  path: FunctionPath,
  args: WireArgs,
  signal: AbortSignal,
): Promise<Schema.Json> =>
  new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(toError(signal.reason));

      return;
    }

    const done = new AbortController();
    let unsubscribe: Unsubscribe | undefined;

    const settle = (finish: () => void): void => {
      if (done.signal.aborted) return;
      done.abort();
      unsubscribe?.();
      finish();
    };

    signal.addEventListener(
      "abort",
      () => {
        settle(() => reject(toError(signal.reason)));
      },
      { signal: done.signal },
    );
    unsubscribe = subscribe(
      path,
      args,
      (value) => {
        settle(() => resolve(value));
      },
      (error) => {
        settle(() => reject(error));
      },
      attachNothing,
    );

    // A client holding the answer already may hand it over before `subscribe` returns.
    if (done.signal.aborted) unsubscribe();
  });

const FIRST_REFETCH_DELAY_MS = 1000;

const MAX_REFETCH_DELAY_MS = 30_000;

const sleep = (millis: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) {
      resolve();

      return;
    }

    const wake = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", wake);
      resolve();
    };

    const timer = setTimeout(wake, millis);

    signal.addEventListener("abort", wake);
  });

const unlessAborted = <A>(promise: Promise<A>, signal: AbortSignal): Promise<A | null> =>
  new Promise<A | null>((resolve, reject) => {
    if (signal.aborted) {
      resolve(null);

      return;
    }

    const abort = (): void => {
      resolve(null);
    };

    signal.addEventListener("abort", abort);
    promise
      .finally(() => {
        signal.removeEventListener("abort", abort);
      })
      .then(resolve, reject);
  });

/** Resolves once every callback already queued, timers and promise reactions alike, has run. */
const nextTask = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

const signedOut: AuthTokenFetcher = () => Promise.resolve(null);

/** The token a fetcher's client holds: none until it has answered, null for none. */
interface HeldToken {
  held: Option.Option<IssuedToken | null>;
  /**
   * Whether the server has answered the source yet. Until it has, the client's results may still
   * come from before it, under the token it replaced.
   */
  answered: boolean;
  /** Resolves once `answered`. */
  readonly settled: Promise<void>;
  readonly answer: () => void;
  /** Moves on each time the fetcher hands the client a different token. */
  version: number;
  /** Fetches out now. */
  fetching: number;
}

/** What a client's fetchers hold at one moment, to compare with a later one. */
interface FetcherMoment {
  readonly state: HeldToken | null;
  readonly held: Option.Option<IssuedToken | null>;
  readonly version: number;
  /** A fetch or a new fetcher is on its way, so the client's token may change at any moment. */
  readonly busy: boolean;
}

/**
 * The token a request carried, from the client's fetchers as it went out (`start`) and as it was
 * answered (`end`). A WebSocket client authenticates its connection, not each request, so a
 * request carried the token held at `start` only when the client held that one token throughout.
 */
const sentOver = (start: FetcherMoment, end: FetcherMoment): SentWith =>
  start.state === end.state &&
  start.version === end.version &&
  !start.busy &&
  !end.busy &&
  start.state?.answered !== false &&
  Option.isSome(start.held)
    ? SentWith.Token({ issued: Option.fromNullishOr(start.held.value) })
    : SentWith.Unsettled();

/**
 * Token fetchers for one Convex WebSocket client, which keeps its session by one rule: a fetch
 * with `forceRefreshToken` returns a token other than the one it holds, or null to sign out.
 * Handed the same token back, the client decides refreshing failed and never schedules another
 * refresh; once that token expires, Convex closes every connection that presents it without the
 * auth error that would make the client ask again, so the connection stays down.
 *
 * The same token comes back when a refresh fails for a while, since the session keeps its token,
 * and when a refresh lands in the second the token was minted, since Convex Auth signs to the
 * second. So a forced fetch asks again, waiting longer each time, until it gets a new token or
 * none; a source whose refresh can never succeed must answer none in the end, as `Auth` does once
 * the server has failed every refresh for a while. Each ask names the token refused last, so the
 * source tries again rather than share the refresh that kept it. `install` and `retire` end every
 * earlier fetcher at once: its fetches answer null and its source is never asked again. `held`
 * names the token the client uses now: none until the newest source has answered, and null while
 * it has no source.
 */
export const clientTokenFetchers = () => {
  let generation = new AbortController();
  const fetching = new Set<Promise<string | null>>();
  let installing = Promise.resolve();
  let installs = 0;
  // What the newest fetcher holds; null while the client has no source.
  let newest: HeldToken | null = null;

  const retire = (): void => {
    generation.abort();
    generation = new AbortController();
  };

  const fetcherFor = (source: AuthTokenSource, signal: AbortSignal) => {
    // The client keeps only the answer of the fetch it started last, so that answer is the token
    // it holds, and an older fetch still asking can stop: its answer will be discarded.
    const answering = { resolve: (): void => undefined };

    const settled = new Promise<void>((resolve) => {
      answering.resolve = resolve;
    });

    const state: HeldToken = {
      held: Option.none(),
      answered: false,
      settled,
      answer: () => {
        state.answered = true;
        answering.resolve();
      },
      version: 0,
      fetching: 0,
    };

    let latest = 0;

    const heldToken = (): IssuedToken | null => Option.getOrNull(state.held);

    const renewed = async (
      fetch: number,
      refused: IssuedToken | null,
      delay: number,
    ): Promise<IssuedToken | null> => {
      if (delay > 0) await sleep(delay, signal);

      if (signal.aborted || fetch !== latest) return null;
      const issued = await unlessAborted(source(Option.fromNullishOr(refused)), signal);

      if (issued === null || issued.token !== heldToken()?.token || fetch !== latest) {
        return issued;
      }

      return renewed(
        fetch,
        issued,
        Math.min(Math.max(delay * 2, FIRST_REFETCH_DELAY_MS), MAX_REFETCH_DELAY_MS),
      );
    };

    const retired = (): boolean => signal.aborted;

    const fetchToken = async (forceRefreshToken: boolean): Promise<string | null> => {
      if (retired()) return null;
      latest += 1;
      const fetch = latest;

      const issued = forceRefreshToken
        ? await renewed(fetch, heldToken(), 0)
        : await unlessAborted(source(Option.none()), signal);

      // Clearing auth leaves the client's scheduled refresh in place, so a retired fetcher can
      // still be asked after a sign-out, and must not hand the old session back.
      if (retired()) return null;

      if (fetch === latest) {
        if (issued?.token !== heldToken()?.token || Option.isNone(state.held)) state.version += 1;
        state.held = Option.some(issued);
      }

      return issued?.token ?? null;
    };

    const fetcher: AuthTokenFetcher = ({ forceRefreshToken }) => {
      const answer = fetchToken(forceRefreshToken);

      state.fetching += 1;
      fetching.add(answer);
      void answer
        .finally(() => {
          state.fetching -= 1;
          fetching.delete(answer);
        })
        .catch(() => undefined);

      return answer;
    };

    return { fetcher, state };
  };

  /**
   * Retires every earlier fetcher, then hands `apply` the fetcher for `source`, or null to sign
   * out, once the client has had the answers the retired fetchers owed it. An answer that lands
   * after the client gets a new fetcher is ignored, and when the client stopped its connection to
   * wait for that answer, it never restarts the connection.
   */
  const install = (
    source: AuthTokenSource | null,
    apply: (fetcher: AuthTokenFetcher | null, answered: () => void) => void,
  ): Promise<void> => {
    retire();
    const { signal } = generation;
    const made = source === null ? null : fetcherFor(source, signal);
    const owed = [...fetching];
    const previous = installing;

    installs += 1;

    const installed = (async () => {
      await previous;
      await Promise.allSettled(owed);
      await nextTask();

      if (signal.aborted) return;
      apply(made?.fetcher ?? null, () => made?.state.answer());
      // The client takes its token from this fetcher from now on, and from the last one until now.
      newest = made?.state ?? null;
    })().finally(() => {
      installs -= 1;
    });

    installing = installed.catch(() => undefined);

    return installed;
  };

  return {
    install,
    retire,
    moment: (): FetcherMoment => ({
      state: newest,
      held: newest === null ? Option.some(null) : newest.held,
      version: newest?.version ?? 0,
      busy: installs > 0 || (newest !== null && (newest.fetching > 0 || !newest.answered)),
    }),
    authenticated: async (): Promise<void> => {
      await installing;
      await newest?.settled;
    },
  };
};

/**
 * `subscribe` over a client whose fetchers are `fetchers`. Each result or failure answers the
 * token held since the last result, or since the query started, when the client held only that
 * one; otherwise it is unsettled, since the client runs the query again under each token it takes.
 */
export const heldSubscribe =
  (
    fetchers: ReturnType<typeof clientTokenFetchers>,
    subscribe: (
      path: FunctionPath,
      args: WireArgs,
      onValue: (value: Schema.Json) => void,
      onError: (error: Error) => void,
    ) => Unsubscribe,
  ): ClientAdapter["subscribe"] =>
  (path, args, onValue, onError, attached) => {
    let since = fetchers.moment();

    const settle = (): void => {
      const now = fetchers.moment();

      attached(sentOver(since, now));
      since = now;
    };

    return subscribe(
      path,
      args,
      (value) => {
        settle();
        onValue(value);
      },
      (error) => {
        settle();
        onError(error);
      },
    );
  };

/**
 * `call` over a client whose fetchers are `fetchers`: once answered, a call carried the token held
 * as it went out when the client held only that one meanwhile, and is unsettled otherwise.
 */
export const heldCall =
  (
    fetchers: ReturnType<typeof clientTokenFetchers>,
    call: (
      kind: FunctionKind,
      path: FunctionPath,
      args: WireArgs,
      signal: AbortSignal,
    ) => Promise<Schema.Json>,
  ): ClientAdapter["call"] =>
  (kind, path, args, signal, attached) => {
    const start = fetchers.moment();

    const settle = (): void => {
      attached(sentOver(start, fetchers.moment()));
    };

    return call(kind, path, args, signal).finally(settle);
  };

const webSocketAdapter = (client: ConvexClient): ClientAdapter => {
  const fetchers = clientTokenFetchers();

  const subscribe = heldSubscribe(fetchers, (path, args, onValue, onError) =>
    client.onUpdate(reference("query", path), args, onValue, (error) => {
      onError(toError(error));
    }),
  );

  return {
    call: heldCall(fetchers, (kind, path, args, signal) =>
      kind === "query"
        ? queryOnce(subscribe, path, args, signal)
        : callByKind(client, kind, path, args),
    ),
    subscribe,
    setAuth: (source) =>
      fetchers.install(source, (fetcher, answered) => {
        client.setAuth(fetcher ?? signedOut, answered);
      }),
    authenticated: fetchers.authenticated,
    close: () => {
      fetchers.retire();

      return client.close();
    },
  };
};

/** Options for the fetch-based transport. */
export interface HttpOptions {
  /** How often a subscription reads its query again. */
  readonly pollInterval: Duration.Duration;
}

const valueKey = (value: Schema.Json): string => JSON.stringify(value);

/**
 * Adapts the fetch-based client. It has no subscriptions, so `subscribe` polls and reports
 * changed results. Each request reads the token as it leaves and sends it once: a refusal is the
 * session's to judge (D51), never a reason to send the request again. Mutations leave one at a
 * time in the order they were called, as the client's own queue keeps them, but the token each
 * carries is read as it leaves rather than when it was queued.
 */
const httpAdapter = (client: ConvexHttpClient, options: HttpOptions): ClientAdapter => {
  let source: AuthTokenSource | null = null;
  let mutations: Promise<unknown> = Promise.resolve();

  // The client reads its token synchronously as a request starts, so the token set here is the
  // one on the wire.
  const send = async (
    kind: FunctionKind,
    path: FunctionPath,
    args: WireArgs,
    attached: Attached,
  ): Promise<Schema.Json> => {
    const issued = source === null ? null : await source(Option.none());

    if (issued === null) client.clearAuth();
    else client.setAuth(issued.token);
    attached(SentWith.Token({ issued: Option.fromNullishOr(issued) }));

    if (kind === "query") return client.query(reference("query", path), args);

    if (kind === "action") return client.action(reference("action", path), args);

    return client.mutation(reference("mutation", path), args, { skipQueue: true });
  };

  const call = (
    kind: FunctionKind,
    path: FunctionPath,
    args: WireArgs,
    _signal: AbortSignal,
    attached: Attached,
  ): Promise<Schema.Json> => {
    if (kind !== "mutation") return send(kind, path, args, attached);
    const turn = mutations.then(() => send(kind, path, args, attached));

    mutations = turn.catch(() => undefined);

    return turn;
  };

  const subscribe = (
    path: FunctionPath,
    args: WireArgs,
    onValue: (value: Schema.Json) => void,
    onError: (error: Error) => void,
    attached: Attached,
  ): Unsubscribe => {
    let stopped = false;
    let last: string | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = async (): Promise<void> => {
      try {
        const value = await call("query", path, args, new AbortController().signal, attached);

        if (stopped) return;
        const key = valueKey(value);

        if (key !== last) {
          last = key;
          onValue(value);
        }

        timer = setTimeout(() => void poll(), Duration.toMillis(options.pollInterval));
      } catch (cause) {
        if (!stopped) onError(toError(cause));
      }
    };

    void poll();

    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  };

  return {
    call,
    subscribe,
    setAuth: (next) => {
      source = next;

      return Promise.resolve();
    },
    authenticated: () => Promise.resolve(),
    close: () => Promise.resolve(),
  };
};

/**
 * The transport over the adapter `acquire` opens, closed with the layer's scope. Closing stops
 * the adapter's token refreshes, so a closed connection never asks its token source again.
 */
export const layerFromAdapter = <E>(
  acquire: Effect.Effect<ClientAdapter, E>,
): Layer.Layer<ConvexTransport, E> =>
  Layer.effect(
    ConvexTransport,
    Effect.acquireRelease(acquire, (adapter) => Effect.promise(() => adapter.close())).pipe(
      Effect.flatMap(make),
    ),
  );

const openAdapter = (open: () => ClientAdapter): Effect.Effect<ClientAdapter, TransportError> =>
  Effect.try({
    try: open,
    catch: (cause) =>
      new TransportError({
        operation: "ConvexTransport.open",
        message: "Transport failed to open: the Convex URL is not valid",
        cause,
      }),
  });

/** A WebSocket connection to `url`: pushed subscriptions and automatic token refresh. */
export const layerWebSocket = (url: string): Layer.Layer<ConvexTransport, TransportError> =>
  layerFromAdapter(
    openAdapter(() =>
      webSocketAdapter(new ConvexClient(url, { logger: false, unsavedChangesWarning: false })),
    ),
  );

/** One-shot HTTP calls to `url`; subscriptions poll. Suits short-lived processes such as the CLI. */
export const layerHttp = (
  url: string,
  options: HttpOptions = { pollInterval: Duration.seconds(1) },
): Layer.Layer<ConvexTransport, TransportError> =>
  layerFromAdapter(
    openAdapter(() => httpAdapter(new ConvexHttpClient(url, { logger: false }), options)),
  );
