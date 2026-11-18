import type { Player } from "@media/player/react";

import type { Track } from "./models";

/**
 * The songs a play button starts: a list it holds, or a load of them it started in the tap, such
 * as an album's pages.
 */
export type PlaySource =
  | ReadonlyArray<Pick<Track, "id">>
  | Promise<ReadonlyArray<Pick<Track, "id">>>;

/** Where a list starts: at `index`, or shuffled from a random song. */
export interface PlayOptions {
  readonly index?: number;
  readonly shuffle?: boolean;
}

/** The player actions a play button uses. */
type PlayingPlayer = Pick<Player, "primeOutput" | "shuffle" | "setShuffle" | "playTracks">;

/**
 * Replaces the queue with `source` and plays it, turning shuffle on or off first when `shuffle` is
 * set. Every play button starts here, synchronously in its tap: the output is primed before the
 * first await (a load, or the shuffle change), as iOS Safari allows audio to start after an await
 * only once it was started inside the gesture. Rejects with the load's or the core's failure.
 *
 * @param player - Returns the player as it is now, read again after each await.
 */
export const startPlay = async (
  player: () => PlayingPlayer,
  source: PlaySource,
  options: PlayOptions = {},
): Promise<void> => {
  player().primeOutput();

  const tracks = await source;

  if (tracks.length === 0) return;

  if (options.shuffle !== undefined && options.shuffle !== player().shuffle) {
    await player().setShuffle(options.shuffle);
  }

  const ids = tracks.map((track) => track.id);
  const index = options.shuffle === true ? Math.floor(Math.random() * ids.length) : options.index;

  await player().playTracks(ids, index);
};
