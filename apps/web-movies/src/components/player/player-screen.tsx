import type { NegotiateResponse } from "@media/contracts/media-playback";
import { Playback, Versions } from "@media/sdk/effect";
import { usePlatform, usePlatformQuery } from "@media/sdk/react";
import { ChapterPopover } from "@media/ui/components/chapter-popover";
import { CommandMenu } from "@media/ui/components/command-menu";
import {
  EpisodesGlyph,
  PlayerButton,
  PlayerControls,
  TracksGlyph,
} from "@media/ui/components/player-controls";
import { TrackPopover } from "@media/ui/components/track-popover";
import type { TrackOption } from "@media/ui/components/track-popover";
import { useKeymap } from "@media/ui/lib/use-keymap";
import { cn } from "@media/ui/lib/utils";
import { useNavigate } from "@tanstack/react-router";
import { Effect, Fiber, Stream } from "effect";
import { ArrowLeftIcon, InfoIcon, ListVideoIcon, PictureInPicture2Icon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { useCommandRoot } from "@/commands";
import type { PlayerCommands } from "@/commands";
import { artworkUrl } from "@/lib/artwork";
import type { EpisodeId, MediaFileId, MediaVersion, TitleId } from "@/lib/catalog";
import { loadQualityChoice, saveQualityChoice } from "@/lib/device-storage";
import { episodeCode } from "@/lib/format";
import { playerKeymap } from "@/lib/keymap";
import { audioTrackLabel, subtitleTrackLabels } from "@/lib/media-facts";
import { volumeIsSettable } from "@/playback/browser-support";
import { PlaybackPhase, StartChoice } from "@/playback/playback-controller";
import type { PlaybackRequest } from "@/playback/playback-controller";
import { PlaybackStop } from "@/playback/playback-policy";
import {
  QUALITY_OPTIONS,
  parseQualityChoice,
  qualityOfSetting,
  qualitySetting,
} from "@/playback/quality";
import type { QualityChoice } from "@/playback/quality";
import { chapterAt, useScrubbing } from "@/playback/scrubbing";
import { useMediaSession } from "@/playback/use-media-session";
import { usePictureInPicture } from "@/playback/use-picture-in-picture";
import { useMediaState, usePlayback } from "@/playback/use-playback";
import { withFacts } from "@/playback/use-version-choice";
import { useMe, useScopes } from "@/session/session";

import { AUTOPLAY_COUNTDOWN } from "./autoplay";
import { AutoplayNext } from "./autoplay-next";
import { EpisodePicker } from "./episode-picker";
import { LeaveDialog } from "./leave-dialog";
import { PhoneControls, TrackPill } from "./phone-player";
import {
  Buffering,
  PlaybackStopped,
  PreparingStream,
  PressPlay,
  ResumePrompt,
  SubtitleDelayNotice,
  TryingAnotherWay,
} from "./player-states";
import { StreamInfo } from "./stream-info";
import { useControlsVisible, useFullscreen, usePlayerLayout } from "./use-player-frame";
import type { PlayerLayout } from "./use-player-frame";
import { useSeasonEpisodes } from "./use-season-episodes";
import { useSubtitleDelay } from "./use-subtitle-delay";

const BUFFER_TARGET_SECONDS = 4;

const BUFFERING_GRACE_MS = 400;

const KEY_PREVIEW_MS = 1_200;

const VOLUME_STEP = 0.1;

const volumeLevel = (value: number): number =>
  Math.round(Math.min(1, Math.max(0, value)) * 100) / 100;

const OFF = "off";

const TRACKS_LABEL = "Audio, subtitles, and quality";

const NO_VERSIONS: ReadonlyArray<MediaVersion> = [];

const creditsSeconds = (duration: number): number => Math.min(30, duration * 0.1);

/** What the player was asked to play. */
export interface PlayerScreenProps {
  readonly titleId: TitleId;
  readonly episodeId: EpisodeId | undefined;
  /** The version to play; the one the server picks for this browser when undefined. */
  readonly version: MediaFileId | undefined;
  /** `0` starts at the beginning; `resume` resumes without asking. */
  readonly start: "0" | "resume" | undefined;
}

const startChoice = (start: PlayerScreenProps["start"]): StartChoice => {
  if (start === "0") return StartChoice.Beginning();

  return start === "resume" ? StartChoice.Resume() : StartChoice.Ask();
};

const useSettled = (value: boolean, ms: number): boolean => {
  const [settled, setSettled] = useState(false);

  useEffect(() => {
    if (!value) {
      setSettled(false);

      return undefined;
    }

    const timer = setTimeout(() => setSettled(true), ms);

    return () => clearTimeout(timer);
  }, [value, ms]);

  return value && settled;
};

/** The player screen. */
export function PlayerScreen({ titleId, episodeId, version, start }: PlayerScreenProps) {
  const platform = usePlatform();
  const me = useMe();
  const scopes = useScopes();
  const navigate = useNavigate();
  const layout = usePlayerLayout();
  const [frame, setFrame] = useState<HTMLDivElement | null>(null);
  const [overlays, setOverlays] = useState<HTMLDivElement | null>(null);
  const [video, setVideo] = useState<HTMLVideoElement | null>(null);
  const title = usePlatformQuery(platform.movies.titles.get, { titleId });
  const detail = title.status === "success" ? title.data : null;

  const [menu, setMenu] = useState(false);
  const [info, setInfo] = useState(false);
  const [episodesOpenIn, setEpisodesOpenIn] = useState<PlayerLayout | null>(null);
  const [volumeOpen, setVolumeOpen] = useState(false);

  const [creditsDismissed, setCreditsDismissed] = useState(false);

  const [countdown, setCountdown] = useState<number | null>(null);
  const [brightness, setBrightness] = useState(1);
  const [scrub, setScrub] = useState<number | null>(null);
  const [keyPreview, setKeyPreview] = useState<number | null>(null);
  const [menuQuery, setMenuQuery] = useState("");

  const [leaving, setLeaving] = useState<{ readonly resume: boolean } | null>(null);
  const focusBeforeLeaving = useRef<HTMLElement | null>(null);

  const canSetVolume = useMemo(() => volumeIsSettable(), []);

  const versionList = usePlatformQuery(
    platform.movies.titles.versions,
    episodeId === undefined ? { titleId } : { titleId, episodeId },
  );

  const versions = versionList.status === "success" ? versionList.data : NO_VERSIONS;
  const versionFacts = useMemo(() => withFacts(versions), [versions]);

  const settings = usePlatformQuery(platform.core.settings.get);

  const deviceQuality =
    settings.status === "success" ? (settings.data.device?.streamQuality ?? null) : null;

  const buildRequest = (): PlaybackRequest => ({
    titleId,
    episodeId: episodeId ?? null,
    fileId: version ?? null,
    start: startChoice(start),
    quality: deviceQuality === null ? loadQualityChoice() : qualityOfSetting(deviceQuality),
  });

  // The first request takes the person's saved quality, so playback waits for the settings to
  // answer once; settings that fail to load fall back to this browser's choice, and a later reload
  // of them never stops playback.
  const [settled, setSettled] = useState(false);

  if (!settled && settings.status !== "loading") setSettled(true);

  const handle = usePlayback(video, settled ? buildRequest : null, `${titleId}:${episodeId ?? ""}`);

  const controller = handle?.controller ?? null;
  const snapshot = handle?.snapshot ?? null;
  const phase = snapshot?.phase ?? PlaybackPhase.Starting();
  const isPlaying = PlaybackPhase.$is("Playing")(phase);
  const player = controller?.player ?? null;
  const media = useMediaState(video, player);
  const stream = snapshot?.stream ?? null;
  const started = snapshot?.started ?? null;
  const coreStart = snapshot?.coreStart ?? null;
  const episode = coreStart?.episode ?? null;
  const titleName = detail?.name ?? "";
  const artworkKey = episode?.still ?? detail?.artwork.poster ?? null;
  const pip = usePictureInPicture(video);

  const duration = stream?.durationSeconds ?? (started?.file.probe.durationMs ?? 0) / 1000;
  const position = scrub ?? media.positionSeconds;

  const heading =
    episode === null ? titleName : `${titleName} ${episodeCode(episode)} ${episode.name}`;

  const next = usePlatformQuery(
    platform.movies.titles.nextEpisode,
    ...(episode === null ? (["skip"] as const) : ([{ episodeId: episode.id }] as const)),
  );

  const nextEpisode = next.status === "success" ? next.data : null;

  const backToDetails = useCallback(() => {
    void navigate({ to: "/title/$titleId", params: { titleId } });
  }, [navigate, titleId]);

  const { toggle: toggleFullscreen, takeEscape } = useFullscreen(frame, video);

  const seekTo = useCallback(
    (seconds: number) => {
      if (player === null) return;

      setScrub(null);
      player.seek(Math.max(0, Math.min(duration, seconds)) * 1000);
    },
    [player, duration],
  );

  const skip = useCallback(
    (by: number) => {
      if (player !== null) seekTo(player.positionMs() / 1000 + by);
    },
    [player, seekTo],
  );

  const scrubbing = useScrubbing(started);
  const preloadThumbnails = scrubbing.preload;
  const keyPreviewTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const skipByKey = useCallback(
    (by: number) => {
      if (player === null) return;
      const target = Math.max(0, Math.min(duration, player.positionMs() / 1000 + by));

      seekTo(target);
      preloadThumbnails();
      setKeyPreview(target);
      clearTimeout(keyPreviewTimer.current);
      keyPreviewTimer.current = setTimeout(() => setKeyPreview(null), KEY_PREVIEW_MS);
    },
    [player, duration, seekTo, preloadThumbnails],
  );

  useEffect(() => () => clearTimeout(keyPreviewTimer.current), []);

  const currentChapter = chapterAt(scrubbing.chapters, media.positionSeconds);

  const play = useCallback(() => {
    if (player === null) return;

    if (snapshot?.needsGesture === true) controller?.resumeWithGesture();
    else void player.play().catch(() => undefined);
  }, [player, snapshot?.needsGesture, controller]);

  const togglePlay = useCallback(() => {
    if (player === null) return;

    if (snapshot?.needsGesture === true || player.isPaused()) play();
    else player.pause();
  }, [player, snapshot?.needsGesture, play]);

  const setVolume = useCallback(
    (value: number) => {
      if (video === null) return;

      const level = volumeLevel(value);

      video.volume = level;
      video.muted = level === 0;
    },
    [video],
  );

  const audible = useRef<number | null>(null);
  const levelNow = media.volume;

  const rememberStart = useCallback(() => {
    if (levelNow > 0 && audible.current === null) audible.current = levelNow;
  }, [levelNow]);

  const commitVolume = useCallback(
    (value: number) => {
      const level = volumeLevel(value);

      rememberStart();

      if (level > 0) audible.current = level;
      setVolume(level);
    },
    [rememberStart, setVolume],
  );

  const followVolume = useCallback(
    (value: number) => {
      rememberStart();
      setVolume(value);
    },
    [rememberStart, setVolume],
  );

  const silent = canSetVolume && media.volume === 0;

  const setMuted = useCallback(
    (muted: boolean) => {
      if (!muted && silent) setVolume(audible.current ?? 1);
      else if (video !== null) video.muted = muted;
    },
    [video, silent, setVolume],
  );

  const audioOptions = useMemo(
    (): ReadonlyArray<TrackOption> =>
      (started?.file.probe.audio ?? []).map((track, index) => ({
        id: String(track.index),
        label: audioTrackLabel(track, index),
      })),
    [started],
  );

  const subtitleLabels = useMemo(() => subtitleTrackLabels(stream?.subtitles ?? []), [stream]);

  const subtitleOptions = useMemo(
    (): ReadonlyArray<TrackOption> => [
      { id: OFF, label: "Off" },
      ...(stream?.subtitles ?? []).flatMap((track, index) =>
        track.url !== undefined || track.kind === "bitmap"
          ? [{ id: track.id, label: subtitleLabels[index] ?? track.id }]
          : [],
      ),
    ],
    [stream, subtitleLabels],
  );

  const subtitleId = snapshot?.subtitleId ?? OFF;

  const audioId =
    snapshot?.audioStreamIndex === null || snapshot === null
      ? ""
      : String(snapshot.audioStreamIndex);

  const lastSubtitle = useRef<string | null>(null);

  const selectSubtitle = useCallback(
    (id: string) => {
      if (id !== OFF) lastSubtitle.current = id;
      controller?.selectSubtitle(id === OFF ? null : id);
    },
    [controller],
  );

  const toggleSubtitles = useCallback(() => {
    if (subtitleId !== OFF) {
      selectSubtitle(OFF);

      return;
    }

    const choice = lastSubtitle.current ?? subtitleOptions[1]?.id;

    if (choice !== undefined) selectSubtitle(choice);
  }, [subtitleId, subtitleOptions, selectSubtitle]);

  const selectAudio = useCallback(
    (id: string) => {
      const index = Number(id);

      if (Number.isInteger(index)) controller?.selectAudio(index);
    },
    [controller],
  );

  const qualityId = snapshot?.quality ?? "auto";

  const selectQuality = useCallback(
    (id: string) => {
      const choice = parseQualityChoice(id);

      if (choice === undefined) return;
      controller?.selectQuality(choice);
    },
    [controller],
  );

  const versionOptions = useMemo(
    (): ReadonlyArray<TrackOption> =>
      versionFacts.length < 2
        ? []
        : versionFacts.map(({ version: candidate, facts }) => ({
            id: candidate.id,
            label: Versions.label(facts),
            detail: Versions.detail(facts),
          })),
    [versionFacts],
  );

  const versionId = coreStart?.file.id ?? "";

  const versionPick = useRef<{
    readonly id: MediaFileId;
    readonly before: NegotiateResponse | null;
  } | null>(null);

  const selectVersion = useCallback(
    (id: string) => {
      const chosen = versions.find((candidate) => candidate.id === id);

      if (chosen === undefined || controller?.selectVersion(chosen.id) !== true) return;
      versionPick.current = { id: chosen.id, before: stream };
    },
    [versions, controller, stream],
  );

  useEffect(() => {
    const pick = versionPick.current;

    if (pick === null || coreStart === null || stream === null || stream === pick.before) return;
    versionPick.current = null;

    if (coreStart.file.id !== pick.id) {
      toast.error("This version couldn't play");

      return;
    }

    void navigate({
      to: "/watch/$titleId",
      params: { titleId },
      search: (previous) => ({ ...previous, version: pick.id }),
      replace: true,
    });
  }, [coreStart, stream, navigate, titleId]);

  const loadedQuality = snapshot?.loadedQuality ?? null;

  const keptQuality = useRef<QualityChoice | null>(null);

  useEffect(() => {
    if (loadedQuality === null || loadedQuality === keptQuality.current) return;
    keptQuality.current = loadedQuality;
    saveQualityChoice(loadedQuality);

    const setting = qualitySetting(loadedQuality);

    if (deviceQuality !== null && deviceQuality !== setting) {
      void platform.core.settings.set({ streamQuality: setting }).catch(() => undefined);
    }
  }, [loadedQuality, deviceQuality, platform]);

  useEffect(() => {
    if (video === null) return;

    for (const track of Array.from(video.textTracks)) {
      track.mode = track.id === subtitleId ? "showing" : "disabled";
    }
  }, [video, subtitleId, stream]);

  const subtitleDelay = useSubtitleDelay({
    controller,
    stream,
    subtitleId: snapshot?.subtitleId ?? null,
    delayMs: snapshot?.subtitleDelayMs ?? 0,
    keycaps: layout === "desktop",
  });

  const askToLeave = useCallback(() => {
    const pause = player !== null && !player.isPaused();

    if (pause) player.pause();
    focusBeforeLeaving.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setLeaving({ resume: pause });
  }, [player]);

  const stay = useCallback(() => {
    if (leaving?.resume === true) play();
    setLeaving(null);
  }, [leaving, play]);

  // Back to where focus was in the player, or to the player itself. The dialog would move focus
  // from the frame, which only script can focus, to its first button, so the frame is focused here.
  const focusAfterLeaving = useCallback((): HTMLElement | false => {
    const previous = focusBeforeLeaving.current;

    if (
      previous !== null &&
      previous !== frame &&
      previous.isConnected &&
      frame?.contains(previous) === true
    )
      return previous;

    frame?.focus({ preventScroll: true });

    return false;
  }, [frame]);

  const remaining = Math.max(0, duration - media.positionSeconds);

  const inCredits =
    isPlaying &&
    leaving === null &&
    (!media.paused || media.ended) &&
    duration > 0 &&
    (media.ended || remaining <= creditsSeconds(duration));

  const showNext = inCredits && nextEpisode !== null && !creditsDismissed;

  const playEpisode = useCallback(
    (id: EpisodeId) => {
      void navigate({
        to: "/watch/$titleId",
        params: { titleId },
        search: { episodeId: id, start: "resume" },
      });
    },
    [navigate, titleId],
  );

  const playNext = useCallback(() => {
    if (nextEpisode !== null) playEpisode(nextEpisode.id);
  }, [nextEpisode, playEpisode]);

  const nextAction = nextEpisode === null ? null : playNext;

  const seasonEpisodes = useSeasonEpisodes(
    coreStart?.titleId ?? titleId,
    episode?.seasonNumber ?? null,
  );

  const previousEpisode = (() => {
    if (seasonEpisodes === null || episode === null) return null;
    const at = seasonEpisodes.findIndex((candidate) => candidate.id === episode.id);

    return at > 0 ? (seasonEpisodes[at - 1] ?? null) : null;
  })();

  const playPrevious = useCallback(() => {
    if (previousEpisode !== null) playEpisode(previousEpisode.id);
  }, [playEpisode, previousEpisode]);

  const episodeIdNow = episode?.id ?? null;
  const seasonNow = episode?.seasonNumber ?? null;
  const seasons = detail?.seasons ?? null;

  const picking = useMemo(
    () =>
      episodeIdNow === null || seasonNow === null || seasons === null
        ? null
        : {
            seasons,
            current: { id: episodeIdNow, seasonNumber: seasonNow },
            currentSeason: seasonEpisodes,
          },
    [episodeIdNow, seasonNow, seasons, seasonEpisodes],
  );

  const canPick = picking !== null;

  if (episodesOpenIn !== null && (!canPick || episodesOpenIn !== layout)) {
    setEpisodesOpenIn(null);
  }

  const episodesShown = episodesOpenIn === layout && canPick;

  const episodeOptions = useMemo(
    (): ReadonlyArray<TrackOption> =>
      !canPick || seasonEpisodes === null
        ? []
        : seasonEpisodes.flatMap((candidate) =>
            candidate.available
              ? [
                  {
                    id: candidate.id,
                    label: `${String(candidate.episodeNumber)}. ${candidate.name}`,
                  },
                ]
              : [],
          ),
    [canPick, seasonEpisodes],
  );

  const selectEpisode = useCallback(
    (id: string) => {
      const chosen = seasonEpisodes?.find((candidate) => candidate.id === id);

      if (chosen !== undefined && chosen.id !== episode?.id) playEpisode(chosen.id);
    },
    [seasonEpisodes, episode?.id, playEpisode],
  );

  useMediaSession(
    !isPlaying || started === null
      ? null
      : {
          title: episode?.name ?? titleName,
          artist: episode === null ? "" : titleName,
          album: episode === null ? "" : episodeCode(episode),
          artwork: artworkUrl(artworkKey, "poster") ?? null,
          durationSeconds: duration,
          positionSeconds: media.positionSeconds,
          paused: media.paused,
          play: () => {
            if (player?.isPaused() === true) togglePlay();
          },
          pause: () => {
            if (player?.isPaused() === false) togglePlay();
          },
          seekTo,
          previous: previousEpisode === null ? null : playPrevious,
          next: nextAction,
        },
  );

  useEffect(() => {
    if (!showNext) {
      setCountdown(null);

      return undefined;
    }

    const fiber = Effect.runFork(
      Stream.runForEach(
        Playback.autoplayCountdown(AUTOPLAY_COUNTDOWN.totalMs, AUTOPLAY_COUNTDOWN.stepMs),
        (left) => Effect.sync(() => setCountdown(left)),
      ).pipe(Effect.andThen(Effect.sync(playNext))),
    );

    return () => {
      Effect.runFork(Fiber.interrupt(fiber));
    };
  }, [showNext, playNext]);

  const stalled = useSettled(isPlaying && media.buffering, BUFFERING_GRACE_MS);

  const streamInfoAvailable = layout === "desktop" && stream !== null && started !== null;
  const infoShown = info && streamInfoAvailable;

  const hold =
    !isPlaying ||
    media.paused ||
    infoShown ||
    menu ||
    episodesShown ||
    (volumeOpen && canSetVolume) ||
    leaving !== null ||
    showNext ||
    scrub !== null;

  const controlsVisible = useControlsVisible(frame, hold);

  useKeymap(
    playerKeymap,
    {
      "menu.toggle": () => setMenu((open) => !open),
      "player.toggle": togglePlay,
      "player.toggle-k": togglePlay,
      "player.back-10": () => skipByKey(-10),
      "player.forward-10": () => skipByKey(10),
      "player.back-5": () => skipByKey(-5),
      "player.forward-5": () => skipByKey(5),
      "player.volume-up": () => {
        if (canSetVolume) commitVolume(media.volume + VOLUME_STEP);
        else if (media.muted) setMuted(false);
      },
      "player.volume-down": () => {
        if (canSetVolume) commitVolume(media.volume - VOLUME_STEP);
      },
      "player.fullscreen": toggleFullscreen,
      "player.mute": () => setMuted(!(media.muted || silent)),
      "player.subtitles": toggleSubtitles,
      "player.subtitles-earlier": () => subtitleDelay.stepWithNotice(-1),
      "player.subtitles-later": () => subtitleDelay.stepWithNotice(1),
      "player.exit": (event) => {
        if (takeEscape(event)) return;

        if (infoShown) setInfo(false);
        else askToLeave();
      },
    },
    !menu && leaving === null,
  );

  const commands = useMemo(
    (): PlayerCommands => ({
      playing: !media.paused,
      togglePlay,
      skip,
      toggleFullscreen,
      showStreamInfo: streamInfoAvailable ? () => setInfo(true) : null,
      subtitles: subtitleOptions,
      subtitleId,
      selectSubtitle,
      subtitleDelay: subtitleDelay.timing.adjustable
        ? { delayMs: subtitleDelay.delayMs, step: subtitleDelay.stepWithNotice }
        : null,
      audio: audioOptions,
      audioId,
      selectAudio,
      quality: QUALITY_OPTIONS,
      qualityId,
      selectQuality,
      versions: versionOptions,
      versionId,
      selectVersion,
      nextEpisode: nextAction,
      episodes: episodeOptions,
      episodeId: episode?.id ?? "",
      selectEpisode,
    }),
    [
      media.paused,
      togglePlay,
      skip,
      toggleFullscreen,
      subtitleOptions,
      subtitleId,
      selectSubtitle,
      subtitleDelay.timing.adjustable,
      subtitleDelay.delayMs,
      subtitleDelay.stepWithNotice,
      audioOptions,
      audioId,
      selectAudio,
      qualityId,
      selectQuality,
      versionOptions,
      versionId,
      selectVersion,
      nextAction,
      episodeOptions,
      episode?.id,
      selectEpisode,
      streamInfoAvailable,
    ],
  );

  const root = useCommandRoot({ navigate, query: menuQuery, scopes, player: commands });

  const backdrop = artworkUrl(detail?.artwork.backdrop ?? null, "backdrop");

  // Where menus, popovers, and dialogs render: always inside the player, so they show in full
  // screen, where nothing outside the player does, and stay put when full screen ends. Popovers
  // open only from controls, after the layer has mounted.
  const overlayContainer = overlays ?? undefined;

  const tracks = (trigger: React.ReactElement) => (
    <TrackPopover
      trigger={trigger}
      container={overlayContainer}
      label={TRACKS_LABEL}
      choices={[
        ...(versionOptions.length === 0
          ? []
          : [
              {
                id: "version",
                label: "Version",
                options: versionOptions,
                value: versionId,
                onValueChange: selectVersion,
              },
            ]),
        {
          id: "audio",
          label: "Audio",
          options: audioOptions,
          value: audioId,
          onValueChange: selectAudio,
        },
        {
          id: "subtitles",
          label: "Subtitles",
          options: subtitleOptions,
          value: subtitleId,
          onValueChange: selectSubtitle,
          footer: subtitleDelay.control,
        },
        {
          id: "quality",
          label: "Quality",
          options: QUALITY_OPTIONS,
          value: qualityId,
          onValueChange: selectQuality,
        },
      ]}
    />
  );

  const chapterMenu = (trigger: React.ReactElement) => (
    <ChapterPopover
      trigger={trigger}
      container={overlayContainer}
      chapters={scrubbing.chapters}
      currentId={currentChapter?.id ?? null}
      onSelect={(chapter) => seekTo(chapter.startSeconds)}
    />
  );

  const episodePicker = (trigger: React.ReactElement) =>
    picking === null ? null : (
      <EpisodePicker
        trigger={trigger}
        container={overlayContainer}
        open={episodesShown}
        onOpenChange={(open) => setEpisodesOpenIn(open ? layout : null)}
        titleId={titleId}
        seasons={picking.seasons}
        current={picking.current}
        currentSeason={picking.currentSeason}
        onPlay={playEpisode}
      />
    );

  const scrubProps = {
    describe: scrubbing.describe,
    chapters: scrubbing.chapterStarts,
    preview: keyPreview,
    onPreviewStart: scrubbing.preload,
  };

  const center = (() => {
    const stopped = PlaybackPhase.$is("Stopped")(phase) ? phase.stop : null;

    if (stopped !== null) {
      return PlaybackStop.$match(stopped, {
        Missing: () => (
          <PlaybackStopped
            missing
            title="We can't find this file"
            description="The video file was moved, renamed, or its drive is offline."
            onBack={backToDetails}
            secondary={
              scopes.has("movies:edit") && detail !== null
                ? {
                    label: "Show missing files",
                    onClick: () =>
                      void navigate({
                        to: "/admin/libraries/$libraryId",
                        params: { libraryId: detail.libraryId },
                      }),
                  }
                : undefined
            }
          />
        ),
        Unsupported: () => (
          <PlaybackStopped
            missing={false}
            title="This can't play here"
            description="This device can't play the file in any way the server offers."
            onBack={backToDetails}
          />
        ),
        Failed: ({ message }) => (
          <PlaybackStopped
            missing={false}
            title="Playback stopped"
            description={message}
            onBack={backToDetails}
            secondary={{ label: "Try again", onClick: () => controller?.retry() }}
          />
        ),
      });
    }

    if (PlaybackPhase.$is("Choosing")(phase)) {
      return (
        <ResumePrompt
          titleLabel={heading}
          personName={me?.username ?? ""}
          positionMs={phase.resumeAtMs}
          durationMs={started?.file.probe.durationMs ?? 0}
          onResume={() => controller?.choose("resume")}
          onStartOver={() => controller?.choose("beginning")}
        />
      );
    }

    if (PlaybackPhase.$is("Recovering")(phase)) {
      return <TryingAnotherWay positionMs={phase.positionMs} onBack={backToDetails} />;
    }

    if (!isPlaying) {
      const preparing = PlaybackPhase.$is("Preparing")(phase) ? phase : null;

      return (
        <PreparingStream
          titleLabel={heading}
          startAtMs={preparing?.startAtMs ?? 0}
          progress={preparing?.progress ?? 0.1}
        />
      );
    }

    if (snapshot?.needsGesture === true) {
      return <PressPlay onPlay={() => controller?.resumeWithGesture()} />;
    }

    if (stalled) {
      return <Buffering fraction={media.bufferedAheadSeconds / BUFFER_TARGET_SECONDS} />;
    }

    return null;
  })();

  const showChrome = isPlaying && center === null && !showNext;

  const videoElement = (
    <video
      ref={setVideo}
      data-testid="player-video"
      crossOrigin="anonymous"
      playsInline
      poster={backdrop}
      className="size-full bg-dark-bg object-contain"
      style={brightness < 1 ? { filter: `brightness(${String(brightness)})` } : undefined}
      onClick={layout === "desktop" ? togglePlay : undefined}
    >
      {(stream?.subtitles ?? []).flatMap((track, index) =>
        track.url === undefined
          ? []
          : [
              <track
                key={`${track.id}:${track.url}`}
                id={track.id}
                kind={track.hearingImpaired ? "captions" : "subtitles"}
                src={track.url}
                label={subtitleLabels[index] ?? track.id}
                {...(track.language === undefined ? {} : { srcLang: track.language })}
              />,
            ],
      )}
    </video>
  );

  const desktopControls = (
    <>
      <header
        className={cn(
          "on-media absolute inset-x-0 top-0 flex h-35 items-start justify-between bg-linear-to-b from-dark-bg/60 to-transparent px-10 py-8 transition-opacity duration-300",
          !controlsVisible &&
            !PlaybackPhase.$is("Choosing")(phase) &&
            "pointer-events-none opacity-0",
        )}
      >
        <div className="flex items-center gap-5">
          <PlayerButton
            aria-label="Back to details"
            onClick={backToDetails}
            className="[&_svg]:size-7"
          >
            <ArrowLeftIcon strokeWidth={1.75} aria-hidden />
          </PlayerButton>
        </div>
        <div className="flex items-center gap-6">
          {isPlaying && pip !== null ? (
            <PlayerButton
              aria-label="Picture in picture"
              aria-pressed={pip.active}
              active={pip.active}
              onClick={pip.toggle}
            >
              <PictureInPicture2Icon strokeWidth={1.75} aria-hidden />
            </PlayerButton>
          ) : null}
          {isPlaying && stream !== null && started !== null ? (
            <PlayerButton
              aria-label="Stream info"
              aria-pressed={infoShown}
              active={infoShown}
              onClick={() => setInfo((open) => !open)}
            >
              <InfoIcon strokeWidth={1.75} aria-hidden />
            </PlayerButton>
          ) : null}
        </div>
      </header>
      {infoShown ? (
        <StreamInfo
          file={started.file}
          stream={stream}
          bufferedAheadSeconds={media.bufferedAheadSeconds}
          onClose={() => setInfo(false)}
          className="absolute top-21 right-10"
        />
      ) : null}
      {showChrome ? (
        <PlayerControls
          className={cn(
            "absolute inset-x-0 bottom-0 transition-opacity duration-300",
            !controlsVisible && "pointer-events-none opacity-0",
          )}
          title={heading}
          playing={!media.paused}
          position={position}
          duration={duration}
          muted={media.muted}
          volume={canSetVolume ? media.volume : null}
          tracks={tracks(
            <PlayerButton aria-label={TRACKS_LABEL}>
              <TracksGlyph />
            </PlayerButton>,
          )}
          episodes={episodePicker(
            <PlayerButton aria-label="Episodes">
              <EpisodesGlyph />
            </PlayerButton>,
          )}
          chapterList={
            scrubbing.chapters.length === 0
              ? undefined
              : chapterMenu(
                  <PlayerButton aria-label="Chapters">
                    <ListVideoIcon strokeWidth={1.75} aria-hidden />
                  </PlayerButton>,
                )
          }
          scrub={scrubProps}
          onPlayPause={togglePlay}
          onSeek={(seconds) => setScrub(seconds)}
          onSeekCommit={seekTo}
          onMuteChange={setMuted}
          onVolumeChange={followVolume}
          onVolumeCommit={commitVolume}
          onVolumeOpenChange={setVolumeOpen}
          onNext={nextAction ?? undefined}
          onFullscreen={toggleFullscreen}
        />
      ) : null}
    </>
  );

  const phoneControls = showChrome ? (
    <div
      className={cn(
        "transition-opacity duration-300",
        !controlsVisible && "pointer-events-none opacity-0",
      )}
    >
      <PhoneControls
        title={heading}
        playing={!media.paused}
        position={position}
        duration={duration}
        brightness={brightness}
        volume={canSetVolume ? (media.muted ? 0 : media.volume) : null}
        tracks={
          <>
            {tracks(
              <TrackPill
                icon="subtitles"
                label={subtitleOptions.find((option) => option.id === subtitleId)?.label ?? "Off"}
              />,
            )}
            {audioOptions.length === 0
              ? null
              : tracks(
                  <TrackPill
                    icon="audio"
                    label={audioOptions.find((option) => option.id === audioId)?.label ?? "Audio"}
                  />,
                )}
            {episodePicker(<TrackPill icon="episodes" label="Episodes" />)}
            {scrubbing.chapters.length === 0
              ? null
              : chapterMenu(
                  <TrackPill
                    icon="chapters"
                    label={currentChapter?.title ?? "Chapters"}
                    aria-label={`Chapters: ${currentChapter?.title ?? "none playing"}`}
                  />,
                )}
          </>
        }
        onClose={backToDetails}
        onPlayPause={togglePlay}
        onSkip={skip}
        onSeek={(seconds) => setScrub(seconds)}
        onSeekCommit={seekTo}
        scrub={scrubProps}
        onBrightness={setBrightness}
        onVolume={followVolume}
        onVolumeCommit={commitVolume}
      />
    </div>
  ) : null;

  return (
    <div
      ref={setFrame}
      data-testid="player"
      tabIndex={-1}
      className={cn(
        "fixed inset-0 flex flex-row bg-dark-bg text-text outline-none select-none",
        !controlsVisible && "cursor-none",
      )}
    >
      <div className="relative min-w-0 grow">
        <div className="absolute inset-0">{videoElement}</div>
        {layout === "desktop" ? desktopControls : phoneControls}
        {center}
        <SubtitleDelayNotice text={subtitleDelay.notice} />
        {showNext ? (
          <AutoplayNext
            next={nextEpisode}
            still={artworkUrl(nextEpisode.still, "card")}
            actions={{
              countdownMs: countdown ?? AUTOPLAY_COUNTDOWN.totalMs,
              onPlayNext: playNext,
              onWatchCredits: () => setCreditsDismissed(true),
            }}
          />
        ) : null}
      </div>
      {overlays === null ? null : (
        <>
          <LeaveDialog
            open={leaving !== null}
            container={overlays}
            returnFocus={focusAfterLeaving}
            onStay={stay}
            onLeave={backToDetails}
          />
          <CommandMenu
            open={menu}
            container={overlays}
            onOpenChange={(open) => {
              setMenu(open);

              if (!open) setMenuQuery("");
            }}
            onQueryChange={(text, page) => {
              if (page.id === "root") setMenuQuery(text);
            }}
            root={root}
          />
        </>
      )}
      <div ref={setOverlays} className="contents cursor-auto select-text" />
    </div>
  );
}
