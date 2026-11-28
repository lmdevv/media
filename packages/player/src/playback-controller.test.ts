import { createServer } from "node:http";

import { Schema } from "effect";
import { describe, expect, it, vi } from "vitest";

import {
  BASE,
  NOT_DOWNLOADED,
  copyUrl,
  entry,
  names,
  queueOf,
  settle,
  setup,
} from "./testing/controller-harness";

const ListeningAddress = Schema.decodeUnknownSync(Schema.Struct({ port: Schema.Int }));

/** A media server whose health check answers while `healthy` is set, and fails while it is not. */
const mediaServer = async () => {
  const state = { healthy: true };

  const server = createServer((request, response) => {
    response.writeHead(request.url === "/api/health" && state.healthy ? 200 : 503).end();
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const { port } = ListeningAddress(server.address());

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    state,
    close: () => {
      server.close();
    },
  };
};

const one = entry("a", "1");

const two = entry("b", "2");

const three = entry("c", "3");

/**
 * Plays A until the media server stops answering, runs `during` through the outage, and waits
 * until playback starts again once the server is back.
 */
const outage = async (during: (run: ReturnType<typeof setup>) => Promise<void>) => {
  const media = await mediaServer();
  const run = setup({ playCurrent: "1", baseUrl: media.baseUrl });

  try {
    await run.controller.playTracks(["a", "b"], 0);
    run.controller.sync(queueOf([one, two], "1"));
    await settle();
    run.engine().emit({ type: "time", positionMs: 60_000 });
    media.state.healthy = false;
    run.engine().emit({ type: "error", reason: "network", message: "network" });

    await vi.waitFor(() => {
      expect(run.controller.getSnapshot().mediaOnline).toBe(false);
    });

    await during(run);
    media.state.healthy = true;

    await vi.waitFor(
      () => {
        expect(run.controller.getSnapshot().engineStatus).toBe("playing");
      },
      { timeout: 5000 },
    );

    return run;
  } finally {
    run.stop();
    media.close();
  }
};

describe("PlaybackController", () => {
  it("reports a tap's pause at once, while the bar and the next tap follow the engine's events", async () => {
    const { controller, engine } = setup({ playCurrent: "1", heldPlayState: true });

    await controller.playTracks(["a", "b"], 0);
    controller.sync(queueOf([one, two], "1"));
    await settle();
    engine().answer();

    await controller.togglePlay();

    expect(controller.reportedHere()).toMatchObject({ playing: false });
    expect(controller.playingHere()).toMatchObject({ playing: true });
    expect(controller.getSnapshot().engineStatus).toBe("playing");

    // The bar still shows Pause, and a tap on it pauses, as it says.
    await controller.togglePlay();

    expect(engine().samplePlayback().playing).toBe(false);

    engine().answer();
    await settle();

    expect(controller.getSnapshot().engineStatus).toBe("paused");
    expect(controller.playingHere()).toMatchObject({ playing: false });
  });

  it("plays a new queue with a ticket for its song, and records the play once", async () => {
    const { controller, record, sent } = setup({ playCurrent: "1" });

    await controller.playTracks(["a", "b"], 0);
    controller.sync(queueOf([one, two], "1"));
    await settle();

    expect(record.loads.map((load) => load.url)).toStrictEqual([
      `${BASE}/media/music/stream/a?ticket=t1&p=original`,
    ]);
    expect(controller.getSnapshot().engineStatus).toBe("playing");
    expect(names(sent)).toStrictEqual(["play:a,b,0", "start:a", "report:a,p1"]);
  });

  it("sends shuffle inside the one play command, and leaves it out when the play keeps it", async () => {
    const { controller, sent } = setup({ playCurrent: "1" });

    await controller.playTracks(["a", "b", "c"], 2, true);
    await controller.playTracks(["a", "b"], 0, false);
    await controller.playTracks(["a"], 0);
    await settle();

    expect(names(sent).filter((call) => call.startsWith("play:"))).toStrictEqual([
      "play:a,b,c,2,true",
      "play:a,b,0,false",
      "play:a,0",
    ]);
  });

  it("asks for the first song's ticket while the queue is written, and plays it before the new queue arrives", async () => {
    const { controller, record, sent, lookups, gates } = setup({ playCurrent: "1" });

    gates.play.holding = true;
    const playing = controller.playTracks(["a", "b"], 0);
    await settle();

    expect(lookups).toStrictEqual(["a"]);
    expect(names(sent)).toStrictEqual(["play:a,b,0", "start:a"]);
    expect(record.loads).toHaveLength(0);

    gates.play.release("play");
    await playing;
    await settle();

    expect(record.loads.map((load) => load.url)).toStrictEqual([
      `${BASE}/media/music/stream/a?ticket=t1&p=original`,
    ]);
    expect(controller.getSnapshot()).toMatchObject({ current: "1", engineStatus: "playing" });

    controller.sync(queueOf([one, two], "1"));
    await settle();

    expect(record.loads).toHaveLength(1);
    expect(names(sent)).toStrictEqual(["play:a,b,0", "start:a", "report:a,p1"]);
  });

  it("plays nothing it asked for ahead when the queue command fails, and keeps the song playing", async () => {
    const { controller, record, gates } = setup({ playCurrent: "1" });

    await controller.playTracks(["a"], 0);
    controller.sync(queueOf([one], "1"));
    await settle();
    gates.play.holding = true;
    const playing = controller.playTracks(["b"], 0);
    await settle();
    gates.play.fail("play", "The queue is full");
    await playing;
    await settle();

    expect(record.loads.map((load) => load.url)).toStrictEqual([
      `${BASE}/media/music/stream/a?ticket=t1&p=original`,
    ]);
    expect(controller.getSnapshot()).toMatchObject({
      current: "1",
      engineStatus: "playing",
      error: "The queue is full",
    });
  });

  it("starts a new queue paused when the listener pauses while it is written", async () => {
    const run = setup({ playCurrent: "1" });

    await run.controller.playTracks(["a", "b"], 0);
    run.controller.sync(queueOf([one, two], "1"));
    await settle();
    run.gates.play.holding = true;
    run.answer.current = "3";
    const replacing = run.controller.playTracks(["c"], 0);
    await settle();
    await run.controller.togglePlay();
    run.gates.play.release("play");
    await replacing;
    run.controller.sync(queueOf([three], "3"));
    await settle();

    expect(run.controller.playingHere()).toMatchObject({ trackId: "c", playing: false });
    expect(run.controller.getSnapshot().engineStatus).toBe("paused");
  });

  it("still starts a new queue playing when the old queue ends while it is written", async () => {
    const run = setup({ playCurrent: "1" });

    await run.controller.playTracks(["a"], 0);
    run.controller.sync(queueOf([one], "1"));
    await settle();
    run.gates.play.holding = true;
    run.answer.current = "3";
    const replacing = run.controller.playTracks(["c"], 0);
    await settle();
    run.engine().finish();
    run.gates.play.release("play");
    await replacing;
    run.controller.sync(queueOf([three], "3"));
    await settle();

    expect(run.controller.playingHere()).toMatchObject({ trackId: "c", playing: true });
    expect(run.controller.getSnapshot().engineStatus).toBe("playing");
  });

  it("starts a new queue where and as its newest ask says when the queue loaded its song before the write answered", async () => {
    const run = setup({ playCurrent: "1" });
    const asked = { now: { positionMs: 0, playing: true } };

    run.gates.play.holding = true;
    const replacing = run.controller.playTracksAt(["a", "b"], () => asked.now);
    await settle();
    asked.now = { positionMs: 30_000, playing: false };
    // Convex can show a mutation's writes to its subscriptions before it answers the mutation.
    run.controller.sync(queueOf([one, two], "1"));
    await settle();
    run.gates.play.release("play");
    await replacing;
    await settle();

    expect(run.engine().samplePlayback()).toStrictEqual({ positionMs: 30_000, playing: false });
    expect(run.controller.playingHere()).toMatchObject({
      trackId: "a",
      playing: false,
      positionMs: 30_000,
    });
  });

  it("pauses a new queue's first song on its way here when the listener taps pause", async () => {
    const run = setup({ playCurrent: "1" });

    run.gates.start.holding = true;
    await run.controller.playTracks(["a", "b"], 0);
    await settle();
    await run.controller.togglePlay();
    run.gates.start.release("a");
    await settle();

    expect(run.controller.playingHere()).toMatchObject({ trackId: "a", playing: false });
    expect(run.controller.getSnapshot().engineStatus).toBe("paused");
  });

  it("starts a new queue's first song on its way here where the listener seeks", async () => {
    const run = setup({ playCurrent: "1" });

    run.gates.start.holding = true;
    await run.controller.playTracks(["a", "b"], 0);
    await settle();
    run.controller.seek(30_000);
    run.gates.start.release("a");
    await settle();

    expect(run.record.loads.map((load) => load.startMs)).toStrictEqual([30_000]);
    expect(run.controller.playingHere()).toMatchObject({ trackId: "a", playing: true });
  });

  it("drops a song asked for ahead once a later play replaced it", async () => {
    const { controller, record, gates } = setup({ playCurrent: "1" });

    gates.play.holding = true;
    const first = controller.playTracks(["a"], 0);
    const second = controller.playTracks(["c"], 0);
    await settle();
    gates.play.release("play");
    await first;
    await settle();

    expect(record.loads).toHaveLength(0);

    gates.play.release("play");
    await second;
    await settle();

    expect(record.loads.map((load) => load.url)).toStrictEqual([
      `${BASE}/media/music/stream/c?ticket=t2&p=original`,
    ]);
  });

  it("asks again for a ticket asked for ahead that is due for renewal by the time it loads", async () => {
    const { controller, record, clock, gates } = setup({ playCurrent: "1", ticketMs: 1000 });

    gates.play.holding = true;
    const playing = controller.playTracks(["a"], 0);
    await settle();
    clock.now += 600;
    gates.play.release("play");
    await playing;
    await settle();

    expect(record.loads.map((load) => load.url)).toStrictEqual([
      `${BASE}/media/music/stream/a?ticket=t2&p=original`,
    ]);
  });

  it("keeps the song asked for ahead through a load of the old queue's song meanwhile", async () => {
    const { controller, record, sent, gates } = setup({ playCurrent: "9" });

    gates.play.holding = true;
    const playing = controller.playTracks(["b"], 0);
    await settle();
    controller.sync(queueOf([one], "1"));
    await settle();
    gates.play.release("play");
    await playing;
    await settle();

    expect(record.loads.at(-1)?.url).toBe(`${BASE}/media/music/stream/b?ticket=t1&p=original`);
    expect(names(sent).filter((name) => name.startsWith("start"))).toStrictEqual([
      "start:b",
      "start:a",
    ]);
  });

  it("loads the new queue's own song when its first entry holds another than the one guessed", async () => {
    const { controller, record } = setup({ playCurrent: "1" });

    await controller.playTracks(["a", "b"], 0);
    await settle();
    controller.sync(queueOf([entry("b", "1")], "1"));
    await settle();

    expect(record.loads.map((load) => load.url)).toStrictEqual([
      `${BASE}/media/music/stream/a?ticket=t1&p=original`,
      `${BASE}/media/music/stream/b?ticket=t2&p=original`,
    ]);
    expect(controller.getSnapshot()).toMatchObject({ current: "1", engineStatus: "playing" });
  });

  it("plays a downloaded copy of the song guessed only once the new queue names that song", async () => {
    const { controller, record, sent } = setup({ playCurrent: "1", copies: ["a"] });

    await controller.playTracks(["a", "b"], 0);
    await settle();

    expect(record.loads).toHaveLength(0);

    controller.sync(queueOf([one, two], "1"));
    await settle();

    expect(record.loads.map((load) => load.url)).toStrictEqual([copyUrl("a")]);
    expect(controller.getSnapshot()).toMatchObject({ current: "1", engineStatus: "playing" });
    expect(names(sent).filter((name) => name.startsWith("start"))).toStrictEqual([]);
  });

  it("never plays the downloaded song guessed when the core opened the new queue on another", async () => {
    // The core passes over a song whose file went missing on the server, which a copy on this
    // device can't tell.
    const { controller, record } = setup({ playCurrent: "1", copies: ["a"] });

    await controller.playTracks(["a", "b"], 0);
    await settle();
    controller.sync(queueOf([entry("b", "1")], "1"));
    await settle();

    expect(record.loads.map((load) => load.url)).toStrictEqual([
      `${BASE}/media/music/stream/b?ticket=t1&p=original`,
    ]);
    expect(controller.getSnapshot()).toMatchObject({ current: "1", engineStatus: "playing" });
  });

  it("stops playing a downloaded copy that fails to play and streams the song instead", async () => {
    const { controller, record, discarded } = setup({
      playCurrent: "1",
      copies: ["a"],
      broken: ["a"],
    });

    await controller.playTracks(["a", "b"], 0);
    controller.sync(queueOf([one, two], "1"));
    await settle();

    expect(discarded).toStrictEqual([copyUrl("a")]);
    expect(record.loads.map((load) => load.url)).toStrictEqual([
      copyUrl("a"),
      `${BASE}/media/music/stream/a?ticket=t1&p=original`,
    ]);
    expect(controller.getSnapshot()).toMatchObject({
      current: "1",
      engineStatus: "playing",
      error: null,
    });
  });

  it("skips a downloaded copy that fails to play while the server can't be reached", async () => {
    const { controller, record, sent, discarded } = setup({
      playCurrent: "1",
      copies: ["a", "c"],
      broken: ["a"],
      offline: true,
    });

    await controller.playTracks(["a", "c"], 0);
    controller.sync(queueOf([one, three], "1"));
    await settle();

    expect(discarded).toStrictEqual([copyUrl("a")]);
    expect(record.loads.map((load) => load.url)).toStrictEqual([copyUrl("a"), copyUrl("c")]);
    expect(names(sent).filter((name) => name.startsWith("jump"))).toStrictEqual(["jump:3"]);
    expect(controller.getSnapshot()).toMatchObject({ current: "3", engineStatus: "playing" });
  });

  it("shows why a song can't play offline when no song follows it", async () => {
    const { controller, sent } = setup({
      playCurrent: "1",
      copies: ["a"],
      broken: ["a"],
      offline: true,
    });

    await controller.playTracks(["a"], 0);
    controller.sync(queueOf([one], "1"));
    await settle();

    expect(names(sent).filter((name) => name.startsWith("jump"))).toStrictEqual([]);
    expect(controller.getSnapshot()).toMatchObject({
      current: "1",
      engineStatus: "error",
      error: NOT_DOWNLOADED,
    });
  });

  it("stops on a repeating queue none of whose songs can play offline", async () => {
    const { controller, record, sent } = setup({
      playCurrent: "1",
      copies: ["a", "b"],
      broken: ["a", "b"],
      offline: true,
    });

    await controller.playTracks(["a", "b"], 0);
    controller.sync(queueOf([one, two], "1", { repeat: "all" }));
    await settle();

    expect(record.loads.map((load) => load.url)).toStrictEqual([copyUrl("a"), copyUrl("b")]);
    expect(names(sent).filter((name) => name.startsWith("jump"))).toStrictEqual(["jump:2"]);
    expect(controller.getSnapshot()).toMatchObject({
      current: "2",
      engineStatus: "error",
      error: NOT_DOWNLOADED,
    });
  });

  it("skips again in a new queue, whatever entries an earlier queue skipped", async () => {
    const { controller, record } = setup({ playCurrent: "2", copies: ["b"], offline: true });

    controller.sync(queueOf([entry("d", "1")], "1"));
    await controller.togglePlay();
    await settle();

    expect(controller.getSnapshot()).toMatchObject({
      engineStatus: "error",
      error: NOT_DOWNLOADED,
    });

    await controller.playTracks(["e", "b"], 0);
    controller.sync(queueOf([entry("e", "2"), entry("b", "1")], "2"));
    await settle();

    expect(record.loads.map((load) => load.url)).toStrictEqual([copyUrl("b")]);
    expect(controller.getSnapshot()).toMatchObject({ current: "1", engineStatus: "playing" });
  });

  it("moves to the next entry at once and keeps it while the core confirms", async () => {
    const { controller, record, sent } = setup({ playCurrent: "1" });

    await controller.playTracks(["a", "b"], 0);
    controller.sync(queueOf([one, two], "1"));
    await settle();
    await controller.next();
    await settle();

    expect(controller.getSnapshot().current).toBe("2");
    expect(record.loads.at(-1)?.url).toContain("/stream/b?");
    expect(names(sent)).toContain("jump:2");

    controller.sync(queueOf([one, two], "1"));
    await settle();

    expect(controller.getSnapshot().current).toBe("2");
    expect(record.loads).toHaveLength(2);

    controller.sync(queueOf([one, two], "2"));
    await settle();

    expect(controller.getSnapshot().current).toBe("2");
    expect(record.loads).toHaveLength(2);
  });

  it("follows a move made elsewhere: loads it while playing, shows it while paused", async () => {
    const playing = setup({ playCurrent: "1" });

    await playing.controller.playTracks(["a", "b"], 0);
    playing.controller.sync(queueOf([one, two], "1"));
    await settle();
    playing.controller.sync(queueOf([one, two], "2"));
    await settle();

    expect(playing.record.loads.at(-1)?.url).toContain("/stream/b?");
    expect(playing.controller.getSnapshot().engineStatus).toBe("playing");

    const paused = setup();

    paused.controller.sync(queueOf([one, two], "1"));
    paused.controller.sync(queueOf([one, two], "2"));
    await settle();

    expect(paused.controller.getSnapshot().current).toBe("2");
    expect(paused.record.loads).toHaveLength(0);
  });

  it("starts the paused song where this browser left it", async () => {
    const { controller, record } = setup({ resume: { itemId: "1", positionMs: 42_000 } });

    controller.sync(queueOf([one, two], "1"));

    expect(controller.positionMs()).toBe(42_000);

    await controller.togglePlay();
    await settle();

    expect(record.loads.at(-1)?.startMs).toBe(42_000);
  });

  it("starts a new song at its start however long its ticket took", async () => {
    const { controller, record, clock, gates } = setup({ playCurrent: "1" });

    gates.start.holding = true;
    await controller.playTracks(["a", "b"], 0);
    controller.sync(queueOf([one, two], "1"));
    await settle();
    clock.now += 5000;
    gates.start.release("a");
    await settle();

    expect(record.loads.map((load) => load.startMs)).toStrictEqual([0]);
  });

  it("resumes where the song stopped however long its ticket took", async () => {
    const { controller, record, clock, gates } = setup({
      resume: { itemId: "1", positionMs: 42_000 },
    });

    gates.start.holding = true;
    controller.sync(queueOf([one, two], "1"));
    const playing = controller.togglePlay();
    await settle();
    clock.now += 5000;
    gates.start.release("a");
    await playing;
    await settle();

    expect(record.loads.map((load) => load.startMs)).toStrictEqual([42_000]);
  });

  it("goes back within the first seconds and starts the song again after", async () => {
    const { controller, record, clock, engine } = setup({ playCurrent: "2" });

    await controller.playTracks(["a", "b"], 1);
    controller.sync(queueOf([one, two], "2"));
    await settle();

    engine().emit({ type: "time", positionMs: 10_000 });
    clock.monotonic += 1;
    await controller.previous();

    expect(record.seeks.at(-1)).toBe(0);
    expect(controller.getSnapshot().current).toBe("2");

    engine().emit({ type: "time", positionMs: 1000 });
    await controller.previous();
    await settle();

    expect(controller.getSnapshot().current).toBe("1");
  });

  it("plays the song again with a new start when repeat is one", async () => {
    const { controller, sent, engine } = setup({ playCurrent: "1" });

    await controller.playTracks(["a"], 0);
    controller.sync(queueOf([one], "1", { repeat: "one" }));
    await settle();
    engine().emit({ type: "ended" });
    await settle();

    expect(names(sent).filter((call) => call.startsWith("report"))).toStrictEqual([
      "report:a,p1",
      "report:a,p2",
    ]);
  });

  it("stops at the start of the last song when the queue runs out", async () => {
    const { controller, engine, saved } = setup({ playCurrent: "1" });

    await controller.playTracks(["a"], 0);
    controller.sync(queueOf([one], "1"));
    await settle();
    engine().emit({ type: "ended" });
    await settle();

    expect(controller.getSnapshot().engineStatus).toBe("paused");
    expect(controller.positionMs()).toBe(0);
    expect(saved.at(-1)).toBeNull();
  });

  it("asks for a fresh ticket once after a refusal, then shows the error", async () => {
    const { controller, record } = setup({ playCurrent: "1" });

    record.refuse = 2;
    await controller.playTracks(["a"], 0);
    controller.sync(queueOf([one], "1"));
    await settle();

    expect(record.loads.map((load) => load.url)).toStrictEqual([
      `${BASE}/media/music/stream/a?ticket=t1&p=original`,
      `${BASE}/media/music/stream/a?ticket=t2&p=original`,
    ]);

    expect(controller.getSnapshot()).toMatchObject({
      engineStatus: "error",
      error: "The media server refused this song's stream",
    });
  });

  it("renews a ticket before it expires when playback resumes", async () => {
    const { controller, record, clock } = setup({ playCurrent: "1", ticketMs: 60_000 });

    await controller.playTracks(["a"], 0);
    controller.sync(queueOf([one], "1"));
    await settle();
    await controller.togglePlay();
    clock.now += 31_000;
    await controller.togglePlay();
    await settle();

    expect(record.loads.map((load) => load.url.match(/ticket=(\w+)/u)?.[1])).toStrictEqual([
      "t1",
      "t2",
    ]);
  });

  it("plays through the gapless engine, and through HTML audio with gapless off", () => {
    expect(setup({ mse: true }).record.created).toStrictEqual(["mse"]);
    expect(setup({ mse: true, gapless: false }).record.created).toStrictEqual(["html"]);
  });

  it("loads the following song ahead and moves the core along when the engine advances", async () => {
    const { controller, record, sent, engine } = setup({ mse: true, playCurrent: "1" });

    await controller.playTracks(["a", "b", "c"], 0);
    controller.sync(queueOf([one, two, three], "1"));
    await settle();
    engine().emit({ type: "time", positionMs: 190_000 });
    await settle();

    expect(record.preloads.at(-1)?.url).toContain("/stream/b?");

    engine().emit({ type: "advanced", key: record.preloads.at(-1)?.key ?? "" });
    await settle();

    expect(controller.getSnapshot().current).toBe("2");
    expect(names(sent).slice(-2)).toStrictEqual(["report:b,p2", "jump:2"]);
  });

  it("shows position only for its queue entry and publishes consecutive seeks immediately", async () => {
    const { controller, engine, stop } = setup({ mse: true, playCurrent: "1" });
    const readPosition = (itemId: string): number => controller.sampledPositionMs(itemId);

    try {
      await controller.playTracks(["a", "b"], 0);
      controller.sync(queueOf([one, two], "1"));
      await settle();
      engine().emit({ type: "time", positionMs: 190_000 });
      await settle();

      expect(readPosition(one.itemId)).toBe(190_000);
      expect(readPosition(two.itemId)).toBe(0);

      engine().finish();
      expect(controller.getSnapshot().current).toBe(two.itemId);
      engine().emit({ type: "time", positionMs: 1500 });
      await controller.togglePlay();

      expect(readPosition(one.itemId)).toBe(0);
      expect(readPosition(two.itemId)).toBe(1500);

      let shown = readPosition(two.itemId);

      const unsubscribe = controller.onPosition(() => {
        shown = readPosition(two.itemId);
      });

      controller.seek(0);
      expect(shown).toBe(0);
      controller.seek(shown + 1000);
      expect(shown).toBe(1000);
      expect(engine().samplePlayback().positionMs).toBe(1000);
      unsubscribe();
    } finally {
      stop();
    }
  });

  it("empties the player with the queue", async () => {
    const { controller, record } = setup({ playCurrent: "1" });

    await controller.playTracks(["a"], 0);
    controller.sync(queueOf([one], "1"));
    await settle();
    controller.sync(queueOf([], null));

    expect(controller.getSnapshot()).toMatchObject({ current: null, engineStatus: "idle" });
    expect(record.loads).toHaveLength(1);
  });

  it("asks for a new ticket when Play is pressed after the first one failed", async () => {
    const { controller, record, gates } = setup({ playCurrent: "1" });

    gates.start.holding = true;
    await controller.playTracks(["a"], 0);
    controller.sync(queueOf([one], "1"));
    await settle();
    gates.start.fail("a", "The server is busy");
    await settle();

    expect(controller.getSnapshot()).toMatchObject({
      engineStatus: "error",
      error: "The server is busy",
    });

    gates.start.holding = false;
    await controller.togglePlay();
    await settle();

    expect(record.loads.map((load) => load.url)).toStrictEqual([
      `${BASE}/media/music/stream/a?ticket=t2&p=original`,
    ]);
    expect(controller.getSnapshot()).toMatchObject({ engineStatus: "playing", error: null });
  });

  it("keeps the song skipped to playing when the skipped song's ticket fails later", async () => {
    const { controller, gates } = setup({ playCurrent: "1" });

    gates.start.holding = true;
    await controller.playTracks(["a", "b"], 0);
    controller.sync(queueOf([one, two], "1"));
    await settle();
    await controller.next();
    gates.start.release("b");
    await settle();
    gates.start.fail("a", "Song a is gone");
    await settle();

    expect(controller.getSnapshot()).toMatchObject({
      current: "2",
      engineStatus: "playing",
      error: null,
    });
  });

  it("stops the song before when the next song's ticket fails", async () => {
    const { controller, gates, engine } = setup({ playCurrent: "1" });

    await controller.playTracks(["a", "b"], 0);
    controller.sync(queueOf([one, two], "1"));
    await settle();
    gates.start.holding = true;
    await controller.next();
    gates.start.fail("b", "Song b is gone");
    await settle();

    expect(engine().samplePlayback().playing).toBe(false);
    expect(controller.getSnapshot()).toMatchObject({
      current: "2",
      engineStatus: "error",
      error: "Song b is gone",
    });
  });

  it("primes idle output at once for a play that starts after an await, never playing output", async () => {
    const { controller, record } = setup({ playCurrent: "1" });

    controller.primeOutput();

    expect(record.unlocks).toBe(1);

    await controller.playTracks(["a"], 0);
    controller.sync(queueOf([one], "1"));
    await settle();
    const unlocks = record.unlocks;

    controller.primeOutput();

    expect(record.unlocks).toBe(unlocks);
  });

  it("ignores the outgoing song's engine events while the next song's ticket is out", async () => {
    const { controller, record, sent, gates, engine } = setup({ playCurrent: "1" });

    await controller.playTracks(["a", "b", "c"], 0);
    controller.sync(queueOf([one, two, three], "1"));
    await settle();
    gates.start.holding = true;
    await controller.jump("2");
    controller.sync(queueOf([one, two, three], "2"));

    // Song a keeps sounding until b's ticket answers: its position, its error, and its end all
    // belong to a, not to b, which has not started.
    engine().emit({ type: "time", positionMs: 150_000 });
    engine().emit({ type: "error", reason: "decode", message: "a failed" });
    engine().finish();
    await settle();

    expect(controller.positionMs()).toBe(0);
    expect(controller.getSnapshot()).toMatchObject({
      current: "2",
      engineStatus: "loading",
      error: null,
    });
    expect(names(sent).filter((name) => name.startsWith("jump"))).toStrictEqual(["jump:2"]);

    gates.start.release("b");
    await settle();

    expect(record.played.at(-1)).toContain("/stream/b?ticket=t2");
    expect(controller.getSnapshot()).toMatchObject({ current: "2", engineStatus: "playing" });
  });

  it("loads the next song paused when a pause reached the player as the song ended", async () => {
    const { controller, sent, engine } = setup({ playCurrent: "1" });

    await controller.playTracks(["a", "b"], 0);
    controller.sync(queueOf([one, two], "1"));
    await settle();
    await controller.togglePlay();
    engine().finish();
    await settle();

    expect(names(sent)).toContain("jump:2");
    expect(controller.getSnapshot()).toMatchObject({ current: "2", engineStatus: "paused" });
    expect(controller.playingHere()).toMatchObject({ trackId: "b", playing: false });
  });

  it("keeps a system pause the output applied itself, so a song moved on elsewhere loads paused", async () => {
    const { controller, engine, systemControls } = setup({ playCurrent: "1" });

    await controller.playTracks(["a", "b"], 0);
    controller.sync(queueOf([one, two], "1"));
    await settle();
    engine().emit({ type: "paused" });
    systemControls.handlers?.pause();
    controller.sync(queueOf([one, two], "2"));
    await settle();

    expect(controller.playingHere()).toMatchObject({ trackId: "b", playing: false });
    expect(controller.getSnapshot().engineStatus).toBe("paused");
  });

  it("takes a system play the output applied itself to the engine too, as a tap's play", async () => {
    const { controller, engine, record, systemControls } = setup({ playCurrent: "1" });

    await controller.playTracks(["a", "b"], 0);
    controller.sync(queueOf([one, two], "1"));
    await settle();
    await controller.togglePlay();
    await settle();
    const plays = record.plays;

    engine().emit({ type: "playing" });
    systemControls.handlers?.play();
    await settle();

    expect(record.plays).toBe(plays + 1);
    expect(controller.playingHere()).toMatchObject({ trackId: "a", playing: true });
  });

  it("plays and pauses as the system media controls ask, never toggling what plays", async () => {
    const { controller, systemControls } = setup({ playCurrent: "1" });

    await controller.playTracks(["a", "b"], 0);
    controller.sync(queueOf([one, two], "1"));
    await settle();
    systemControls.handlers?.play();
    await settle();

    expect(controller.playingHere()).toMatchObject({ trackId: "a", playing: true });

    systemControls.handlers?.pause();
    systemControls.handlers?.pause();
    await settle();

    expect(controller.playingHere()).toMatchObject({ trackId: "a", playing: false });
  });

  it("tells the now-playing surface of each new choice before it acts, and of no seek, skip, or Connect request that keeps what plays", async () => {
    const { controller, systemControls } = setup({ playCurrent: "1" });

    controller.sync(queueOf([one, two, three], "1"));
    await settle();

    const counted = async (act: () => Promise<void> | void): Promise<number> => {
      const before = systemControls.commanded;

      await act();

      return systemControls.commanded - before;
    };

    expect(await counted(() => controller.togglePlay())).toBe(1);
    expect(await counted(() => controller.next())).toBe(0);
    expect(await counted(() => controller.previous())).toBe(0);
    expect(await counted(() => controller.jump("3"))).toBe(1);
    expect(await counted(() => controller.seek(10_000))).toBe(0);
    expect(
      await counted(() => {
        controller.steer(true, 20_000);
      }),
    ).toBe(0);
    expect(
      await counted(() => {
        controller.steer(false, 0);
      }),
    ).toBe(1);
    expect(await counted(() => controller.playTracks(["a", "b"], 0))).toBe(1);
    expect(await counted(() => systemControls.handlers?.pause())).toBe(1);
    expect(await counted(() => controller.release())).toBe(1);
  });

  it("keeps the next song's preload through a reload of the playing song", async () => {
    const { controller, record, clock, engine } = setup({ playCurrent: "1", ticketMs: 60_000 });

    await controller.playTracks(["a", "b"], 0);
    controller.sync(queueOf([one, two], "1"));
    await settle();
    engine().emit({ type: "time", positionMs: 190_000 });
    await settle();
    const preloaded = record.preloads.at(-1)?.url;

    clock.now += 31_000;
    controller.seek(195_000);
    await settle();

    expect(record.loads.at(-1)?.url).toContain("/stream/a?ticket=t3");

    engine().finish();
    await settle();

    expect(preloaded).toContain("/stream/b?ticket=t2");
    expect(record.played.at(-1)).toBe(preloaded);
    expect(controller.getSnapshot().current).toBe("2");
  });

  it("drops a preload that answers after repeat one is turned on", async () => {
    const { controller, record, gates, engine } = setup({ mse: true, playCurrent: "1" });

    await controller.playTracks(["a", "b", "c"], 0);
    controller.sync(queueOf([one, two, three], "1"));
    await settle();
    gates.start.holding = true;
    engine().emit({ type: "time", positionMs: 190_000 });
    controller.sync(queueOf([one, two, three], "1", { repeat: "one" }));
    gates.start.release("b");
    await settle();
    gates.start.holding = false;
    engine().finish();
    await settle();

    expect(record.played.at(-1)).toContain("/stream/a?");
    expect(controller.getSnapshot().current).toBe("1");
  });

  it("drops a preload that answers after the queue was reordered, and loads the new next", async () => {
    const { controller, record, gates, engine } = setup({ mse: true, playCurrent: "1" });

    await controller.playTracks(["a", "b", "c"], 0);
    controller.sync(queueOf([one, two, three], "1"));
    await settle();
    gates.start.holding = true;
    engine().emit({ type: "time", positionMs: 190_000 });
    controller.sync(queueOf([one, three, two], "1"));
    gates.start.release("b");
    await settle();
    gates.start.holding = false;
    engine().emit({ type: "time", positionMs: 191_000 });
    await settle();
    engine().finish();
    await settle();

    expect(record.played.at(-1)).toContain("/stream/c?");
    expect(controller.getSnapshot().current).toBe("3");
  });

  it("drops the preload when the listener jumps to the last song, so it ends there", async () => {
    const { controller, record, engine } = setup({ playCurrent: "1" });

    await controller.playTracks(["a", "b", "c"], 0);
    controller.sync(queueOf([one, two, three], "1"));
    await settle();
    engine().emit({ type: "time", positionMs: 190_000 });
    await settle();

    expect(record.preloads.at(-1)?.url).toContain("/stream/b?");

    await controller.jump("3");
    await settle();
    engine().finish();
    await settle();

    expect(record.played.at(-1)).toContain("/stream/c?");
    expect(controller.getSnapshot()).toMatchObject({ current: "3", engineStatus: "paused" });
  });

  it("keeps a later move when an earlier one fails to reach the core", async () => {
    const { controller, record, gates } = setup({ playCurrent: "1" });

    await controller.playTracks(["a", "b", "c"], 0);
    controller.sync(queueOf([one, two, three], "1"));
    await settle();
    gates.jump.holding = true;
    const first = controller.jump("2");
    const second = controller.jump("3");
    await settle();
    gates.jump.fail("2", "Can't reach the server");
    await first;
    await settle();

    expect(controller.getSnapshot()).toMatchObject({
      current: "3",
      engineStatus: "playing",
      error: null,
    });
    expect(record.played.at(-1)).toContain("/stream/c?");

    gates.jump.release("3");
    await second;
  });

  it("shows a move's failure after the core's entry stood again", async () => {
    const { controller, clock, gates } = setup({ playCurrent: "1" });

    await controller.playTracks(["a", "b"], 0);
    controller.sync(queueOf([one, two], "1"));
    await settle();
    gates.jump.holding = true;
    const move = controller.jump("2");
    await settle();
    clock.now += 11_000;
    controller.sync(queueOf([one, two], "1"));
    await settle();
    gates.jump.fail("2", "Can't reach the server");
    await move;

    expect(controller.getSnapshot()).toMatchObject({
      current: "1",
      error: "Can't reach the server",
    });
  });

  it("drops a history report's failure once another song plays", async () => {
    const { controller, gates } = setup({ playCurrent: "1" });

    gates.report.holding = true;
    await controller.playTracks(["a", "b"], 0);
    controller.sync(queueOf([one, two], "1"));
    await settle();
    await controller.next();
    await settle();
    gates.report.fail("a", "History is unavailable");
    await settle();

    expect(controller.getSnapshot()).toMatchObject({ current: "2", error: null });
  });

  describe("when the media server goes away", () => {
    it("plays the song picked during the outage once it is back", async () => {
      const { controller, record } = await outage(async ({ controller: during }) => {
        await during.jump("2");
      });

      expect(record.loads.at(-1)).toMatchObject({ startMs: 0 });
      expect(record.loads.at(-1)?.url).toContain("/stream/b?");
      expect(controller.getSnapshot().current).toBe("2");
    });

    it("picks the song that stopped up where it stopped, through queue updates meanwhile", async () => {
      const { controller, record } = await outage(async ({ controller: during }) => {
        during.sync(queueOf([one, two], "1"));
        await settle();
      });

      expect(record.loads.at(-1)).toMatchObject({ startMs: 60_000 });
      expect(record.loads.at(-1)?.url).toContain("/stream/a?");
      expect(controller.getSnapshot().current).toBe("1");
    });

    it("plays a downloaded song picked after a stream failed, without waiting for the server", async () => {
      const media = await mediaServer();
      const run = setup({ playCurrent: "1", baseUrl: media.baseUrl, copies: ["b"] });

      try {
        await run.controller.playTracks(["a", "b"], 0);
        run.controller.sync(queueOf([one, two], "1"));
        await settle();
        media.state.healthy = false;
        run.engine().emit({ type: "error", reason: "network", message: "network" });

        await vi.waitFor(() => {
          expect(run.controller.getSnapshot().mediaOnline).toBe(false);
        });
        const startsBefore = names(run.sent).filter((name) => name.startsWith("start:"));

        await run.controller.jump("2");
        await settle();

        expect(run.record.loads.at(-1)?.url).toBe(copyUrl("b"));
        expect(run.controller.getSnapshot()).toMatchObject({
          current: "2",
          engineStatus: "playing",
          mediaOnline: false,
          error: null,
        });

        // A song with no copy still waits for the server, which is never asked.
        await run.controller.jump("1");
        await settle();

        expect(run.record.loads.at(-1)?.url).toBe(copyUrl("b"));
        expect(run.controller.getSnapshot()).toMatchObject({ current: "1", engineStatus: "error" });
        expect(run.engine().samplePlayback().playing).toBe(false);
        expect(names(run.sent).filter((name) => name.startsWith("start:"))).toStrictEqual(
          startsBefore,
        );
      } finally {
        run.stop();
        media.close();
      }
    });

    it.each([
      { label: "the next song", order: [one, two, three] },
      { label: "the next song with a copy", order: [one, two, entry("d", "4"), three] },
    ])(
      "skips a copy that fails while the server is away to $label, without asking for a stream",
      async ({ order }) => {
        const media = await mediaServer();
        const run = setup({ playCurrent: "1", baseUrl: media.baseUrl, copies: ["b", "c"] });

        try {
          await run.controller.playTracks(
            order.map((queued) => queued.track.id),
            0,
          );
          run.controller.sync(queueOf(order, "1"));
          await settle();
          media.state.healthy = false;
          run.engine().emit({ type: "error", reason: "network", message: "network" });

          await vi.waitFor(() => {
            expect(run.controller.getSnapshot().mediaOnline).toBe(false);
          });
          await run.controller.jump("2");
          await settle();

          expect(run.controller.getSnapshot()).toMatchObject({
            current: "2",
            engineStatus: "playing",
          });
          const startsBefore = names(run.sent).filter((name) => name.startsWith("start:"));

          run.engine().emit({ type: "error", reason: "decode", message: "Cannot decode" });
          await settle();

          expect(run.discarded).toStrictEqual([copyUrl("b")]);
          expect(run.record.loads.at(-1)?.url).toBe(copyUrl("c"));
          expect(run.controller.getSnapshot()).toMatchObject({
            current: "3",
            engineStatus: "playing",
            mediaOnline: false,
            error: null,
          });
          expect(names(run.sent).filter((name) => name.startsWith("start:"))).toStrictEqual(
            startsBefore,
          );
        } finally {
          run.stop();
          media.close();
        }
      },
    );

    it("follows the device's own queue when the song it moved to fails outside that queue", async () => {
      const run = setup({ playCurrent: "1", copies: ["a", "c"] });

      try {
        await run.controller.playTracks(["a", "b", "c"], 0);
        run.controller.sync(queueOf([one, two, three], "1"));
        await settle();
        // A plays out. The core never confirms the move to B, and B's ticket doesn't come.
        run.gates.jump.holding = true;
        run.gates.start.holding = true;
        run.engine().emit({ type: "ended" });
        await settle();

        expect(run.controller.getSnapshot()).toMatchObject({
          current: "2",
          engineStatus: "loading",
        });

        // The device goes its own way first: its queue holds only its copies, from C on.
        run.device.away = true;
        run.controller.sync(queueOf([one, three], "3"));
        run.gates.start.release("b");
        await settle();

        expect(run.record.loads.map((load) => load.url)).toStrictEqual([
          copyUrl("a"),
          copyUrl("c"),
        ]);
        expect(run.controller.getSnapshot()).toMatchObject({
          current: "3",
          engineStatus: "playing",
          error: null,
        });
      } finally {
        run.stop();
      }
    });

    it("keeps a downloaded song playing when the server comes back", async () => {
      const media = await mediaServer();
      const run = setup({ playCurrent: "1", baseUrl: media.baseUrl, copies: ["b"] });

      try {
        await run.controller.playTracks(["a", "b"], 0);
        run.controller.sync(queueOf([one, two], "1"));
        await settle();
        media.state.healthy = false;
        run.engine().emit({ type: "error", reason: "network", message: "network" });

        await vi.waitFor(() => {
          expect(run.controller.getSnapshot().mediaOnline).toBe(false);
        });
        await run.controller.jump("2");
        await settle();
        const loads = run.record.loads.length;

        media.state.healthy = true;

        await vi.waitFor(
          () => {
            expect(run.controller.getSnapshot().mediaOnline).toBe(true);
          },
          { timeout: 5000 },
        );

        expect(run.record.loads.length).toBe(loads);
        expect(run.controller.getSnapshot()).toMatchObject({
          current: "2",
          engineStatus: "playing",
        });
      } finally {
        run.stop();
        media.close();
      }
    });
  });
});

describe("PlaybackController casting to a receiver", () => {
  it("moves the song here to the receiver at its place, playing, as the same play", async () => {
    const run = setup({ playCurrent: "1" });

    await run.controller.playTracks(["a", "b"], 0);
    run.controller.sync(queueOf([one, two], "1"));
    await settle();
    run.engine().emit({ type: "time", positionMs: 60_000 });

    run.controller.castTo(run.receiver("Living Room TV"));
    await settle();

    expect(run.record.loads.at(-1)).toStrictEqual({
      kind: "cast",
      url: `${BASE}/media/music/stream/a?ticket=t2&p=aac-320`,
      startMs: 60_000,
    });
    expect(run.controller.getSnapshot()).toMatchObject({
      engine: "cast",
      engineStatus: "playing",
      current: "1",
      cast: { receiver: "Living Room TV" },
    });
    expect(run.controller.playingHere()).toMatchObject({ trackId: "a", playing: true });
    // A new ticket for the receiver, and still one play in history.
    expect(names(run.sent)).toStrictEqual(["play:a,b,0", "start:a", "report:a,p1", "start:a"]);
    run.stop();
  });

  it("drops what the old output says after the switch, and comes back where the receiver was", async () => {
    const run = setup({ playCurrent: "1" });

    await run.controller.playTracks(["a", "b"], 0);
    run.controller.sync(queueOf([one, two], "1"));
    await settle();

    const local = run.engine();

    run.controller.castTo(run.receiver(null));
    await settle();

    const cast = run.engine();

    // The browser's own element ends and fails as it lets go; neither is the receiver's song.
    local.emit({ type: "ended" });
    local.emit({ type: "error", reason: "network", message: "gone" });
    await settle();

    expect(run.controller.getSnapshot()).toMatchObject({
      current: "1",
      engineStatus: "playing",
      cast: { receiver: null },
    });

    cast.emit({ type: "time", positionMs: 90_000 });
    run.controller.steer(false, 90_000);
    await settle();

    expect(run.controller.getSnapshot().engineStatus).toBe("paused");

    run.controller.castTo(null);
    await settle();

    expect(run.record.loads.at(-1)).toMatchObject({ kind: "html", startMs: 90_000 });
    expect(run.controller.getSnapshot()).toMatchObject({
      engine: "html",
      engineStatus: "paused",
      cast: null,
    });
    run.stop();
  });

  it("takes the song back paused where the receiver was once another sender's media took it", async () => {
    const run = setup({ playCurrent: "1" });

    await run.controller.playTracks(["a", "b"], 0);
    run.controller.sync(queueOf([one, two], "1"));
    await settle();

    run.controller.castTo(run.receiver("Living Room TV"));
    await settle();
    run.engine().emit({ type: "time", positionMs: 75_000 });

    run.controller.castTaken();
    await settle();

    expect(run.record.loads.at(-1)).toMatchObject({ kind: "html", startMs: 75_000 });
    expect(run.controller.getSnapshot()).toMatchObject({
      engine: "html",
      engineStatus: "paused",
      current: "1",
      cast: null,
    });
    expect(run.controller.playingHere()).toMatchObject({ trackId: "a", playing: false });
    run.stop();
  });

  it("sets the receiver's volume while it plays and keeps this device's own", async () => {
    const run = setup({ playCurrent: "1" });

    await run.controller.playTracks(["a"], 0);
    run.controller.sync(queueOf([one], "1"));
    await settle();
    run.controller.setVolume(0.8);

    const kitchen = run.receiver("Kitchen");

    run.controller.castTo(kitchen);
    await settle();

    // The controls show the TV's volume, and follow its own remote.
    expect(run.controller.getSnapshot().volume).toBe(0.5);
    kitchen.turnTo(0.3);
    expect(run.controller.getSnapshot().volume).toBe(0.3);

    run.controller.setVolume(0.2);

    expect(run.controller.getSnapshot().volume).toBe(0.2);

    run.controller.castTo(null);
    await settle();
    kitchen.turnTo(0.9);

    expect(run.controller.getSnapshot().volume).toBe(0.8);
    run.stop();
  });
});
