import type { EngineEvent, EngineSource } from "@media/player/engine";
import { describe, expect, it } from "vitest";

import type {
  CastFramework,
  CastMediaId,
  CastLoadRequest,
  CastSession,
  ChromeCast,
  RemotePlayer,
  RemotePlayerChange,
} from "./cast-api";
import { CastEngine } from "./cast-engine";
import type { CastEngineHost } from "./cast-engine";

const CREDENTIAL = `r1.${"c".repeat(43)}`;

const STREAM = "http://nas.lan:8080/media/music/stream/song1?ticket=t1.k1.ticket&p=aac-320";

const OTHER = "http://nas.lan:8080/media/music/stream/song2?ticket=t1.k1.other&p=original";

const source = (url: string): EngineSource => ({
  key: url,
  url,
  durationMs: 200_000,
  finished: false,
});

/** A promise the test settles. */
const deferred = <A>() => {
  const { promise, resolve } = Promise.withResolvers<A>();

  return { promise, settle: resolve };
};

/** A wait the test holds a probe in until it settles it. */
interface ProbeHold {
  current: Promise<void> | null;
}

/** The receiver's media session, whose idle reason the test sets. */
interface FakeMedia {
  idleReason: string | null;
}

const settled = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

interface Loaded {
  readonly contentId: string;
  readonly contentType: string;
  readonly title: string;
  readonly currentTime: number;
  readonly autoplay: boolean;
  readonly answer: ReturnType<typeof deferred<string | undefined>>;
}

/** The media on the receiver, as a sender loaded it; null while it has none. */
interface OnReceiver {
  media: CastMediaId | null;
}

