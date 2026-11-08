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

import type { SharedStore, SharedTransaction } from "./shared-store";

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
 * Whether a session may still be used from this store: `none` while the store holds its
 * credentials and no sign-out; `pending` once signed out here, until the server confirms;
 * `confirmed` after; `missing` when the store no longer holds its credentials at all, as after a
 * sign-out that could only delete them. Anything but `none` means stop using it.
 */
export type Revocation = "none" | "pending" | "confirmed" | "missing";

/** Persists the current session's tokens. */
export interface Interface {
  /** The current session; none when signed out, when it was revoked, or when it is unreadable. */
  readonly load: Effect.Effect<Option.Option<StoredSession>, TokenStorageError>;
  /**
   * Makes a new sign-in the current session. The browser's shared store refuses it: a session
   * enters there only with its device order (`keepSession`).
   */
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
   * Signs `session` out as `revoke` does, but only while the store still holds it as its current
   * session; whether it did. A store another client replaced the session in keeps its newer one.
   */
  readonly revokeHeld: (session: StoredSession) => Effect.Effect<boolean, TokenStorageError>;
  /**
   * Records that the server ended a revoked `session`, and forgets its tokens and its pending
   * sign-out.
   */
  readonly confirmRevoked: (session: StoredSession) => Effect.Effect<void, TokenStorageError>;
  readonly revocation: (session: StoredSession) => Effect.Effect<Revocation, TokenStorageError>;
  /** Whether `session` still waits for the server to confirm its sign-out. */
  readonly signOutPending: (session: StoredSession) => Effect.Effect<boolean, TokenStorageError>;
  /**
   * Every session signed out in the store whose sign-out the server has not confirmed. These
   * credentials serve only to end the session on the server; nothing signs in or calls with them.
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
  readonly save: (session: StoredSession) => Effect.Effect<void, TokenStorageError>;
  readonly clear: Effect.Effect<void, TokenStorageError>;
}): Interface => ({
  load: store.load,
  save: store.save,
  renew: (_expected, renewed) => Effect.as(store.save(renewed), true),
  revoke: () => store.clear,
  revokeHeld: () => Effect.as(store.clear, true),
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
 * A synchronous or asynchronous string store that one client owns, such as AsyncStorage or a file.
 * Methods may throw or reject; the adapter turns that into `TokenStorageError`. Clients that share
 * a store, such as browser tabs, use a `SharedStore` instead (`layerShared`).
 */
export interface KeyValueStore {
  readonly getItem: (key: string) => string | null | Promise<string | null>;
  readonly setItem: (key: string, value: string) => void | Promise<void>;
  readonly removeItem: (key: string) => void | Promise<void>;
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

const failure =
  (operation: TokenStorageError["operation"], message: string) =>
  (cause: unknown): TokenStorageError =>
    new TokenStorageError({ operation, message, cause });

/** Stores the session under `key` in a string key-value store that one client owns. */
export const layerKeyValue = (store: KeyValueStore, key: string): Layer.Layer<TokenStorage> =>
  Layer.succeed(
    TokenStorage,
    TokenStorage.of(
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
      }),
    ),
  );

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

/**
 * The browser's device: its id, its code `dv_<id>.<secret>`, and the number of the last session the
 * core bound to it that this browser kept.
 */
export interface BrowserDevice {
  readonly id: string;
  readonly code: string;
  readonly sequence: number;
}

/** Where and in what order the core bound a new session to this browser's device. */
export interface DeviceOrder {
  readonly deviceId: string;
  /** The device's code, `dv_<id>.<secret>`. */
  readonly code: string;
  /** The session's number on the device. The core ends the device's earlier sessions. */
  readonly sequence: number;
  /** The device this browser kept when the sign-in began; null when it kept none. */
  readonly basedOn: string | null;
}

const DEVICE = "media.device";

const SESSION = "media.session";

const REVOKED = "media.revoked:";

const PENDING = "media.signOut:";

const StoredDevice = Schema.fromJsonString(
  Schema.Struct({ id: Schema.String, code: Schema.String, sequence: Schema.Int }),
);

const decodeDevice = Schema.decodeUnknownOption(StoredDevice);

const encodeDevice = Schema.encodeSync(StoredDevice);

