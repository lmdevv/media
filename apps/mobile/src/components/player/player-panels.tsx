import type { NegotiateResponse } from "@media/contracts/media-playback";
import type { AudioStream, SeasonEpisode } from "@media/contracts/models/catalog";
import { Check, ChevronRight, Minus, Play, Plus, RotateCcw } from "lucide-react-native";
import type { ReactNode } from "react";
import { FlatList, Pressable, ScrollView, View } from "react-native";

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Image } from "@/components/ui/image";
import { Text } from "@/components/ui/text";
import { formatRuntime } from "@/lib/format";
import { formatClock } from "@/lib/player/clock";
import { QUALITY_OPTIONS } from "@/lib/player/quality";
import type { QualityChoice } from "@/lib/player/quality";
import type { ChapterRow } from "@/lib/player/scrubbing";
import { SUBTITLE_DELAY, formatSubtitleDelay } from "@/lib/player/subtitle-delay";
import { audioTrackLabels, subtitleTrackLabels } from "@/lib/player/tracks";

import { SidePanel } from "./side-panel";

function ChoiceRow({
  label,
  selected,
  onPress,
}: {
  readonly label: string;
  readonly selected: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected }}
      className="h-14 flex-row items-center gap-2 active:opacity-60"
    >
      <Text tone="onMedia" className="flex-1" numberOfLines={1}>
        {label}
      </Text>
      {selected ? <Icon icon={Check} tone="onMedia" size="inline" /> : null}
    </Pressable>
  );
}

function DetailRow({
  leading,
  label,
  detail,
  selected = false,
  onPress,
}: {
  readonly leading?: ReactNode;
  readonly label: string;
  readonly detail: string | null;
  readonly selected?: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={detail === null ? label : `${label}, ${detail}`}
      accessibilityState={{ selected }}
      className="min-h-14 flex-row items-center gap-3 active:opacity-60"
    >
      {leading}
      <Text tone="onMedia" className="flex-1" numberOfLines={1}>
        {label}
      </Text>
      {detail === null ? null : (
        <Text variant="secondary" tone="darkMuted">
          {detail}
        </Text>
      )}
      <View className="w-5 items-center">
        <Icon icon={ChevronRight} tone="darkMuted" size="chevron" />
      </View>
    </Pressable>
  );
}

function ColumnHeading({ children }: { readonly children: string }) {
  return (
    <Text variant="label" tone="darkMuted" accessibilityRole="header">
      {children}
    </Text>
  );
}

function SubtitleTiming({
  delayMs,
  onDelay,
}: {
  readonly delayMs: number;
  readonly onDelay: (delayMs: number) => void;
}) {
  return (
    <View className="h-14 flex-row items-center gap-2">
      <Text tone="onMedia" className="flex-1">
        Timing
      </Text>
      <Pressable
        onPress={() => onDelay(delayMs - SUBTITLE_DELAY.stepMs)}
        accessibilityRole="button"
        accessibilityLabel="Subtitles earlier"
        className="size-9 items-center justify-center rounded-pill bg-dark-hairline active:opacity-60"
      >
        <Icon icon={Minus} tone="onMedia" size="inline" />
      </Pressable>
      <Pressable
        onPress={() => onDelay(0)}
        accessibilityRole="button"
        accessibilityLabel={`Subtitle delay ${formatSubtitleDelay(delayMs)}, reset`}
        className="w-18 items-center"
      >
        <Text variant="monoMedium" tone="onMedia">
          {formatSubtitleDelay(delayMs)}
        </Text>
      </Pressable>
      <Pressable
        onPress={() => onDelay(delayMs + SUBTITLE_DELAY.stepMs)}
        accessibilityRole="button"
        accessibilityLabel="Subtitles later"
        className="size-9 items-center justify-center rounded-pill bg-dark-hairline active:opacity-60"
      >
        <Icon icon={Plus} tone="onMedia" size="inline" />
      </Pressable>
    </View>
  );
}