/** The Cast SDK as the engine uses it, played by the test, and the engine over it. */
const castSetup = () => {
  const listeners = new Set<(change: RemotePlayerChange) => void>();
  const commands: Array<string> = [];
  const loads: Array<Loaded> = [];
  const lends: Array<ReturnType<typeof deferred<string | null>>> = [];
  const probes: Array<string> = [];
  const media: FakeMedia = { idleReason: null };
  let probeStatus: number | null = 410;
  /** While set, a probe waits for it, as one the media server answers slowly. */
  const probeHold: ProbeHold = { current: null };

  const mirror = {
    isConnected: true,
    isPaused: true,
    isMuted: false,
    playerState: "IDLE",
    currentTime: 0,
    volumeLevel: 1,
  };

  const onReceiver: OnReceiver = { media: null };

  const change = (field: keyof typeof mirror, value: boolean | number | string): void => {
    Reflect.set(mirror, field, value);

    for (const listener of listeners) listener({ field, value });
  };

  /** Another sender, or this engine's load, puts `contentId` on the receiver, as the mirror tells. */
  const mediaArrives = (contentId: string | null): void => {
    onReceiver.media = contentId === null ? null : { contentId };

    for (const listener of listeners) listener({ field: "mediaInfo", value: onReceiver.media });
  };

  const taken: Array<true> = [];

  /** Every RemotePlayer the SDK makes mirrors the one receiver, as the fake's do. */
  class MirroredPlayer implements RemotePlayer {
    get isConnected(): boolean {
      return mirror.isConnected;
    }

    get isPaused(): boolean {
      return mirror.isPaused;
    }

    get isMuted(): boolean {
      return mirror.isMuted;
    }

    get mediaInfo(): CastMediaId | null {
      return onReceiver.media;
    }

    get playerState(): string {
      return mirror.playerState;
    }

    get currentTime(): number {
      return mirror.currentTime;
    }

    set currentTime(value: number) {
      mirror.currentTime = value;
    }

    get volumeLevel(): number {
      return mirror.volumeLevel;
    }

    set volumeLevel(value: number) {
      mirror.volumeLevel = value;
    }
  }

  const infos: Array<FakeMediaInfo> = [];

  class FakeMediaInfo {
    readonly contentId: string;
    readonly contentType: string;
    contentUrl = "";
    streamType = "";
    duration = 0;
    metadata = { title: "", artist: "", albumName: "", images: new Array<{ url: string }>() };

    constructor(contentId: string, contentType: string) {
      this.contentId = contentId;
      this.contentType = contentType;
      infos.push(this);
    }
  }

  const framework: CastFramework = {
    CastContext: {
      getInstance: () => {
        throw new Error("The engine never asks for the context");
      },
    },
    CastContextEventType: { CAST_STATE_CHANGED: "cast", SESSION_STATE_CHANGED: "session" },
    RemotePlayer: MirroredPlayer,
    RemotePlayerController: class {
      playOrPause() {
        commands.push("playOrPause");
      }
      seek() {
        commands.push(`seek ${String(mirror.currentTime)}`);
      }
      stop() {
        commands.push("stop");
      }
      setVolumeLevel() {
        commands.push(`volume ${String(mirror.volumeLevel)}`);
      }
      muteOrUnmute() {
        commands.push("muteOrUnmute");
      }
      addEventListener(_type: string, handler: (event: RemotePlayerChange) => void) {
        listeners.add(handler);
      }
      removeEventListener(_type: string, handler: (event: RemotePlayerChange) => void) {
        listeners.delete(handler);
      }
    },
    RemotePlayerEventType: { ANY_CHANGE: "anyChanged" },
  };

  const cast: ChromeCast = {
    AutoJoinPolicy: { TAB_AND_ORIGIN_SCOPED: "tab_and_origin_scoped" },
    Image: class {
      readonly url: string;

      constructor(url: string) {
        this.url = url;
      }
    },
    media: {
      DEFAULT_MEDIA_RECEIVER_APP_ID: "CC1AD845",
      MediaInfo: FakeMediaInfo,
      MusicTrackMediaMetadata: class {
        title = "";
        artist = "";
        albumName = "";
        images = new Array<{ url: string }>();
      },
      LoadRequest: class {
        autoplay = true;
        currentTime = 0;
      },
    },
  };

  const session: CastSession = {
    getCastDevice: () => ({ friendlyName: "Living Room TV" }),
    getMediaSession: () => media,
    loadMedia: (request: CastLoadRequest) => {
      const answer = deferred<string | undefined>();
      const info = infos.at(-1);

      loads.push({
        contentId: info?.contentId ?? "",
        contentType: info?.contentType ?? "",
        title: info?.metadata.title ?? "",
        currentTime: request.currentTime,
        autoplay: request.autoplay,
        answer,
      });

      return answer.promise;
    },
  };

  const host: CastEngineHost = {
    song: (trackId) => ({
      title: `Song ${trackId}`,
      artist: "Artist",
      album: "Album",
      artUrl: null,
      codec: "FLAC",
    }),
    lend: () => {
      const lent = deferred<string | null>();

      lends.push(lent);

      return lent.promise;
    },
    probe: async (url) => {
      probes.push(url);
      await probeHold.current;

      return probeStatus;
    },
    taken: () => {
      taken.push(true);
    },
  };

  const engine = new CastEngine({ framework, cast }, session, host);
  const events: Array<EngineEvent> = [];

  engine.subscribe((event) => events.push(event));

  return {
    engine,
    events,
    commands,
    loads,
    lends,
    probes,
    media,
    change,
    mediaArrives,
    taken,
    mirror,
    setProbe: (status: number | null) => {
      probeStatus = status;
    },
    probeHold,
  };
};

/** A movie another tab cast from `/movies` on the same receiver. */
const MOVIE = "http://nas.lan:8080/media/hls/movie1/1/index.m3u8";

/** Loads the song in `run`'s engine and has the receiver take it; answers its content id. */
const landSong = async (run: ReturnType<typeof castSetup>, autoplay = true): Promise<string> => {
  const loading = run.engine.load(source(STREAM), 0, autoplay);

  run.lends[0]?.settle(CREDENTIAL);
  await settled();
  run.loads[0]?.answer.settle(undefined);
  await loading;

  return run.loads[0]?.contentId ?? "";
};

