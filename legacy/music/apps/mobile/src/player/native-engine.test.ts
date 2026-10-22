import { createServer } from "node:http";

import type { EngineEvent, EngineSource } from "@music/player/engine";
import { Schema } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { NativeEngine } from "./native-engine";
import type { AudioOutput, LockScreenInfo, OutputStatus } from "./native-engine";

/**
 * A stand-in for one AVPlayer behind expo-audio. Like AVPlayer it opens paused, waits for data
 * when told to play before it can, ignores seeks in a live stream, and reports every change.
 */
class FakeOutput implements AudioOutput {
  readonly url: string;
  wantsPlay = false;
  loaded = false;
  live = false;
  durationMs = 0;
  positionMs = 0;
  released = false;
  lockScreen: { readonly info: LockScreenInfo | null; readonly live: boolean } | null = null;
  readonly #listeners = new Set<(status: OutputStatus) => void>();

  constructor(url: string) {
    this.url = url;
  }

  play = (): void => {
    this.wantsPlay = true;
    this.#report();
  };

  pause = (): void => {
    this.wantsPlay = false;
    this.#report();
  };

  seek = async (positionMs: number): Promise<void> => {
    if (!this.live) this.positionMs = positionMs;
    this.#report();
  };

  setVolume = (): void => {};

  showOnLockScreen = (info: LockScreenInfo | null, live: boolean): void => {
    this.lockScreen = { info, live };
  };

  subscribe = (listener: (status: OutputStatus) => void): (() => void) => {
    this.#listeners.add(listener);

    return () => this.#listeners.delete(listener);
  };

  release = (): void => {
    this.released = true;
  };

  /** The stream opened: a live one has no length. */
  ready(live: boolean, durationMs = 200_000): void {
    this.loaded = true;
    this.live = live;
    this.durationMs = durationMs;
    this.#report();
  }

  /** Plays on by `ms`. */
  advance(ms: number): void {
    this.positionMs += ms;
    this.#report();
  }

  /** The stream played to its end. Like expo-audio, a live stream reports its end at 0. */
  finish(): void {
    this.wantsPlay = false;
    this.#report({ finished: true, positionMs: this.live ? 0 : this.durationMs });
  }

  fail(message: string): void {
    this.#report({ error: message });
  }

  #report(patch: Partial<OutputStatus> = {}): void {
    const status: OutputStatus = {
      loaded: this.loaded,
      control: this.wantsPlay ? (this.loaded ? "playing" : "waiting") : "paused",
      positionMs: this.positionMs,
      durationMs: this.loaded && !this.live ? this.durationMs : null,
      finished: false,
      error: null,
      ...patch,
    };

    for (const listener of this.#listeners) listener(status);
  }
}

const ListeningAddress = Schema.decodeUnknownSync(Schema.Struct({ port: Schema.Int }));

/** What the media service answers an offset stream (`&start=`) with. */
type OffsetAnswer = "audio" | "busy" | "expired" | "empty";

/**
 * A local media service. A request for the first byte of the finished file waits for
 * `finished` (a song still transcoding); offset streams answer as `offsets` says, in order, the
 * last answer repeating.
 */
