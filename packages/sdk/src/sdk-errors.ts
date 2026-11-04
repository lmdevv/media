import { RequestIdentity } from "@media/contracts/errors";
import type { CommandError } from "@media/contracts/errors";
import { Predicate, Schema } from "effect";

/**
 * The server could not be reached or the connection dropped before an answer arrived. A mutation
 * that fails this way may still have run; read the state again before retrying it.
 */
export class TransportError extends Schema.TaggedError<TransportError>()("TransportError", {
  /** The command or function that was running, such as `titles.list`. */
  operation: Schema.String,
  message: Schema.String,
  cause: Schema.Defect(),
  ...RequestIdentity.fields,
}) {}

/**
 * The server answered with a value the contracts do not describe. This points at mismatched
 * client and server versions or a server bug; retrying does not help.
 */
export class ProtocolError extends Schema.TaggedError<ProtocolError>()("ProtocolError", {
  /** The command or function whose answer did not match, such as `titles.list`. */
  operation: Schema.String,
  message: Schema.String,
  cause: Schema.Defect(),
  ...RequestIdentity.fields,
}) {}

/** Any failure a command call can end with. */
export type CallError = CommandError | TransportError | ProtocolError;

/**
 * Whether `error` may pass by itself, without anyone changing anything: the network or rate
 * limiting. A crashed function (`Internal`) usually crashes again the same way, so it is not.
 */
export const isTransient = (error: CallError): boolean =>
  Predicate.isTagged(error, "TransportError") || Predicate.isTagged(error, "RateLimited");
