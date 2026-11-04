import { targetPosition } from "@media/contracts/clock";
import { DRIFT_THRESHOLDS } from "@media/contracts/clock";
import type { EpisodeId, MediaFileId, RoomId, TitleId } from "@media/contracts/ids";
import type { NegotiateResponse } from "@media/contracts/media-playback";
import type { MediaVersion } from "@media/contracts/models/catalog";
import { EpochMillis, Milliseconds } from "@media/contracts/units";
import { Playback, Versions } from "@media/sdk/effect";
import {
  useCommand,
  useCommandQuery,
  useMoviesRuntime,
  useRoomPresence,
  useRoomSync,
} from "@media/sdk/react";
import { ChapterPopover } from "@media/ui/components/chapter-popover";
import { CommandMenu } from "@media/ui/components/command-menu";
import {
  EpisodesGlyph,
  PlayerButton,
  PlayerControls,
  TracksGlyph,
} from "@media/ui/components/player-controls";
import { RoomPanel } from "@media/ui/components/room-panel";
import { TrackPopover } from "@media/ui/components/track-popover";
import type { TrackOption } from "@media/ui/components/track-popover";
import { useKeymap } from "@media/ui/lib/use-keymap";
import { cn } from "@media/ui/lib/utils";
import { useNavigate } from "@tanstack/react-router";
import { Effect, Fiber, Result, Stream } from "effect";
import {
  ArrowLeftIcon,
  CastIcon,
  InfoIcon,
  ListVideoIcon,
  PictureInPicture2Icon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { useCommandRoot } from "@/commands";
import type { PlayerCommands } from "@/commands";
import { artworkUrl } from "@/lib/artwork";
import {
  deviceName,
  loadDeviceId,
  loadQualityChoice,
  saveQualityChoice,
} from "@/lib/device-storage";
import { toastFailure } from "@/lib/failure";
import { copyText } from "@/lib/secure-context";
import { episodeCode } from "@/lib/format";
import { playerKeymap } from "@/lib/keymap";
import { audioTrackLabel, subtitleTrackLabels } from "@/lib/media-facts";
import { listOrLoading } from "@/lib/query-state";
import { useLatest } from "@/lib/use-latest";
import { volumeIsSettable } from "@/playback/browser-support";
import { PlaybackPhase, StartChoice } from "@/playback/playback-controller";
import type { PlaybackRequest } from "@/playback/playback-controller";
import { castImage } from "@/casting/cast-playback";
import { localOnly } from "@/casting/cast-profile";
import type { CastItem } from "@/casting/cast-profile";
import { useAirPlay, useRemotePlayback } from "@/casting/system-targets";
import { useCast, useRemoteState } from "@/casting/use-cast";
import { PlaybackStop } from "@/playback/playback-policy";
import { chapterAt, useScrubbing } from "@/playback/scrubbing";
import { parseQualityChoice, QUALITY_OPTIONS } from "@/playback/quality";
import { useMediaSession } from "@/playback/use-media-session";
import { usePictureInPicture } from "@/playback/use-picture-in-picture";
import { useMediaState, usePlayback } from "@/playback/use-playback";
import { useActiveProfile } from "@/session/guards";
import { useScopes } from "@/session/viewer";

import { AUTOPLAY_COUNTDOWN } from "./autoplay";
import { AutoplayNext } from "./autoplay-next";
import { RoomNextEpisode } from "./room-next";
import { CastMenu, CastingState } from "./cast-menu";
import { EpisodePicker } from "./episode-picker";
import { LeaveDialog } from "./leave-dialog";
import {
  PhoneControls,
  PhoneRoomDetails,
  PhoneRoomVideoChrome,
  PhoneSubtitlesButton,
  TrackPill,
} from "./phone-player";
import {
  Buffering,
  PlaybackStopped,
  PreparingStream,
  PressPlay,
  ResumePrompt,
  SubtitleDelayNotice,
  TryingAnotherWay,
} from "./player-states";
import { roomMembers } from "./room-members";
import {
  HostLeft,
  RoomChip,
  RoomDenied,
  StartRoomDialog,
  SyncingToHost,
  WaitingForHost,
} from "./room-states";
import { hostGone } from "./room-members";
import { StreamInfo } from "./stream-info";
import { useControlsVisible, useFullscreen, usePlayerLayout } from "./use-player-frame";
import type { PlayerLayout } from "./use-player-frame";
import { useSubtitleDelay } from "./use-subtitle-delay";
import { useRoomNext } from "./use-room-next";
import { useWatchRoom } from "./use-watch-room";

const BUFFER_TARGET_SECONDS = 4;

const BUFFERING_GRACE_MS = 400;

const KEY_PREVIEW_MS = 1_200;

const VOLUME_STEP = 0.1;

const CAST_UNMUTE_LEVEL = 0.5;

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
  /** The watch room to join, from the URL. */
  readonly roomId: RoomId | undefined;
  /** Open Watch together once playback runs, as the title page asks. */
  readonly together: boolean;
}

