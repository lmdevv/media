import { localOnly } from "@media/contracts/cast";
import { DRIFT_THRESHOLDS } from "@media/contracts/clock";
import type { FollowerPlayer } from "@media/contracts/follower";
import type { NegotiateResponse } from "@media/contracts/media-playback";
import { sessionSkip } from "@media/contracts/session-next";
import {
  SLEEP_FADE_MS,
  formatSleepTimeLeft,
  sleepHoldsAutoplay,
  sleepPausesPlayback,
  sleepTimerRuns,
} from "@media/contracts/sleep-timer";
import { Playback, Versions } from "@media/sdk/effect";
import { usePlatform, usePlatformQuery } from "@media/sdk/react";
import { ChapterPopover } from "@media/ui/components/chapter-popover";
import {
  EpisodesGlyph,
  PlayerButton,
  PlayerControls,
  TracksGlyph,
} from "@media/ui/components/player-controls";
import { TrackPopover } from "@media/ui/components/track-popover";
import type { TrackOption } from "@media/ui/components/track-popover";
import { fixedValue, useLiveValue } from "@media/ui/lib/live-value";
import type { LiveValue } from "@media/ui/lib/live-value";
import { unlessYielding } from "@media/ui/lib/focus-policy";
import { cn } from "@media/ui/lib/utils";
import { useHotkeys } from "@tanstack/react-hotkeys";
import { useNavigate } from "@tanstack/react-router";
import { Effect, Fiber, Stream } from "effect";
import {
  ArrowLeftIcon,
  CastIcon,
  InfoIcon,
  ListVideoIcon,
  MoonIcon,
  PictureInPicture2Icon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import type { CastItem } from "@/casting/cast-profile";
import { useAirPlay, useRemotePlayback } from "@/casting/system-targets";
import { useCast, useRemoteState } from "@/casting/use-cast";
import { MemberPlayerMenu } from "./member-player-menu";
import type { PlayerCommands, PlayerTogether } from "@/commands";
import { artworkUrl } from "@/lib/artwork";
import type { EpisodeId, MediaFileId, MediaVersion, PlaybackDetail, TitleId } from "@/lib/catalog";
import { loadQualityChoice, saveQualityChoice } from "@/lib/device-storage";
import { episodeCode } from "@/lib/format";
import { HOTKEYS } from "@/lib/hotkeys";
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
import { NO_PROGRESS } from "@/playback/media-progress";
import type { MediaProgress } from "@/playback/media-progress";
import { useMediaProgress, useMediaState, usePlayback } from "@/playback/use-playback";
import { withFacts } from "@/playback/use-version-choice";
import { nameOf, useMe, useScopes } from "@/session/session";
import { itemOf } from "@/together/session";
import { SessionPanel, memberRows } from "@/together/session-panel";
import {
  HostAway,
  SessionChip,
  SessionStopped,
  StartSessionDialog,
  SyncingToSession,
} from "@/together/session-states";
import { useSessionFollow, useSessionPlayer } from "@/together/use-session-player";

import { AUTOPLAY_COUNTDOWN } from "./autoplay";
import { AutoplayNext } from "./autoplay-next";
import { CastMenu, CastingState } from "./cast-menu";
import { EpisodePicker } from "./episode-picker";
import { LeaveDialog } from "./leave-dialog";
import { PhoneControls, PhoneSessionVideoChrome, TrackPill } from "./phone-player";
import {
  Buffering,
  PlaybackStopped,
  PreparingStream,
  PressPlay,
  ResumePrompt,
  SubtitleDelayNotice,
  TryingAnotherWay,
} from "./player-states";
import { CustomSleepTimerDialog, SleepTimerMenu, sleepTimerButtonLabel } from "./sleep-timer-menu";
import { StillWatchingDialog } from "./still-watching-dialog";
import { StreamInfo } from "./stream-info";
import { useControlsVisible, useFullscreen, usePlayerLayout } from "./use-player-frame";
import type { PlayerLayout } from "./use-player-frame";
import { useSeasonEpisodes } from "./use-season-episodes";
import { useSubtitleDelay } from "./use-subtitle-delay";
import { useSubtitlePlacement } from "./use-subtitle-placement";
import type { SleepTimerControl } from "./use-sleep-timer";
import type { StillWatchingControl } from "./use-still-watching";

const BUFFER_TARGET_SECONDS = 4;

const BUFFERING_GRACE_MS = 400;

const KEY_PREVIEW_MS = 1_200;

const VOLUME_STEP = 0.1;

/** Where unmuting a TV from silence goes when nothing was settled on there yet. */
const CAST_UNMUTE_LEVEL = 0.5;

const volumeLevel = (value: number): number =>
  Math.round(Math.min(1, Math.max(0, value)) * 100) / 100;

const OFF = "off";

const TRACKS_LABEL = "Audio, subtitles, and quality";

const NO_VERSIONS: ReadonlyArray<MediaVersion> = [];

const STARTING = PlaybackPhase.Starting();

const creditsSeconds = (duration: number): number => Math.min(30, duration * 0.1);

/** What the player was asked to play. */
export interface PlayerScreenProps {
  readonly titleId: TitleId;
  readonly episodeId: EpisodeId | undefined;
  /** The version to play; the one the server picks for this browser when undefined. */
  readonly version: MediaFileId | undefined;
  /** `0` starts at the beginning; `resume` resumes without asking. */
  readonly start: "0" | "resume" | undefined;
  readonly guest?: {
    readonly detail: PlaybackDetail;
    readonly onBack: () => void;
  };
  /** The page's sleep timer, which outlives this episode's player. */
  readonly sleepTimer: SleepTimerControl;
  /** The page's count of autoplay's jumps since the viewer's last input, kept across players. */
  readonly stillWatching: StillWatchingControl;
}

const startChoice = (start: PlayerScreenProps["start"]): StartChoice => {
  if (start === "0") return StartChoice.Beginning();

  return start === "resume" ? StartChoice.Resume() : StartChoice.Ask();
};

const useSettled = (value: boolean, ms: number): boolean => {
  const [settled, setSettled] = useState(false);

  if (!value && settled) setSettled(false);

  useEffect(() => {
    if (!value) return undefined;

    const timer = setTimeout(() => setSettled(true), ms);

    return () => clearTimeout(timer);
  }, [value, ms]);

  return value && settled;
};

/** The buffering state, filling as the buffer ahead grows. */
function BufferingAhead({ bufferedAhead }: { readonly bufferedAhead: LiveValue<number> }) {
  const fraction = useLiveValue(bufferedAhead, (seconds) => seconds / BUFFER_TARGET_SECONDS);

  return <Buffering fraction={fraction} />;
}

/** Syncing to the session, filling as the buffer ahead grows once the stream plays. */
function SyncingAhead({
  bufferedAhead,
  playing,
  ...props
}: Omit<React.ComponentProps<typeof SyncingToSession>, "progress"> & {
  readonly bufferedAhead: LiveValue<number>;
  readonly playing: boolean;
}) {
  const progress = useLiveValue(bufferedAhead, (seconds) =>
    playing ? Math.min(1, seconds / BUFFER_TARGET_SECONDS) : 0.2,
  );

  return <SyncingToSession {...props} progress={progress} />;
}

/** The player screen. */
export function PlayerScreen({
  titleId,
  episodeId,
  version,
  start,
  guest,
  sleepTimer,
  stillWatching,
}: PlayerScreenProps) {
  const platform = usePlatform();
  const me = useMe();
  const scopes = useScopes();
  const navigate = useNavigate();
  const layout = usePlayerLayout();
  const [frame, setFrame] = useState<HTMLDivElement | null>(null);
  const [overlays, setOverlays] = useState<HTMLDivElement | null>(null);
  const [video, setVideo] = useState<HTMLVideoElement | null>(null);
  const [controlsTop, setControlsTop] = useState<HTMLDivElement | null>(null);

  const title = usePlatformQuery(
    platform.movies.titles.get,
    ...(guest === undefined ? [{ titleId }] : (["skip"] as const)),
  );

  const detail = guest?.detail ?? (title.status === "success" ? title.data : null);

  const [menu, setMenu] = useState(false);
  const [info, setInfo] = useState(false);
  const [episodesOpenIn, setEpisodesOpenIn] = useState<PlayerLayout | null>(null);
  const [volumeOpen, setVolumeOpen] = useState(false);
  const [customSleepOpen, setCustomSleepOpen] = useState(false);

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
    ...(guest !== undefined
      ? (["skip"] as const)
      : [episodeId === undefined ? { titleId } : { titleId, episodeId }]),
  );

  const versions =
    guest?.detail.versions ?? (versionList.status === "success" ? versionList.data : NO_VERSIONS);

  const versionFacts = useMemo(() => withFacts(versions), [versions]);

  const settings = usePlatformQuery(
    platform.core.settings.get,
    ...(guest === undefined ? [] : (["skip"] as const)),
  );

  const deviceQuality =
    settings.status === "success" ? (settings.data.device?.streamQuality ?? null) : null;

  // The person's Autoplay setting; on while it loads, or when it fails to.
  const autoplay = settings.status === "success" ? settings.data.user.autoplay : true;

  const watching = useMemo(() => ({ titleId, episodeId: episodeId ?? null }), [titleId, episodeId]);
  const playerNow = useRef<FollowerPlayer | null>(null);
  const together = useSessionPlayer(watching, playerNow);
  const inSession = together.session !== null;
  const sessionStart = together.startAt;

  const buildRequest = (): PlaybackRequest => ({
    titleId,
    episodeId: episodeId ?? null,
    fileId: inSession ? null : (version ?? null),
    start: inSession
      ? StartChoice.At({
          positionMs: () => sessionStart().positionMs,
          play: () => sessionStart().play,
        })
      : startChoice(start),
    quality: deviceQuality === null ? loadQualityChoice() : qualityOfSetting(deviceQuality),
  });

  // Household playback takes the person's saved quality, so it waits for the settings to
  // answer once; settings that fail to load fall back to this browser's choice, and a later reload
  // of them never stops playback.
  const [settled, setSettled] = useState(false);

  if (!settled && (guest !== undefined || settings.status !== "loading")) setSettled(true);

  const handle = usePlayback(
    video,
    settled && together.mode !== "loading" ? buildRequest : null,
    `${titleId}:${episodeId ?? ""}`,
  );

  const controller = handle?.controller ?? null;
  const snapshot = handle?.snapshot ?? null;
  const phase = snapshot?.phase ?? STARTING;
  const isPlaying = PlaybackPhase.$is("Playing")(phase);
  const player = controller?.player ?? null;
  const output = controller?.output ?? null;

  useEffect(() => {
    playerNow.current = output;
  }, [output]);
  const localMedia = useMediaState(video, player);
  const localProgress = useMediaProgress(video, player);
  const stream = snapshot?.stream ?? null;
  const started = snapshot?.started ?? null;
  const coreStart = snapshot?.coreStart ?? null;
  const episode = coreStart?.episode ?? null;
  const titleName = detail?.name ?? "";
  const artworkKey = episode?.still ?? detail?.artwork.poster ?? null;
  const pip = usePictureInPicture(video);

  const castItem = useMemo(
    (): CastItem | null =>
      started === null
        ? null
        : {
            title: episode?.name ?? titleName,
            episode:
              episode === null
                ? null
                : {
                    seriesTitle: titleName,
                    season: episode.seasonNumber,
                    episode: episode.episodeNumber,
                  },
            imageUrl: artworkUrl(artworkKey, "poster") ?? null,
          },
    [started, episode, titleName, artworkKey],
  );

  const chromecast = useCast(controller, isPlaying, castItem, guest === undefined);
  const casting = chromecast.playback;
  const remote = useRemoteState(casting);
  const airplay = useAirPlay(guest === undefined ? video : null);
  const remotePlayback = useRemotePlayback(guest === undefined ? video : null);

  const media = remote === null ? localMedia : { ...localMedia, ...remote };

  const progress = useMemo(
    (): MediaProgress =>
      casting === null
        ? localProgress
        : { position: casting.player.position, bufferedAhead: NO_PROGRESS.bufferedAhead },
    [casting, localProgress],
  );

  const duration = stream?.durationSeconds ?? (started?.file.probe.durationMs ?? 0) / 1000;

  const position = useMemo(
    () => (scrub === null ? progress.position : fixedValue(scrub)),
    [scrub, progress.position],
  );

  const heading =
    episode === null ? titleName : `${titleName} ${episodeCode(episode)} ${episode.name}`;

  const next = usePlatformQuery(
    platform.movies.titles.nextEpisode,
    ...(episode === null || guest !== undefined
      ? (["skip"] as const)
      : ([{ episodeId: episode.id }] as const)),
  );

  const nextEpisode = next.status === "success" ? next.data : null;

  const follow = useSessionFollow(together, {
    player: isPlaying ? output : null,
    durationMs: duration > 0 ? duration * 1000 : null,
    nextEpisode,
  });

  const sessionMove = follow.move;

  const backToDetails = useCallback(() => {
    if (guest !== undefined) {
      guest.onBack();

      return;
    }

    void navigate({ to: "/title/$titleId", params: { titleId } });
  }, [navigate, titleId, guest]);

  const { toggle: toggleFullscreen, takeEscape } = useFullscreen(frame, video);

  const seekTo = useCallback(
    (seconds: number) => {
      if (output === null) return;

      const positionMs = Math.max(0, Math.min(duration, seconds)) * 1000;

      setScrub(null);

      if (inSession) sessionMove({ kind: "seek", positionMs });
      else output.seek(positionMs);
    },
    [output, duration, inSession, sessionMove],
  );

  const skip = useCallback(
    (by: number) => {
      if (output !== null) seekTo(output.positionMs() / 1000 + by);
    },
    [output, seekTo],
  );

  const scrubbing = useScrubbing(started);
  const preloadThumbnails = scrubbing.preload;
  const keyPreviewTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const skipByKey = useCallback(
    (by: number) => {
      if (output === null) return;
      const target = Math.max(0, Math.min(duration, output.positionMs() / 1000 + by));

      seekTo(target);
      preloadThumbnails();
      setKeyPreview(target);
      clearTimeout(keyPreviewTimer.current);
      keyPreviewTimer.current = setTimeout(() => setKeyPreview(null), KEY_PREVIEW_MS);
    },
    [output, duration, seekTo, preloadThumbnails],
  );

  useEffect(() => () => clearTimeout(keyPreviewTimer.current), []);

  const currentChapter = useLiveValue(progress.position, (seconds) =>
    chapterAt(scrubbing.chapters, seconds),
  );

  // A TV never needs a gesture.
  const needsGesture = snapshot?.needsGesture === true && casting === null;

  const play = useCallback(() => {
    if (output === null) return;

    if (needsGesture) controller?.resumeWithGesture();
    else if (inSession) sessionMove({ kind: "play" });
    else void output.play().catch(() => undefined);
  }, [output, needsGesture, controller, inSession, sessionMove]);

  const togglePlay = useCallback(() => {
    if (output === null) return;

    if (needsGesture || output.isPaused()) play();
    else if (inSession) sessionMove({ kind: "pause" });
    else output.pause();
  }, [output, needsGesture, play, inSession, sessionMove]);

  // Silence mutes and any other level unmutes, here and on a TV alike, so the mute button and the
  // slider always agree.
  const setVolume = useCallback(
    (value: number) => {
      const level = volumeLevel(value);

      if (casting !== null) {
        casting.player.setVolume(level);

        return;
      }

      if (video === null) return;

      video.volume = level;
      video.muted = level === 0;
    },
    [video, casting],
  );

  // The last level the viewer settled on above silence, here and on each cast, which unmuting from
  // silence there returns to. A drag's passing levels do not count.
  const audibleHere = useRef<number | null>(null);
  const audibleCast = useRef(new WeakMap<object, number>());
  const levelNow = media.volume;

  const remember = useCallback(
    (level: number) => {
      if (casting === null) audibleHere.current = level;
      else audibleCast.current.set(casting, level);
    },
    [casting],
  );

  const remembered = useCallback(
    (): number | null =>
      casting === null ? audibleHere.current : (audibleCast.current.get(casting) ?? null),
    [casting],
  );

  // A change starts from the level now: here only before the first change, since a drag moves it
  // as it goes; on a TV every time, since its remote can change it meanwhile.
  const rememberStart = useCallback(() => {
    if (levelNow > 0 && (casting !== null || audibleHere.current === null)) remember(levelNow);
  }, [levelNow, casting, remember]);

  const commitVolume = useCallback(
    (value: number) => {
      const level = volumeLevel(value);

      rememberStart();

      if (level > 0) remember(level);
      setVolume(level);
    },
    [rememberStart, remember, setVolume],
  );

  // The slider follows the pointer here at once; a TV hears only where it settles.
  const followVolume = useCallback(
    (value: number) => {
      rememberStart();

      if (casting === null) setVolume(value);
    },
    [rememberStart, casting, setVolume],
  );

  const volumeSettable = casting === null ? canSetVolume : (remote?.volumeSettable ?? false);
  const silent = volumeSettable && media.volume === 0;

  const setMuted = useCallback(
    (muted: boolean) => {
      if (!muted && silent) {
        setVolume(remembered() ?? (casting === null ? 1 : CAST_UNMUTE_LEVEL));
      } else if (casting !== null) casting.player.setMuted(muted);
      else if (video !== null) video.muted = muted;
    },
    [video, casting, silent, remembered, setVolume],
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
      versionFacts.length < 2 || inSession || casting !== null
        ? []
        : versionFacts.map(({ version: candidate, facts }) => ({
            id: candidate.id,
            label: Versions.label(facts),
            detail: Versions.detail(facts),
          })),
    [versionFacts, inSession, casting],
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

    if (guest !== undefined) return;

    void navigate({
      to: "/watch/$titleId",
      params: { titleId },
      search: (previous) => ({ ...previous, version: pick.id }),
      replace: true,
    });
  }, [coreStart, stream, navigate, titleId, guest]);

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

  const shownSubtitle = casting === null ? subtitleId : OFF;

  // A new stream's subtitles arrive as new tracks, which take the shown subtitle as they are added.
  useEffect(() => {
    if (video === null) return undefined;

    const tracks = video.textTracks;

    const show = (): void => {
      for (const track of Array.from(tracks)) {
        track.mode = track.id === shownSubtitle ? "showing" : "disabled";
      }
    };

    show();
    tracks.addEventListener("addtrack", show);

    return () => tracks.removeEventListener("addtrack", show);
  }, [video, shownSubtitle]);

  const subtitleDelay = useSubtitleDelay({
    controller,
    stream,
    subtitleId: snapshot?.subtitleId ?? null,
    delayMs: snapshot?.subtitleDelayMs ?? 0,
    casting: casting !== null,
    otherScreen: airplay?.active === true || remotePlayback?.active === true,
    keycaps: layout === "desktop",
  });

  const askToLeave = useCallback(() => {
    const pause = !inSession && output !== null && !output.isPaused();

    if (pause) output.pause();
    focusBeforeLeaving.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setLeaving({ resume: pause });
  }, [output, inSession]);

  const stay = useCallback(() => {
    if (leaving?.resume === true) play();
    setLeaving(null);
  }, [leaving, play]);

  // After a keyboard open, back to where focus was in the player, or to the player itself. The
  // dialog would move focus from the frame, which only script can focus, to its first button, so
  // the frame is focused here. After a pointer open the dialog never calls this.
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

  const creditsReached = useLiveValue(
    progress.position,
    (seconds) => duration - seconds <= creditsSeconds(duration),
  );

  const inCredits =
    isPlaying &&
    leaving === null &&
    (!media.paused || media.ended) &&
    duration > 0 &&
    (media.ended || creditsReached);

  const sleepKey = `${titleId}:${episodeId ?? ""}`;
  const { report: reportToSleepTimer, cancel: cancelSleepTimer } = sleepTimer;
  const playingForSleep = isPlaying && !media.paused;
  const playbackPosition = progress.position;

  // Reports from the position without re-rendering the screen: once a second while the end is
  // further off than the fade, then on every move so the fade starts on time. A change of
  // playing runs the effect again, which reports at once.
  useEffect(() => {
    if (!isPlaying) return undefined;

    let reported: { readonly seconds: number | null } | null = null;

    const report = (): void => {
      const leftMs = duration > 0 ? Math.max(0, duration - playbackPosition.get()) * 1000 : null;
      const seconds = leftMs === null ? null : Math.ceil(leftMs / 1000);
      const nearFade = leftMs !== null && leftMs <= SLEEP_FADE_MS + 1000;

      if (!nearFade && reported !== null && reported.seconds === seconds) return;

      reported = { seconds };
      reportToSleepTimer({ itemKey: sleepKey, leftMs, playing: playingForSleep });
    };

    report();

    return playbackPosition.subscribe(report);
  }, [reportToSleepTimer, isPlaying, sleepKey, duration, playbackPosition, playingForSleep]);

  // A group session plays for everyone, so a timer on one device has no place in it.
  useEffect(() => {
    if (inSession) cancelSleepTimer();
  }, [inSession, cancelSleepTimer]);

  const sleepPauses = sleepPausesPlayback(sleepTimer.timer);
  const sleepFade = sleepTimer.volume;
  const levelBeforeFade = useRef<number | null>(null);
  const asking = stillWatching.watching.state === "asking";

  // Pauses as the timer runs out, before the effect below puts the volume back, and pauses the
  // next episode too if the timer ran out while it loaded. Asking whether anyone is still watching
  // pauses too.
  useEffect(() => {
    if ((sleepPauses || asking) && playingForSleep) output?.pause();
  }, [sleepPauses, asking, playingForSleep, output]);

  // The fade scales the level the viewer set and puts it back after; a TV keeps its own level.
  useEffect(() => {
    if (video === null) return;

    if (sleepFade < 1 && casting === null) {
      levelBeforeFade.current ??= video.volume;
      video.volume = levelBeforeFade.current * sleepFade;
    } else if (levelBeforeFade.current !== null) {
      video.volume = levelBeforeFade.current;
      levelBeforeFade.current = null;
    }
  }, [video, sleepFade, casting]);

  const showNext =
    inCredits &&
    nextEpisode !== null &&
    !creditsDismissed &&
    !inSession &&
    !asking &&
    !sleepHoldsAutoplay(sleepTimer.timer, sleepKey);

  const sessionPlayNow = together.actions.playNow;
  const sessionPlayQueued = together.actions.playQueued;
  const picksForSession = inSession && together.mayControl && together.mayAdd;

  const playEpisode = useCallback(
    (id: EpisodeId) => {
      if (inSession) {
        sessionPlayNow(itemOf({ titleId, episodeId: id }));

        return;
      }

      void navigate({
        to: "/watch/$titleId",
        params: { titleId },
        search: { episodeId: id, start: "resume" },
      });
    },
    [navigate, titleId, inSession, sessionPlayNow],
  );

  const playNext = useCallback(() => {
    if (nextEpisode !== null) playEpisode(nextEpisode.id);
  }, [nextEpisode, playEpisode]);

  const nextSkip = sessionSkip({
    mayControl: together.mayControl,
    mayAdd: together.mayAdd,
    queued: follow.queue.length > 0,
    nextPlayable: nextEpisode?.available === true,
  });

  const sessionNextAction =
    nextSkip === null ? null : { queued: sessionPlayQueued, episode: playNext }[nextSkip];

  const nextAction = inSession ? sessionNextAction : nextEpisode === null ? null : playNext;

  const seasonEpisodes = useSeasonEpisodes(
    coreStart?.titleId ?? titleId,
    guest === undefined ? (episode?.seasonNumber ?? null) : null,
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
  const seasons = detail !== null && "seasons" in detail ? detail.seasons : null;

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

  const canPick = picking !== null && (!inSession || picksForSession);

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
          position: progress.position,
          paused: media.paused,
          play: () => {
            if (output?.isPaused() === true) togglePlay();
          },
          pause: () => {
            if (output?.isPaused() === false) togglePlay();
          },
          seekTo,
          previous: previousEpisode === null || inSession ? null : playPrevious,
          next: nextAction,
        },
  );

  const { countdownEnded } = stillWatching;
  const countingDown = showNext && autoplay;

  if (!countingDown && countdown !== null) setCountdown(null);

  // Only the countdown's end is autoplay's jump; the card's Play next is the viewer's own input.
  useEffect(() => {
    if (!countingDown) return undefined;

    const fiber = Effect.runFork(
      Stream.runForEach(
        Playback.autoplayCountdown(AUTOPLAY_COUNTDOWN.totalMs, AUTOPLAY_COUNTDOWN.stepMs),
        (left) => Effect.sync(() => setCountdown(left)),
      ).pipe(
        Effect.andThen(
          Effect.sync(() => {
            if (countdownEnded()) playNext();
          }),
        ),
      ),
    );

    return () => {
      Effect.runFork(Fiber.interrupt(fiber));
    };
  }, [countingDown, playNext, countdownEnded]);

  const stalled = useSettled(isPlaying && media.buffering, BUFFERING_GRACE_MS);

  const session = together.session;
  const followState = follow.following.state;
  const [panel, setPanel] = useState(true);
  const [closedCard, setClosedCard] = useState<EpisodeId | null>(null);
  const shownCard = follow.nextCard;

  const sessionCard =
    leaving === null && shownCard !== null && shownCard.episode.id !== closedCard
      ? shownCard
      : null;

  const syncing =
    session !== null &&
    (followState === null ||
      followState.offset === null ||
      followState.follow === "blocked" ||
      (session.clock.status === "playing" &&
        (followState.follow === "buffering" ||
          followState.driftMs === null ||
          Math.abs(followState.driftMs) >= DRIFT_THRESHOLDS.seekMs)));

  const selfId = me?.userId ?? null;

  const rows = useMemo(
    () =>
      session === null
        ? []
        : memberRows(session.members, selfId, syncing, followState?.driftMs ?? null),
    [session, selfId, syncing, followState?.driftMs],
  );

  const sessionPaused =
    session !== null && (session.clock.status !== "playing" || together.hostAway);

  const streamInfoAvailable = layout === "desktop" && stream !== null && started !== null;
  const infoShown = info && streamInfoAvailable;

  const hold =
    !isPlaying ||
    media.paused ||
    infoShown ||
    menu ||
    episodesShown ||
    (volumeOpen && volumeSettable) ||
    customSleepOpen ||
    leaving !== null ||
    showNext ||
    sessionCard !== null ||
    together.starting !== undefined ||
    scrub !== null;

  const controlsVisible = useControlsVisible(frame, hold);

  useSubtitlePlacement({
    video,
    controls: controlsTop,
    raised:
      controlsVisible &&
      casting === null &&
      pip?.active !== true &&
      airplay?.active !== true &&
      remotePlayback?.active !== true,
  });

  useHotkeys([
    {
      hotkey: HOTKEYS["command-menu.toggle"],
      callback: (event) => {
        event.preventDefault();

        if (guest !== undefined) return;

        if (menu) setMenu(false);
        else if (
          leaving === null &&
          !asking &&
          together.starting === undefined &&
          !customSleepOpen
        ) {
          setMenu(true);
        }
      },
    },
    { hotkey: HOTKEYS["player.toggle"], callback: unlessYielding(togglePlay) },
    { hotkey: HOTKEYS["player.toggle-k"], callback: unlessYielding(togglePlay) },
    { hotkey: HOTKEYS["player.back-10"], callback: unlessYielding(() => skipByKey(-10)) },
    { hotkey: HOTKEYS["player.forward-10"], callback: unlessYielding(() => skipByKey(10)) },
    { hotkey: HOTKEYS["player.back-5"], callback: unlessYielding(() => skipByKey(-5)) },
    { hotkey: HOTKEYS["player.forward-5"], callback: unlessYielding(() => skipByKey(5)) },
    {
      hotkey: HOTKEYS["player.volume-up"],
      callback: unlessYielding(() => {
        if (volumeSettable) commitVolume(media.volume + VOLUME_STEP);
        else if (media.muted) setMuted(false);
      }),
    },
    {
      hotkey: HOTKEYS["player.volume-down"],
      callback: unlessYielding(() => {
        if (volumeSettable) commitVolume(media.volume - VOLUME_STEP);
      }),
    },
    { hotkey: HOTKEYS["player.fullscreen"], callback: unlessYielding(toggleFullscreen) },
    {
      hotkey: HOTKEYS["player.mute"],
      callback: unlessYielding(() => setMuted(!(media.muted || silent))),
    },
    { hotkey: HOTKEYS["player.subtitles"], callback: unlessYielding(toggleSubtitles) },
    {
      hotkey: HOTKEYS["player.subtitles-earlier"],
      callback: unlessYielding(() => subtitleDelay.stepWithNotice(-1)),
    },
    {
      hotkey: HOTKEYS["player.subtitles-later"],
      callback: unlessYielding(() => subtitleDelay.stepWithNotice(1)),
    },
    {
      hotkey: HOTKEYS["player.exit"],
      callback: unlessYielding((event) => {
        if (takeEscape(event)) return;

        if (infoShown) setInfo(false);
        else askToLeave();
      }),
    },
  ]);

  const canStart =
    guest === undefined &&
    isPlaying &&
    started !== null &&
    together.mode === "solo" &&
    !together.elsewhere;

  const startSession = together.actions.start;
  const copySessionLink = together.actions.copyLink;
  const leaveSession = together.actions.leave;

  const playerTogether = useMemo(
    (): PlayerTogether => ({
      start: canStart ? startSession : null,
      copyLink: inSession ? copySessionLink : null,
      leave: inSession ? leaveSession : null,
      hosting: together.hosting,
    }),
    [canStart, startSession, inSession, copySessionLink, leaveSession, together.hosting],
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
      together: playerTogether,
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
      playerTogether,
    ],
  );

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
    picking === null || !canPick ? null : (
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

  const castTargets = {
    chromecast: chromecast.available
      ? {
          connecting: chromecast.connecting,
          starting: chromecast.starting,
          deviceName: casting?.deviceName ?? null,
          unreachable: started !== null && localOnly(started.mediaBaseUrl),
          onConnect: chromecast.connect,
          onDisconnect: chromecast.disconnect,
        }
      : null,
    airplay:
      airplay === null || !airplay.available
        ? null
        : { active: airplay.active, onChoose: airplay.choose },
    otherDevices:
      chromecast.available ||
      airplay !== null ||
      remotePlayback === null ||
      !remotePlayback.available
        ? null
        : { active: remotePlayback.active, onChoose: remotePlayback.choose },
  };

  const canCast =
    castTargets.chromecast !== null ||
    castTargets.airplay !== null ||
    castTargets.otherDevices !== null;

  const castMenu = (trigger: React.ReactElement) => (
    <CastMenu trigger={trigger} container={overlayContainer} {...castTargets} />
  );

  const showSleepTimer = isPlaying && !inSession;
  const sleepTimeLeft = sleepTimer.leftMs === null ? null : formatSleepTimeLeft(sleepTimer.leftMs);

  const sleepMenu = (trigger: React.ReactElement) => (
    <SleepTimerMenu
      trigger={trigger}
      container={overlayContainer}
      timeLeft={sleepTimeLeft}
      itemKey={episodeId === undefined ? null : sleepKey}
      onChoose={sleepTimer.set}
      onCustom={() => setCustomSleepOpen(true)}
      onCancel={sleepTimerRuns(sleepTimer.timer) ? cancelSleepTimer : null}
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
      const shown = PlaybackStop.$match(stopped, {
        Missing: () => ({
          missing: true,
          title: "We can't find this file",
          description: "The video file was moved, renamed, or its drive is offline.",
          secondary:
            scopes.has("movies:edit") && detail !== null && "libraryId" in detail
              ? {
                  label: "Show missing files",
                  onClick: () =>
                    void navigate({
                      to: "/admin/libraries/$libraryId",
                      params: { libraryId: detail.libraryId },
                    }),
                }
              : undefined,
        }),
        Unsupported: () => ({
          missing: false,
          title: "This can't play here",
          description: "This device can't play the file in any way the server offers.",
          secondary: undefined,
        }),
        Failed: ({ message }) => ({
          missing: false,
          title: "Playback stopped",
          description: message,
          secondary: { label: "Try again", onClick: () => controller?.retry() },
        }),
      });

      return (
        <PlaybackStopped
          missing={shown.missing}
          title={shown.title}
          description={shown.description}
          onBack={backToDetails}
          secondary={shown.secondary}
        />
      );
    }

    if (PlaybackPhase.$is("Choosing")(phase)) {
      return (
        <ResumePrompt
          titleLabel={heading}
          personName={me === null ? "" : nameOf(me)}
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

    if (together.stopped !== null) {
      return (
        <SessionStopped
          title={
            together.stopped.kind === "ended"
              ? `${together.hostName} ended the session`
              : "You're no longer in this session"
          }
          onKeepWatching={together.actions.goSolo}
          onBack={backToDetails}
        />
      );
    }

    if (session !== null && !together.hosting && together.hostAway) {
      return (
        <HostAway
          hostName={together.hostName}
          positionMs={together.positionNow()}
          onKeepWatching={together.actions.goSolo}
          onLeave={() => {
            together.actions.leave();
            backToDetails();
          }}
        />
      );
    }

    if (session !== null && !together.hosting && (!isPlaying || syncing)) {
      const blocked = followState?.follow === "blocked" || snapshot?.needsGesture === true;

      return (
        <SyncingAhead
          hostName={together.hostName}
          targetMs={together.positionNow()}
          bufferedAhead={progress.bufferedAhead}
          playing={isPlaying}
          onJoin={blocked ? () => controller?.resumeWithGesture() : undefined}
        />
      );
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

    if (needsGesture) {
      return <PressPlay onPlay={() => controller?.resumeWithGesture()} />;
    }

    if (stalled) {
      return <BufferingAhead bufferedAhead={progress.bufferedAhead} />;
    }

    return null;
  })();

  const showChrome = isPlaying && center === null && !showNext && sessionCard === null;
  const portraitSession = layout === "phone-portrait" && session !== null;
  const sidePanel = layout === "desktop" && session !== null && panel;

  const locked =
    session !== null && !together.mayControl
      ? `Only ${together.hostName} can pause or seek`
      : undefined;

  const onRoom =
    session !== null
      ? () => setPanel((open) => !open)
      : canStart
        ? together.actions.start
        : undefined;

  const videoElement = (
    <video
      ref={setVideo}
      data-testid="player-video"
      crossOrigin="anonymous"
      playsInline
      x-webkit-airplay={guest === undefined ? "allow" : "deny"}
      disableRemotePlayback={guest !== undefined}
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
          {session === null ? null : (
            <SessionChip paused={sessionPaused} watching={session.members.length} />
          )}
        </div>
        <div className="flex items-center gap-6">
          {showSleepTimer
            ? sleepMenu(
                <PlayerButton
                  aria-label={sleepTimerButtonLabel(sleepTimeLeft)}
                  active={sleepTimerRuns(sleepTimer.timer)}
                >
                  <MoonIcon strokeWidth={1.75} aria-hidden />
                  {sleepTimeLeft === null ? null : (
                    <span className="relative font-sans text-label/label font-semibold tabular-nums">
                      {sleepTimeLeft}
                    </span>
                  )}
                </PlayerButton>,
              )
            : null}
          {isPlaying && pip !== null && casting === null ? (
            <PlayerButton
              aria-label="Picture in picture"
              aria-pressed={pip.active}
              active={pip.active}
              onClick={pip.toggle}
            >
              <PictureInPicture2Icon strokeWidth={1.75} aria-hidden />
            </PlayerButton>
          ) : null}
          {isPlaying && canCast
            ? castMenu(
                <PlayerButton aria-label="Cast" active={casting !== null}>
                  <CastIcon strokeWidth={1.75} aria-hidden />
                </PlayerButton>,
              )
            : null}
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
          bufferedAhead={progress.bufferedAhead}
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
          volume={volumeSettable ? media.volume : null}
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
          locked={locked}
          roomActive={sidePanel}
          onRoom={onRoom}
          onPlayPause={togglePlay}
          onSeek={(seconds) => setScrub(seconds)}
          onSeekCommit={seekTo}
          onMuteChange={setMuted}
          onVolumeChange={followVolume}
          onVolumeCommit={commitVolume}
          onVolumeOpenChange={setVolumeOpen}
          onNext={nextAction ?? undefined}
          onFullscreen={toggleFullscreen}
          topRowRef={setControlsTop}
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
        volume={volumeSettable ? (media.muted ? 0 : media.volume) : null}
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
        locked={locked}
        onRoom={session === null ? onRoom : undefined}
        castMenu={canCast ? castMenu : undefined}
        sleepTimer={showSleepTimer ? { menu: sleepMenu, timeLeft: sleepTimeLeft } : undefined}
        bottomBarRef={setControlsTop}
      />
    </div>
  ) : null;

  return (
    <div
      ref={setFrame}
      data-testid="player"
      tabIndex={-1}
      className={cn(
        "fixed inset-0 flex bg-dark-bg text-text outline-none select-none",
        portraitSession ? "flex-col" : "flex-row",
        !controlsVisible && "cursor-none",
      )}
    >
      <div
        className={cn(
          "relative",
          portraitSession
            ? "mt-[env(safe-area-inset-top)] aspect-video w-full shrink-0"
            : "min-w-0 grow",
        )}
      >
        <div className="absolute inset-0">
          {videoElement}
          {casting === null ? null : <CastingState deviceName={casting.deviceName} />}
        </div>
        {portraitSession ? (
          <PhoneSessionVideoChrome
            label={together.mayControl ? null : `${together.hostName} is hosting`}
            playing={!media.paused}
            position={position}
            duration={duration}
            onPlayPause={together.mayControl ? togglePlay : null}
            onFullscreen={toggleFullscreen}
          />
        ) : layout === "desktop" ? (
          desktopControls
        ) : (
          phoneControls
        )}
        {center}
        <SubtitleDelayNotice text={subtitleDelay.notice} />
        {showNext ? (
          <AutoplayNext
            next={nextEpisode}
            still={artworkUrl(nextEpisode.still, "card")}
            actions={{
              kind: "advance",
              countdownMs: autoplay ? (countdown ?? AUTOPLAY_COUNTDOWN.totalMs) : null,
              onPlayNext: playNext,
              onWatchCredits: () => setCreditsDismissed(true),
            }}
          />
        ) : null}
        {sessionCard === null ? null : (
          <AutoplayNext
            next={sessionCard.episode}
            still={artworkUrl(sessionCard.episode.still, "card")}
            actions={
              sessionCard.canWatchCredits
                ? {
                    kind: "advance",
                    countdownMs: sessionCard.countdownMs,
                    onPlayNext: sessionPlayQueued,
                    onWatchCredits: follow.watchCredits,
                  }
                : {
                    kind: "follow",
                    countdownMs: sessionCard.countdownMs,
                    onPlayNext: sessionCard.canPlayNow ? sessionPlayQueued : null,
                    onClose: () => setClosedCard(sessionCard.episode.id),
                  }
            }
          />
        )}
      </div>
      {session === null || (!sidePanel && !portraitSession) ? null : (
        <SessionPanel
          session={session}
          rows={rows}
          paused={sessionPaused}
          queue={follow.queue}
          actions={together.actions}
          className={
            portraitSession
              ? "min-h-0 w-full grow pb-[max(env(safe-area-inset-bottom),var(--spacing-7))]"
              : "h-full w-95 shrink-0 border-l border-hairline"
          }
        />
      )}
      {overlays === null ? null : (
        <>
          <StartSessionDialog
            open={together.starting !== undefined}
            link={together.starting ?? null}
            container={overlays}
            onCopy={together.actions.copyLink}
            onCancel={together.actions.cancelStart}
            onStart={together.actions.confirmStart}
          />
          <CustomSleepTimerDialog
            open={customSleepOpen && showSleepTimer}
            container={overlays}
            onOpenChange={setCustomSleepOpen}
            onStart={(minutes) => sleepTimer.set({ kind: "after", minutes })}
          />
          <LeaveDialog
            open={leaving !== null}
            container={overlays}
            returnFocus={focusAfterLeaving}
            onStay={stay}
            onLeave={backToDetails}
          />
          <StillWatchingDialog
            open={asking}
            container={overlays}
            onContinue={() => {
              stillWatching.continueWatching();
              playNext();
            }}
            onDone={stillWatching.done}
          />
          {guest === undefined ? (
            <MemberPlayerMenu
              context={{ navigate, query: menuQuery, scopes, player: commands }}
              open={menu}
              container={overlays}
              onOpenChange={(open) => {
                setMenu(open);

                if (!open) setMenuQuery("");
              }}
              onQueryChange={(text, page) => {
                if (page.id === "root") setMenuQuery(text);
              }}
            />
          ) : null}
        </>
      )}
      <div ref={setOverlays} className="contents cursor-auto select-text" />
    </div>
  );
}
