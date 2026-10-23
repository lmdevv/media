import { QueueItemId, TrackId } from "@music/commands/ids";
import { errorMessage } from "@music/sdk/errors";
import { describe, expect, it, vi } from "vitest";

import { planEngine, sessionView } from "./engine-plan";
import { seedLocal } from "./local-session";
import { ACK_DEADLINE_MS, SessionRouter } from "./session-router";
import type { SessionStore, StoredSessions } from "./session-router";
import {
  holding,
  laptop,
  manualClock,
  memorySessionStore,
  phone,
  recordingServer,
  sessionOf,
  songIds,
} from "./testing/offline-session";

const setup = (
  options: {
    readonly stored?: StoredSessions;
    readonly store?: SessionStore;
    readonly downloaded?: Iterable<string>;
    readonly ackDeadlineMs?: number;
    readonly connected?: boolean;
  } = {},
) => {
  const server = recordingServer();
  const clock = manualClock();
  const memory = memorySessionStore(options.stored);

  const router = new SessionRouter({
    client: server.client,
    connection: server.connection,
    store: options.store ?? memory.store,
    device: phone,
    playable: holding(options.downloaded ?? songIds),
    clock,
    random: () => 0.5,
    ackDeadlineMs: options.ackDeadlineMs ?? ACK_DEADLINE_MS,
  });

  server.state.connected = options.connected ?? true;
  router.start();

  return { router, server, clock, memory };
};

const settle = (): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });

const shownFailure = async (call: Promise<unknown>): Promise<string> => {
  try {
    await call;
  } catch (error) {
    return error instanceof Error ? errorMessage(error) : String(error);
  }

  throw new Error("The command was not refused");
};

const report = (index: number, positionMs: number) => ({
  deviceId: phone.id,
  index,
  itemId: QueueItemId.make(String(index + 1)),
  positionMs,
  playing: true,
});

describe("taking the session over", () => {
  it("carries the session on here when the connection drops, and the engine does nothing", async () => {
    const { router, server, memory } = setup();
    const playing = sessionOf(["a", "b", "c"], { positionMs: 5000 });

    router.offerServer(playing);
    server.setConnected(false);
    await settle();
    const shown = router.getSnapshot().state;

    expect(router.mode()).toBe("local");
    expect(shown).toBeDefined();

    const loaded = { trackId: TrackId.make("a"), positionMs: 5000, reportedMs: null };
    const before = sessionView(playing, phone.id);

    expect(
      shown && planEngine(before, sessionView(shown, phone.id), loaded, playing.updatedAt),
    ).toEqual([]);
    expect(memory.local()?.items.map((entry) => entry.track.id)).toEqual(["a", "b", "c"]);
  });

  it("leaves the session with the server while it plays elsewhere, nowhere, or this one follows", () => {
    const idle = setup();

    idle.router.offerServer(sessionOf(["a"], { activeDevice: null, playing: false }));
    idle.server.setConnected(false);

    const elsewhere = setup();

    elsewhere.router.offerServer(
      sessionOf(["a"], {
        activeDevice: { id: laptop, name: "Laptop", kind: "web", lastSeenAt: 0, online: true },
      }),
    );
    elsewhere.server.setConnected(false);

    const following = setup();

    following.router.offerServer(sessionOf(["a"], { following: true }));
    following.server.setConnected(false);

    expect([idle.router.mode(), elsewhere.router.mode(), following.router.mode()]).toEqual([
      "server",
      "server",
      "server",
    ]);
  });
});

describe("commands while offline", () => {
  it("plays on through the songs held here and refuses what needs the server", async () => {
    const { router, server } = setup({ downloaded: ["a", "c"] });

    router.offerServer(sessionOf(["a", "b", "c"]));
    server.setConnected(false);

    await expect(router.run("playback.next", {})).resolves.toEqual({ ok: true });
    expect(router.getSnapshot().state?.index).toBe(2);

    expect(await shownFailure(router.run("playback.transfer", { deviceId: laptop }))).toBe(
      "Not available offline",
    );
    expect(await shownFailure(router.run("queue.add", { trackIds: [TrackId.make("b")] }))).toBe(
      "Only downloaded songs play offline",
    );
    expect(server.names()).toEqual([]);
  });
});

