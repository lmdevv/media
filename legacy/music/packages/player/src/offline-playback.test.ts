import { TrackId } from "@music/commands/ids";
import { describe, expect, it, vi } from "vitest";

import type { EngineEvent, PlayerEngine } from "./engine";
import type { MediaSessionHandlers } from "./media-session";
import { PlaybackController } from "./playback-controller";
import { SessionRouter } from "./session-router";
import { localFirst, streamSources } from "./source-resolver";
import {
  holding,
  manualClock,
  memorySessionStore,
  phone,
  recordingServer,
  sessionOf,
  unreachableMedia,
} from "./testing/offline-session";
import type { SongId } from "./testing/offline-session";

const instantEngine = () => {
  const listeners = new Set<(event: EngineEvent) => void>();
  const loads: Array<string> = [];

  const emit = (event: EngineEvent): void => {
    for (const listener of listeners) listener(event);
  };

  const engine: PlayerEngine = {
    load: async (source, _startMs, autoplay) => {
      loads.push(source.url);

      if (autoplay) emit({ type: "playing" });
    },
    preload: () => {},
    play: async () => {
      emit({ type: "playing" });
    },
    pause: () => {
      emit({ type: "paused" });
    },
    seek: () => {},
    setVolume: () => {},
    unload: () => {},
    subscribe: (listener) => {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },
  };

  return { engine, loads, emit };
};

const fileOf = (trackId: string): string => `file:///vault/${trackId}.m4a`;

const setup = (queue: ReadonlyArray<SongId>, downloaded: ReadonlyArray<SongId>) => {
  const server = recordingServer();
  const clock = manualClock();
  const held = new Set<string>(downloaded);
  const discarded: Array<{ readonly trackId: TrackId; readonly url: string }> = [];
  const output = instantEngine();
  let lockScreen: MediaSessionHandlers | null = null;

  const router = new SessionRouter({
    client: server.client,
    connection: server.connection,
    store: memorySessionStore().store,
    device: phone,
    playable: holding(held),
    clock,
    random: () => 0.5,
  });

  const copies = {
    find: (trackId: TrackId) =>
      held.has(trackId) ? { uri: fileOf(trackId), profile: "aac-320" as const } : null,
    discard: (trackId: TrackId, url: string) => {
      held.delete(trackId);
      discarded.push({ trackId, url });
    },
  };

  const sources = localFirst(
    copies,
    streamSources(server.client, { now: clock.now, resolveUrl: (url) => url }),
    router,
  );

  const controller = new PlaybackController(
    router,
    sources,
    { mse: null, create: () => output.engine },
    {
      deviceId: phone.id,
      device: { name: phone.name, kind: phone.kind },
      canPlay: () => true,
      now: clock.now,
      quality: "high",
      saveQuality: () => {},
      nowPlaying: {
        setHandlers: (handlers) => {
          lockScreen = handlers;
        },
        show: () => {},
      },
      onForeground: () => () => {},
    },
  );

  const unsubscribe = router.subscribe(() => {
    const state = router.getSnapshot().state;

    if (state !== undefined) controller.sync(state);
  });

  const stopRouter = router.start();
  const stopController = controller.start();

  router.offerServer(sessionOf(queue, { updatedAt: clock.now() }));

  return {
    controller,
    router,
    server,
    clock,
    output,
    discarded,
    lockScreen: (): MediaSessionHandlers => {
      if (lockScreen === null) throw new Error("No lock-screen controls");

      return lockScreen;
    },
    stop: () => {
      stopController();
      stopRouter();
      unsubscribe();
    },
  };
};

