import type { CommandItem, CommandPage } from "@media/ui/lib/command-menu";
import type { TrackOption } from "@media/ui/components/track-popover";
import {
  AudioLinesIcon,
  CaptionsIcon,
  ChevronsLeftIcon,
  ChevronsRightIcon,
  FastForwardIcon,
  GalleryVerticalEndIcon,
  GaugeIcon,
  InfoIcon,
  LayersIcon,
  MaximizeIcon,
  PauseIcon,
  PlayIcon,
  RewindIcon,
  SkipForwardIcon,
  TimerResetIcon,
} from "lucide-react";
import { useMemo } from "react";

import { playerKeymap } from "@/lib/keymap";

import type { CommandContext, CommandContribution, PlayerCommands } from "./contribution";

const trackPage = (
  id: string,
  breadcrumb: string,
  options: ReadonlyArray<TrackOption>,
  selected: string,
  select: (id: string) => void,
): CommandPage => ({
  id,
  breadcrumb,
  placeholder: `Search ${breadcrumb.toLowerCase()}…`,
  groups: [
    {
      id: `${id}:options`,
      items: options.map((option): CommandItem => ({
        kind: "action",
        id: `${id}:${option.id}`,
        title: option.label,
        detail: option.detail,
        checked: option.id === selected,
        perform: () => select(option.id),
      })),
    },
  ],
});

const subtitleDelayItems = (delay: PlayerCommands["subtitleDelay"]): ReadonlyArray<CommandItem> => {
  if (delay === null) return [];

  const keywords = ["subtitles", "captions", "delay", "timing", "sync", "offset"];

  return [
    {
      kind: "action",
      id: "player:subtitles-earlier",
      title: "Subtitles earlier",
      keywords,
      leading: { kind: "icon", icon: ChevronsLeftIcon },
      keycaps: playerKeymap.keycaps("player.subtitles-earlier"),
      perform: () => delay.step(-1),
    },
    {
      kind: "action",
      id: "player:subtitles-later",
      title: "Subtitles later",
      keywords,
      leading: { kind: "icon", icon: ChevronsRightIcon },
      keycaps: playerKeymap.keycaps("player.subtitles-later"),
      perform: () => delay.step(1),
    },
    ...(delay.delayMs === 0
      ? []
      : [
          {
            kind: "action" as const,
            id: "player:subtitles-reset",
            title: "Reset subtitle delay",
            keywords,
            leading: { kind: "icon" as const, icon: TimerResetIcon },
            perform: () => delay.step(0),
          },
        ]),
  ];
};

/** The player's group of commands. A file without audio tracks has no Audio list. */
export const playbackCommands = (player: PlayerCommands | null): CommandContribution => {
  if (player === null) return { groups: [] };

  const timeline: ReadonlyArray<CommandItem> = [
    {
      kind: "action",
      id: "player:toggle",
      title: player.playing ? "Pause" : "Play",
      leading: { kind: "icon", icon: player.playing ? PauseIcon : PlayIcon },
      keycaps: playerKeymap.keycaps("player.toggle"),
      perform: player.togglePlay,
    },
    {
      kind: "action",
      id: "player:back",
      title: "Back 10 seconds",
      keywords: ["rewind", "seek"],
      leading: { kind: "icon", icon: RewindIcon },
      keycaps: playerKeymap.keycaps("player.back-10"),
      perform: () => player.skip(-10),
    },
    {
      kind: "action",
      id: "player:forward",
      title: "Forward 10 seconds",
      keywords: ["skip", "seek"],
      leading: { kind: "icon", icon: FastForwardIcon },
      keycaps: playerKeymap.keycaps("player.forward-10"),
      perform: () => player.skip(10),
    },
    ...(player.nextEpisode === null
      ? []
      : [
          {
            kind: "action" as const,
            id: "player:next",
            title: "Next episode",
            leading: { kind: "icon" as const, icon: SkipForwardIcon },
            perform: player.nextEpisode,
          },
        ]),
    ...(player.episodes.length === 0
      ? []
      : [
          {
            kind: "submenu" as const,
            id: "player:episodes",
            title: "Episodes",
            keywords: ["season", "episode"],
            leading: { kind: "icon" as const, icon: GalleryVerticalEndIcon },
            page: trackPage(
              "episodes",
              "Episodes",
              player.episodes,
              player.episodeId,
              player.selectEpisode,
            ),
          },
        ]),
  ];

  const items: ReadonlyArray<CommandItem> = [
    ...timeline,
    {
      kind: "submenu",
      id: "player:subtitles",
      title: "Subtitles",
      keywords: ["captions", "cc"],
      leading: { kind: "icon", icon: CaptionsIcon },
      page: trackPage(
        "subtitles",
        "Subtitles",
        player.subtitles,
        player.subtitleId,
        player.selectSubtitle,
      ),
    },
    ...subtitleDelayItems(player.subtitleDelay),
    ...(player.audio.length === 0
      ? []
      : [
          {
            kind: "submenu" as const,
            id: "player:audio",
            title: "Audio",
            keywords: ["language", "track", "dub"],
            leading: { kind: "icon" as const, icon: AudioLinesIcon },
            page: trackPage("audio", "Audio", player.audio, player.audioId, player.selectAudio),
          },
        ]),
    {
      kind: "submenu",
      id: "player:quality",
      title: "Quality",
      keywords: ["resolution", "bitrate", "1080p", "720p", "480p"],
      leading: { kind: "icon", icon: GaugeIcon },
      page: trackPage("quality", "Quality", player.quality, player.qualityId, player.selectQuality),
    },
    ...(player.versions.length === 0
      ? []
      : [
          {
            kind: "submenu" as const,
            id: "player:version",
            title: "Version",
            keywords: ["edition", "file", "cut", "copy"],
            leading: { kind: "icon" as const, icon: LayersIcon },
            page: trackPage(
              "version",
              "Version",
              player.versions,
              player.versionId,
              player.selectVersion,
            ),
          },
        ]),
    ...(player.showStreamInfo === null
      ? []
      : [
          {
            kind: "action" as const,
            id: "player:stream-info",
            title: "Stream info",
            keywords: ["codec", "direct", "transcode", "bitrate"],
            leading: { kind: "icon" as const, icon: InfoIcon },
            perform: player.showStreamInfo,
          },
        ]),
    {
      kind: "action",
      id: "player:fullscreen",
      title: "Full screen",
      leading: { kind: "icon", icon: MaximizeIcon },
      keycaps: playerKeymap.keycaps("player.fullscreen"),
      perform: player.toggleFullscreen,
    },
  ];

  return { groups: [{ id: "playback", label: "Playback", items }] };
};

/** The player's group of commands, when the player is open. */
export const usePlaybackCommands = ({ player }: CommandContext): CommandContribution =>
  useMemo(() => playbackCommands(player), [player]);