describe("a command the server doesn't answer", () => {
  it("moves the session here once the deadline passes, and the server runs it before the hand-back", async () => {
    const { router, server, clock } = setup({ ackDeadlineMs: 2500 });

    router.offerServer(sessionOf(["a", "b", "c"]));
    server.hold();
    const next = router.run("playback.next", {});

    clock.advance(2499);
    await settle();
    expect(router.mode()).toBe("server");

    clock.advance(1);
    await expect(next).resolves.toEqual({ ok: true });
    expect(router.mode()).toBe("local");
    expect(router.getSnapshot().state?.index).toBe(1);

    server.release();
    await vi.waitFor(() => expect(router.mode()).toBe("server"));
    expect(server.names()).toEqual(["playback.next", "devices.reconcile"]);
    expect(server.ran[1]?.args).toMatchObject({ resume: { index: 1, playing: true } });
  });

  it("keeps waiting for the server when the command can't run here", async () => {
    const { router, server, clock } = setup();

    router.offerServer(sessionOf(["a", "b"]));
    server.hold();
    const transfer = router.run("playback.transfer", { deviceId: laptop });

    clock.advance(ACK_DEADLINE_MS * 2);
    await settle();
    expect(router.mode()).toBe("server");

    server.release();
    await expect(transfer).resolves.toEqual({ ok: true });
    expect(server.names()).toEqual(["playback.transfer"]);
  });

  it("runs here, in the order sent, the commands still out when the connection drops", async () => {
    const { router, server } = setup();

    router.offerServer(sessionOf(["a", "b", "c"]));
    server.hold();
    const seek = router.run("playback.seek", { positionMs: 10_000 });
    const transfer = router.run("playback.transfer", { deviceId: laptop });

    server.setConnected(false);
    await expect(seek).resolves.toEqual({ ok: true });
    expect(await shownFailure(transfer)).toBe("Not available offline");
    expect(router.getSnapshot().state?.positionMs).toBe(10_000);

    await router.run("playback.seek", { positionMs: 60_000 });
    server.setConnected(true);
    server.release();
    await vi.waitFor(() => expect(router.mode()).toBe("server"));

    // The server runs the old commands first; the hand-back after them carries the new seek.
    expect(server.names()).toEqual(["playback.seek", "playback.transfer", "devices.reconcile"]);
    expect(server.ran[2]?.args).toMatchObject({ resume: { positionMs: 60_000 } });
  });

  it("leaves the play of a report still out with the server to the server", async () => {
    const { router, server } = setup();

    router.offerServer(sessionOf(["a", "b"]));
    server.hold();
    const sent = router.run("playback.report", report(1, 0));

    server.setConnected(false);
    await sent;
    expect(router.getSnapshot().state?.index).toBe(1);

    server.setConnected(true);
    server.release();
    await vi.waitFor(() => expect(router.mode()).toBe("server"));
    expect(server.ran[1]?.args).toMatchObject({ plays: [], resume: { index: 1 } });
  });
});

describe("handing the session back", () => {
  it("sends the offline plays and the queue once, then follows the server's next snapshot", async () => {
    const { router, server, clock, memory } = setup();

    router.offerServer(sessionOf(["a", "b", "c"]));
    server.setConnected(false);
    clock.advance(10_000);
    await router.run("playback.report", report(1, 0));
    clock.advance(4000);

    server.setConnected(true);
    await vi.waitFor(() => expect(router.mode()).toBe("server"));

    expect(server.ran).toEqual([
      {
        name: "devices.reconcile",
        args: {
          deviceId: "phone",
          plays: [{ trackId: "b", playedAt: 1_010_000 }],
          resume: {
            items: [
              { trackId: "a", itemId: "1" },
              { trackId: "b", itemId: "2" },
              { trackId: "c", itemId: "3" },
            ],
            index: 1,
            positionMs: 4000,
            playing: true,
            shuffle: false,
            repeat: "off",
            volume: 1,
            autoplay: true,
          },
        },
      },
    ]);

    await settle();
    expect(memory.local()).toBeNull();

    expect(router.getSnapshot().state?.index).toBe(1);
    const adopted = sessionOf(["a", "b", "c"], { index: 1 });

    router.offerServer(adopted);
    expect(router.getSnapshot().state).toBe(adopted);
  });

  it("sends the plays in batches, with the queue only in the last", async () => {
    const plays = Array.from({ length: 450 }, (_, n) => ({
      trackId: TrackId.make("a"),
      playedAt: 900_000 + n,
    }));

    const played = { ...seedLocal(sessionOf(["a"]), phone.id), plays, changed: true };
    const { server } = setup({ stored: { local: played, server: null } });

    await vi.waitFor(() => expect(server.names()).toHaveLength(3));

    expect(server.ran.map(({ args }) => args)).toMatchObject([
      { plays: plays.slice(0, 200), resume: null },
      { plays: plays.slice(200, 400), resume: null },
      { plays: plays.slice(400), resume: { items: [{ trackId: "a" }], index: 0 } },
    ]);
  });

  it("shows the server's own session at once when the server keeps it", async () => {
    const { router, server } = setup();

    router.offerServer(sessionOf(["a", "b"], { playing: false }));
    server.setConnected(false);

    const elsewhere = sessionOf(["c"], {
      activeDevice: { id: laptop, name: "Laptop", kind: "web", lastSeenAt: 0, online: true },
    });

    router.offerServer(elsewhere);
    expect(router.getSnapshot().state?.queue.map((entry) => entry.id)).toEqual(["a", "b"]);

    server.state.adopt = false;
    server.setConnected(true);
    await vi.waitFor(() => expect(router.mode()).toBe("server"));
    expect(router.getSnapshot().state).toBe(elsewhere);
  });

  it("tries the hand-back again after it fails", async () => {
    const { router, server, clock } = setup();

    router.offerServer(sessionOf(["a"]));
    server.setConnected(false);
    server.state.failures = 1;
    server.setConnected(true);
    await settle();
    expect(router.mode()).toBe("local");

    clock.advance(1000);
    await vi.waitFor(() => expect(router.mode()).toBe("server"));
    expect(server.names()).toEqual(["devices.reconcile", "devices.reconcile"]);
  });

  it("hands back again when the session moved here while the hand-back was out", async () => {
    const { router, server } = setup();

    router.offerServer(sessionOf(["a", "b", "c"]));
    server.setConnected(false);
    server.hold();
    server.setConnected(true);
    await settle();
    expect(router.getSnapshot().reconciling).toBe(true);

    await router.run("playback.next", {});
    server.release();
    await vi.waitFor(() => expect(router.mode()).toBe("server"));

    // Nothing ran here when the first went out, so it handed back only plays.
    expect(server.ran.map(({ args }) => args)).toMatchObject([
      { resume: null },
      { resume: { index: 1 } },
    ]);
  });

  it("shows the adopted session from a snapshot that came before the hand-back's answer", async () => {
    const { router, server } = setup();

    router.offerServer(sessionOf(["a", "b", "c"]));
    server.setConnected(false);
    await router.run("playback.next", {});
    server.hold();
    server.setConnected(true);
    await settle();

    // Convex shows a mutation's effect before it answers the mutation.
    const adopted = sessionOf(["a", "b", "c"], { index: 1 });

    router.offerServer(adopted);
    server.release();
    await vi.waitFor(() => expect(router.mode()).toBe("server"));
    expect(router.getSnapshot().state).toBe(adopted);
  });

  it("keeps the plays of a session stored at launch when the store answers during a hand-back", async () => {
    const earlier = { trackId: TrackId.make("a"), playedAt: 990_000 };
    const stored = { ...seedLocal(sessionOf(["a"]), phone.id), plays: [earlier], changed: true };
    const loaded = Promise.withResolvers<StoredSessions>();

    const store: SessionStore = {
      load: () => loaded.promise,
      saveLocal: async () => {},
      saveServer: async () => {},
    };

    const { router, server } = setup({ store });

    router.offerServer(sessionOf(["a", "b"]));
    server.setConnected(false);
    await router.run("playback.report", report(1, 0));
    server.setConnected(true);
    await settle();
    expect(server.names()).toEqual([]);

    loaded.resolve({ local: stored, server: null });
    await vi.waitFor(() => expect(router.mode()).toBe("server"));
    expect(server.ran.map(({ args }) => args)).toMatchObject([
      { plays: [earlier, { trackId: "b" }] },
    ]);
  });
});

