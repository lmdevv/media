import { PlaybackController } from "@media/player/playback-controller";
import type { MusicCommands, QueueState } from "@media/player/playback-controller";
import { ticketSources } from "@media/player/source-resolver";
import { afterEach, describe, expect, it } from "vitest";

import type { DownloadedCopies } from "@/downloads";
import type { Track } from "@/lib/models";
import { trackOf } from "@/lib/test-fixtures";

import { handOver } from "./hand-over";
import { handBack, jumpLocal, playingView, seedLocal } from "./local-queue";
import type { HandBackStep, LocalQueue } from "./local-queue";
import { phoneSources } from "./phone-sources";
import { instantEngine, settle } from "./test-engine";
import type { Load } from "./test-engine";

const BASE = "http://media.test";

const songA = trackOf("Safe from Harm");

const songB = trackOf("One Love");

const PAUSED_AT = 60_000;

const uri = (trackId: string): string => `file:///vault/${trackId}.m4a`;

/** The phone holds a copy of both songs. */
const copies: DownloadedCopies = {
  find: (trackId) => {
    const track = [songA, songB].find((song) => song.id === trackId);

    return track === undefined
      ? null
      : { track, uri: uri(trackId), profile: "aac-320", bytes: 1, artUri: null };
  },
  discard: () => {},
};

/** Where the provider's commands go, read when one runs. */
interface Mode {
  current: "server" | "local";
}

const stops: Array<() => void> = [];

/** A deadline the cases that settle never reach. */
const noDeadline = {
  deadlineMs: 60_000,
  release: () => {
    throw new Error("The hand-back was released");
  },
};

afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

/**
 * The provider's player with a core whose queue plays A then B: online it plays A, the server goes
 * away, the phone moves on to B on its own queue, and pauses B at 60 s. Once `follow` runs, every
 * change to the core's queue reaches the player, as the provider's queue subscription does.
 */
