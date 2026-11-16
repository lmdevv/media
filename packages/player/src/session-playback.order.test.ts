/**
 * Random orders of what can happen in a music session (moves from other screens, a viewer's own
 * moves through their player, queue changes, stalls, and the time between them) against the real
 * controller, session playback, and follower. Whatever the order, once things settle every
 * member plays the session's song where its clock stands, playing exactly when it plays, and
 * only the host's player or a person moves the session on.
 */
import { positionAt } from "@media/contracts/clock";
import { EpochMillis } from "@media/contracts/units";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { SessionOp } from "./session-playback";
import { scenario, song } from "./testing/session-harness";
import type { Member, Transition, World } from "./testing/session-harness";

type Step =
  | { readonly kind: "wait"; readonly ms: number }
  | { readonly kind: "play" | "pause"; readonly by: "screen" | "viewer" }
  | { readonly kind: "seek"; readonly by: "screen" | "viewer"; readonly share: number }
  | { readonly kind: "next"; readonly by: "screen" | "viewer" }
  | { readonly kind: "jump"; readonly by: "screen" | "viewer"; readonly pick: number }
  | { readonly kind: "add"; readonly seconds: number; readonly at: "next" | "end" }
  | { readonly kind: "remove"; readonly pick: number }
  | { readonly kind: "front"; readonly pick: number }
  | { readonly kind: "stall"; readonly who: number; readonly stalled: boolean };

const by = fc.constantFrom("screen" as const, "viewer" as const);

const step: fc.Arbitrary<Step> = fc.oneof(
  {
    weight: 4,
    arbitrary: fc.integer({ min: 10, max: 4_000 }).map((ms) => ({ kind: "wait", ms }) as const),
  },
  { weight: 2, arbitrary: by.map((who) => ({ kind: "play", by: who }) as const) },
  { weight: 2, arbitrary: by.map((who) => ({ kind: "pause", by: who }) as const) },
  {
    weight: 2,
    arbitrary: fc
      .record({ by, share: fc.double({ min: 0, max: 1, noNaN: true }) })
      .map(({ by: who, share }) => ({ kind: "seek", by: who, share }) as const),
  },
  { weight: 1, arbitrary: by.map((who) => ({ kind: "next", by: who }) as const) },
  {
    weight: 1,
    arbitrary: fc
      .record({ by, pick: fc.nat(10) })
      .map(({ by: who, pick }) => ({ kind: "jump", by: who, pick }) as const),
  },
  {
    weight: 2,
    arbitrary: fc
      .record({
        seconds: fc.integer({ min: 4, max: 30 }),
        at: fc.constantFrom("next" as const, "end" as const),
      })
      .map(({ seconds, at }) => ({ kind: "add", seconds, at }) as const),
  },
  { weight: 1, arbitrary: fc.nat(10).map((pick) => ({ kind: "remove", pick }) as const) },
  { weight: 1, arbitrary: fc.nat(10).map((pick) => ({ kind: "front", pick }) as const) },
  {
    weight: 1,
    arbitrary: fc
      .record({ who: fc.nat(2), stalled: fc.boolean() })
      .map(({ who, stalled }) => ({ kind: "stall", who, stalled }) as const),
  },
);

/**
 * How far a member's engine stands from the session's shared position, held at the song's end
 * past it as the follower holds it, or null off the session's song.
 */
const driftOf = (world: World, member: Member): number | null => {
  const { track } = world.playing();

  return member.engine.song === track.id
    ? member.engine.samplePlayback().positionMs - Math.min(world.shared(), track.durationMs)
    : null;
};

let added = 0;

/** Moves the session from another screen; a move the core refuses, as a stale one, changes nothing. */
const fromScreen = (world: World, op: SessionOp): void => {
  try {
    world.move("screen", op);
  } catch {
    // Refused, as the core refuses a move against an older clock.
  }
};

