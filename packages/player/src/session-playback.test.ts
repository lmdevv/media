import { positionAt } from "@media/contracts/clock";
import type { SessionClock } from "@media/contracts/clock";
import { EpochMillis } from "@media/contracts/units";
import { Brand } from "effect";
import { describe, expect, it } from "vitest";

import { NO_CONTROL, SessionPresence, startSession } from "./session-playback";
import type { SessionOp, SessionTimers, StartCommands } from "./session-playback";
import { asEntryId, playInSession } from "./session-react";
import type { JoinedSession, SessionAdds } from "./session-react";
import { scenario, song } from "./testing/session-harness";
import type { Member, Transition, World } from "./testing/session-harness";

/** How far a member's engine stands from the session's shared position now. */
const driftOf = (world: World, member: Member): number => {
  const playing = world.playing();

  if (member.engine.song !== playing.track.id) return Number.POSITIVE_INFINITY;

  return member.engine.samplePlayback().positionMs - world.shared();
};

/** The times each member's engine moved on to `songId` by itself, or loaded it. */
const changesTo = (member: Member, songId: string) =>
  member.engine.heard.filter((heard) => heard.song === songId && heard.kind !== "seek");

/** When the session's song, played from its start by `world.move`, ends, on the device's clock. */
const endOf = (world: World, lengthMs: number): number =>
  (world.calls.find((call) => call.op.kind === "play")?.at ?? Number.NaN) + lengthMs;

/** The host's ends the core took: at once, or at the end on its clock (`by: "core"`). */
const endsTaken = (world: World) =>
  world.calls.filter((call) => call.op.kind === "ended" && call.outcome === "applied");

/** Every move on at a song's end the core made, by a host's end or at the end itself. */
const endMoves = (world: World) => world.transitions.filter((change) => change.kind === "ended");

/** Where the session's clock stood in the song it left when `move` moved it on. */
const positionAtMove = (move: Transition | undefined): number =>
  move === undefined ? Number.NaN : positionAt(move.before.clock, EpochMillis.make(move.serverAt));

