/**
 * An album or playlist the server can't load while it is out of reach (a launch that never reached
 * it has nothing cached), drawn from this phone's downloads: the offline bar, its cover, title, and
 * artist or owner, then Play and Shuffle over the songs this phone holds; an iPad lays them out in
 * its horizontal header (P05). One this phone doesn't hold is G10's failure, saying why.
 */
import type { OfflineLibrary } from "@music/sdk/downloads";
import { View } from "react-native";

import { DetailHeader } from "@/components/browse/detail-header";
import { ListPage } from "@/components/browse/list-page";
import { usePlayList } from "@/components/browse/play";
import { PlayShuffle } from "@/components/browse/play-shuffle";
import { ContentUnavailable } from "@/components/states/content-unavailable";
import { OfflineNotice } from "@/components/states/offline-notice";
import { Artwork } from "@/components/ui/artwork";
import { Text } from "@/components/ui/text";
import { useDownloadsLibrary } from "@/downloads";
import type { Unavailable } from "@/lib/detail-state";
import type { OfflineCollection } from "@/lib/offline-library";
import { DEVICE_FAMILY } from "@/lib/this-device";
import { useWindowLayout } from "@/lib/window-layout";
import { useNowPlaying } from "@/player";

import { LocalSongRow } from "./local-song-row";

const NOT_HERE: Unavailable = {
  kind: "failed",
  message: `It isn’t on this ${DEVICE_FAMILY}, and the server is out of reach.`,
};

/** Props for `OfflineCollectionPage`. */
export interface OfflineCollectionPageProps {
  readonly kind: "album" | "playlist";
  /** Picks the album or playlist out of what this phone holds. */
  readonly find: (library: OfflineLibrary) => OfflineCollection | null;
}

/** The page of a downloaded album or playlist, with no server. */
export function OfflineCollectionPage({ kind, find }: OfflineCollectionPageProps) {
  const collection = find(useDownloadsLibrary());
  const playingId = useNowPlaying().nowPlaying?.trackId ?? null;
  const { playFrom, playAll } = usePlayList();
  const { tablet } = useWindowLayout();

  if (collection === null) return <ContentUnavailable kind={kind} state={NOT_HERE} />;

  const trackIds = collection.tracks.map((copy) => copy.track.id);

  return (
    <ListPage
      bar={{}}
      data={collection.tracks}
      extraData={playingId}
      keyExtractor={(copy) => copy.track.id}
      header={
        <View className="px-page">
          <OfflineNotice variant="bar" className="pb-4" />
          {tablet ? (
            <DetailHeader
              art={{ url: collection.artUri }}
              title={collection.title}
              actions={
                <PlayShuffle
                  width="natural"
                  onPlay={() => playAll(trackIds, false)}
                  onShuffle={() => playAll(trackIds, true)}
                />
              }
            >
              <Text variant="subtitle" tone="muted">
                {collection.subtitle}
              </Text>
            </DetailHeader>
          ) : (
            <>
              <View className="items-center gap-2 pb-4">
                <Artwork url={collection.artUri} className="size-ios-192 rounded-lg" />
                <Text variant="title" className="text-center" accessibilityRole="header">
                  {collection.title}
                </Text>
                <Text variant="bodyMedium" tone="muted" className="text-center">
                  {collection.subtitle}
                </Text>
              </View>
              <PlayShuffle
                className="pb-3"
                onPlay={() => playAll(trackIds, false)}
                onShuffle={() => playAll(trackIds, true)}
              />
            </>
          )}
        </View>
      }
      renderItem={({ item, index }) => (
        <LocalSongRow
          copy={item}
          active={item.track.id === playingId}
          onPress={() => playFrom(trackIds, index)}
        />
      )}
    />
  );
}
