import { usePlatform, usePlatformQuery } from "@media/sdk/react";
import * as Brightness from "expo-brightness";
import { useKeepAwake } from "expo-keep-awake";
import * as Network from "expo-network";
import { router } from "expo-router";
import { VideoView } from "expo-video";
import type { VideoMetadata } from "expo-video";
import { ChevronLeft, LockKeyhole } from "lucide-react-native";
import { Result } from "effect";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { AppState, Pressable, StyleSheet, View } from "react-native";
import Animated, { FadeIn, FadeOut } from "react-native-reanimated";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { useDownloadSession } from "@/components/downloads/use-download-session";
import { Icon } from "@/components/ui/icon";
import { Image } from "@/components/ui/image";
import { Text } from "@/components/ui/text";
import { artworkUrl } from "@/lib/artwork";
import { asEpisodeId, asMediaFileId, asTitleId } from "@/lib/catalog";
import type { EpisodeId, SeasonEpisode } from "@/lib/catalog";
import { IOS_CAPABILITIES } from "@/lib/player/capabilities";
import { NEXT_COUNTDOWN, episodeLine, inCredits } from "@/lib/player/next-episode";
import { DATA_SAVER_QUALITY, mobileDataStep } from "@/lib/player/mobile-data";
import type { Connection, MobileDataStep } from "@/lib/player/mobile-data";
import { startArgs } from "@/lib/player/play-session";
import type { StartArgs } from "@/lib/player/play-session";
import { MAX_RECOVERIES, PlaybackStep, PlaybackStop } from "@/lib/player/policy";
import { preferredTracks } from "@/lib/player/preferred-tracks";
import type { QualityChoice } from "@/lib/player/quality";
import { chapterRows, scrubTileAt } from "@/lib/player/scrubbing";
import type { ScrubTile } from "@/lib/player/scrubbing";
import type { VideoState } from "@/lib/player/video-port";
import type { WatchParams } from "@/lib/routes";
import { useServer } from "@/session/connection";
import { useMediaServer } from "@/session/media-server";
import { usePreferences } from "@/session/preferences";

import { NextEpisodeCard } from "./next-episode-card";
import { PlaySource, PlayerController, PlayerPhase } from "./playback-controller";
import type { PlayerSnapshot } from "./playback-controller";
import { PLAYER_MARGINS, PlayerControls, RoundButton, useMargin } from "./player-controls";
import type { MoreItem } from "./player-controls";
import {
  AudioSubtitlesPanel,
  ChaptersPanel,
  EpisodesPanel,
  ProblemPanel,
  QualityPanel,
  SpeedPanel,
  speedLabel,
} from "./player-panels";
import { Spinner } from "./spinner";
import { SubtitleOverlay } from "./subtitle-overlay";
import { usePlayStart } from "./use-play-start";
import { useSeasonEpisodes } from "./use-season-episodes";

const CONTROLS_HIDE_MS = 4_000;

const UNLOCK_HINT_MS = 3_000;

type Panel = "audio" | "quality" | "speed" | "episodes" | "chapters";

interface Attempt {
  readonly key: number;
  readonly startAtMs: number | null;
  readonly failures: number;
  /** The play intent the attempt's startup counts from, in milliseconds since the epoch. */
  readonly intentAt: number | null;
  /** Whether the attempt plays once its stream loads, or stays paused there. */
  readonly play: boolean;
}

const IDLE_SNAPSHOT: PlayerSnapshot = {
  phase: PlayerPhase.Preparing(),
  playback: null,
  video: null,
  audioStreamIndex: null,
  subtitleId: null,
  subtitleDelayMs: 0,
  quality: "auto",
  rate: 1,
  recovering: false,
};

const IDLE_STATE: VideoState = {
  positionSeconds: 0,
  playing: false,
  buffering: false,
  ended: false,
};

const subscribeNothing = (): (() => void) => () => undefined;