describe("a music session's players", { timeout: 60_000 }, () => {
  it("play the session's song where its clock stands, in step", async () => {
    await scenario(song("a", 60), [song("b", 60)], async (world) => {
      const host = world.join("Lucía", { hosting: true });

      await world.advance(500);
      world.move("Lucía", { kind: "play" });
      await world.advance(5_000);

      const guest = world.join("Aiko", {});

      await world.advance(8_000);

      for (const member of [host, guest]) {
        expect(member.engine.song).toBe("a");
        expect(member.engine.samplePlayback().playing).toBe(true);
        expect(Math.abs(driftOf(world, member))).toBeLessThan(120);
      }
    });
  });

  it("move on to the next song together at its end, without a gap, and the session follows", async () => {
    await scenario(song("a", 20), [song("b", 60), song("c", 60)], async (world) => {
      const host = world.join("Lucía", { hosting: true });
      const guests = [world.join("Aiko", {}), world.join("Mateo", {})];

      await world.advance(500);
      world.move("Lucía", { kind: "play" });
      await world.advance(30_000);

      expect(world.playing().track.id).toBe("b");

      const moves = [host, ...guests].map((member) => changesTo(member, "b"));

      for (const heard of moves) {
        // Each engine moved on by itself, at the end of the song: no load, so no gap.
        expect(heard[0]?.kind).toBe("advance");
      }

      const times = moves.map((heard) => heard[0]?.at ?? Number.NaN);

      expect(Math.max(...times) - Math.min(...times)).toBeLessThan(250);

      for (const member of [host, ...guests]) {
        expect(Math.abs(driftOf(world, member))).toBeLessThan(120);
      }

      // Only the host's engine said the song ended, and the core moved the session on once, at the
      // end on its clock or after; nobody skipped.
      expect(world.calls.filter((call) => call.op.kind === "next")).toEqual([]);
      expect(world.calls.find((call) => call.op.kind === "ended")).toMatchObject({
        by: "Lucía",
      });

      const movedOn = endMoves(world);

      expect(movedOn).toHaveLength(1);
      expect(movedOn[0]?.after.entry.track.id).toBe("b");
      expect(positionAtMove(movedOn[0])).toBeGreaterThanOrEqual(20_000);
    });
  });

  it("start a song put first at the end of the one before from its start, for everyone", async () => {
    await scenario(song("a", 20), [song("b", 60), song("c", 60)], async (world) => {
      const host = world.join("Lucía", { hosting: true });
      const guests = [world.join("Aiko", {}), world.join("Mateo", {})];
      const [, c] = world.queue();

      await world.advance(500);
      world.move("Lucía", { kind: "play" });
      // The session's song ends 20.5 s in, where every engine moves on to b by itself; 20 ms
      // later, before the host's move lands, someone puts c in front.
      await world.advance(20_020);
      world.toFront(c?.key ?? "missing");
      await world.advance(5_000);

      // The session moved on to c, queued first only after the end, from its start: no engine had
      // it, so none skipped any of it, and every one plays it where the clock stands.
      expect(endsTaken(world)).toMatchObject([{ by: "Lucía", startedAt: 0 }]);
      expect(world.playing().key).toBe(c?.key);

      for (const member of [host, ...guests]) {
        expect(member.engine.song).toBe("c");
        expect(Math.abs(driftOf(world, member))).toBeLessThan(120);
      }
    });
  });

  it("start a song put first just before the end of the one before from its start", async () => {
    await scenario(song("a", 20), [song("b", 60)], async (world) => {
      const host = world.join("Lucía", { hosting: true });
      const guest = world.join("Aiko", {});

      await world.advance(500);
      world.move("Lucía", { kind: "play" });
      // A second before the end, inside the time players take to preload a song, c goes first.
      await world.advance(19_000);

      const c = world.add(song("c", 60), "next");

      await world.advance(6_000);

      expect(endsTaken(world)).toMatchObject([{ startedAt: 0 }]);
      expect(world.playing().key).toBe(c);

      for (const member of [host, guest]) {
        expect(member.engine.song).toBe("c");
        expect(Math.abs(driftOf(world, member))).toBeLessThan(120);
      }
    });
  });

  it("pause at the end of the last song, back at its start, as old music's player stopped", async () => {
    await scenario(song("a", 10), [], async (world) => {
      const host = world.join("Lucía", { hosting: true });
      const guest = world.join("Aiko", {});

      await world.advance(500);
      world.move("Lucía", { kind: "play" });
      await world.advance(14_000);

      expect(world.clock()).toMatchObject({ status: "paused", positionAtAnchorMs: 0 });

      for (const member of [host, guest]) {
        expect(member.engine.samplePlayback()).toMatchObject({ playing: false });
        expect(member.engine.samplePlayback().positionMs).toBeLessThan(120);
      }
    });
  });

  for (const skewMs of [30_000, -30_000]) {
    it(`move the session on at the song's end when the host's clock runs ${String(skewMs / 1000)} s off and the song is known before a heartbeat answers`, async () => {
      await scenario(song("a", 20), [song("b", 60), song("c", 60)], async (world) => {
        const guest = world.join("Aiko", {});

        await world.advance(500);
        world.move("Lucía", { kind: "play" });
        await world.advance(5_000);

        // The host's page opens again with the session playing: it knows the song at once, and the
        // server's time only once its first heartbeat answers.
        const host = world.join("Lucía", { hosting: true, deviceClock: { skewMs } });

        await world.advance(25_000);

        const taken = endsTaken(world);

        expect(taken).toHaveLength(1);

        const end = endOf(world, 20_000);

        expect(taken[0]?.at).toBeGreaterThanOrEqual(end);
        expect(taken[0]?.at).toBeLessThan(end + 300);
        expect(world.playing().track.id).toBe("b");
        expect(changesTo(guest, "b")[0]?.kind).toBe("advance");

        for (const member of [host, guest]) {
          expect(Math.abs(driftOf(world, member))).toBeLessThan(120);
        }
      });
    });
  }

  for (const [label, firstTrip] of [
    ["ahead of", { outMs: 1_000, backMs: 30 }],
    ["behind", { outMs: 30, backMs: 1_000 }],
  ] as const) {
    it(`move the session on at the song's end when the host's first heartbeat put the server's time ${label} where it is`, async () => {
      await scenario(song("a", 20), [song("b", 60)], async (world) => {
        world.join("Aiko", {});

        await world.advance(500);
        world.move("Lucía", { kind: "play" });
        await world.advance(2_000);

        // A lopsided trip puts the first estimate about half a second off; the next heartbeat's
        // shorter trip corrects it, and the end is planned again on it.
        world.join("Lucía", { hosting: true, deviceClock: { skewMs: 12_000, firstTrip } });
        await world.advance(25_000);

        const taken = endsTaken(world);
        const end = endOf(world, 20_000);

        expect(taken).toHaveLength(1);
        expect(taken[0]?.at).toBeGreaterThanOrEqual(end);
        expect(taken[0]?.at).toBeLessThan(end + 300);
      });
    });
  }

  it("move on, never back to the song's start, when the host's page opens near the end and the queue lists late", async () => {
    await scenario(song("a", 20), [song("b", 60), song("c", 60)], async (world) => {
      const guest = world.join("Aiko", {});

      await world.advance(500);
      world.move("Lucía", { kind: "play" });
      await world.advance(18_000);

      // The host's page opens 2 s before the end; the song's details arrive at once, and the queue's
      // pages 2 s after the end.
      world.join("Lucía", { hosting: true, listsQueueAfterMs: 4_000 });
      await world.advance(8_000);

      // The core read its own queue at the end: the host's listing, still loading, decided nothing.
      const end = endOf(world, 20_000);
      const byHost = world.calls.filter((call) => call.by === "Lucía" && call.at > end - 5_000);

      expect(byHost.map((call) => call.op.kind)).toEqual(["ended"]);
      expect(byHost[0]).toMatchObject({ outcome: "applied" });
      expect(byHost[0]?.at).toBeGreaterThanOrEqual(end);
      expect(byHost[0]?.at).toBeLessThan(end + 300);
      expect(world.playing().track.id).toBe("b");
      expect(world.clock().status).toBe("playing");

      // The guest's engine moved on by itself at the end; the skip carried the time since, so it
      // never went back.
      expect(changesTo(guest, "b").map((heard) => heard.kind)).toEqual(["advance"]);
      expect(Math.abs(driftOf(world, guest))).toBeLessThan(120);
    });
  });

  it("go back into the song when the session seeks back after their engines moved on", async () => {
    await scenario(song("a", 20), [song("b", 60)], async (world) => {
      // No host follows, so nobody moves the session on: every engine plays ahead into b.
      world.allowControl(true);
      const members = [world.join("Aiko", {}), world.join("Mateo", {})];

      await world.advance(500);
      world.move("Aiko", { kind: "play" });
      await world.advance(21_000);

      for (const member of members) expect(member.engine.song).toBe("b");

      world.move("Aiko", { kind: "seek", positionMs: 10_000, revision: world.clock().revision });
      await world.advance(6_000);

      for (const member of members) {
        expect(member.engine.song).toBe("a");
        expect(Math.abs(driftOf(world, member))).toBeLessThan(120);
      }
    });
  });

  it("play what the session moved to, where its clock stands, when it is not what they moved on to", async () => {
    await scenario(song("a", 20), [song("b", 60), song("c", 60)], async (world) => {
      world.allowControl(true);
      const members = [world.join("Aiko", {}), world.join("Mateo", {})];

      await world.advance(500);
      world.move("Aiko", { kind: "play" });
      await world.advance(21_000);

      for (const member of members) expect(member.engine.song).toBe("b");

      const c = world.queue()[1]?.key ?? "missing";

      world.move("Aiko", { kind: "next", revision: world.clock().revision, entryId: c });
      await world.advance(6_000);

      for (const member of members) {
        expect(member.engine.song).toBe("c");
        expect(Math.abs(driftOf(world, member))).toBeLessThan(120);
      }
    });
  });

  it("let a pause someone made first stand over the host's move at the end", async () => {
    await scenario(song("a", 20), [song("b", 60)], async (world) => {
      world.allowControl(true);
      const host = world.join("Lucía", { hosting: true });
      const guest = world.join("Aiko", {});

      await world.advance(500);
      world.move("Lucía", { kind: "play" });
      // The session's song ends 20.5 s in, where the host's engine moves on and says so; its end,
      // under the clock before this pause, reaches the core 30 ms later, after the pause.
      await world.advance(20_010);
      world.move("Aiko", { kind: "pause" });
      await world.advance(3_000);

      // The end said before the pause is refused; paused past the end, the session then moves on
      // to the next song's start, still paused.
      expect(world.calls.filter((call) => call.op.kind === "ended")).toMatchObject([
        { by: "Lucía", outcome: "refused" },
        { by: "Lucía", outcome: "applied" },
      ]);
      expect(world.clock()).toMatchObject({ status: "paused", positionAtAnchorMs: 0 });
      expect(world.playing().track.id).toBe("b");

      for (const member of [host, guest]) {
        expect(member.engine.song).toBe("b");
        expect(member.engine.samplePlayback()).toMatchObject({ playing: false });
        expect(member.engine.samplePlayback().positionMs).toBeLessThan(120);
      }
    });
  });

  it("follow the clock with an engine that reports a load's start only after it, as the iOS one does", async () => {
    await scenario(song("a", 60), [], async (world) => {
      world.join("Lucía", { hosting: true });

      await world.advance(500);
      world.move("Lucía", { kind: "play" });
      await world.advance(3_000);

      const guest = world.join("Aiko", { reportsLate: true });

      await world.advance(3_000);
      expect(guest.playback.getSnapshot().follower).not.toBeNull();

      world.move("Lucía", { kind: "pause" });
      await world.advance(2_000);

      expect(guest.engine.samplePlayback().playing).toBe(false);
      expect(Math.abs(guest.engine.samplePlayback().positionMs - world.shared())).toBeLessThan(120);
    });
  });

  it("let a guest whose player something outside paused, as a call does, play it again in step", async () => {
    await scenario(song("a", 60), [], async (world) => {
      world.join("Lucía", { hosting: true });
      const guest = world.join("Aiko", {});

      await world.advance(500);
      world.move("Lucía", { kind: "play" });
      await world.advance(3_000);

      guest.engine.pause();
      await world.advance(2_000);

      expect(world.clock().status).toBe("playing");
      expect(guest.engine.samplePlayback().playing).toBe(false);

      await expect(guest.playback.togglePlay()).resolves.toBeNull();
      await world.advance(3_000);

      expect(guest.engine.samplePlayback().playing).toBe(true);
      expect(Math.abs(driftOf(world, guest))).toBeLessThan(120);
    });
  });

  it("let a guest whose browser held back their player, as they joined a playing session, start it in step with one tap", async () => {
    await scenario(song("a", 60), [], async (world) => {
      world.join("Lucía", { hosting: true });

      await world.advance(500);
      world.move("Lucía", { kind: "play" });
      await world.advance(3_000);

      // A fresh tab: the browser refuses the load's start and every play the follower tries.
      const guest = world.join("Aiko", { blocksAutoplay: true });

      await world.advance(5_000);

      expect(guest.engine.samplePlayback().playing).toBe(false);
      expect(guest.controller.getSnapshot().autoplayBlocked).toBe(true);
      expect(guest.playback.getSnapshot().follower?.follow).toBe("blocked");

      const before = world.clock();

      await expect(guest.engine.tap(() => guest.playback.togglePlay())).resolves.toBeNull();
      await world.advance(3_000);

      expect(guest.engine.samplePlayback().playing).toBe(true);
      expect(Math.abs(driftOf(world, guest))).toBeLessThan(120);
      // The tap started only this player: the session did not move.
      expect(world.clock()).toStrictEqual(before);
      expect(world.calls.filter((call) => call.by === "Aiko")).toEqual([]);
    });
  });

  it("let a member who may control, whose browser held back their player, start it with one tap and pause no one", async () => {
    await scenario(song("a", 60), [], async (world) => {
      const host = world.join("Lucía", { hosting: true });

      await world.advance(500);
      world.move("Lucía", { kind: "play" });
      await world.advance(3_000);

      world.allowControl(true);

      const guest = world.join("Aiko", { blocksAutoplay: true });

      await world.advance(5_000);

      expect(guest.playback.getSnapshot().follower?.follow).toBe("blocked");

      const tapped = guest.engine.tap(() => guest.playback.togglePlay());

      await world.advance(3_000);

      await expect(tapped).resolves.toBeNull();
      expect(world.clock().status).toBe("playing");

      for (const member of [host, guest]) {
        expect(member.engine.samplePlayback().playing).toBe(true);
        expect(Math.abs(driftOf(world, member))).toBeLessThan(120);
      }
    });
  });

  it("skip to an entry just queued, before the queue they see shows it", async () => {
    await scenario(song("a", 60), [], async (world) => {
      const host = world.join("Lucía", { hosting: true });

      await world.advance(500);
      world.move("Lucía", { kind: "play" });
      await world.advance(2_000);

      const key = world.add(song("b", 30));
      // The core's answer comes on the test clock, so time moves on before it is awaited.
      const jumped = host.playback.jump(key);

      await world.advance(3_000);

      await expect(jumped).resolves.toBeNull();
      expect(world.playing().track.id).toBe("b");
      expect(host.engine.song).toBe("b");
    });
  });

  it("leave a song without a known length playing until someone skips it", async () => {
    await scenario(song("a", 0), [song("b", 30)], async (world) => {
      world.join("Lucía", { hosting: true });

      await world.advance(500);
      world.move("Lucía", { kind: "play" });
      await world.advance(5_000);

      expect(world.playing().track.id).toBe("a");
      expect(world.calls.filter((call) => call.op.kind === "next")).toEqual([]);
      expect(endMoves(world)).toEqual([]);
    });
  });

  it("play a song now in a paused session for everyone at the word of a member who may control, and refuse one who may not", async () => {
    await scenario(song("a", 60), [], async (world) => {
      const host = world.join("Lucía", { hosting: true });
      const guest = world.join("Aiko", {});

      await world.advance(500);

      expect(await guest.playback.playNow("c", world.sessionId())).toBe(NO_CONTROL);
      expect(world.clock().status).toBe("paused");

      const played = host.playback.playNow("c", world.sessionId());

      await world.advance(500);

      expect(await played).toBeNull();
      expect(world.playing().track.id).toBe("c");
      expect(world.clock()).toMatchObject({ status: "playing", revision: 1 });

      await world.advance(3_000);

      for (const member of [host, guest]) {
        expect(member.engine.song).toBe("c");
        expect(member.engine.samplePlayback().playing).toBe(true);
        expect(Math.abs(driftOf(world, member))).toBeLessThan(120);
      }
    });
  });

  it("play a song now in a paused session without the song before sounding for a moment", async () => {
    await scenario(song("a", 60), [song("b", 60)], async (world) => {
      const host = world.join("Lucía", { hosting: true, hearsLateMs: 200 });

      await world.advance(2_000);

      const since = world.now();
      const played = host.playback.playNow("c", world.sessionId());

      await world.advance(3_000);

      expect(await played).toBeNull();
      expect(
        host.engine.heard.filter(
          (heard) => heard.at >= since && heard.song === "a" && heard.kind === "play",
        ),
      ).toEqual([]);
      expect(host.engine.song).toBe("c");
      expect(host.engine.samplePlayback().playing).toBe(true);
      // The queue stays as it was.
      expect(world.queue().map((entry) => entry.track.id)).toEqual(["b"]);
    });
  });

  it("refuse a pause from a guest the host has not let control, and keep their player on the clock", async () => {
    await scenario(song("a", 60), [], async (world) => {
      world.join("Lucía", { hosting: true });
      const guest = world.join("Aiko", {});

      await world.advance(500);
      world.move("Lucía", { kind: "play" });
      await world.advance(3_000);

      await expect(guest.playback.togglePlay()).resolves.toMatch(/control/u);

      await world.advance(2_000);

      expect(world.clock().status).toBe("playing");
      expect(guest.engine.samplePlayback().playing).toBe(true);
      expect(Math.abs(driftOf(world, guest))).toBeLessThan(120);
    });
  });

  it("hide a song a member may not play, and play the next one for them where the clock stands", async () => {
    await scenario(song("a", 10), [song("explicit", 10), song("c", 60)], async (world) => {
      world.join("Lucía", { hosting: true });
      const kid = world.join("Sam", { hidden: ["explicit"] });

      await world.advance(500);
      world.move("Lucía", { kind: "play" });
      await world.advance(15_000);

      expect(world.playing().track.id).toBe("explicit");
      expect(kid.engine.song).not.toBe("explicit");

      await world.advance(10_000);

      expect(world.playing().track.id).toBe("c");
      expect(kid.engine.song).toBe("c");
      expect(kid.engine.heard.some((heard) => heard.song === "explicit")).toBe(false);
      expect(Math.abs(driftOf(world, kid))).toBeLessThan(120);
    });
  });

  it("load a stream that failed again where the clock stands, without moving the session", async () => {
    await scenario(song("a", 120), [], async (world) => {
      world.allowControl(true);
      world.join("Lucía", { hosting: true });
      const guest = world.join("Aiko", {});

      await world.advance(500);
      world.move("Lucía", { kind: "play" });
      await world.advance(10_000);

      const before = world.calls.length;

      guest.engine.expire();
      await world.advance(5_000);

      expect(world.calls.slice(before)).toEqual([]);
      expect(world.clock()).toMatchObject({ status: "playing", revision: 1 });
      expect(guest.engine.heard.filter((heard) => heard.kind === "load")).toHaveLength(2);
      expect(Math.abs(driftOf(world, guest))).toBeLessThan(120);
    });
  });

  it("hold the session for the host's stalled player, and play it on once it recovers", async () => {
    await scenario(song("a", 120), [], async (world) => {
      const host = world.join("Lucía", { hosting: true });
      const guest = world.join("Aiko", {});

      await world.advance(500);
      world.move("Lucía", { kind: "play" });
      await world.advance(5_000);
      host.engine.stall(true);
      await world.advance(3_000);

      expect(world.clock().status).toBe("paused");
      expect(guest.engine.samplePlayback().playing).toBe(false);

      host.engine.stall(false);
      await world.advance(3_000);

      expect(world.clock().status).toBe("playing");

      for (const member of [host, guest]) {
        expect(member.engine.samplePlayback().playing).toBe(true);
        expect(Math.abs(driftOf(world, member))).toBeLessThan(250);
      }
    });
  });
});

