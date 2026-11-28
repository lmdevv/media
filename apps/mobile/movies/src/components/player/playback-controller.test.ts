import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";

import { MEDIA_ROUTES, NegotiateResponse, SeekResponse } from "@media/contracts/media-playback";
import { Brand, Result, Schema } from "effect";
import type { VideoPlayerEvents, VideoPlayerStatus, VideoSource } from "expo-video";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CoreStart } from "@/lib/player/play-session";
import { startedPlay } from "@/lib/player/play-session";
import { PlaybackStop } from "@/lib/player/policy";

import { PlaySource, PlayerController, PlayerPhase } from "./playback-controller";
import type { StreamVideo } from "./playback-controller";

type VideoEvents = Pick<
  VideoPlayerEvents,
  "playingChange" | "statusChange" | "playToEnd" | "timeUpdate" | "sourceLoad"
>;

type Listeners = { [Name in keyof VideoEvents]: Set<VideoEvents[Name]> };

/** The source the controller hands a native player: its URL among other settings. */
const decodeSource = Schema.decodeUnknownSync(Schema.Struct({ uri: Schema.String }));

/** Where a listening server is. */
const decodeAddress = Schema.decodeUnknownSync(Schema.Struct({ port: Schema.Int }));

/**
 * AVPlayer as the controller drives it: it loads, plays once ready if asked to, and fails when
 * told to.
 */
class TestVideo implements StreamVideo {
  currentTime = 0;
  playbackRate = 1;
  playing = false;
  status: VideoPlayerStatus = "loading";
  bufferedPosition = 0;
  timeUpdateEventInterval = 0;
  volume = 1;
  staysActiveInBackground = false;
  showNowPlayingNotification = false;
  allowsExternalPlayback = false;
  released = false;
  /** Asked to play while loading, so it plays once ready. */
  #waitingToPlay = false;
  readonly #listeners: Listeners = {
    playingChange: new Set(),
    statusChange: new Set(),
    playToEnd: new Set(),
    timeUpdate: new Set(),
    sourceLoad: new Set(),
  };

  /** The URL the player opened. */
  readonly uri: string;

  constructor(source: VideoSource) {
    this.uri = decodeSource(source).uri;
  }

  play(): void {
    if (this.status === "readyToPlay") this.#setPlaying(true);
    else this.#waitingToPlay = true;
  }

  pause(): void {
    this.#waitingToPlay = false;
    this.#setPlaying(false);
  }

  #setPlaying(playing: boolean): void {
    if (this.playing === playing) return;
    this.playing = playing;

    for (const listener of this.#listeners.playingChange) listener({ isPlaying: playing });
  }

  release(): void {
    this.released = true;
  }

  addListener<Name extends keyof VideoEvents>(event: Name, listener: VideoEvents[Name]) {
    const set: Set<VideoEvents[Name]> = this.#listeners[event];

    set.add(listener);

    return {
      remove: () => {
        set.delete(listener);
      },
    };
  }

  /** AVPlayer's status changes, with its error when it failed. */
  fireStatus(status: VideoPlayerStatus, message?: string): void {
    this.status = status;

    for (const listener of this.#listeners.statusChange) {
      listener(message === undefined ? { status } : { status, error: { message } });
    }

    if (status === "readyToPlay" && this.#waitingToPlay) this.#setPlaying(true);

    if (status === "error") this.#setPlaying(false);
  }
}

const titleId = Brand.nominal<CoreStart["titleId"]>()("title1");

const fileId = Brand.nominal<CoreStart["file"]["id"]>()("file1");

const coreStart: CoreStart = {
  titleId,
  episodeId: null,
  episode: null,
  file: {
    id: fileId,
    titleId,
    episodeId: null,
    versionName: null,
    sizeBytes: 1_000,
    probe: {
      container: "mkv",
      durationMs: 1_500_000,
      bitRate: null,
      video: [],
      audio: [],
      subtitles: [],
      chapters: [],
    },
    externalSubtitles: [],
    hdr: false,
    trickplay: null,
  },
  resumePositionMs: 0,
  playbackId: "4d1c2a52-0b5e-4f7e-9d6c-8b2f1e3a7c90",
  startedAt: 1_762_000_000_000,
  ticket: "t1.ticket-one",
  expiresAt: 4_102_444_800_000,
};

