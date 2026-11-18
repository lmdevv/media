import { usePages } from "@media/mobile-core/pages";
import { usePlatform } from "@media/sdk/react";
import { router } from "expo-router";
import { Ellipsis, History as HistoryIcon, Play } from "lucide-react-native";
import { useMemo, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, View } from "react-native";

import { loadMoreOf, PagingFooter } from "@/components/browse/poster-grid";
import { Button } from "@/components/ui/button";
import { CalmState } from "@/components/ui/calm-state";
import { Icon } from "@/components/ui/icon";
import { Image } from "@/components/ui/image";
import { NavHeader } from "@/components/ui/nav-header";
import { READABLE_COLUMN, Screen } from "@/components/ui/screen";
import { Text } from "@/components/ui/text";
import { artworkUrl } from "@/lib/artwork";
import type { HistoryEntry } from "@/lib/catalog";
import { progressLabel } from "@/lib/format";
import { historyDetail, historyKey, historyName, historySections } from "@/lib/history";
import { watchHref } from "@/lib/routes";
import { useServer } from "@/session/connection";

type Item =
  | { readonly kind: "heading"; readonly key: string; readonly title: string }
  | { readonly kind: "entry"; readonly key: string; readonly entry: HistoryEntry };

function EntryRow({ entry }: { readonly entry: HistoryEntry }) {
  const { mediaUrl } = useServer();
  const name = historyName(entry);
  const detail = historyDetail(entry);
  const still = entry.episode?.still ?? entry.title.artwork.backdrop ?? entry.title.artwork.poster;
  const uri = artworkUrl(mediaUrl, still, "card");

  const play = () =>
    router.push(
      watchHref({
        titleId: entry.title.id,
        episodeId: entry.episode?.id,
        start: entry.progress.watched ? "beginning" : undefined,
      }),
    );

  const more = () => {
    const params = {
      titleId: entry.title.id,
      name,
      left: progressLabel(entry.progress) ?? "",
      watched: entry.progress.watched ? "1" : "0",
    };

    router.push({
      pathname: "/history-entry",
      params: entry.episode === null ? params : { ...params, episodeId: entry.episode.id },
    });
  };

  return (
    <View className="flex-row items-center gap-3">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${entry.progress.watched ? "Play" : "Resume"} ${name}, ${detail}`}
        onPress={play}
        className="flex-1 flex-row items-center gap-3 active:opacity-80"
      >
        <View className="h-19 w-32 overflow-hidden rounded-control bg-surface-raised">
          {uri === undefined ? null : (
            <Image source={{ uri }} contentFit="cover" transition={150} className="size-full" />
          )}
          <View className="absolute bottom-2 left-2">
            <Icon icon={Play} tone="onMedia" size="inline" filled />
          </View>
        </View>
        <View className="flex-1 gap-1">
          <Text variant="labelStrong" numberOfLines={2}>
            {name}
          </Text>
          {detail === "" ? null : (
            <Text variant="meta" tone="muted" numberOfLines={1}>
              {detail}
            </Text>
          )}
        </View>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`More for ${name}`}
        hitSlop={8}
        onPress={more}
        className="h-11 w-7 items-center justify-center active:opacity-60"
      >
        <Icon icon={Ellipsis} size="inline" />
      </Pressable>
    </View>
  );
}

export default function WatchHistory() {
  const platform = usePlatform();
  const history = usePages(platform.movies.history.list, (paginationOpts) => ({ paginationOpts }));
  const [now] = useState(Date.now);

  const items = useMemo((): ReadonlyArray<Item> => {
    if (history.status !== "ready") return [];

    const rows: Array<Item> = [];

    for (const section of historySections(history.rows, now)) {
      rows.push({ kind: "heading", key: `heading:${section.title}`, title: section.title });

      for (const entry of section.entries)
        rows.push({ kind: "entry", key: historyKey(entry), entry });
    }

    return rows;
  }, [history, now]);

  const header = <NavHeader title="Watch History" fallback="/you" />;

  if (history.status === "loading") {
    return (
      <Screen readable header={header}>
        <ActivityIndicator className="py-6" colorClassName="accent-text-muted" />
      </Screen>
    );
  }

  if (history.status === "failed") {
    return (
      <Screen readable header={header}>
        <CalmState
          title="Couldn’t Load Watch History"
          description={history.message}
          actions={<Button label="Try Again" onPress={history.retry} />}
        />
      </Screen>
    );
  }

  if (items.length === 0 && history.next.kind === "done") {
    return (
      <Screen readable header={header}>
        <CalmState
          placement="top"
          icon={HistoryIcon}
          title="Nothing watched yet"
          description="What you play shows up here."
        />
      </Screen>
    );
  }

  return (
    <Screen header={<View className={READABLE_COLUMN}>{header}</View>} edges={["top"]}>
      <FlatList
        data={items}
        keyExtractor={(item) => item.key}
        contentContainerClassName={`gap-4 px-5 pt-4 pb-10 ${READABLE_COLUMN}`}
        onEndReached={loadMoreOf(history)}
        onEndReachedThreshold={1}
        ListFooterComponent={<PagingFooter pages={history} />}
        renderItem={({ item }) =>
          item.kind === "heading" ? (
            <Text variant="heading" accessibilityRole="header">
              {item.title}
            </Text>
          ) : (
            <EntryRow entry={item.entry} />
          )
        }
      />
    </Screen>
  );
}
