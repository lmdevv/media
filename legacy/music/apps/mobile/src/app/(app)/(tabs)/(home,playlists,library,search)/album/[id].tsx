/**
 * A07 · Album: the cover, title, artist (which opens the artist, A08), and a line of facts, then
 * Play and Shuffle over the songs. A song plays the album from there; its ellipsis opens Song
 * actions (A11). The playing song's title is the accent. The bar holds the download ring (D01)
 * and the ellipsis that opens Album actions (D03b). An album the viewer can no longer open, such
 * as one whose library was made private, is G10. While the server is out of reach the offline bar
 * leads (D13), and an album it hasn't sent opens from this phone's downloads.
 */
import { AlbumId } from "@music/commands/ids";
import { useReadSettled } from "@music/sdk/react";
import { Option, Schema } from "effect";
import { router, useLocalSearchParams } from "expo-router";
import { Ellipsis } from "lucide-react-native";
import { Pressable, View } from "react-native";

import { ListPage } from "@/components/browse/list-page";
import { usePlayList } from "@/components/browse/play";
import { PlayShuffle } from "@/components/browse/play-shuffle";
import { TrackRow, openArtist } from "@/components/browse/rows";
import { DownloadButton } from "@/components/downloads/download-button";
import { OfflineCollectionPage } from "@/components/downloads/offline-collection";
import { ContentUnavailable } from "@/components/states/content-unavailable";
import { OfflineNotice } from "@/components/states/offline-notice";
import { Artwork } from "@/components/ui/artwork";
import { IconButton } from "@/components/ui/icon-button";
import { Text } from "@/components/ui/text";
import { albumMeta } from "@/lib/album-meta";
import { detailStateOf } from "@/lib/detail-state";
import { offlineAlbum } from "@/lib/offline-library";
import { useNowPlaying } from "@/player";
import { useServerReach } from "@/session/server-reach";

const decodeId = Schema.decodeUnknownOption(AlbumId);

function Album({ albumId }: { readonly albumId: AlbumId }) {
  const state = detailStateOf(
    useReadSettled("albums.get", { albumId }),
    "Couldn’t load this album.",
  );

  const playingId = useNowPlaying().nowPlaying?.trackId ?? null;
  const { playFrom, playAll } = usePlayList();
  const reach = useServerReach();

  if (state.kind === "loading" && reach !== "online") {
    return (
      <OfflineCollectionPage kind="album" find={(library) => offlineAlbum(library, albumId)} />
    );
  }

  if (state.kind === "unavailable" || state.kind === "failed") {
    return <ContentUnavailable kind="album" state={state} />;
  }

  const detail = state.kind === "ready" ? state.detail : undefined;
  const tracks = detail?.tracks ?? [];
  const trackIds = tracks.map((track) => track.id);

  return (
    <ListPage
      bar={
        detail === undefined
          ? {}
          : {
              trailing: (
                <>
                  <DownloadButton
                    target={{ kind: "album", id: albumId }}
                    title={detail.album.title}
                  />
                  <IconButton
                    icon={Ellipsis}
                    label="Album actions"
                    onPress={() =>
                      router.push({ pathname: "/album/[id]/actions", params: { id: albumId } })
                    }
                  />
                </>
              ),
            }
      }
      data={tracks}
      extraData={playingId}
      keyExtractor={(track) => track.id}
      header={
        detail === undefined ? null : (
          <View className="px-mobile-edge">
            <OfflineNotice variant="bar" className="pb-4" />
            <View className="items-center gap-2 pb-4">
              <Artwork
                url={detail.album.artUrl}
                recyclingKey={detail.album.id}
                className="size-ios-192 rounded-lg"
              />
              <Text variant="title" className="text-center" accessibilityRole="header">
                {detail.album.title}
              </Text>
              <Pressable
                accessibilityRole="link"
                accessibilityLabel={`Artist, ${detail.album.artist}`}
                onPress={() => openArtist({ id: detail.album.artistId })}
                className="active:opacity-60"
              >
                <Text variant="bodyMedium" tone="accent" className="text-center">
                  {detail.album.artist}
                </Text>
              </Pressable>
              <Text variant="mono" tone="muted" className="text-center">
                {albumMeta(detail)}
              </Text>
            </View>
            <PlayShuffle
              className="pb-3"
              onPlay={() => playAll(trackIds, false)}
              onShuffle={() => playAll(trackIds, true)}
            />
          </View>
        )
      }
      renderItem={({ item, index }) => (
        <TrackRow
          song={item}
          artUrl={item.artUrl}
          active={item.id === playingId}
          onPress={() => playFrom(trackIds, index)}
        />
      )}
    />
  );
}

export default function AlbumScreen() {
  const albumId = Option.getOrNull(decodeId(useLocalSearchParams().id));

  return albumId === null ? (
    <ListPage bar={{ title: "Album" }} data={[]} renderItem={() => null} />
  ) : (
    <Album albumId={albumId} />
  );
}
