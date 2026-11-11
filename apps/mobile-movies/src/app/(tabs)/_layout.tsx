import { NativeTabs } from "expo-router/native-tabs";

import { SearchActivationProvider, useActivateSearch } from "@/components/browse/search-activation";
import { useThemeColor } from "@/lib/theme-color";

export default function TabsLayout() {
  return (
    <SearchActivationProvider>
      <Tabs />
    </SearchActivationProvider>
  );
}

function Tabs() {
  const accent = useThemeColor("--color-accent");
  const activateSearch = useActivateSearch();

  return (
    <NativeTabs
      minimizeBehavior="onScrollDown"
      tintColor={accent}
      // iOS 27 detaches the search tab into its own circle only when asked to.
      unstable_nativeProps={{ ios: { prominentScreenKey: "search" } }}
    >
      <NativeTabs.Trigger name="(home)" disableAutomaticContentInsets>
        <NativeTabs.Trigger.Icon sf={{ default: "house", selected: "house.fill" }} />
        <NativeTabs.Trigger.Label>Home</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="downloads">
        <NativeTabs.Trigger.Icon sf="arrow.down.to.line" />
        <NativeTabs.Trigger.Label>Downloads</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger
        name="search"
        role="search"
        unstable_nativeProps={{ ios: { role: "search" } }}
        listeners={{ tabPress: activateSearch }}
      >
        <NativeTabs.Trigger.Icon sf="magnifyingglass" />
        <NativeTabs.Trigger.Label>Search</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
