import { lyricsButton } from "@media/player/lyrics";
import { router } from "expo-router";
import { ListMusic, MessageSquareQuote, Speaker } from "lucide-react-native";
import { Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { LikeButton } from "@/components/playback/like-button";
import { HIDDEN_SONG } from "@/components/playback/mini-player";
import { Scrubber } from "@/components/playback/scrubber";
import { BarTransport } from "@/components/playback/transport";
import { Artwork } from "@/components/ui/artwork";
import { IconButton } from "@/components/ui/icon-button";
import { Text } from "@/components/ui/text";
import { creditText } from "@/lib/credits";
import { formatBadge } from "@/lib/playback-format";
import { whereItPlays } from "@/lib/this-device";
import { useWindowLayout } from "@/lib/window-layout";
import { useNowPlaying } from "@/player";

import type { Inspector } from "./use-inspector";

const BAR = {
  wide: { gap: "gap-6", song: "w-ios-320", tools: "w-ios-320", extras: true },
  tablet: { gap: "gap-4", song: "w-ios-240", tools: "", extras: false },
} as const;

const litClass = (lit: boolean): string => (lit ? "bg-accent/12" : "");

/**
 * The bar while a Jam plays a song this person may not play, as a kid an explicit one: its name
 * hidden, and the Jam's transport.
 */
function HiddenSongBar() {
  const insets = useSafeAreaInsets();
  const { widthClass } = useWindowLayout();
  const { gap, song, tools } = widthClass === "wide" ? BAR.wide : BAR.tablet;

  return (
    <View
      className="border-t border-border bg-canvas px-6 pt-3 shadow-lg shadow-glass-shadow dark:border-canvas"
      style={{ paddingBottom: insets.bottom }}
    >
      <View className={`h-16 flex-row items-center ${gap}`}>
        <View className={`min-w-0 ${song}`}>
          <Text variant="bodyStrong" numberOfLines={1}>
            {HIDDEN_SONG.title}
          </Text>
          <Text variant="secondary" tone="muted" numberOfLines={1}>
            {HIDDEN_SONG.artist}
          </Text>
        </View>
        <View className="min-w-0 flex-1 items-center self-stretch">
          <BarTransport modes={false} />
        </View>
        <View className={`shrink-0 ${tools}`} />
      </View>
    </View>
  );
}

/** The bar for what is playing; nothing with nothing queued. */
export function PlayerBar({ inspector }: { readonly inspector: Inspector }) {
  const { nowPlaying, remote, hidden } = useNowPlaying();
  const insets = useSafeAreaInsets();
  const { widthClass } = useWindowLayout();

  if (nowPlaying === null) return hidden ? <HiddenSongBar /> : null;

  const { gap, song, tools, extras } = widthClass === "wide" ? BAR.wide : BAR.tablet;
  const badge = extras ? formatBadge(nowPlaying) : null;
  const lit = inspector.open ? inspector.tab : null;
  const lyrics = lyricsButton(inspector.offer, false);
  const artists = creditText(nowPlaying);

  return (
    <View
      className="border-t border-border bg-canvas px-6 pt-3 shadow-lg shadow-glass-shadow dark:border-canvas"
      style={{ paddingBottom: insets.bottom }}
    >
      <View className={`h-16 flex-row items-center ${gap}`}>
        <View className={`flex-row items-center gap-3 ${song}`}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Now playing: ${nowPlaying.title}, ${artists}`}
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
                {artists}
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
            label={whereItPlays(remote)}
            accessibilityHint="Chooses where the music plays"
            size="side"
            tone={remote === null ? "default" : "accent"}
            className={remote === null ? "" : "bg-accent/12"}
            onPress={() => router.push("/devices")}
          />
        </View>
      </View>
    </View>
  );
}
