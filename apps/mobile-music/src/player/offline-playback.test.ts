import { PlaybackController } from "@media/player/playback-controller";
import type { MusicCommands, QueueState } from "@media/player/playback-controller";
import { ticketSources } from "@media/player/source-resolver";
import type { PlayStart } from "@media/player/source-resolver";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DownloadedCopies } from "@/downloads";
import type { Track } from "@/lib/models";
import { trackOf } from "@/lib/test-fixtures";

import { jumpLocal, playingView, seedLocal } from "./local-queue";
import type { LocalQueue } from "./local-queue";
import { boundedSources, phoneSources } from "./phone-sources";
import { instantEngine, settle } from "./test-engine";
import type { Load } from "./test-engine";

/** A media server nothing answers on: its health check fails at once. */
const UNREACHABLE_MEDIA = "http://127.0.0.1:9";

const songA = trackOf("Safe from Harm");

const songB = trackOf("One Love");

const songC = trackOf("Unfinished Sympathy");

/** How long the tests let a ticket go unanswered: the app waits seconds. */
const DEADLINE_MS = 20;

const uri = (trackId: string): string => `file:///vault/${trackId}.m4a`;

/** Where the provider's commands go, read when one runs. */
interface Mode {
  current: "server" | "local";
}

const stops: Array<() => void> = [];

afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

/**
 * The provider's player with the app's sources: the core's queue plays A then B, and the phone
 * holds a copy of B only. Commands go to the core or to the phone's own queue as `mode` says, as
 * the provider's do.
 */
const phoneWithB = () => {
  const loads: Array<Load> = [];
  const engine = instantEngine(loads);
  const mode: Mode = { current: "server" };
  const songs = [songA, songB];

  const server: QueueState<Track> = {
    entries: [
      { itemId: "a", autoplay: false, track: songA },
      { itemId: "b", autoplay: false, track: songB },
    ],
    complete: true,
    current: "a",
    shuffle: false,
    repeat: "off",
    autoplay: false,
  };

  let local: LocalQueue<Track> = seedLocal<Track>(null, () => null);

  const copies: DownloadedCopies = {
    find: (trackId) =>
      trackId === songB.id
        ? { track: songB, uri: uri(trackId), profile: "aac-320", bytes: 1, artUri: null }
        : null,
    discard: () => {},
  };

  const commands: MusicCommands = {
    play: async () => ({ current: "a" }),
    track: async (trackId) => songs.find((song) => song.id === trackId) ?? songA,
    jump: async (itemId) => {
      if (mode.current === "local") {
        local = jumpLocal(local, itemId);
        controller.sync(playingView(local));
      }
    },
    report: async () => {},
  };

  const remote = ticketSources(
    async (trackId) => ({
      playbackId: `p-${trackId}`,
      startedAt: 0,
      ticket: "ticket",
      expiresAt: Date.now() + 60_000,
    }),
    { now: Date.now, baseUrl: UNREACHABLE_MEDIA },
  );

  const controller = new PlaybackController(
    commands,
    phoneSources(copies, remote, mode, () => "id"),
    { mse: null, create: () => engine },
    {
      canPlay: () => true,
      now: Date.now,
      monotonicNow: () => 0,
      settings: { quality: "high", volume: 1, gapless: true },
      saveQuality: () => {},
      saveVolume: () => {},
      nowPlaying: { setHandlers: () => {}, show: () => {}, commanded: () => {} },
      resume: { load: () => null, save: () => {} },
    },
  );

  stops.push(controller.start());
  controller.sync(server);

  return {
    controller,
    engine,
    loads,
    /** The server went out of reach: the phone plays its own queue, seeded from the core's. */
    goLocal: () => {
      mode.current = "local";
      local = seedLocal(server, (id) => songs.find((song) => song.id === id) ?? null);
      controller.sync(playingView(local));
    },
  };
};

describe("playing without a connection", () => {
  it("plays a downloaded song picked after the stream playing failed", async () => {
    const phone = phoneWithB();

    await phone.controller.togglePlay();

    await vi.waitFor(() => {
      expect(phone.loads.map((load) => load.url)).toEqual([
        expect.stringContaining(
          `${UNREACHABLE_MEDIA}/media/music/stream/${encodeURIComponent(songA.id)}?`,
        ),
      ]);
    });

    // A's stream drops and the media server doesn't answer: the player waits for it.
    phone.engine.dropStream();

    await vi.waitFor(() => {
      expect(phone.controller.getSnapshot().mediaOnline).toBe(false);
    });

    // The phone then plays its own queue, and the listener taps the downloaded B.
    phone.goLocal();
    await phone.controller.jump("b");

    await vi.waitFor(() => {
      expect(phone.loads.at(-1)?.url).toBe(uri(songB.id));
    });
    expect(phone.controller.getSnapshot()).toMatchObject({
      current: "b",
      engineStatus: "playing",
      error: null,
    });
  });
});