describe("after a hand-back", () => {
  it("clears the stored session, trying again when the store fails to", async () => {
    const memory = memorySessionStore();
    let failures = 1;

    const store: SessionStore = {
      load: memory.store.load,
      saveServer: memory.store.saveServer,
      saveLocal: async (state) => {
        if (state === null && failures > 0) {
          failures -= 1;

          throw new Error("The disk is full");
        }

        await memory.store.saveLocal(state);
      },
    };

    const { router, server, clock } = setup({ store });

    router.offerServer(sessionOf(["a"]));
    server.setConnected(false);
    server.setConnected(true);
    await vi.waitFor(() => expect(router.mode()).toBe("server"));
    await settle();
    expect(memory.local()).not.toBeNull();

    clock.advance(1000);
    await settle();
    expect(memory.local()).toBeNull();
  });
});

describe("launching", () => {
  it("resumes a session played offline and never handed back, paused, and hands it back", async () => {
    const played = { ...seedLocal(sessionOf(["a", "b"], { index: 1 }), phone.id), changed: true };

    const stored = {
      local: { ...played, plays: [{ trackId: TrackId.make("a"), playedAt: 990_000 }] },
      server: null,
    };

    const { router, server } = setup({ stored, connected: false });

    await settle();
    expect(router.mode()).toBe("local");
    expect(router.getSnapshot().state).toMatchObject({ index: 1, playing: false });

    server.setConnected(true);
    await vi.waitFor(() => expect(router.mode()).toBe("server"));
    expect(server.ran[0]?.args).toMatchObject({
      plays: [{ trackId: "a", playedAt: 990_000 }],
      resume: { index: 1, playing: false },
    });
  });

  it("starts paused from the server's last snapshot without a connection, else with nothing queued", async () => {
    const remembered = setup({
      stored: { local: null, server: sessionOf(["a", "b"], { index: 1 }) },
      connected: false,
    });

    await remembered.router.startLocal();
    expect(remembered.router.getSnapshot().state).toMatchObject({ index: 1, playing: false });

    const fresh = setup({ connected: false });

    await fresh.router.startLocal();
    expect(fresh.router.mode()).toBe("local");
    expect(fresh.router.getSnapshot().state?.queue).toEqual([]);
  });
});
