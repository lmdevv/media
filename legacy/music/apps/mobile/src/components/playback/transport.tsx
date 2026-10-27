/**
 * Now Playing's controls (B01, B02): previous, play or pause, and next, then the session volume.
 * They act on whichever device plays, so on B02 they steer the remote device. Shuffle and repeat
 * live in the queue's mode pills (B03).
 */
import * as Haptics from "expo-haptics";
import type { LucideIcon } from "lucide-react-native";
import { FastForward, Pause, Play, Rewind, Volume, Volume2 } from "lucide-react-native";
import { Pressable, View } from "react-native";

import { Icon } from "@/components/ui/icon";
import { playsOn } from "@/lib/playback-format";
import { usePlayer, usePlayerActions } from "@/player";

import { Slider } from "./slider";

/** Previous and next: 32pt filled glyphs in 44pt targets. */
function SkipButton({
  icon,
  label,
  onPress,
}: {
  readonly icon: LucideIcon;
  readonly label: string;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      className="size-hit-target items-center justify-center rounded-full active:opacity-60"
    >
      <Icon icon={icon} size="transport" filled />
    </Pressable>
  );
}

/** The transport row, centered. */
export function Transport() {
  const { status } = usePlayer();
  const actions = usePlayerActions();
  const playing = playsOn(status);

  return (
    <View className="flex-row items-center justify-center gap-12 py-4">
      <SkipButton icon={Rewind} label="Previous" onPress={() => void actions.previous()} />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={playing ? "Pause" : "Play"}
        onPress={() => {
          void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          void actions.toggle();
        }}
        className="size-16 items-center justify-center active:opacity-60"
      >
        <Icon icon={playing ? Pause : Play} size="hero" filled />
      </Pressable>
      <SkipButton icon={FastForward} label="Next" onPress={() => void actions.next()} />
    </View>
  );
}

/**
 * The session volume, shared by every device that plays it. On this phone it scales the app's
 * audio under the hardware volume buttons, which iOS keeps separate.
 */
export function VolumeRow() {
  const { volume } = usePlayer();
  const { setVolume } = usePlayerActions();

  return (
    <View className="flex-row items-center gap-3 py-2">
      <Icon icon={Volume} size="inline" />
      <View className="flex-1">
        <Slider
          value={volume}
          fillClassName="bg-text-muted"
          label="Volume"
          valueText={`${Math.round(volume * 100)}%`}
          onChange={(next) => void setVolume(next)}
        />
      </View>
      <Icon icon={Volume2} size="inline" />
    </View>
  );
}
