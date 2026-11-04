import { PlaylistId } from "@music/commands/ids";
import { useRead, useRun } from "@music/sdk/react";
import { router, useLocalSearchParams } from "expo-router";

import { ConfirmSheet } from "@/components/ui/confirm-sheet";

export default function DeletePlaylist() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const playlistId = PlaylistId.make(id);
  const name = useRead("playlists.list", {})?.find((playlist) => playlist.id === playlistId)?.name;
  const remove = useRun("playlists.delete");

  return (
    <ConfirmSheet
      title={name === undefined ? "Delete playlist?" : `Delete ${name}?`}
      body="The playlist will be removed for everyone it’s shared with. Your music files and liked songs stay."
      confirmLabel="Delete playlist"
      pendingLabel="Deleting…"
      cancelLabel="Keep playlist"
      onConfirm={async () => {
        await remove({ playlistId });
        router.dismissTo("/(app)/(tabs)/(playlists)");
      }}
    />
  );
}
