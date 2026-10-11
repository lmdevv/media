/**
 * Checks signed media URLs. Convex signs `exp` and `sig` for a resource; the media service only
 * verifies them and never decides access itself.
 */
import { type SignedResource, verifyResource } from "@music/commands/signed-url";
import { Clock, Effect, Redacted } from "effect";

/** Query parameters a signed URL carries. Absent parameters are `undefined`. */
export interface SignedQuery {
  readonly exp: string | undefined;
  readonly sig: string | undefined;
}

const DIGITS = /^\d{1,16}$/;

/**
 * True when `sig` is a valid, unexpired signature of `resource` and `exp` under `signingKey`.
 * Malformed parameters are simply invalid.
 */
export const isSignedRequestValid = Effect.fn("SignedRequest.isValid")(function* (
  signingKey: Redacted.Redacted,
  resource: SignedResource,
  query: SignedQuery,
) {
  const { exp, sig } = query;

  if (exp === undefined || sig === undefined || !DIGITS.test(exp) || sig === "") return false;
  const now = yield* Clock.currentTimeMillis;

  return yield* Effect.promise(() =>
    verifyResource(Redacted.value(signingKey), resource, Number(exp), sig, now),
  );
});
