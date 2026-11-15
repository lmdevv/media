import { PlaylistId } from "@/lib/ids";
import { router, useLocalSearchParams } from "expo-router";

import { useSharedPlaylists } from "@/components/playlists/use-playlists";
import { ConfirmSheet } from "@/components/ui/confirm-sheet";
import { useMusic } from "@/lib/platform";
import { useMaybeMe } from "@/session/me";

export default function LeavePlaylist() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const playlistId = PlaylistId.make(id);
  const playlist = useSharedPlaylists()?.find((entry) => entry.id === playlistId);
  const me = useMaybeMe();
  const music = useMusic();
  const owner = playlist?.owner?.name ?? "The owner";

  return (
    <ConfirmSheet
      title={playlist === undefined ? "Leave playlist?" : `Leave ${playlist.name}?`}
      body={`It leaves your Shared with you list. ${owner} can share it with you again.`}
      confirmLabel="Leave playlist"
      pendingLabel="Leaving…"
      cancelLabel="Stay"
      onConfirm={async () => {
        if (me === null) throw new Error("Your account is still loading. Try again.");
        await music.playlists.unshare({ playlistId, userId: me.userId });
        router.dismissTo("/(app)/(tabs)/(playlists)");
      }}
    />
  );
}
