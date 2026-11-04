import {
  DeviceId,
  EpisodeId,
  MediaFileId,
  ProfileId,
  RoomId,
  SeasonId,
  TitleId,
  UserId,
} from "@media/contracts/ids";
import type { Episode } from "@media/contracts/models/catalog";
import type { Room, RoomMember } from "@media/contracts/models/rooms";
import { Conflict, Internal, NotFound } from "@media/contracts/errors";
import { EpochMillis, Milliseconds } from "@media/contracts/units";
import { describe, expect, it } from "vitest";

import { FILE_MISSING, closedKey, roomNextCard, shouldStartCountdown } from "./room-next";
import type { RoomNextInput } from "./room-next";
import {
  guestCatchingUp,
  memberRows,
  messagesUrl,
  roomAccess,
  roomLink,
  roomNotice,
  shownLink,
  watchingLabel,
} from "./room-view";

const ALEX_DEVICE = DeviceId.make("ios-alex");

const SAM_DEVICE = DeviceId.make("web-sam");

const JORDAN_DEVICE = DeviceId.make("web-jordan");

const ALEX = ProfileId.make("p-alex");

const member = (
  deviceId: DeviceId,
  name: string,
  role: RoomMember["role"],
  joinedAt: number,
  presence: RoomMember["presence"] = "watching",
): RoomMember => ({
  userId: UserId.make(`u-${name}`),
  profileId: deviceId === ALEX_DEVICE ? ALEX : ProfileId.make(`p-${name}`),
  profileName: name,
  avatar: "red",
  deviceId,
  role,
  joinedAt: EpochMillis.make(joinedAt),
  lastSeenAt: EpochMillis.make(joinedAt),
  presence,
  driftMs: null,
});

const episode = (id: string, available = true): Episode => ({
  id: EpisodeId.make(id),
  titleId: TitleId.make("show"),
  seasonId: SeasonId.make("s1"),
  seasonNumber: 1,
  episodeNumber: 2,
  name: "Half Loop",
  overview: null,
  airDate: null,
  runtimeMs: null,
  still: null,
  rating: null,
  externalIds: { tmdb: null, imdb: null, tvdb: null },
  available,
  progress: null,
});

const room = (change: Partial<Room> = {}): Room => ({
  id: RoomId.make("r1"),
  title: {
    id: TitleId.make("dune"),
    kind: "movie",
    name: "Dune: Part Two",
    year: 2024,
    certification: null,
    ageRating: null,
    runtimeMs: null,
    genres: [],
    artwork: { poster: null, backdrop: null, logo: null },
    available: true,
    addedAt: EpochMillis.make(0),
  },
  episode: null,
  fileId: MediaFileId.make("f1"),
  hostUserId: UserId.make("u-Sam"),
  hostProfileId: ProfileId.make("p-Sam"),
  hostDeviceId: SAM_DEVICE,
  hostProfileName: "Sam",
  hostAway: false,
  clock: {
    status: "playing",
    positionAtAnchorMs: Milliseconds.make(5_598_000),
    anchorServerTime: EpochMillis.make(1_000),
    playbackRate: 1,
    revision: 3,
  },
  next: null,
  members: [
    member(JORDAN_DEVICE, "Jordan", "guest", 30),
    member(ALEX_DEVICE, "Alex", "guest", 20),
    member(SAM_DEVICE, "Sam", "host", 10),
  ],
  createdAt: EpochMillis.make(0),
  ...change,
});

const clockAt = (status: Room["clock"]["status"]): Room["clock"] => ({
  status,
  positionAtAnchorMs: Milliseconds.make(5_598_000),
  anchorServerTime: EpochMillis.make(1_000),
  playbackRate: 1,
  revision: 3,
});

describe("invite links", () => {
  it("builds the web app's room link on the media service", () => {
    expect(roomLink("http://cinema.home:8080/", RoomId.make("k7"))).toBe(
      "http://cinema.home:8080/r/k7",
    );
  });

  it("shows a link without its scheme", () => {
    expect(shownLink("https://cinema.home/r/7K4P2")).toBe("cinema.home/r/7K4P2");
    expect(shownLink("cinema.home/r/7K4P2")).toBe("cinema.home/r/7K4P2");
  });

  it("puts the link in a Messages compose URL", () => {
    expect(messagesUrl("http://a.b/r/1?x=y")).toBe("sms:&body=http%3A%2F%2Fa.b%2Fr%2F1%3Fx%3Dy");
  });

  it("counts everyone watching", () => {
    expect(watchingLabel(3)).toBe("3 Watching");
  });
});

