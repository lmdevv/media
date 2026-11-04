import type { HistoryEntry } from "@media/contracts/models/catalog";
import type { Cursor as CursorSchema } from "@media/contracts/models/common";
import { useCommand, useCommandQuery } from "@media/sdk/react";
import { router, useFocusEffect } from "expo-router";
import { Ellipsis, History as HistoryIcon, Play } from "lucide-react-native";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, View } from "react-native";

import { Button } from "@/components/ui/button";
import { CalmState } from "@/components/ui/calm-state";
import { Icon } from "@/components/ui/icon";
import { Image } from "@/components/ui/image";
import { NavHeader } from "@/components/ui/nav-header";
import { READABLE_COLUMN, Screen } from "@/components/ui/screen";
import { Text } from "@/components/ui/text";
import { artworkUrl } from "@/lib/artwork";
import { describeFailure } from "@/lib/failure";
import { progressLabel } from "@/lib/format";
import { historyDetail, historyKey, historyName, historySections } from "@/lib/history";
import { watchHref } from "@/lib/routes";
import { useActiveProfile } from "@/session/active-profile";
import { useServer } from "@/session/connection";

type Cursor = typeof CursorSchema.Type;

const PAGE = 50;

type Item =
  | { readonly kind: "heading"; readonly key: string; readonly title: string }
  | { readonly kind: "entry"; readonly key: string; readonly entry: HistoryEntry };

const useOlderPages = (firstCursor: Cursor | null) => {
  const { profile } = useActiveProfile();
  const list = useCommand("history.list");

  const [pages, setPages] = useState<{
    readonly after: Cursor | null;
    readonly entries: ReadonlyArray<HistoryEntry>;
    readonly next: Cursor | null;
  }>({ after: null, entries: [], next: null });

  const loading = useRef(false);

  const current =
    pages.after === firstCursor ? pages : { after: firstCursor, entries: [], next: firstCursor };

  const loadMore = async () => {
    if (loading.current || current.next === null) return;
    loading.current = true;

    try {
      const page = await list({ profileId: profile.id, cursor: current.next, limit: PAGE });

      setPages({
        after: firstCursor,
        entries: [...current.entries, ...page.items],
        next: page.nextCursor,
      });
    } catch {
    } finally {
      loading.current = false;
    }
  };

  const readFrom = async (
    cursor: Cursor,
    wanted: number,
    read: ReadonlyArray<HistoryEntry>,
  ): Promise<{ readonly entries: ReadonlyArray<HistoryEntry>; readonly next: Cursor | null }> => {
    const page = await list({ profileId: profile.id, cursor, limit: PAGE });
    const entries = [...read, ...page.items];

    return entries.length >= wanted || page.nextCursor === null
      ? { entries, next: page.nextCursor }
      : readFrom(page.nextCursor, wanted, entries);
  };

  const reload = async () => {
    if (loading.current || current.entries.length === 0 || firstCursor === null) return;
    loading.current = true;

    try {
      const read = await readFrom(firstCursor, current.entries.length, []);

      setPages({ after: firstCursor, ...read });
    } catch {
    } finally {
      loading.current = false;
    }
  };

  return { entries: current.entries, more: current.next !== null, loadMore, reload };
};

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
  const { profile } = useActiveProfile();
  const first = useCommandQuery("history.list", { profileId: profile.id, limit: PAGE });
  const older = useOlderPages(first.status === "success" ? first.data.nextCursor : null);
  const reloadOlder = useRef(older.reload);

  useEffect(() => {
    reloadOlder.current = older.reload;
  });

  useFocusEffect(
    useCallback(() => {
      void reloadOlder.current();
    }, []),
  );
  const [now] = useState(Date.now);

  const items = useMemo((): ReadonlyArray<Item> => {
    if (first.status !== "success") return [];

    const rows: Array<Item> = [];

    for (const section of historySections([...first.data.items, ...older.entries], now)) {
      rows.push({ kind: "heading", key: `heading:${section.title}`, title: section.title });

      for (const entry of section.entries)
        rows.push({ kind: "entry", key: historyKey(entry), entry });
    }

    return rows;
  }, [first, older.entries, now]);

  const header = <NavHeader title="Watch History" fallback="/you" />;

  if (first.status === "loading") {
    return (
      <Screen readable header={header}>
        <ActivityIndicator className="py-6" colorClassName="accent-text-muted" />
      </Screen>
    );
  }

  if (first.status === "error") {
    return (
      <Screen readable header={header}>
        <CalmState
          title="Couldn’t Load Watch History"
          description={describeFailure(first.error)}
          actions={<Button label="Try Again" onPress={first.retry} />}
        />
      </Screen>
    );
  }

  if (items.length === 0) {
    return (
      <Screen readable header={header}>
        <CalmState
          placement="top"
          icon={HistoryIcon}
          title="Nothing watched yet"
          description="What this profile plays shows up here."
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
        onEndReached={() => void older.loadMore()}
        onEndReachedThreshold={1}
        ListFooterComponent={
          older.more ? (
            <ActivityIndicator className="py-4" colorClassName="accent-text-muted" />
          ) : undefined
        }
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
