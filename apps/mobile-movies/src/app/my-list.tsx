import { useAllPages } from "@media/mobile-core/pages";
import { usePlatform } from "@media/sdk/react";
import { router } from "expo-router";
import { Bookmark } from "lucide-react-native";
import { useState } from "react";
import { ActivityIndicator, View } from "react-native";

import { KindChips } from "@/components/browse/chip";
import { EmptyState } from "@/components/browse/empty-state";
import { PagingFooter, PosterGrid } from "@/components/browse/poster-grid";
import { UndoBar } from "@/components/browse/undo-bar";
import { Button } from "@/components/ui/button";
import { CalmState } from "@/components/ui/calm-state";
import { NavHeader } from "@/components/ui/nav-header";
import { Screen } from "@/components/ui/screen";
import { Text } from "@/components/ui/text";
import { ofKind, plural } from "@/lib/browse";
import type { KindFilter } from "@/lib/browse";

export default function MyList() {
  const platform = usePlatform();
  const list = useAllPages(platform.movies.myList.list, (paginationOpts) => ({ paginationOpts }));
  const [kind, setKind] = useState<KindFilter>("all");

  if (list.status === "loading") {
    return (
      <Screen edges={["top"]} header={<NavHeader title="My List" />}>
        <ActivityIndicator className="py-10" colorClassName="accent-text-muted" />
      </Screen>
    );
  }

  if (list.status === "failed") {
    return (
      <Screen header={<NavHeader title="My List" />}>
        <CalmState
          title="Couldn't Load My List"
          description={list.message}
          actions={<Button label="Try Again" onPress={list.retry} />}
        />
      </Screen>
    );
  }

  const shown = ofKind(list.rows, kind);
  const empty = list.rows.length === 0 && list.next.kind === "done";

  return (
    <>
      <Screen edges={["top"]} header={<NavHeader title="My List" />}>
        <PosterGrid
          titles={shown}
          footer={<PagingFooter pages={list} />}
          header={
            empty ? undefined : (
              <View className="gap-4 px-5 pb-1 regular:px-8 wide:px-12">
                <KindChips kind={kind} onChange={setKind} />
                <Text variant="secondary" tone="muted">
                  {plural(shown.length, "Title", "Titles")}
                </Text>
              </View>
            )
          }
          empty={
            empty ? (
              <EmptyState
                icon={Bookmark}
                title="Your List Is Empty"
                action={<Button label="Browse Library" onPress={() => router.navigate("/")} />}
              />
            ) : undefined
          }
        />
      </Screen>
      <UndoBar />
    </>
  );
}
