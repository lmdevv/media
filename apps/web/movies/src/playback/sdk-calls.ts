import type { Playback } from "@media/sdk/effect";
import { Effect, Exit, Struct } from "effect";
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

/** `playback` continued in the generation a seek started, at its playlist. */
export const inGeneration = (
  playback: Playback.Playback,
  moved: { readonly generation: number; readonly playlistUrl: string },
): Playback.Playback => ({
  started: playback.started,
  stream: Struct.evolve(playback.stream, {
    url: () => moved.playlistUrl,
    generation: () => moved.generation,
  }),
});