const deviceIn = async (tx: SharedTransaction): Promise<Option.Option<BrowserDevice>> =>
  Option.flatMap(Option.fromNullishOr(await tx.get(DEVICE)), decodeDevice);

const sessionIn = async (tx: SharedTransaction): Promise<Option.Option<StoredSession>> =>
  Option.flatMap(Option.fromNullishOr(await tx.get(SESSION)), parseStoredSession);

const holds = async (tx: SharedTransaction, id: string): Promise<boolean> =>
  Option.contains(Option.flatMap(await sessionIn(tx), sessionOf), id);

const isRevoked = async (tx: SharedTransaction, id: string): Promise<boolean> =>
  (await tx.get(`${REVOKED}${id}`)) !== undefined;

const signOutIn = async (tx: SharedTransaction, id: string, session: StoredSession) => {
  if (!(await isRevoked(tx, id))) {
    await tx.set(`${REVOKED}${id}`, "revoked");
    await tx.set(`${PENDING}${id}`, serializeSession(session));
  }

  if (await holds(tx, id)) await tx.remove(SESSION);
};

/** This browser's device; null before a sign-in kept one. */
export const readDevice = async (store: SharedStore): Promise<BrowserDevice | null> =>
  Option.getOrNull(await store.read(deviceIn));

/**
 * Makes `session` the browser's one session, as `order` places it; whether it did (ADR 0020). It
 * does only when the core bound it after the session kept now: on the same device, with a higher
 * number; or on a new device enrolled from the one kept, when the core no longer knew that one.
 * A session signed out here never comes back, and keeping the session held now changes nothing.
 * The session it replaces, or a session that lost, is signed out in the same transaction, so a
 * client ends it with the core even if it is still live there. No client clock decides anything.
 */
export const keepSession = (
  store: SharedStore,
  session: StoredSession,
  order: DeviceOrder,
): Promise<boolean> =>
  store.write(async (tx) => {
    const id = Option.getOrNull(sessionOf(session));

    if (id === null || (await isRevoked(tx, id))) return false;

    if (await holds(tx, id)) return true;

    const newer = Option.match(await deviceIn(tx), {
      onNone: () => true,
      onSome: (kept) =>
        kept.id === order.deviceId ? order.sequence > kept.sequence : kept.id === order.basedOn,
    });

    if (!newer) {
      await signOutIn(tx, id, session);

      return false;
    }

    const replaced = await sessionIn(tx);
    const replacedId = Option.flatMap(replaced, sessionOf);

    if (Option.isSome(replaced) && Option.isSome(replacedId)) {
      await signOutIn(tx, replacedId.value, replaced.value);
    }

    await tx.set(
      DEVICE,
      encodeDevice({ id: order.deviceId, code: order.code, sequence: order.sequence }),
    );
    await tx.set(SESSION, serializeSession(session));

    return true;
  });

/** A sign-in held in memory until the browser keeps it with its device order. */
export interface HeldSignIn {
  /** The store a client of its own signs in on. */
  readonly storage: KeyValueStore;
  /** Keeps the session that client holds in `store`, as `keepSession` does; whether it did. */
  readonly keep: (store: SharedStore, order: DeviceOrder) => Promise<boolean>;
}

/**
 * A place in memory for a new sign-in. A browser learns a session's order only after it signs in,
 * when the core binds it to the device, so a client of its own signs in here first.
 */
export const holdSignIn = (): HeldSignIn => {
  const held = new Map<string, string>();

  return {
    storage: {
      getItem: (key) => held.get(key) ?? null,
      setItem: (key, value) => {
        held.set(key, value);
      },
      removeItem: (key) => {
        held.delete(key);
      },
    },
    keep: async (store, order) => {
      const [session] = [...held.values()].flatMap((text) =>
        Option.toArray(parseStoredSession(text)),
      );

      return session === undefined ? false : keepSession(store, session, order);
    },
  };
};

/**
 * The browser's one session, in a store every client on the origin shares (ADR 0020). Every
 * operation is one transaction, so a check and the write it guards never interleave with another
 * client's:
 *
 * - `media.device` is the browser's device and the number of the session kept last, and
 *   `media.session` that session's tokens. Only `keepSession` puts a session there.
 * - A renewal replaces the tokens only while they are still the ones it started from and the
 *   session has no revocation.
 * - `media.revoked:<session>` records a sign-out and is never deleted, and
 *   `media.signOut:<session>` holds it until the core confirms, for any client to finish.
 *
 * A store that cannot be read loads no session, and a token check that cannot read it counts the
 * session as revoked.
 */
