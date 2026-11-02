import type { TrackId } from "@music/commands/ids";

import { usePlayerActions } from "@/player";

/** How a list starts playback. */
interface PlayList {
  /** Plays `trackIds` from the song at `index`, keeping shuffle as it is. */
  readonly playFrom: (trackIds: ReadonlyArray<TrackId>, index: number) => void;
  /** Plays `trackIds` from the top in order, or shuffled from a random song. */
  readonly playAll: (trackIds: ReadonlyArray<TrackId>, shuffle: boolean) => void;
}

/** How a list's rows, Play, and Shuffle start playback. */
export const usePlayList = (): PlayList => {
  const { play, setShuffle } = usePlayerActions();

  return {
    playFrom: (trackIds, index) => void play(trackIds, index),
    playAll: (trackIds, shuffle) => {
      if (trackIds.length === 0) return;

      void setShuffle(shuffle);
      void play(trackIds, shuffle ? Math.floor(Math.random() * trackIds.length) : 0);
    },
  };
};
