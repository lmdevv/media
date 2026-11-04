import { InvalidArgs } from "@media/contracts/errors";
import { Effect, Option, Schema, SchemaIssue, Stream } from "effect";

import type * as Auth from "./auth";
import type { WireArgs } from "./convex-transport";
import type { CallError } from "./sdk-errors";
import { ProtocolError } from "./sdk-errors";

const decodeWireArgs = Schema.decodeUnknownEffect(Schema.JsonObject);

const issueText = (issue: SchemaIssue.Issue): string =>
  SchemaIssue.makeFormatterDefault()(issue).replaceAll("\n", " ");

/**
 * `args` encoded with `schema` into the JSON object a Convex function takes; absent arguments are
 * `{}`. Arguments the schema rejects fail with `InvalidArgs` before anything is sent.
 */
export const encodeArgs = <A>(
  operation: string,
  schema: Schema.Codec<A, unknown>,
  args: A | undefined,
): Effect.Effect<WireArgs, InvalidArgs> =>
  Schema.encodeUnknownEffect(schema)(args ?? {}).pipe(
    Effect.flatMap(decodeWireArgs),
    Effect.mapError(
      (error) =>
        new InvalidArgs({
          message: `Invalid arguments for ${operation}: ${issueText(error.issue)}`,
        }),
    ),
  );

/** `raw` decoded with `schema`; an answer the schema rejects fails with `ProtocolError`. */
export const decodeResult = <A>(
  operation: string,
  schema: Schema.Codec<A, unknown>,
  raw: Schema.Json,
): Effect.Effect<A, ProtocolError> =>
  Schema.decodeEffect(schema)(raw).pipe(
    Effect.mapError(
      (cause) =>
        new ProtocolError({
          operation,
          message: `Protocol error in ${operation}: the result does not match the contract`,
          cause,
        }),
    ),
  );

/** What `acrossReconnects` reads of the session. */
export type ReconnectView = Pick<
  Auth.Interface,
  "isReconnecting" | "reconnecting" | "currentIdentity"
>;

/**
 * Whether to subscribe again after Convex answered `Unauthenticated` to a subscription made as
 * `identity`: once the connection signs in again, when it ran signed out because the server
 * keeps failing to renew the session, or at once when it did so as the subscription was made,
 * since the answer may be from then. Only while that session is still the one signed in, so
 * nothing one account asked is asked again as another.
 */
const subscribeAgain = (
  auth: ReconnectView,
  askedWhileReconnecting: boolean,
  identity: Option.Option<string>,
) =>
  Effect.gen(function* () {
    const reconnecting = yield* auth.isReconnecting;

    if (!reconnecting && !askedWhileReconnecting) return false;
    yield* Stream.runHead(Stream.filter(auth.reconnecting, (waiting) => !waiting));
    const current = yield* auth.currentIdentity;

    return Option.isSome(identity) && Option.contains(current, identity.value);
  });

/**
 * `results`, subscribed again as `subscribeAgain` says, however long the connection runs signed
 * out, so a screen keeps what it shows.
 */
export const acrossReconnects = <A>(
  auth: ReconnectView,
  results: Stream.Stream<A, CallError>,
): Stream.Stream<A, CallError> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const askedWhileReconnecting = yield* auth.isReconnecting;
      const identity = yield* auth.currentIdentity;

      return Stream.catchTag(results, "Unauthenticated", (error) =>
        Stream.unwrap(
          Effect.map(subscribeAgain(auth, askedWhileReconnecting, identity), (again) =>
            again ? acrossReconnects(auth, results) : Stream.fail(error),
          ),
        ),
      );
    }),
  );