const useBrightness = (): readonly [number, (value: number) => void] => {
  const [level, setLevel] = useState(0.5);

  useEffect(() => {
    let original: number | null = null;

    const read = async (): Promise<void> => {
      try {
        const value = await Brightness.getBrightnessAsync();

        original = value;
        setLevel(value);
      } catch {}
    };

    void read();

    return () => {
      if (original !== null) void Brightness.setBrightnessAsync(original).catch(() => undefined);
    };
  }, []);

  const set = useCallback((value: number) => {
    setLevel(value);
    void Brightness.setBrightnessAsync(value).catch(() => undefined);
  }, []);

  return [level, set] as const;
};

interface StartChoices {
  readonly quality: QualityChoice;
  readonly tracks: {
    readonly audioStreamIndex: number | null;
    readonly subtitleId: string | null;
  } | null;
}

type Restart =
  /** `intentAt` when the viewer asked to try again; the attempt's own intent stands otherwise. */
  | { readonly kind: "again"; readonly failed: boolean; readonly intentAt?: number }
  | {
      readonly kind: "at";
      readonly positionMs: number;
      readonly choices: StartChoices;
      readonly intentAt: number | null;
      readonly play: boolean;
    };

interface PlayerSessionProps {
  readonly params: WatchParams;
  readonly attempt: Attempt;
  readonly onRestart: (restart: Restart) => void;
  readonly choices: StartChoices;
}

/** What `params` asks `movies.play.start` for. */
const startArgsOf = (params: WatchParams): StartArgs =>
  startArgs(
    {
      titleId: asTitleId(params.titleId),
      episodeId: params.episodeId === undefined ? null : asEpisodeId(params.episodeId),
    },
    params.fileId === undefined ? null : asMediaFileId(params.fileId),
    IOS_CAPABILITIES,
  );

const MISSING_DOWNLOAD = PlaybackStep.Stop({ stop: PlaybackStop.Missing() });

