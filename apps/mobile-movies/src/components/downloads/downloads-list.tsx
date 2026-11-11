import { router, Stack } from "expo-router";
import { Download, Ellipsis, Settings2 } from "lucide-react-native";
import type { ReactNode } from "react";
import { ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { EmptyState } from "@/components/browse/empty-state";
import { CompactBar, LargeTitle, useCollapse } from "@/components/browse/tab-chrome";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { ListRow } from "@/components/ui/list-row";
import { downloadsOf, summaryOf } from "@/lib/downloads/model";
import type { DownloadEngine } from "@/session/download-engine";
import type { DownloadsSnapshot } from "@/session/download-engine";
import { useDownloads } from "@/session/downloads";

import { DownloadRow } from "./download-row";

/** Props for `DownloadsList`. */
export interface DownloadsListProps {
  /** The tab's native header, or the list's own title and bar (offline). */
  readonly chrome: "native" | "own";
  /** The empty state's way forward. */
  readonly empty: { readonly label: string; readonly onPress: () => void };
  /** Under Download Settings, such as Try Again offline. */
  readonly footer?: ReactNode;
}

const openSettings = () => router.push("/download-settings");

const openMenu = () => router.push("/download-settings/menu");

function DownloadsBody({
  engine,
  snapshot,
  empty,
  footer,
}: {
  readonly engine: DownloadEngine | null;
  readonly snapshot: DownloadsSnapshot | null;
  readonly empty: DownloadsListProps["empty"];
  readonly footer: ReactNode;
}) {
  const downloads = snapshot === null ? [] : downloadsOf(snapshot.store);
  const summary = summaryOf(downloads);

  if (engine === null || downloads.length === 0) {
    return (
      <EmptyState
        icon={Download}
        title="Nothing downloaded yet."
        action={<Button label={empty.label} onPress={empty.onPress} />}
      />
    );
  }

  return (
    <View className="gap-4 px-5 py-4 regular:w-full regular:max-w-readable regular:self-center regular:px-0">
      <ListRow icon={Download} title={summary.items} detail={summary.size} onPress={openSettings} />
      {downloads.map((download) => (
        <DownloadRow key={download.id} engine={engine} download={download} />
      ))}
      <View className="h-6" />
      <ListRow icon={Settings2} title="Download Settings" onPress={openSettings} />
      {footer}
    </View>
  );
}

/** The person's downloads. */
export function DownloadsList({ chrome, empty, footer }: DownloadsListProps) {
  const { engine, snapshot } = useDownloads();
  const collapse = useCollapse();
  const insets = useSafeAreaInsets();
  const any = snapshot !== null && snapshot.store.downloads.length > 0;
  const more = any ? <IconButton icon={Ellipsis} label="More" onPress={openMenu} /> : undefined;
  const body = <DownloadsBody engine={engine} snapshot={snapshot} empty={empty} footer={footer} />;

  if (chrome === "native") {
    return (
      <>
        <Stack.Screen options={{ headerRight: () => more ?? null }} />
        {/* The automatic insets already clear the native header, the tab bar, and the home indicator. */}
        <ScrollView contentInsetAdjustmentBehavior="automatic" className="flex-1 bg-bg">
          {body}
        </ScrollView>
      </>
    );
  }

  return (
    <View className="flex-1 bg-bg">
      <ScrollView
        onScroll={collapse.onScroll}
        scrollEventThrottle={16}
        contentInsetAdjustmentBehavior="never"
        contentContainerStyle={{ paddingBottom: insets.bottom + 16 }}
      >
        <LargeTitle title="Downloads" />
        {body}
      </ScrollView>
      <CompactBar title="Downloads" collapsed={collapse.collapsed} trailing={more} />
    </View>
  );
}
