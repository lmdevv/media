import { AlbumId, ArtistId, QueueItemId, TrackId } from "@music/commands/ids";
import type { QueueEntry } from "@music/commands/models";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import { EngineCommand, followingIndex, planEngine } from "./engine-plan";
import type { SessionView } from "./engine-plan";

const track = (id: string, durationMs = 200_000, itemId = `item-${id}`): QueueEntry => ({
  itemId: QueueItemId.make(itemId),
  addedBy: null,
  autoplay: false,
  id: TrackId.make(id),
  title: id,
  artist: "Artist",
  artistId: ArtistId.make("artist"),
  album: "Album",
  albumId: AlbumId.make("album"),
  trackNumber: null,
  discNumber: null,
  durationMs,
  codec: "FLAC",
  lossless: true,
  bitrate: null,
  sampleRate: null,
  bitDepth: null,
  artUrl: null,
  liked: false,
});

const a = track("a");

const b = track("b");

const view = (overrides: Partial<SessionView> = {}): SessionView => ({
  active: true,
  index: 0,
  track: a,
  positionMs: 0,
  updatedAt: 1000,
  playing: true,
  volume: 1,
  ...overrides,
});

const loaded = (trackId: string, positionMs = 0, reportedMs: number | null = null) => ({
  trackId: TrackId.make(trackId),
  positionMs,
  reportedMs,
});

const unloaded = { trackId: null, positionMs: 0, reportedMs: null };