function PlayerSession({ params, attempt, onRestart, choices }: PlayerSessionProps) {
  const platform = usePlatform();
  const mediaServer = useMediaServer();
  const startQuality = choices.quality;
  const startTracks = choices.tracks;
  const { mediaUrl } = useServer();
  const preferences = usePreferences();
  const [startPreferences] = useState(preferences);
  const [controller, setController] = useState<PlayerController | null>(null);
  const restart = useRef(onRestart);
  const attemptIntent = useRef(attempt.intentAt);
  const attemptPlay = useRef(attempt.play);
  const titleId = asTitleId(params.titleId);
  const download = params.download ?? null;
  const [args] = useState(() => (download === null ? startArgsOf(params) : null));

  useEffect(() => {
    restart.current = onRestart;
  }, [onRestart]);

  useEffect(() => {
    attemptIntent.current = attempt.intentAt;
  }, [attempt.intentAt]);

  useEffect(() => {
    const created = new PlayerController({
      services: {
        report: platform.movies.play.report,
        sendDiagnostics: mediaServer.reportClientEvents,
      },
      onNewSession: (positionMs, intentAt, play) => {
        const ended = created.getSnapshot();

        restart.current({
          kind: "at",
          positionMs,
          intentAt,
          play,
          choices: {
            quality: ended.quality,
            tracks: { audioStreamIndex: ended.audioStreamIndex, subtitleId: ended.subtitleId },
          },
        });
      },
      quality: startQuality,
      intentAt: attemptIntent.current,
      play: attemptPlay.current,
      // The app may already be away when the player opens; a start then opens no stream.
      background: AppState.currentState === "background",
    });

    setController(created);

    return () => {
      created.dispose();
      setController(null);
    };
  }, [platform, mediaServer, startQuality]);

  useEffect(() => {
    if (controller === null) return undefined;

    const subscription = AppState.addEventListener("change", (status) => {
      controller.appStateChanged(status);
    });

    return () => subscription.remove();
  }, [controller]);

  const online = usePlayStart(args);
  const offline = useDownloadSession(download, controller?.port ?? null);

  useEffect(() => {
    if (controller === null) return;

    if (download !== null) {
      if (offline !== null && Result.isSuccess(offline)) {
        controller.start(PlaySource.Kept({ playback: offline.success }));
      }

      return;
    }

    if (online.status !== "started") return;

    const { started } = online.play;
    const durationMs = started.file.probe.durationMs;
    const atMs = attempt.startAtMs ?? started.resumePositionMs;

    controller.start(
      PlaySource.Streamed({
        play: online.play,
        atMs: durationMs > 0 ? Math.min(atMs, durationMs) : atMs,
        audioStreamIndex:
          startTracks?.audioStreamIndex ??
          preferredTracks(startPreferences, started.file.probe.audio, []).audioStreamIndex,
      }),
    );
  }, [controller, download, offline, online, attempt.startAtMs, startTracks, startPreferences]);

  let startStep: PlaybackStep | null = null;

  if (download === null) {
    startStep = online.status === "failed" ? online.step : null;
  } else if (offline !== null && Result.isFailure(offline)) {
    startStep = MISSING_DOWNLOAD;
  }

  const retryable =
    startStep !== null && !PlaybackStep.$is("Stop")(startStep) && attempt.failures < MAX_RECOVERIES;

  useEffect(() => {
    if (startStep === null || !retryable) return undefined;

    const afterMs = PlaybackStep.$is("Renegotiate")(startStep) ? startStep.afterMs : 0;
    const timer = setTimeout(() => restart.current({ kind: "again", failed: true }), afterMs);

    return () => clearTimeout(timer);
  }, [startStep, retryable]);

  const snapshot = useSyncExternalStore(
    controller?.subscribe ?? subscribeNothing,
    () => controller?.getSnapshot() ?? IDLE_SNAPSHOT,
  );

  const media = useSyncExternalStore(
    controller?.port.subscribeState ?? subscribeNothing,
    () => controller?.port.getState() ?? IDLE_STATE,
  );

  const detail = usePlatformQuery(platform.movies.titles.get, { titleId });
  const title = detail.status === "success" ? detail.data : null;
  const started = snapshot.playback?.started ?? null;
  const episode = started?.episode ?? null;

  const nextEpisode = usePlatformQuery(
    platform.movies.titles.nextEpisode,
    ...(episode === null
      ? (["skip"] as const)
      : ([{ episodeId: asEpisodeId(episode.id) }] as const)),
  );

  const seasonEpisodes = useSeasonEpisodes(titleId, episode?.seasonNumber ?? null);

  useEffect(() => {
    if (controller === null || title === null) return;

    const metadata: VideoMetadata = { title: episode === null ? title.name : episode.name };
    const artwork = artworkUrl(mediaUrl, title.artwork.backdrop ?? title.artwork.poster, "card");

    if (episode !== null) metadata.artist = title.name;

    if (artwork !== undefined) metadata.artwork = artwork;
    controller.setMetadata(metadata);
  }, [controller, title, episode, mediaUrl]);

  useKeepAwake();

  const [brightness, setBrightness] = useBrightness();
  const [volume, setVolume] = useState(1);
  const [visible, setVisible] = useState(true);
  const [held, setHeld] = useState(false);
  const [touch, setTouch] = useState(0);
  const [locked, setLocked] = useState(false);
  const [unlockHint, setUnlockHint] = useState(false);
  const [panel, setPanel] = useState<Panel | null>(null);
  const [creditsDismissed, setCreditsDismissed] = useState(false);

  const poke = useCallback((holding?: boolean) => {
    setVisible(true);
    setTouch((count) => count + 1);

    if (holding !== undefined) setHeld(holding);
  }, []);

  const playing = PlayerPhase.$is("Playing")(snapshot.phase);
  const holding = held || panel !== null;

  useEffect(() => {
    if (!visible || holding || !media.playing || !playing) return undefined;

    const timer = setTimeout(() => setVisible(false), CONTROLS_HIDE_MS);

    return () => clearTimeout(timer);
  }, [visible, holding, media.playing, playing, touch]);

  useEffect(() => {
    if (!unlockHint) return undefined;

    const timer = setTimeout(() => setUnlockHint(false), UNLOCK_HINT_MS);

    return () => clearTimeout(timer);
  }, [unlockHint]);

  const durationSeconds = (started?.file.probe.durationMs ?? 0) / 1000;
  const stop = startStep !== null && PlaybackStep.$is("Stop")(startStep) ? startStep.stop : null;
  const stopped = PlayerPhase.$is("Stopped")(snapshot.phase) ? snapshot.phase.stop : stop;
  const failedStart = startStep !== null && !retryable && stop === null;

  const subtitlesFor = useRef<string | null>(null);

  useEffect(() => {
    const playback = snapshot.playback;

    if (!playing || controller === null || playback === null) return;

    if (subtitlesFor.current === playback.started.sessionId) return;
    subtitlesFor.current = playback.started.sessionId;

    const subtitleId =
      startTracks === null
        ? preferredTracks(startPreferences, [], playback.stream.subtitles).subtitleId
        : startTracks.subtitleId;

    if (subtitleId !== null) controller.selectSubtitle(subtitleId);
  }, [playing, controller, snapshot.playback, startPreferences, startTracks]);

  const next = nextEpisode.status === "success" ? nextEpisode.data : null;

  const credits =
    playing &&
    inCredits({
      positionSeconds: media.positionSeconds,
      durationSeconds,
      playing: media.playing,
      ended: media.ended,
    });

  const showNext = credits && next !== null && !creditsDismissed && panel === null && !locked;

  const [countdownStart, setCountdownStart] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const autoplay = preferences.autoplayNext;

  useEffect(() => {
    if (!showNext || !autoplay) {
      setCountdownStart(null);

      return undefined;
    }

    setCountdownStart(Date.now());
    setNow(Date.now());

    const timer = setInterval(() => setNow(Date.now()), NEXT_COUNTDOWN.stepMs / 4);

    return () => clearInterval(timer);
  }, [showNext, autoplay]);

  const countdownMs =
    countdownStart === null
      ? NEXT_COUNTDOWN.totalMs
      : NEXT_COUNTDOWN.totalMs - (now - countdownStart);

  const playEpisode = useCallback((episodeId: EpisodeId) => {
    router.setParams({ episodeId, fileId: undefined, start: "resume", at: undefined });
  }, []);

  useEffect(() => {
    if (showNext && countdownStart !== null && countdownMs <= 0) playEpisode(next.id);
  }, [showNext, next, countdownStart, countdownMs, playEpisode]);

  const tileAt = useCallback(
    (seconds: number): ScrubTile | null =>
      started === null ? null : scrubTileAt(started, seconds),
    [started],
  );

  const chapters = useMemo(() => chapterRows(started?.file.probe.chapters ?? []), [started]);

  const more: ReadonlyArray<MoreItem> = [
    ...(episode === null
      ? []
      : [
          {
            label: "Episodes",
            systemImage: "list.bullet.rectangle",
            onPress: () => setPanel("episodes"),
          } as const,
        ]),
    ...(chapters.length === 0
      ? []
      : [
          {
            label: "Chapters",
            systemImage: "list.number",
            onPress: () => setPanel("chapters"),
          } as const,
        ]),
    ...(download === null
      ? [
          {
            label: "Playback Quality",
            systemImage: "dial.medium",
            onPress: () => setPanel("quality"),
          } as const,
        ]
      : []),
  ];

  const close = useCallback(() => {
    router.back();
  }, []);

  const backdrop =
    title === null
      ? undefined
      : artworkUrl(mediaUrl, title.artwork.backdrop ?? title.artwork.poster, "backdrop");

  const subtitleUrl =
    snapshot.playback?.stream.subtitles.find(
      (track) => track.id === snapshot.subtitleId && track.kind === "text",
    )?.url ?? null;

  const name = title?.name ?? "";

  const detailLine = episode === null ? null : episodeLine(episode);

  const port = controller?.port ?? null;
  const bar = useMargin(PLAYER_MARGINS.bar);

  const seekTo = (seconds: number): void => {
    controller?.seek(Math.min(Math.max(0, seconds), durationSeconds) * 1000);
  };

  const stillOf = (item: Pick<SeasonEpisode, "still">): string | undefined =>
    artworkUrl(mediaUrl, item.still ?? title?.artwork.backdrop, "card");

  const togglePlay = () => {
    poke();

    if (media.playing) port?.pause();
    else void port?.play();
  };

  const seekFromControls = (seconds: number) => {
    poke();
    seekTo(seconds);
  };

  return (
    <View className="flex-1 bg-dark-bg">
      <View className="absolute inset-0">
        {snapshot.video === null ? null : (
          <VideoView
            player={snapshot.video}
            style={StyleSheet.absoluteFill}
            contentFit="contain"
            nativeControls={false}
            allowsPictureInPicture
            startsPictureInPictureAutomatically
            onPictureInPictureStart={() => controller?.pictureInPictureChanged(true)}
            onPictureInPictureStop={() => controller?.pictureInPictureChanged(false)}
            onFirstFrameRender={() => controller?.showedFrame()}
          />
        )}

        {playing || backdrop === undefined ? null : (
          <Image source={{ uri: backdrop }} contentFit="cover" className="absolute inset-0" />
        )}

        <SubtitleOverlay
          url={subtitleUrl}
          positionSeconds={media.positionSeconds}
          delayMs={snapshot.subtitleDelayMs}
          raised={locked ? unlockHint : visible}
        />

        <Pressable
          className="absolute inset-0"
          accessibilityLabel={visible ? "Hide controls" : "Show controls"}
          onPress={() => {
            if (locked) {
              setUnlockHint(true);

              return;
            }

            if (visible) {
              setVisible(false);
              setHeld(false);
            } else {
              poke();
            }
          }}
        />

        {playing && media.buffering ? (
          <View className="absolute inset-0 items-center justify-center gap-4" pointerEvents="none">
            <Spinner />
            {snapshot.recovering ? (
              <Text variant="status" tone="onMedia">
                Reconnecting…
              </Text>
            ) : null}
          </View>
        ) : null}

        {visible && playing && !locked && !showNext && stopped === null ? (
          <Animated.View
            entering={FadeIn}
            exiting={FadeOut}
            className="absolute inset-0"
            pointerEvents="box-none"
          >
            <PlayerControls
              title={name}
              detail={detailLine}
              playing={media.playing}
              positionSeconds={media.positionSeconds}
              durationSeconds={durationSeconds}
              rateLabel={`${speedLabel(snapshot.rate)} Speed`}
              brightness={brightness}
              volume={volume}
              more={more}
              tileAt={tileAt}
              onClose={close}
              onTogglePlay={togglePlay}
              onSeek={seekFromControls}
              onLock={() => {
                setLocked(true);
                setVisible(false);
                setUnlockHint(true);
              }}
              onSpeed={() => setPanel("speed")}
              onAudioSubtitles={() => setPanel("audio")}
              onBrightness={setBrightness}
              onVolume={(value) => {
                setVolume(value);
                controller?.setVolume(value);
              }}
              onInteract={poke}
              onDismiss={() => {
                setVisible(false);
                setHeld(false);
              }}
            />
          </Animated.View>
        ) : null}
      </View>

      {PlayerPhase.$is("Preparing")(snapshot.phase) && stopped === null && !failedStart ? (
        <View className="absolute inset-0 items-center justify-center gap-4 bg-scrim">
          <Spinner />
          <Text variant="status" tone="onMedia">
            {snapshot.recovering ? "Reconnecting…" : "Preparing stream…"}
          </Text>
          <View className="absolute top-0 left-0 h-17 justify-center" style={bar}>
            <RoundButton icon={ChevronLeft} label="Close" onPress={close} />
          </View>
        </View>
      ) : null}

      {showNext ? (
        <NextEpisodeCard
          show={name}
          playing={detailLine}
          next={next}
          stillUrl={stillOf(next)}
          countdownMs={countdownMs}
          {...(autoplay ? {} : { headline: "Next Episode" })}
          onWatchCredits={() => setCreditsDismissed(true)}
          onPlayNext={() => playEpisode(next.id)}
        />
      ) : null}

      {locked && unlockHint ? (
        <Animated.View
          entering={FadeIn}
          exiting={FadeOut}
          className="absolute right-0 bottom-6 left-0 items-center"
        >
          <Pressable
            onPress={() => {
              setLocked(false);
              setUnlockHint(false);
              poke();
            }}
            accessibilityRole="button"
            accessibilityLabel="Unlock Controls"
            className="h-13 w-46 flex-row items-center justify-center gap-2 rounded-pill bg-dark-surface-raised active:opacity-80"
          >
            <Icon icon={LockKeyhole} tone="onMedia" size="inline" />
            <Text variant="bodyStrong" tone="onMedia">
              Unlock Controls
            </Text>
          </Pressable>
        </Animated.View>
      ) : null}

      {panel === "audio" && started !== null && snapshot.playback !== null ? (
        <AudioSubtitlesPanel
          audio={started.file.probe.audio}
          audioStreamIndex={snapshot.audioStreamIndex}
          subtitles={snapshot.playback.stream.subtitles}
          subtitleId={snapshot.subtitleId}
          subtitleDelayMs={snapshot.subtitleDelayMs}
          onAudio={(index) => controller?.selectAudio(index)}
          onSubtitle={(id) => controller?.selectSubtitle(id)}
          onDelay={(ms) => controller?.setSubtitleDelay(ms)}
          onClose={() => setPanel(null)}
        />
      ) : null}

      {panel === "quality" ? (
        <QualityPanel
          quality={snapshot.quality}
          onQuality={(quality) => {
            controller?.selectQuality(quality);
            setPanel(null);
          }}
          onClose={() => setPanel(null)}
        />
      ) : null}

      {panel === "speed" ? (
        <SpeedPanel
          rate={snapshot.rate}
          onRate={(rate) => {
            controller?.setRate(rate);
            setPanel(null);
          }}
          onClose={() => setPanel(null)}
        />
      ) : null}

      {panel === "episodes" && episode !== null ? (
        <EpisodesPanel
          title={`${name} · Season ${String(episode.seasonNumber)}`}
          episodes={seasonEpisodes}
          playingId={episode.id}
          stillUrl={stillOf}
          onEpisode={(item) => {
            setPanel(null);
            playEpisode(item.id);
          }}
          onClose={() => setPanel(null)}
        />
      ) : null}

      {panel === "chapters" ? (
        <ChaptersPanel
          chapters={chapters}
          onChapter={(chapter) => {
            seekTo(chapter.startSeconds);
            setPanel(null);
          }}
          onClose={() => setPanel(null)}
        />
      ) : null}

      {stopped === null && !failedStart ? null : (
        <StoppedPanel
          stop={stopped}
          onRetry={() => {
            if (startStep === null) {
              controller?.retry();
            } else {
              restart.current({ kind: "again", failed: false, intentAt: Date.now() });
            }
          }}
          onLowerQuality={snapshot.playback === null ? null : () => controller?.tryLowerQuality()}
          onClose={close}
        />
      )}
    </View>
  );
}

