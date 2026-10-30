/**
 * The player bar under the iPad's content (page 26, B1's foot and A3's), in place of the iPhone's
 * mini player: the song, the transport over the scrubber, and the format, lyrics, queue, and device
 * buttons. A `wide` window has the room for the heart, shuffle, repeat, and the format; a `tablet`
 * one drops them (A3). The lyrics and queue buttons open the Now Playing panel on that tab and are
 * lit while it shows; pressing the lit one hides it. The song itself opens full-screen Now Playing.
 * Everything acts on whichever device plays. Only the scrubber re-renders with the position. The
 * bar is absent with nothing queued.
 */
import { lyricsButton } from "@music/player/lyrics";
import { router } from "expo-router";
import { ListMusic, MessageSquareQuote, Speaker } from "lucide-react-native";
import { Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { LikeButton } from "@/components/playback/like-button";
import { Scrubber } from "@/components/playback/scrubber";
import { BarTransport } from "@/components/playback/transport";
import { Artwork } from "@/components/ui/artwork";
import { IconButton } from "@/components/ui/icon-button";
import { Text } from "@/components/ui/text";
import { formatBadge } from "@/lib/playback-format";
import { DEVICE_FAMILY } from "@/lib/this-device";
import { useWindowLayout } from "@/lib/window-layout";
import { useNowPlaying } from "@/player";

import type { Inspector } from "./use-inspector";

/** What the bar holds at each window width. */
const BAR = {
  wide: { gap: "gap-6", song: "w-ios-320", tools: "w-ios-320", extras: true },
  tablet: { gap: "gap-4", song: "w-ios-240", tools: "", extras: false },
} as const;

/** Lit as Paper draws it: the accent on its wash, while the panel shows this button's tab. */
const litClass = (lit: boolean): string => (lit ? "bg-accent/12" : "");

/** The bar for what is playing; nothing with nothing queued. */
export function PlayerBar({ inspector }: { readonly inspector: Inspector }) {
  const { nowPlaying, role } = useNowPlaying();
  const insets = useSafeAreaInsets();
  const { widthClass } = useWindowLayout();

  if (nowPlaying === null) return null;

  const { gap, song, tools, extras } = widthClass === "wide" ? BAR.wide : BAR.tablet;
  const badge = extras ? formatBadge(nowPlaying) : null;
  const remote = role.kind === "remote";
  const lit = inspector.open ? inspector.tab : null;
  const lyrics = lyricsButton(inspector.offer, false);

  return (
    <View
      className="border-t border-border bg-canvas px-6 pt-3 shadow-lg shadow-glass-shadow dark:border-canvas"
      style={{ paddingBottom: insets.bottom }}
    >
      <View className={`h-16 flex-row items-center ${gap}`}>
        <View className={`flex-row items-center gap-3 ${song}`}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Now playing: ${nowPlaying.title}, ${nowPlaying.artist}`}
            accessibilityHint="Opens Now Playing"
            onPress={() => router.push("/player")}
            className="min-w-0 flex-1 flex-row items-center gap-3 active:opacity-60"
          >
            <Artwork
              url={nowPlaying.artUrl}
              recyclingKey={nowPlaying.trackId}
              className="size-ios-52 shrink-0 rounded-md"
            />
            <View className="min-w-0 flex-1">
              <Text variant="bodyStrong" numberOfLines={1}>
                {nowPlaying.title}
              </Text>
              <Text variant="secondary" tone="muted" numberOfLines={1}>
                {nowPlaying.artist}
              </Text>
            </View>
          </Pressable>
          {extras ? (
            <LikeButton trackId={nowPlaying.trackId} liked={nowPlaying.liked} size="side" />
          ) : null}
        </View>
        <View className="min-w-0 flex-1 items-center self-stretch">
          <BarTransport modes={extras} />
          <Scrubber inline />
        </View>
        <View className={`shrink-0 flex-row items-center justify-end gap-2 ${tools}`}>
          {badge === null ? null : (
            <View className="rounded-xs border border-border px-ios-6 py-ios-3">
              <Text variant="mono" tone="muted" numberOfLines={1}>
                {badge}
              </Text>
            </View>
          )}
          <IconButton
            icon={MessageSquareQuote}
            label={lyrics.label}
            size="side"
            tone={lit === "lyrics" ? "accent" : "default"}
            disabled={lyrics.disabled}
            loading={lyrics.loading}
            accessibilityState={{ selected: lit === "lyrics", disabled: lyrics.disabled }}
            className={`${litClass(lit === "lyrics")} ${lyrics.disabled ? "opacity-disabled" : ""}`}
            onPress={() => {
              inspector.pressPanel("lyrics");
            }}
          />
          <IconButton
            icon={ListMusic}
            label="Queue"
            size="side"
            tone={lit === "queue" ? "accent" : "default"}
            accessibilityState={{ selected: lit === "queue" }}
            className={litClass(lit === "queue")}
            onPress={() => {
              inspector.pressPanel("queue");
            }}
          />
          <IconButton
            icon={Speaker}
            label={remote ? `Playing on ${role.device.name}` : `This ${DEVICE_FAMILY}`}
            accessibilityHint="Chooses where the music plays"
            size="side"
            tone={remote ? "accent" : "default"}
            className={remote ? "bg-accent/12" : ""}
            onPress={() => router.push("/devices")}
          />
        </View>
      </View>
    </View>
  );
}
