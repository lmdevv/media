import {
  Context,
  Effect,
  Layer,
  Option,
  Queue,
  Redacted,
  Ref,
  Result,
  Schema,
  Stream,
} from "effect";
import * as Base64Url from "effect/encoding/Base64Url";

/** A Convex Auth session: the short-lived JWT and the refresh token that renews it. */
export interface StoredSession {
  readonly token: Redacted.Redacted;
  readonly refreshToken: Redacted.Redacted;
}

/** The JSON text of a token's claims, when it reads as a JWT. */
export const tokenPayload = (token: string): Option.Option<string> => {
  const [, payload] = token.split(".");

  if (payload === undefined) return Option.none();
  const text = Base64Url.decodeString(payload);

  return Result.isSuccess(text) ? Option.some(text.success) : Option.none();
};

/** Convex Auth signs `sub` as `userId|sessionId`, so equal subjects name one session. */
const decodeSubject = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ sub: Schema.String })),
);

/** The account and session `session` signs in as, which a renewal keeps. */
export const sessionOf = (session: StoredSession): Option.Option<string> =>
  Option.map(
    Option.flatMap(tokenPayload(Redacted.value(session.token)), decodeSubject),
    (claims) => claims.sub,
  );

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
   * Clears the store after `session` signed out, and keeps that sign-in out of it for good: a
   * write of the same session that lands later, such as another tab's renewal that started before
   * the sign-out, loads as no session.
   */
  readonly end: (session: StoredSession) => Effect.Effect<void, TokenStorageError>;
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
  end: () => store.clear,
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

/** How many signed-out sessions a key remembers. */
const ENDED_KEPT = 16;

const EndedSessions = Schema.fromJsonString(Schema.Array(Schema.String));

const decodeEnded = Schema.decodeUnknownOption(EndedSessions);

const encodeEnded = Schema.encodeSync(EndedSessions);

const hasEnded = (ended: ReadonlyArray<string>, session: StoredSession): boolean =>
  Option.exists(sessionOf(session), (id) => ended.includes(id));

/**
 * Stores the session under `key` in a string key-value store, and the sessions signed out there
 * under `<key>.ended`. A store several clients share, such as `localStorage` across tabs, offers
 * no atomic write, so a renewal can land after another tab's sign-out; the ended list makes such a
 * session load as none, and the read that finds it removes it.
 */
export const layerKeyValue = (store: KeyValueStore, key: string): Layer.Layer<TokenStorage> => {
  const endedKey = `${key}.ended`;

  const readEnded = async (): Promise<ReadonlyArray<string>> => {
    const text = await store.getItem(endedKey);

    return text === null ? [] : Option.getOrElse(decodeEnded(text), () => []);
  };

  const read = async (): Promise<Option.Option<StoredSession>> => {
    const text = await store.getItem(key);
    const held = text === null ? Option.none() : parseStoredSession(text);

    if (Option.isNone(held) || !hasEnded(await readEnded(), held.value)) return held;
    await store.removeItem(key);

    return Option.none();
  };

  const write = async (next: Option.Option<StoredSession>) =>
    Option.isSome(next) ? store.setItem(key, serializeSession(next.value)) : store.removeItem(key);

  const markEnded = async (session: StoredSession, ended: boolean) => {
    const id = sessionOf(session);

    if (Option.isNone(id)) return;
    const before = await readEnded();
    const others = before.filter((held) => held !== id.value);

    if (!ended && others.length === before.length) return;
    await store.setItem(
      endedKey,
      encodeEnded(ended ? [...others, id.value].slice(-ENDED_KEPT) : others),
    );
  };

  return Layer.succeed(
    TokenStorage,
    TokenStorage.of({
      load: Effect.tryPromise({
        try: read,
        catch: failure("load", "Token storage failed to load the session"),
      }),
      save: (session) =>
        Effect.tryPromise({
          try: async () => {
            await markEnded(session, false);
            await write(Option.some(session));
          },
          catch: failure("save", "Token storage failed to save the session"),
        }),
      clear: Effect.tryPromise({
        try: () => write(Option.none()),
        catch: failure("clear", "Token storage failed to clear the session"),
      }),
      end: (session) =>
        Effect.tryPromise({
          try: () => write(Option.none()),
          catch: failure("clear", "Token storage failed to clear the session"),
        }).pipe(
          Effect.andThen(
            Effect.tryPromise(() => markEnded(session, true)).pipe(
              Effect.catch(() => Effect.logWarning("TokenStorage.endedSessionNotKept")),
            ),
          ),
        ),
      replace: (expected, next) =>
        Effect.tryPromise({
          try: async () => {
            if (!sameStored(await read(), expected)) return false;
            await write(next);

            return true;
          },
          catch: failure(
            Option.isSome(next) ? "save" : "clear",
            "Token storage failed to replace the session",
          ),
        }),
      changed: changesOf(store, key),
    }),
  );
};
