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
   * Saves `next`, or clears the store for none, only while it still holds `expected` (none: no
   * session); whether it did. A refresh commits its result this way, so it never overwrites what
   * another writer stored meanwhile, such as another tab's sign-out.
   */
  readonly replace: (
    expected: Option.Option<StoredSession>,
    next: Option.Option<StoredSession>,
  ) => Effect.Effect<boolean, TokenStorageError>;
  /**
   * Emits once it starts listening, then whenever the stored session may have changed outside
   * this client, such as another tab writing the same key. The first emission covers changes made
   * before it listened. Never emits for a store that cannot tell.
   */
  readonly changed: Stream.Stream<void>;
}

/** Whether two stored values hold the same tokens, or both hold none. */
export const sameStored = Option.makeEquivalence<StoredSession>(
  (a, b) =>
    Redacted.value(a.token) === Redacted.value(b.token) &&
    Redacted.value(a.refreshToken) === Redacted.value(b.refreshToken),
);

/**
 * A store that only this client reads and writes, from its `load`, `save`, and `clear`. Nothing
 * else changes it, so `replace` writes without checking and `changed` never emits.
 */
export const owned = (store: Pick<Interface, "load" | "save" | "clear">): Interface => ({
  ...store,
  replace: (_expected, next) =>
    Option.match(next, { onNone: () => store.clear, onSome: store.save }).pipe(Effect.as(true)),
  changed: Stream.never,
});

/** The token store the SDK's auth reads and writes. */
export class TokenStorage extends Context.Service<TokenStorage, Interface>()(
  "@media/sdk/TokenStorage",
) {}

/** Keeps the session in memory only; a new process starts signed out. */
export const layerMemory: Layer.Layer<TokenStorage> = Layer.effect(
  TokenStorage,
  Effect.gen(function* () {
    const current = yield* Ref.make(Option.none<StoredSession>());

    return TokenStorage.of(
      owned({
        load: Ref.get(current),
        save: (session) => Ref.set(current, Option.some(session)),
        clear: Ref.set(current, Option.none()),
      }),
    );
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
  /**
   * Runs `write` while no other client writes `key`, such as under a Web Lock, and settles with
   * its result. Every write to the session goes through it. Without it, a write that checks the
   * stored value first trusts that nothing runs between its read and its write, which holds for
   * `localStorage` within one tab.
   */
  readonly exclusive?: <A>(key: string, write: () => Promise<A>) => Promise<A>;
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

const failure =
  (operation: TokenStorageError["operation"], message: string) =>
  (cause: unknown): TokenStorageError =>
    new TokenStorageError({ operation, message, cause });

/** Stores the session under `key` in a string key-value store. */
export const layerKeyValue = (store: KeyValueStore, key: string): Layer.Layer<TokenStorage> => {
  const exclusively = <A>(write: () => Promise<A>): Promise<A> =>
    store.exclusive === undefined ? write() : store.exclusive(key, write);

  const read = async () => {
    const text = await store.getItem(key);

    return text === null ? Option.none() : parseStoredSession(text);
  };

  const write = async (next: Option.Option<StoredSession>) =>
    Option.isSome(next) ? store.setItem(key, serializeSession(next.value)) : store.removeItem(key);

  return Layer.succeed(
    TokenStorage,
    TokenStorage.of({
      load: Effect.tryPromise({
        try: read,
        catch: failure("load", "Token storage failed to load the session"),
      }),
      save: (session) =>
        Effect.tryPromise({
          try: () => exclusively(() => write(Option.some(session))),
          catch: failure("save", "Token storage failed to save the session"),
        }),
      clear: Effect.tryPromise({
        try: () => exclusively(() => write(Option.none())),
        catch: failure("clear", "Token storage failed to clear the session"),
      }),
      replace: (expected, next) =>
        Effect.tryPromise({
          try: () =>
            exclusively(async () => {
              if (!sameStored(await read(), expected)) return false;
              await write(next);

              return true;
            }),
          catch: failure(
            Option.isSome(next) ? "save" : "clear",
            "Token storage failed to replace the session",
          ),
        }),
      changed: changesOf(store, key),
    }),
  );
};
