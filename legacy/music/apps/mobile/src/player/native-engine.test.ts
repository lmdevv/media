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
  /** While set, each seek waits for the test to land it, as AVPlayer's lands a moment later. */
  holdSeeks = false;
  lockScreen: { readonly info: LockScreenInfo | null; readonly live: boolean } | null = null;
  readonly #listeners = new Set<(status: OutputStatus) => void>();
  readonly #heldSeeks: Array<{ readonly land: () => void; readonly refuse: () => void }> = [];

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
    if (this.holdSeeks) {
      await new Promise<void>((resolve, reject) => {
        this.#heldSeeks.push({ land: resolve, refuse: () => reject(new Error("seek refused")) });
      });
    }

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

  /**
   * Lands the held seeks newest first, and each seek the engine asks for meanwhile, until none is
   * left. Nothing makes a player land its seeks in the order they were asked for.
   */
  async landSeeksNewestFirst(): Promise<void> {
    const held = this.#heldSeeks.pop();

    if (held === undefined) return;
    held.land();
    await settled();
    await this.landSeeksNewestFirst();
  }

  /** Fails the oldest held seek, as AVPlayer can when a seek is interrupted. */
  async refuseOldestSeek(): Promise<void> {
    this.#heldSeeks.shift()?.refuse();
    await settled();
  }

  /**
   * Reports the end it reached before a seek moved it back, as AVPlayer can once the seek has
   * landed: paused (an item that ends pauses), where the seek took it.
   */
  reportEndLate(): void {
    this.wantsPlay = false;
    this.#report({ finished: true });
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
      finished: false,
    }),
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
};

/** Resolves once the engine has handled everything already settled. */
const settled = () =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });

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

  it("reports the seek target until the seek lands, never a status from before it", async () => {
    const { engine, media, output, events } = await setup();
    const loaded = engine.load(media.source("a"), 0, true);
    output(0).ready(false);
    await loaded;
    output(0).advance(30_000);
    output(0).holdSeeks = true;
    const before = events.length;

    engine.seek(60_000);
    output(0).advance(250);
    await output(0).landSeeksNewestFirst();
    output(0).advance(250);

    const times = events
      .slice(before)
      .flatMap((event) => (event.type === "time" ? [event.positionMs] : []));

    expect(Math.min(...times)).toBe(60_000);
    expect(times.at(-1)).toBe(60_250);
  });

  it("pauses at the seek target while the seek is still landing", async () => {
    const { engine, media, output, events } = await setup();
    const loaded = engine.load(media.source("a"), 0, true);
    output(0).ready(false);
    await loaded;
    output(0).advance(30_000);
    output(0).holdSeeks = true;

    engine.seek(60_000);
    engine.pause();

    expect(lastTime(events)).toBe(60_000);
  });

  it("lands on the latest of two quick seeks, whichever of the player's seeks lands first", async () => {
    const { engine, media, output, events } = await setup();
    const loaded = engine.load(media.source("a"), 0, true);
    output(0).ready(false);
    await loaded;
    output(0).advance(30_000);
    output(0).holdSeeks = true;

    engine.seek(60_000);
    const before = events.length;
    engine.seek(90_000);
    await output(0).landSeeksNewestFirst();
    output(0).advance(250);

    const times = events
      .slice(before)
      .flatMap((event) => (event.type === "time" ? [event.positionMs] : []));

    expect(output(0).positionMs).toBe(90_250);
    expect(Math.min(...times)).toBe(90_000);
    expect(times.at(-1)).toBe(90_250);
  });

  it("still lands on a newer seek when the running seek fails", async () => {
    const { engine, media, output, events } = await setup();
    const loaded = engine.load(media.source("a"), 0, true);
    output(0).ready(false);
    await loaded;
    output(0).advance(30_000);
    output(0).holdSeeks = true;

    engine.seek(60_000);
    const before = events.length;
    engine.seek(90_000);
    await output(0).refuseOldestSeek();
    await output(0).landSeeksNewestFirst();
    output(0).advance(250);

    const times = events
      .slice(before)
      .flatMap((event) => (event.type === "time" ? [event.positionMs] : []));

    expect(output(0).positionMs).toBe(90_250);
    expect(Math.min(...times)).toBe(90_000);
  });

  it("plays on from a seek back that was landing as the song ended, without moving on", async () => {
    const { engine, media, output, events } = await setup();
    const loaded = engine.load(media.source("a"), 0, true);
    output(0).ready(false);
    await loaded;
    engine.preload(media.source("b"));
    await vi.waitFor(() => expect(output(1).url).toBe(media.source("b").url));
    output(1).ready(false);
    output(0).advance(199_000);
    output(0).holdSeeks = true;

    engine.seek(60_000);
    output(0).finish();
    await output(0).landSeeksNewestFirst();
    output(0).advance(250);

    expect(types(events)).not.toContain("advanced");
    expect(types(events)).not.toContain("ended");
    expect(output(1).wantsPlay).toBe(false);
    expect(output(0).wantsPlay).toBe(true);
    expect(lastTime(events)).toBe(60_250);
  });

  it("plays on from a seek back that landed before the player reported the song's end", async () => {
    const { engine, media, output, events } = await setup();
    const loaded = engine.load(media.source("a"), 0, true);
    output(0).ready(false);
    await loaded;
    engine.preload(media.source("b"));
    await vi.waitFor(() => expect(output(1).url).toBe(media.source("b").url));
    output(1).ready(false);
    output(0).advance(199_000);

    engine.seek(60_000);
    await settled();
    output(0).reportEndLate();
    output(0).advance(250);

    expect(types(events)).not.toContain("advanced");
    expect(output(1).wantsPlay).toBe(false);
    expect(output(0).wantsPlay).toBe(true);
    expect(lastTime(events)).toBe(60_250);
  });

  it("ends the song when a seek that was landing as it ended lands at its end", async () => {
    const { engine, media, output, events } = await setup();
    const loaded = engine.load(media.source("a"), 0, true);
    output(0).ready(false);
    await loaded;
    output(0).advance(199_000);
    output(0).holdSeeks = true;

    engine.seek(199_500);
    output(0).finish();
    await output(0).landSeeksNewestFirst();

    expect(types(events).at(-1)).toBe("ended");
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

  it("opens and preloads downloaded files at once, asking the media service nothing", async () => {
    const { engine, media, outputs, output } = await setup();
    const downloaded = (key: string): EngineSource => ({ ...media.source(key), finished: true });
    // Any question about a finished file would wait here for good.
    media.state.finished = deferred().promise;
    const loaded = engine.load(downloaded("a"), 0, true);
    output(0).ready(false);
    await loaded;

    engine.preload(downloaded("b"));
    await vi.waitFor(() => expect(outputs).toHaveLength(2));

    expect(output(1).url).toBe(downloaded("b").url);
    expect(media.state.finishedAsks).toBe(0);
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