describe("memberRows", () => {
  it("lists this device first, then the host, then guests as they joined", () => {
    const rows = memberRows(room(), ALEX_DEVICE);

    expect(rows.map((row) => [row.name, row.detail])).toStrictEqual([
      ["Alex", "You"],
      ["Sam", "Host"],
      ["Jordan", null],
    ]);
  });

  it("marks the host's own row You · Host and away members Away", () => {
    const rows = memberRows(
      room({
        hostDeviceId: ALEX_DEVICE,
        members: [
          member(ALEX_DEVICE, "Alex", "host", 10, "away"),
          member(SAM_DEVICE, "Sam", "guest", 20, "away"),
        ],
      }),
      ALEX_DEVICE,
    );

    expect(rows.map((row) => row.detail)).toStrictEqual(["You · Host", "Away"]);
  });

  it("keeps a row for a host who left, after this device", () => {
    const rows = memberRows(
      room({ members: [member(ALEX_DEVICE, "Alex", "guest", 20)] }),
      ALEX_DEVICE,
    );

    expect(rows.map((row) => [row.name, row.detail, row.avatar])).toStrictEqual([
      ["Alex", "You", "red"],
      ["Sam", "Host · Left", null],
    ]);
  });
});

describe("roomNotice", () => {
  it("tells guests the host paused or is buffering", () => {
    expect(roomNotice(room({ clock: clockAt("paused") }), "guest")).toStrictEqual({
      text: "Sam paused playback.",
      waiting: false,
    });

    expect(roomNotice(room({ clock: clockAt("buffering") }), "guest")).toStrictEqual({
      text: "Waiting for Sam…",
      waiting: true,
    });
  });

  it("tells guests the host left", () => {
    expect(roomNotice(room({ clock: clockAt("paused"), hostAway: true }), "guest")).toStrictEqual({
      text: "Sam left the room.",
      waiting: false,
    });
  });

  it("says nothing while the room plays, to the host, or once the room ended", () => {
    expect(roomNotice(room(), "guest")).toBeNull();
    expect(roomNotice(room({ clock: clockAt("paused") }), "host")).toBeNull();
    expect(roomNotice(room({ clock: clockAt("ended") }), "guest")).toBeNull();
  });
});

describe("roomAccess", () => {
  it("waits while loading and joins a room this device is not in", () => {
    expect(roomAccess({ status: "loading" }, ALEX_DEVICE, ALEX)).toStrictEqual({
      kind: "loading",
    });

    const open = room({ members: [] });

    expect(roomAccess({ status: "success", data: open }, ALEX_DEVICE, ALEX)).toStrictEqual({
      kind: "join",
      room: open,
    });
  });

  it("asks to join again when the device joined with another profile", () => {
    const data = room();

    expect(roomAccess({ status: "success", data }, ALEX_DEVICE, ProfileId.make("p-kid")).kind).toBe(
      "join",
    );
  });

  it("knows the device's role", () => {
    const data = room();

    expect(roomAccess({ status: "success", data }, ALEX_DEVICE, ALEX)).toStrictEqual({
      kind: "member",
      room: data,
      role: "guest",
    });

    const hosted = room({ hostDeviceId: ALEX_DEVICE });

    expect(roomAccess({ status: "success", data: hosted }, ALEX_DEVICE, ALEX)).toMatchObject({
      kind: "member",
      role: "host",
    });
  });

  it("tells a guest the host left, but not the host itself", () => {
    const data = room({ hostAway: true });

    expect(roomAccess({ status: "success", data }, ALEX_DEVICE, ALEX).kind).toBe("hostLeft");

    const hosted = room({ hostAway: true, hostDeviceId: ALEX_DEVICE });

    expect(roomAccess({ status: "success", data: hosted }, ALEX_DEVICE, ALEX).kind).toBe("member");
  });

  it("maps an ended room and the server's refusals", () => {
    const ended = room({ clock: clockAt("ended") });

    expect(roomAccess({ status: "success", data: ended }, ALEX_DEVICE, ALEX).kind).toBe("ended");

    expect(
      roomAccess(
        { status: "error", error: new NotFound({ message: "No such room" }) },
        ALEX_DEVICE,
        ALEX,
      ),
    ).toStrictEqual({ kind: "denied" });

    expect(
      roomAccess({ status: "error", error: new Conflict({ message: "Ended" }) }, ALEX_DEVICE, ALEX),
    ).toStrictEqual({ kind: "ended" });

    expect(
      roomAccess({ status: "error", error: new Internal({ message: "Oops" }) }, ALEX_DEVICE, ALEX)
        .kind,
    ).toBe("failed");
  });
});

