import { usePages } from "@media/mobile-core/pages";
import { usePlatform } from "@media/sdk/react";
import { useLocalSearchParams } from "expo-router";
import { Tags } from "lucide-react-native";
import { useState } from "react";
import type { ReactElement } from "react";
import { ActivityIndicator, View } from "react-native";

import { KindChips } from "@/components/browse/chip";
import { EmptyState } from "@/components/browse/empty-state";
import { loadMoreOf, PagingFooter, PosterGrid } from "@/components/browse/poster-grid";
import { UndoBar } from "@/components/browse/undo-bar";
import { Button } from "@/components/ui/button";
import { CalmState } from "@/components/ui/calm-state";
import { NavHeader } from "@/components/ui/nav-header";
import { Screen } from "@/components/ui/screen";
import { DEFAULT_FILTERS, listArgs } from "@/lib/browse";
import type { KindFilter } from "@/lib/browse";

const kindParam = (raw: string | undefined): KindFilter =>
  raw === "movie" || raw === "show" ? raw : "all";

export default function GenrePage() {
  const params = useLocalSearchParams<{ genre: string; kind?: string }>();
  const genre = params.genre.trim();

  const [kind, setKind] = useState<KindFilter>(kindParam(params.kind));

  return (
    <>
      <Screen edges={["top"]} header={<NavHeader title={genre} />}>
        <GenreGrid
          key={`${genre}:${kind}`}
          genre={genre}
          kind={kind}
          chips={
            <View className="px-5 pt-4 pb-1 regular:px-8 wide:px-12">
              <KindChips kind={kind} onChange={setKind} />
            </View>
          }
        />
      </Screen>
      <UndoBar />
    </>
  );
}

function GenreGrid({
  genre,
  kind,
  chips,
}: {
  readonly genre: string;
  readonly kind: KindFilter;
  readonly chips: ReactElement;
}) {
  const platform = usePlatform();

  const pages = usePages(platform.movies.titles.list, (paginationOpts) =>
    listArgs(kind === "all" ? null : kind, { ...DEFAULT_FILTERS, genre }, paginationOpts),
  );

  return (
    <PosterGrid
      titles={pages.status === "ready" ? pages.rows : []}
      header={chips}
      onEndReached={loadMoreOf(pages)}
      footer={<PagingFooter pages={pages} />}
      empty={
        pages.status === "failed" ? (
          <View className="h-80">
            <CalmState
              title={`Couldn't Load ${genre}`}
              description={pages.message}
              actions={<Button label="Try Again" onPress={pages.retry} />}
            />
          </View>
        ) : pages.status === "ready" && pages.next.kind === "done" ? (
          <EmptyState icon={Tags} title={`No ${genre} Titles`} />
        ) : (
          <ActivityIndicator className="py-10" colorClassName="accent-text-muted" />
        )
      }
    />
  );
}