const runStep = async (world: World, members: ReadonlyArray<Member>, next: Step): Promise<void> => {
  // Mateo moves through his own player; another screen moves the session without one; Aiko only
  // listens, so her player never moves the session.
  const mateo = members.find((member) => member.name === "Mateo");

  if (mateo === undefined) return;

  const viewer = mateo.playback;
  const revision = world.clock().revision;
  const queue = world.queue();

  const picked = (pick: number): string | undefined => queue[pick % Math.max(1, queue.length)]?.key;

  switch (next.kind) {
    case "wait": {
      await world.advance(next.ms);

      break;
    }

    case "play":
    case "pause": {
      if (next.by === "viewer") {
        const playing = world.clock().status === "playing";

        if ((next.kind === "pause") === playing) void viewer.togglePlay();
      } else fromScreen(world, { kind: next.kind });

      break;
    }

    case "seek": {
      const positionMs = Math.round(next.share * world.playing().track.durationMs * 0.9);

      if (next.by === "viewer") void viewer.seek(positionMs);
      else fromScreen(world, { kind: "seek", positionMs, revision });

      break;
    }

    case "next": {
      if (next.by === "viewer") void viewer.next();
      else fromScreen(world, { kind: "next", revision });

      break;
    }

    case "jump": {
      const key = picked(next.pick);

      if (key === undefined) break;

      if (next.by === "viewer") void viewer.jump(key);
      else fromScreen(world, { kind: "next", revision, entryId: key });

      break;
    }

    case "add": {
      added += 1;
      world.add(song(`s${String(added)}`, next.seconds), next.at);

      break;
    }

    case "remove": {
      const key = picked(next.pick);

      if (key !== undefined) world.remove(key);

      break;
    }

    case "front": {
      const key = picked(next.pick);

      if (key !== undefined) world.toFront(key);

      break;
    }

    case "stall": {
      members[next.who % members.length]?.engine.stall(next.stalled);

      break;
    }
  }
};

/** Waits until just before the first song's end, 25 seconds in. */
const WAIT_TO_THE_END: Array<Step> = [{ kind: "wait", ms: 24_300 }];

/** Waits until just after the first song's end. */
const WAIT_PAST_THE_END: Array<Step> = [{ kind: "wait", ms: 25_200 }];

/** Waits as long as the longest song. */
const WAIT_A_SONG: Array<Step> = [{ kind: "wait", ms: 26_000 }];

/** A step around a song's end, where engines move on a network round trip before the session. */
const nearTheEnd: fc.Arbitrary<Step> = fc.oneof(
  {
    weight: 4,
    arbitrary: fc.integer({ min: 10, max: 300 }).map((ms) => ({ kind: "wait", ms }) as const),
  },
  { weight: 1, arbitrary: by.map((who) => ({ kind: "pause", by: who }) as const) },
  { weight: 1, arbitrary: by.map((who) => ({ kind: "play", by: who }) as const) },
  {
    weight: 1,
    arbitrary: fc
      .record({ by, share: fc.double({ min: 0.5, max: 0.9, noNaN: true }) })
      .map(({ by: who, share }) => ({ kind: "seek", by: who, share }) as const),
  },
  { weight: 1, arbitrary: by.map((who) => ({ kind: "next", by: who }) as const) },
  {
    weight: 1,
    arbitrary: fc
      .record({ by, pick: fc.nat(3) })
      .map(({ by: who, pick }) => ({ kind: "jump", by: who, pick }) as const),
  },
  { weight: 1, arbitrary: fc.nat(3).map((pick) => ({ kind: "remove", pick }) as const) },
  { weight: 1, arbitrary: fc.nat(3).map((pick) => ({ kind: "front", pick }) as const) },
  {
    weight: 1,
    arbitrary: fc
      .constantFrom("next" as const, "end" as const)
      .map((at) => ({ kind: "add", seconds: 12, at }) as const),
  },
);

/**
 * Plays `script` in a session of a host and two members, then lets it settle and checks it. Mateo's
 * engine reports a load's start only on its next status, as the iOS app's does. A host who joins
 * late leaves nobody to move the session on at a song's end during the script, so
 * every engine plays on into the queued song by itself and stays there, ahead of the session,
 * while the script runs.
 */
