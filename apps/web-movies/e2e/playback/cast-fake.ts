/**
 * A scripted stand-in for Google's Cast Web Sender SDK, for driving the web clients' Chromecast
 * support without a device: the movies and music suites cast to it, and so does verify-media's
 * browser host for a page made with `--cast-fake`. Each suite keeps its own copy of this file, the
 * same in both, so each depends only on its own workspace. `installCastFake` adds it to every page
 * before the app runs (`addInitScript`) and answers the app's request for `cast_sender.js` with a
 * script that announces the SDK, so the app's own loader runs as it does against Google's. The
 * fake keeps the SDK's names and constants (read from the real SDK in Chrome: `caststatechanged`,
 * `anyChanged`, `CC1AD845`, …), records what the app sends the receiver, and lets a test play the
 * receiver's part. Like a real receiver it fetches what it is told to play (the playlist and a
 * segment, or a byte range of a direct file) with whatever credential its URLs carry, so a stream
 * the media server closed shows up as a failed fetch, and its state reaches the page a moment
 * after a load, not within the call.
 */
import type { Page } from "@playwright/test";

/** What the app asked the receiver to load. */
interface FakeLoad {
  readonly contentId: string;
  readonly contentType: string;
  readonly streamType: string;
  readonly hlsSegmentFormat: string | null;
  readonly duration: number;
  readonly title: string;
  readonly seriesTitle: string | null;
  /** A song's artist, for music metadata. */
  readonly artist: string | null;
  readonly images: ReadonlyArray<string>;
  readonly tracks: ReadonlyArray<{
    readonly trackId: number;
    readonly url: string;
    readonly contentType: string;
    readonly name: string;
  }>;
  readonly activeTrackIds: ReadonlyArray<number>;
  readonly currentTime: number;
  readonly autoplay: boolean;
}

/** Everything the fake receiver saw, and its state. */
export interface FakeReceiver {
  readonly castState: string;
  readonly loads: ReadonlyArray<FakeLoad>;
  /** Commands from the remote player controller, such as `["seek", 52]`. */
  readonly commands: ReadonlyArray<readonly [string, number | boolean | null]>;
  /** Text tracks shown after loading, one entry per change. */
  readonly trackChanges: ReadonlyArray<ReadonlyArray<number>>;
  /** What the receiver fetched from the media server, and the answers' statuses. */
  readonly fetches: ReadonlyArray<{ readonly url: string; readonly status: number }>;
  /** When the receiver last had its media and reported playing it, in epoch milliseconds. */
  readonly playingAt: number | null;
  readonly currentTime: number;
  readonly isPaused: boolean;
  /** `IDLE`, `PLAYING`, `PAUSED`, or `BUFFERING`, as the receiver last reported. */
  readonly playerState: string;
}

