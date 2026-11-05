import { describe, expect, it } from "vitest";

import type { Id, TableNames } from "../../../convex/_generated/dataModel";
import {
  appliedAfter,
  changed,
  nextRevision,
  playbackOf,
  positionAt,
} from "../../../convex/core/connect/playback";
import type { Player, Request } from "../../../convex/core/connect/playback";

// SAFETY: a type predicate, not checked by the compiler. A Convex id is an opaque string; these
// functions only compare ids for equality and never send one to a backend.
const isIdOf = <Table extends TableNames>(table: Table, value: string): value is Id<Table> =>
  value.startsWith(`${table}:`);

const idOf = <Table extends TableNames>(table: Table, name: string): Id<Table> => {
  const value = `${table}:${name}`;

  if (!isIdOf(table, value)) throw new Error(`${value} is not a ${table} id`);

  return value;
};

const TV = idOf("devices", "tv");

const LUCIA = idOf("authSessions", "lucia-tile");

const AIKO = idOf("authSessions", "aiko-tile");

const player = (fields: Partial<Omit<Player, "_id" | "_creationTime">> = {}): Player => ({
  _id: idOf("connectPlayers", "tv"),
  _creationTime: 0,
  deviceId: TV,
  reporter: LUCIA,
  output: { kind: "local" },
  playback: { domain: "movies", playing: true, positionMs: 60_000 },
  applied: 0,
  reportedAt: 1_000,
  ...fields,
});

const request = (fields: Partial<Omit<Request, "_id" | "_creationTime">> = {}): Request => ({
  _id: idOf("connectRequests", "tv"),
  _creationTime: 0,
  deviceId: TV,
  reporter: LUCIA,
  revision: 1,
  playing: false,
  positionMs: 61_000,
  at: 2_000,
  ...fields,
});

describe("what a device plays, as controllers see it", () => {
  it("is the report, held at the time it arrived, while no request waits", () => {
    expect(playbackOf(player(), null)).toEqual({
      domain: "movies",
      playing: true,
      positionMs: 60_000,
      at: 1_000,
      pending: false,
    });
  });

  it("is the request at once, before the device applies it", () => {
    expect(playbackOf(player(), request())).toEqual({
      domain: "movies",
      playing: false,
      positionMs: 61_000,
      at: 2_000,
      pending: true,
    });
  });

  it("is the report again once the device says it applied the request", () => {
    const paused = player({
      applied: 1,
      playback: { domain: "movies", playing: false, positionMs: 61_020 },
      reportedAt: 2_040,
    });

    expect(playbackOf(paused, request())).toMatchObject({ playing: false, pending: false });
  });

  it("keeps the request when a late report still names an older revision", () => {
    expect(playbackOf(player({ reportedAt: 2_100 }), request())).toMatchObject({
      playing: false,
      pending: true,
    });
  });

  it("drops a request made for the playback of a session that no longer reports", () => {
    expect(playbackOf(player({ reporter: AIKO }), request())).toMatchObject({
      playing: true,
      pending: false,
    });
  });

  it("is nothing while the device plays nothing", () => {
    expect(playbackOf(player({ playback: null }), request())).toBeNull();
  });
});

describe("a position in server time", () => {
  it("moves on while playing and holds while paused", () => {
    expect(positionAt({ playing: true, positionMs: 60_000, at: 1_000 }, 1_250)).toBe(60_250);
    expect(positionAt({ playing: false, positionMs: 60_000, at: 1_000 }, 9_000)).toBe(60_000);
  });

  it("never runs backwards when a clock reads earlier than the anchor", () => {
    expect(positionAt({ playing: true, positionMs: 60_000, at: 1_000 }, 900)).toBe(60_000);
  });
});

describe("a change a controller asks for", () => {
  const playing = { playing: true, positionMs: 60_000, at: 1_000 };

  it("pauses where playback is at that moment", () => {
    expect(changed(playing, { playing: false }, 1_500)).toEqual({
      playing: false,
      positionMs: 60_500,
      at: 1_500,
    });
  });

  it("seeks and keeps playing", () => {
    expect(changed(playing, { positionMs: 5_000 }, 1_500)).toEqual({
      playing: true,
      positionMs: 5_000,
      at: 1_500,
    });
  });

  it("resumes from where a pause held", () => {
    const paused = { playing: false, positionMs: 60_500, at: 1_500 };

    expect(changed(paused, { playing: true }, 9_000)).toEqual({
      playing: true,
      positionMs: 60_500,
      at: 9_000,
    });
  });

  it("asks the same thing twice with the same outcome", () => {
    const once = changed(playing, { playing: false }, 1_500);

    expect(changed(once, { playing: false }, 1_700)).toEqual({ ...once, at: 1_700 });
  });
});

describe("revisions", () => {
  it("number each request above the last one", () => {
    expect(nextRevision(null)).toBe(1);
    expect(nextRevision(request({ revision: 3 }))).toBe(4);
  });

  it("never go down for one reporter, so a restarted app does not apply a request again", () => {
    expect(appliedAfter(player({ applied: 5 }), LUCIA, 0)).toBe(5);
    expect(appliedAfter(player({ applied: 5 }), LUCIA, 6)).toBe(6);
  });

  it("start from a new reporter's own count", () => {
    expect(appliedAfter(player({ applied: 5 }), AIKO, 0)).toBe(0);
    expect(appliedAfter(null, AIKO, 2)).toBe(2);
  });
});
