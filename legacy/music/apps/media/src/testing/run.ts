import { Effect, type Scope } from "effect";

/** Runs `effect` with a fresh scope, rejecting when it fails. */
export const runScoped = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>): Promise<A> =>
  Effect.runPromise(Effect.scoped(effect));
