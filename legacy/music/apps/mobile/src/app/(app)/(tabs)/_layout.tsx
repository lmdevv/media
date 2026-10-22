/**
 * The system tab bar (A01, A14, A17): Home, Playlists, and Library, with Search as the system
 * search tab in its own circle. Scrolling down minimizes the bar to the active tab and moves the
 * mini player inline beside it; scrolling up restores both. Paper's floating glass pill, separate
 * search circle, and scroll morph are what iOS 26 draws natively here.
 */
import { NativeTabs } from "expo-router/native-tabs";
import { Platform } from "react-native";

import { MiniPlayer } from "@/components/playback/mini-player";
import { useThemeColor } from "@/lib/theme-color";
import { useNowPlaying } from "@/player";

/** iOS 27 detaches the search tab into its own circle only when asked to; iOS 26 always does. */
const PROMINENT_SEARCH =
  Number.parseInt(String(Platform.Version), 10) >= 27
    ? { ios: { prominentScreenKey: "search" } }
    : {};

export default function TabsLayout() {
  const accent = useThemeColor("--color-accent");
  // The accessory shows only while something is queued.
  const { nowPlaying } = useNowPlaying();

  return (
    <NativeTabs
      minimizeBehavior="onScrollDown"
      tintColor={accent}
      unstable_nativeProps={PROMINENT_SEARCH}
    >
      {nowPlaying === null ? null : (
        <NativeTabs.BottomAccessory>
          <MiniPlayer />
        </NativeTabs.BottomAccessory>
      )}
      {/* Tab roots draw their own title and avatar, so their scroll views keep their own insets. */}
      <NativeTabs.Trigger name="(home)" disableAutomaticContentInsets>
        <NativeTabs.Trigger.Icon sf={{ default: "house", selected: "house.fill" }} />
        <NativeTabs.Trigger.Label>Home</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="(playlists)" disableAutomaticContentInsets>
        <NativeTabs.Trigger.Icon sf="music.note.list" />
        <NativeTabs.Trigger.Label>Playlists</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="(library)" disableAutomaticContentInsets>
        <NativeTabs.Trigger.Icon sf="books.vertical" />
        <NativeTabs.Trigger.Label>Library</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger
        name="(search)"
        role="search"
        disableAutomaticContentInsets
        unstable_nativeProps={{ ios: { role: "search" } }}
      >
        <NativeTabs.Trigger.Icon sf="magnifyingglass" />
        <NativeTabs.Trigger.Label>Search</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
