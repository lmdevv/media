/**
 * C07 · Edit playlist: the owner renames and describes it; the owner and collaborators reorder
 * songs by their grips and remove them with the red buttons. Nothing changes until the check
 * saves the draft; Back discards it. Saving sends the fewest moves that reach the new order.
 */
import { PlaylistId } from "@music/commands/ids";
import type { PlaylistItemId } from "@music/commands/ids";
import type { PlaylistDetail, PlaylistEntry } from "@music/commands/models";
import { canEditPlaylistItems, canManagePlaylist } from "@music/commands/permissions";
import { errorMessage } from "@music/sdk/errors";
import { useRun } from "@music/sdk/react";
import { router, useLocalSearchParams } from "expo-router";
import * as Haptics from "expo-haptics";
import { Check } from "lucide-react-native";
import { useState } from "react";
import { View } from "react-native";
import Animated, { useAnimatedRef, useScrollOffset, useSharedValue } from "react-native-reanimated";

import { openAddSongs } from "@/components/playlists/playlist-header";
import { PlaylistFields, isSavable } from "@/components/playlists/playlist-fields";
import type { PlaylistText } from "@/components/playlists/playlist-fields";
import { ReorderList } from "@/components/playlists/reorder-list";
import { ContentUnavailable } from "@/components/states/content-unavailable";
import { usePlaylist } from "@/components/playlists/use-playlist";
import { IconButton } from "@/components/ui/icon-button";
import { NavBar } from "@/components/ui/nav-bar";
import { Page } from "@/components/ui/page";
import { Row } from "@/components/ui/row";
import { SectionHeader } from "@/components/ui/section-header";
import { Text } from "@/components/ui/text";
import { moveIndex, planMoves, reconcileOrder } from "@/lib/playlist-order";

/** The nav bar is the scroll view's first child, and stays at the top. */
const STICKY_BAR = [0];

/** The edit in progress: new text, and the songs in their new order without the removed ones. */
interface Draft {
  readonly text: PlaylistText;
  readonly order: ReadonlyArray<PlaylistItemId>;
  readonly removed: ReadonlySet<PlaylistItemId>;
}

const draftOf = (detail: PlaylistDetail): Draft => ({
  text: { name: detail.playlist.name, description: detail.playlist.description ?? "" },
  order: detail.items.map((entry) => entry.itemId),
  removed: new Set(),
});

