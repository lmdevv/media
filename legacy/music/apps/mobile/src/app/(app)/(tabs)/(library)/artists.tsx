/**
 * A04 · Artists: every artist in the library by name, with how many of their albums it holds. A
 * row opens the artist (A08). Pages load as the list nears its end.
 */
import { useRead } from "@music/sdk/react";
import { Users } from "lucide-react-native";
import { View } from "react-native";

import { ListPage } from "@/components/browse/list-page";
import { ArtistRow } from "@/components/browse/rows";
import { useArtistPages } from "@/components/browse/use-pages";
import { EmptyState } from "@/components/ui/empty-state";
import { Text } from "@/components/ui/text";
import { countOf } from "@/lib/format";

/** Artists per page. */
const PAGE_SIZE = 100;

export default function Artists() {
  const pages = useArtistPages({ limit: PAGE_SIZE, all: false });
  const home = useRead("library.home", {});
  const done = pages.status.kind === "done";

  return (
    <ListPage
      bar={{ title: "Artists" }}
      data={pages.items}
      keyExtractor={(artist) => artist.id}
      onEndReached={pages.loadMore}
      onEndReachedThreshold={1}
      header={
        <View className="px-mobile-edge pb-3">
          <Text variant="callout" tone="muted">
            {home === undefined
              ? " "
              : `${countOf(home.stats.artists, "artist")} in your collection`}
          </Text>
        </View>
      }
      footer={
        done && pages.items.length === 0 ? (
          <View className="px-mobile-edge">
            <EmptyState
              icon={Users}
              title={"No artists\nyet."}
              body={"Artists show up here once\na library has been scanned."}
            />
          </View>
        ) : null
      }
      renderItem={({ item }) => (
        <ArtistRow artist={item} subtitle={countOf(item.albumCount, "album")} />
      )}
    />
  );
}
