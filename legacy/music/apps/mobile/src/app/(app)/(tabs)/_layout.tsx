import { NativeTabs } from "expo-router/native-tabs";
import { Platform } from "react-native";

import { SearchActivationProvider, useActivateSearch } from "@/components/browse/search-activation";
import { MiniPlayer } from "@/components/playback/mini-player";
import { Shell } from "@/components/shell/shell";
import { shellOf } from "@/lib/shell-layout";
import { useThemeColor } from "@/lib/theme-color";
import { DEVICE_FAMILY } from "@/lib/this-device";
import { useWindowLayout } from "@/lib/window-layout";
import { useNowPlaying } from "@/player";

const PROMINENT_SEARCH =
  Number.parseInt(String(Platform.Version), 10) >= 27
    ? { ios: { prominentScreenKey: "(search)" } }
    : {};

export default function TabsLayout() {
  return (
    <SearchActivationProvider>
      {DEVICE_FAMILY === "iPad" ? <FramedTabs /> : <Tabs framed={false} />}
    </SearchActivationProvider>
  );
}

function FramedTabs() {
  const { widthClass, landscape } = useWindowLayout();
  const layout = shellOf(widthClass, landscape);

  return (
    <Shell layout={layout}>
      <Tabs framed={layout.player === "bar"} />
    </Shell>
  );
}

function Tabs({ framed }: { readonly framed: boolean }) {
  const activateSearch = useActivateSearch();
  const accent = useThemeColor("--color-accent");
  const { nowPlaying } = useNowPlaying();

  return (
    <NativeTabs
      hidden={framed}
      minimizeBehavior="onScrollDown"
      tintColor={accent}
      unstable_nativeProps={PROMINENT_SEARCH}
    >
      {framed || nowPlaying === null ? null : (
        <NativeTabs.BottomAccessory>
          <MiniPlayer />
        </NativeTabs.BottomAccessory>
      )}
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
        listeners={{ tabPress: activateSearch }}
      >
        <NativeTabs.Trigger.Icon sf="magnifyingglass" />
        <NativeTabs.Trigger.Label>Search</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