const pausedOfflineOnB = async () => {
  const loads: Array<Load> = [];
  const mode: Mode = { current: "server" };

  let server: QueueState<Track> = {
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

  let following = true;

  const commands: MusicCommands = {
    play: async () => ({ current: "a" }),
    track: async () => songA,
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
    { now: Date.now, baseUrl: BASE },
  );

  const controller = new PlaybackController(
    commands,
    phoneSources(copies, remote, mode, () => "id"),
    { mse: null, create: () => instantEngine(loads) },
    {
      canPlay: () => true,
      now: Date.now,
      monotonicNow: () => 0,
      settings: { quality: "high", volume: 1, gapless: true },
      saveQuality: () => {},
      saveVolume: () => {},
      nowPlaying: { setHandlers: () => {}, show: () => {} },
      resume: { load: () => null, save: () => {} },
    },
  );

  stops.push(controller.start());

  controller.sync(server);
  await controller.togglePlay();
  await settle();

  // The server goes away: the phone plays its own queue, seeded from the core's last answer.
  following = false;
  mode.current = "local";
  local = seedLocal(server, (id) => [songA, songB].find((song) => song.id === id) ?? null);
  controller.sync(playingView(local));
  await controller.next();
  await settle();
  await controller.togglePlay();
  controller.seek(PAUSED_AT);
  await settle();

  return {
    controller,
    loads,
    local: () => local,
    reconnect: () => {
      mode.current = "server";
    },
    /** Sends commands to the phone's own queue again, as the provider's `release` does. */
    goBackLocal: () => {
      mode.current = "local";
    },
    /** Moves to `itemId` the way the player's queue screen does. */
    jump: (itemId: string) => commands.jump(itemId),
    /** Changes the core's queue, as a hand-back step landing does. */
    land: (next: QueueState<Track>) => {
      server = next;

      if (following) controller.sync(server);
    },
    server: () => server,
    follow: () => {
      following = true;
      controller.sync(server);
    },
  };
};

describe("handOver", () => {
  it("keeps the song paused offline, and its place, while the core takes back the entry played", async () => {
    const phone = await pausedOfflineOnB();

    expect(phone.controller.getSnapshot()).toMatchObject({ current: "b", engineStatus: "paused" });
    expect(phone.controller.positionMs()).toBe(PAUSED_AT);
    const loadsBefore = phone.loads.length;

    phone.reconnect();
    const steps = handBack(phone.local(), false);
    const landed = Promise.withResolvers<void>();

    expect(steps).toEqual([{ kind: "jump", itemId: "b" }]);

    const done = handOver({
      steps,
      send: async (step: HandBackStep) => {
        await landed.promise;

        if (step.kind === "jump") phone.land({ ...phone.server(), current: step.itemId });

        return null;
      },
      playing: phone.local().state.current,
      stands: () => true,
      adopt: (fromItemId, toItemId) => {
        phone.controller.adoptEntry(fromItemId, toItemId);
      },
      follow: phone.follow,
      ...noDeadline,
    });

    // The core still names A until the jump lands.
    await settle();
    expect(phone.controller.getSnapshot().current).toBe("b");
    expect(phone.controller.positionMs()).toBe(PAUSED_AT);

    landed.resolve();
    await done;
    await settle();

    expect(phone.controller.getSnapshot()).toMatchObject({ current: "b", engineStatus: "paused" });
    expect(phone.controller.positionMs()).toBe(PAUSED_AT);
    expect(phone.loads.slice(loadsBefore)).toEqual([]);

    await phone.controller.togglePlay();
    await settle();

    expect(phone.controller.getSnapshot().engineStatus).toBe("playing");
    expect(phone.controller.positionMs()).toBe(PAUSED_AT);
    expect(phone.loads.slice(loadsBefore)).toEqual([]);
  });

  it("keeps the song and its place when the queue goes back as a new one, under the core's new id", async () => {
    const phone = await pausedOfflineOnB();
    const loadsBefore = phone.loads.length;

    phone.reconnect();
    // A new queue sent before the outage landed during it, so the whole queue goes back.
    const steps = handBack(phone.local(), true);

    expect(steps).toEqual([{ kind: "play", trackIds: [songA.id, songB.id], index: 1 }]);

    await handOver({
      steps,
      send: async () => {
        phone.land({
          ...phone.server(),
          entries: [
            { itemId: "n0", autoplay: false, track: songA },
            { itemId: "n1", autoplay: false, track: songB },
          ],
          current: "n1",
        });

        return "n1";
      },
      playing: phone.local().state.current,
      stands: () => true,
      adopt: (fromItemId, toItemId) => {
        phone.controller.adoptEntry(fromItemId, toItemId);
      },
      follow: phone.follow,
      ...noDeadline,
    });
    await settle();

    expect(phone.controller.getSnapshot()).toMatchObject({ current: "n1", engineStatus: "paused" });
    expect(phone.controller.positionMs()).toBe(PAUSED_AT);
    expect(phone.loads.slice(loadsBefore)).toEqual([]);
  });

  it("loads the core's song when the new queue opened on another one", async () => {
    const phone = await pausedOfflineOnB();
    const loadsBefore = phone.loads.length;

    phone.reconnect();

    await handOver({
      steps: handBack(phone.local(), true),
      send: async () => {
        phone.land({
          ...phone.server(),
          entries: [{ itemId: "n0", autoplay: false, track: songA }],
          current: "n0",
        });

        return "n0";
      },
      playing: phone.local().state.current,
      stands: () => true,
      adopt: (fromItemId, toItemId) => {
        phone.controller.adoptEntry(fromItemId, toItemId);
      },
      follow: phone.follow,
      ...noDeadline,
    });
    await settle();

    expect(phone.controller.getSnapshot().current).toBe("n0");
    expect(phone.loads.slice(loadsBefore)).toEqual([{ url: uri(songA.id), startMs: 0 }]);
  });

  it("keeps the phone's queue when the server went away again before the hand-back landed", async () => {
    const phone = await pausedOfflineOnB();
    let followed = false;

    phone.reconnect();

    await handOver({
      steps: handBack(phone.local(), false),
      send: async () => null,
      playing: phone.local().state.current,
      stands: () => false,
      adopt: () => {
        followed = true;
      },
      follow: () => {
        followed = true;
      },
      ...noDeadline,
    });

    expect(followed).toBe(false);
    expect(phone.controller.getSnapshot().current).toBe("b");
    expect(phone.controller.positionMs()).toBe(PAUSED_AT);
  });

  it("gives commands back to the phone's queue when the core never answers the hand-back", async () => {
    const phone = await pausedOfflineOnB();
    const loadsBefore = phone.loads.length;
    let followed = false;
    let released = 0;

    phone.reconnect();

    await handOver({
      steps: handBack(phone.local(), false),
      // Media health answers, but the core never settles the jump.
      send: () => new Promise<string | null>(() => {}),
      playing: phone.local().state.current,
      stands: () => true,
      adopt: () => {
        followed = true;
      },
      follow: () => {
        followed = true;
      },
      deadlineMs: 20,
      release: () => {
        released += 1;
        phone.goBackLocal();
      },
    });

    expect(released).toBe(1);
    expect(followed).toBe(false);
    expect(phone.controller.getSnapshot()).toMatchObject({ current: "b", engineStatus: "paused" });
    expect(phone.controller.positionMs()).toBe(PAUSED_AT);

    // The phone's queue answers commands again: a jump back to A moves it there, and Play plays A
    // from its copy.
    await phone.jump("a");
    await phone.controller.togglePlay();
    await settle();

    expect(phone.local().state.current).toBe("a");
    expect(phone.controller.getSnapshot()).toMatchObject({ current: "a", engineStatus: "playing" });
    expect(phone.loads.slice(loadsBefore)).toEqual([{ url: uri(songA.id), startMs: 0 }]);
  });
});