describe("CastEngine", () => {
  it("plays a song on the receiver with a receiver credential in place of its ticket", async () => {
    const run = castSetup();
    const loading = run.engine.load(source(STREAM), 30_000, true);

    run.lends[0]?.settle(CREDENTIAL);
    await settled();

    expect(run.loads).toHaveLength(1);
    expect(run.loads[0]).toMatchObject({
      contentId: `http://nas.lan:8080/media/music/stream/song1?ticket=${CREDENTIAL}&p=aac-320`,
      contentType: "audio/mp4",
      title: "Song song1",
      currentTime: 30,
    });
    expect(run.engine.receiverName).toBe("Living Room TV");

    run.change("currentTime", 30);
    run.change("isPaused", false);
    run.loads[0]?.answer.settle(undefined);
    await loading;

    expect(run.events).toContainEqual({ type: "playing" });
    expect(run.engine.samplePlayback()).toStrictEqual({ positionMs: 30_000, playing: true });
  });

  it("drops a credential and a load answer that come for a load a newer one replaced", async () => {
    const run = castSetup();
    const first = run.engine.load(source(STREAM), 0, true);
    const second = run.engine.load(source(OTHER), 0, true);

    run.lends[0]?.settle(CREDENTIAL);
    await first;

    expect(run.loads).toHaveLength(0);

    run.lends[1]?.settle(CREDENTIAL);
    await settled();

    expect(run.loads.map((load) => load.title)).toStrictEqual(["Song song2"]);

    const third = run.engine.load(source(STREAM), 0, true);

    run.loads[0]?.answer.settle("LOAD_FAILED");
    await second;

    expect(run.events.filter((event) => event.type === "error")).toHaveLength(0);
    expect(run.probes).toHaveLength(0);

    run.engine.unload();
    run.lends[2]?.settle(CREDENTIAL);
    await third;

    expect(run.loads).toHaveLength(1);
  });

  it("says nothing of the media before until the newest load landed, then follows the receiver", async () => {
    const run = castSetup();
    const loading = run.engine.load(source(STREAM), 0, true);

    run.lends[0]?.settle(CREDENTIAL);
    await settled();

    // The song before ends on the receiver as the new one loads.
    run.media.idleReason = "FINISHED";
    run.change("playerState", "IDLE");
    run.change("isPaused", true);

    expect(run.events).toStrictEqual([]);

    run.media.idleReason = null;
    run.change("isPaused", false);
    run.loads[0]?.answer.settle(undefined);
    await loading;
    run.change("currentTime", 12);
    run.media.idleReason = "FINISHED";
    run.change("playerState", "IDLE");

    expect(run.events).toStrictEqual([
      { type: "time", positionMs: 0 },
      { type: "playing" },
      { type: "time", positionMs: 12_000 },
      { type: "ended" },
    ]);
  });

  it("tells a refused credential from a song the receiver could not play", async () => {
    const run = castSetup();
    const loading = run.engine.load(source(STREAM), 0, true);

    run.lends[0]?.settle(CREDENTIAL);
    await settled();
    run.loads[0]?.answer.settle(undefined);
    await loading;

    run.media.idleReason = "ERROR";
    run.change("playerState", "IDLE");
    await settled();

    expect(run.events.at(-1)).toMatchObject({ type: "error", reason: "expired" });
    expect(run.probes).toStrictEqual([run.loads[0]?.contentId]);

    run.setProbe(200);
    run.change("playerState", "IDLE");
    await settled();

    expect(run.events.at(-1)).toMatchObject({ type: "error", reason: "unsupported" });
  });

  it("toggles the receiver once per change of mind, and seeks it at once", async () => {
    const run = castSetup();
    const loading = run.engine.load(source(STREAM), 0, false);

    run.lends[0]?.settle(CREDENTIAL);
    await settled();
    run.loads[0]?.answer.settle(undefined);
    await loading;

    await run.engine.play();
    await run.engine.play();

    expect(run.commands).toStrictEqual(["playOrPause"]);
    expect(run.engine.samplePlayback().playing).toBe(true);

    run.change("isPaused", false);
    run.engine.seek(45_000);

    expect(run.commands).toStrictEqual(["playOrPause", "seek 45"]);
    expect(run.events.at(-1)).toStrictEqual({ type: "time", positionMs: 45_000 });

    run.engine.unload();

    expect(run.commands.at(-1)).toBe("stop");
  });

  it("reads the receiver's answer to a seek back to the start as that seek, not a disconnect", async () => {
    const run = castSetup();
    const loading = run.engine.load(source(STREAM), 0, false);

    run.lends[0]?.settle(CREDENTIAL);
    await settled();
    run.loads[0]?.answer.settle(undefined);
    await loading;
    run.change("isPaused", false);
    run.change("currentTime", 30);

    // The person restarts the song; the receiver answers at 0 and plays on.
    run.engine.seek(0);
    run.change("currentTime", 0);
    run.change("currentTime", 5);

    expect(run.engine.samplePlayback().positionMs).toBe(5_000);
    expect(run.events.at(-1)).toStrictEqual({ type: "time", positionMs: 5_000 });

    // A jump to 0 nobody asked for is still the mirror's reset as the receiver goes.
    run.change("currentTime", 0);
    run.change("isConnected", false);

    expect(run.engine.samplePlayback().positionMs).toBe(5_000);
  });

  it("hands the song back, and leaves the receiver alone, once another tab's movie takes it", async () => {
    const run = castSetup();
    const song = await landSong(run);

    run.mediaArrives(song);
    run.change("isPaused", false);
    run.change("currentTime", 20);
    // The person seeks; the receiver has not shown it yet when the movie arrives.
    run.engine.seek(90_000);

    const before = run.events.length;

    // The movies tab casts a movie to the same receiver, which plays it an hour in and ends it.
    run.mediaArrives(MOVIE);
    run.change("currentTime", 3605);
    run.change("isPaused", true);
    run.media.idleReason = "FINISHED";
    run.change("playerState", "IDLE");

    expect(run.taken).toHaveLength(1);
    expect(run.events.slice(before)).toStrictEqual([]);
    expect(run.engine.samplePlayback()).toStrictEqual({ positionMs: 90_000, playing: false });

    // Taking the song back unloads the engine, which leaves the movie playing.
    run.engine.unload();
    await run.engine.play();

    expect(run.commands).toStrictEqual(["seek 90"]);
  });

  it("says nothing of a movie on the receiver before the song's own media shows", async () => {
    const run = castSetup();

    // The receiver plays another tab's movie an hour in as the song loads.
    run.mediaArrives(MOVIE);
    run.change("isPaused", false);
    run.change("currentTime", 3600);

    const song = await landSong(run);

    expect(run.events).toStrictEqual([{ type: "time", positionMs: 0 }, { type: "playing" }]);

    run.change("currentTime", 3601);
    run.media.idleReason = "FINISHED";
    run.change("playerState", "IDLE");

    expect(run.events).toHaveLength(2);
    expect(run.taken).toStrictEqual([]);

    // The song's own media replaces the movie, and the engine follows it from then on.
    run.media.idleReason = null;
    run.mediaArrives(song);
    run.change("currentTime", 2);

    expect(run.events.at(-1)).toStrictEqual({ type: "time", positionMs: 2_000 });
  });

  it("hands the song back when another sender loads before the song's own media shows", async () => {
    const run = castSetup();

    run.mediaArrives(MOVIE);
    await landSong(run);

    // The movies tab moves its movie to a new stream before the receiver shows the song.
    run.mediaArrives("http://nas.lan:8080/media/hls/movie1/2/index.m3u8");

    expect(run.taken).toHaveLength(1);
  });

  it("takes a late report of its own song before for the media before, not another sender's", async () => {
    const run = castSetup();
    const first = run.engine.load(source(STREAM), 0, true);

    run.lends[0]?.settle(CREDENTIAL);
    await settled();

    // The person skips before the receiver answered the first song.
    const second = run.engine.load(source(OTHER), 0, true);

    run.lends[1]?.settle(CREDENTIAL);
    await settled();
    run.loads[0]?.answer.settle(undefined);
    run.loads[1]?.answer.settle(undefined);
    await Promise.all([first, second]);

    // The receiver reports the first song late, then the second.
    run.mediaArrives(run.loads[0]?.contentId ?? "");
    run.mediaArrives(run.loads[1]?.contentId ?? "");
    run.change("currentTime", 3);

    expect(run.taken).toStrictEqual([]);
    expect(run.events.at(-1)).toStrictEqual({ type: "time", positionMs: 3_000 });
  });

  it("loads the song paused when the person pauses while its credential is on its way", async () => {
    const run = castSetup();
    const loading = run.engine.load(source(STREAM), 0, true);

    run.engine.pause();
    run.lends[0]?.settle(CREDENTIAL);
    await settled();

    expect(run.loads[0]?.autoplay).toBe(false);
    run.loads[0]?.answer.settle(undefined);
    await loading;
  });

  it("asks a pause made while the receiver loads of the song, not of the idle receiver before it", async () => {
    const run = castSetup();
    const loading = run.engine.load(source(STREAM), 0, true);

    run.lends[0]?.settle(CREDENTIAL);
    await settled();
    // The load asked to play; the person pauses before the receiver answers, which shows paused.
    run.engine.pause();
    run.loads[0]?.answer.settle(undefined);
    await loading;

    expect(run.engine.samplePlayback().playing).toBe(false);
    expect(run.commands).toStrictEqual([]);

    // The receiver starts the song playing, as the load asked; the pause goes once it shows.
    run.mediaArrives(run.loads[0]?.contentId ?? "");
    run.change("playerState", "PLAYING");
    run.change("isPaused", false);
    await settled();

    expect(run.commands).toStrictEqual(["playOrPause"]);
  });

  it("stops a song the receiver took after the player let go of it", async () => {
    const run = castSetup();
    const loading = run.engine.load(source(STREAM), 0, true);

    run.lends[0]?.settle(CREDENTIAL);
    await settled();
    // Playback moves to another device while the receiver still loads the song.
    run.engine.unload();

    expect(run.commands).toStrictEqual([]);

    run.loads[0]?.answer.settle(undefined);
    await loading;

    expect(run.commands).toStrictEqual(["stop"]);
    expect(run.events).toStrictEqual([]);
  });

  it("drops a failure it learned of after a newer load began", async () => {
    const run = castSetup();
    const hold = deferred<undefined>();

    run.probeHold.current = hold.promise;

    const first = run.engine.load(source(STREAM), 0, true);

    run.lends[0]?.settle(CREDENTIAL);
    await settled();
    run.loads[0]?.answer.settle("LOAD_FAILED");
    await settled();

    // The listener skips while the media server is asked why the first song failed.
    const second = run.engine.load(source(OTHER), 0, true);

    hold.settle(undefined);
    await first;

    expect(run.events.filter((event) => event.type === "error")).toStrictEqual([]);

    run.engine.unload();
    run.lends[1]?.settle(CREDENTIAL);
    await second;
  });

  it("tells its watchers the receiver's volume, as its own remote changes it", () => {
    const run = castSetup();
    const heard: Array<number> = [];
    const stop = run.engine.watchVolume((volume) => heard.push(volume));

    expect(run.engine.volume()).toBe(1);

    run.change("volumeLevel", 0.3);
    stop();
    run.change("volumeLevel", 0.6);

    expect(heard).toStrictEqual([0.3]);
  });

  it("stops the song before when the person skips before the next one reached the receiver", async () => {
    const run = castSetup();
    const first = run.engine.load(source(STREAM), 0, true);

    run.lends[0]?.settle(CREDENTIAL);
    await settled();

    // The skip's load still waits for its credential as the first song lands.
    const second = run.engine.load(source(OTHER), 0, true);

    run.loads[0]?.answer.settle(undefined);
    await first;

    expect(run.commands).toStrictEqual(["stop"]);

    run.lends[1]?.settle(CREDENTIAL);
    await settled();
    run.loads[1]?.answer.settle(undefined);
    await second;

    expect(run.loads.map((load) => load.title)).toStrictEqual(["Song song1", "Song song2"]);
  });

  it("sends the receiver nothing once disposed", async () => {
    const run = castSetup();
    const loading = run.engine.load(source(STREAM), 0, true);

    run.lends[0]?.settle(CREDENTIAL);
    await settled();
    run.engine.dispose();
    run.loads[0]?.answer.settle(undefined);
    await loading;
    run.engine.unload();

    expect(run.commands).toStrictEqual([]);
  });

  it("reads a muted receiver as silent, and a level above silence unmutes it", () => {
    const run = castSetup();
    const heard: Array<number> = [];

    run.engine.watchVolume((volume) => heard.push(volume));
    run.change("isMuted", true);

    expect(run.engine.volume()).toBe(0);
    expect(heard).toStrictEqual([0]);

    run.engine.setVolume(0.4);

    expect(run.commands).toStrictEqual(["volume 0.4", "muteOrUnmute"]);
  });
});
