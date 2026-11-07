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
   * Makes a new sign-in the current session; whether it did. A session that was signed out here
   * is never stored again, as when another tab signed out the session a late answer carries.
   */
  readonly save: (session: StoredSession) => Effect.Effect<boolean, TokenStorageError>;
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
   * Deletes revocation records once the sessions they name can no longer work anywhere, and the
   * oldest confirmed ones past a cap. It never deletes a session that could still be live.
   */
  readonly sweep: Effect.Effect<void, TokenStorageError>;
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
  save: (session) => Effect.as(store.save(session), true),
  renew: (_expected, renewed) => Effect.as(store.save(renewed), true),
  revoke: () => store.clear,
  confirmRevoked: () => Effect.void,
  revocation: () => Effect.succeed("none"),
  signOutPending: () => Effect.succeed(false),
  pendingSignOuts: Effect.succeed([]),
  sweep: Effect.void,
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

const Revoked = Schema.fromJsonString(
  Schema.Struct({
    revokedAt: Schema.Finite,
    slot: Schema.String,
    confirmedAt: Schema.optionalKey(Schema.Finite),
  }),
);

const decodeRevoked = Schema.decodeUnknownOption(Revoked);

const encodeRevoked = Schema.encodeSync(Revoked);

const PendingSignOut = Schema.fromJsonString(
  Schema.Struct({ slot: Schema.String, token: Schema.String, refreshToken: Schema.String }),
);

const decodePending = Schema.decodeUnknownOption(PendingSignOut);

const encodePending = Schema.encodeSync(PendingSignOut);

/**
 * How long after a sign-out its session can surely no longer work: the core's 30-day limit on a
 * session and on an unused refresh token, and a day's margin.
 */
const REVOCATION_KEPT_MS = 31 * 24 * 60 * 60 * 1000;

/** How many confirmed revocations a store keeps before it drops the oldest. */
const CONFIRMED_KEPT = 64;

/** Revocations, one per session id, whichever slot it was signed in under. */
const REVOKED = "media.revoked:";

/** Sign-outs the core has not confirmed, one per session id, for any client to finish. */
const PENDING = "media.signOut:";

const SlotRecord = Schema.fromJsonString(
  Schema.Struct({ session: Schema.String, user: Schema.String, generation: Schema.Finite }),
);

const decodeSlot = Schema.decodeUnknownOption(SlotRecord);

const encodeSlot = Schema.encodeSync(SlotRecord);

/** What a slot holds: its session, whose it is, and which of that person's sign-ins it was. */
export interface SlotHolding {
  readonly session: string;
  readonly user: string;
  readonly generation: number;
}

/** The person's sign-in counter, raised inside each sign-in's transaction. */
const GENERATION = "media.generation:";

/** What the slot under `key` holds, read inside `tx`; none for an empty or unreadable slot. */
export const slotHolding = async (
  tx: SharedTransaction,
  key: string,
): Promise<Option.Option<SlotHolding>> =>
  Option.flatMap(Option.fromNullishOr(await tx.get(key)), decodeSlot);

/** The newest sign-in generation of `user`, read inside `tx`; 0 before any. */
export const latestGeneration = async (tx: SharedTransaction, user: string): Promise<number> =>
  Number((await tx.get(`${GENERATION}${user}`)) ?? "0") || 0;

const tokensIn = async (tx: SharedTransaction, key: string) =>
  Option.flatMap(Option.fromNullishOr(await tx.get(key)), parseStoredSession);

const revokedIn = async (tx: SharedTransaction, id: string) =>
  Option.flatMap(Option.fromNullishOr(await tx.get(`${REVOKED}${id}`)), decodeRevoked);

/**
 * The session of slot `slot` in a store the origin's clients share (ADR 0020). Every operation is
 * one transaction, so a check and the write it guards never interleave with another client's:
 *
 * - `slot` names the slot's current session. Only a sign-in writes it.
 * - `slot:<session>` holds that session's tokens. A renewal replaces them only while they are
 *   still the ones it started from and no revocation exists; a sign-out deletes them.
 * - `media.revoked:<session>` records a sign-out, and the core's confirmation once it comes.
 * - `media.signOut:<session>` holds a sign-out the core has not confirmed, for any client to
 *   finish, wherever its slot went. Nothing that loads a session reads it.
 *
 * A store that cannot be read loads no session, and a token check that cannot read it counts the
 * session as revoked.
 */