function StoppedPanel({
  stop,
  onRetry,
  onLowerQuality,
  onClose,
}: {
  readonly stop: PlaybackStop | null;
  readonly onRetry: () => void;
  readonly onLowerQuality: (() => void) | null;
  readonly onClose: () => void;
}) {
  const interrupted = (description: string) => (
    <ProblemPanel
      title="Playback interrupted"
      description={description}
      primary={{ label: "Retry", retry: true, onPress: onRetry }}
      secondary={
        onLowerQuality === null ? null : { label: "Try Lower Quality", onPress: onLowerQuality }
      }
      onClose={onClose}
    />
  );

  if (stop === null) return interrupted("Playback stopped. Try again in a moment.");

  return PlaybackStop.$match(stop, {
    Missing: () => (
      <ProblemPanel
        title="File unavailable"
        description="The library folder can't be reached."
        primary={{ label: "Try Again", retry: false, onPress: onRetry }}
        secondary={{ label: "Choose Another Version", onPress: onClose }}
        onClose={onClose}
      />
    ),
    Unsupported: () => (
      <ProblemPanel
        title="Can't play on iPhone"
        description="This file can't be played or converted for this device."
        primary={{ label: "Choose Another Version", retry: false, onPress: onClose }}
        secondary={null}
        onClose={onClose}
      />
    ),
    Interrupted: ({ message }) => interrupted(message),
  });
}