/** Song ids as the session's screens hand them to `playInSession`. */
const asSongId = Brand.nominal<Parameters<typeof playInSession>[3][number]>();

const asSessionId = Brand.nominal<JoinedSession["sessionId"]>();

/** The person's session as their screen shows it, joined as its host, playing nothing they see. */
const joinedView = (world: World): JoinedSession => ({
  state: "joined",
  sessionId: asSessionId(world.sessionId()),
  host: "lucia",
  hostDisplayName: "Lucía",
  role: "host",
  link: "mt_session.secret",
  settings: { join: "open", control: false, add: false },
  may: { control: true, add: true, manage: true },
  clock: world.clock(),
  item: null,
  entryId: null,
  lengthMs: world.playing().track.durationMs,
  members: [],
  pending: null,
});

/** `core.together.add` as `by`'s screen calls it, through the world's core. */
const addsAs = (world: World, by: string): SessionAdds => ({
  core: {
    together: {
      add: async ({ item, at, sessionId }) => ({
        entryId: asEntryId(await world.addAs(by, item.ref.id, at ?? "end", sessionId)),
      }),
    },
  },
});

/**
 * The verifier's reproductions of fix round 3 (ADR 0017): each failed on ea37b18c, where the
 * host's player decided a song's end from its own clock and its own copy of the queue, a Jam's
 * transport took no number from #163's sequence, and playing a song now was two calls.
 */
