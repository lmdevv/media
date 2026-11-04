import type { MoviesClient, Playback } from "@media/sdk/effect";
import type { useMoviesRuntime } from "@media/sdk/react";
import { Effect, Exit, Struct } from "effect";
import type { Result } from "effect";

/** The app's SDK runtime. */
export type Runtime = ReturnType<typeof useMoviesRuntime>;

/** Renew the token and the stream this long before the token expires. */
export const RENEW_BEFORE_MS = 5 * 60 * 1000;

/**
 * Runs `effect` and returns its success or failure; defects, interruption, and an SDK that could
 * not open become `null`.
 */
export const runSdk = async <A, E>(
  runtime: Runtime,
  effect: Effect.Effect<A, E, MoviesClient.MoviesClient>,
): Promise<Result.Result<A, E> | null> => {
  const exit = await runtime.runPromiseExit(Effect.result(effect));

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
