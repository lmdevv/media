import { targetPosition } from "@media/contracts/clock";
import type { EpisodeId } from "@media/contracts/ids";
import type { SeasonEpisode } from "@media/contracts/models/catalog";
import { EpochMillis, Milliseconds } from "@media/contracts/units";
import type { Playback } from "@media/sdk/effect";
import { useCommandQuery, useMoviesRuntime, usePlaybackSession } from "@media/sdk/react";
import * as Brightness from "expo-brightness";
import { useKeepAwake } from "expo-keep-awake";
import * as Network from "expo-network";
import { router } from "expo-router";
import { VideoView } from "expo-video";
import type { VideoMetadata } from "expo-video";
import { ChevronLeft, LockKeyhole } from "lucide-react-native";
import { Option, Result } from "effect";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import Animated, { FadeIn, FadeOut } from "react-native-reanimated";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { RoomEntry, useRoomGate, useSessionRoom } from "@/components/rooms/player-room";
import type { RoomGate } from "@/components/rooms/player-room";
import { RoomNextEpisodeCard } from "@/components/rooms/room-next-card";
import { RoomPane, RoomViewportControls } from "@/components/rooms/room-pane";
import { useRoomNext } from "@/components/rooms/use-room-next";
import { Icon } from "@/components/ui/icon";
import { Image } from "@/components/ui/image";
import { Text } from "@/components/ui/text";
import { artworkUrl } from "@/lib/artwork";
import { deviceId, deviceName } from "@/lib/device";
import { IOS_CAPABILITIES } from "@/lib/player/capabilities";
import { NEXT_COUNTDOWN, episodeLine, inCredits } from "@/lib/player/next-episode";
import { DATA_SAVER_QUALITY, mobileDataStep } from "@/lib/player/mobile-data";
import type { Connection, MobileDataStep } from "@/lib/player/mobile-data";
import {
  MAX_RECOVERIES,
  PlaybackStep,
  PlaybackStop,
  afterStartFailure,
  isUnhonoured,
} from "@/lib/player/policy";
import { preferredTracks } from "@/lib/player/preferred-tracks";
import { qualityCap } from "@/lib/player/quality";
import type { QualityChoice } from "@/lib/player/quality";
import { chapterRows, scrubTileAt } from "@/lib/player/scrubbing";
import type { ScrubTile } from "@/lib/player/scrubbing";
import type { VideoState } from "@/lib/player/video-port";
import type { WatchParams } from "@/lib/routes";
import { useActiveProfile } from "@/session/active-profile";
import { useServer } from "@/session/connection";
import { usePreferences } from "@/session/preferences";

import { useDownloadSession } from "@/components/downloads/use-download-session";

import { NextEpisodeCard } from "./next-episode-card";
import { PlayerController, PlayerPhase } from "./playback-controller";
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

const CONTROLS_HIDE_MS = 4_000;

const UNLOCK_HINT_MS = 3_000;

type Panel = "audio" | "quality" | "speed" | "episodes" | "chapters";

interface Attempt {
  readonly key: number;
  readonly startAtMs: number | null;
  readonly failures: number;
  /** The play intent the attempt's startup counts from, in milliseconds since the epoch. */
  readonly intentAt: number | null;
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
    };

interface PlayerSessionProps {
  readonly params: WatchParams;
  readonly attempt: Attempt;
  readonly onRestart: (restart: Restart) => void;
  readonly gate: RoomGate;
  readonly choices: StartChoices;
  readonly onQualityRefused: () => void;
}

const useSessionStart = (gate: RoomGate) =>
  useState(() => ({
    roomId: gate.opened,
    atMs:
      gate.opened === null || gate.joined === null
        ? null
        : targetPosition(gate.joined.clock, EpochMillis.make(Math.round(gate.serverNow()))),
  }))[0];