/** F02: the file's audio tracks and the stream's subtitles, side by side. */
export function AudioSubtitlesPanel({
  audio,
  audioStreamIndex,
  subtitles,
  subtitleId,
  subtitleDelayMs,
  onAudio,
  onSubtitle,
  onDelay,
  onClose,
}: {
  readonly audio: ReadonlyArray<AudioStream>;
  readonly audioStreamIndex: number | null;
  readonly subtitles: NegotiateResponse["subtitles"];
  readonly subtitleId: string | null;
  readonly subtitleDelayMs: number;
  readonly onAudio: (streamIndex: number) => void;
  readonly onSubtitle: (id: string | null) => void;
  readonly onDelay: (delayMs: number) => void;
  readonly onClose: () => void;
}) {
  const audioLabels = audioTrackLabels(audio);
  const subtitleLabels = subtitleTrackLabels(subtitles);

  const playingAudio =
    audioStreamIndex ?? audio.find((track) => track.default)?.index ?? audio[0]?.index;

  const shownText = subtitles.find((track) => track.id === subtitleId)?.kind === "text";

  return (
    <SidePanel title="Audio & Subtitles" widthClassName="w-140" onClose={onClose}>
      <View className="flex-1 flex-row gap-8">
        <ScrollView className="flex-1" contentContainerClassName="gap-2">
          <ColumnHeading>Audio</ColumnHeading>
          {audio.map((track, index) => (
            <ChoiceRow
              key={track.index}
              label={audioLabels[index] ?? ""}
              selected={track.index === playingAudio}
              onPress={() => onAudio(track.index)}
            />
          ))}
        </ScrollView>
        <ScrollView className="flex-1" contentContainerClassName="gap-2">
          <ColumnHeading>Subtitles</ColumnHeading>
          <ChoiceRow label="Off" selected={subtitleId === null} onPress={() => onSubtitle(null)} />
          {subtitles.map((track, index) => (
            <ChoiceRow
              key={track.id}
              label={subtitleLabels[index] ?? ""}
              selected={track.id === subtitleId}
              onPress={() => onSubtitle(track.id)}
            />
          ))}
          {shownText ? <SubtitleTiming delayMs={subtitleDelayMs} onDelay={onDelay} /> : null}
        </ScrollView>
      </View>
    </SidePanel>
  );
}

/** F03: the quality cap. */
export function QualityPanel({
  quality,
  onQuality,
  onClose,
}: {
  readonly quality: QualityChoice;
  readonly onQuality: (quality: QualityChoice) => void;
  readonly onClose: () => void;
}) {
  return (
    <SidePanel title="Playback Quality" widthClassName="w-100" onClose={onClose}>
      <ScrollView contentContainerClassName="gap-4">
        {QUALITY_OPTIONS.map((option) => (
          <DetailRow
            key={option.id}
            label={option.label}
            detail={option.id === quality ? "Selected" : option.rate}
            selected={option.id === quality}
            onPress={() => onQuality(option.id)}
          />
        ))}
      </ScrollView>
    </SidePanel>
  );
}

const SPEEDS: ReadonlyArray<number> = [0.5, 0.75, 1, 1.25, 1.5, 2];

/** `1×`, `1.25×`. */
export const speedLabel = (rate: number): string => `${String(rate)}×`;

/** Playback speed, as rows like Playback Quality's. */
export function SpeedPanel({
  rate,
  onRate,
  onClose,
}: {
  readonly rate: number;
  readonly onRate: (rate: number) => void;
  readonly onClose: () => void;
}) {
  return (
    <SidePanel title="Playback Speed" widthClassName="w-100" onClose={onClose}>
      <ScrollView contentContainerClassName="gap-2">
        {SPEEDS.map((speed) => (
          <ChoiceRow
            key={speed}
            label={speedLabel(speed)}
            selected={speed === rate}
            onPress={() => onRate(speed)}
          />
        ))}
      </ScrollView>
    </SidePanel>
  );
}