const playScript = (
  script: ReadonlyArray<Step>,
  host: "present" | "late" = "present",
): Promise<void> =>
  scenario(song("a", 25), [song("b", 20), song("c", 30)], async (world) => {
    world.allowControl(true);

    const guests = [world.join("Aiko", {}), world.join("Mateo", { reportsLate: true })];

    const members =
      host === "present" ? [world.join("Lucía", { hosting: true }), ...guests] : [...guests];

    await world.advance(500);
    world.move("screen", { kind: "play" });
    await world.advance(1_000);

    await script.reduce(
      (done: Promise<void>, next) => done.then(() => runStep(world, members, next)),
      Promise.resolve(),
    );

    if (host === "late") members.unshift(world.join("Lucía", { hosting: true }));

    for (const member of members) member.engine.stall(false);

    // A player off by less than the seek threshold nudges its speed by 5% until it is in step,
    // which takes up to 30 seconds (the shared follower policy, ADR 0017); wait that out.
    await world.advance(32_000);

    // Around a song's end the session moves on a network round trip after the engines did, and
    // after a move every player takes a round trip to hear it: check once neither is under way.
    const unsettled = (): boolean => {
      const lastMove = world.calls.findLast((call) => call.outcome === "applied")?.at ?? 0;

      const nearAnEnd =
        world.clock().status === "playing" &&
        Math.abs(world.shared() - world.playing().track.durationMs) < 1_000;

      return nearAnEnd || world.now() - lastMove < 3_000;
    };

    const settleDown = async (left: number): Promise<void> => {
      if (left <= 0 || !unsettled()) return;

      await world.advance(500);

      return settleDown(left - 500);
    };

    await settleDown(10_000);

    // A guest's player never moved the session on by itself.
    const guestSkips = world.calls.filter(
      (call) => call.op.kind === "next" && call.by === "Aiko" && call.outcome === "applied",
    );

    expect(guestSkips).toEqual([]);

    const playing = world.clock().status === "playing";

    for (const member of members) {
      const drift = driftOf(world, member);

      expect(member.engine.song, member.name).toBe(world.playing().track.id);
      expect(member.engine.samplePlayback().playing, member.name).toBe(playing);
      expect(Math.abs(drift ?? Number.POSITIVE_INFINITY), member.name).toBeLessThan(250);
    }
  });

describe("a music session's players, whatever happens in whatever order", () => {
  it(
    "settle on the session's song where its clock stands, playing exactly when it plays",
    { timeout: 240_000 },
    async () => {
      await fc.assert(
        fc.asyncProperty(fc.array(step, { minLength: 1, maxLength: 14 }), (script) =>
          playScript(script),
        ),
        { numRuns: 20 },
      );
    },
  );

  it(
    "settle the same way after anything happens around a song's end",
    { timeout: 240_000 },
    async () => {
      // The first song ends 25 seconds in; start just before its end.
      const aroundTheEnd = fc
        .array(nearTheEnd, { minLength: 1, maxLength: 10 })
        .map((script): ReadonlyArray<Step> => WAIT_TO_THE_END.concat(script));

      await fc.assert(
        fc.asyncProperty(aroundTheEnd, (script) => playScript(script)),
        { numRuns: 30 },
      );
    },
  );

  it(
    "settle the same way after anything happens while their engines play ahead of the session",
    { timeout: 240_000 },
    async () => {
      // Without a host the first song's end, 25 seconds in, moves nobody's session on.
      const ahead = fc
        .array(nearTheEnd, { minLength: 1, maxLength: 10 })
        .map((script): ReadonlyArray<Step> => WAIT_PAST_THE_END.concat(script));

      await fc.assert(
        fc.asyncProperty(ahead, (script) => playScript(script, "late")),
        { numRuns: 30 },
      );
    },
  );

  it(
    "settle the same way when every script ends at a song's end",
    { timeout: 240_000 },
    async () => {
      const toTheEnd = fc
        .array(step, { minLength: 1, maxLength: 8 })
        .map((script): ReadonlyArray<Step> => script.concat(WAIT_A_SONG));

      await fc.assert(
        fc.asyncProperty(toTheEnd, (script) => playScript(script)),
        { numRuns: 12 },
      );
    },
  );
});

