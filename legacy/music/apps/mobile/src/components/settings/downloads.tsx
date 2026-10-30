/**
 * D16 · Downloads settings: the quality new downloads use, the space downloads take on this iPhone,
 * and Remove all downloads (D17). Paper's "Download over cellular" switch is left out: the app
 * can't tell cellular from Wi-Fi yet.
 */
import { router } from "expo-router";
import { Check, Info, Music, Trash2 } from "lucide-react-native";
import { Pressable, View } from "react-native";

import { Icon } from "@/components/ui/icon";
import { IconButton } from "@/components/ui/icon-button";
import { Notice } from "@/components/ui/notice";
import { Page } from "@/components/ui/page";
import { Row, RowCheck } from "@/components/ui/row";
import { SectionHeader } from "@/components/ui/section-header";
import { Text } from "@/components/ui/text";
import { useDownloadSettings } from "@/downloads";
import type { DownloadQuality } from "@/downloads";
import { storageLine } from "@/lib/downloaded";
import { formatBytes } from "@/lib/format";
import { DEVICE_FAMILY } from "@/lib/this-device";

/** What each quality downloads, with Paper's rough size of a song. */
const QUALITIES = [
  { value: "lossless", title: "Lossless", detail: "Original file · ~35 MB a song" },
  { value: "high", title: "High", detail: "AAC · 320 kbps · ~10 MB a song" },
] as const satisfies ReadonlyArray<{
  readonly value: DownloadQuality;
  readonly title: string;
  readonly detail: string;
}>;

/** Quality, storage, and removing everything. A choice applies as it is made. */
export function DownloadSettings() {
  const { quality, setQuality, usage, downloads } = useDownloadSettings();
  // A download still waiting for its first song holds no songs, but Remove all still removes it.
  const empty = downloads === 0 && usage.tracks === 0;

  return (
    <Page
      title="Downloads"
      bottom="plain"
      trailing={<IconButton icon={Check} label="Done" onPress={() => router.back()} />}
    >
      <SectionHeader title="Download quality" />
      <View accessibilityRole="radiogroup" accessibilityLabel="Download quality">
        {QUALITIES.map((option) => (
          <Row
            key={option.value}
            leading={{ kind: "icon", icon: Music, tone: "muted" }}
            title={option.title}
            subtitle={option.detail}
            trailing={option.value === quality ? <RowCheck /> : null}
            accessibilityLabel={`${option.title}, ${option.detail}${
              option.value === quality ? ", selected" : ""
            }`}
            onPress={() => setQuality(option.value)}
          />
        ))}
      </View>
      <Notice
        icon={Info}
        title="Applies to new downloads"
        body="Songs already downloaded keep their quality."
      />
      <View className="gap-3 pt-mobile-edge pb-3">
        <Text variant="section" accessibilityRole="header">
          Storage
        </Text>
        <View className="flex-row items-baseline justify-between gap-3">
          <Text variant="bodyMedium">{storageLine(usage)}</Text>
          {usage.freeBytes === null ? null : (
            <Text variant="mono" tone="muted">
              {`${formatBytes(usage.freeBytes)} free`.toLocaleUpperCase()}
            </Text>
          )}
        </View>
        <Text variant="secondary" tone="muted">
          {`Stored on this ${DEVICE_FAMILY}, outside iCloud backups.`}
        </Text>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled: empty }}
        disabled={empty}
        onPress={() => router.push("/settings/downloads/remove-all")}
        className={`min-h-row-touch flex-row items-center gap-3 border-y border-border py-2 active:opacity-60 ${
          empty ? "opacity-disabled" : ""
        }`}
      >
        <View className="w-8 shrink-0 items-center">
          <Icon icon={Trash2} tone="danger" />
        </View>
        <Text variant="bodyMedium" tone="danger">
          Remove all downloads
        </Text>
      </Pressable>
    </Page>
  );
}