/** F04: the season's episodes, the one playing marked. */
export function EpisodesPanel({
  title,
  episodes,
  playingId,
  stillUrl,
  onEpisode,
  onClose,
}: {
  readonly title: string;
  readonly episodes: ReadonlyArray<SeasonEpisode>;
  readonly playingId: string;
  readonly stillUrl: (episode: SeasonEpisode) => string | undefined;
  readonly onEpisode: (episode: SeasonEpisode) => void;
  readonly onClose: () => void;
}) {
  return (
    <SidePanel title={title} widthClassName="w-117.5" onClose={onClose}>
      <FlatList
        data={episodes}
        keyExtractor={(episode) => episode.id}
        contentContainerClassName="gap-4"
        initialScrollIndex={Math.max(
          0,
          episodes.findIndex((episode) => episode.id === playingId),
        )}
        getItemLayout={(_data, index) => ({ length: 92, offset: 92 * index, index })}
        renderItem={({ item }) => {
          const playing = item.id === playingId;
          const runtime = item.runtimeMs === null ? null : formatRuntime(item.runtimeMs);
          const detail = [runtime, playing ? "Playing" : null].filter((part) => part !== null);
          const still = stillUrl(item);

          return (
            <Pressable
              onPress={() => onEpisode(item)}
              disabled={playing || !item.available}
              accessibilityRole="button"
              accessibilityLabel={`${String(item.episodeNumber)}. ${item.name}`}
              accessibilityState={{ selected: playing, disabled: !item.available }}
              className={`h-19 flex-row items-center gap-3 active:opacity-60 ${item.available ? "" : "opacity-40"}`}
            >
              <View className="h-19 w-32 overflow-hidden rounded-control bg-dark-surface">
                {still === undefined ? null : (
                  <Image source={{ uri: still }} contentFit="cover" className="absolute inset-0" />
                )}
                <View className="absolute bottom-2 left-2">
                  <Icon icon={Play} tone="onMedia" size="inline" filled />
                </View>
              </View>
              <View className="flex-1 gap-1">
                <Text variant="labelStrong" tone="onMedia" numberOfLines={1}>
                  {`${String(item.episodeNumber)}. ${item.name}`}
                </Text>
                {detail.length === 0 ? null : (
                  <Text variant="meta" tone="darkMuted" numberOfLines={1}>
                    {detail.join(" · ")}
                  </Text>
                )}
              </View>
            </Pressable>
          );
        }}
      />
    </SidePanel>
  );
}

/** F05: the file's chapters, each starting playback there. */
export function ChaptersPanel({
  chapters,
  onChapter,
  onClose,
}: {
  readonly chapters: ReadonlyArray<ChapterRow>;
  readonly onChapter: (chapter: ChapterRow) => void;
  readonly onClose: () => void;
}) {
  return (
    <SidePanel title="Chapters" widthClassName="w-110" onClose={onClose}>
      <ScrollView contentContainerClassName="gap-4">
        {chapters.map((chapter) => (
          <DetailRow
            key={`${String(chapter.startSeconds)}-${chapter.title}`}
            leading={<Icon icon={Play} tone="onMedia" size="inline" filled />}
            label={chapter.title}
            detail={formatClock(chapter.startSeconds)}
            onPress={() => onChapter(chapter)}
          />
        ))}
      </ScrollView>
    </SidePanel>
  );
}

/** F09 and F13: why playback stopped, and the ways on. */
export function ProblemPanel({
  title,
  description,
  primary,
  secondary,
  onClose,
}: {
  readonly title: string;
  readonly description: string;
  /** The main way on; `retry` draws the retry arrow before its label. */
  readonly primary: {
    readonly label: string;
    readonly retry: boolean;
    readonly onPress: () => void;
  };
  readonly secondary: { readonly label: string; readonly onPress: () => void } | null;
  readonly onClose: () => void;
}) {
  return (
    <SidePanel title={title} widthClassName="w-105" onClose={onClose}>
      <Text tone="darkMuted">{description}</Text>
      <View className="h-4" />
      {primary.retry ? (
        <Button label={primary.label} icon={RotateCcw} onPress={primary.onPress} />
      ) : (
        <Button label={primary.label} onPress={primary.onPress} />
      )}
      {secondary === null ? null : (
        <Button label={secondary.label} variant="onDark" onPress={secondary.onPress} />
      )}
    </SidePanel>
  );
}
