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
import { DetailHeader, DetailHeaderPlaceholder } from "@/components/browse/detail-header";
import { ListPage } from "@/components/browse/list-page";
import { usePlayList } from "@/components/browse/play";
import { PlayShuffle } from "@/components/browse/play-shuffle";
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
import { useContentLayout } from "@/lib/window-layout";
import { useNowPlaying, usePlayerActions } from "@/player";

const decodeId = Schema.decodeUnknownOption(ArtistId);

const HERO_HEIGHT = 440;

const SCRIM_STOPS = [
  { from: 0.38, to: 0.72 },
  { from: 0.55, to: 1 },
] as const;

const statsOf = (detail: ArtistDetail): string =>
  [
    countOf(detail.artist.albumCount, "album"),
    countOf(
      detail.albums.reduce((sum, album) => sum + album.trackCount, 0),
      "song",
    ),
  ].join(" · ");

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
          className="absolute inset-0 border-b border-border bg-content"
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
  const { tablet } = useContentLayout();
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

  const onScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const next = event.nativeEvent.contentOffset.y > HERO_HEIGHT - insets.top - 60;

    if (next !== collapsed) setCollapsed(next);
  };

  const menu =
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
    );

  const top = tablet ? (
    <View className="px-page">
      {detail === undefined ? (
        <DetailHeaderPlaceholder />
      ) : (
        <DetailHeader
          art={{ url: detail.artist.artUrl, recyclingKey: detail.artist.id }}
          facts={statsOf(detail).toLocaleUpperCase("en-US")}
          title={detail.artist.name}
          actions={
            tracks.length === 0 ? null : (
              <PlayShuffle
                width="natural"
                onPlay={() => playAll(trackIds, false)}
                onShuffle={() => playAll(trackIds, true)}
              />
            )
          }
        />
      )}
    </View>
  ) : detail === undefined ? (
    <View className="h-ios-440 bg-art" />
  ) : (
    <Hero detail={detail} onPlay={(shuffle) => playAll(trackIds, shuffle)} />
  );

  return (
    <View className="flex-1 bg-content">
      <ListPage
        bar={tablet ? { trailing: menu } : null}
        data={tracks}
        extraData={playingId}
        keyExtractor={(track) => track.id}
        onScroll={tablet ? undefined : onScroll}
        scrollEventThrottle={tablet ? undefined : 16}
        contentInsetAdjustmentBehavior={tablet ? undefined : "never"}
        header={
          <>
            {top}
            {tracks.length === 0 ? null : (
              <View className="px-page pt-1">
                <SectionHeader title="Top songs" />
              </View>
            )}
          </>
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
      {tablet ? null : (
        <TopBar name={detail?.artist.name ?? ""} collapsed={collapsed} menu={menu} />
      )}
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