export const layerShared = (store: SharedStore, slot: string): Layer.Layer<TokenStorage> => {
  const tokensKey = (id: string) => `${slot}:${id}`;

  const attempt = <A>(
    operation: TokenStorageError["operation"],
    mode: "read" | "write",
    run: (tx: SharedTransaction) => Promise<A>,
  ) =>
    Effect.tryPromise({
      try: () => (mode === "read" ? store.read(run) : store.write(run)),
      catch: failure(operation, `Token storage failed to ${operation} the session`),
    });

  const revocationIn = async (tx: SharedTransaction, id: string): Promise<Revocation> =>
    Option.match(await revokedIn(tx, id), {
      onSome: (record) => (record.confirmedAt === undefined ? "pending" : "confirmed"),
      onNone: async () => (Option.isSome(await tokensIn(tx, tokensKey(id))) ? "none" : "missing"),
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
        const held = await slotHolding(tx, slot);

        if (Option.isNone(held) || Option.isSome(await revokedIn(tx, held.value.session))) {
          return Option.none();
        }

        return tokensIn(tx, tokensKey(held.value.session));
      }).pipe(Effect.orElseSucceed(() => Option.none<StoredSession>())),
      save: (session) =>
        Effect.flatMap(idOf(session, "save"), (id) =>
          attempt("save", "write", async (tx) => {
            if (Option.isSome(await revokedIn(tx, id))) return false;

            const user = id.split("|")[0] ?? id;
            const generation = (await latestGeneration(tx, user)) + 1;

            await tx.set(`${GENERATION}${user}`, String(generation));
            await tx.set(tokensKey(id), serializeSession(session));
            await tx.set(slot, encodeSlot({ session: id, user, generation }));

            return true;
          }),
        ),
      renew: (expected, renewed) =>
        Effect.flatMap(idOf(renewed, "save"), (id) =>
          attempt("save", "write", async (tx) => {
            if (Option.isSome(await revokedIn(tx, id))) return false;

            if (!sameStored(await tokensIn(tx, tokensKey(id)), Option.some(expected))) return false;
            await tx.set(tokensKey(id), serializeSession(renewed));

            return true;
          }),
        ),
      revoke: (session) =>
        Effect.flatMap(idOf(session, "clear"), (id) =>
          Effect.flatMap(Clock.currentTimeMillis, (revokedAt) =>
            attempt("clear", "write", async (tx) => {
              if (Option.isNone(await revokedIn(tx, id))) {
                await tx.set(`${REVOKED}${id}`, encodeRevoked({ revokedAt, slot }));
              }

              if ((await tx.get(`${PENDING}${id}`)) === undefined) {
                await tx.set(
                  `${PENDING}${id}`,
                  encodePending({
                    slot,
                    token: Redacted.value(session.token),
                    refreshToken: Redacted.value(session.refreshToken),
                  }),
                );
              }

              await tx.remove(tokensKey(id));
            }).pipe(
              // A full store refuses the records, so deleting the tokens alone frees space and
              // leaves nothing to load; the caller keeps retrying the records.
              Effect.tapError(() =>
                Effect.ignore(attempt("clear", "write", (tx) => tx.remove(tokensKey(id)))),
              ),
            ),
          ),
        ),
      confirmRevoked: (session) =>
        Effect.flatMap(idOf(session, "clear"), (id) =>
          Effect.flatMap(Clock.currentTimeMillis, (confirmedAt) =>
            attempt("clear", "write", async (tx) => {
              const pending = Option.flatMap(
                Option.fromNullishOr(await tx.get(`${PENDING}${id}`)),
                decodePending,
              );

              const signedInAt = Option.match(pending, {
                onNone: () => slot,
                onSome: (each) => each.slot,
              });

              const revokedAt = Option.match(await revokedIn(tx, id), {
                onNone: () => confirmedAt,
                onSome: (record) => record.revokedAt,
              });

              await tx.set(
                `${REVOKED}${id}`,
                encodeRevoked({ revokedAt, slot: signedInAt, confirmedAt }),
              );
              await tx.remove(`${signedInAt}:${id}`);
              await tx.remove(`${PENDING}${id}`);
            }),
          ),
        ),
      revocation: (session) =>
        Effect.flatMap(idOf(session, "load"), (id) =>
          attempt("load", "read", (tx) => revocationIn(tx, id)),
        ),
      signOutPending: (session) =>
        Effect.flatMap(idOf(session, "load"), (id) =>
          attempt("load", "read", async (tx) => (await tx.get(`${PENDING}${id}`)) !== undefined),
        ),
      pendingSignOuts: attempt("load", "read", async (tx) => {
        const keys = (await tx.keys()).filter((key) => key.startsWith(PENDING));
        const found = await Promise.all(keys.map((key) => tx.get(key)));

        return found.flatMap((text) =>
          Option.toArray(
            Option.map(
              Option.flatMap(Option.fromNullishOr(text), decodePending),
              ({ token, refreshToken }) => ({
                token: Redacted.make(token),
                refreshToken: Redacted.make(refreshToken),
              }),
            ),
          ),
        );
      }),
      sweep: Effect.flatMap(Clock.currentTimeMillis, (now) =>
        attempt("clear", "write", async (tx) => {
          const keys = (await tx.keys()).filter((key) => key.startsWith(REVOKED));

          const records = (
            await Promise.all(
              keys.map(async (key) => ({
                id: key.slice(REVOKED.length),
                record: Option.flatMap(Option.fromNullishOr(await tx.get(key)), decodeRevoked),
              })),
            )
          ).flatMap(({ id, record }) =>
            Option.toArray(Option.map(record, (each) => ({ id, ...each }))),
          );

          const expired = records.filter((each) => now - each.revokedAt > REVOCATION_KEPT_MS);

          const overCap = records
            .filter((each) => each.confirmedAt !== undefined)
            .toSorted((a, b) => (b.confirmedAt ?? 0) - (a.confirmedAt ?? 0))
            .slice(CONFIRMED_KEPT);

          await Promise.all(
            [...expired, ...overCap].flatMap((each) => [
              tx.remove(`${REVOKED}${each.id}`),
              tx.remove(`${PENDING}${each.id}`),
              tx.remove(`${each.slot}:${each.id}`),
            ]),
          );
        }),
      ),
      changed,
    }),
  );
};
