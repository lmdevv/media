import { Effect, Exit } from "effect";
import type { Result } from "effect";

/**
 * Runs `effect` and returns its success or failure; defects and interruption become `null`.
 */
export const runSdk = async <A, E>(
  effect: Effect.Effect<A, E>,
): Promise<Result.Result<A, E> | null> => {
  const exit = await Effect.runPromiseExit(Effect.result(effect));

  return Exit.isSuccess(exit) ? exit.value : null;
};
