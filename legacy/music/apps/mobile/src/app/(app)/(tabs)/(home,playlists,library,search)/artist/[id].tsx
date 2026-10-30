/**
 * A08b, A08c · Artist: their picture full bleed under the status bar, darkened toward the bottom,
 * with their name, how many of their albums and songs the library holds, Shuffle, and Play. Back
 * and the ellipsis float over it on glass. Then their top songs, numbered, and their albums in a
 * rail. Once the picture scrolls away a bar on the page color names the artist. A song plays the
 * top songs from there. An artist the viewer can no longer open is G10.
 */
import { ArtistId } from "@music/commands/ids";
import type { AlbumId } from "@music/commands/ids";
import type { ArtistDetail, Track } from "@music/commands/models";
import { useReadSettled } from "@music/sdk/react";
import { Option, Schema } from "effect";
import { LinearGradient } from "expo-linear-gradient";
import { router, useLocalSearchParams } from "expo-router";
import { ChevronLeft, Play, Shuffle } from "lucide-react-native";
import type { LucideIcon } from "lucide-react-native";
import { useState } from "react";
import type { ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import type { NativeScrollEvent, NativeSyntheticEvent } from "react-native";
import Animated, { FadeIn, FadeOut } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AlbumRail } from "@/components/browse/album-rail";
import { ListPage } from "@/components/browse/list-page";
import { usePlayList } from "@/components/browse/play";
import { openSongActions } from "@/components/browse/rows";
import { MenuButton } from "@/components/playback/menu-button";
import { ContentUnavailable } from "@/components/states/content-unavailable";
import { Artwork } from "@/components/ui/artwork";
import { Icon } from "@/components/ui/icon";
import { RowMore } from "@/components/ui/row";
import { SectionHeader } from "@/components/ui/section-header";
import { Text } from "@/components/ui/text";
import { clearOf } from "@/lib/color";
import { detailStateOf } from "@/lib/detail-state";
import { countOf } from "@/lib/format";
import { useThemeColor } from "@/lib/theme-color";
import { useNowPlaying, usePlayerActions } from "@/player";

const decodeId = Schema.decodeUnknownOption(ArtistId);

/** The hero's height, Paper's 440pt. */
const HERO_HEIGHT = 440;

/** Paper's two scrims over the picture: a long one under the name, a short one at the foot. */
const SCRIM_STOPS = [
  { from: 0.38, to: 0.72 },
  { from: 0.55, to: 1 },
] as const;

/** "6 albums · 61 songs": the albums the library holds, and the songs on them. */
const statsOf = (detail: ArtistDetail): string =>
  [
    countOf(detail.artist.albumCount, "album"),
    countOf(
      detail.albums.reduce((sum, album) => sum + album.trackCount, 0),
      "song",
    ),
  ].join(" · ");

/** A 44pt glass circle over the picture: Back, the ellipsis's look, and Shuffle. */
function GlassButton({
  icon,
  label,
  size = "nav",
  onPress,
}: {
  readonly icon: LucideIcon;
  readonly label: string;
  readonly size?: "nav" | "inline";
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      className="size-hit-target items-center justify-center rounded-full border border-border bg-glass active:opacity-60"
    >
      <Icon icon={icon} size={size} />
    </Pressable>
  );
}

/** The picture with the name, the counts, Shuffle, and Play. */
function Hero({
  detail,
  onPlay,
}: {
  readonly detail: ArtistDetail;
  readonly onPlay: (shuffle: boolean) => void;
}) {
  const scrim = useThemeColor("--color-scrim");
  const playable = detail.topTracks.length > 0;

  return (
    <View className="h-ios-440 justify-end px-page pb-6">
      <Artwork
        url={detail.artist.artUrl}
        recyclingKey={detail.artist.id}
        className="absolute inset-0"
      />
      {SCRIM_STOPS.map((stop) => (
        <LinearGradient
          key={stop.from}
          colors={[clearOf(scrim), scrim, scrim]}
          locations={[stop.from, stop.to, 1]}
          style={StyleSheet.absoluteFill}
          pointerEvents="none"
        />
      ))}
      <View className="flex-row items-end gap-4">
        <View className="min-w-0 flex-1 gap-1">
          <Text variant="display" tone="overArt" accessibilityRole="header" numberOfLines={2}>
            {detail.artist.name}
          </Text>
          <Text variant="calloutMedium" tone="overArt">
            {statsOf(detail)}
          </Text>
        </View>
        {playable ? (
          <View className="flex-row items-center gap-3">
            <GlassButton
              icon={Shuffle}
              label="Shuffle"
              size="inline"
              onPress={() => onPlay(true)}
            />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Play"
              onPress={() => onPlay(false)}
              className="size-ios-60 items-center justify-center rounded-full bg-accent active:opacity-80"
            >
              <Icon icon={Play} tone="onAccent" filled />
            </Pressable>
          </View>
        ) : null}
      </View>
    </View>
  );
}