const encodeStream = Schema.encodeSync(Schema.toCodecJson(NegotiateResponse));

const encodeSeek = Schema.encodeSync(Schema.toCodecJson(SeekResponse));

const decodeStream = Schema.decodeUnknownSync(NegotiateResponse);

const NegotiateBody = Schema.Struct({
  capabilities: Schema.Struct({
    videoCodecs: Schema.Array(
      Schema.Struct({
        codec: Schema.String,
        dynamicRanges: Schema.optional(Schema.Array(Schema.String)),
      }),
    ),
  }),
  startSeconds: Schema.Finite,
  audioStreamIndex: Schema.optional(Schema.Int),
});

const decodeNegotiation = Schema.decodeUnknownSync(Schema.fromJsonString(NegotiateBody));

const StreamBody = Schema.Struct({ streamId: Schema.String });

const decodeStreamBody = Schema.decodeUnknownSync(Schema.fromJsonString(StreamBody));

/** The stream id named `name`, in the 22 characters the service's ids take. */
const idOf = (name: string): string => name.padEnd(22, "0");

/** The playlist of the stream named `name`. */
const playlistOf = (base: string, name: string): string =>
  `${base}/media/hls/${idOf(name)}/1/index.m3u8`;

/** An HLS transcode of the file named `name`, in `codec`, from `startSeconds`. */
const transcode = (base: string, name: string, codec: string, startSeconds = 0) =>
  decodeStream({
    mode: "transcode-qsv",
    url: playlistOf(base, name),
    streamId: idOf(name),
    generation: 1,
    startSeconds,
    durationSeconds: 1500,
    video: { codec, width: 1920, height: 1080, dynamicRange: "sdr" },
    transcode: {
      stages: [{ op: "encode", domain: "qsv", impl: `encode.qsv.${codec}` }],
      changes: [],
    },
    subtitles: [],
    expiresAt: 4_102_444_800_000,
  });

/** A Dolby Vision 5 copy of the file, as the service answers a client that declares it. */
const dolbyVisionCopy = (base: string, name: string, startSeconds = 0) =>
  decodeStream({
    mode: "remux",
    url: playlistOf(base, name),
    streamId: idOf(name),
    generation: 1,
    startSeconds,
    durationSeconds: 1500,
    video: { codec: "hevc", width: 1920, height: 1080, dynamicRange: "dolby-vision" },
    transcode: { source: "dolby-vision-5", stages: [], changes: [] },
    subtitles: [],
    expiresAt: 4_102_444_800_000,
  });

/** One answer of the media service to a negotiation, and how long it takes. */
interface Answer {
  readonly stream: NegotiateResponse;
  readonly delayMs?: number;
}

const bodyOf = (request: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Array<Buffer> = [];

    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });

const servers: Array<Server> = [];

/** Answers `response` with `status` and the JSON text `json`. */
const reply = (response: ServerResponse, status: number, json: string): void => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(json);
};

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

/**
 * A media service over HTTP that answers the n-th negotiation with `answers(base)[n]`, moves a
 * stream within its generation on a seek, and records the negotiations and stops it was sent.
 */
const mediaService = async (answers: (base: string) => ReadonlyArray<Answer>) => {
  const negotiations: Array<typeof NegotiateBody.Type> = [];
  const stops: Array<string> = [];
  const streams = new Map<string, NegotiateResponse>();
  let script: ReadonlyArray<Answer> = [];

  const server = createServer((request, response) => {
    void bodyOf(request).then(async (body) => {
      if (request.url === MEDIA_ROUTES.negotiate) {
        const answer = script[negotiations.length];

        negotiations.push(decodeNegotiation(body));

        if (answer === undefined) return reply(response, 500, '{"message":"no more streams"}');
        streams.set(answer.stream.streamId ?? "", answer.stream);

        if (answer.delayMs !== undefined) {
          await new Promise((resolve) => setTimeout(resolve, answer.delayMs));
        }

        return reply(response, 200, JSON.stringify(encodeStream(answer.stream)));
      }

      if (request.url === MEDIA_ROUTES.seek) {
        const stream = streams.get(decodeStreamBody(body).streamId);

        if (stream?.streamId === undefined) {
          return reply(response, 404, '{"message":"no such stream"}');
        }

        const moved = encodeSeek({
          streamId: stream.streamId,
          generation: stream.generation ?? 1,
          playlistUrl: stream.url,
          mode: stream.mode,
          video: stream.video,
          transcode: stream.transcode ?? { stages: [], changes: [] },
        });

        return reply(response, 200, JSON.stringify(moved));
      }

      if (request.url === MEDIA_ROUTES.stop) stops.push(decodeStreamBody(body).streamId);

      return reply(response, 200, "{}");
    });
  });

  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const base = `http://127.0.0.1:${String(decodeAddress(server.address()).port)}`;

  script = answers(base);

  return { base, negotiations, stops };
};