describe("a music session's end, transport, and play now", { timeout: 60_000 }, () => {
  it("never moves on early when the host's wall clock is set 30 s ahead mid-song", async () => {
    await scenario(song("a", 30), [song("b", 60)], async (world) => {
      const host = world.join("Lucía", { hosting: true, deviceClock: { skewMs: 0 } });
      const guest = world.join("Aiko", {});

      await world.advance(500);
      world.move("Lucía", { kind: "play" });
      await world.advance(4_500);

      // 5 s in, the host's device clock is set 30 s ahead, past the song's end, just before a
      // heartbeat answers.
      world.setWallClock("Lucía", 30_000);
      await world.advance(15_000);

      expect(world.playing().track.id).toBe("a");
      expect(endMoves(world)).toEqual([]);

      for (const member of [host, guest]) {
        expect(member.engine.song).toBe("a");
        expect(Math.abs(driftOf(world, member))).toBeLessThan(120);
      }

      // It still moves on at the song's real end.
      await world.advance(15_000);

      const movedOn = endMoves(world);

      expect(movedOn).toHaveLength(1);
      expect(positionAtMove(movedOn[0])).toBeGreaterThanOrEqual(30_000);
      expect(world.playing().track.id).toBe("b");
    });
  });

  it("moves on to a song added 10 ms before the end, though the host hears of the add 500 ms late", async () => {
    await scenario(song("a", 20), [], async (world) => {
      const host = world.join("Lucía", { hosting: true, hearsLateMs: 500 });
      const guest = world.join("Aiko", {});

      await world.advance(500);
      world.move("Lucía", { kind: "play" });
      // The song ends 20.5 s in.
      await world.advance(19_990);

      const b = world.add(song("b", 30));

      await world.advance(5_000);

      // The core read its queue at the end: b was in it, so the Jam played b, and never went back
      // to a's start, paused, with b queued.
      expect(world.playing().key).toBe(b);
      expect(world.clock().status).toBe("playing");
      expect(
        world.transitions.filter(
          (change) =>
            change.after.entry === change.before.entry && change.after.clock.status === "paused",
        ),
      ).toEqual([]);

      for (const member of [host, guest]) {
        expect(member.engine.song).toBe("b");
        expect(member.engine.samplePlayback().playing).toBe(true);
        expect(Math.abs(driftOf(world, member))).toBeLessThan(120);
      }
    });
  });

  it("lets no lock-screen press made before the person plays the Jam pause it again", async () => {
    await scenario(song("a", 60), [], async (world) => {
      const host = world.join("Lucía", { hosting: true, phone: true });

      await world.advance(500);

      // The Jam is paused. The host presses pause on the lock screen; the press reaches the app's
      // JavaScript 600 ms later. Meanwhile they play the Jam in the app.
      world.press("Lucía", "pause", 600);
      await world.advance(100);

      const played = host.playback.togglePlay();

      await world.advance(2_000);

      expect(await played).toBeNull();
      expect(world.calls.filter((call) => call.op.kind === "pause")).toEqual([]);
      expect(world.clock().status).toBe("playing");
      expect(host.engine.samplePlayback().playing).toBe(true);
    });
  });

  it("plays nothing in the Jam the person moved to while a song played now in the one before answers", async () => {
    await scenario(song("a", 60), [], async (world) => {
      const host = world.join("Lucía", { hosting: true, answersLateMs: 1_000 });

      await world.advance(500);

      const playing = playInSession(addsAs(world, "Lucía"), joinedView(world), host.playback, [
        asSongId("x"),
        asSongId("y"),
      ]).catch((cause: unknown) => cause);

      // The person ends that Jam and starts another, as on another device, while the core's answers
      // are still on their way.
      await world.advance(1_200);
      world.replaceSession(song("z", 60));
      await world.advance(3_000);
      await playing;

      expect(world.sessionId()).not.toBe("session");
      expect(world.playing().track.id).toBe("z");
      expect(world.clock()).toMatchObject({ status: "paused", revision: 0 });
      expect(world.queue()).toEqual([]);
      expect(host.engine.samplePlayback().playing).toBe(false);
    });
  });

  it("lets the core, not the view of another session, decide a song played now in the one before", async () => {
    await scenario(song("a", 60), [], async (world) => {
      const host = world.join("Lucía", { hosting: true });
      const guest = world.join("Aiko", {});
      const before = world.sessionId();

      await world.advance(500);
      world.allowControl(true);
      await world.advance(500);
      world.replaceSession(song("z", 60));
      world.allowControl(false);
      await world.advance(500);

      // The guest may not control the Jam they see now, but the song was chosen in the one before:
      // the core answers for that one, which they are no longer in.
      const played = guest.playback.playNow("x", before);

      await world.advance(500);

      expect(await played).toMatch(/no longer in that group session/u);
      expect(world.calls.filter((call) => call.op.kind === "playNow")).toMatchObject([
        { by: "Aiko", outcome: "refused" },
      ]);
      expect(host.engine.song).toBe("z");
    });
  });
});