const connectionOf = (state: Network.NetworkState): Connection => {
  if (state.type === Network.NetworkStateType.CELLULAR) return "cellular";

  return state.type === undefined || state.type === Network.NetworkStateType.UNKNOWN
    ? "unknown"
    : "other";
};

interface MobileDataGate {
  readonly step: MobileDataStep | "checking";
  readonly allow: () => void;
}

const useMobileDataGate = (): MobileDataGate => {
  const { mobileData } = usePreferences();
  const [preference] = useState(mobileData);
  const [step, setStep] = useState<MobileDataStep | "checking">("checking");

  useEffect(() => {
    let live = true;

    const read = async (): Promise<Connection> => {
      try {
        return connectionOf(await Network.getNetworkStateAsync());
      } catch {
        return "unknown";
      }
    };

    void read().then((connection) => {
      if (live) setStep(mobileDataStep(preference, connection));

      return undefined;
    });

    return () => {
      live = false;
    };
  }, [preference]);

  return { step, allow: () => setStep("play") };
};

const closePlayer = (): void => router.back();

function MobileDataPanel({
  step,
  onPlay,
}: {
  readonly step: Exclude<MobileDataStep, "play"> | "checking";
  readonly onPlay: (quality: QualityChoice | null) => void;
}) {
  if (step === "checking") {
    return (
      <View className="flex-1 items-center justify-center bg-dark-bg">
        <Spinner />
      </View>
    );
  }

  if (step === "ask") {
    return (
      <View className="flex-1 bg-dark-bg">
        <ProblemPanel
          title="Play on mobile data?"
          description="This iPhone isn't on Wi-Fi. Streaming uses mobile data."
          primary={{ label: "Play", retry: false, onPress: () => onPlay(null) }}
          secondary={{
            label: `Play at ${DATA_SAVER_QUALITY} to Save Data`,
            onPress: () => onPlay(DATA_SAVER_QUALITY),
          }}
          onClose={closePlayer}
        />
      </View>
    );
  }

  return (
    <View className="flex-1 bg-dark-bg">
      <ProblemPanel
        title="Wi-Fi only"
        description="App Settings streams on Wi-Fi only, and this iPhone is on mobile data."
        primary={{ label: "Close", retry: false, onPress: closePlayer }}
        secondary={null}
        onClose={closePlayer}
      />
    </View>
  );
}

