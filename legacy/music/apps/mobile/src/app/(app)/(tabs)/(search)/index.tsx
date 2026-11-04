import type { TrackId } from "@music/commands/ids";
import type { AlbumCard, ArtistCard, Track } from "@music/commands/models";
import { useRead } from "@music/sdk/react";
import { FlashList } from "@shopify/flash-list";
import type { FlashListRef } from "@shopify/flash-list";
import { Stack, router, useFocusEffect, useNavigation } from "expo-router";
import { useHeaderHeight } from "expo-router/react-navigation";
import { Search as SearchIcon } from "lucide-react-native";
import { useCallback, useEffect, useRef, useState } from "react";
import { View } from "react-native";
import type { SearchBarCommands } from "react-native-screens";
import { useCSSVariable } from "uniwind";

import { usePlayList } from "@/components/browse/play";
import { useRecentSearches } from "@/components/browse/recent-searches-store";
import { useFocusOnRequest, useOnSearchActivate } from "@/components/browse/search-activation";
import { AlbumRow, ArtistRow, TrackRow, openAlbum, openArtist } from "@/components/browse/rows";
import { ShowSidebarButton } from "@/components/shell/top-buttons";
import { useSidebarControl } from "@/components/shell/sidebar-control";
import { OfflineNotice, OfflineState } from "@/components/states/offline-notice";
import { AccountButton } from "@/components/ui/account-button";
import { Button } from "@/components/ui/button";
import { ChipGroup } from "@/components/ui/chip";
import { EmptyState } from "@/components/ui/empty-state";
import { SectionHeader } from "@/components/ui/section-header";
import { Text } from "@/components/ui/text";
import type { SectionAction } from "@/components/ui/section-header";
import { countOf } from "@/lib/format";
import { distinctSongs } from "@/lib/history";
import { recentAlbum, recentArtist, recentKey, recentTrack } from "@/lib/recent-searches";
import type { RecentItem } from "@/lib/recent-searches";
import { SEARCH_FILTERS, foundNothing, searchRows } from "@/lib/search-results";
import type { SearchFilter, SearchRow, TopResult } from "@/lib/search-results";
import { useThemeColor } from "@/lib/theme-color";
import { useContentCanvas } from "@/lib/window-layout";
import { useNowPlaying } from "@/player";
import { useServerReach } from "@/session/server-reach";

const DEBOUNCE_MS = 250;

const RESULT_LIMIT = 50;

const RECENTLY_PLAYED = 3;

const PLAYS_READ = 50;