/** A session as the core keeps it, for `startSession`'s calls. */
interface CoreSession {
  readonly id: string;
  readonly queue: Array<string>;
  clock: SessionClock;
}

/** Songs one `addItems` call takes at most, as the core takes as many as one call decides. */
const FILL_TAKES = 196;

/**
 * The core as one person reaches it, for `startSession`: their session, which `create` starts,
 * and `control` and `addItems`, which refuse a call for a session they are no longer in, as the
 * core's session fence does. `hold` holds the next `addItems` on its way until `letGo`.
 */
const personalCore = () => {
  const sessions: Array<CoreSession> = [];
  let current: CoreSession | null = null;
  let release: (() => void) | null = null;
  let holding = false;

  const create = (): CoreSession => {
    const session: CoreSession = {
      id: `session-${String(sessions.length + 1)}`,
      queue: [],
      clock: {
        status: "paused",
        positionAtAnchorMs: 0,
        anchorServerTime: EpochMillis.make(1_000),
        playbackRate: 1,
        revision: 0,
      },
    };

    sessions.push(session);
    current = session;

    return session;
  };

  /** The person's session, when it is the one `sessionId` names. */
  const theirs = (sessionId: string): CoreSession => {
    if (current?.id !== sessionId) throw new Error("You are no longer in that group session");

    return current;
  };

  const commands: StartCommands = {
    create: async () => {
      const { id } = create();

      return { sessionId: id, link: `mt_${id}.secret` };
    },
    control: async (op: SessionOp, sessionId) => {
      const session = theirs(sessionId);
      const { clock } = session;
      const revision = clock.revision + 1;

      // `startSession` only plays and seeks.
      if (op.kind === "play") session.clock = { ...clock, status: "playing", revision };

      if (op.kind === "seek") {
        session.clock = { ...clock, positionAtAnchorMs: op.positionMs, revision };
      }

      return session.clock;
    },
    addItems: async (sessionId, trackIds) => {
      if (holding) {
        holding = false;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }

      const taken = trackIds.slice(0, FILL_TAKES);

      theirs(sessionId).queue.push(...taken);

      return taken.length;
    },
  };

  return {
    commands,
    sessions,
    /** Holds the next `addItems` on its way to the core. */
    hold: () => {
      holding = true;
    },
    letGo: () => {
      release?.();
    },
    /** Ends the person's session and starts another, as they might on another device. */
    replace: () => {
      current = null;
      create();
    },
  };
};

