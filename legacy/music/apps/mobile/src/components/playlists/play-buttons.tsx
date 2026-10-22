/**
 * Paper's Play and Shuffle pair (C02, C03) and C11's Play and Add songs: two equal pills 12pt
 * apart. Playing goes through the player, which replaces the queue and plays on this phone (or
 * adds to the host's queue in someone else's Jam).
 */
import type { TrackId } from "@music/commands/ids";
import { Play, Plus, Shuffle } from "lucide-react-native";
import { View } from "react-native";

import { Button } from "@/components/ui/button";
import { usePlayer, usePlayerActions } from "@/player";

/** Plays `trackIds` from `index`, or shuffled from a random song, turning shuffle on or off first. */
const usePlayList = (): ((
  trackIds: ReadonlyArray<TrackId>,
  mode: { readonly shuffle: boolean; readonly index?: number },
) => Promise<void>) => {
  const { shuffle } = usePlayer();
  const { play, setShuffle } = usePlayerActions();

  return async (trackIds, mode) => {
    if (trackIds.length === 0) return;

    if (mode.shuffle !== shuffle) await setShuffle(mode.shuffle);

    await play(trackIds, mode.shuffle ? Math.floor(Math.random() * trackIds.length) : mode.index);
  };
};

/** Props for `PlayButtons`. */
export interface PlayButtonsProps {
  readonly trackIds: ReadonlyArray<TrackId>;
  /** Shuffle beside Play, or Add songs for a collaborator (C11). */
  readonly second:
    | { readonly kind: "shuffle" }
    | { readonly kind: "add"; readonly onPress: () => void };
  readonly className?: string;
}

/** Play from the top, then Shuffle or Add songs. */
export function PlayButtons({ trackIds, second, className }: PlayButtonsProps) {
  const playList = usePlayList();
  const empty = trackIds.length === 0;

  return (
    <View className={`flex-row gap-3 ${className ?? ""}`}>
      <Button
        label="Play"
        icon={Play}
        iconFilled
        disabled={empty}
        className="flex-1"
        onPress={() => void playList(trackIds, { shuffle: false, index: 0 })}
      />
      {second.kind === "shuffle" ? (
        <Button
          label="Shuffle"
          icon={Shuffle}
          variant="secondary"
          disabled={empty}
          className="flex-1"
          onPress={() => void playList(trackIds, { shuffle: true })}
        />
      ) : (
        <Button
          label="Add songs"
          icon={Plus}
          variant="secondary"
          className="flex-1"
          onPress={second.onPress}
        />
      )}
    </View>
  );
}