/** Waits until `check` holds, for at most two seconds. */
const eventually = (check: () => boolean): Promise<void> =>
  vi.waitFor(
    () => {
      expect(check()).toBe(true);
    },
    { timeout: 2000, interval: 10 },
  );

/** A controller of the start against `base`, with every native player it made. */
const playing = (base: string) => {
  const videos: Array<TestVideo> = [];

  const controller = new PlayerController({
    createVideo: (source) => {
      const video = new TestVideo(source);

      videos.push(video);

      return video;
    },
    services: {
      report: () => Promise.resolve({ applied: true, watched: false }),
      sendDiagnostics: () => Promise.resolve(),
    },
    onNewSession: () => undefined,
    quality: "auto",
    intentAt: null,
    play: true,
    background: false,
  });

  const play = Result.getOrThrow(startedPlay(coreStart, base));

  controller.start(PlaySource.Streamed({ play, atMs: 0, audioStreamIndex: null }));

  return { controller, videos };
};

/** The codecs a negotiation said the device plays. */
const codecsOf = (negotiation: typeof NegotiateBody.Type | undefined): ReadonlyArray<string> =>
  negotiation?.capabilities.videoCodecs.map((support) => support.codec) ?? [];

/**
 * AVPlayer cannot decode the HEVC stream: it fails, fails again once the stream reloads, and the
 * controller drops HEVC and negotiates again.
 */
const failTwice = async (videos: ReadonlyArray<TestVideo>, from: number): Promise<void> => {
  await eventually(() => videos.length > from);
  videos[from]?.fireStatus("error", "Cannot Decode");
  await eventually(() => videos.length > from + 1);
  videos[from + 1]?.fireStatus("error", "Cannot Decode");
};

/** The dynamic ranges a negotiation said the device plays HEVC in. */
const hevcRangesOf = (negotiation: typeof NegotiateBody.Type | undefined): ReadonlyArray<string> =>
  negotiation?.capabilities.videoCodecs.find((support) => support.codec === "hevc")
    ?.dynamicRanges ?? [];

describe("PlayerController after a Dolby Vision stream fails", () => {
  it("negotiates once more without Dolby Vision, keeping HEVC, and plays what the service sends", async () => {
    const service = await mediaService((base) => [
      { stream: dolbyVisionCopy(base, "dovi-1") },
      { stream: transcode(base, "hevc-1", "hevc") },
    ]);

    const { controller, videos } = playing(service.base);

    // AVPlayer on a device without a Dolby Vision decoder answers the copy "Cannot Decode".
    await failTwice(videos, 0);
    await eventually(() => videos.length === 3);

    expect(videos[2]?.uri).toBe(playlistOf(service.base, "hevc-1"));
    videos[2]?.fireStatus("readyToPlay");
    controller.showedFrame();

    expect(controller.getSnapshot().phase).toStrictEqual(PlayerPhase.Playing());
    expect(service.negotiations.map(codecsOf)).toStrictEqual([
      ["h264", "hevc"],
      ["h264", "hevc"],
    ]);
    expect(service.negotiations.map(hevcRangesOf)).toStrictEqual([
      ["hdr10", "hlg", "dolby-vision"],
      ["hdr10", "hlg"],
    ]);
    controller.dispose();
  });

  it("ignores the answer to the negotiation without Dolby Vision once the viewer seeked", async () => {
    const service = await mediaService((base) => [
      { stream: dolbyVisionCopy(base, "dovi-1") },
      { stream: transcode(base, "hevc-stale", "hevc"), delayMs: 300 },
      { stream: transcode(base, "hevc-1", "hevc", 600) },
    ]);

    const { controller, videos } = playing(service.base);

    await failTwice(videos, 0);
    await eventually(() => service.negotiations.length === 2);
    controller.seek(600_000);
    await eventually(() => videos.length === 3);

    expect(videos.map((video) => video.uri)).not.toContain(playlistOf(service.base, "hevc-stale"));
    expect(videos[2]?.uri).toBe(playlistOf(service.base, "hevc-1"));
    expect(service.stops).toContain(idOf("hevc-stale"));
    expect(service.negotiations.map(hevcRangesOf)).toStrictEqual([
      ["hdr10", "hlg", "dolby-vision"],
      ["hdr10", "hlg"],
      ["hdr10", "hlg"],
    ]);
    controller.dispose();
  });
});