describe("starting a music session", () => {
  it("stands where the song stood, then queues the songs after it, up to the session's limit", async () => {
    const core = personalCore();
    const upcoming = Array.from({ length: 520 }, (_, at) => `song-${String(at)}`);

    const started = await startSession(
      { trackId: "first", positionNow: () => 42_000, playing: true, upcoming },
      core.commands,
    );

    expect(started.link).toBe("mt_session-1.secret");
    expect(core.sessions[0]?.clock).toMatchObject({
      status: "playing",
      positionAtAnchorMs: 42_000,
      revision: 2,
    });
    await expect(started.queued).resolves.toBe(500);
    expect(core.sessions[0]?.queue).toEqual(upcoming.slice(0, 500));
  });

  it("lets none of the songs it queues land in a session that replaced the one it started", async () => {
    const core = personalCore();

    core.hold();

    const started = await startSession(
      {
        trackId: "first",
        positionNow: () => 42_000,
        playing: true,
        upcoming: ["second", "third"],
      },
      core.commands,
    );

    // The songs wait on their way while the person ends that session and starts another.
    core.replace();
    core.letGo();

    await expect(started.queued).rejects.toThrow("You are no longer in that group session");

    const [first, replacement] = core.sessions;

    expect(first?.queue).toEqual([]);
    expect(replacement?.queue).toEqual([]);
    expect(replacement?.clock).toMatchObject({
      status: "paused",
      positionAtAnchorMs: 0,
      revision: 0,
    });
  });
});