/** The player for `params`, starting again when the last start ended or failed to start. */
export function PlayerScreen({ params }: { readonly params: WatchParams }) {
  const preferences = usePreferences();

  const [choices, setChoices] = useState<StartChoices>({
    quality: preferences.quality,
    tracks: null,
  });

  const [attempt, setAttempt] = useState<Attempt>(() => ({
    key: 0,
    startAtMs: params.at ?? (params.start === "beginning" ? 0 : null),
    failures: 0,
    intentAt: Date.now(),
    play: true,
  }));

  const restart = useCallback((next: Restart) => {
    if (next.kind === "at") setChoices(next.choices);

    setAttempt((current) =>
      next.kind === "again"
        ? {
            ...current,
            key: current.key + 1,
            failures: next.failed ? current.failures + 1 : 0,
            intentAt: next.intentAt ?? current.intentAt,
          }
        : {
            key: current.key + 1,
            startAtMs: next.positionMs,
            failures: 0,
            intentAt: next.intentAt,
            play: next.play,
          },
    );
  }, []);

  const data = useMobileDataGate();

  // The player's own safe area: the modal turns to landscape, where the app's provider would still
  // report the portrait insets.
  if (data.step !== "play" && params.download === undefined) {
    return (
      <SafeAreaProvider>
        <MobileDataPanel
          step={data.step}
          onPlay={(quality) => {
            if (quality !== null) setChoices((current) => ({ ...current, quality }));
            setAttempt((current) => ({ ...current, intentAt: Date.now() }));
            data.allow();
          }}
        />
      </SafeAreaProvider>
    );
  }

  return (
    <SafeAreaProvider>
      <PlayerSession
        key={attempt.key}
        params={params}
        attempt={attempt}
        onRestart={restart}
        choices={choices}
      />
    </SafeAreaProvider>
  );
}
