/**
 * C02, C05, C11, H08 · Playlist. Its owner sees the hero, who can open it, Share, Add, and Play
 * and Shuffle (C02), or "Make it yours." while it is empty (C05). A collaborator sees whose it is
 * and may add songs (C11); a viewer may only play. On an iPad the header lays out horizontally
 * (P05) and carries the name, so the bar doesn't repeat it. The song list's bar holds the
 * download ring beside the ellipsis (D06). A playlist the viewer can't open is G10. While the
 * server is out of reach the offline bar leads (D13), and a playlist it hasn't sent opens from
 * this phone's downloads.
 */
import { PlaylistId } from "@music/commands/ids";
import type { PlaylistDetail, PlaylistEntry } from "@music/commands/models";
import { can, canEditPlaylistItems } from "@music/commands/permissions";
import { useRead } from "@music/sdk/react";
import { router, useLocalSearchParams } from "expo-router";
import { Ellipsis, ListMusic, Plus } from "lucide-react-native";

import { DownloadButton } from "@/components/downloads/download-button";
import { OfflineCollectionPage } from "@/components/downloads/offline-collection";
import { OwnerHeader, SharedHeader, openAddSongs } from "@/components/playlists/playlist-header";
import { SongListPage } from "@/components/playlists/song-list-page";
import type { SongEntry } from "@/components/playlists/song-list-page";
import { ContentUnavailable } from "@/components/states/content-unavailable";
import { OfflineNotice } from "@/components/states/offline-notice";
import { usePlaylist } from "@/components/playlists/use-playlist";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { IconButton } from "@/components/ui/icon-button";
import { Page } from "@/components/ui/page";
import { offlinePlaylist } from "@/lib/offline-library";
import { useWindowLayout } from "@/lib/window-layout";
import { usePlayerActions } from "@/player";
import { useServerReach } from "@/session/server-reach";

const REASONS = {
  missing: "File missing",
  no_access: "In a library you can’t open",
} as const;

/** A playlist entry as a song row; one that can't play keeps its place and says why. */
const songOf = (entry: PlaylistEntry): SongEntry => ({
  key: entry.itemId,
  song: entry.track,
  title: entry.track?.title ?? "Unavailable song",
  subtitle:
    entry.available || entry.reason === null ? (entry.track?.artist ?? "") : REASONS[entry.reason],
  artUrl: entry.track?.artUrl ?? null,
  playable: entry.available && entry.track !== null,
});

/** The ellipsis that opens the playlist's actions (C08). */
function ActionsButton({ id }: { readonly id: PlaylistId }) {
  return (
    <IconButton
      icon={Ellipsis}
      label="Playlist actions"
      onPress={() => router.push({ pathname: "/playlist/[id]/actions", params: { id } })}
    />
  );
}

/** C05: an empty playlist's invitation to add songs, for people who may add them. */
function Empty({
  detail,
  canEdit,
}: {
  readonly detail: PlaylistDetail;
  readonly canEdit: boolean;
}) {
  return (
    <EmptyState
      icon={ListMusic}
      title="Make it yours."
      body={
        canEdit
          ? "Add a few songs to start\nyour next favorite playlist."
          : "No songs here yet.\nCheck back soon."
      }
      primary={
        canEdit ? (
          <Button label="Add songs" icon={Plus} onPress={() => openAddSongs(detail.playlist)} />
        ) : undefined
      }
    />
  );
}

function Loaded({
  detail,
  canShare,
}: {
  readonly detail: PlaylistDetail;
  readonly canShare: boolean;
}) {
  const { play } = usePlayerActions();
  const { tablet } = useWindowLayout();
  const { playlist } = detail;
  const owner = playlist.access === "owner";
  const canEdit = canEditPlaylistItems(playlist.access);
  const songs = detail.items.map(songOf);

  const trackIds = songs.flatMap((song) =>
    song.playable && song.song !== null ? [song.song.id] : [],
  );

  const actions = <ActionsButton id={playlist.id} />;

  if (owner && detail.items.length === 0) {
    return (
      <Page title={playlist.name} trailing={actions}>
        <Empty detail={detail} canEdit />
      </Page>
    );
  }

  const trailing = (
    <>
      <DownloadButton target={{ kind: "playlist", id: playlist.id }} title={playlist.name} />
      {actions}
    </>
  );

  return (
    <SongListPage
      bar={owner || tablet ? { trailing } : { title: playlist.name, trailing }}
      songs={songs}
      onPlay={(index) => void play(trackIds, index)}
      header={
        owner ? (
          <>
            <OfflineNotice variant="bar" className="pb-4" />
            <OwnerHeader
              playlist={playlist}
              canShare={canShare}
              trackIds={trackIds}
              tablet={tablet}
            />
          </>
        ) : (
          <>
            <OfflineNotice variant="bar" className="pb-4" />
            <SharedHeader playlist={playlist} trackIds={trackIds} tablet={tablet} />
            {detail.items.length === 0 ? <Empty detail={detail} canEdit={canEdit} /> : null}
          </>
        )
      }
    />
  );
}

export default function PlaylistScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const playlistId = PlaylistId.make(id);
  const state = usePlaylist(playlistId);
  const me = useRead("account.me", {});
  const reach = useServerReach();

  if (state.kind === "loading" && reach !== "online") {
    return (
      <OfflineCollectionPage
        kind="playlist"
        find={(library) => offlinePlaylist(library, playlistId)}
      />
    );
  }

  if (state.kind === "loading") return <Page>{null}</Page>;

  if (state.kind !== "ready") return <ContentUnavailable kind="playlist" state={state} />;

  return <Loaded detail={state.detail} canShare={me !== undefined && can(me.role, "share")} />;
}
