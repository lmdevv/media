/**
 * Now Playing's controls (B01, B02): shuffle, previous, play or pause, next, and repeat, then the
 * session volume. They act on whichever device plays, so on B02 they steer the remote device.
 * Paper draws shuffle and repeat only when off; on, they take the accent, as H05 notes.
 */
import * as Haptics from "expo-haptics";
import type { LucideIcon } from "lucide-react-native";
import {
  FastForward,
  Pause,
  Play,
  Repeat,
  Repeat1,
  Rewind,
  Shuffle,
  Speaker,
  Volume2,
} from "lucide-react-native";
import { Pressable, View } from "react-native";

import { Icon } from "@/components/ui/icon";
import { IconButton } from "@/components/ui/icon-button";
import { playsOn } from "@/lib/playback-format";
import { usePlayer, usePlayerActions } from "@/player";

import { Slider } from "./slider";

const REPEAT_LABELS = {
  off: "Repeat off",
  all: "Repeat all",
  one: "Repeat one",
} as const;

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

/** The transport row. */
export function Transport() {
  const { status, shuffle, repeat } = usePlayer();
  const actions = usePlayerActions();
  const playing = playsOn(status);

  return (
    <View className="flex-row items-center justify-between py-4">
      <IconButton
        icon={Shuffle}
        label={shuffle ? "Shuffle on" : "Shuffle off"}
        tone={shuffle ? "accent" : "default"}
        accessibilityState={{ selected: shuffle }}
        onPress={() => {
          void Haptics.selectionAsync();
          void actions.setShuffle(!shuffle);
        }}
      />
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
      <IconButton
        icon={repeat === "one" ? Repeat1 : Repeat}
        label={REPEAT_LABELS[repeat]}
        tone={repeat === "off" ? "default" : "accent"}
        accessibilityState={{ selected: repeat !== "off" }}
        onPress={() => {
          void Haptics.selectionAsync();
          void actions.cycleRepeat();
        }}
      />
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
    <View className="flex-row items-center gap-3">
      <Icon icon={Volume2} size="inline" />
      <View className="flex-1">
        <Slider
          value={volume}
          fillClassName="bg-text-muted"
          label="Volume"
          valueText={`${Math.round(volume * 100)}%`}
          onChange={(next) => void setVolume(next)}
        />
      </View>
      <Icon icon={Speaker} size="inline" />
    </View>
  );
}
