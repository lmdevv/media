import { DeviceId, QueueItemId, TrackId } from "@music/commands/ids";
import type { PlaybackState, RepeatMode } from "@music/commands/models";
import { isNewPlay } from "@music/commands/queue-rules";
import type { CommandArgs } from "@music/commands/registry";
import type { SessionMutation } from "@music/commands/session-commands";
import { Result, Schema } from "effect";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import { planEngine, sessionView } from "./engine-plan";
import {
  LocalRefusal,
  LocalSessionState,
  localView,
  offlineResume,
  seedLocal,
  stepLocal,
} from "./local-session";
import type { LocalContext } from "./local-session";
import { holding, phone, sessionOf, songIds } from "./testing/offline-session";
import type { SongId } from "./testing/offline-session";

const contextOf = (downloaded: Iterable<string>, now = 50_000): LocalContext => ({
  now,
  device: phone,
  playable: holding(downloaded),
  random: () => 0.5,
});

const server = (queue: ReadonlyArray<SongId>, overrides: Partial<PlaybackState> = {}) =>
  sessionOf(queue, { updatedAt: 40_000, ...overrides });

const run = <Name extends SessionMutation>(
  name: Name,
  state: LocalSessionState,
  args: CommandArgs<Name>,
  context: LocalContext,
): LocalSessionState => Result.getOrThrow(stepLocal(name, state, args, context)).state;

const songArb = fc.constantFrom(...songIds);

const session = fc
  .record({
    queue: fc.array(songArb, { minLength: 1, maxLength: 10 }),
    downloaded: fc.subarray([...songIds]),
    repeat: fc.constantFrom<RepeatMode>("off", "all", "one"),
    positionMs: fc.nat({ max: 20_000 }),
    playing: fc.boolean(),
    elapsed: fc.nat({ max: 10_000 }),
  })
  .chain(({ queue, downloaded, repeat, positionMs, playing, elapsed }) =>
    fc.nat({ max: queue.length - 1 }).map((index) => ({
      queue,
      downloaded,
      repeat,
      positionMs,
      playing,
      elapsed,
      index,
      state: seedLocal(server(queue, { index, repeat, positionMs, playing }), phone.id),
      context: contextOf(new Set(downloaded), 40_000 + elapsed),
    })),
  );

describe("next and previous on this device", () => {
  it("next lands on the first following song this device holds, and stops when none is left", () => {
    fc.assert(
      fc.property(session, ({ queue, downloaded, repeat, index, state, context }) => {
        const following = [
          ...queue.keys().filter((position) => position > index),
          ...(repeat === "all" ? queue.keys().filter((position) => position <= index) : []),
        ];

        const expected = following.find((position) => {
          const id = queue[position];

          return id !== undefined && downloaded.includes(id);
        });

        const after = run("playback.next", state, {}, context);

        expect(after.index).toBe(expected ?? index);
        expect(after.playing).toBe(expected === undefined ? false : state.playing);
        expect(after.positionMs).toBe(0);
      }),
    );
  });

  it("previous restarts after three seconds, else lands on the nearest earlier song held", () => {
    fc.assert(
      fc.property(session, ({ queue, downloaded, repeat, index, state, context, elapsed }) => {
        const live = state.playing ? state.positionMs + elapsed : state.positionMs;

        const earlier = [
          ...queue
            .keys()
            .filter((position) => position < index)
            .toArray()
            .toReversed(),
          ...(repeat === "all"
            ? queue
                .keys()
                .filter((position) => position > index)
                .toArray()
                .toReversed()
            : []),
        ];

        const held = earlier.find((position) => {
          const id = queue[position];

          return id !== undefined && downloaded.includes(id);
        });

        const after = run("playback.previous", state, {}, context);

        expect(after.index).toBe(live > 3000 ? index : (held ?? index));
        expect(after.positionMs).toBe(0);
      }),
    );
  });

  it("matches the server's next and previous when every song is held", () => {
    fc.assert(
      fc.property(session, ({ queue, repeat, index, state }) => {
        const context = contextOf(new Set(songIds));
        const last = queue.length - 1;
        const wraps = repeat === "all";

        expect(run("playback.next", state, {}, context).index).toBe(
          index < last ? index + 1 : wraps ? 0 : index,
        );

        const restarted = { ...state, positionMs: 0, playing: false };

        expect(run("playback.previous", restarted, {}, context).index).toBe(
          index > 0 ? index - 1 : wraps ? last : 0,
        );
      }),
    );
  });
});

const report = (
  state: LocalSessionState,
  position: number,
  positionMs: number,
  playing = true,
): CommandArgs<"playback.report"> => ({
  deviceId: phone.id,
  index: position,
  itemId: state.items[position]?.id ?? QueueItemId.make("gone"),
  positionMs,
  playing,
});