/** A top song: its rank, 44pt cover, title over album and year, and its actions. */
function TopSong({
  track,
  rank,
  year,
  last,
  active,
  onPress,
}: {
  readonly track: Track;
  readonly rank: number;
  readonly year: number | null;
  readonly last: boolean;
  readonly active: boolean;
  readonly onPress: () => void;
}) {
  const subtitle = year === null ? track.album : `${track.album} · ${String(year)}`;

  return (
    <View className="h-row-touch flex-row items-center gap-3 px-page">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${String(rank)}. ${track.title}, ${subtitle}`}
        onPress={onPress}
        onLongPress={() => openSongActions(track)}
        className="h-full min-w-0 flex-1 flex-row items-center gap-3 active:opacity-60"
      >
        <Text variant="label" tone="muted" className="w-mobile-edge text-center">
          {String(rank)}
        </Text>
        <Artwork
          url={track.artUrl}
          recyclingKey={track.id}
          className="size-hit-target shrink-0 rounded-sm"
        />
        <View
          className={`h-full min-w-0 flex-1 justify-center ${last ? "" : "border-b border-border"}`}
        >
          <Text
            variant={active ? "bodyStrong" : "bodyMedium"}
            tone={active ? "accent" : "default"}
            numberOfLines={1}
          >
            {track.title}
          </Text>
          <Text variant="secondary" tone="muted" numberOfLines={1}>
            {subtitle}
          </Text>
        </View>
      </Pressable>
      <View className={`h-full w-8 justify-center ${last ? "" : "border-b border-border"}`}>
        <RowMore label={`More, ${track.title}`} onPress={() => openSongActions(track)} />
      </View>
    </View>
  );
}

/**
 * The floating top: Back and the ellipsis on glass, and once the picture has scrolled away the
 * page color behind them with the artist's name.
 */
function TopBar({
  name,
  collapsed,
  menu,
}: {
  readonly name: string;
  readonly collapsed: boolean;
  readonly menu: ReactNode;
}) {
  const insets = useSafeAreaInsets();

  return (
    <View
      className="absolute inset-x-0 top-0"
      style={{ paddingTop: insets.top }}
      pointerEvents="box-none"
    >
      {collapsed ? (
        <Animated.View
          entering={FadeIn.duration(180)}
          exiting={FadeOut.duration(120)}
          className="absolute inset-0 border-b border-border bg-canvas"
          pointerEvents="none"
        />
      ) : null}
      <View
        className="h-ios-60 flex-row items-center justify-between px-4"
        pointerEvents="box-none"
      >
        <GlassButton icon={ChevronLeft} label="Back" onPress={() => router.back()} />
        {collapsed ? (
          <Animated.View
            entering={FadeIn.duration(180)}
            exiting={FadeOut.duration(120)}
            className="absolute inset-x-ios-72 items-center"
            pointerEvents="none"
          >
            <Text variant="bodyStrong" numberOfLines={1}>
              {name}
            </Text>
          </Animated.View>
        ) : null}
        {menu === null || menu === undefined ? (
          <View className="size-hit-target" />
        ) : (
          <View className="size-hit-target items-center justify-center rounded-full border border-border bg-glass">
            {menu}
          </View>
        )}
      </View>
    </View>
  );
}

function Artist({ artistId }: { readonly artistId: ArtistId }) {
  const state = detailStateOf(
    useReadSettled("artists.get", { artistId }),
    "Couldn’t load this artist.",
  );

  const playingId = useNowPlaying().nowPlaying?.trackId ?? null;
  const { playFrom, playAll } = usePlayList();
  const { playNext } = usePlayerActions();
  const insets = useSafeAreaInsets();
  const [collapsed, setCollapsed] = useState(false);

  if (state.kind === "unavailable" || state.kind === "failed") {
    return <ContentUnavailable kind="artist" state={state} />;
  }

  const detail = state.kind === "ready" ? state.detail : undefined;
  const tracks = detail?.topTracks ?? [];
  const trackIds = tracks.map((track) => track.id);

  const years = new Map<AlbumId, number | null>(
    (detail?.albums ?? []).map((album) => [album.id, album.year]),
  );

  // The bar takes over once the picture's foot passes under it.
  const onScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const next = event.nativeEvent.contentOffset.y > HERO_HEIGHT - insets.top - 60;

    if (next !== collapsed) setCollapsed(next);
  };

  return (
    <View className="flex-1 bg-canvas">
      <ListPage
        bar={null}
        data={tracks}
        extraData={playingId}
        keyExtractor={(track) => track.id}
        onScroll={onScroll}
        scrollEventThrottle={16}
        contentInsetAdjustmentBehavior="never"
        header={
          detail === undefined ? (
            <View className="h-ios-440 bg-art" />
          ) : (
            <>
              <Hero detail={detail} onPlay={(shuffle) => playAll(trackIds, shuffle)} />
              {tracks.length === 0 ? null : (
                <View className="px-page pt-1">
                  <SectionHeader title="Top songs" />
                </View>
              )}
            </>
          )
        }
        footer={
          detail === undefined || detail.albums.length === 0 ? null : (
            <View className="px-page pt-3">
              <AlbumRail title="Albums" albums={detail.albums} size="artist" />
            </View>
          )
        }
        renderItem={({ item, index }) => (
          <TopSong
            track={item}
            rank={index + 1}
            year={years.get(item.albumId) ?? null}
            last={index === tracks.length - 1}
            active={item.id === playingId}
            onPress={() => playFrom(trackIds, index)}
          />
        )}
      />
      <TopBar
        name={detail?.artist.name ?? ""}
        collapsed={collapsed}
        menu={
          trackIds.length === 0 ? null : (
            <MenuButton
              label="More"
              items={[
                {
                  title: "Play next",
                  icon: "text.line.first.and.arrowtriangle.forward",
                  onPress: () => void playNext(trackIds),
                },
                { title: "Shuffle", icon: "shuffle", onPress: () => playAll(trackIds, true) },
              ]}
            />
          )
        }
      />
    </View>
  );
}

export default function ArtistScreen() {
  const artistId = Option.getOrNull(decodeId(useLocalSearchParams().id));

  return artistId === null ? (
    <ListPage bar={{ title: "Artist" }} data={[]} renderItem={() => null} />
  ) : (
    <Artist artistId={artistId} />
  );
}
