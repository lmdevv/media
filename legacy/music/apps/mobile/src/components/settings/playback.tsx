/**
 * F03 · Playback and appearance (H10 in dark): the theme on this iPhone, the streaming quality
 * this iPhone asks for, and autoplay, which the server keeps per account.
 */
import type { StreamQuality } from "@music/player/stream-quality";
import { router } from "expo-router";
import { Check, Info, Music } from "lucide-react-native";
import { useState } from "react";
import { View } from "react-native";

import { ChipGroup } from "@/components/ui/chip";
import { IconButton } from "@/components/ui/icon-button";
import { Notice } from "@/components/ui/notice";
import { Page } from "@/components/ui/page";
import { Row, RowCheck } from "@/components/ui/row";
import { SectionHeader } from "@/components/ui/section-header";
import { Switch } from "@/components/ui/switch";
import { Text } from "@/components/ui/text";
import { loadAppearance, saveAppearance } from "@/lib/appearance";
import type { Appearance } from "@/lib/appearance";
import { DEVICE_FAMILY } from "@/lib/this-device";
import { usePlayer, usePlayerActions } from "@/player";

const APPEARANCES = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "System" },
] as const satisfies ReadonlyArray<{ readonly value: Appearance; readonly label: string }>;

const APPEARANCE_NOTES = {
  light: "Always light. Now Playing uses the album’s colors.",
  dark: "Always dark. Now Playing uses the album’s colors.",
  system: `Follows this ${DEVICE_FAMILY}. Now Playing uses the album’s colors.`,
} as const satisfies Record<Appearance, string>;

/**
 * What each setting streams on iPhone. High is AAC at 320 kbps here: the phone plays progressive
 * AAC, not the web's gapless 256 kbps fragments.
 */
const QUALITIES = [
  { value: "lossless", title: "Lossless", detail: "FLAC for lossless files" },
  { value: "high", title: "High", detail: "AAC · 320 kbps" },
  { value: "data-saver", title: "Data saver", detail: "AAC · 128 kbps" },
] as const satisfies ReadonlyArray<{
  readonly value: StreamQuality;
  readonly title: string;
  readonly detail: string;
}>;

/** Theme, quality, and autoplay. Each choice applies as it is made; the check just goes back. */
export function PlaybackSettings() {
  const { quality, autoplay } = usePlayer();
  const { setQuality, setAutoplay } = usePlayerActions();
  const [appearance, setAppearance] = useState<Appearance>(loadAppearance);

  return (
    <Page
      title="Playback"
      bottom="plain"
      trailing={<IconButton icon={Check} label="Done" onPress={() => router.back()} />}
    >
      <SectionHeader title="Appearance" />
      <ChipGroup
        label="Appearance"
        options={APPEARANCES}
        value={appearance}
        onChange={(next) => {
          setAppearance(next);
          saveAppearance(next);
        }}
      />
      <Text variant="secondary" tone="muted">
        {APPEARANCE_NOTES[appearance]}
      </Text>
      <SectionHeader title="Streaming quality" />
      <View accessibilityRole="radiogroup" accessibilityLabel="Streaming quality">
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
        title="Applies from the next song"
        body="Quality is remembered per device. Gapless is used when the playback engine supports it."
      />
      <View className="min-h-ios-72 flex-row items-center gap-4 border-b border-border py-3">
        <View className="flex-1 gap-1">
          <Text variant="bodyMedium">Autoplay</Text>
          <Text variant="secondary" tone="muted">
            Keep listening from your own library.
          </Text>
        </View>
        <Switch label="Autoplay" value={autoplay} onValueChange={(on) => void setAutoplay(on)} />
      </View>
    </Page>
  );
}
