/** Paper's Play and Shuffle pair (A05, A07): two equal pills, accent Play and surface Shuffle. */
import { Play, Shuffle } from "lucide-react-native";
import { View } from "react-native";

import { Button } from "@/components/ui/button";

/** Play in order and Shuffle, side by side. */
export function PlayShuffle({
  onPlay,
  onShuffle,
  pending = false,
  className,
}: {
  readonly onPlay: () => void;
  readonly onShuffle: () => void;
  /** While the songs to play are still loading. */
  readonly pending?: boolean;
  readonly className?: string;
}) {
  return (
    <View className={`flex-row gap-3 ${className ?? ""}`}>
      <Button
        label="Play"
        icon={Play}
        iconFilled
        pending={pending}
        onPress={onPlay}
        className="flex-1"
      />
      <Button
        label="Shuffle"
        variant="secondary"
        icon={Shuffle}
        pending={pending}
        onPress={onShuffle}
        className="flex-1"
      />
    </View>
  );
}