function Editor({ detail }: { readonly detail: PlaylistDetail }) {
  const update = useRun("playlists.update");
  const remove = useRun("playlists.remove");
  const move = useRun("playlists.move");
  const scrollRef = useAnimatedRef<Animated.ScrollView>();
  const scroll = useScrollOffset(scrollRef);
  const content = useSharedValue(0);
  const viewport = useSharedValue(0);
  const maxScroll = useSharedValue(0);
  const [draft, setDraft] = useState(() => draftOf(detail));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { playlist } = detail;
  const owner = canManagePlaylist(playlist.access);
  const ready = (!owner || isSavable(draft.text)) && !pending;

  // The server's entries by ID; the draft keeps its order, and shows what the server still has.
  const entries = new Map(detail.items.map((entry) => [entry.itemId, entry]));

  const shown = reconcileOrder(
    draft.order,
    detail.items.map((entry) => entry.itemId),
  )
    .filter((itemId) => !draft.removed.has(itemId))
    .flatMap((itemId) => {
      const entry = entries.get(itemId);

      return entry === undefined ? [] : [entry];
    });

  const save = async () => {
    if (!ready) return;
    setPending(true);
    setError(null);

    try {
      const name = draft.text.name.trim();
      const description = draft.text.description.trim();

      if (owner && (name !== playlist.name || description !== (playlist.description ?? ""))) {
        await update({ playlistId: playlist.id, name, description });
      }

      await Promise.all(
        detail.items.flatMap((entry) =>
          draft.removed.has(entry.itemId)
            ? [remove({ playlistId: playlist.id, itemId: entry.itemId })]
            : [],
        ),
      );

      const current = detail.items
        .map((entry) => entry.itemId)
        .filter((itemId) => !draft.removed.has(itemId));

      // Each move places an entry after one an earlier move placed, so they run in order.
      await planMoves(
        current,
        shown.map((entry) => entry.itemId),
      ).reduce<Promise<unknown>>(
        (previous, step) =>
          previous.then(() =>
            move(
              step.afterItemId === null
                ? { playlistId: playlist.id, itemId: step.itemId }
                : { playlistId: playlist.id, itemId: step.itemId, afterItemId: step.afterItemId },
            ),
          ),
        Promise.resolve(),
      );

      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      router.back();
    } catch (cause) {
      setError(cause instanceof Error ? errorMessage(cause) : "Something went wrong. Try again.");
      setPending(false);
    }
  };

  return (
    <Animated.ScrollView
      ref={scrollRef}
      stickyHeaderIndices={STICKY_BAR}
      contentInsetAdjustmentBehavior="never"
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="interactive"
      automaticallyAdjustKeyboardInsets
      onContentSizeChange={(_, height) => {
        content.set(height);
        maxScroll.set(Math.max(0, height - viewport.get()));
      }}
      onLayout={(event) => {
        viewport.set(event.nativeEvent.layout.height);
        maxScroll.set(Math.max(0, content.get() - event.nativeEvent.layout.height));
      }}
      className="flex-1 bg-canvas"
      contentContainerClassName="pb-row"
    >
      <NavBar
        title={`Edit ${playlist.name}`}
        trailing={
          <IconButton
            icon={Check}
            label="Save"
            disabled={!ready}
            className={ready ? "" : "opacity-disabled"}
            onPress={() => void save()}
          />
        }
      />
      <View className="px-mobile-edge">
        {owner ? (
          <PlaylistFields
            value={draft.text}
            onChange={(text) => setDraft({ ...draft, text })}
            descriptionLabel="Description"
            onSubmit={() => void save()}
            error={error}
          />
        ) : null}
        <SectionHeader
          title="Songs"
          action={{ kind: "link", label: "Add", onPress: () => openAddSongs(playlist) }}
        />
        {!owner && error !== null ? (
          <Text variant="calloutMedium" tone="danger" className="pb-2">
            {error}
          </Text>
        ) : null}
        {shown.length === 0 ? (
          <Text tone="muted" className="py-4">
            No songs. Add some, or save to leave it empty.
          </Text>
        ) : (
          <ReorderList<PlaylistEntry>
            items={shown}
            keyOf={(entry) => entry.itemId}
            labelOf={(entry) => entry.track?.title ?? "Unavailable song"}
            scrollRef={scrollRef}
            scroll={scroll}
            maxScroll={maxScroll}
            onMove={(from, to) =>
              setDraft({ ...draft, order: moveIndex(shown, from, to).map((entry) => entry.itemId) })
            }
            onRemove={(entry) =>
              setDraft({ ...draft, removed: new Set([...draft.removed, entry.itemId]) })
            }
            renderItem={(entry, grip) => (
              <Row
                title={entry.track?.title ?? "Unavailable song"}
                subtitle={entry.track?.artist ?? ""}
                leading={{ kind: "art", url: entry.track?.artUrl ?? null }}
                trailing={grip}
              />
            )}
          />
        )}
      </View>
    </Animated.ScrollView>
  );
}

export default function EditPlaylist() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const state = usePlaylist(PlaylistId.make(id));

  if (state.kind === "loading") {
    return (
      <Page title="Edit playlist" bottom="plain">
        {null}
      </Page>
    );
  }

  if (state.kind !== "ready") return <ContentUnavailable kind="playlist" state={state} />;

  // A viewer reaching this page by a link can't change anything here.
  if (!canEditPlaylistItems(state.detail.playlist.access)) {
    return <ContentUnavailable kind="playlist" state={{ kind: "unavailable" }} />;
  }

  return <Editor detail={state.detail} />;
}
