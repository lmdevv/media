import { DeviceId } from "@media/contracts/ids";
import { Room } from "@media/contracts/models/rooms";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { driftLabel, roomMembers } from "./room-members";

const HOST = DeviceId.make("host-device");

const ME = DeviceId.make("my-device");

const member = (
  deviceId: string,
  name: string,
  role: "host" | "guest",
  driftMs: number | null,
  presence: "watching" | "away" = "watching",
) => ({
  userId: `user-${name}`,
  profileId: `profile-${name}`,
  profileName: name,
  avatar: "blue",
  deviceId,
  role,
  joinedAt: role === "host" ? 1 : 2,
  lastSeenAt: 3,
  presence,
  driftMs,
});

const room = (
  members: ReadonlyArray<ReturnType<typeof member>>,
  clock: { readonly status: "playing" | "paused" | "buffering" | "ended" },
  hostAway = false,
): Room =>
  Schema.decodeSync(Room)({
    id: "room-1",
    title: {
      id: "title-1",
      kind: "movie",
      name: "Fixture",
      year: 2024,
      certification: null,
      ageRating: null,
      runtimeMs: 7_200_000,
      genres: [],
      artwork: { poster: null, backdrop: null, logo: null },
      available: true,
      addedAt: 1,
    },
    episode: null,
    fileId: "file-1",
    hostUserId: "user-Alex",
    hostProfileId: "profile-Alex",
    hostDeviceId: HOST,
    hostProfileName: "Alex",
    hostAway,
    next: null,
    clock: {
      status: clock.status,
      positionAtAnchorMs: 0,
      anchorServerTime: 1,
      playbackRate: 1,
      revision: 1,
    },
    members,
    createdAt: 1,
  });

describe("roomMembers", () => {
  it("lists the host, then this device, then guests, with drift only when it shows", () => {
    const rows = roomMembers(
      room(
        [
          member("sam-device", "Sam", "guest", -2_400),
          member(ME, "Maya", "guest", 40),
          member(HOST, "Alex", "host", null),
          member("kim-device", "Kim", "guest", 300),
        ],
        { status: "playing" },
      ),
      ME,
      false,
      40,
    );

    expect(rows.map((row) => [row.name, row.detail, row.status])).toStrictEqual([
      ["Alex", "Host", undefined],
      ["Maya", "You", undefined],
      ["Sam", undefined, { kind: "drift", label: "-2.4s" }],
      ["Kim", undefined, undefined],
    ]);
  });

  it("shows this device syncing while it catches up", () => {
    const rows = roomMembers(
      room([member(HOST, "Alex", "host", null), member(ME, "Maya", "guest", null)], {
        status: "playing",
      }),
      ME,
      true,
      null,
    );

    expect(rows[1]?.status).toStrictEqual({ kind: "syncing" });
  });

  it("marks the host buffering, or left when away or gone", () => {
    const buffering = roomMembers(
      room([member(HOST, "Alex", "host", null)], { status: "buffering" }),
      ME,
      false,
      null,
    );

    expect(buffering[0]?.status).toStrictEqual({ kind: "buffering" });

    const away = roomMembers(
      room([member(HOST, "Alex", "host", null)], { status: "paused" }, true),
      ME,
      false,
      null,
    );

    expect(away[0]?.status).toStrictEqual({ kind: "left" });

    const gone = roomMembers(
      room([member(ME, "Maya", "guest", null)], { status: "ended" }),
      ME,
      false,
      null,
    );

    expect(gone.map((row) => [row.name, row.status])).toStrictEqual([
      ["Alex", { kind: "left" }],
      ["Maya", undefined],
    ]);
  });
});

describe("members browsing elsewhere", () => {
  const browsing = room(
    [
      member(HOST, "Alex", "host", null, "away"),
      member(ME, "Maya", "guest", null),
      member("sam-device", "Sam", "guest", null, "away"),
    ],
    { status: "playing" },
  );

  it("shows them away instead of in step or drifting", () => {
    expect(roomMembers(browsing, ME, false, 20).map((row) => [row.name, row.status])).toStrictEqual(
      [
        ["Alex", { kind: "away" }],
        ["Maya", undefined],
        ["Sam", { kind: "away" }],
      ],
    );
  });

  it("never shows this device away: it is in the player", () => {
    const back = room(
      [member(HOST, "Alex", "host", null, "away"), member(ME, "Maya", "guest", null, "away")],
      { status: "playing" },
    );

    expect(roomMembers(back, ME, false, 20)[1]?.status).toBeUndefined();
    expect(roomMembers(back, HOST, false, null)[0]?.status).toBeUndefined();
  });

  it("still shows a host who stopped sending heartbeats as left", () => {
    const silent = room([member(HOST, "Alex", "host", null, "away")], { status: "paused" }, true);

    expect(roomMembers(silent, ME, false, null)[0]?.status).toStrictEqual({ kind: "left" });
  });
});

describe("driftLabel", () => {
  it("writes the sign and one decimal", () => {
    expect(driftLabel(-2_400)).toBe("-2.4s");
    expect(driftLabel(1_250)).toBe("+1.3s");
  });
});
