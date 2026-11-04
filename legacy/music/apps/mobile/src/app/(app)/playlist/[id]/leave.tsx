import { PlaylistId } from "@music/commands/ids";
import { useRead, useRun } from "@music/sdk/react";
import { router, useLocalSearchParams } from "expo-router";

import { ConfirmSheet } from "@/components/ui/confirm-sheet";

export default function LeavePlaylist() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const playlistId = PlaylistId.make(id);
  const playlist = useRead("playlists.shared", {})?.find((entry) => entry.id === playlistId);
  const me = useRead("account.me", {});
  const unshare = useRun("playlists.unshare");
  const owner = playlist?.owner?.name ?? "The owner";

  return (
    <ConfirmSheet
      title={playlist === undefined ? "Leave playlist?" : `Leave ${playlist.name}?`}
      body={`It leaves your Shared with you list. ${owner} can share it with you again.`}
      confirmLabel="Leave playlist"
      pendingLabel="Leaving…"
      cancelLabel="Stay"
      onConfirm={async () => {
        if (me === undefined) throw new Error("Your account is still loading. Try again.");
        await unshare({ playlistId, userId: me.id });
        router.dismissTo("/(app)/(tabs)/(playlists)");
      }}
    />
  );
}