/**
 * The provider's player with the app's sources, its source calls bounded as the provider bounds
 * them: the core's queue plays A, then B, then C, and the phone holds copies of A and C only. The
 * server goes away while A plays in the background: nothing the core is sent answers, the media
 * server's health check fails, and the engine reports no error.
 */
const awayInThePocket = () => {
  const loads: Array<Load> = [];
  const engine = instantEngine(loads);
  const mode: Mode = { current: "server" };
  const songs = [songA, songB, songC];
  const held = new Set<string>([songA.id, songC.id]);

  const starts: Array<{ readonly trackId: string; readonly answer: (start: PlayStart) => void }> =
    [];

  const server: QueueState<Track> = {
    entries: [
      { itemId: "a", autoplay: false, track: songA },
      { itemId: "b", autoplay: false, track: songB },
      { itemId: "c", autoplay: false, track: songC },
    ],
    complete: true,
    current: "a",
    shuffle: false,
    repeat: "off",
    autoplay: false,
  };

  let local: LocalQueue<Track> = seedLocal<Track>(null, () => null);

  const copies: DownloadedCopies = {
    find: (trackId) => {
      const track = songs.find((song) => song.id === trackId);

      return track !== undefined && held.has(track.id)
        ? { track, uri: uri(trackId), profile: "aac-320", bytes: 1, artUri: null }
        : null;
    },
    discard: () => {},
  };

  const commands: MusicCommands = {
    play: async () => ({ current: "a" }),
    track: async (trackId) => songs.find((song) => song.id === trackId) ?? songA,
    jump: async (itemId) => {
      if (mode.current === "local") {
        local = jumpLocal(local, itemId);
        controller.sync(playingView(local));

        return;
      }

      // The core never answers: the server is away.
      await new Promise<never>(() => {});
    },
    report: async () => {},
  };

  const remote = ticketSources(
    async (trackId) =>
      new Promise<PlayStart>((resolve) => {
        starts.push({ trackId, answer: resolve });
      }),
    { now: Date.now, baseUrl: UNREACHABLE_MEDIA },
  );

  // As the provider's `goLocal`: the phone's own queue, from the entry the player moved to.
  const away = (): void => {
    mode.current = "local";
    local = seedLocal(
      server,
      (id) => (held.has(id) ? (songs.find((song) => song.id === id) ?? null) : null),
      controller.getSnapshot().current,
    );
    controller.sync(playingView(local));
  };

  const controller = new PlaybackController(
    commands,
    phoneSources(
      copies,
      boundedSources(remote, {
        deadlineMs: DEADLINE_MS,
        answers: async () => false,
        away,
      }),
      mode,
      () => "id",
    ),
    { mse: null, create: () => engine },
    {
      canPlay: () => true,
      now: Date.now,
      monotonicNow: () => 0,
      settings: { quality: "high", volume: 1, gapless: true },
      saveQuality: () => {},
      saveVolume: () => {},
      nowPlaying: { setHandlers: () => {}, show: () => {}, commanded: () => {} },
      resume: { load: () => null, save: () => {} },
    },
  );

  stops.push(controller.start());
  controller.sync(server);

  return { controller, engine, loads, mode, starts };
};

describe("losing the server while a downloaded song plays in the background", () => {
  it("goes local when the next song's ticket goes unanswered, and plays the next downloaded song", async () => {
    const phone = awayInThePocket();

    await phone.controller.togglePlay();

    await vi.waitFor(() => {
      expect(phone.loads.map((load) => load.url)).toEqual([uri(songA.id)]);
    });

    // A plays out; B has no copy, so the player asks the core for its ticket, which never comes.
    phone.engine.end();

    await vi.waitFor(() => {
      expect(phone.starts.map((start) => start.trackId)).toEqual([songB.id]);
    });

    await vi.waitFor(() => {
      expect(phone.loads.map((load) => load.url)).toEqual([uri(songA.id), uri(songC.id)]);
    });
    expect(phone.mode.current).toBe("local");
    expect(phone.controller.getSnapshot()).toMatchObject({
      current: "c",
      engineStatus: "playing",
      error: null,
    });
  });

  it("keeps the downloaded song when the ticket answers after the phone went local", async () => {
    const phone = awayInThePocket();

    await phone.controller.togglePlay();

    await vi.waitFor(() => {
      expect(phone.loads).toHaveLength(1);
    });
    phone.engine.end();

    await vi.waitFor(() => {
      expect(phone.loads.at(-1)?.url).toBe(uri(songC.id));
    });

    // The server comes back with B's ticket from before the fallback.
    for (const start of phone.starts) {
      start.answer({
        playbackId: `p-${start.trackId}`,
        startedAt: 0,
        ticket: "late",
        expiresAt: 60_000,
      });
    }

    await settle();
    expect(phone.loads.map((load) => load.url)).toEqual([uri(songA.id), uri(songC.id)]);
    expect(phone.controller.getSnapshot()).toMatchObject({
      current: "c",
      engineStatus: "playing",
      error: null,
    });
  });
});
