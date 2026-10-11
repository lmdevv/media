/**
 * Runs an Effect test body on the live runtime and closes its scope afterwards. Used instead of
 * `it.effect` / `it.live`, which the Effect language service marks unstable in this release.
 */
import { Effect, type Scope } from "effect";

/** Runs `effect` with a fresh scope, rejecting when it fails. */
export const runScoped = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>): Promise<A> =>
  Effect.runPromise(Effect.scoped(effect));