describe("plays", () => {
  it("counts a song once as it plays through, again when it starts over, never paused", () => {
    const downloaded = new Set<string>(songIds);
    let state = seedLocal(server(["a", "b"], { playing: false }), phone.id);

    state = run("playback.report", state, report(state, 0, 1000), contextOf(downloaded, 41_000));
    state = run("playback.report", state, report(state, 0, 16_000), contextOf(downloaded, 56_000));
    expect(state.plays).toEqual([]);

    state = run("playback.report", state, report(state, 1, 0), contextOf(downloaded, 60_000));
    state = run(
      "playback.report",
      state,
      report(state, 1, 5000, false),
      contextOf(downloaded, 65_000),
    );
    state = run("playback.report", state, report(state, 1, 5000), contextOf(downloaded, 70_000));
    expect(state.plays).toEqual([{ trackId: "b", playedAt: 60_000 }]);

    state = run("playback.report", state, report(state, 1, 90_000), contextOf(downloaded, 155_000));
    state = run("playback.report", state, report(state, 1, 1000), contextOf(downloaded, 160_000));

    expect(state.plays).toEqual([
      { trackId: "b", playedAt: 60_000 },
      { trackId: "b", playedAt: 160_000 },
    ]);
  });

  it("records a play exactly when the server's rule says a report starts one", () => {
    const step = fc.record({
      position: fc.nat(),
      positionMs: fc.nat({ max: 200_000 }),
      playing: fc.boolean(),
      wait: fc.nat({ max: 60_000 }),
    });

    fc.assert(
      fc.property(session, fc.array(step, { maxLength: 12 }), ({ state: start }, steps) => {
        let state = start;
        let now = 40_000;

        for (const next of steps) {
          now += next.wait;
          const position = next.position % state.items.length;
          const entry = state.items[position];
          const args = report(state, position, next.positionMs, next.playing);
          const live = state.playing ? state.positionMs + now - state.updatedAt : state.positionMs;

          const counts =
            entry !== undefined &&
            isNewPlay(
              { trackId: entry.track.id, positionMs: next.positionMs, playing: next.playing },
              { trackId: state.reportedTrackId, livePositionMs: live },
              entry.track.durationMs,
            );

          const after = run("playback.report", state, args, contextOf(new Set(songIds), now));

          expect(after.plays).toEqual(
            counts ? [...state.plays, { trackId: entry.track.id, playedAt: now }] : state.plays,
          );

          state = after;
        }
      }),
    );
  });
});

describe("taking over and handing back", () => {
  it("shows the server's session unchanged, so the engine does nothing when it takes over", () => {
    fc.assert(
      fc.property(session, ({ queue, index, repeat, positionMs, playing }) => {
        const before = server(queue, { index, repeat, positionMs, playing });
        const after = localView(seedLocal(before, phone.id), phone);
        const loaded = { trackId: before.queue[index]?.id ?? null, positionMs, reportedMs: null };

        expect(
          planEngine(sessionView(before, phone.id), sessionView(after, phone.id), loaded, 45_000),
        ).toEqual([]);
        expect(after.queue).toEqual(before.queue);
      }),
    );
  });

  it("starts paused when another device or none played the session", () => {
    const state = seedLocal(server(["a", "b"], { activeDevice: null, playing: true }), phone.id);

    expect(state.playing).toBe(false);
  });

  it("hands back the queue in play order, where it stands, and its settings", () => {
    const skipped = run(
      "playback.next",
      seedLocal(server(["a", "b", "c"], { shuffle: true, repeat: "all" }), phone.id),
      {},
      contextOf(new Set(["a", "c"]), 50_000),
    );

    const state = run("playback.volume", skipped, { volume: 0.4 }, contextOf(["a", "c"], 50_000));

    expect(offlineResume(state, 52_000)).toEqual({
      items: [
        { trackId: "a", itemId: "1" },
        { trackId: "b", itemId: "2" },
        { trackId: "c", itemId: "3" },
      ],
      index: 2,
      positionMs: 2000,
      playing: true,
      shuffle: true,
      repeat: "all",
      volume: 0.4,
      autoplay: true,
    });
  });

  it("hands back only plays until a command runs here, and an emptied queue as empty", () => {
    const seeded = seedLocal(server(["a"]), phone.id);

    const emptied = run(
      "queue.remove",
      seeded,
      { itemId: QueueItemId.make("1") },
      contextOf(["a"]),
    );

    expect(offlineResume(seeded, 52_000)).toBeNull();
    expect(offlineResume(emptied, 52_000)).toMatchObject({ items: [], playing: false });
  });

  it("numbers new entries past the ones made here before the session last went back", () => {
    const before = run(
      "queue.add",
      seedLocal(server(["a"]), phone.id),
      { trackIds: [TrackId.make("b"), TrackId.make("c")] },
      contextOf(songIds),
    );

    const again = seedLocal(localView(before, phone), phone.id);
    const after = run("queue.add", again, { trackIds: [TrackId.make("d")] }, contextOf(songIds));

    expect(after.items.map((entry) => entry.id)).toEqual(["1", "local-1", "local-2", "local-3"]);
  });

  it("ignores a report of the entry before a skip, sent before the player saw the skip", () => {
    const skipped = run(
      "playback.next",
      seedLocal(server(["a", "b"]), phone.id),
      {},
      contextOf(songIds),
    );

    const early = run(
      "playback.report",
      skipped,
      report(skipped, 0, 9000),
      contextOf(songIds, 52_000),
    );

    const late = run(
      "playback.report",
      skipped,
      report(skipped, 0, 9000),
      contextOf(songIds, 53_001),
    );

    expect(early.index).toBe(1);
    expect(late.index).toBe(0);
  });
});

