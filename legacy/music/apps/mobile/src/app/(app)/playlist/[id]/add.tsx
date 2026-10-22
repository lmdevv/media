/**
 * Add songs (C05's Add songs, C02's plus, C07's Add): every song, or search results while typing,
 * each with a plus that adds it to the playlist at once and turns into a check. Paper doesn't draw
 * this picker; it is built from the Songs list and Search.
 */
import { PlaylistId } from "@music/commands/ids";
import type { TrackId } from "@music/commands/ids";
import type { PlaylistDetail, Track } from "@music/commands/models";
import { errorMessage } from "@music/sdk/errors";
import { useRead, useRun } from "@music/sdk/react";
import { FlashList } from "@shopify/flash-list";
import { useLocalSearchParams } from "expo-router";
import * as Haptics from "expo-haptics";
import { Plus, Search, X } from "lucide-react-native";
import { useDeferredValue, useState } from "react";
import { Pressable, TextInput, View } from "react-native";

import { ContentUnavailable } from "@/components/states/content-unavailable";
import { usePlaylist } from "@/components/playlists/use-playlist";
import { useTrackPages } from "@/components/playlists/use-track-pages";
import { Icon } from "@/components/ui/icon";
import { IconButton } from "@/components/ui/icon-button";
import { NavBar } from "@/components/ui/nav-bar";
import { Row, RowCheck } from "@/components/ui/row";
import { Text } from "@/components/ui/text";

/** Search results to show at most. */
const SEARCH_LIMIT = 50;

/** The search field, stuck under the bar. */
function SearchField({
  query,
  onChange,
}: {
  readonly query: string;
  readonly onChange: (query: string) => void;
}) {
  return (
    <View className="px-mobile-edge pb-3">
      <View className="min-h-row-touch flex-row items-center gap-2 rounded-full bg-surface px-4">
        <Icon icon={Search} tone="muted" size="inline" />
        <TextInput
          value={query}
          onChangeText={onChange}
          placeholder="Songs, albums, or artists"
          accessibilityLabel="Search songs"
          autoCorrect={false}
          returnKeyType="search"
          clearButtonMode="never"
          maxFontSizeMultiplier={1.6}
          placeholderTextColorClassName="accent-text-muted"
          selectionColorClassName="accent-accent"
          className="flex-1 py-4 font-sans text-md text-text"
        />
        {query.length === 0 ? null : (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Clear search"
            hitSlop={12}
            onPress={() => onChange("")}
            className="active:opacity-60"
          >
            <Icon icon={X} tone="muted" size="inline" />
          </Pressable>
        )}
      </View>
    </View>
  );
}

function Picker({ detail }: { readonly detail: PlaylistDetail }) {
  const playlistId = detail.playlist.id;
  const add = useRun("playlists.add");
  const [query, setQuery] = useState("");
  const typed = useDeferredValue(query.trim());
  const songs = useTrackPages("tracks.list", { eager: false });
  const results = useRead("search", typed === "" ? "skip" : { query: typed, limit: SEARCH_LIMIT });
  const [adding, setAdding] = useState<ReadonlySet<TrackId>>(new Set());
  const [failure, setFailure] = useState<string | null>(null);

  const inPlaylist = new Set(
    detail.items.flatMap((entry) => (entry.track === null ? [] : [entry.track.id])),
  );

  const tracks = typed === "" ? (songs?.tracks ?? []) : (results?.tracks ?? []);

  const addTrack = async (track: Track) => {
    if (inPlaylist.has(track.id) || adding.has(track.id)) return;
    setAdding((set) => new Set([...set, track.id]));
    setFailure(null);

    try {
      await add({ playlistId, trackIds: [track.id] });
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    } catch (cause) {
      setFailure(cause instanceof Error ? errorMessage(cause) : "Couldn’t add that song.");
    } finally {
      setAdding((set) => new Set([...set].filter((id) => id !== track.id)));
    }
  };

  // The field sits above the list rather than in it, so recycling never touches the focused input.
  return (
    <View className="flex-1 bg-canvas">
      <NavBar title={`Add to ${detail.playlist.name}`} />
      <SearchField query={query} onChange={setQuery} />
      {failure === null ? null : (
        <Text variant="calloutMedium" tone="danger" className="px-mobile-edge pb-2">
          {failure}
        </Text>
      )}
      <FlashList
        data={tracks}
        extraData={[inPlaylist.size, adding]}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        automaticallyAdjustKeyboardInsets
        keyExtractor={(track) => track.id}
        onEndReached={typed === "" ? songs?.more : undefined}
        onEndReachedThreshold={1}
        ListFooterComponent={
          <View className="px-mobile-edge pb-row">
            {typed !== "" && results !== undefined && results.tracks.length === 0 ? (
              <Text tone="muted" className="py-4">{`No songs match “${typed}”.`}</Text>
            ) : null}
          </View>
        }
        renderItem={({ item: track }) => {
          const added = inPlaylist.has(track.id);

          return (
            <View className="px-mobile-edge">
              <Row
                title={track.title}
                subtitle={track.artist}
                leading={{ kind: "art", url: track.artUrl, recyclingKey: track.id }}
                accessibilityLabel={`${track.title}, ${track.artist}${added ? ", added" : ""}`}
                onPress={() => void addTrack(track)}
                trailing={
                  added ? (
                    <RowCheck />
                  ) : (
                    <IconButton
                      icon={Plus}
                      label={`Add ${track.title}`}
                      tone="muted"
                      size="inline"
                      disabled={adding.has(track.id)}
                      onPress={() => void addTrack(track)}
                    />
                  )
                }
              />
            </View>
          );
        }}
      />
    </View>
  );
}

export default function AddSongs() {
  const { id } = useLocalSearchParams<{ id: string }>();

  const state = usePlaylist(PlaylistId.make(id));

  if (state.kind === "loading") return <NavBar title="Add songs" />;

  if (state.kind !== "ready") return <ContentUnavailable kind="playlist" state={state} />;

  return <Picker detail={state.detail} />;
}