/**
 * A device for `SessionPresence`: a wall clock someone may set, a monotonic clock that stops while
 * the device sleeps, a server whose clock runs `SERVER_AHEAD_MS` ahead of real time, and heartbeats
 * the test answers after a trip it chooses.
 */
const SERVER_AHEAD_MS = 4_000;

const presenceDevice = () => {
  const clocks = { real: 1_760_000_000_000, wallSet: 0, monotonic: 50_000 };
  const beats: Array<() => void> = [];
  let answer: ((serverTime: number) => void) | null = null;

  const timers: SessionTimers = {
    now: () => clocks.real + clocks.wallSet,
    monotonic: () => clocks.monotonic,
    after: (_ms, callback) => {
      beats.push(callback);

      return () => undefined;
    },
  };

  const heartbeat = (): Promise<{ readonly serverTime: number }> =>
    new Promise((resolve) => {
      answer = (serverTime) => {
        resolve({ serverTime });
      };
    });

  /** Time passes; the monotonic clock runs only while the device is awake. */
  const pass = (ms: number, awake = true): void => {
    clocks.real += ms;

    if (awake) clocks.monotonic += ms;
  };

  const serverNow = (): number => clocks.real + SERVER_AHEAD_MS;

  /** The heartbeat out comes back after a trip of `tripMs`, the server reading halfway. */
  const answerAfter = async (tripMs: number): Promise<void> => {
    pass(tripMs / 2);

    const serverTime = serverNow();

    pass(tripMs / 2);
    answer?.(serverTime);
    await Promise.resolve();
    await Promise.resolve();
  };

  return {
    presence: new SessionPresence(heartbeat, timers),
    serverNow,
    pass,
    answerAfter,
    /** Sets the wall clock `byMs` from where it ran, as a person or NTP sets it. */
    setWall: (byMs: number) => {
      clocks.wallSet += byMs;
    },
    /** The next heartbeat goes out, as its timer fires. */
    beat: () => {
      beats.shift()?.();
    },
  };
};

