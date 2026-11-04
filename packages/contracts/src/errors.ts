/**
 * Expected failures of every command. Convex throws `ConvexError({ code, message })`; the media
 * service answers with the same body. Clients decode it with `CommandFailure` and turn it into one
 * tagged error per code with `commandError`.
 */
import { Match, Schema } from "effect";

import { RequestId } from "./request-id";

/** Stable failure codes. Clients branch on these, never on message text. */
export const ErrorCode = Schema.Literals([
  "unauthenticated",
  "forbidden",
  "not_found",
  "invalid_args",
  "conflict",
  "expired",
  "stale_revision",
  "rate_limited",
  "internal",
]);

/** A stable failure code. */
export type ErrorCode = typeof ErrorCode.Type;

/** The wire form of an expected failure: `ConvexError` data and media service error bodies. */
export const CommandFailure = Schema.Struct({
  code: ErrorCode,
  message: Schema.String,
});

/** The wire form of an expected failure. */
export interface CommandFailure extends Schema.Schema.Type<typeof CommandFailure> {}

/** Which request a client error came from. Clients read it from the response headers. */
export const RequestIdentity = Schema.Struct({
  /**
   * The media service's `x-request-id` of the failed request, to find its log lines with
   * `media logs --grep`; absent when no response arrived or the failure came from Convex.
   */
  requestId: Schema.optionalKey(RequestId),
});

export type RequestIdentity = typeof RequestIdentity.Type;

/** No session, or the session ended (sign-out, key revoked, account disabled). Sign in again. */
export class Unauthenticated extends Schema.TaggedError<Unauthenticated>()("Unauthenticated", {
  message: Schema.String,
  ...RequestIdentity.fields,
}) {}

/** The session lacks the scope, role, ownership, PIN unlock, or host role the command needs. */
export class Forbidden extends Schema.TaggedError<Forbidden>()("Forbidden", {
  message: Schema.String,
  ...RequestIdentity.fields,
}) {}

/** The record does not exist or the viewer may not see it. Hidden titles report this too. */
export class NotFound extends Schema.TaggedError<NotFound>()("NotFound", {
  message: Schema.String,
  ...RequestIdentity.fields,
}) {}

/** The arguments were well-formed but not acceptable, such as an unknown scope or a bad PIN format. */
export class InvalidArgs extends Schema.TaggedError<InvalidArgs>()("InvalidArgs", {
  message: Schema.String,
  ...RequestIdentity.fields,
}) {}

/** The record is not in a state that allows this, such as a used invite or a lost job lease. */
export class Conflict extends Schema.TaggedError<Conflict>()("Conflict", {
  message: Schema.String,
  ...RequestIdentity.fields,
}) {}

/** A code, invite, key, or token has expired. */
export class Expired extends Schema.TaggedError<Expired>()("Expired", {
  message: Schema.String,
  ...RequestIdentity.fields,
}) {}

/** A room command carried an older revision than the room's. Read the committed clock and retry. */
export class StaleRevision extends Schema.TaggedError<StaleRevision>()("StaleRevision", {
  message: Schema.String,
  ...RequestIdentity.fields,
}) {}

/** Too many attempts. Wait and retry, after `retryAfterSeconds` when it is known. */
export class RateLimited extends Schema.TaggedError<RateLimited>()("RateLimited", {
  message: Schema.String,
  retryAfterSeconds: Schema.optional(Schema.Int),
  ...RequestIdentity.fields,
}) {}

/** The server failed in a way the caller cannot fix, such as a missing deployment secret. */
export class Internal extends Schema.TaggedError<Internal>()("Internal", {
  message: Schema.String,
  ...RequestIdentity.fields,
}) {}

/** Any expected command failure. */
export type CommandError =
  | Unauthenticated
  | Forbidden
  | NotFound
  | InvalidArgs
  | Conflict
  | Expired
  | StaleRevision
  | RateLimited
  | Internal;

/** Turns a decoded wire failure into its tagged error, carrying the request it came from. */
export const commandError = (
  failure: CommandFailure,
  identity: RequestIdentity = {},
): CommandError => {
  const fields = { message: failure.message, ...identity };

  return Match.value(failure.code).pipe(
    Match.when("unauthenticated", () => new Unauthenticated(fields)),
    Match.when("forbidden", () => new Forbidden(fields)),
    Match.when("not_found", () => new NotFound(fields)),
    Match.when("invalid_args", () => new InvalidArgs(fields)),
    Match.when("conflict", () => new Conflict(fields)),
    Match.when("expired", () => new Expired(fields)),
    Match.when("stale_revision", () => new StaleRevision(fields)),
    Match.when("rate_limited", () => new RateLimited(fields)),
    Match.when("internal", () => new Internal(fields)),
    Match.exhaustive,
  );
};