const mediaService = async () => {
  const offsets: Array<OffsetAnswer> = ["audio"];
  const state = { finished: Promise.resolve(), offsets, finishedAsks: 0 };

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");

    if (request.headers.range === "bytes=0-0") {
      state.finishedAsks += 1;
      void state.finished.then(() => response.writeHead(206).end("x"));

      return;
    }

    if (url.searchParams.has("start")) {
      const answer = state.offsets.length > 1 ? state.offsets.shift() : state.offsets[0];

      if (answer === "busy") response.writeHead(503, { "Retry-After": "0" }).end();
      else if (answer === "expired") response.writeHead(403).end();
      else if (answer === "empty") response.writeHead(200).end();
      else response.writeHead(200).end("audio");

      return;
    }

    response.writeHead(200).end("audio");
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const { port } = ListeningAddress(server.address());

  return {
    state,
    source: (key: string): EngineSource => ({
      key,
      url: `http://127.0.0.1:${port}/media/stream/${key}?p=aac-320&sig=s`,
      durationMs: 200_000,
    }),
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
};

/** A deferred the test settles by hand. */
const deferred = () => Promise.withResolvers<void>();

const setup = async () => {
  const media = await mediaService();
  const outputs: Array<FakeOutput> = [];
  const events: Array<EngineEvent> = [];

  const engine = new NativeEngine((url) => {
    const output = new FakeOutput(url);

    outputs.push(output);

    return output;
  });

  engine.subscribe((event) => events.push(event));

  const output = (index: number): FakeOutput => {
    const found = outputs[index];

    if (found === undefined) throw new Error(`No player ${index} was opened`);

    return found;
  };

  cleanups.push(() => {
    engine.unload();
    media.close();
  });

  return { engine, media, outputs, output, events };
};

const cleanups: Array<() => void> = [];

const types = (events: ReadonlyArray<EngineEvent>): ReadonlyArray<EngineEvent["type"]> =>
  events.map((event) => event.type);

const lastTime = (events: ReadonlyArray<EngineEvent>): number | null =>
  events.findLast((event) => event.type === "time")?.positionMs ?? null;

describe("NativeEngine", () => {
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
  });

  it("starts a song from the top before its stream opens and reports it playing", async () => {
    const { engine, media, output, events } = await setup();
    const song = media.source("a");

    const loaded = engine.load(song, 0, true);

    expect(output(0)).toMatchObject({ url: song.url, wantsPlay: true });
    output(0).ready(false);
    await loaded;
    output(0).advance(1000);

    expect(types(events)).toContain("playing");
    expect(lastTime(events)).toBe(1000);
  });

  it("opens paused without reporting the pause twice", async () => {
    const { engine, media, output, events } = await setup();

    const loaded = engine.load(media.source("a"), 0, false);
    output(0).ready(false);
    await loaded;
    output(0).pause();

    expect(types(events).filter((type) => type === "paused")).toHaveLength(1);
  });

  it("reports a pause from the lock screen once, and none for its own opening state", async () => {
    const { engine, media, output, events } = await setup();
    const loaded = engine.load(media.source("a"), 0, true);
    output(0).ready(false);
    await loaded;

    output(0).pause();
    output(0).pause();

    expect(types(events).filter((type) => type === "paused")).toHaveLength(1);
  });

  it("seeks within a finished song without opening it again", async () => {
    const { engine, media, outputs, output, events } = await setup();
    const loaded = engine.load(media.source("a"), 0, true);
    output(0).ready(false);
    await loaded;

    engine.seek(60_000);
    await vi.waitFor(() => expect(output(0).positionMs).toBe(60_000));

    expect(outputs).toHaveLength(1);
    expect(lastTime(events)).toBe(60_000);
  });

  it("seeks in a live song by opening it from the offset, counting time from there", async () => {
    const { engine, media, output, events } = await setup();
    const transcoding = deferred();
    media.state.finished = transcoding.promise;
    const loaded = engine.load(media.source("a"), 0, true);
    output(0).ready(true);
    await loaded;

    engine.seek(90_000);
    await vi.waitFor(() => expect(output(1).url).toContain("start=90000"));
    output(1).ready(true);
    await vi.waitFor(() => expect(output(1).wantsPlay).toBe(true));
    output(1).advance(500);

    expect(output(0).released).toBe(true);
    expect(lastTime(events)).toBe(90_500);
    transcoding.resolve();
  });

  it("once the song is finished, seeks in a live stream by opening the file and seeking there", async () => {
    const { engine, media, output } = await setup();
    const song = media.source("a");
    const loaded = engine.load(song, 0, true);
    output(0).ready(true);
    await loaded;
    await vi.waitFor(() => expect(media.state.finishedAsks).toBe(1));
    // The answer is in once the request settles; give its continuation a turn.
    await new Promise((resolve) => setTimeout(resolve, 20));

    engine.seek(90_000);
    await vi.waitFor(() => expect(output(1).url).toBe(song.url));
    output(1).ready(false);

    await vi.waitFor(() =>
      expect(output(1)).toMatchObject({ positionMs: 90_000, wantsPlay: true }),
    );
  });

  it("starts a live song part-way from the offset when playback moves here mid-song", async () => {
    const { engine, media, output } = await setup();
    const transcoding = deferred();
    media.state.finished = transcoding.promise;

    const loaded = engine.load(media.source("a"), 45_000, true);
    output(0).ready(true);
    await vi.waitFor(() => expect(output(1).url).toContain("start=45000"));
    output(1).ready(true);
    await loaded;

    expect(output(1).wantsPlay).toBe(true);
    transcoding.resolve();
  });

  it("preloads the next song only once the server has finished it", async () => {
    const { engine, media, outputs, output } = await setup();
    const transcoding = deferred();
    const loaded = engine.load(media.source("a"), 0, true);
    output(0).ready(false);
    await loaded;
    media.state.finished = transcoding.promise;

    engine.preload(media.source("b"));
    await vi.waitFor(() => expect(media.state.finishedAsks).toBe(2));

    expect(outputs).toHaveLength(1);
    transcoding.resolve();
    await vi.waitFor(() => expect(outputs).toHaveLength(2));
    expect(output(1).wantsPlay).toBe(false);
  });

  it("starts the preloaded song the moment the current one ends", async () => {
    const { engine, media, output, events } = await setup();
    const loaded = engine.load(media.source("a"), 0, true);
    output(0).ready(false);
    await loaded;
    engine.preload(media.source("b"));
    await vi.waitFor(() => expect(output(1).url).toBe(media.source("b").url));
    output(1).ready(false);

    output(0).finish();

    expect(output(1).wantsPlay).toBe(true);
    expect(events).toContainEqual({ type: "advanced", key: "b" });
    expect(lastTime(events)).toBe(0);
    expect(types(events)).not.toContain("ended");
  });

  it("reports the end when nothing is preloaded", async () => {
    const { engine, media, output, events } = await setup();
    const loaded = engine.load(media.source("a"), 0, true);
    output(0).ready(false);
    await loaded;
    output(0).advance(200_000);

    output(0).finish();

    expect(types(events).at(-1)).toBe("ended");
    expect(types(events)).not.toContain("paused");
  });

  it("moves on when a live stream plays to the song's end", async () => {
    const { engine, media, outputs, output, events } = await setup();
    const transcoding = deferred();
    media.state.finished = transcoding.promise;
    const loaded = engine.load(media.source("a"), 0, true);
    output(0).ready(true);
    await loaded;
    output(0).advance(199_750);

    output(0).finish();

    expect(types(events).at(-1)).toBe("ended");
    expect(outputs).toHaveLength(1);
    transcoding.resolve();
  });

  it("carries on where a live stream was cut off before the song ended", async () => {
    const { engine, media, output } = await setup();
    const transcoding = deferred();
    media.state.finished = transcoding.promise;
    const loaded = engine.load(media.source("a"), 0, true);
    output(0).ready(true);
    await loaded;
    output(0).advance(30_000);

    output(0).finish();

    await vi.waitFor(() => expect(output(1).url).toContain("start=30000"));
    transcoding.resolve();
  });

  it("asks a busy media service again after its Retry-After", async () => {
    const { engine, media, output } = await setup();
    const transcoding = deferred();
    media.state.finished = transcoding.promise;
    media.state.offsets = ["busy", "audio"];
    const loaded = engine.load(media.source("a"), 0, true);
    output(0).ready(true);
    await loaded;

    engine.seek(90_000);
    await vi.waitFor(() => expect(output(1).url).toContain("start=90000"));
    output(1).fail("The server is busy");

    await vi.waitFor(() => expect(output(2).url).toContain("start=90000"));
    transcoding.resolve();
  });

  it("reports an expired stream when the media service refuses its URL", async () => {
    const { engine, media, output, events } = await setup();
    const transcoding = deferred();
    media.state.finished = transcoding.promise;
    media.state.offsets = ["expired"];
    const loaded = engine.load(media.source("a"), 0, true);
    output(0).ready(true);
    await loaded;

    engine.seek(90_000);
    await vi.waitFor(() => expect(output(1).url).toContain("start=90000"));
    output(1).fail("Forbidden");

    await vi.waitFor(() =>
      expect(events).toContainEqual(expect.objectContaining({ reason: "expired" })),
    );
    transcoding.resolve();
  });

  it("fails a finished song whose stream fails", async () => {
    const { engine, media, output, events } = await setup();
    const loaded = engine.load(media.source("a"), 0, true);
    output(0).ready(false);
    await loaded;

    output(0).fail("The file is damaged");

    expect(events.at(-1)).toMatchObject({ type: "error", message: "The file is damaged" });
  });

  it("shows the song on the lock screen of the player that plays, live while it has no length", async () => {
    const { engine, media, output } = await setup();
    const info = { title: "Song", artist: "Artist", album: "Album", artworkUrl: null };
    engine.setLockScreen(info);
    const transcoding = deferred();
    media.state.finished = transcoding.promise;
    const loaded = engine.load(media.source("a"), 0, true);

    output(0).ready(true);
    await loaded;
    expect(output(0).lockScreen).toStrictEqual({ info, live: true });

    transcoding.resolve();
    engine.preload(media.source("b"));
    await vi.waitFor(() => expect(output(1).url).toBe(media.source("b").url));
    output(1).ready(false);
    output(0).advance(199_000);
    output(0).finish();

    expect(output(1).lockScreen).toStrictEqual({ info, live: false });
  });
});