function PlayerSession({
  params,
  attempt,
  onRestart,
  gate,
  choices,
  onQualityRefused,
}: PlayerSessionProps) {
  const runtime = useMoviesRuntime();
  const startQuality = choices.quality;
  const startTracks = choices.tracks;
  const { profile } = useActiveProfile();
  const { mediaUrl } = useServer();
  const preferences = usePreferences();
  const [startPreferences] = useState(preferences);
  const [controller, setController] = useState<PlayerController | null>(null);
  const restart = useRef(onRestart);
  const attemptIntent = useRef(attempt.intentAt);
  const sessionStart = useSessionStart(gate);

  useEffect(() => {
    restart.current = onRestart;
  }, [onRestart]);

  useEffect(() => {
    attemptIntent.current = attempt.intentAt;
  }, [attempt.intentAt]);

  useEffect(() => {
    const created = new PlayerController(runtime, {
      onNewSession: (positionMs, intentAt) => {
        const ended = created.getSnapshot();

        restart.current({
          kind: "at",
          positionMs,
          intentAt,
          choices: {
            quality: ended.quality,
            tracks: { audioStreamIndex: ended.audioStreamIndex, subtitleId: ended.subtitleId },
          },
        });
      },
      quality: startQuality,
      intentAt: attemptIntent.current,
    });

    setController(created);

    return () => {
      created.dispose();
      setController(null);
    };
  }, [runtime, startQuality]);

  const request = useMemo(
    (): Playback.PlaybackRequest => ({
      profileId: profile.id,
      deviceId: deviceId(),
      deviceName: Option.some(deviceName()),
      titleId: params.titleId,
      episodeId: Option.fromNullishOr(params.episodeId),
      fileId: Option.fromNullishOr(params.fileId),
      roomId: Option.fromNullishOr(sessionStart.roomId),
      capabilities: IOS_CAPABILITIES,
      startAtMs: Option.map(Option.fromNullishOr(attempt.startAtMs ?? sessionStart.atMs), (ms) =>
        Milliseconds.make(ms),
      ),
      audioStreamIndex: Option.fromNullishOr(startTracks?.audioStreamIndex),
      chooseAudio: (file) =>
        Option.fromNullishOr(
          preferredTracks(startPreferences, file.probe.audio, []).audioStreamIndex,
        ),
      quality: Option.fromNullishOr(qualityCap(startQuality)),
    }),
    [
      profile.id,
      params,
      attempt.startAtMs,
      sessionStart,
      startQuality,
      startTracks,
      startPreferences,
    ],
  );

  const download = params.download ?? null;

  const online = usePlaybackSession(
    controller === null || download !== null ? null : request,
    controller?.port ?? null,
  );

  const offline = useDownloadSession(download, controller?.port ?? null);
  const session = download === null ? online : offline;

  useEffect(() => {
    if (controller !== null && session !== null && Result.isSuccess(session)) {
      controller.start(session.success, download === null);
    }
  }, [controller, session, download]);

  const startStep = useMemo(
    () =>
      session !== null && Result.isFailure(session) ? afterStartFailure(session.failure) : null,
    [session],
  );

  const qualityRefused =
    startQuality !== "auto" &&
    session !== null &&
    Result.isFailure(session) &&
    isUnhonoured(session.failure);

  useEffect(() => {
    if (qualityRefused) onQualityRefused();
  }, [qualityRefused, onQualityRefused]);

  const retryable =
    !qualityRefused &&
    startStep !== null &&
    !PlaybackStep.$is("Stop")(startStep) &&
    attempt.failures < MAX_RECOVERIES;

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

  const detail = useCommandQuery("titles.get", { profileId: profile.id, titleId: params.titleId });
  const title = detail.status === "success" ? detail.data : null;
  const started = snapshot.playback?.started ?? null;
  const episode = started?.episode ?? null;

  const nextEpisode = useCommandQuery(
    "playback.nextEpisode",
    episode === null ? "skip" : { profileId: profile.id, episodeId: episode.id },
  );

  const seasonEpisodes = useCommandQuery(
    "titles.episodes",
    episode === null
      ? "skip"
      : { profileId: profile.id, titleId: params.titleId, seasonNumber: episode.seasonNumber },
  );

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

  const shown = PlayerPhase.$is("Playing")(snapshot.phase);

  const room = useSessionRoom({
    gate,
    player: shown ? (controller?.port ?? null) : null,
    started:
      started === null
        ? null
        : {
            titleId: started.titleId,
            episodeId: started.episodeId,
            fileId: started.file.id,
            name: title?.name ?? "",
            artwork: started.episode?.still ?? title?.artwork.backdrop ?? null,
          },
    positionMs: () => controller?.port.positionMs() ?? 0,
    resume: () => {
      void controller?.port.play();
    },
  });

  const inRoom = room.room !== null;
  const guest = room.role === "guest";
  const holding = held || panel !== null || room.pane || room.popup !== null;

  useEffect(() => {
    if (!visible || holding || !media.playing || !shown) return undefined;

    const timer = setTimeout(() => setVisible(false), CONTROLS_HIDE_MS);

    return () => clearTimeout(timer);
  }, [visible, holding, media.playing, shown, touch]);

  useEffect(() => {
    if (!unlockHint) return undefined;

    const timer = setTimeout(() => setUnlockHint(false), UNLOCK_HINT_MS);

    return () => clearTimeout(timer);
  }, [unlockHint]);

  const durationSeconds = (started?.file.probe.durationMs ?? 0) / 1000;
  const stop = startStep !== null && PlaybackStep.$is("Stop")(startStep) ? startStep.stop : null;
  const stopped = PlayerPhase.$is("Stopped")(snapshot.phase) ? snapshot.phase.stop : stop;
  const failedStart = startStep !== null && !retryable && !qualityRefused && stop === null;
  const playing = PlayerPhase.$is("Playing")(snapshot.phase);

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

  const solo = gate.roomId === null;

  const showNext =
    solo && credits && next !== null && !creditsDismissed && panel === null && !locked;

  const roomNext = useRoomNext({
    room: room.room,
    role: room.role,
    deviceId: deviceId(),
    page:
      started === null
        ? null
        : { titleId: started.titleId, episodeId: started.episodeId ?? undefined },
    episodeId: started?.episodeId ?? null,
    nextEpisode: next,
    credits,
    canCommand:
      room.sync !== null && room.sync.connection === "connected" && room.sync.offset !== null,
  });

  const roomCard = inRoom && panel === null && !locked ? roomNext.card : null;
  const roomCardShown = roomNext.card !== null;
  const { setPane } = room;

  useEffect(() => {
    if (roomCardShown) setPane(false);
  }, [roomCardShown, setPane]);
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

  const pickEpisode = roomNext.pick ?? playEpisode;

  const more: ReadonlyArray<MoreItem> = [
    ...(episode === null || guest
      ? []
      : [
          {
            label: "Episodes",
            systemImage: "list.bullet.rectangle",
            onPress: () => setPanel("episodes"),
          } as const,
        ]),
    ...(chapters.length === 0 || guest
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
      <View className={`absolute top-0 bottom-0 left-0 ${room.pane ? "right-80" : "right-0"}`}>
        {snapshot.video === null ? null : (
          <VideoView
            player={snapshot.video}
            style={StyleSheet.absoluteFill}
            contentFit="contain"
            nativeControls={false}
            allowsPictureInPicture
            startsPictureInPictureAutomatically
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

        {playing && (media.buffering || room.waiting) && !room.pane ? (
          <View className="absolute inset-0 items-center justify-center gap-4" pointerEvents="none">
            <Spinner />
            {snapshot.recovering ? (
              <Text variant="status" tone="onMedia">
                Reconnecting…
              </Text>
            ) : null}
          </View>
        ) : null}

        {room.pane &&
        room.room !== null &&
        playing &&
        !locked &&
        roomCard === null &&
        stopped === null ? (
          <RoomViewportControls
            title={name}
            playing={media.playing}
            waiting={room.waiting}
            controlsTimeline={!guest}
            positionSeconds={media.positionSeconds}
            durationSeconds={durationSeconds}
            count={room.room.members.length}
            more={more}
            tileAt={tileAt}
            onClose={close}
            onTogglePlay={togglePlay}
            onSeek={seekFromControls}
            onAudioSubtitles={() => setPanel("audio")}
            onRoom={() => room.setPane(false)}
            onInteract={poke}
          />
        ) : null}

        {visible &&
        playing &&
        !locked &&
        !showNext &&
        roomCard === null &&
        !room.pane &&
        stopped === null ? (
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
              together={
                started === null || download !== null
                  ? undefined
                  : room.room === null
                    ? { kind: "start", onPress: room.onTogether }
                    : {
                        kind: "room",
                        count: room.room.members.length,
                        onPress: () => room.setPane(true),
                      }
              }
              controlsTimeline={!guest}
            />
          </Animated.View>
        ) : null}
      </View>

      {room.pane && room.room !== null && room.role !== null ? (
        <RoomPane
          role={room.role}
          members={room.members}
          watching={room.watching}
          notice={room.notice}
          onClose={() => room.setPane(false)}
          onInvite={room.openInvite}
          onEnd={room.openEnd}
          onLeave={room.leave}
          onContinue={room.continueAlone}
        />
      ) : null}

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

      {roomCard === null || room.room === null ? null : (
        <RoomNextEpisodeCard
          room={room.room}
          offset={room.sync?.offset ?? null}
          card={roomCard}
          show={name}
          playing={detailLine}
          stillUrl={stillOf(roomCard.episode)}
          onPlayNext={roomNext.moveOn}
          onWatchCredits={roomNext.cancel}
          onClose={roomNext.close}
        />
      )}

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
          episodes={seasonEpisodes.status === "success" ? seasonEpisodes.data : []}
          playingId={episode.id}
          stillUrl={stillOf}
          onEpisode={(item) => {
            setPanel(null);
            pickEpisode(item.id);
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
            if (snapshot.playback === null) {
              restart.current({ kind: "again", failed: false, intentAt: Date.now() });
            } else {
              controller?.retry();
            }
          }}
          onLowerQuality={snapshot.playback === null ? null : () => controller?.tryLowerQuality()}
          onClose={close}
        />
      )}

      {room.popup}
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

/** The player for `params`, starting a new session when the last one ended or failed to start. */
export function PlayerScreen({ params }: { readonly params: WatchParams }) {
  const gate = useRoomGate(params);
  const preferences = usePreferences();

  const [choices, setChoices] = useState<StartChoices>({
    quality: preferences.quality,
    tracks: null,
  });

  const [attempt, setAttempt] = useState<Attempt>(() => {
    const own = params.room === undefined;
    const at = own ? (params.at ?? (params.start === "beginning" ? 0 : null)) : null;

    return {
      key: 0,
      startAtMs: at,
      failures: 0,
      intentAt: Date.now(),
    };
  });

  const [admitted, setAdmitted] = useState(gate.admitted);

  if (gate.admitted && !admitted) {
    setAdmitted(true);
    setAttempt((current) => ({ ...current, intentAt: Date.now() }));
  }

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
          },
    );
  }, []);

  const uncapped = useCallback(() => {
    setChoices((current) => ({ ...current, quality: "auto" }));
    restart({ kind: "again", failed: false });
  }, [restart]);

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
      {gate.admitted ? (
        <PlayerSession
          key={attempt.key}
          params={params}
          attempt={attempt}
          onRestart={restart}
          gate={gate}
          choices={choices}
          onQualityRefused={uncapped}
        />
      ) : (
        <RoomEntry gate={gate} params={params} />
      )}
    </SafeAreaProvider>
  );
}
