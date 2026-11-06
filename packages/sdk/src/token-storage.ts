import {
  Clock,
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

/**
 * Whether a session was signed out in this store: not at all, signed out here with the server not
 * yet confirming it, or confirmed by the server.
 */
export type Revocation = "none" | "pending" | "confirmed";

/** Persists the current session's tokens. */
export interface Interface {
  /** The current session; none when signed out, when it was revoked, or when it is unreadable. */
  readonly load: Effect.Effect<Option.Option<StoredSession>, TokenStorageError>;
  /** Makes a new sign-in the current session. */
  readonly save: (session: StoredSession) => Effect.Effect<void, TokenStorageError>;
  /**
   * Stores `renewed`, a renewal of the session in `expected`, only while the store still holds
   * `expected` for that session; whether it did. It never changes which session is current.
   */
  readonly renew: (
    expected: StoredSession,
    renewed: StoredSession,
  ) => Effect.Effect<boolean, TokenStorageError>;
  /**
   * Signs `session` out of the store for good. Every client that reads the store afterwards stops
   * using it, whatever later writes of its tokens say.
   */
  readonly revoke: (session: StoredSession) => Effect.Effect<void, TokenStorageError>;
  /**
   * Records that the server ended a revoked `session`, and forgets its tokens and its pending
   * sign-out.
   */
  readonly confirmRevoked: (session: StoredSession) => Effect.Effect<void, TokenStorageError>;
  readonly revocation: (session: StoredSession) => Effect.Effect<Revocation, TokenStorageError>;
  /** Whether `session` still waits for the server to confirm its sign-out. */
  readonly signOutPending: (session: StoredSession) => Effect.Effect<boolean, TokenStorageError>;
  /**
   * Every session signed out anywhere in the store whose sign-out the server has not confirmed,
   * whichever key it was signed in under. These credentials serve only to end the session on the
   * server; nothing signs in or calls with them.
   */
  readonly pendingSignOuts: Effect.Effect<ReadonlyArray<StoredSession>, TokenStorageError>;
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
 * else writes it, so a renewal is saved without checking, revoking clears it, and `changed` never
 * emits.
 */
export const owned = (store: {
  readonly load: Interface["load"];
  readonly save: Interface["save"];
  readonly clear: Effect.Effect<void, TokenStorageError>;
}): Interface => ({
  load: store.load,
  save: store.save,
  renew: (_expected, renewed) => Effect.as(store.save(renewed), true),
  revoke: () => store.clear,
  confirmRevoked: () => Effect.void,
  revocation: () => Effect.succeed("none"),
  signOutPending: () => Effect.succeed(false),
  pendingSignOuts: Effect.succeed([]),
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
   * Calls `onChange` when `key`, or a key that starts with `key:`, may have changed underneath
   * this client, such as another tab writing `localStorage`, and returns the unsubscribe. A store
   * with it is shared between clients; a store without it is read only at start, so it suits a
   * store that one client owns.
   */
  readonly subscribe?: (key: string, onChange: () => void) => () => void;
  /** Every key the store holds, so a shared store can find sign-outs other clients left pending. */
  readonly keys?: () => ReadonlyArray<string> | Promise<ReadonlyArray<string>>;
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

/** One key holding the session, for a store only this client uses. */
const singleKey = (store: KeyValueStore, key: string): Interface =>
  owned({
    load: Effect.tryPromise({
      try: async () => store.getItem(key),
      catch: failure("load", "Token storage failed to load the session"),
    }).pipe(Effect.map((text) => (text === null ? Option.none() : parseStoredSession(text)))),
    save: (session) =>
      Effect.tryPromise({
        try: async () => store.setItem(key, serializeSession(session)),
        catch: failure("save", "Token storage failed to save the session"),
      }),
    clear: Effect.tryPromise({
      try: async () => store.removeItem(key),
      catch: failure("clear", "Token storage failed to clear the session"),
    }),
  });

const idOf = (session: StoredSession, operation: TokenStorageError["operation"]) =>
  Effect.fromOption(sessionOf(session)).pipe(
    Effect.mapError(
      (cause) =>
        new TokenStorageError({
          operation,
          message: "Token storage cannot name a session whose token has no subject",
          cause,
        }),
    ),
  );

const attempt = <A>(operation: TokenStorageError["operation"], run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: failure(operation, `Token storage failed to ${operation} the session`),
  });

const Revoked = Schema.fromJsonString(Schema.Struct({ revokedAt: Schema.Finite }));

/**
 * The store-wide prefix of pending sign-outs. It sits outside every session key, so forgetting a
 * slot keeps them, and no read that loads a session looks there.
 */
const PENDING = "media.signOut";

const PendingSignOut = Schema.fromJsonString(
  Schema.Struct({ key: Schema.String, token: Schema.String, refreshToken: Schema.String }),
);

const decodePending = Schema.decodeUnknownOption(PendingSignOut);

const encodePending = Schema.encodeSync(PendingSignOut);

const encodeRevoked = Schema.encodeSync(Revoked);

/**
 * The session under `key` in a store several clients share, such as `localStorage` across tabs,
 * which has no atomic compare-and-set. Each key has one kind of writer, and nothing deletes a key
 * because of what a read found:
 *
 * - `key` names the current session. Only a sign-in writes it.
 * - `key:<session>` holds that session's tokens. A sign-in creates it, a renewal of that session
 *   replaces it, and the server confirming its sign-out removes it.
 * - `key:<session>:revoked` is written once, when the session signs out, and never changes.
 * - `key:<session>:confirmed` is written once, when the server confirms the sign-out.
 */
const sharedKeys = (store: KeyValueStore, key: string): Interface => {
  const tokensKey = (id: string) => `${key}:${id}`;
  const revokedKey = (id: string) => `${key}:${id}:revoked`;
  const confirmedKey = (id: string) => `${key}:${id}:confirmed`;

  const tokensOf = async (id: string) => {
    const text = await store.getItem(tokensKey(id));

    return text === null ? Option.none() : parseStoredSession(text);
  };

  const pendingKey = (id: string) => `${PENDING}:${id}`;

  const pendingOf = async (id: string) => {
    const text = await store.getItem(pendingKey(id));

    return text === null ? Option.none() : decodePending(text);
  };

  const revocationOf = async (id: string): Promise<Revocation> => {
    if ((await store.getItem(confirmedKey(id))) !== null) return "confirmed";

    return (await store.getItem(revokedKey(id))) === null ? "none" : "pending";
  };

  return {
    load: attempt("load", async () => {
      const id = await store.getItem(key);

      if (id === null || (await revocationOf(id)) !== "none") return Option.none();

      return tokensOf(id);
    }),
    save: (session) =>
      Effect.flatMap(idOf(session, "save"), (id) =>
        attempt("save", async () => {
          await store.setItem(tokensKey(id), serializeSession(session));
          await store.setItem(key, id);
        }),
      ),
    renew: (expected, renewed) =>
      Effect.flatMap(idOf(renewed, "save"), (id) =>
        attempt("save", async () => {
          if (!sameStored(await tokensOf(id), Option.some(expected))) return false;
          await store.setItem(tokensKey(id), serializeSession(renewed));

          return true;
        }),
      ),
    revoke: (session) =>
      Effect.flatMap(idOf(session, "clear"), (id) =>
        Effect.flatMap(Clock.currentTimeMillis, (revokedAt) =>
          attempt("clear", async () => {
            if ((await store.getItem(revokedKey(id))) === null) {
              await store.setItem(revokedKey(id), encodeRevoked({ revokedAt }));
            }

            if ((await store.getItem(pendingKey(id))) === null) {
              await store.setItem(
                pendingKey(id),
                encodePending({
                  key,
                  token: Redacted.value(session.token),
                  refreshToken: Redacted.value(session.refreshToken),
                }),
              );
            }
          }),
        ),
      ),
    confirmRevoked: (session) =>
      Effect.flatMap(idOf(session, "clear"), (id) =>
        attempt("clear", async () => {
          const signedInAt = Option.match(await pendingOf(id), {
            onNone: () => key,
            onSome: (pending) => pending.key,
          });

          await store.setItem(`${signedInAt}:${id}:confirmed`, "1");
          await store.removeItem(`${signedInAt}:${id}`);
          await store.removeItem(pendingKey(id));
        }),
      ),
    revocation: (session) =>
      Effect.flatMap(idOf(session, "load"), (id) => attempt("load", () => revocationOf(id))),
    signOutPending: (session) =>
      Effect.flatMap(idOf(session, "load"), (id) =>
        attempt("load", async () => Option.isSome(await pendingOf(id))),
      ),
    pendingSignOuts: attempt("load", async () => {
      const all = store.keys === undefined ? [] : await store.keys();

      const found = await Promise.all(
        all
          .filter((each) => each.startsWith(`${PENDING}:`))
          .map(async (each) => {
            const text = await store.getItem(each);

            return text === null ? Option.none() : decodePending(text);
          }),
      );

      return found.flatMap((pending) =>
        Option.toArray(
          Option.map(pending, ({ token, refreshToken }) => ({
            token: Redacted.make(token),
            refreshToken: Redacted.make(refreshToken),
          })),
        ),
      );
    }),
    changed: Stream.merge(changesOf(store, key), changesOf(store, PENDING)),
  };
};

/**
 * Stores the session under `key` in a string key-value store. A store that can announce other
 * clients' writes (`subscribe`) is shared, so it gets the layout of `sharedKeys`; any other store
 * keeps the session under `key` alone.
 */
export const layerKeyValue = (store: KeyValueStore, key: string): Layer.Layer<TokenStorage> =>
  Layer.succeed(
    TokenStorage,
    TokenStorage.of(store.subscribe === undefined ? singleKey(store, key) : sharedKeys(store, key)),
  );
