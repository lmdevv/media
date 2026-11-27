import { RequestIdentity } from "@media/contracts/errors";
import { RequestId } from "@media/contracts/request-id";
import type { CommandError } from "@media/contracts/errors";
import { Option, Predicate, Schema } from "effect";

/**
 * The server could not be reached or the connection dropped before an answer arrived. A mutation
 * that fails this way may still have run; read the state again before retrying it.
 */
export class TransportError extends Schema.TaggedError<
  TransportError,
  { readonly brand: unique symbol }
>()("TransportError", {
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
export class ProtocolError extends Schema.TaggedError<
  ProtocolError,
  { readonly brand: unique symbol }
>()("ProtocolError", {
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

/** The media service request each error the SDK built from that request's response failed. */
const answeredRequests = new WeakMap<object, string>();

const isRequestId = Schema.is(RequestId);

/**
 * `error`, kept as failing the media service request its `requestId` names. The SDK passes each
 * error it builds from a media service response through here before a caller can see it.
 */
export const answeredBy = <E>(error: E): E => {
  if (Predicate.hasProperty(error, "requestId") && isRequestId(error.requestId)) {
    answeredRequests.set(error, error.requestId);
  }

  return error;
};

/**
 * The media service request `cause` failed, as the SDK read it from that request's response;
 * none for any value the SDK did not build so, whatever fields it has or gains later.
 */
export const answeredRequestOf = (cause: unknown): Option.Option<string> =>
  Predicate.isObject(cause) ? Option.fromNullishOr(answeredRequests.get(cause)) : Option.none();
