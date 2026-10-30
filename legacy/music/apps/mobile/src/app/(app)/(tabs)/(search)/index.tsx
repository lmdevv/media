/**
 * A09, A10, A13, A16, G03 · Search. iOS draws the field: selecting the Search tab turns the tab
 * bar into it beside a return button and focuses it, so searching starts at once (A13, A17); it
 * rises above the keyboard with a Cancel circle while the tabs and mini player hide (A13, A16). Before typing the page offers what was played
 * lately; focused with nothing typed it lists what was opened from Search before. Typing shows
 * live results by kind with filter chips (A10), or says nothing matched (G03). Clearing keeps the
 * keyboard; Cancel empties the field and returns to browsing. The tab stays mounted, so leaving
 * for another tab and coming back keeps the query and the scroll.
 *
 * On an iPad the tab bar is hidden: the sidebar's Search row opens this screen and focuses the
 * field, which iOS draws in the header, and the page draws the title under it.
 */
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

/** How long typing pauses before the search runs. */
const DEBOUNCE_MS = 250;

/** Results of each kind the server returns at most. */
const RESULT_LIMIT = 50;

/** Recently played songs offered before typing (A09). */
const RECENTLY_PLAYED = 3;

/** Plays read to find them, since one song often plays several times in a row. */
const PLAYS_READ = 50;

/** `text` once it has stopped changing for a moment, trimmed. */
const useSettled = (text: string): string => {
  const [settled, setSettled] = useState(text.trim());

  useEffect(() => {
    const timer = setTimeout(() => setSettled(text.trim()), DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [text]);

  return settled;
};

/**
 * `value`, or the last value that wasn't undefined while it is, so results stay on screen while
 * the next query loads rather than flashing empty.
 */
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
  // The bar's height with its title collapsed; iOS insets the list by it.
  const barHeight = useHeaderHeight();
  const [typed, setTyped] = useState("");
  const [focused, setFocused] = useState(false);
  const [filter, setFilter] = useState<SearchFilter>("all");
  const query = useSettled(typed);

  const navigation = useNavigation();
  // Set when the Search tab is selected while another tab is on screen; the field focuses once
  // this screen is.
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
  // A launch that never reached the server has nothing to search.
  const offline = useServerReach() === "offline";

  const searching = query !== "" && typed.trim() !== "";
  const played = distinctSongs(plays ?? [], RECENTLY_PLAYED);
  const browsing = !searching && !(focused && recents.length > 0);

  // Which page the list shows; a new one starts from its top.
  const page = searching ? `results:${filter}:${query}` : browsing ? "browse" : "recents";
  const shownPage = useRef<string | null>(null);

  // Under the collapsed bar, once the new rows lay out (scrolling before that lands short). A
  // point inside the collapsed range, since exactly at its edge UIKit can leave the large title
  // open with the rows under it. The first page keeps the large title open.
  useEffect(() => {
    const previous = shownPage.current;

    shownPage.current = page;

    if (previous === null || previous === page) return;

    list.current?.scrollToOffset({ offset: 1 - barHeight, animated: false });
  }, [page, barHeight]);

  /** The songs a song row plays from: the results while searching, else the recent plays. */
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
          // Beside the iPad's sidebar UIKit runs a large title into its edge, so the page draws it.
          title: sidebar === null ? "Search" : "",
          headerLargeTitleEnabled: sidebar === null,
          headerShadowVisible: false,
          headerLargeTitleShadowVisible: false,
          headerTintColor: text,
          headerLargeTitleStyle: { fontFamily: heavy, color: text },
          headerTitleStyle: { fontFamily: semibold, color: text },
          contentStyle: { backgroundColor: canvas },
          // Options merge, so these say null rather than leave a key out: rotating to a pinned
          // sidebar must take the buttons away. Pinned, it holds the account; hidden, the page
          // offers the way back to it (A3).
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
        // React Native clamps scrolling at zero, but iOS insets the list for the bar above it.
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

/** The result "All" leads with, as the row its kind uses. */
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

/** An artist found: "Artist · 6 albums" as the top result, the album count in the list. */
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

/** Something opened from Search before (A16). */
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

/** G03: the search found nothing; Edit search brings the keyboard back to the query. */
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