const useSettled = (text: string): string => {
  const [settled, setSettled] = useState(text.trim());

  useEffect(() => {
    const timer = setTimeout(() => setSettled(text.trim()), DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [text]);

  return settled;
};

const useHeld = <Value,>(value: Value | undefined): Value | undefined => {
  const [held, setHeld] = useState(value);

  if (value !== undefined && value !== held) setHeld(value);

  return value ?? held;
};

/** A row of the page, whatever it shows. */
type PageRow =
  | SearchRow
  | {
      readonly kind: "heading";
      readonly key: string;
      readonly title: string;
      readonly action: SectionAction;
    }
  | { readonly kind: "recent"; readonly key: string; readonly item: RecentItem };

export default function Search() {
  const accent = useThemeColor("--color-accent");
  const text = useThemeColor("--color-text");
  const canvas = useContentCanvas();
  const sidebar = useSidebarControl();
  const heavy = String(useCSSVariable("--font-sans-heavy"));
  const semibold = String(useCSSVariable("--font-sans-semibold"));

  const field = useRef<SearchBarCommands>(null);
  const list = useRef<FlashListRef<PageRow>>(null);
  const barHeight = useHeaderHeight();
  const [typed, setTyped] = useState("");
  const [focused, setFocused] = useState(false);
  const [filter, setFilter] = useState<SearchFilter>("all");
  const query = useSettled(typed);

  const navigation = useNavigation();
  const focusOnArrival = useRef(false);

  useOnSearchActivate(
    useCallback(() => {
      if (navigation.isFocused()) field.current?.focus();
      else focusOnArrival.current = true;
    }, [navigation]),
  );

  const focusField = useCallback(() => field.current?.focus(), []);

  useFocusOnRequest(focusField, focused);

  useFocusEffect(
    useCallback(() => {
      if (!focusOnArrival.current) return;

      focusOnArrival.current = false;
      field.current?.focus();
    }, []),
  );

  const results = useHeld(
    useRead("search", query === "" ? "skip" : { query, limit: RESULT_LIMIT }),
  );

  const plays = useRead("history.list", { limit: PLAYS_READ });
  const { recents, remember, clear } = useRecentSearches();
  const playingId = useNowPlaying().nowPlaying?.trackId ?? null;
  const { playFrom } = usePlayList();
  const offline = useServerReach() === "offline";

  const searching = query !== "" && typed.trim() !== "";
  const played = distinctSongs(plays ?? [], RECENTLY_PLAYED);
  const browsing = !searching && !(focused && recents.length > 0);

  const page = searching ? `results:${filter}:${query}` : browsing ? "browse" : "recents";
  const shownPage = useRef<string | null>(null);

  useEffect(() => {
    const previous = shownPage.current;

    shownPage.current = page;

    if (previous === null || previous === page) return;

    list.current?.scrollToOffset({ offset: 1 - barHeight, animated: false });
  }, [page, barHeight]);

  const songs: ReadonlyArray<Track> = searching ? (results?.tracks ?? []) : played;
  const songIds: ReadonlyArray<TrackId> = songs.map((track) => track.id);

  const rows: ReadonlyArray<PageRow> = searching
    ? results === undefined
      ? []
      : searchRows(results, filter, query)
    : browsing
      ? played.length === 0
        ? []
        : [
            {
              kind: "heading",
              key: "heading:played",
              title: "Recently played",
              action: { kind: "chevron", onPress: () => router.push("/history") },
            },
            ...played.map((track, index) => ({
              kind: "track" as const,
              key: `track:${track.id}`,
              track,
              index,
            })),
          ]
      : [
          {
            kind: "heading",
            key: "heading:recents",
            title: "Recently searched",
            action: { kind: "link", label: "Clear", onPress: clear },
          },
          ...recents.map((item) => ({ kind: "recent" as const, key: recentKey(item), item })),
        ];

  const openTrack = (track: Track, index: number) => {
    if (searching) remember(recentTrack(track));
    playFrom(songIds, index);
  };

  const openAlbumResult = (album: AlbumCard) => {
    remember(recentAlbum(album));
    openAlbum(album);
  };

  const openArtistResult = (artist: ArtistCard) => {
    remember(recentArtist(artist));
    openArtist(artist);
  };

  const openRecent = (item: RecentItem) => {
    remember(item);

    if (item.kind === "track") {
      playFrom([item.id], 0);
    } else if (item.kind === "album") {
      openAlbum(item);
    } else {
      openArtist(item);
    }
  };

  const renderRow = (row: PageRow) => {
    if (row.kind === "heading" || row.kind === "section") {
      const more = row.kind === "section" ? row.more : null;

      return (
        <View className="px-page">
          <SectionHeader
            title={row.title}
            action={
              row.kind === "heading"
                ? row.action
                : more === null
                  ? undefined
                  : { kind: "link", label: "See all", onPress: () => setFilter(more) }
            }
          />
        </View>
      );
    }

    if (row.kind === "top") {
      return (
        <TopResultRow
          top={row.top}
          playingId={playingId}
          onTrack={openTrack}
          onAlbum={openAlbumResult}
          onArtist={openArtistResult}
        />
      );
    }

    if (row.kind === "track") {
      return (
        <TrackRow
          song={row.track}
          artUrl={row.track.artUrl}
          active={row.track.id === playingId}
          onPress={() => openTrack(row.track, row.index)}
        />
      );
    }

    if (row.kind === "album") {
      return <AlbumRow album={row.album} onPress={() => openAlbumResult(row.album)} />;
    }

    if (row.kind === "artist") {
      return <ArtistResult artist={row.artist} top={false} onOpen={openArtistResult} />;
    }

    return <RecentRow item={row.item} active={row.item.id === playingId} onOpen={openRecent} />;
  };

  return (
    <>
      <Stack.Screen
        options={{
          headerShown: true,
          title: sidebar === null ? "Search" : "",
          headerLargeTitleEnabled: sidebar === null,
          headerShadowVisible: false,
          headerLargeTitleShadowVisible: false,
          headerTintColor: text,
          headerLargeTitleStyle: { fontFamily: heavy, color: text },
          headerTitleStyle: { fontFamily: semibold, color: text },
          contentStyle: { backgroundColor: canvas },
          headerRight: () =>
            sidebar?.placement === "beside" ? null : <AccountButton solid={sidebar !== null} />,
          headerLeft: () =>
            sidebar?.placement === "hidden" ? <ShowSidebarButton onPress={sidebar.toggle} /> : null,
        }}
      />
      <Stack.SearchBar
        ref={field}
        placeholder="Your library"
        tintColor={accent}
        hideWhenScrolling={false}
        hideNavigationBar={false}
        autoCapitalize="none"
        onChangeText={(event) => setTyped(event.nativeEvent.text)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onCancelButtonPress={() => {
          setTyped("");
          setFilter("all");
        }}
        onSearchButtonPress={() => field.current?.blur()}
      />
      <FlashList
        ref={list}
        scrollToOverflowEnabled
        data={offline ? [] : rows}
        extraData={playingId}
        keyExtractor={(row) => row.key}
        getItemType={(row) => row.kind}
        contentInsetAdjustmentBehavior="automatic"
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        ListHeaderComponent={
          <View className="px-page">
            {sidebar === null ? null : (
              <Text variant="largeTitle" accessibilityRole="header" className="pt-4 pb-3">
                Search
              </Text>
            )}
            {offline ? (
              <OfflineState body="Search comes back when the server answers." />
            ) : (
              <OfflineNotice variant="card" className="mb-1" />
            )}
            {searching && results !== undefined && !foundNothing(results) ? (
              <ChipGroup
                label="Show"
                options={SEARCH_FILTERS}
                value={filter}
                onChange={setFilter}
              />
            ) : null}
          </View>
        }
        ListFooterComponent={
          <>
            {searching && results !== undefined && foundNothing(results) ? (
              <NoResults query={query} onEdit={() => field.current?.focus()} />
            ) : null}
            <View className="h-page-foot" />
          </>
        }
        renderItem={({ item }) => renderRow(item)}
      />
    </>
  );
}

function TopResultRow({
  top,
  playingId,
  onTrack,
  onAlbum,
  onArtist,
}: {
  readonly top: TopResult;
  readonly playingId: TrackId | null;
  readonly onTrack: (track: Track, index: number) => void;
  readonly onAlbum: (album: AlbumCard) => void;
  readonly onArtist: (artist: ArtistCard) => void;
}) {
  if (top.kind === "artist") return <ArtistResult artist={top.artist} top onOpen={onArtist} />;

  if (top.kind === "album")
    return <AlbumRow album={top.album} onPress={() => onAlbum(top.album)} />;

  return (
    <TrackRow
      song={top.track}
      artUrl={top.track.artUrl}
      subtitle={`Song · ${top.track.artist}`}
      active={top.track.id === playingId}
      onPress={() => onTrack(top.track, top.index)}
    />
  );
}

function ArtistResult({
  artist,
  top,
  onOpen,
}: {
  readonly artist: ArtistCard;
  readonly top: boolean;
  readonly onOpen: (artist: ArtistCard) => void;
}) {
  const albums = countOf(artist.albumCount, "album");

  return (
    <ArtistRow
      artist={artist}
      subtitle={top ? `Artist · ${albums}` : albums}
      onPress={() => onOpen(artist)}
    />
  );
}

function RecentRow({
  item,
  active,
  onOpen,
}: {
  readonly item: RecentItem;
  readonly active: boolean;
  readonly onOpen: (item: RecentItem) => void;
}) {
  if (item.kind === "track") {
    return (
      <TrackRow song={item} artUrl={item.artUrl} active={active} onPress={() => onOpen(item)} />
    );
  }

  if (item.kind === "album") {
    return <AlbumRow album={item} onPress={() => onOpen(item)} />;
  }

  return (
    <ArtistRow
      artist={item}
      subtitle={countOf(item.albumCount, "album")}
      onPress={() => onOpen(item)}
    />
  );
}

function NoResults({ query, onEdit }: { readonly query: string; readonly onEdit: () => void }) {
  return (
    <View className="px-page">
      <EmptyState
        icon={SearchIcon}
        title={"Nothing here\nyet."}
        body={`No songs, albums, or artists match\n“${query}”. Try another search.`}
        primary={<Button label="Edit search" onPress={onEdit} />}
      />
    </View>
  );
}
