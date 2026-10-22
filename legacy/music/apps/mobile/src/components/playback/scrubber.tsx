/**
 * Now Playing's scrubber (B01): the progress track over elapsed and remaining times in Geist Mono.
 * It is the only part of the screen that re-renders with the position. While dragging, the times
 * follow the finger; the seek is sent once, on release.
 */
import * as Haptics from "expo-haptics";
import { useState } from "react";
import { View } from "react-native";

import { Text } from "@/components/ui/text";
import { clock, progressOf, remainingClock } from "@/lib/playback-format";
import { usePlaybackPosition, usePlayerActions } from "@/player";

import { Slider } from "./slider";

/** The progress track and its times. */
export function Scrubber() {
  const { positionMs, durationMs } = usePlaybackPosition();
  const { seek } = usePlayerActions();
  const [scrub, setScrub] = useState<number | null>(null);
  const shownMs = scrub === null ? positionMs : scrub * durationMs;

  return (
    <View>
      <Slider
        value={progressOf(positionMs, durationMs)}
        fillClassName="bg-text"
        label="Position"
        valueText={`${clock(shownMs)} of ${clock(durationMs)}`}
        onScrub={setScrub}
        onChange={(fraction) => {
          void Haptics.selectionAsync();
          void seek(fraction * durationMs);
        }}
      />
      {/* The 44pt touch area centers the track 20pt below the title row, as Paper's padding does;
          the times sit Paper's 8pt under the track, inside the touch area's lower half. */}
      <View className="-mt-3 flex-row justify-between" pointerEvents="none">
        <Text variant="mono" tone="muted">
          {clock(shownMs)}
        </Text>
        <Text variant="mono" tone="muted">
          {remainingClock(shownMs, durationMs)}
        </Text>
      </View>
    </View>
  );
}