/** Something that can happen around a song's end while the core decides it (ADR 0017). */
type AtTheEnd =
  | { readonly kind: "wait"; readonly ms: number }
  | { readonly kind: "add"; readonly at: "next" | "end" }
  | { readonly kind: "remove"; readonly pick: number }
  | { readonly kind: "front"; readonly pick: number }
  | { readonly kind: "skip" }
  | { readonly kind: "leave" };

const atTheEnd: fc.Arbitrary<AtTheEnd> = fc.oneof(
  {
    weight: 6,
    arbitrary: fc.integer({ min: 5, max: 300 }).map((ms) => ({ kind: "wait", ms }) as const),
  },
  {
    weight: 3,
    arbitrary: fc
      .constantFrom("next" as const, "end" as const)
      .map((at) => ({ kind: "add", at }) as const),
  },
  { weight: 2, arbitrary: fc.nat(3).map((pick) => ({ kind: "remove", pick }) as const) },
  { weight: 2, arbitrary: fc.nat(3).map((pick) => ({ kind: "front", pick }) as const) },
  { weight: 1, arbitrary: fc.constant({ kind: "skip" } as const) },
  { weight: 1, arbitrary: fc.constant({ kind: "leave" } as const) },
);

/**
 * How the Jam stands as the script starts: how late the host's player hears the session, as a busy
 * page does, whether b is hidden from the host, as from a kid, and how many songs are queued after
 * the first.
 */
interface Setup {
  readonly hearsLateMs: number;
  readonly hidesB: boolean;
  readonly queued: number;
}

const setup: fc.Arbitrary<Setup> = fc.record({
  hearsLateMs: fc.constantFrom(0, 120, 500),
  hidesB: fc.boolean(),
  queued: fc.constantFrom(0, 0, 1, 2),
});

/** Whether `change`, by no person's move, left the song where it was, paused at its start. */
const rewound = (change: Transition): boolean =>
  change.after.entry.key === change.before.entry.key &&
  change.after.clock.status === "paused" &&
  change.after.clock.positionAtAnchorMs === 0;

/** Where the clock stood in the song `change` left, at the server time it was made. */
const leftAt = (change: Transition): number =>
  positionAt(change.before.clock, EpochMillis.make(change.serverAt));

/** What a script around the end has done so far. */
interface EndState {
  lateAdds: number;
  /** When the host left, on the server's clock, or null while they stay. */
  leftAtServer: number | null;
}

/** Runs one step `next` of a script around a song's end; Mateo skips through his own player. */
const runAtTheEnd = async (
  world: World,
  mateo: Member,
  state: EndState,
  next: AtTheEnd,
): Promise<void> => {
  const pickOf = (pick: number): string | undefined => {
    const queue = world.queue();

    return queue[pick % Math.max(1, queue.length)]?.key;
  };

  switch (next.kind) {
    case "wait": {
      await world.advance(next.ms);

      break;
    }

    case "add": {
      state.lateAdds += 1;
      world.add(song(`late${String(state.lateAdds)}`, 12), next.at);

      break;
    }

    case "remove": {
      const key = pickOf(next.pick);

      if (key !== undefined) world.remove(key);

      break;
    }

    case "front": {
      const key = pickOf(next.pick);

      if (key !== undefined) world.toFront(key);

      break;
    }

    case "skip": {
      void mateo.playback.next();

      break;
    }

    case "leave": {
      if (world.live()) {
        state.leftAtServer = world.serverNow();
        world.hostLeaves();
      }

      break;
    }
  }
};

/**
 * Plays `script` from just before the first song's end, in a Jam whose host's player says when its
 * engine finished a song and whose guest Mateo may control, then lets two more songs' ends pass.
 */
