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
  Volume,
  Volume2,
} from "lucide-react-native";
import { Pressable, View } from "react-native";

import { Icon } from "@/components/ui/icon";
import { IconButton } from "@/components/ui/icon-button";
import { REPEAT_LABELS, playsOn } from "@/lib/playback-format";
import { usePlayer, usePlayerActions } from "@/player";

import { Slider } from "./slider";

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

function BarSkipButton({
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
      className="h-ios-36 w-hit-target items-center justify-center active:opacity-60"
    >
      <Icon icon={icon} size="barSkip" filled />
    </Pressable>
  );
}

function BarMode({
  icon,
  label,
  on,
  onPress,
}: {
  readonly icon: LucideIcon;
  readonly label: string;
  readonly on: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityState={{ checked: on }}
      onPress={() => {
        void Haptics.selectionAsync();
        onPress();
      }}
      className="size-ios-36 items-center justify-center active:opacity-60"
    >
      <Icon icon={icon} size="inline" tone={on ? "accent" : "muted"} />
    </Pressable>
  );
}

/** The player bar's row: previous, play or pause in a filled circle, next, and maybe the modes. */
export function BarTransport({ modes }: { readonly modes: boolean }) {
  const { status, shuffle, repeat } = usePlayer();
  const actions = usePlayerActions();
  const playing = playsOn(status);

  return (
    <View className="flex-row items-center gap-4">
      {modes ? (
        <BarMode
          icon={Shuffle}
          label="Shuffle"
          on={shuffle}
          onPress={() => void actions.setShuffle(!shuffle)}
        />
      ) : null}
      <BarSkipButton icon={Rewind} label="Previous" onPress={() => void actions.previous()} />
      <IconButton
        icon={playing ? Pause : Play}
        label={playing ? "Pause" : "Play"}
        tone="inverse"
        size="inline"
        filled
        className="bg-text"
        onPress={() => {
          void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          void actions.toggle();
        }}
      />
      <BarSkipButton icon={FastForward} label="Next" onPress={() => void actions.next()} />
      {modes ? (
        <BarMode
          icon={repeat === "one" ? Repeat1 : Repeat}
          label={REPEAT_LABELS[repeat]}
          on={repeat !== "off"}
          onPress={() => void actions.cycleRepeat()}
        />
      ) : null}
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