describe("what needs the server", () => {
  const state = seedLocal(server(["a", "b"]), phone.id);
  const context = contextOf(new Set(["a"]));

  it("refuses to play or queue songs this device doesn't hold, or to play elsewhere", () => {
    expect(stepLocal("queue.add", state, { trackIds: [TrackId.make("b")] }, context)).toStrictEqual(
      Result.fail(LocalRefusal.NotDownloaded()),
    );
    expect(
      stepLocal("playback.transfer", state, { deviceId: DeviceId.make("laptop") }, context),
    ).toStrictEqual(Result.fail(LocalRefusal.Offline()));
    expect(
      stepLocal("playback.jump", state, { itemId: QueueItemId.make("2") }, context),
    ).toStrictEqual(Result.fail(LocalRefusal.NotDownloaded()));
  });

  it("keeps only the songs it holds when playing a list, on the chosen one or the next held", () => {
    const after = run(
      "playback.play",
      state,
      { trackIds: [TrackId.make("b"), TrackId.make("a"), TrackId.make("c")], index: 0 },
      contextOf(new Set(["a", "c"])),
    );

    expect(after.items.map((entry) => entry.track.id)).toEqual(["a", "c"]);
    expect(after.index).toBe(0);
    expect(after.playing).toBe(true);
  });
});

const apply =
  <Name extends SessionMutation>(name: Name, args: CommandArgs<Name>) =>
  (state: LocalSessionState, context: LocalContext): LocalSessionState =>
    Result.match(stepLocal(name, state, args, context), {
      onSuccess: ({ state: next }) => next,
      onFailure: () => state,
    });

const command = (
  items: ReadonlyArray<QueueItemId>,
): fc.Arbitrary<(state: LocalSessionState, context: LocalContext) => LocalSessionState> => {
  const itemId = fc.constantFrom(...items, QueueItemId.make("gone"));

  const trackIds = fc.array(
    songArb.map((id) => TrackId.make(id)),
    { minLength: 1, maxLength: 4 },
  );

  return fc.oneof(
    fc
      .record({ trackIds, index: fc.nat({ max: 3 }) })
      .map(({ trackIds: ids, index }) => apply("playback.play", { trackIds: ids, index })),
    fc.constant(apply("playback.pause", {})),
    fc.constant(apply("playback.resume", {})),
    fc.constant(apply("playback.next", {})),
    fc.constant(apply("playback.previous", {})),
    fc.nat({ max: 200_000 }).map((positionMs) => apply("playback.seek", { positionMs })),
    itemId.map((id) => apply("playback.jump", { itemId: id })),
    fc.boolean().map((on) => apply("playback.shuffle", { on })),
    fc
      .constantFrom<RepeatMode>("off", "all", "one")
      .map((mode) => apply("playback.repeat", { mode })),
    fc.boolean().map((on) => apply("queue.autoplay", { on })),
    fc.record({ trackIds, next: fc.boolean() }).map((args) => apply("queue.add", args)),
    itemId.map((id) => apply("queue.remove", { itemId: id })),
    fc
      .record({ id: itemId, after: fc.option(itemId, { nil: undefined }) })
      .map(({ id, after }) =>
        apply(
          "queue.move",
          after === undefined ? { itemId: id } : { itemId: id, afterItemId: after },
        ),
      ),
    fc.constant(apply("queue.clear", {})),
  );
};

describe("any run of commands", () => {
  const decode = Schema.decodeUnknownSync(LocalSessionState);

  it("keeps entries unique, the index in the queue, new entries playable, and survives storage", () => {
    fc.assert(
      fc.property(
        session,
        fc.array(fc.nat({ max: 5000 }), { maxLength: 30 }).chain((waits) =>
          fc.tuple(
            fc.constant(waits),
            fc.array(
              command(["1", "2", "3", "local-1", "local-2"].map((id) => QueueItemId.make(id))),
              {
                minLength: waits.length,
                maxLength: waits.length,
              },
            ),
          ),
        ),
        ({ state: start, context: base }, [waits, commands]) => {
          let state = start;
          let now = base.now;

          for (const [position, step] of commands.entries()) {
            now += waits[position] ?? 0;
            state = step(state, { ...base, now });

            const ids = state.items.map((entry) => entry.id);

            expect(new Set(ids).size).toBe(ids.length);
            expect(state.index).toBeLessThanOrEqual(Math.max(0, ids.length - 1));

            if (state.unshuffled !== undefined) {
              expect(new Set(state.unshuffled)).toEqual(new Set(ids));
            }

            if (!state.shuffle) expect(state.unshuffled).toBeUndefined();

            for (const entry of state.items) {
              if (entry.id.startsWith("local-")) {
                expect(base.playable(entry.track.id)).not.toBeNull();
              }
            }
          }

          expect(decode(JSON.parse(JSON.stringify(state)))).toEqual(state);
        },
      ),
    );
  });
});