describe("PlayerController after an HEVC stream fails", () => {
  it("negotiates once more without HEVC, plays the H.264 stream, and keeps HEVC off for the playback", async () => {
    const service = await mediaService((base) => [
      { stream: transcode(base, "hevc-1", "hevc") },
      { stream: transcode(base, "h264-1", "h264") },
      { stream: transcode(base, "h264-2", "h264") },
    ]);

    const { controller, videos } = playing(service.base);

    await failTwice(videos, 0);
    await eventually(() => videos.length === 3);

    const h264 = videos[2];

    expect(h264?.uri).toBe(playlistOf(service.base, "h264-1"));
    h264?.fireStatus("readyToPlay");
    controller.showedFrame();

    expect(controller.getSnapshot().phase).toStrictEqual(PlayerPhase.Playing());
    expect(service.negotiations.map(codecsOf)).toStrictEqual([["h264", "hevc"], ["h264"]]);

    // Another audio track later in the same playback asks without HEVC too.
    controller.selectAudio(2);
    await eventually(() => videos.length === 4);

    expect(service.negotiations.map(codecsOf)).toStrictEqual([
      ["h264", "hevc"],
      ["h264"],
      ["h264"],
    ]);
    expect(service.negotiations[2]?.audioStreamIndex).toBe(2);
    controller.dispose();
  });

  it("stops as unsupported when the H.264 stream fails as well, negotiating no further", async () => {
    const service = await mediaService((base) => [
      { stream: transcode(base, "hevc-1", "hevc") },
      { stream: transcode(base, "h264-1", "h264") },
    ]);

    const { controller, videos } = playing(service.base);

    await failTwice(videos, 0);
    await eventually(() => videos.length === 3);
    // It never played, so AVPlayer cannot decode it either: there is nothing left to drop.
    videos[2]?.fireStatus("error", "Cannot Decode");
    await eventually(() => PlayerPhase.$is("Stopped")(controller.getSnapshot().phase));

    expect(controller.getSnapshot().phase).toStrictEqual(
      PlayerPhase.Stopped({ stop: PlaybackStop.Unsupported() }),
    );
    expect(service.negotiations.map(codecsOf)).toStrictEqual([["h264", "hevc"], ["h264"]]);
    controller.dispose();
  });

  it("ignores the answer to the narrowed negotiation once the viewer seeked, and asks again", async () => {
    const service = await mediaService((base) => [
      { stream: transcode(base, "hevc-1", "hevc") },
      { stream: transcode(base, "h264-stale", "h264"), delayMs: 300 },
      { stream: transcode(base, "h264-1", "h264", 600) },
    ]);

    const { controller, videos } = playing(service.base);

    await failTwice(videos, 0);
    await eventually(() => service.negotiations.length === 2);
    controller.seek(600_000);
    await eventually(() => videos.length === 3);

    expect(videos.map((video) => video.uri)).not.toContain(playlistOf(service.base, "h264-stale"));
    expect(videos[2]?.uri).toBe(playlistOf(service.base, "h264-1"));
    expect(service.stops).toContain(idOf("h264-stale"));
    expect(service.negotiations.map(codecsOf)).toStrictEqual([
      ["h264", "hevc"],
      ["h264"],
      ["h264"],
    ]);
    controller.dispose();
  });

  it("ignores the answer to the narrowed negotiation once the player closed for another title", async () => {
    const service = await mediaService((base) => [
      { stream: transcode(base, "hevc-1", "hevc") },
      { stream: transcode(base, "h264-stale", "h264"), delayMs: 300 },
    ]);

    const { controller, videos } = playing(service.base);

    await failTwice(videos, 0);
    await eventually(() => service.negotiations.length === 2);
    controller.dispose();
    await eventually(() => service.stops.includes(idOf("h264-stale")));

    expect(videos).toHaveLength(2);
  });
});
