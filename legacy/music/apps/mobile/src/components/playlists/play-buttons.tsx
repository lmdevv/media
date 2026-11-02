import type { TrackId } from "@music/commands/ids";
import { Play, Plus, Shuffle } from "lucide-react-native";
import { View } from "react-native";

import { PAIR_ROWS, PAIR_WIDTHS } from "@/components/browse/play-shuffle";
import type { PairWidth } from "@/components/browse/play-shuffle";
import { Button } from "@/components/ui/button";
import { usePlayer, usePlayerActions } from "@/player";

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

export interface PlayButtonsProps {
  readonly trackIds: ReadonlyArray<TrackId>;
  /** Shuffle beside Play, or Add songs for a collaborator (C11). */
  readonly second:
    | { readonly kind: "shuffle" }
    | { readonly kind: "add"; readonly onPress: () => void };
  readonly width?: PairWidth;
  readonly className?: string;
}

/** Play from the top, then Shuffle or Add songs. */
export function PlayButtons({ trackIds, second, width = "fill", className }: PlayButtonsProps) {
  const playList = usePlayList();
  const empty = trackIds.length === 0;

  return (
    <View className={`${PAIR_ROWS[width]} ${className ?? ""}`}>
      <Button
        label="Play"
        icon={Play}
        iconFilled
        disabled={empty}
        className={PAIR_WIDTHS[width]}
        onPress={() => void playList(trackIds, { shuffle: false, index: 0 })}
      />
      {second.kind === "shuffle" ? (
        <Button
          label="Shuffle"
          icon={Shuffle}
          variant="secondary"
          disabled={empty}
          className={PAIR_WIDTHS[width]}
          onPress={() => void playList(trackIds, { shuffle: true })}
        />
      ) : (
        <Button
          label="Add songs"
          icon={Plus}
          variant="secondary"
          className={PAIR_WIDTHS[width]}
          onPress={second.onPress}
        />
      )}
    </View>
  );
}