describe("playing without a connection", () => {
  it("plays the next downloaded song from its file when a song ends", async () => {
    const { router, server, output, stop } = setup(["a", "b", "c"], ["a", "b", "c"]);

    await vi.waitFor(() => expect(server.names()).toContain("playback.report"));
    expect(output.loads).toEqual([fileOf("a")]);
    server.setConnected(false);
    expect(router.mode()).toBe("local");
    const online = server.names();

    output.emit({ type: "ended" });

    await vi.waitFor(() => expect(output.loads).toEqual([fileOf("a"), fileOf("b")]));
    expect(router.getSnapshot().state?.index).toBe(1);
    expect(server.names()).toEqual(online);
    stop();
  });

  it("skips songs that aren't downloaded when next is pressed on the lock screen", async () => {
    const { server, output, lockScreen, stop } = setup(["a", "b", "c"], ["a", "c"]);

    await vi.waitFor(() => expect(output.loads).toEqual([fileOf("a")]));
    server.setConnected(false);

    lockScreen().next();

    await vi.waitFor(() => expect(output.loads).toEqual([fileOf("a"), fileOf("c")]));
    stop();
  });

  it("plays downloaded songs while the media service is out of reach", async () => {
    const { controller, server, output, lockScreen, stop } = setup(["a", "b"], ["b"]);
    const streamed = `${unreachableMedia}/stream/a?p=aac-320`;

    await vi.waitFor(() => expect(output.loads).toEqual([streamed]));
    server.setConnected(false);

    output.emit({ type: "error", reason: "network", message: "The network dropped" });
    await vi.waitFor(() => expect(controller.getSnapshot().mediaOnline).toBe(false));
    lockScreen().next();

    await vi.waitFor(() => expect(output.loads).toEqual([streamed, fileOf("b")]));
    stop();
  });

  it("drops a copy that fails to play and moves on to the next downloaded song", async () => {
    const { server, output, discarded, stop } = setup(["a", "b", "c"], ["a", "b", "c"]);

    await vi.waitFor(() => expect(output.loads).toHaveLength(1));
    server.setConnected(false);
    output.emit({ type: "ended" });
    await vi.waitFor(() => expect(output.loads).toHaveLength(2));

    output.emit({ type: "error", reason: "decode", message: "The file is damaged" });

    await vi.waitFor(() => expect(output.loads).toEqual([fileOf("a"), fileOf("b"), fileOf("c")]));
    expect(discarded).toEqual([{ trackId: "b", url: fileOf("b") }]);
    stop();
  });

  it("moves the queue on when a preloaded song plays on gaplessly after the queue was replaced", async () => {
    const { controller, router, server, clock, output, stop } = setup(
      ["a", "b", "c"],
      ["a", "b", "c"],
    );

    await vi.waitFor(() => expect(output.loads).toEqual([fileOf("a")]));
    server.setConnected(false);
    // Near the end of "a", the controller preloads "b" for a gapless start.
    output.emit({ type: "time", positionMs: 179_000 });
    // Playing the same songs again gives every entry a new ID; "a" plays on from the top.
    await controller.playTracks(["a", "b", "c"].map((id) => TrackId.make(id)));
    clock.advance(179_000);
    output.emit({ type: "time", positionMs: 179_000 });

    output.emit({ type: "advanced", key: "b:aac-320:local" });

    await vi.waitFor(() => expect(router.getSnapshot().state?.index).toBe(1));
    expect(output.loads).toEqual([fileOf("a")]);
    stop();
  });

  it("keeps playing when the server stops answering, and hands back what played once it does", async () => {
    const { router, server, clock, output, stop } = setup(["a", "b", "c"], ["a", "b", "c"]);

    await vi.waitFor(() => expect(output.loads).toHaveLength(1));
    server.hold();
    output.emit({ type: "ended" });
    clock.advance(4000);

    await vi.waitFor(() => expect(output.loads).toEqual([fileOf("a"), fileOf("b")]));
    expect(router.mode()).toBe("local");

    server.release();
    await vi.waitFor(() => expect(router.mode()).toBe("server"));

    const handedBack = server.ran.filter(({ name }) => name === "devices.reconcile");

    expect(handedBack).toHaveLength(1);
    expect(handedBack[0]?.args).toMatchObject({
      plays: [{ trackId: "b" }],
      resume: {
        items: [{ trackId: "a" }, { trackId: "b" }, { trackId: "c" }],
        index: 1,
        playing: true,
      },
    });
    stop();
  });
});
