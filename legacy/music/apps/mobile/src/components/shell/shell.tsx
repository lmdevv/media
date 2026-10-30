/**
 * The iPad's frame around the tabs (page 26, direction B): the sidebar, the tabs' pages, and the
 * player bar. The native tabs stay mounted underneath with their bar hidden, so each page keeps
 * its own stack, and rotating or resizing never loses it; the sidebar drives them by route. In
 * Split View narrower than `tablet` the frame steps aside for the phone's tab bar.
 *
 * `shellOf` says what the window gets. Pinned, the sidebar sits beside the pages until its button
 * hides it; at `tablet` it stays hidden behind a button on the page and opens over everything,
 * with a scrim that closes it, as does choosing anything in it. The Now Playing panel sits beside
 * the pages as a pane, or above the bar as a sheet; the pages take what room it leaves.
 */
import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Pressable, View } from "react-native";
import Animated, { FadeIn, FadeOut, SlideInLeft, SlideOutLeft } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import type { ShellLayout } from "@/lib/shell-layout";
import { useThemeLength } from "@/lib/theme-color";
import { useSong } from "@/player";

import { ContentArea } from "./content-area";
import { InspectorPane, InspectorSheet } from "./inspector";
import { PlayerBar } from "./player-bar";
import { Sidebar } from "./sidebar";
import { SidebarControlContext } from "./sidebar-control";
import type { SidebarControl } from "./sidebar-control";
import { useInspector } from "./use-inspector";

const noop = () => undefined;

/** The sidebar over everything, on a scrim; VoiceOver stays inside it until it closes. */
function SidebarOverlay({ onClose }: { readonly onClose: () => void }) {
  const insets = useSafeAreaInsets();

  return (
    <View
      collapsable={false}
      accessibilityViewIsModal
      onAccessibilityEscape={onClose}
      className="absolute inset-0"
    >
      <Animated.View
        entering={FadeIn.duration(180)}
        exiting={FadeOut.duration(120)}
        className="absolute inset-0 bg-scrim"
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close sidebar"
          className="flex-1"
          onPress={onClose}
        />
      </Animated.View>
      <Animated.View
        entering={SlideInLeft.duration(220)}
        exiting={SlideOutLeft.duration(160)}
        style={{ paddingTop: insets.top, paddingBottom: insets.bottom }}
        className="absolute inset-y-0 left-0 w-sidebar"
      >
        <View className="my-2 ml-2 flex-1">
          <Sidebar onHide={onClose} onDone={onClose} />
        </View>
      </Animated.View>
    </View>
  );
}

/** The frame for `layout`, around the native tabs. */
export function Shell({
  layout,
  children,
}: {
  readonly layout: ShellLayout;
  readonly children: ReactNode;
}) {
  const insets = useSafeAreaInsets();
  const margin = useThemeLength("--spacing-2");
  const nowPlaying = useSong();
  const [hidden, setHidden] = useState(false);
  const [overlaid, setOverlaid] = useState(false);
  const [lastSidebar, setLastSidebar] = useState(layout.sidebar);

  // An overlay left open would come back open on the next rotation to this size.
  if (lastSidebar !== layout.sidebar) {
    setLastSidebar(layout.sidebar);
    setOverlaid(false);
  }

  const beside = layout.sidebar === "pinned" && !hidden;
  const framed = layout.sidebar !== "none";
  const hasBar = layout.player === "bar" && nowPlaying !== null;
  const inspector = useInspector(layout.inspector, nowPlaying?.trackId ?? null);
  const panelSong = inspector.open ? nowPlaying : null;

  const control = useMemo<SidebarControl | null>(() => {
    if (layout.sidebar === "none") return null;

    return {
      placement: beside ? "beside" : "hidden",
      toggle: () => {
        if (layout.sidebar === "pinned") setHidden((current) => !current);
        else setOverlaid((current) => !current);
      },
    };
  }, [layout.sidebar, beside]);

  return (
    <View className="flex-1 bg-canvas">
      <SidebarControlContext value={control}>
        <View
          className="flex-1 flex-row"
          style={
            framed
              ? {
                  paddingTop: insets.top + margin,
                  paddingBottom: hasBar ? margin : insets.bottom + margin,
                }
              : undefined
          }
        >
          {beside ? (
            <View className="w-sidebar ml-2 shrink-0">
              <Sidebar onHide={() => setHidden(true)} onDone={noop} />
            </View>
          ) : null}
          <ContentArea framed={framed}>{children}</ContentArea>
          {panelSong !== null && inspector.placement === "pane" ? (
            <InspectorPane song={panelSong} inspector={inspector} />
          ) : null}
        </View>
        {panelSong !== null && inspector.placement === "sheet" ? (
          <InspectorSheet song={panelSong} inspector={inspector} />
        ) : null}
        {hasBar ? <PlayerBar inspector={inspector} /> : null}
        {overlaid ? <SidebarOverlay onClose={() => setOverlaid(false)} /> : null}
      </SidebarControlContext>
    </View>
  );
}
