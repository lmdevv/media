/**
 * A08 · Artist: their picture, how many of their albums the library holds, and Play for their top
 * songs; then the top songs, and their albums in a rail. A song plays the top songs from there.
 * An artist the viewer can no longer open is G10.
 */
import { ArtistId } from "@music/commands/ids";
import { useReadSettled } from "@music/sdk/react";
import { Option, Schema } from "effect";
import { useLocalSearchParams } from "expo-router";
import { Play } from "lucide-react-native";
import { View } from "react-native";

import { AlbumRail } from "@/components/browse/album-rail";
import { ListPage } from "@/components/browse/list-page";
import { usePlayList } from "@/components/browse/play";
import { TrackRow } from "@/components/browse/rows";
import { ContentUnavailable } from "@/components/states/content-unavailable";
import { Artwork } from "@/components/ui/artwork";
import { Button } from "@/components/ui/button";
import { SectionHeader } from "@/components/ui/section-header";
import { Text } from "@/components/ui/text";
import { detailStateOf } from "@/lib/detail-state";
import { countOf } from "@/lib/format";
import { useNowPlaying } from "@/player";

const decodeId = Schema.decodeUnknownOption(ArtistId);

function Artist({ artistId }: { readonly artistId: ArtistId }) {
  const state = detailStateOf(
    useReadSettled("artists.get", { artistId }),
    "Couldn’t load this artist.",
  );

  const playingId = useNowPlaying().nowPlaying?.trackId ?? null;
  const { playFrom, playAll } = usePlayList();

  if (state.kind === "unavailable" || state.kind === "failed") {
    return <ContentUnavailable kind="artist" state={state} />;
  }

  const detail = state.kind === "ready" ? state.detail : undefined;

  const tracks = detail?.topTracks ?? [];
  const trackIds = tracks.map((track) => track.id);

  return (
    <ListPage
      bar={{ title: detail?.artist.name ?? "" }}
      data={tracks}
      extraData={playingId}
      keyExtractor={(track) => track.id}
      header={
        detail === undefined ? null : (
          <View className="px-mobile-edge">
            <View className="flex-row items-center gap-4">
              <Artwork
                url={detail.artist.artUrl}
                recyclingKey={detail.artist.id}
                className="size-ios-104 rounded-full"
              />
              <View className="flex-1 gap-2">
                <Text variant="callout" tone="muted">
                  {`${countOf(detail.artist.albumCount, "album")} in your library`}
                </Text>
                <Button
                  label="Play"
                  icon={Play}
                  iconFilled
                  disabled={trackIds.length === 0}
                  onPress={() => playAll(trackIds, false)}
                />
              </View>
            </View>
            {tracks.length === 0 ? null : <SectionHeader title="Top songs" />}
          </View>
        )
      }
      footer={
        detail === undefined || detail.albums.length === 0 ? null : (
          <View className="px-mobile-edge">
            <AlbumRail title="Albums" albums={detail.albums} size="small" />
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

export default function ArtistScreen() {
  const artistId = Option.getOrNull(decodeId(useLocalSearchParams().id));

  return artistId === null ? (
    <ListPage bar={{ title: "Artist" }} data={[]} renderItem={() => null} />
  ) : (
    <Artist artistId={artistId} />
  );
}
