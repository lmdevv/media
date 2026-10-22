/**
 * C06 · Add to playlist, from a song's actions (A11): New playlist starts one with this song;
 * tapping one of your playlists, or one you collaborate on, adds the song and closes the sheet.
 */
import { TrackId } from "@music/commands/ids";
import type { Playlist } from "@music/commands/models";
import { canEditPlaylistItems } from "@music/commands/permissions";
import { errorMessage } from "@music/sdk/errors";
import { useRead, useRun } from "@music/sdk/react";
import * as Haptics from "expo-haptics";
import { router, useLocalSearchParams } from "expo-router";
import { Check, Plus } from "lucide-react-native";
import { useState } from "react";

import { useCloseAfter } from "@/components/playlists/use-close-after";
import { Icon } from "@/components/ui/icon";
import { Row, RowChevron } from "@/components/ui/row";
import { SheetLayout } from "@/components/ui/sheet-layout";
import { Text } from "@/components/ui/text";
import { addTargetLine } from "@/lib/playlist-format";

/** Where a tap is: adding to one playlist, or added to it and about to close. */
type Progress =
  | { readonly kind: "idle" }
  | { readonly kind: "adding"; readonly playlistId: string }
  | { readonly kind: "added"; readonly playlistId: string };

/** How long the added check shows before the sheet closes. */
const ADDED_MS = 500;

export default function AddToPlaylist() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const trackId = TrackId.make(id);
  const song = useRead("links.get", { kind: "track", id: trackId });
  const own = useRead("playlists.list", {});
  const shared = useRead("playlists.shared", {});
  const add = useRun("playlists.add");
  const [progress, setProgress] = useState<Progress>({ kind: "idle" });
  const [failure, setFailure] = useState<string | null>(null);
  const closeSoon = useCloseAfter(ADDED_MS);

  const targets: ReadonlyArray<Playlist> = [
    ...(own ?? []),
    ...(shared ?? []).filter((playlist) => canEditPlaylistItems(playlist.access)),
  ];

  const addTo = async (playlist: Playlist) => {
    if (progress.kind !== "idle") return;
    setProgress({ kind: "adding", playlistId: playlist.id });
    setFailure(null);

    try {
      await add({ playlistId: playlist.id, trackIds: [trackId] });
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setProgress({ kind: "added", playlistId: playlist.id });
      closeSoon();
    } catch (cause) {
      setFailure(cause instanceof Error ? errorMessage(cause) : "Couldn’t add the song.");
      setProgress({ kind: "idle" });
    }
  };

  return (
    <SheetLayout title="Add to playlist" subtitle={song?.title ?? " "}>
      <Row
        title="New playlist"
        leading={{ kind: "icon", icon: Plus, tone: "muted" }}
        trailing={<RowChevron />}
        onPress={() => {
          router.back();
          router.push({ pathname: "/playlist/new", params: { trackId } });
        }}
      />
      {targets.map((playlist) => {
        const here = progress.kind !== "idle" && progress.playlistId === playlist.id;

        return (
          <Row
            key={playlist.id}
            title={playlist.name}
            subtitle={
              here && progress.kind === "added"
                ? `Added to ${playlist.name}`
                : addTargetLine(playlist)
            }
            leading={{ kind: "art", url: playlist.artUrls[0] ?? null, recyclingKey: playlist.id }}
            trailing={
              <Icon
                icon={here && progress.kind === "added" ? Check : Plus}
                tone={here && progress.kind === "added" ? "accent" : "muted"}
                size="inline"
              />
            }
            accessibilityLabel={`Add to ${playlist.name}, ${addTargetLine(playlist)}`}
            onPress={() => void addTo(playlist)}
          />
        );
      })}
      {failure === null ? null : (
        <Text variant="calloutMedium" tone="danger" className="pt-3">
          {failure}
        </Text>
      )}
    </SheetLayout>
  );
}