describe("planEngine", () => {
  it("loads the current entry at the live position on the first snapshot", () => {
    expect(planEngine(null, view({ positionMs: 5000, updatedAt: 1000 }), unloaded, 3000)).toEqual([
      EngineCommand.SetVolume({ volume: 1 }),
      EngineCommand.Load({ track: a, index: 0, startMs: 7000, autoplay: true }),
    ]);
  });

  it("loads paused when the session is paused", () => {
    expect(planEngine(null, view({ playing: false, positionMs: 5000 }), unloaded, 9000)).toEqual([
      EngineCommand.SetVolume({ volume: 1 }),
      EngineCommand.Load({ track: a, index: 0, startMs: 5000, autoplay: false }),
    ]);
  });

  it("resyncs when playback is handed to this device", () => {
    const before = view({ active: false });
    const after = view({ active: true, positionMs: 61_000, updatedAt: 2000 });

    expect(planEngine(before, after, unloaded, 2500)).toEqual([
      EngineCommand.SetVolume({ volume: 1 }),
      EngineCommand.Load({ track: a, index: 0, startMs: 61_500, autoplay: true }),
    ]);
  });

  it("unloads at once when another device takes over", () => {
    expect(planEngine(view(), view({ active: false }), loaded("a", 4000), 2000)).toEqual([
      EngineCommand.Unload(),
    ]);
  });

  it("unloads when the queue empties", () => {
    expect(planEngine(view(), view({ track: null }), loaded("a"), 2000)).toEqual([
      EngineCommand.Unload(),
    ]);
  });

  it("loads the new entry when the server skips", () => {
    const after = view({ index: 1, track: b, positionMs: 0, updatedAt: 5000 });

    expect(planEngine(view(), after, loaded("a", 4000), 5000)).toEqual([
      EngineCommand.SetVolume({ volume: 1 }),
      EngineCommand.Load({ track: b, index: 1, startMs: 0, autoplay: true }),
    ]);
  });

  it("keeps a gapless advance the server has not confirmed yet", () => {
    // The engine moved on to b; a heartbeat re-ran the query before the report landed.
    expect(planEngine(view(), view(), loaded("b", 300), 200_500)).toEqual([]);
  });

  it("adopts the new index without reloading when the same song moved (shuffle on)", () => {
    const before = view({ index: 4 });
    const after = view({ index: 0 });

    expect(planEngine(before, after, loaded("a", 3000), 4000)).toEqual([
      EngineCommand.AdoptIndex({ index: 0, track: a }),
    ]);
  });

  it("adopts a new entry of the same song at the same index without reloading", () => {
    const again = track("a", 200_000, "item-a-again");

    expect(planEngine(view(), view({ track: again }), loaded("a", 3000), 4000)).toEqual([
      EngineCommand.AdoptIndex({ index: 0, track: again }),
    ]);
  });

  it("seeks when the server position jumps", () => {
    const before = view({ positionMs: 10_000, updatedAt: 1000 });
    const after = view({ positionMs: 90_000, updatedAt: 3000 });

    expect(planEngine(before, after, loaded("a", 12_000), 3000)).toEqual([
      EngineCommand.Seek({ positionMs: 90_000 }),
    ]);
  });

  it("ignores its own reports that sit close to the engine position", () => {
    const before = view({ positionMs: 10_000, updatedAt: 1000 });
    const after = view({ positionMs: 25_000, updatedAt: 16_000 });

    expect(planEngine(before, after, loaded("a", 25_200), 16_100)).toEqual([]);
  });

  it("never seeks to its own report, even with a skewed clock", () => {
    // The device clock runs 5 s ahead of the server, so the echo looks 5 s off.
    const before = view({ positionMs: 10_000, updatedAt: 1000 });
    const after = view({ positionMs: 25_000, updatedAt: 16_000 });

    expect(planEngine(before, after, loaded("a", 25_000, 25_000), 21_000)).toEqual([]);
  });

  it("follows play and pause from other devices", () => {
    const paused = view({ playing: false, positionMs: 4000, updatedAt: 5000 });

    expect(planEngine(view(), paused, loaded("a", 4000), 5000)).toEqual([EngineCommand.Pause()]);
    expect(
      planEngine(paused, view({ updatedAt: 6000, positionMs: 4000 }), loaded("a", 4000), 6000),
    ).toEqual([EngineCommand.Play()]);
  });

  it("does not undo an optimistic pause when an unrelated write re-runs the query", () => {
    // The engine paused locally; the server still says playing until the mutation lands.
    expect(planEngine(view(), view(), loaded("a", 4000), 5000)).toEqual([]);
  });

  it("follows volume changes", () => {
    expect(planEngine(view(), view({ volume: 0.4 }), loaded("a"), 1000)).toEqual([
      EngineCommand.SetVolume({ volume: 0.4 }),
    ]);
  });

  const trackArbitrary = fc
    .tuple(fc.constantFrom("a", "b", "c"), fc.integer({ min: 0, max: 600_000 }))
    .map(([id, durationMs]) => track(id, durationMs));

  const sessionArbitrary: fc.Arbitrary<SessionView> = fc.record({
    active: fc.boolean(),
    index: fc.integer({ min: 0, max: 20 }),
    track: fc.option(trackArbitrary, { nil: null }),
    positionMs: fc.integer({ min: 0, max: 600_000 }),
    updatedAt: fc.integer({ min: 0, max: 1_000_000 }),
    playing: fc.boolean(),
    volume: fc.double({ min: 0, max: 1, noNaN: true }),
  });

  const localArbitrary = fc.record({
    trackId: fc.option(
      fc.constantFrom("a", "b", "c").map((id) => TrackId.make(id)),
      { nil: null },
    ),
    positionMs: fc.integer({ min: 0, max: 600_000 }),
    reportedMs: fc.option(fc.integer({ min: 0, max: 600_000 }), { nil: null }),
  });

  const nowArbitrary = fc.integer({ min: 0, max: 2_000_000 });

  it("an inactive device only ever unloads", () => {
    fc.assert(
      fc.property(
        fc.option(sessionArbitrary, { nil: null }),
        sessionArbitrary,
        localArbitrary,
        nowArbitrary,
        (previous, next, local, now) => {
          const commands = planEngine(previous, { ...next, active: false }, local, now);

          expect(commands).toEqual(local.trackId === null ? [] : [EngineCommand.Unload()]);
        },
      ),
    );
  });

  it("replaying the same snapshot is a no-op once the engine holds its track", () => {
    fc.assert(
      fc.property(
        sessionArbitrary,
        fc.integer({ min: 0, max: 600_000 }),
        nowArbitrary,
        (session, positionMs, now) => {
          if (session.track === null) return;
          const local = { trackId: session.track.id, positionMs, reportedMs: null };

          expect(planEngine(session, session, local, now)).toEqual(
            session.active ? [] : [EngineCommand.Unload()],
          );
        },
      ),
    );
  });

  it("a load always starts inside the song", () => {
    fc.assert(
      fc.property(
        fc.option(sessionArbitrary, { nil: null }),
        sessionArbitrary,
        localArbitrary,
        nowArbitrary,
        (previous, next, local, now) => {
          for (const command of planEngine(previous, next, local, now)) {
            if (EngineCommand.$is("Load")(command)) {
              expect(command.startMs).toBeGreaterThanOrEqual(0);

              if (command.track.durationMs > 0) {
                expect(command.startMs).toBeLessThanOrEqual(command.track.durationMs);
              }
            }
          }
        },
      ),
    );
  });
});

describe("followingIndex", () => {
  it("moves to the next entry, wraps with repeat all, and stops at the end otherwise", () => {
    expect(followingIndex(0, 3, "off")).toBe(1);
    expect(followingIndex(2, 3, "off")).toBeNull();
    expect(followingIndex(2, 3, "all")).toBe(0);
    expect(followingIndex(1, 3, "one")).toBeNull();
    expect(followingIndex(0, 0, "all")).toBeNull();
  });

  it("always points inside the queue", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 50 }),
        fc.integer({ min: 0, max: 50 }),
        fc.constantFrom("off" as const, "all" as const, "one" as const),
        (index, length, repeat) => {
          const following = followingIndex(index, length, repeat);

          if (following !== null) {
            expect(following).toBeGreaterThanOrEqual(0);
            expect(following).toBeLessThan(length);
          }
        },
      ),
    );
  });
});
