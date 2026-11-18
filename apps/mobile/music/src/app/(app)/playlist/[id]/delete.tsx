import { PlaylistId } from "@/lib/ids";
import { router, useLocalSearchParams } from "expo-router";

import { useMyPlaylists } from "@/components/playlists/use-playlists";
import { ConfirmSheet } from "@/components/ui/confirm-sheet";
import { useMusic } from "@/lib/platform";

export default function DeletePlaylist() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const playlistId = PlaylistId.make(id);
  const name = useMyPlaylists()?.find((playlist) => playlist.id === playlistId)?.name;
  const music = useMusic();

  return (
    <ConfirmSheet
      title={name === undefined ? "Delete playlist?" : `Delete ${name}?`}
      body="The playlist will be removed for everyone it’s shared with. Your music files and liked songs stay."
      confirmLabel="Delete playlist"
      pendingLabel="Deleting…"
      cancelLabel="Keep playlist"
      onConfirm={async () => {
        await music.playlists.remove({ playlistId });
        router.dismissTo("/(app)/(tabs)/(playlists)");
      }}
    />
  );
}