export const layerShared = (store: SharedStore): Layer.Layer<TokenStorage> => {
  const attempt = <A>(
    operation: TokenStorageError["operation"],
    mode: "read" | "write",
    run: (tx: SharedTransaction) => Promise<A>,
  ) =>
    Effect.tryPromise({
      try: () => (mode === "read" ? store.read(run) : store.write(run)),
      catch: failure(operation, `Token storage failed to ${operation} the session`),
    });

  const changed = Stream.callback<void>(
    (queue) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          const stop = store.subscribe(() => {
            Queue.offerUnsafe(queue, undefined);
          });

          Queue.offerUnsafe(queue, undefined);

          return stop;
        }),
        (stop) => Effect.sync(stop),
      ),
    { bufferSize: 1, strategy: "sliding" },
  );

  return Layer.succeed(
    TokenStorage,
    TokenStorage.of({
      load: attempt("load", "read", async (tx) => {
        const held = await sessionIn(tx);
        const id = Option.getOrNull(Option.flatMap(held, sessionOf));

        return id === null || (await isRevoked(tx, id)) ? Option.none<StoredSession>() : held;
      }).pipe(Effect.orElseSucceed(() => Option.none<StoredSession>())),
      save: () =>
        Effect.fail(
          new TokenStorageError({
            operation: "save",
            message:
              "A browser keeps a new session only with its device order: sign in on a client of its own, then keep it",
            cause: null,
          }),
        ),
      renew: (expected, renewed) =>
        Effect.flatMap(idOf(renewed, "save"), (id) =>
          attempt("save", "write", async (tx) => {
            if (await isRevoked(tx, id)) return false;

            if (!sameStored(await sessionIn(tx), Option.some(expected))) return false;
            await tx.set(SESSION, serializeSession(renewed));

            return true;
          }),
        ),
      revoke: (session) =>
        Effect.flatMap(idOf(session, "clear"), (id) =>
          attempt("clear", "write", (tx) => signOutIn(tx, id, session)).pipe(
            // A full store refuses the records, so deleting the tokens alone frees space and
            // leaves nothing to load; the caller keeps retrying the records.
            Effect.tapError(() =>
              Effect.ignore(
                attempt("clear", "write", async (tx) => {
                  if (await holds(tx, id)) await tx.remove(SESSION);
                }),
              ),
            ),
          ),
        ),
      revokeHeld: (session) =>
        Effect.flatMap(idOf(session, "clear"), (id) =>
          attempt("clear", "write", async (tx) => {
            if (!(await holds(tx, id))) return false;
            await signOutIn(tx, id, session);

            return true;
          }),
        ),
      confirmRevoked: (session) =>
        Effect.flatMap(idOf(session, "clear"), (id) =>
          attempt("clear", "write", async (tx) => {
            if (!(await isRevoked(tx, id))) await tx.set(`${REVOKED}${id}`, "revoked");

            await tx.remove(`${PENDING}${id}`);

            if (await holds(tx, id)) await tx.remove(SESSION);
          }),
        ),
      revocation: (session) =>
        Effect.flatMap(idOf(session, "load"), (id) =>
          attempt("load", "read", async (tx): Promise<Revocation> => {
            if (await isRevoked(tx, id)) {
              return (await tx.get(`${PENDING}${id}`)) === undefined ? "confirmed" : "pending";
            }

            return (await holds(tx, id)) ? "none" : "missing";
          }),
        ),
      signOutPending: (session) =>
        Effect.flatMap(idOf(session, "load"), (id) =>
          attempt("load", "read", async (tx) => (await tx.get(`${PENDING}${id}`)) !== undefined),
        ),
      pendingSignOuts: attempt("load", "read", async (tx) => {
        const keys = (await tx.keys()).filter((key) => key.startsWith(PENDING));
        const found = await Promise.all(keys.map((key) => tx.get(key)));

        return found.flatMap((text) =>
          Option.toArray(Option.flatMap(Option.fromNullishOr(text), parseStoredSession)),
        );
      }),
      changed,
    }),
  );
};
