import { router } from "expo-router";
import { Ellipsis, Play } from "lucide-react-native";
import { Pressable, View } from "react-native";

import { Icon } from "@/components/ui/icon";
import { Image } from "@/components/ui/image";
import { ProgressBar } from "@/components/ui/progress-bar";
import { Text } from "@/components/ui/text";
import { artworkUrl } from "@/lib/artwork";
import { headingOf, lineOf, pictureOf, transferFraction } from "@/lib/downloads/model";
import type { DownloadRecord } from "@/lib/downloads/model";
import { downloadHref, playDownloadHref } from "@/lib/routes";
import { useServer } from "@/session/connection";
import type { DownloadEngine } from "@/session/download-engine";

/** The picture of a download: the one kept with it, else the server's while it is reachable. */
export const useDownloadPicture = (
  engine: DownloadEngine,
  download: DownloadRecord,
): string | undefined => {
  const { mediaUrl } = useServer();

  return engine.artworkUri(download) ?? artworkUrl(mediaUrl, pictureOf(download), "card");
};

/** One download row. */
export function DownloadRow({
  engine,
  download,
}: {
  readonly engine: DownloadEngine;
  readonly download: DownloadRecord;
}) {
  const picture = useDownloadPicture(engine, download);
  const heading = headingOf(download);
  const line = lineOf(download);
  const ready = download.phase === "ready";
  const fraction = download.phase === "downloading" ? transferFraction(download) : null;

  return (
    <View className="gap-4">
      <View className="flex-row items-center gap-3">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={ready ? `Play ${heading}` : heading}
          onPress={() =>
            router.push(ready ? playDownloadHref(download) : downloadHref(download.id))
          }
          className="h-19 w-32 overflow-hidden rounded-control bg-surface-raised active:opacity-70"
        >
          {picture === undefined ? null : (
            <Image
              source={{ uri: picture }}
              contentFit="cover"
              transition={150}
              className="size-full"
            />
          )}
          <View className="absolute bottom-2 left-2">
            <Icon icon={Play} tone="onMedia" size="inline" filled />
          </View>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${heading}, ${line}`}
          onPress={() => router.push(downloadHref(download.id))}
          className="flex-1 gap-1 active:opacity-70"
        >
          <Text variant="labelStrong" numberOfLines={2}>
            {heading}
          </Text>
          <Text variant="meta" tone="muted" numberOfLines={1}>
            {line}
          </Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`More for ${heading}`}
          hitSlop={8}
          onPress={() => router.push(`${downloadHref(download.id)}/actions`)}
          className="h-11 w-7 items-center justify-center active:opacity-60"
        >
          <Icon icon={Ellipsis} size="row" />
        </Pressable>
      </View>
      {fraction === null ? null : <ProgressBar value={fraction} />}
    </View>
  );
}
