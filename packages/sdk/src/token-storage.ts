import { Context, Effect, Layer, Option, Queue, Redacted, Ref, Schema, Stream } from "effect";

/** A Convex Auth session: the short-lived JWT and the refresh token that renews it. */
export interface StoredSession {
  readonly token: Redacted.Redacted;
  readonly refreshToken: Redacted.Redacted;
}

/** Reading or writing the token store failed. */
export class TokenStorageError extends Schema.TaggedError<TokenStorageError>()(
  "TokenStorageError",
  {
    operation: Schema.Literals(["load", "save", "clear"]),
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

/** Persists the current session's tokens. */
export interface Interface {
  /** The stored session; none when signed out or when the stored value is unreadable. */
  readonly load: Effect.Effect<Option.Option<StoredSession>, TokenStorageError>;
  readonly save: (session: StoredSession) => Effect.Effect<void, TokenStorageError>;
  readonly clear: Effect.Effect<void, TokenStorageError>;
  /**
   * Emits once it starts listening, then whenever the stored session may have changed outside
   * this client, such as another tab writing the same key. The first emission covers changes made
   * before it listened. Never emits for a store that cannot tell.
   */
  readonly changed: Stream.Stream<void>;
}

/** The token store the SDK's auth reads and writes. */
export class TokenStorage extends Context.Service<TokenStorage, Interface>()(
  "@media/sdk/TokenStorage",
) {}

/** Keeps the session in memory only; a new process starts signed out. */
export const layerMemory: Layer.Layer<TokenStorage> = Layer.effect(
  TokenStorage,
  Effect.gen(function* () {
    const current = yield* Ref.make(Option.none<StoredSession>());

    return TokenStorage.of({
      load: Ref.get(current),
      save: (session) => Ref.set(current, Option.some(session)),
      clear: Ref.set(current, Option.none()),
      changed: Stream.never,
    });
  }),
);

/**
 * A synchronous or asynchronous string store, such as `window.localStorage` or AsyncStorage.
 * Methods may throw or reject; the adapter turns that into `TokenStorageError`.
 */
export interface KeyValueStore {
  readonly getItem: (key: string) => string | null | Promise<string | null>;
  readonly setItem: (key: string, value: string) => void | Promise<void>;
  readonly removeItem: (key: string) => void | Promise<void>;
  /**
   * Calls `onChange` when `key` may have changed underneath this client, such as another tab
   * writing `localStorage`, and returns the unsubscribe. A store without it is read only at start,
   * so it suits a store that one client owns.
   */
  readonly subscribe?: (key: string, onChange: () => void) => () => void;
}

const SerializedSession = Schema.fromJsonString(
  Schema.Struct({ token: Schema.String, refreshToken: Schema.String }),
);

const decodeSession = Schema.decodeUnknownOption(SerializedSession);

const encodeSession = Schema.encodeSync(SerializedSession);

/** Parses a stored session, treating unreadable text as no session. */
export const parseStoredSession = (text: string): Option.Option<StoredSession> =>
  Option.map(decodeSession(text), (stored) => ({
    token: Redacted.make(stored.token),
    refreshToken: Redacted.make(stored.refreshToken),
  }));

/** Serializes a session for a store that holds text. This reveals the tokens; store it privately. */
export const serializeSession = (session: StoredSession): string =>
  encodeSession({
    token: Redacted.value(session.token),
    refreshToken: Redacted.value(session.refreshToken),
  });

const changesOf = (store: KeyValueStore, key: string): Stream.Stream<void> => {
  const { subscribe } = store;

  if (subscribe === undefined) return Stream.never;

  return Stream.callback<void>(
    (queue) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          const unsubscribe = subscribe(key, () => {
            Queue.offerUnsafe(queue, undefined);
          });

          Queue.offerUnsafe(queue, undefined);

          return unsubscribe;
        }),
        (unsubscribe) => Effect.sync(unsubscribe),
      ),
    { bufferSize: 1, strategy: "sliding" },
  );
};

/** Stores the session under `key` in a string key-value store. */
export const layerKeyValue = (store: KeyValueStore, key: string): Layer.Layer<TokenStorage> =>
  Layer.succeed(
    TokenStorage,
    TokenStorage.of({
      load: Effect.tryPromise({
        try: async () => store.getItem(key),
        catch: (cause) =>
          new TokenStorageError({
            operation: "load",
            message: "Token storage failed to load the session",
            cause,
          }),
      }).pipe(Effect.map((text) => (text === null ? Option.none() : parseStoredSession(text)))),
      save: (session) =>
        Effect.tryPromise({
          try: async () => store.setItem(key, serializeSession(session)),
          catch: (cause) =>
            new TokenStorageError({
              operation: "save",
              message: "Token storage failed to save the session",
              cause,
            }),
        }),
      clear: Effect.tryPromise({
        try: async () => store.removeItem(key),
        catch: (cause) =>
          new TokenStorageError({
            operation: "clear",
            message: "Token storage failed to clear the session",
            cause,
          }),
      }),
      changed: changesOf(store, key),
    }),
  );
