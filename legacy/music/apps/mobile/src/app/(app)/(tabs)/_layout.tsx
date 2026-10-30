/**
 * The tabs: Home, Playlists, and Library, with Search as the system search tab in its own circle.
 *
 * On an iPhone they are the system tab bar (A01, A14, A17). Scrolling down minimizes the bar to the
 * active tab and moves the mini player inline beside it; scrolling up restores both. Selecting
 * Search turns the bar into the search field with the keyboard up (A13). Paper's floating glass
 * pill, separate search circle, and both morphs are what iOS draws natively here.
 *
 * On an iPad the same tabs run with their bar hidden, inside the frame `Shell` draws: a sidebar and
 * a player bar (Paper page 26). The device picks the tree rather than the window, so resizing in
 * Split View keeps the tabs mounted and each stack where it was.
 */
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

/**
 * iOS 27 detaches the search tab into its own circle only when asked to, by the tab's screen key,
 * which is its route name; iOS 26 always does.
 */
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

/** The tabs in the iPad's frame for the window's size. */
function FramedTabs() {
  const { widthClass, landscape } = useWindowLayout();
  const layout = shellOf(widthClass, landscape);

  return (
    <Shell layout={layout}>
      <Tabs framed={layout.player === "bar"} />
    </Shell>
  );
}

/** The four tabs, telling the Search screen when its tab is selected. */
function Tabs({ framed }: { readonly framed: boolean }) {
  const activateSearch = useActivateSearch();
  const accent = useThemeColor("--color-accent");
  // The accessory shows only while something is queued.
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
        listeners={{ tabPress: activateSearch }}
      >
        <NativeTabs.Trigger.Icon sf="magnifyingglass" />
        <NativeTabs.Trigger.Label>Search</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