const playAtTheEnd = (script: ReadonlyArray<AtTheEnd>, host: Setup): Promise<void> =>
  scenario(song("a", 20), [song("b", 12), song("c", 12)].slice(0, host.queued), async (world) => {
    world.allowControl(true);

    const lucia = world.join("Lucía", {
      hosting: true,
      hearsLateMs: host.hearsLateMs,
      hidden: host.hidesB ? ["b"] : [],
    });

    const mateo = world.join("Mateo", { reportsLate: true });

    world.join("Aiko", {});

    await world.advance(500);
    world.move("screen", { kind: "play" });
    // The first song ends 20.5 s in; start a little before, as late as an add the host hears late.
    await world.advance(19_500);

    const at: EndState = { lateAdds: 0, leftAtServer: null };

    await script.reduce(
      (done: Promise<void>, next) => done.then(() => runAtTheEnd(world, mateo, at, next)),
      Promise.resolve(),
    );

    // Two more songs' ends pass, with the fallback's second after each.
    await world.advance(32_000);

    for (const change of world.transitions) {
      // Only the host's player, or the core at an end it took, moves the session by itself: the
      // screen's play and Mateo's skip are people's moves.
      if (change.by === "screen" || change.by === "Mateo") continue;

      // The Jam never goes back to a song's start while something is queued when that is decided.
      if (rewound(change)) expect(change.queued, "rewound with entries queued").toBe(0);

      // It never moves on, or stops, before the song's end on the clock, which every engine in step
      // reached then: so no member's song is cut short.
      expect(leftAt(change), "moved on before the end").toBeGreaterThanOrEqual(
        change.before.entry.track.durationMs,
      );
    }

    // Once the host left, nothing moved the session.
    const { leftAtServer } = at;

    if (leftAtServer !== null) {
      const after = world.transitions.filter((change) => change.serverAt > leftAtServer);

      expect(after).toEqual([]);

      return;
    }

    // No song plays on past its end with nothing moving it on: the Jam is never stuck.
    const playing = world.playing();

    if (world.clock().status === "playing") {
      expect(world.shared(), "stuck past an end").toBeLessThan(playing.track.durationMs + 2_500);
    }

    // The host's player, the one that said each end, follows the session's song unless hidden.
    if (!(host.hidesB && playing.track.id === "b")) {
      expect(lucia.engine.song).toBe(playing.track.id);
    }
  });

describe("a music session's end, decided by the core, whatever happens around it", () => {
  it(
    "never rewinds while something is queued, and never moves on before the song's end",
    { timeout: 240_000 },
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(atTheEnd, { minLength: 1, maxLength: 12 }),
          setup,
          (script, host) => playAtTheEnd(script, host),
        ),
        { numRuns: 40 },
      );
    },
  );

  it(
    "moves on to whatever is queued at the end, however late the host hears of an add or a removal",
    { timeout: 240_000 },
    async () => {
      // An add in the last second of an empty Jam, which the host's page hears late, and maybe
      // its removal right after: the window where the host's own view said nothing was queued.
      const window = fc
        .record({
          before: fc.integer({ min: 0, max: 1_000 }),
          at: fc.constantFrom("next" as const, "end" as const),
          removeAfter: fc.option(fc.integer({ min: 5, max: 400 }), { nil: null }),
          hearsLateMs: fc.constantFrom(120, 500),
        })
        .map(({ before, at, removeAfter, hearsLateMs }) => ({
          script: [
            { kind: "wait", ms: Math.max(5, before) } as const,
            { kind: "add", at } as const,
            ...(removeAfter === null
              ? []
              : [{ kind: "wait", ms: removeAfter } as const, { kind: "remove", pick: 0 } as const]),
          ],
          host: { hearsLateMs, hidesB: false, queued: 0 },
        }));

      await fc.assert(
        fc.asyncProperty(window, ({ script, host }) => playAtTheEnd(script, host)),
        { numRuns: 30 },
      );
    },
  );
});
