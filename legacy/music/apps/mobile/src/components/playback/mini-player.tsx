/**
 * The mini player in the tab bar's bottom accessory. iOS shows the accessory above the tabs
 * (`regular`, A01: 40pt art, title over artist, play or pause and next) and moves it into the
 * minimized tab bar as the page scrolls (`inline`, A14: 32pt art, artist over title, play or pause
 * only). Both copies render at once, so everything here reads the player and keeps no state of
 * its own. The system draws the glass capsule. Tapping the song opens Now Playing (B01).
 */
import { router } from "expo-router";
import { NativeTabs } from "expo-router/native-tabs";
import { FastForward, Pause, Play } from "lucide-react-native";
import { Pressable, View } from "react-native";

import { IconButton } from "@/components/ui/icon-button";
import { Text } from "@/components/ui/text";
import { Artwork } from "@/components/ui/artwork";
import { playsOn, progressOf } from "@/lib/playback-format";
import { useNowPlaying, usePlaybackPosition, usePlayerActions } from "@/player";

/** A hairline of progress under the song; the only part that re-renders with the position. */
function Progress() {
  const { positionMs, durationMs } = usePlaybackPosition();

  return (
    <View className="mt-1 h-0.5 overflow-hidden rounded-full bg-border">
      <View
        className="h-full rounded-full bg-text-muted"
        style={{ width: `${progressOf(positionMs, durationMs) * 100}%` }}
      />
    </View>
  );
}

const openNowPlaying = () => {
  router.push("/player");
};

/** The mini player for the accessory's current placement. */
export function MiniPlayer() {
  const placement = NativeTabs.BottomAccessory.usePlacement();
  const { nowPlaying, status } = useNowPlaying();
  const actions = usePlayerActions();

  if (nowPlaying === null) return null;
  const playing = playsOn(status);

  const toggle = (
    <IconButton
      icon={playing ? Pause : Play}
      label={playing ? "Pause" : "Play"}
      size={placement === "inline" ? "inline" : "nav"}
      filled
      onPress={() => void actions.toggle()}
    />
  );

  if (placement === "inline") {
    return (
      <View className="flex-1 flex-row items-center gap-2 pl-2">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Now playing: ${nowPlaying.title}, ${nowPlaying.artist}`}
          accessibilityHint="Opens Now Playing"
          onPress={openNowPlaying}
          className="min-w-0 flex-1 flex-row items-center gap-2 active:opacity-60"
        >
          <Artwork url={nowPlaying.artUrl} className="size-8 shrink-0 rounded-sm" />
          <View className="min-w-0 flex-1">
            <Text variant="caption" tone="muted" numberOfLines={1}>
              {nowPlaying.artist}
            </Text>
            <Text variant="label" numberOfLines={1}>
              {nowPlaying.title}
            </Text>
          </View>
        </Pressable>
        {toggle}
      </View>
    );
  }

  return (
    <View className="flex-1 flex-row items-center gap-2 px-2">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Now playing: ${nowPlaying.title}, ${nowPlaying.artist}`}
        accessibilityHint="Opens Now Playing"
        onPress={openNowPlaying}
        className="min-w-0 flex-1 flex-row items-center gap-2 active:opacity-60"
      >
        <Artwork url={nowPlaying.artUrl} className="size-row shrink-0 rounded-md" />
        <View className="min-w-0 flex-1">
          <Text variant="label" numberOfLines={1}>
            {nowPlaying.title}
          </Text>
          <Text variant="caption" tone="muted" numberOfLines={1}>
            {nowPlaying.artist}
          </Text>
          <Progress />
        </View>
      </Pressable>
      {toggle}
      <IconButton icon={FastForward} label="Next" filled onPress={() => void actions.next()} />
    </View>
  );
}