const SDK = String.raw`
(() => {
  const listeners = { context: new Map(), player: new Set() };
  const fake = {
    castState: "NO_DEVICES_AVAILABLE",
    session: null,
    loads: [],
    commands: [],
    trackChanges: [],
    fetches: [],
    current: null,
    // When the receiver last had its media and reported playing it, by the page's clock.
    playingAt: null,
    idleReason: null,
    // Set by \`holdConnection\`: the next connection waits for \`completeConnection\`.
    holdConnection: false,
    completeConnection: null,
    player: {
      isConnected: false,
      isMediaLoaded: false,
      isPaused: true,
      isMuted: false,
      canControlVolume: true,
      duration: 0,
      playerState: "IDLE",
      currentTime: 0,
      volumeLevel: 1,
    },
  };

  const emitContext = (type, event) => {
    for (const handler of listeners.context.get(type) ?? []) handler(event);
  };

  const change = (field, value) => {
    fake.player[field] = value;
    for (const handler of listeners.player) handler({ type: "anyChanged", field, value });
  };

  const setCastState = (castState) => {
    fake.castState = castState;
    emitContext("caststatechanged", { castState });
  };

  const record = async (url, init) => {
    const response = await fetch(url, init).catch(() => ({ status: 0, text: () => "" }));
    fake.fetches.push({ url, status: response.status });
    return response;
  };

  // A receiver fetches the playlist and a segment of an HLS stream, or a range of a direct file.
  // Like a real receiver, an HLS load fetches the playlist, then the segment that covers the time
  // it loads at (segments before a stream's start belong to a generation it never ran).
  const fetchMedia = async (url, hls, atSeconds) => {
    if (!hls) {
      await record(url, { headers: { range: "bytes=0-1023" } });
      return;
    }
    const playlist = await record(url);
    if (playlist.status !== 200) return;
    const lines = (await playlist.text()).split("\n");
    let end = 0;
    let segment;
    for (const line of lines) {
      if (line.startsWith("#EXTINF:")) end += Number.parseFloat(line.slice("#EXTINF:".length));
      else if (line.length > 0 && !line.startsWith("#")) {
        segment = line;
        if (end > atSeconds) break;
      }
    }
    if (segment !== undefined) await record(new URL(segment, url).href);
  };

  const device = { friendlyName: "Living Room TV", capabilities: ["video_out", "audio_out"] };

  const session = {
    getCastDevice: () => device,
    getMediaSession: () => ({
      idleReason: fake.idleReason,
      editTracksInfo: (request, onSuccess) => {
        fake.trackChanges.push([...request.activeTrackIds]);
        onSuccess();
      },
    }),
    loadMedia: (request) => {
      const info = request.media;
      fake.loads.push({
        contentId: info.contentId,
        contentType: info.contentType,
        streamType: info.streamType,
        hlsSegmentFormat: info.hlsSegmentFormat ?? null,
        duration: info.duration,
        title: info.metadata.title,
        seriesTitle: info.metadata.seriesTitle ?? null,
        artist: info.metadata.artist ?? null,
        images: info.metadata.images.map((image) => image.url),
        tracks: info.tracks.map((track) => ({
          trackId: track.trackId,
          url: track.trackContentId,
          contentType: track.trackContentType,
          name: track.name,
        })),
        activeTrackIds: [...request.activeTrackIds],
        currentTime: request.currentTime,
        autoplay: request.autoplay,
      });
      fake.idleReason = null;
      const current = {
        url: info.contentId,
        hls: info.contentType === "application/x-mpegurl",
        at: request.currentTime,
      };
      fake.current = current;
      fake.playingAt = null;
      // The receiver reports its new state a moment later, as the SDK relays it.
      const reported = new Promise((resolve) => setTimeout(resolve, 50)).then(() => {
        change("isMediaLoaded", true);
        change("duration", info.duration);
        change("currentTime", request.currentTime);
        change("playerState", "PLAYING");
        change("isPaused", !request.autoplay);
      });
      const fetched = fetchMedia(current.url, current.hls, current.at);
      // It plays once it has its media and said so; a newer load replaces this one's moment.
      void Promise.all([reported, fetched]).then(() => {
        if (fake.current === current) fake.playingAt = Date.now();
      });
      return fetched.then(() => undefined);
    },
  };

  const context = {
    setOptions: (options) => {
      fake.options = options;
    },
    getCastState: () => fake.castState,
    getCurrentSession: () => fake.session,
    requestSession: () => {
      setCastState("CONNECTING");

      const connect = () => {
        fake.session = session;
        change("isConnected", true);
        emitContext("sessionstatechanged", { sessionState: "SESSION_STARTED" });
        setCastState("CONNECTED");
      };

      if (!fake.holdConnection) {
        connect();
        return Promise.resolve(undefined);
      }

      fake.holdConnection = false;
      return new Promise((resolve) => {
        fake.completeConnection = () => {
          fake.completeConnection = null;
          connect();
          resolve(undefined);
        };
      });
    },
    endCurrentSession: () => window.__castFake.disconnect(),
    addEventListener: (type, handler) => {
      const handlers = listeners.context.get(type) ?? new Set();
      handlers.add(handler);
      listeners.context.set(type, handlers);
    },
    removeEventListener: (type, handler) => listeners.context.get(type)?.delete(handler),
  };

  class RemotePlayer {
    constructor() {
      return fake.player;
    }
  }

  class RemotePlayerController {
    playOrPause() {
      fake.commands.push(["playOrPause", null]);
      change("isPaused", !fake.player.isPaused);
    }
    seek() {
      fake.commands.push(["seek", fake.player.currentTime]);
      change("currentTime", fake.player.currentTime);
    }
    stop() {
      fake.commands.push(["stop", null]);
      change("isMediaLoaded", false);
      change("playerState", "IDLE");
    }
    setVolumeLevel() {
      fake.commands.push(["setVolumeLevel", fake.player.volumeLevel]);
      change("volumeLevel", fake.player.volumeLevel);
    }
    muteOrUnmute() {
      fake.commands.push(["muteOrUnmute", !fake.player.isMuted]);
      change("isMuted", !fake.player.isMuted);
    }
    addEventListener(_type, handler) {
      listeners.player.add(handler);
    }
    removeEventListener(_type, handler) {
      listeners.player.delete(handler);
    }
  }

  class Image {
    constructor(url) {
      this.url = url;
    }
  }

  class MediaInfo {
    constructor(contentId, contentType) {
      this.contentId = contentId;
      this.contentType = contentType;
      this.tracks = [];
    }
  }

  class Track {
    constructor(trackId, type) {
      this.trackId = trackId;
      this.type = type;
    }
  }

  class LoadRequest {
    constructor(media) {
      this.media = media;
      this.autoplay = true;
      this.currentTime = 0;
      this.activeTrackIds = [];
    }
  }

  window.__installCastFake = () => {
    window.chrome = Object.assign(window.chrome ?? {}, {
      cast: {
        AutoJoinPolicy: { ORIGIN_SCOPED: "origin_scoped" },
        Image,
        media: {
          DEFAULT_MEDIA_RECEIVER_APP_ID: "CC1AD845",
          MediaInfo,
          MovieMediaMetadata: class { constructor() { this.metadataType = 1; } },
          TvShowMediaMetadata: class { constructor() { this.metadataType = 2; } },
          MusicTrackMediaMetadata: class { constructor() { this.metadataType = 3; } },
          Track,
          LoadRequest,
          EditTracksInfoRequest: class { constructor(ids) { this.activeTrackIds = ids; } },
        },
      },
    });
    window.cast = {
      framework: {
        CastContext: { getInstance: () => context },
        CastContextEventType: {
          CAST_STATE_CHANGED: "caststatechanged",
          SESSION_STATE_CHANGED: "sessionstatechanged",
        },
        RemotePlayer,
        RemotePlayerController,
        RemotePlayerEventType: { ANY_CHANGE: "anyChanged" },
      },
    };
  };

  window.__castFake = {
    state: () => ({
      castState: fake.castState,
      loads: fake.loads,
      commands: fake.commands,
      trackChanges: fake.trackChanges,
      fetches: fake.fetches,
      playingAt: fake.playingAt,
      currentTime: fake.player.currentTime,
      isPaused: fake.player.isPaused,
      playerState: fake.player.playerState,
    }),
    devicesAppear: () => setCastState("NOT_CONNECTED"),
    holdConnection: () => {
      fake.holdConnection = true;
    },
    completeConnection: () => fake.completeConnection?.(),
    advanceTo: (seconds) => change("currentTime", seconds),
    finish: () => {
      fake.idleReason = "FINISHED";
      change("playerState", "IDLE");
    },
    /** The receiver stops because its media failed, as a download error leaves it. */
    fail: () => {
      fake.idleReason = "ERROR";
      change("playerState", "IDLE");
    },
    /** Fetches what the receiver plays again, as it does while playing on. */
    refetch: () =>
      fake.current === null
        ? Promise.resolve()
        : fetchMedia(fake.current.url, fake.current.hls, fake.current.at),
    disconnect: () => {
      fake.session = null;
      // The mirror's time resets before it reports the disconnect: the order that loses most.
      change("currentTime", 0);
      change("isConnected", false);
      change("isMediaLoaded", false);
      emitContext("sessionstatechanged", { sessionState: "SESSION_ENDED" });
      setCastState("NOT_CONNECTED");
    },
  };
})();
`;

/** The script Google's loader URL answers with: install the fake, then say casting is available. */
const LOADER = "window.__installCastFake(); window.__onGCastApiAvailable(true);";

/** Puts the fake SDK into every page of `page`'s context. */
export const installCastFake = async (page: Page): Promise<void> => {
  await page.addInitScript({ content: SDK });
  await page.route("https://www.gstatic.com/cv/js/sender/v1/cast_sender.js*", (route) =>
    route.fulfill({ contentType: "text/javascript", body: LOADER }),
  );
};

/** Plays the receiver's part: `action` is a fake control such as `devicesAppear`. */
export const castFake = (
  page: Page,
  action:
    | "devicesAppear"
    | "holdConnection"
    | "completeConnection"
    | "finish"
    | "fail"
    | "disconnect"
    | "refetch",
): Promise<void> => page.evaluate(`window.__castFake.${action}()`);

/** Moves the fake receiver's playback position. */
export const advanceReceiver = (page: Page, seconds: number): Promise<void> =>
  page.evaluate(`window.__castFake.advanceTo(${String(seconds)})`);

/** What the fake receiver saw so far. */
export const receiver = (page: Page): Promise<FakeReceiver> =>
  page.evaluate("window.__castFake.state()");