describe("guestCatchingUp", () => {
  const synced = {
    offset: { offsetMs: 0, roundTripMs: 10 },
    follow: "following",
    clockStatus: "playing",
    driftMs: 40,
  } as const;

  it("catches up until the engine runs with the server clock", () => {
    expect(guestCatchingUp(null)).toBe(true);
    expect(guestCatchingUp({ ...synced, offset: null })).toBe(true);
    expect(guestCatchingUp({ ...synced, follow: "blocked" })).toBe(true);
  });

  it("catches up while a playing room's guest stalls or sits a seek away", () => {
    expect(guestCatchingUp({ ...synced, follow: "buffering" })).toBe(true);
    expect(guestCatchingUp({ ...synced, driftMs: null })).toBe(true);
    expect(guestCatchingUp({ ...synced, driftMs: -2_000 })).toBe(true);
    expect(guestCatchingUp(synced)).toBe(false);
  });

  it("is in step with a paused room once it has the clock", () => {
    expect(guestCatchingUp({ ...synced, clockStatus: "paused", driftMs: null })).toBe(false);
  });
});

describe("room next episode", () => {
  const next = episode("e3");

  const input: RoomNextInput = {
    role: "host",
    next: null,
    roomEpisodeId: EpisodeId.make("e2"),
    episodeId: EpisodeId.make("e2"),
    nextEpisode: next,
    credits: true,
    canCommand: true,
  };

  const pending = { status: "pending", episode: next, nextAt: EpochMillis.make(9_000) } as const;

  it("starts the countdown from the host's credits of the room's episode, once", () => {
    expect(shouldStartCountdown(input)).toBe(true);
    expect(shouldStartCountdown({ ...input, role: "guest" })).toBe(false);
    expect(shouldStartCountdown({ ...input, credits: false })).toBe(false);
    expect(shouldStartCountdown({ ...input, canCommand: false })).toBe(false);
    expect(shouldStartCountdown({ ...input, next: pending })).toBe(false);
    expect(shouldStartCountdown({ ...input, nextEpisode: episode("e3", false) })).toBe(false);
    expect(shouldStartCountdown({ ...input, roomEpisodeId: EpisodeId.make("e9") })).toBe(false);
  });

  it("shows everyone the pending countdown until they close it", () => {
    expect(roomNextCard({ ...input, role: "guest", next: pending }, null, null)).toStrictEqual({
      kind: "countdown",
      episode: next,
      nextAt: 9_000,
      role: "guest",
      problem: null,
    });

    expect(roomNextCard({ ...input, next: pending }, closedKey(pending, null), null)).toBeNull();
  });

  it("tells only the host why the next episode cannot play", () => {
    const missing = { ...input, nextEpisode: episode("e3", false) };

    expect(roomNextCard(missing, null, null)).toMatchObject({
      kind: "unavailable",
      reason: FILE_MISSING,
    });

    expect(roomNextCard({ ...missing, role: "guest" }, null, null)).toBeNull();

    const problem = { from: EpisodeId.make("e2"), reason: "This room has ended" };

    expect(roomNextCard(input, null, problem)).toMatchObject({
      kind: "unavailable",
      reason: "This room has ended",
    });

    expect(roomNextCard(input, null, null)).toBeNull();
    expect(roomNextCard(missing, closedKey(null, EpisodeId.make("e2")), null)).toBeNull();
  });

  it("tells the host, on the countdown, why Play Next failed", () => {
    const problem = { from: EpisodeId.make("e2"), reason: "Can't reach the server." };

    expect(roomNextCard({ ...input, next: pending }, null, problem)).toMatchObject({
      kind: "countdown",
      problem: "Can't reach the server.",
    });

    expect(roomNextCard({ ...input, role: "guest", next: pending }, null, problem)).toMatchObject({
      problem: null,
    });

    expect(
      roomNextCard({ ...input, next: pending }, null, { ...problem, from: EpisodeId.make("e1") }),
    ).toMatchObject({ problem: null });
  });

  it("shows nothing after the host chose to watch the credits", () => {
    expect(roomNextCard({ ...input, next: { status: "cancelled" } }, null, null)).toBeNull();
  });
});
