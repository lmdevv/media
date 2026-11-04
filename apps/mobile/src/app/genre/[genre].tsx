import { TitleKind } from "@media/contracts/models/catalog";
import { useLocalSearchParams } from "expo-router";
import { Option, Schema } from "effect";
import { Tags } from "lucide-react-native";
import { useState } from "react";
import type { ReactElement } from "react";
import { ActivityIndicator, View } from "react-native";

import { KindChips } from "@/components/browse/chip";
import { EmptyState } from "@/components/browse/empty-state";
import { PagingFooter, PosterGrid } from "@/components/browse/poster-grid";
import { useTitlePages } from "@/components/browse/title-pages";
import { UndoBar } from "@/components/browse/undo-bar";
import { Button } from "@/components/ui/button";
import { CalmState } from "@/components/ui/calm-state";
import { NavHeader } from "@/components/ui/nav-header";
import { Screen } from "@/components/ui/screen";
import { DEFAULT_FILTERS } from "@/lib/browse";
import type { KindFilter } from "@/lib/browse";
import { describeFailure } from "@/lib/failure";
import { useActiveProfile } from "@/session/active-profile";

const decodeKind = Schema.decodeUnknownOption(TitleKind);

export default function GenrePage() {
  const params = useLocalSearchParams<{ genre: string; kind?: string }>();
  const genre = params.genre.trim();

  const [kind, setKind] = useState<KindFilter>(
    Option.getOrElse(decodeKind(params.kind), () => "all" as const),
  );

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
  const { profile } = useActiveProfile();

  const pages = useTitlePages(profile.id, kind === "all" ? null : kind, {
    ...DEFAULT_FILTERS,
    genre,
  });

  return (
    <>
      {pages.subscriptions}
      <PosterGrid
        titles={pages.titles}
        header={chips}
        onEndReached={pages.loadMore}
        footer={<PagingFooter pages={pages} />}
        empty={
          pages.failure !== null ? (
            <View className="h-80">
              <CalmState
                title={`Couldn't Load ${genre}`}
                description={describeFailure(pages.failure.cause)}
                actions={<Button label="Try Again" onPress={pages.retry} />}
              />
            </View>
          ) : pages.loaded ? (
            <EmptyState icon={Tags} title={`No ${genre} Titles`} />
          ) : (
            <ActivityIndicator className="py-10" colorClassName="accent-text-muted" />
          )
        }
      />
    </>
  );
}
