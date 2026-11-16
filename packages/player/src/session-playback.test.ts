import type { SessionClock } from "@media/contracts/clock";
import { EpochMillis } from "@media/contracts/units";
import { describe, expect, it } from "vitest";

import { startSession } from "./session-playback";
import type { SessionOp, StartCommands } from "./session-playback";
import { scenario, song } from "./testing/session-harness";
import type { Member, World } from "./testing/session-harness";

/** How far a member's engine stands from the session's shared position now. */
const driftOf = (world: World, member: Member): number => {
  const playing = world.playing();

  if (member.engine.song !== playing.track.id) return Number.POSITIVE_INFINITY;

  return member.engine.samplePlayback().positionMs - world.shared();
};

/** The times each member's engine moved on to `songId` by itself, or loaded it. */
const changesTo = (member: Member, songId: string) =>
  member.engine.heard.filter((heard) => heard.song === songId && heard.kind !== "seek");

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

      // Only the host moved the session on, once, against the clock it decided on; the entry every
      // engine preloaded starts as far in as the clock ran past the end.
      const skips = world.calls.filter((call) => call.op.kind === "next");

      expect(skips).toMatchObject([{ by: "Lucía", outcome: "applied" }]);
      expect(skips[0]?.startedAt).toBeGreaterThan(0);
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
      expect(world.calls.filter((call) => call.op.kind === "next")).toMatchObject([
        { by: "Lucía", outcome: "applied", startedAt: 0 },
      ]);
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

      expect(world.calls.filter((call) => call.op.kind === "next")).toMatchObject([
        { by: "Lucía", outcome: "applied", startedAt: 0 },
      ]);
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
      // The session's song ends 20.5 s in; the host's player moves it on 40 ms later, against the
      // clock before this pause, which the core lands first.
      await world.advance(20_030);
      world.move("Aiko", { kind: "pause" });
      await world.advance(3_000);

      // The skip decided before the pause is refused; paused past the end, the session then moves
      // on to the next song's start, still paused.
      expect(world.calls.filter((call) => call.op.kind === "next")).toMatchObject([
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