/** 5 s on, the next heartbeat goes out and comes back after a trip of `tripMs`. */
const nextBeat = async (
  device: ReturnType<typeof presenceDevice>,
  tripMs: number,
): Promise<void> => {
  device.pass(5_000);
  device.beat();
  await device.answerAfter(tripMs);
};

/** How far `presence`'s estimate of the server's time stands from the server's time now. */
const offBy = (device: ReturnType<typeof presenceDevice>): number =>
  Math.abs((device.presence.now() ?? Number.NaN) - device.serverNow());

describe("estimating the server's time for a session", () => {
  it("starts over after the device slept with its monotonic clock stopped", async () => {
    const device = presenceDevice();

    device.presence.keep("session");
    await device.answerAfter(10);

    // Three more heartbeats, each 5 s on, one after another.
    await [1, 2, 3].reduce(
      (done: Promise<void>) => done.then(() => nextBeat(device, 10)),
      Promise.resolve(),
    );

    expect(offBy(device)).toBeLessThan(10);

    // The device sleeps for a minute: real time and the server's run on, its monotonic clock
    // stops, as on macOS and iOS. The heartbeat after waking takes a longer trip than those before.
    device.pass(60_000, false);
    device.beat();
    await device.answerAfter(80);

    expect(offBy(device)).toBeLessThan(50);
  });

  it("measures nothing from a heartbeat whose trip the device slept through", async () => {
    const device = presenceDevice();

    device.presence.keep("session");
    await device.answerAfter(10);
    device.pass(5_000);
    device.beat();

    // It slept while the heartbeat was out: the trip reads as short on the monotonic clock.
    device.pass(30_000, false);
    await device.answerAfter(4);

    expect(device.presence.now()).toBeNull();

    device.pass(5_000);
    device.beat();
    await device.answerAfter(20);

    expect(offBy(device)).toBeLessThan(20);
  });

  it("moves nothing when the wall clock is set, before and after the next heartbeat", async () => {
    const device = presenceDevice();

    device.presence.keep("session");
    await device.answerAfter(10);
    device.setWall(30_000);
    device.pass(2_000);

    expect(offBy(device)).toBeLessThan(10);

    device.pass(3_000);
    device.beat();
    await device.answerAfter(10);

    expect(offBy(device)).toBeLessThan(10);
  });
});