const startChoice = (start: PlayerScreenProps["start"]): StartChoice => {
  if (start === "0") return StartChoice.Beginning();

  return start === "resume" ? StartChoice.Resume() : StartChoice.Ask();
};

interface WatchSearch {
  readonly episodeId?: EpisodeId;
  readonly room?: RoomId;
  readonly start: "resume";
}

const watchSearch = (episodeId: EpisodeId | undefined, room: RoomId | undefined): WatchSearch => {
  if (episodeId === undefined)
    return room === undefined ? { start: "resume" } : { room, start: "resume" };

  return room === undefined ? { episodeId, start: "resume" } : { episodeId, room, start: "resume" };
};

const roomLink = (id: RoomId): string => `${window.location.origin}/r/${id}`;

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
export function PlayerScreen({
  titleId,
  episodeId,
  version,
  start,
  roomId,
  together,
}: PlayerScreenProps) {
  const { profile, profiles } = useActiveProfile();
  const scopes = useScopes();
  const navigate = useNavigate();
  const runtime = useMoviesRuntime();
  const layout = usePlayerLayout();
  const deviceId = useMemo(() => loadDeviceId(), []);
  const [frame, setFrame] = useState<HTMLDivElement | null>(null);
  const [overlays, setOverlays] = useState<HTMLDivElement | null>(null);
  const [video, setVideo] = useState<HTMLVideoElement | null>(null);
  const [openedRoom] = useState(roomId ?? null);
  const title = useCommandQuery("titles.get", { profileId: profile.id, titleId });
  const detail = title.status === "success" ? title.data : null;
  const createRoom = useCommand("rooms.create");
  const leaveRoom = useCommand("rooms.leave");
  const endRoom = useCommand("rooms.end");

  const [menu, setMenu] = useState(false);
  const [info, setInfo] = useState(false);
  const [panel, setPanel] = useState(true);
  const [episodesOpenIn, setEpisodesOpenIn] = useState<PlayerLayout | null>(null);
  const [volumeOpen, setVolumeOpen] = useState(false);

  const [creditsDismissed, setCreditsDismissed] = useState(false);

  const [countdown, setCountdown] = useState<number | null>(null);
  const [brightness, setBrightness] = useState(1);
  const [scrub, setScrub] = useState<number | null>(null);
  const [keyPreview, setKeyPreview] = useState<number | null>(null);
  const [menuQuery, setMenuQuery] = useState("");
  const [startDialog, setStartDialog] = useState<{ readonly roomId: RoomId | null } | null>(null);

  const [leaving, setLeaving] = useState<{ readonly resume: boolean } | null>(null);
  const focusBeforeLeaving = useRef<HTMLElement | null>(null);

  const wantsTogether = useRef(together);
  const canSetVolume = useMemo(() => volumeIsSettable(), []);

  const watch = useWatchRoom(roomId ?? null, profile.id, deviceId);

  const outOfReach = watch?.join.status === "denied" && watch.join.denial.kind === "unavailable";

  useRoomPresence(outOfReach && roomId !== undefined ? { roomId, deviceId } : null);

  const leftRoom = openedRoom !== null && roomId === undefined;
  const joined = openedRoom === null || leftRoom || watch?.join.status === "joined";
  const roomReady = openedRoom === null || leftRoom || (joined && watch?.room !== null);
  const roomRecord = watch?.room ?? null;
  const latestRoom = useLatest(roomRecord);

  const versionList = useCommandQuery(
    "titles.versions",
    openedRoom !== null
      ? "skip"
      : episodeId === undefined
        ? { profileId: profile.id, titleId }
        : { profileId: profile.id, titleId, episodeId },
  );

  const versions = versionList.status === "success" ? versionList.data : NO_VERSIONS;

  const buildRequest = roomReady
    ? (): PlaybackRequest => ({
        profileId: profile.id,
        deviceId,
        deviceName: deviceName(),
        titleId: roomRecord?.title.id ?? titleId,
        episodeId: roomRecord === null ? (episodeId ?? null) : (roomRecord.episode?.id ?? null),
        fileId: openedRoom === null ? (version ?? null) : null,
        roomId: openedRoom,
        start:
          openedRoom === null
            ? startChoice(start)
            : StartChoice.At({
                positionMs: () => {
                  const current = latestRoom.current;

                  return current === null
                    ? 0
                    : targetPosition(current.clock, EpochMillis.make(Date.now()));
                },
              }),
        quality: loadQualityChoice(),
      })
    : null;

  const [pageFile, setPageFile] = useState("");

  const matchingFile =
    openedRoom !== null &&
    roomRecord !== null &&
    roomRecord.title.id === titleId &&
    (roomRecord.episode?.id ?? undefined) === episodeId
      ? roomRecord.fileId
      : null;

  if (matchingFile !== null && matchingFile !== pageFile) setPageFile(matchingFile);
  const roomFile = matchingFile ?? pageFile;

  const playbackKey = [
    roomReady ? "ready" : "waiting",
    profile.id,
    titleId,
    episodeId ?? "",
    openedRoom ?? "",
    roomFile,
  ].join(":");

  const handle = usePlayback(video, buildRequest, playbackKey);
  const controller = handle?.controller ?? null;
  const snapshot = handle?.snapshot ?? null;
  const phase = snapshot?.phase ?? PlaybackPhase.Starting();
  const isPlaying = PlaybackPhase.$is("Playing")(phase);
  const player = controller?.player ?? null;
  const output = controller?.output ?? null;
  const localMedia = useMediaState(video, player);
  const stream = snapshot?.stream ?? null;
  const started = snapshot?.started ?? null;
  const episode = started?.episode ?? roomRecord?.episode ?? null;
  const titleName = detail?.name ?? roomRecord?.title.name ?? "";
  const artworkKey = episode?.still ?? detail?.artwork.poster ?? null;

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
            imageUrl: castImage(started, artworkKey),
          },
    [started, episode, titleName, artworkKey],
  );

  const chromecast = useCast(controller, isPlaying, castItem);
  const casting = chromecast.playback;
  const remote = useRemoteState(casting);
  const airplay = useAirPlay(video);
  const remotePlayback = useRemotePlayback(video);
  const pip = usePictureInPicture(video);

  const media =
    remote === null ? localMedia : { ...localMedia, ...remote, bufferedAheadSeconds: 0 };

  const engine = useRoomSync(
    isPlaying && joined ? output : null,
    roomId === undefined || !joined ? null : { roomId, deviceId, fileId: started?.file.id },
  );

  const sync = engine !== null && Result.isSuccess(engine) ? engine.success : null;
  const room = roomRecord;

  const duration = stream?.durationSeconds ?? (started?.file.probe.durationMs ?? 0) / 1000;
  const position = scrub ?? media.positionSeconds;
  const inRoom = roomId !== undefined && room !== null && joined;
  const host = inRoom && room.hostDeviceId === deviceId;
  const guest = inRoom && !host;
  const controlsTimeline = !guest;
  const hostName = room?.hostProfileName ?? "The host";

  const heading =
    episode === null ? titleName : `${titleName} ${episodeCode(episode)} ${episode.name}`;

  const next = useCommandQuery(
    "playback.nextEpisode",
    episode === null ? "skip" : { profileId: profile.id, episodeId: episode.id },
  );

  const nextEpisode = next.status === "success" ? next.data : null;

  const backToDetails = useCallback(() => {
    void navigate({ to: "/title/$titleId", params: { titleId } });
  }, [navigate, titleId]);

  const { toggle: toggleFullscreen, takeEscape } = useFullscreen(frame, video);

  const seekTo = useCallback(
    (seconds: number) => {
      if (output === null || !controlsTimeline) return;

      setScrub(null);
      output.seek(Math.max(0, Math.min(duration, seconds)) * 1000);
    },
    [output, controlsTimeline, duration],
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
      if (!controlsTimeline || output === null) return;
      const target = Math.max(0, Math.min(duration, output.positionMs() / 1000 + by));

      seekTo(target);
      preloadThumbnails();
      setKeyPreview(target);
      clearTimeout(keyPreviewTimer.current);
      keyPreviewTimer.current = setTimeout(() => setKeyPreview(null), KEY_PREVIEW_MS);
    },
    [controlsTimeline, output, duration, seekTo, preloadThumbnails],
  );

  useEffect(() => () => clearTimeout(keyPreviewTimer.current), []);

  const currentChapter = chapterAt(scrubbing.chapters, media.positionSeconds);

  const play = useCallback(() => {
    if (output === null || !controlsTimeline) return;

    if (snapshot?.needsGesture === true && casting === null) controller?.resumeWithGesture();
    else void output.play().catch(() => undefined);
  }, [output, controlsTimeline, snapshot?.needsGesture, controller, casting]);

  const togglePlay = useCallback(() => {
    if (output === null || !controlsTimeline) return;

    if ((snapshot?.needsGesture === true && casting === null) || output.isPaused()) play();
    else output.pause();
  }, [output, controlsTimeline, snapshot?.needsGesture, casting, play]);

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
      versions.length < 2 || openedRoom !== null || roomId !== undefined || casting !== null
        ? []
        : versions.map((candidate) => ({
            id: candidate.id,
            label: Versions.label(candidate),
            detail: Versions.detail(candidate),
          })),
    [versions, openedRoom, roomId, casting],
  );

  const versionId = started?.file.id ?? "";

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

    if (pick === null || started === null || stream === null || stream === pick.before) return;
    versionPick.current = null;

    if (started.file.id !== pick.id) {
      toast.error("This version couldn't play");

      return;
    }

    void navigate({
      to: "/watch/$titleId",
      params: { titleId },
      search: (previous) => ({ ...previous, version: pick.id }),
      replace: true,
    });
  }, [started, stream, navigate, titleId]);

  const loadedQuality = snapshot?.loadedQuality ?? null;

  useEffect(() => {
    if (loadedQuality !== null) saveQualityChoice(loadedQuality);
  }, [loadedQuality]);

  const shownSubtitle = casting === null ? subtitleId : null;

  useEffect(() => {
    if (video === null) return;

    for (const track of Array.from(video.textTracks)) {
      track.mode = track.id === shownSubtitle ? "showing" : "disabled";
    }
  }, [video, shownSubtitle, stream]);

  const subtitleDelay = useSubtitleDelay({
    controller,
    stream,
    subtitleId: snapshot?.subtitleId ?? null,
    delayMs: snapshot?.subtitleDelayMs ?? 0,
    casting: casting !== null,
    otherScreen: airplay?.active === true || remotePlayback?.active === true,
    keycaps: layout === "desktop",
  });

  const copyLink = useCallback((id: RoomId) => {
    void copyText(roomLink(id)).then(() => toast.success("Invite link copied"), toastFailure);
  }, []);

  const openStartRoom = useCallback(() => {
    if (started === null || output === null) return;

    const positionMs = Milliseconds.make(Math.max(0, output.positionMs()));

    const input = {
      profileId: profile.id,
      deviceId,
      titleId: started.titleId,
      fileId: started.file.id,
      positionMs,
    };

    setStartDialog({ roomId: null });
    createRoom(
      started.episodeId === null ? input : { ...input, episodeId: started.episodeId },
    ).then(
      (created) => setStartDialog({ roomId: created.id }),
      (cause: unknown) => {
        setStartDialog(null);
        toastFailure(cause);
      },
    );
  }, [started, output, createRoom, profile.id, deviceId]);

  useEffect(() => {
    if (!wantsTogether.current || !isPlaying || roomId !== undefined) return;
    wantsTogether.current = false;
    openStartRoom();
  }, [isPlaying, roomId, openStartRoom]);

  const cancelStartRoom = useCallback(() => {
    const created = startDialog?.roomId ?? null;

    setStartDialog(null);

    if (created !== null) void endRoom({ roomId: created, deviceId }).catch(toastFailure);
  }, [startDialog, endRoom, deviceId]);

  const confirmStartRoom = useCallback(() => {
    const created = startDialog?.roomId ?? null;

    if (created === null) return;

    setStartDialog(null);
    setPanel(true);
    void navigate({
      to: "/watch/$titleId",
      params: { titleId },
      search: watchSearch(episodeId, created),
      replace: true,
    });
  }, [startDialog, navigate, titleId, episodeId]);

  const dropRoomFromUrl = useCallback(() => {
    void navigate({
      to: "/watch/$titleId",
      params: { titleId },
      search: watchSearch(episodeId, undefined),
      replace: true,
    });
  }, [navigate, titleId, episodeId]);

  const leaveAndStay = useCallback(() => {
    if (roomId === undefined) return;
    void leaveRoom({ roomId, deviceId }).catch(toastFailure);
    dropRoomFromUrl();
  }, [roomId, leaveRoom, deviceId, dropRoomFromUrl]);

  const leaveAndExit = useCallback(() => {
    if (roomId !== undefined) void leaveRoom({ roomId, deviceId }).catch(toastFailure);
    backToDetails();
  }, [roomId, leaveRoom, deviceId, backToDetails]);

  const endAndStay = useCallback(() => {
    if (roomId === undefined) return;
    void endRoom({ roomId, deviceId }).catch(toastFailure);
    dropRoomFromUrl();
  }, [roomId, endRoom, deviceId, dropRoomFromUrl]);

  const askToLeave = useCallback(() => {
    const pause = roomId === undefined && output !== null && !output.isPaused();

    if (pause) output.pause();
    focusBeforeLeaving.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setLeaving({ resume: pause });
  }, [roomId, output]);

  // Plays again from what asking paused, not from `isPaused()`, which lags on a cast receiver.
  // Stay is a user gesture, so a stream that now needs one resumes too.
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

  const solo = roomId === undefined;
  const showNext = inCredits && solo && nextEpisode !== null && !creditsDismissed;

  const roomNext = useRoomNext({
    room: inRoom ? room : null,
    deviceId,
    role: host ? "host" : guest ? "guest" : null,
    page: { titleId, episodeId },
    episodeId: episode?.id ?? null,
    nextEpisode,
    credits: inCredits,
    canCommand: sync !== null && sync.connection === "connected" && sync.offset !== null,
  });

  const roomCard = leaving === null ? roomNext.card : null;
  const nextShown = showNext || roomCard !== null;

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

  const nextAction = solo ? (nextEpisode === null ? null : playNext) : roomNext.playNext;

  const seasonEpisodes = useCommandQuery(
    "titles.episodes",
    episode === null || guest
      ? "skip"
      : {
          profileId: profile.id,
          titleId: started?.titleId ?? titleId,
          seasonNumber: episode.seasonNumber,
        },
  );

  const previousEpisode = (() => {
    if (seasonEpisodes.status !== "success" || episode === null) return null;
    const at = seasonEpisodes.data.findIndex((candidate) => candidate.id === episode.id);

    return at > 0 ? (seasonEpisodes.data[at - 1] ?? null) : null;
  })();

  const playPrevious = useCallback(() => {
    if (previousEpisode !== null) playEpisode(previousEpisode.id);
  }, [playEpisode, previousEpisode]);

  const pickable = episode !== null && (solo || roomNext.pick !== null);
  const pickEpisode = roomNext.pick ?? playEpisode;
  const episodeIdNow = episode?.id ?? null;
  const seasonNow = episode?.seasonNumber ?? null;
  const seasons = detail?.seasons ?? null;

  const picking = useMemo(
    () =>
      !pickable || episodeIdNow === null || seasonNow === null || seasons === null
        ? null
        : {
            seasons,
            current: { id: episodeIdNow, seasonNumber: seasonNow },
            currentSeason: listOrLoading(seasonEpisodes),
          },
    [pickable, episodeIdNow, seasonNow, seasons, seasonEpisodes],
  );

  const canPick = picking !== null;

  if (episodesOpenIn !== null && (!pickable || episodesOpenIn !== layout)) {
    setEpisodesOpenIn(null);
  }

  const episodesShown = episodesOpenIn === layout && canPick;

  const episodeOptions = useMemo(
    (): ReadonlyArray<TrackOption> =>
      !canPick || seasonEpisodes.status !== "success"
        ? []
        : seasonEpisodes.data.flatMap((candidate) =>
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
      const chosen =
        seasonEpisodes.status === "success"
          ? seasonEpisodes.data.find((candidate) => candidate.id === id)
          : undefined;

      if (chosen !== undefined && chosen.id !== episode?.id) pickEpisode(chosen.id);
    },
    [seasonEpisodes, episode?.id, pickEpisode],
  );

  useMediaSession(
    !isPlaying || castItem === null
      ? null
      : {
          title: castItem.title,
          artist: episode === null ? "" : titleName,
          album: episode === null ? "" : episodeCode(episode),
          artwork: castItem.imageUrl,
          durationSeconds: duration,
          positionSeconds: media.positionSeconds,
          paused: media.paused,
          play: () => {
            if (output?.isPaused() === true) togglePlay();
          },
          pause: () => {
            if (output?.isPaused() === false) togglePlay();
          },
          seekTo,
          previous: previousEpisode === null || !solo ? null : playPrevious,
          next: nextAction,
        },
  );

  useEffect(() => {
    if (!showNext) {
      setCountdown(null);

      return undefined;
    }

    const fiber = runtime.runFork(
      Stream.runForEach(
        Playback.autoplayCountdown(AUTOPLAY_COUNTDOWN.totalMs, AUTOPLAY_COUNTDOWN.stepMs),
        (left) => Effect.sync(() => setCountdown(left)),
      ).pipe(Effect.andThen(Effect.sync(playNext))),
    );

    return () => {
      runtime.runFork(Fiber.interrupt(fiber));
    };
  }, [showNext, runtime, playNext]);

  const guestSyncing =
    guest &&
    (sync === null ||
      sync.offset === null ||
      sync.follow === "blocked" ||
      (sync.clock.status === "playing" &&
        (sync.follow === "buffering" ||
          sync.driftMs === null ||
          Math.abs(sync.driftMs) >= DRIFT_THRESHOLDS.seekMs)));

  const members = useMemo(
    () => (room === null ? [] : roomMembers(room, deviceId, guestSyncing, sync?.driftMs ?? null)),
    [room, deviceId, guestSyncing, sync?.driftMs],
  );

  const roomPaused = room !== null && (room.clock.status !== "playing" || hostGone(room));
  const stalled = useSettled(isPlaying && media.buffering, BUFFERING_GRACE_MS);

  const streamInfoAvailable = layout === "desktop" && stream !== null && started !== null;
  const infoShown = info && streamInfoAvailable;

  const hold =
    !isPlaying ||
    media.paused ||
    infoShown ||
    menu ||
    episodesShown ||
    (volumeOpen && volumeSettable) ||
    startDialog !== null ||
    leaving !== null ||
    nextShown ||
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
        if (volumeSettable) commitVolume(media.volume + VOLUME_STEP);
        else if (media.muted) setMuted(false);
      },
      "player.volume-down": () => {
        if (volumeSettable) commitVolume(media.volume - VOLUME_STEP);
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
    !menu && startDialog === null && leaving === null,
  );

  const commands = useMemo(
    (): PlayerCommands => ({
      playing: !media.paused,
      controlsTimeline,
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
      startRoom: inRoom || started === null ? null : openStartRoom,
      room: !inRoom
        ? null
        : {
            copyLink: () => copyLink(roomId),
            ...(host
              ? { role: "host" as const, end: endAndStay }
              : { role: "guest" as const, leave: leaveAndExit }),
          },
    }),
    [
      media.paused,
      controlsTimeline,
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
      inRoom,
      episodeOptions,
      episode?.id,
      selectEpisode,
      started,
      streamInfoAvailable,
      openStartRoom,
      roomId,
      copyLink,
      host,
      endAndStay,
      leaveAndExit,
    ],
  );

  const root = useCommandRoot({
    navigate,
    query: menuQuery,
    profile,
    profiles,
    scopes,
    player: commands,
  });

  if (watch !== null && watch.join.status === "denied") {
    return (
      <RoomDenied
        denial={watch.join.denial}
        switchProfile={() => void navigate({ to: "/profiles" })}
        home={(className) => (
          <button type="button" className={className} onClick={() => void navigate({ to: "/" })}>
            Go to Home
          </button>
        )}
      />
    );
  }

  const backdrop = artworkUrl(
    detail?.artwork.backdrop ?? room?.title.artwork.backdrop ?? null,
    "backdrop",
  );

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
        profileId={profile.id}
        titleId={titleId}
        seasons={picking.seasons}
        current={picking.current}
        currentSeason={picking.currentSeason}
        onPlay={pickEpisode}
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
              scopes.has("manage") && detail !== null
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
          profileName={profile.name}
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

    if (guest && hostGone(room)) {
      return (
        <HostLeft
          hostName={hostName}
          positionMs={room.clock.positionAtAnchorMs}
          onKeepWatching={() => {
            leaveAndStay();
            controller?.resumeWithGesture();
          }}
          onLeave={leaveAndExit}
        />
      );
    }

    if (guest && (!isPlaying || guestSyncing)) {
      const target = targetPosition(room.clock, EpochMillis.make(Date.now()));
      const blocked = sync?.follow === "blocked" || snapshot?.needsGesture === true;

      return (
        <SyncingToHost
          hostName={hostName}
          targetMs={target}
          progress={
            isPlaying ? Math.min(1, media.bufferedAheadSeconds / BUFFER_TARGET_SECONDS) : 0.2
          }
          onJoin={blocked ? () => controller?.resumeWithGesture() : undefined}
        />
      );
    }

    if (guest && room.clock.status === "buffering") return <WaitingForHost hostName={hostName} />;

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

  const showChrome = isPlaying && center === null && !nextShown;
  const portraitRoom = layout === "phone-portrait" && inRoom;
  const sidePanel = layout === "desktop" && inRoom && panel;

  const videoElement = (
    <video
      ref={setVideo}
      data-testid="player-video"
      crossOrigin="anonymous"
      playsInline
      x-webkit-airplay="allow"
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
          {inRoom ? (
            <RoomChip paused={roomPaused} watching={hostGone(room) ? undefined : members.length} />
          ) : null}
        </div>
        <div className="flex items-center gap-6">
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
          bufferedAheadSeconds={media.bufferedAheadSeconds}
          onClose={() => setInfo(false)}
          className="absolute top-21 right-10"
        />
      ) : null}
      {showChrome || (isPlaying && guest && center === null && !nextShown) ? (
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
          locked={guest ? `Only ${hostName} can pause or seek` : undefined}
          roomActive={sidePanel}
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
            scrubbing.chapters.length === 0 || guest
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
          onRoom={inRoom ? () => setPanel((open) => !open) : openStartRoom}
          onFullscreen={toggleFullscreen}
        />
      ) : null}
    </>
  );

  const phoneControls =
    isPlaying && center === null && !nextShown ? (
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
          locked={guest ? `${hostName} is hosting` : undefined}
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
              {scrubbing.chapters.length === 0 || guest
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
          onRoom={inRoom ? undefined : openStartRoom}
          castMenu={canCast ? castMenu : undefined}
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
        portraitRoom ? "flex-col" : "flex-row",
        !controlsVisible && "cursor-none",
      )}
    >
      <div
        className={cn(
          "relative",
          portraitRoom
            ? "mt-[env(safe-area-inset-top)] aspect-video w-full shrink-0"
            : "min-w-0 grow",
        )}
      >
        <div className="absolute inset-0">
          {videoElement}
          {casting === null ? null : <CastingState deviceName={casting.deviceName} />}
        </div>
        {portraitRoom ? (
          <PhoneRoomVideoChrome
            hostName={hostName}
            fraction={duration <= 0 ? 0 : Math.min(1, position / duration)}
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
              countdownMs: countdown ?? AUTOPLAY_COUNTDOWN.totalMs,
              onPlayNext: playNext,
              onWatchCredits: () => setCreditsDismissed(true),
            }}
          />
        ) : null}
        {roomCard === null || room === null ? null : (
          <RoomNextEpisode
            room={room}
            offset={sync?.offset ?? null}
            card={roomCard}
            onPlayNext={roomNext.moveOn}
            onWatchCredits={roomNext.cancel}
            onClose={roomNext.close}
          />
        )}
      </div>
      {portraitRoom ? (
        <PhoneRoomDetails
          live={!roomPaused}
          position={position}
          duration={duration}
          title={titleName}
          members={members}
          subtitles={tracks(<PhoneSubtitlesButton />)}
          onLeave={host ? endAndStay : leaveAndExit}
        />
      ) : null}
      {sidePanel ? (
        <RoomPanel
          className="shrink-0"
          members={members}
          paused={roomPaused}
          onCopyLink={host ? () => copyLink(roomId) : undefined}
          onEnd={host ? endAndStay : undefined}
          onLeave={host || hostGone(room) ? undefined : leaveAndExit}
        />
      ) : null}
      {overlays === null ? null : (
        <>
          <StartRoomDialog
            open={startDialog !== null}
            link={
              startDialog?.roomId === null || startDialog === null
                ? null
                : roomLink(startDialog.roomId)
            }
            container={overlays}
            onCopy={() => {
              if (startDialog?.roomId != null) copyLink(startDialog.roomId);
            }}
            onCancel={cancelStartRoom}
            onStart={confirmStartRoom}
          />
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
