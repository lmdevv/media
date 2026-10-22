import { PlaylistId, UserId } from "@music/commands/ids";
import type { Playlist } from "@music/commands/models";
import { describe, expect, it } from "vitest";

import {
  addTargetLine,
  ownershipLine,
  playlistLine,
  playlistMeta,
  playlistReach,
  reachLabel,
  totalLength,
} from "./playlist-format";

/** The playlist Paper draws, with the fields a test changes. */
const playlist = (
  changes: Partial<
    Pick<Playlist, "trackCount" | "access" | "owner" | "visibility" | "sharedWithPeople">
  > = {},
): Playlist => ({
  id: PlaylistId.make("p1"),
  name: "Late night",
  description: "A little room to slow down.",
  trackCount: changes.trackCount ?? 24,
  durationMs: (60 + 46) * 60_000,
  artUrls: [],
  updatedAt: 0,
  owner: changes.owner === undefined ? { id: UserId.make("u1"), name: "Luis" } : changes.owner,
  visibility: changes.visibility ?? "private",
  sharedWithPeople: changes.sharedWithPeople ?? false,
  access: changes.access ?? "owner",
});

const lateNight = playlist();

const sam = { id: UserId.make("u2"), name: "Sam" };

describe("playlistReach", () => {
  it("names the widest way in", () => {
    expect(reachLabel(playlistReach(lateNight))).toBe("Only you");
    expect(reachLabel(playlistReach(playlist({ sharedWithPeople: true })))).toBe(
      "Shared with people",
    );
    expect(
      reachLabel(playlistReach(playlist({ visibility: "shared", sharedWithPeople: true }))),
    ).toBe("Shared by link");
  });
});

describe("playlistLine", () => {
  it("tells the owner who can open it", () => {
    expect(playlistLine(lateNight)).toBe("24 songs · Only you");
    expect(playlistLine(playlist({ trackCount: 0 }))).toBe("No songs yet · Only you");
  });

  it("tells everyone else whose it is and their role", () => {
    expect(playlistLine(playlist({ trackCount: 42, access: "collaborator", owner: sam }))).toBe(
      "42 songs · Sam · Collaborator",
    );
    expect(playlistLine(playlist({ access: "viewer", owner: null }))).toBe("24 songs · Viewer");
  });
});

describe("addTargetLine", () => {
  it("adds the role only on someone else's playlist", () => {
    expect(addTargetLine({ trackCount: 0, access: "owner" })).toBe("No songs yet");
    expect(addTargetLine({ trackCount: 42, access: "collaborator" })).toBe(
      "42 songs · Collaborator",
    );
  });
});

describe("totalLength", () => {
  it("reads in hours and minutes", () => {
    expect(totalLength(106 * 60_000)).toBe("1 hr 46 min");
    expect(totalLength(120 * 60_000)).toBe("2 hr");
    expect(totalLength(46 * 60_000)).toBe("46 min");
  });

  it("never says zero minutes for a playlist with music", () => {
    expect(totalLength(20_000)).toBe("1 min");
    expect(totalLength(0)).toBe("0 min");
  });
});

describe("playlistMeta", () => {
  it("is Paper's mono line in caps", () => {
    expect(playlistMeta(24, 106 * 60_000)).toBe("24 SONGS · 1 HR 46 MIN");
    expect(playlistMeta(0, 0)).toBe("NO SONGS YET");
  });
});

describe("ownershipLine", () => {
  it("says the playlist is yours, or whose it is", () => {
    expect(ownershipLine(lateNight, "actions")).toBe("24 songs · Created by you");
    expect(ownershipLine(lateNight, "sharing")).toBe("24 songs · You own this playlist");
    expect(ownershipLine(playlist({ access: "viewer", owner: sam }), "actions")).toBe(
      "24 songs · By Sam",
    );
  });
});
