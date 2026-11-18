import { TrackId } from "@/lib/ids";
import type { Playlist } from "@/lib/models";
import { canEditPlaylistItems } from "@/lib/capabilities";
import { describeFailure } from "@media/mobile-core/failure";
import * as Haptics from "expo-haptics";
import { router, useLocalSearchParams } from "expo-router";
import { Check, Plus } from "lucide-react-native";
import { useState } from "react";

import { useCloseAfter } from "@/components/playlists/use-close-after";
import { useMyPlaylists, useSharedPlaylists } from "@/components/playlists/use-playlists";
import { Icon } from "@/components/ui/icon";
import { Row, RowChevron } from "@/components/ui/row";
import { SheetLayout } from "@/components/ui/sheet-layout";
import { Text } from "@/components/ui/text";
import { useMusic, useRead } from "@/lib/platform";
import { addTargetLine } from "@/lib/playlist-format";

/** Where a tap is: adding to one playlist, or added to it and about to close. */
type Progress =
  | { readonly kind: "idle" }
  | { readonly kind: "adding"; readonly playlistId: string }
  | { readonly kind: "added"; readonly playlistId: string };

const ADDED_MS = 500;

export default function AddToPlaylist() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const trackId = TrackId.make(id);
  const music = useMusic();
  const song = useRead(music.tracks.get, { trackId });
  const own = useMyPlaylists();
  const shared = useSharedPlaylists();
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
      await music.playlists.addTracks({ playlistId: playlist.id, trackIds: [trackId] });
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setProgress({ kind: "added", playlistId: playlist.id });
      closeSoon();
    } catch (cause) {
      setFailure(cause instanceof Error ? describeFailure(cause) : "Couldn’t add the song.");
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
