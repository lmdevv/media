/**
 * Jams through the real dispatcher: joining under each join policy, what people in a Jam may do
 * under every host setting, streaming only the Jam's songs, listening along, the expiry cron, and
 * guest accounts made from Jam links.
 */
import { DeviceId, UserId } from "@music/commands/ids";
import type { TrackId } from "@music/commands/ids";
import type { CommandArgs } from "@music/commands/registry";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { GUESTS_PER_HOUR, GUESTS_PER_JAM_PER_HOUR, MAX_GUESTS_PER_JAM } from "../convex/lib/jams";
import { enableAuth, passwordFlow } from "./auth";
import {
  allTracks,
  drainScheduled,
  makeBackend,
  seedLibrary,
  signUp,
  trackIds,
  upsertFiles,
} from "./backend";
import type { Backend, User } from "./backend";
import { failureCode } from "./harness";

const HOST_DEVICE = DeviceId.make("host-laptop");

const MEMBER_DEVICE = DeviceId.make("member-phone");

const START = 1_800_000_000_000;

const ok = "succeeded";

const pick = <Item>(list: ReadonlyArray<Item>, position: number): Item => {
  const item = list[position];

  if (item === undefined) throw new Error(`Nothing at ${position}`);

  return item;
};

interface Fixture {
  readonly backend: Backend;
  readonly host: User;
  readonly member: User;
  /** Songs everyone can read. */
  readonly rock: ReadonlyArray<TrackId>;
  /** Songs only the host can read. */
  readonly secret: ReadonlyArray<TrackId>;
  readonly code: string;
}

/** A host playing five shared songs and one private one, in a Jam a member joined. */
const setup = async (settings: CommandArgs<"jam.settings"> = {}, join = true): Promise<Fixture> => {
  const backend = makeBackend();
  const host = await signUp(backend, "owner");
  const member = await signUp(backend, "member");
  await seedLibrary(backend, host, { name: "Rock", count: 5 });
  await seedLibrary(backend, host, { name: "Secret", count: 2, visibility: "private" });
  const tracks = await allTracks(host);
  const rock = trackIds(tracks, "Rock");
  const secret = trackIds(tracks, "Secret");

  await host.music.run("devices.heartbeat", { deviceId: HOST_DEVICE, name: "Laptop", kind: "web" });
  await member.music.run("devices.heartbeat", {
    deviceId: MEMBER_DEVICE,
    name: "Phone",
    kind: "phone",
  });
  await host.music.run("queue.autoplay", { on: false });
  await host.music.run("playback.play", {
    trackIds: [...rock.slice(0, 3), pick(secret, 0)],
    deviceId: HOST_DEVICE,
  });

  const { code } = await host.music.run("jam.start", {});

  await host.music.run("jam.settings", settings);

  if (join) await member.music.run("jam.join", { code });

  return { backend, host, member, rock, secret, code };
};

const queueTitles = async (user: User) =>
  (await user.music.read("queue.list", {})).queue.map((entry) => entry.title);

const entryIds = async (user: User) =>
  (await user.music.read("queue.list", {})).queue.map((entry) => entry.itemId);

beforeAll(enableAuth);

/** Puts the test clock at `time`; `drainScheduled` hands the clock back to real time. */
const clockAt = (time: number): void => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(time);
};

beforeEach(() => {
  clockAt(START);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("joining", () => {
  it("lets anyone with an open link in, sharing the host's queue and keeping their own", async () => {
    const backend = makeBackend();
    const host = await signUp(backend, "owner");
    const member = await signUp(backend, "member");
    await seedLibrary(backend, host, { name: "Rock", count: 3 });
    const rock = trackIds(await allTracks(host), "Rock");
    await member.music.run("devices.heartbeat", {
      deviceId: MEMBER_DEVICE,
      name: "Phone",
      kind: "phone",
    });

    // The member had their own queue going before.
    await member.music.run("playback.play", { trackIds: [pick(rock, 2)], deviceId: MEMBER_DEVICE });
    const own = await queueTitles(member);

    await host.music.run("queue.add", { trackIds: rock.slice(0, 2) });
    const { code } = await host.music.run("jam.start", {});

    // A whole link works as well as the bare code.
    expect(
      await member.music.run("jam.join", { code: `https://music.example.com/jam/${code}?x=1` }),
    ).toMatchObject({ status: "joined" });
    expect(await queueTitles(member)).toEqual(await queueTitles(host));

    const jam = await member.music.read("jam.get", {});

    expect([jam?.role, jam?.host.id, jam?.members.map((person) => person.person.id)]).toEqual([
      "member",
      host.id,
      [member.id],
    ]);

    await member.music.run("jam.leave", {});
    expect(await queueTitles(member)).toEqual(own);
    expect(await member.music.read("jam.get", {})).toBeNull();
  });

  it("holds people for approval, and turning them away keeps this link from asking again", async () => {
    const { backend, host, member, code } = await setup({ join: "approval" });
    const other = await signUp(backend, "member");

    expect((await member.music.read("jam.get", {}))?.role).toBe("pending");
    // While waiting, they still play their own queue.
    expect(await queueTitles(member)).toEqual([]);
    expect((await host.music.read("jam.members", {})).map((row) => row.status)).toEqual([
      "pending",
    ]);
    // People waiting don't see the link.
    expect((await member.music.read("jam.get", {}))?.code).toBe("");

    await host.music.run("jam.approve", { userId: UserId.make(member.id), approve: true });
    expect((await member.music.read("jam.get", {}))?.role).toBe("member");

    await other.music.run("jam.join", { code });
    await host.music.run("jam.approve", { userId: UserId.make(other.id), approve: false });
    expect(await failureCode(other.music.run("jam.join", { code }))).toBe("forbidden");

    // A new link lets them ask again.
    const { code: fresh } = await host.music.run("jam.relink", {});

    expect(await other.music.run("jam.join", { code: fresh })).toMatchObject({
      status: "pending",
    });
  });

  it("lets nobody new into a locked Jam, but keeps those already in", async () => {
    const { backend, host, member, code } = await setup({ join: "locked" }, false);
    const other = await signUp(backend, "member");

    expect(await failureCode(member.music.run("jam.join", { code }))).toBe("forbidden");
    await host.music.run("jam.settings", { join: "open" });
    await member.music.run("jam.join", { code });
    await host.music.run("jam.settings", { join: "locked" });

    expect(await failureCode(other.music.run("jam.join", { code }))).toBe("forbidden");
    expect((await member.music.read("jam.get", {}))?.role).toBe("member");
  });

  it("keeps someone the host removed out with that link", async () => {
    const { host, member, code } = await setup();

    await host.music.run("jam.remove", { userId: UserId.make(member.id) });
    expect(await member.music.read("jam.get", {})).toBeNull();
    expect(await failureCode(member.music.run("jam.join", { code }))).toBe("forbidden");
  });

  it("stops the old link when the host makes a new one", async () => {
    const { backend, host, code } = await setup({}, false);
    const other = await signUp(backend, "member");
    const { code: fresh } = await host.music.run("jam.relink", {});

    expect(fresh).not.toBe(code);
    expect(await failureCode(other.music.run("jam.join", { code }))).toBe("not_found");
    expect(await failureCode(other.music.run("jam.join", { code: fresh }))).toBe(ok);
  });

  it("keeps each person in one Jam at a time", async () => {
    const { backend, host, member, code } = await setup();
    const otherHost = await signUp(backend, "member");
    const { code: other } = await otherHost.music.run("jam.start", {});

    await member.music.run("jam.join", { code: other });
    expect((await member.music.read("jam.get", {}))?.host.id).toBe(otherHost.id);
    expect(await host.music.read("jam.members", {})).toEqual([]);

    // A host must end their own Jam before joining another.
    expect(await failureCode(otherHost.music.run("jam.join", { code }))).toBe("conflict");
    expect(await failureCode(host.music.run("jam.join", { code }))).toBe("conflict");
  });

  it("finds the Jam someone rejoined, after leaving it for another and coming back", async () => {
    const { backend, host, member, code } = await setup();
    const otherHost = await signUp(backend, "member");
    const { code: other } = await otherHost.music.run("jam.start", {});

    // All in one go, as fast as one mutation's clock: B, then A, then B again.
    await member.music.run("jam.join", { code: other });
    await member.music.run("jam.join", { code });

    expect((await member.music.read("jam.get", {}))?.host.id).toBe(host.id);
    expect(await queueTitles(member)).toEqual(await queueTitles(host));
  });

  it("lets someone the host approves listen along on the device they asked from", async () => {
    const { host, member, code } = await setup({ join: "approval" }, false);

    await member.music.run("jam.join", { code, deviceId: MEMBER_DEVICE });
    await host.music.run("jam.approve", { userId: UserId.make(member.id), approve: true });

    const position = await member.music.read("playback.position", {});

    expect([position.following, position.activeDevice?.id]).toEqual([true, MEMBER_DEVICE]);
  });

  it("refuses host-only actions to people in the Jam", async () => {
    const { member } = await setup();
    const target = { userId: UserId.make(member.id) };

    expect(await failureCode(member.music.run("jam.end", {}))).toBe("forbidden");
    expect(await failureCode(member.music.run("jam.relink", {}))).toBe("forbidden");
    expect(await failureCode(member.music.run("jam.settings", { join: "locked" }))).toBe(
      "forbidden",
    );
    expect(await failureCode(member.music.run("jam.remove", target))).toBe("forbidden");
    expect(await failureCode(member.music.run("jam.approve", { ...target, approve: true }))).toBe(
      "forbidden",
    );
  });
});

describe("controlling playback", () => {
  it("leaves play, pause, skip, and seek to the host by default", async () => {
    const { host, member } = await setup();

    const outcomes = await Promise.all([
      failureCode(member.music.run("playback.pause", {})),
      failureCode(member.music.run("playback.next", {})),
      failureCode(member.music.run("playback.seek", { positionMs: 1000 })),
      failureCode(member.music.run("playback.shuffle", { on: true })),
    ]);

    expect(outcomes).toEqual(["forbidden", "forbidden", "forbidden", "forbidden"]);

    expect((await host.music.read("playback.state", {})).playing).toBe(true);
  });

  it("lets people steer the host's playback when the host allows it", async () => {
    const { host, member } = await setup({ membersCanControl: true });

    await member.music.run("playback.next", {});
    await member.music.run("playback.pause", {});
    const state = await host.music.read("playback.state", {});

    expect([state.index, state.playing]).toEqual([1, false]);
  });

  it("never lets people replace the Jam's queue, clear it, or change autoplay", async () => {
    const { member, rock } = await setup({ membersCanControl: true, membersCanEdit: "any" });

    expect(
      await failureCode(
        member.music.run("playback.play", { trackIds: [pick(rock, 4)], deviceId: MEMBER_DEVICE }),
      ),
    ).toBe("forbidden");
    expect(await failureCode(member.music.run("queue.clear", {}))).toBe("forbidden");
    expect(await failureCode(member.music.run("queue.autoplay", { on: true }))).toBe("forbidden");
  });
});

describe("adding songs", () => {
  it("records who added each song, and caps each person's upcoming songs", async () => {
    const { host, member, rock } = await setup({ addLimit: 2 });

    await member.music.run("queue.add", { trackIds: [pick(rock, 3), pick(rock, 4)] });
    const added = (await host.music.read("queue.list", {})).queue.slice(-2);

    expect(added.map((entry) => entry.addedBy?.id)).toEqual([member.id, member.id]);
    expect(await failureCode(member.music.run("queue.add", { trackIds: [pick(rock, 0)] }))).toBe(
      "conflict",
    );
    // The host is never limited.
    expect(await failureCode(host.music.run("queue.add", { trackIds: [pick(rock, 0)] }))).toBe(ok);

    // Once one of theirs has played, there is room again.
    await host.music.run("playback.jump", { itemId: pick(await entryIds(host), 4) });
    expect(await failureCode(member.music.run("queue.add", { trackIds: [pick(rock, 1)] }))).toBe(
      ok,
    );
  });

  it("counts a played song moved back up as an add", async () => {
    const { host, member, rock } = await setup({ addLimit: 2 });

    await member.music.run("queue.add", { trackIds: [pick(rock, 3), pick(rock, 4)] });
    // Both of theirs reach the front: one played, one playing.
    await host.music.run("playback.jump", { itemId: pick(await entryIds(host), 5) });
    await member.music.run("queue.add", { trackIds: [pick(rock, 0), pick(rock, 1)] });

    const ids = await entryIds(member);
    const played = pick(ids, 4);
    const playing = pick(ids, 5);

    expect(
      await failureCode(member.music.run("queue.move", { itemId: played, afterItemId: playing })),
    ).toBe("conflict");
    // Moving it among the played songs adds nothing.
    expect(await failureCode(member.music.run("queue.move", { itemId: played }))).toBe(ok);
  });

  it("lifts the cap at 0 and stops adding when the host turns it off", async () => {
    const { host, member, rock } = await setup({ addLimit: 0 });

    expect(await failureCode(member.music.run("queue.add", { trackIds: [...rock] }))).toBe(ok);
    await host.music.run("jam.settings", { membersCanAdd: false });
    expect(await failureCode(member.music.run("queue.add", { trackIds: [pick(rock, 0)] }))).toBe(
      "forbidden",
    );
  });

  it("only takes songs the host can play too", async () => {
    // Here the owner joins a member's Jam, with a private library the member host can't hear.
    const backend = makeBackend();
    const owner = await signUp(backend, "owner");
    const host = await signUp(backend, "member");
    await seedLibrary(backend, owner, { name: "Rock", count: 2 });
    await seedLibrary(backend, owner, { name: "Vault", count: 1, visibility: "private" });
    const tracks = await allTracks(owner);
    const vault = pick(trackIds(tracks, "Vault"), 0);

    await host.music.run("devices.heartbeat", {
      deviceId: HOST_DEVICE,
      name: "Laptop",
      kind: "web",
    });
    await host.music.run("playback.play", {
      trackIds: trackIds(tracks, "Rock"),
      deviceId: HOST_DEVICE,
    });
    const { code } = await host.music.run("jam.start", {});

    await owner.music.run("jam.join", { code });
    expect(await failureCode(owner.music.run("queue.add", { trackIds: [vault] }))).toBe(
      "forbidden",
    );
    expect(await queueTitles(host)).toEqual(["Rock 0001", "Rock 0002"]);
  });

  it("only takes songs the person adding can read", async () => {
    const { member, secret } = await setup();

    expect(await failureCode(member.music.run("queue.add", { trackIds: [pick(secret, 1)] }))).toBe(
      "not_found",
    );
  });
});

/** A Jam where the host queued the first entries and the member added the last one. */
const mixed = async (scope: "none" | "own" | "any") => {
  const fixture = await setup({ membersCanEdit: scope });
  const { member, rock } = fixture;
  const { itemIds } = await member.music.run("queue.add", { trackIds: [pick(rock, 4)] });
  const ids = await entryIds(fixture.host);

  return { ...fixture, mine: pick(itemIds, 0), hosts: pick(ids, 2) };
};

describe("reordering and removing", () => {
  it("lets people touch nothing when the host says so", async () => {
    const { member, mine, hosts } = await mixed("none");

    expect(await failureCode(member.music.run("queue.move", { itemId: mine }))).toBe("forbidden");
    expect(await failureCode(member.music.run("queue.remove", { itemId: hosts }))).toBe(
      "forbidden",
    );
  });

  it("lets people move and remove only their own songs by default", async () => {
    const { member, mine, hosts } = await mixed("own");

    expect(await failureCode(member.music.run("queue.move", { itemId: hosts }))).toBe("forbidden");
    expect(await failureCode(member.music.run("queue.remove", { itemId: hosts }))).toBe(
      "forbidden",
    );
    expect(
      await failureCode(member.music.run("queue.move", { itemId: mine, afterItemId: hosts })),
    ).toBe(ok);
    expect(await failureCode(member.music.run("queue.remove", { itemId: mine }))).toBe(ok);
  });

  it("lets people move and remove anything when the host allows it", async () => {
    const { member, hosts } = await mixed("any");

    expect(await failureCode(member.music.run("queue.move", { itemId: hosts }))).toBe(ok);
    expect(await failureCode(member.music.run("queue.remove", { itemId: hosts }))).toBe(ok);
  });
});

describe("streaming", () => {
  it("signs URLs for the Jam's songs only, and only while the person is in it", async () => {
    const { host, member, rock, secret } = await setup();

    const url = (trackId: TrackId) =>
      failureCode(member.music.read("stream.url", { trackId, profile: "original" }));

    // In the Jam's queue but in a library the member can't read: the host chose to play it.
    expect(await url(pick(secret, 0))).toBe(ok);
    // In a library the member can't read and not in the queue.
    expect(await url(pick(secret, 1))).toBe("not_found");

    await member.music.run("jam.leave", {});
    expect(await url(pick(secret, 0))).toBe("not_found");
    // Readable songs stream as always.
    expect(await url(pick(rock, 0))).toBe(ok);

    // And not after the Jam ended.
    const { code } = await host.music.run("jam.relink", {});
    await member.music.run("jam.join", { code });
    await host.music.run("jam.end", {});
    expect(await url(pick(secret, 0))).toBe("not_found");
  });

  it("signs a song heard only through the Jam for minutes, and a readable one for hours", async () => {
    const { member, rock, secret } = await setup();

    const expiresIn = async (trackId: TrackId) =>
      (await member.music.read("stream.url", { trackId, profile: "original" })).expiresAt - START;

    expect(await expiresIn(pick(secret, 0))).toBe(5 * 60 * 1000);
    expect(await expiresIn(pick(rock, 0))).toBe(6 * 60 * 60 * 1000);
  });
});

describe("volume", () => {
  it("stays each person's own in someone else's Jam, listening along or not", async () => {
    const { host, member } = await setup();

    await member.music.run("playback.volume", { volume: 0.3 });

    expect((await member.music.read("playback.position", {})).volume).toBeCloseTo(0.3);
    expect((await host.music.read("playback.position", {})).volume).toBe(1);
  });
});

/** A song by the artist both libraries share, on an album of its own. */
const song = (path: string, title: string) => ({
  path,
  title,
  artist: "Shared Artist",
  album: title,
  genre: "Rock",
  year: 1999,
});

describe("autoplay in a Jam", () => {
  it("never picks songs from a library granted only to the host", async () => {
    const backend = makeBackend();
    const owner = await signUp(backend, "owner");
    const admin = await signUp(backend, "admin");
    const member = await signUp(backend, "member");
    const alpha = await seedLibrary(backend, owner, { name: "Alpha", count: 0 });
    const beta = await seedLibrary(backend, admin, { name: "Beta", count: 0 });

    await upsertFiles(backend, alpha.libraryId, [song("Alpha/a.flac", "Alpha song")]);
    await upsertFiles(backend, beta.libraryId, [
      song("Beta/b1.flac", "Beta song 1"),
      song("Beta/b2.flac", "Beta song 2"),
    ]);

    // The second admin keeps Beta to themselves and the owner.
    await admin.music.run("libraries.update", {
      libraryId: beta.libraryId,
      visibility: "restricted",
    });
    await admin.music.run("libraries.grant", {
      libraryId: beta.libraryId,
      userId: UserId.make(owner.id),
    });

    const tracks = await allTracks(owner);

    const idOf = (title: string) =>
      pick(
        tracks.filter((track) => track.title === title),
        0,
      ).id;

    await owner.music.run("devices.heartbeat", {
      deviceId: HOST_DEVICE,
      name: "Laptop",
      kind: "web",
    });
    await owner.music.run("playback.play", {
      trackIds: [idOf("Alpha song")],
      deviceId: HOST_DEVICE,
    });

    // Alone, the owner's autoplay may pick from Beta.
    expect(await queueTitles(owner)).toContain("Beta song 1");

    // Hosting a Jam, it may not: the songs it picked go, and no new ones come from Beta.
    const { code } = await owner.music.run("jam.start", {});

    await member.music.run("jam.join", { code });
    expect((await queueTitles(member)).some((title) => title.startsWith("Beta"))).toBe(false);

    const stream = (trackId: TrackId) =>
      failureCode(member.music.read("stream.url", { trackId, profile: "original" }));

    // An autoplay entry from Beta left from before this rule doesn't stream to the member.
    await backend.run(async (ctx) => {
      const row = await ctx.db
        .query("playbackQueues")
        .withIndex("by_user", (q) => q.eq("userId", owner.id))
        .unique();

      const trackId = ctx.db.normalizeId("tracks", idOf("Beta song 2"));

      if (row === null || trackId === null) throw new Error("No queue or song");

      await ctx.db.patch(row._id, {
        items: [...(row.items ?? []), { id: "old", trackId, autoplay: true }],
      });
    });
    expect(await stream(idOf("Beta song 2"))).toBe("not_found");

    // The host's own choice of a Beta song plays for everyone.
    await owner.music.run("queue.add", { trackIds: [idOf("Beta song 1")] });
    expect(await stream(idOf("Beta song 1"))).toBe(ok);
  });
});

describe("a Jam started on an autoplay song from a library shared with the host alone", () => {
  it("moves on to a song it may share, and shows people none of what it held", async () => {
    const backend = makeBackend();
    const owner = await signUp(backend, "owner");
    // The host owns nothing; Delta is granted to them alone.
    const host = await signUp(backend, "member");
    const member = await signUp(backend, "member");
    const alpha = await seedLibrary(backend, owner, { name: "Alpha", count: 0 });
    const delta = await seedLibrary(backend, owner, { name: "Delta", count: 0 });

    // The seed shares its artist with Delta's songs only, so autoplay picks those first; Alpha's
    // other songs share its genre, for after.
    await upsertFiles(backend, alpha.libraryId, [
      song("Alpha/0.flac", "Alpha song 0"),
      ...Array.from({ length: 12 }, (_, index) => ({
        ...song(`Alpha/${String(index + 1)}.flac`, `Alpha song ${String(index + 1)}`),
        artist: "Alpha Artist",
      })),
    ]);
    await upsertFiles(backend, delta.libraryId, [
      song("Delta/1.flac", "Delta song 1"),
      song("Delta/2.flac", "Delta song 2"),
    ]);
    await owner.music.run("libraries.update", {
      libraryId: delta.libraryId,
      visibility: "restricted",
    });
    await owner.music.run("libraries.grant", {
      libraryId: delta.libraryId,
      userId: UserId.make(host.id),
    });

    const tracks = await allTracks(host);

    const idOf = (title: string) =>
      pick(
        tracks.filter((track) => track.title === title),
        0,
      ).id;

    await host.music.run("devices.heartbeat", {
      deviceId: HOST_DEVICE,
      name: "Laptop",
      kind: "web",
    });
    await host.music.run("playback.play", {
      trackIds: [idOf("Alpha song 0")],
      deviceId: HOST_DEVICE,
    });

    // Autoplay queued Delta songs, and the host skips to one.
    const queued = (await host.music.read("queue.list", {})).queue;
    const deltaEntry = queued.find((entry) => entry.autoplay && entry.title.startsWith("Delta"));

    if (deltaEntry === undefined) throw new Error("Autoplay picked nothing from Delta");
    await host.music.run("playback.jump", { itemId: deltaEntry.itemId });

    const { code } = await host.music.run("jam.start", {});

    await member.music.run("jam.join", { code, deviceId: MEMBER_DEVICE });

    const seen = await member.music.read("playback.state", {});
    const current = seen.queue[seen.index];

    // The Jam plays a song it may share.
    expect(current?.withheld).toBeUndefined();
    expect(current?.title.startsWith("Alpha")).toBe(true);
    expect(seen.playing).toBe(true);

    // The Delta entry it moved past shows as withheld: nothing about the song, not even its IDs.
    const hidden = seen.queue.find((entry) => entry.itemId === deltaEntry.itemId);

    expect(hidden).toMatchObject({
      withheld: true,
      title: "",
      artist: "",
      album: "",
      artUrl: null,
    });
    expect(hidden?.id).not.toBe(deltaEntry.id);
    expect(hidden?.albumId).not.toBe(deltaEntry.albumId);
    expect(seen.queue.some((entry) => entry.title.startsWith("Delta"))).toBe(false);

    // The host still sees their own queue whole.
    expect((await host.music.read("queue.list", {})).queue.map((entry) => entry.title)).toContain(
      deltaEntry.title,
    );
  });
});

describe("listening along", () => {
  it("plays the Jam on the person's own device, with their own volume, until they stop", async () => {
    const { host, member, code } = await setup({}, false);

    await member.music.run("playback.volume", { volume: 0.3 });
    await member.music.run("jam.join", { code, deviceId: MEMBER_DEVICE });

    const position = await member.music.read("playback.position", {});

    expect([position.following, position.activeDevice?.id, position.volume]).toEqual([
      true,
      MEMBER_DEVICE,
      0.3,
    ]);

    // The member's player never moves the host's playback by reporting.
    await member.music.run("playback.report", {
      deviceId: MEMBER_DEVICE,
      index: 2,
      positionMs: 50_000,
      playing: false,
    });
    expect((await host.music.read("playback.state", {})).playing).toBe(true);

    await member.music.run("jam.listen", { on: false });
    const remote = await member.music.read("playback.position", {});

    expect([remote.following, remote.activeDevice?.id]).toEqual([false, HOST_DEVICE]);
  });

  it("follows on a device only once that device has registered", async () => {
    const { member, code } = await setup({}, false);
    const fresh = DeviceId.make("first-visit-browser");

    await member.music.run("jam.join", { code, deviceId: fresh });
    expect((await member.music.read("playback.position", {})).following).toBe(false);

    await member.music.run("devices.heartbeat", { deviceId: fresh, name: "Browser", kind: "web" });
    const position = await member.music.read("playback.position", {});

    expect([position.following, position.activeDevice?.id]).toEqual([true, fresh]);
  });

  it("stops everyone listening along when the host turns it off", async () => {
    const { host, member, code } = await setup({}, false);

    await member.music.run("jam.join", { code, deviceId: MEMBER_DEVICE });
    await host.music.run("jam.settings", { listenAlong: false });

    expect((await member.music.read("playback.position", {})).following).toBe(false);
    expect(
      await failureCode(member.music.run("jam.listen", { on: true, deviceId: MEMBER_DEVICE })),
    ).toBe("forbidden");
  });
});

/** Runs the expiry cron and reads why the fixture's Jam ended, if it did. */
const expire = async (fixture: Fixture) => {
  await fixture.backend.mutation(internal.maintenance.expireJams, {});

  return (await fixture.member.music.read("jam.get", {}))?.endedReason ?? null;
};

describe("ending", () => {
  it("shows people that the Jam ended and gives them their own player back", async () => {
    const { host, member } = await setup();

    await host.music.run("jam.end", {});
    const ended = await member.music.read("jam.get", {});

    expect([ended?.status, ended?.endedReason]).toEqual(["ended", "host"]);
    expect(await queueTitles(member)).toEqual([]);

    await member.music.run("jam.leave", {});
    expect(await member.music.read("jam.get", {})).toBeNull();
    expect(await host.music.read("jam.get", {})).toBeNull();
  });

  it("ends a Jam whose host is removed, and clears the memberships of people removed", async () => {
    const { backend, host, member } = await setup();
    const otherHost = await signUp(backend, "member");
    const { code } = await otherHost.music.run("jam.start", {});

    await host.music.run("jam.end", {});
    await host.music.run("jam.join", { code });
    await host.music.run("people.remove", { userId: UserId.make(otherHost.id) });
    await host.music.run("people.remove", { userId: UserId.make(member.id) });
    await drainScheduled(backend);

    expect((await host.music.read("jam.get", {}))?.endedReason).toBe("host");

    const left = await backend.run(async (ctx) =>
      (await ctx.db.query("jamMembers").collect()).map((row) => row.userId),
    );

    expect(left).toEqual([host.id]);
  });

  it("ends Jams whose host went offline for 30 minutes or that sat idle for 4 hours", async () => {
    const offline = await setup();
    const idle = await setup();
    const lively = await setup();

    // 31 minutes without a heartbeat from the host.
    vi.setSystemTime(START + 31 * 60 * 1000);
    expect(await expire(offline)).toBe("host_offline");

    // The host's laptop keeps beating, but playback was paused over 4 hours ago.
    await idle.host.music.run("playback.pause", {});
    vi.setSystemTime(START + 31 * 60 * 1000 + 4 * 60 * 60 * 1000 + 60_000);
    await idle.host.music.run("devices.heartbeat", {
      deviceId: HOST_DEVICE,
      name: "Laptop",
      kind: "web",
    });
    expect(await expire(idle)).toBe("idle");

    // Playing with the host online: it goes on.
    await lively.host.music.run("devices.heartbeat", {
      deviceId: HOST_DEVICE,
      name: "Laptop",
      kind: "web",
    });
    expect(await expire(lively)).toBeNull();
  });

  it("ends a Jam whose host went offline even while its people skip songs", async () => {
    const fixture = await setup({ membersCanControl: true });

    clockAt(START + 20 * 60 * 1000);
    await fixture.member.music.run("playback.next", {});
    clockAt(START + 31 * 60 * 1000);

    expect(await expire(fixture)).toBe("host_offline");
  });

  it("keeps a Jam run from the CLI, which sends no heartbeats, while its host plays", async () => {
    const { backend, host, member, rock } = await setup();

    await backend.run(async (ctx) => {
      await Promise.all(
        (await ctx.db.query("devices").collect()).map((device) => ctx.db.delete(device._id)),
      );
    });

    // 20 minutes in, the host plays something from a terminal: still here.
    vi.setSystemTime(START + 20 * 60 * 1000);
    await host.music.run("queue.add", { trackIds: [pick(rock, 4)] });
    await host.music.run("playback.next", {});
    vi.setSystemTime(START + 40 * 60 * 1000);
    await backend.mutation(internal.maintenance.expireJams, {});
    expect((await member.music.read("jam.get", {}))?.status).toBe("active");

    // Nothing for over half an hour after that: gone.
    vi.setSystemTime(START + 51 * 60 * 1000);
    await backend.mutation(internal.maintenance.expireJams, {});
    expect((await member.music.read("jam.get", {}))?.endedReason).toBe("host_offline");
  });
});

/** Lets Jam links on the fixture's server make guest accounts. */
const guestsAllowed = async (fixture: Fixture): Promise<Fixture> => {
  await fixture.host.music.run("server.update", { jamGuestAccounts: true });

  return fixture;
};

/** Signs up from a Jam link through Convex Auth, as the landing page does, and signs in. */
const joinAsGuest = (backend: Backend, jamCode: string): Promise<User> =>
  passwordFlow(backend, {
    flow: "signUp",
    email: `guest-${Math.random().toString(36).slice(2)}@jam.local`,
    password: "a-guest-password",
    name: "Noor",
    jamCode,
  });

/** Which of these accounts still exist. */
const accountsLeft = (backend: Backend, ids: ReadonlyArray<Id<"users">>) =>
  backend.run(async (ctx) => {
    const users = await Promise.all(ids.map((id) => ctx.db.get(id)));

    return users.flatMap((user) => (user === null ? [] : [user._id]));
  });

/** The sign-in sessions these people still have. */
const sessionsOf = (backend: Backend, ids: ReadonlyArray<Id<"users">>) =>
  backend.run(async (ctx) => {
    const sessions = await Promise.all(
      ids.map((userId) =>
        ctx.db
          .query("authSessions")
          .withIndex("userId", (q) => q.eq("userId", userId))
          .collect(),
      ),
    );

    return sessions.flat().map((session) => session._id);
  });

/** How many guest accounts Jam links have made. */
const guestCount = (backend: Backend) =>
  backend.run(
    async (ctx) =>
      (await ctx.db.query("users").collect()).filter((user) => user.joinedViaJam !== undefined)
        .length,
  );

/** Signs up a guest from a Jam link, as the password provider does; resolves to the outcome. */
const createGuest = (backend: Backend, jamCode: string) =>
  failureCode(
    backend.mutation(internal.users.createFromSignUp, {
      email: `guest-${Math.random().toString(36).slice(2)}@jam.local`,
      name: "Noor",
      jamCode,
    }),
  );

describe("guest accounts from Jam links", () => {
  it("are made only while an admin allows it, for a Jam that lets people in", async () => {
    const { backend, host, code } = await setup({}, false);

    expect(await createGuest(backend, code)).toBe("signup_closed");

    await host.music.run("server.update", { jamGuestAccounts: true });
    expect(await createGuest(backend, code)).toBe(ok);

    const guests = await backend.run(async (ctx) =>
      (await ctx.db.query("users").collect()).filter((user) => user.joinedViaJam !== undefined),
    );

    expect(guests.map((user) => user.role)).toEqual(["guest"]);
    expect((await host.music.read("people.list", {})).filter((p) => p.joinedViaJam)).toHaveLength(
      1,
    );

    await host.music.run("jam.settings", { join: "locked" });
    expect(await createGuest(backend, code)).toBe("signup_closed");
    expect(await createGuest(backend, "not-a-real-code")).toBe("signup_closed");
  });

  it("land in the Jam at once when it is open, and wait for the host when it asks", async () => {
    const open = await guestsAllowed(await setup({}, false));
    const approval = await guestsAllowed(await setup({ join: "approval" }, false));

    const [inOpen, waiting] = await Promise.all([
      joinAsGuest(open.backend, open.code),
      joinAsGuest(approval.backend, approval.code),
    ]);

    expect((await inOpen.music.read("jam.get", {}))?.role).toBe("member");
    expect((await waiting.music.read("jam.get", {}))?.role).toBe("pending");
    // Nothing of the host's plays for them until they are let in.
    expect(await queueTitles(waiting)).toEqual([]);

    const queue = await approval.host.music.read("jam.members", {});

    expect(queue.map((row) => [row.person.id, row.status])).toEqual([[waiting.id, "pending"]]);
  });

  it("go when the host turns them away or removes them; a member's account stays", async () => {
    const { backend, host, member, code } = await guestsAllowed(await setup({ join: "approval" }));
    const turnedAway = await joinAsGuest(backend, code);

    await host.music.run("jam.settings", { join: "open" });
    const removed = await joinAsGuest(backend, code);

    await host.music.run("jam.approve", { userId: UserId.make(turnedAway.id), approve: false });
    await host.music.run("jam.remove", { userId: UserId.make(removed.id) });
    await host.music.run("jam.approve", { userId: UserId.make(member.id), approve: true });
    await host.music.run("jam.remove", { userId: UserId.make(member.id) });
    await drainScheduled(backend);

    expect(await accountsLeft(backend, [turnedAway.id, removed.id, member.id])).toEqual([
      member.id,
    ]);
    expect(await sessionsOf(backend, [turnedAway.id, removed.id])).toEqual([]);
    expect(await failureCode(removed.music.read("account.me", {}))).toBe("unauthenticated");
  });

  it("go when the Jam ends, unless an admin has promoted them", async () => {
    const { backend, host, code } = await guestsAllowed(await setup());

    const [kept, gone, alsoGone] = await Promise.all([
      joinAsGuest(backend, code),
      joinAsGuest(backend, code),
      joinAsGuest(backend, code),
    ]);

    await host.music.run("people.role", { userId: UserId.make(kept.id), role: "member" });
    await host.music.run("jam.end", {});
    await drainScheduled(backend);

    expect(await accountsLeft(backend, [kept.id, gone.id, alsoGone.id])).toEqual([kept.id]);
    expect(await sessionsOf(backend, [gone.id, alsoGone.id])).toEqual([]);
    expect(await failureCode(kept.music.read("account.me", {}))).toBe(ok);
  });

  it("take every session with them, from sign-up and from signing in again", async () => {
    const { backend, host, code } = await guestsAllowed(await setup());
    const account = { email: "returning@jam.local", password: "a-guest-password" };

    const fromSignUp = await passwordFlow(backend, {
      flow: "signUp",
      ...account,
      name: "Noor",
      jamCode: code,
    });

    // Signing in opens a session of the current generation, in the password check's transaction.
    const fromSignIn = await passwordFlow(backend, { flow: "signIn", ...account });

    await host.music.run("jam.end", {});
    await drainScheduled(backend);

    expect(await sessionsOf(backend, [fromSignUp.id])).toEqual([]);
    expect(await failureCode(fromSignUp.music.read("account.me", {}))).toBe("unauthenticated");
    expect(await failureCode(fromSignIn.music.read("account.me", {}))).toBe("unauthenticated");
    expect(await failureCode(passwordFlow(backend, { flow: "signIn", ...account }))).toBe(
      "unauthenticated",
    );
  });

  it("go when the cron ends their Jam", async () => {
    const fixture = await guestsAllowed(await setup());
    const guest = await joinAsGuest(fixture.backend, fixture.code);

    clockAt(START + 31 * 60 * 1000);
    expect(await expire(fixture)).toBe("host_offline");
    await drainScheduled(fixture.backend);

    expect(await accountsLeft(fixture.backend, [guest.id])).toEqual([]);
  });

  it("go, with the Jam, when its host is made a guest, and the link makes no more", async () => {
    const { backend, host, code } = await guestsAllowed(await setup({}, false));
    const otherHost = await signUp(backend, "member");
    const otherCode = (await otherHost.music.run("jam.start", {})).code;
    const guest = await joinAsGuest(backend, otherCode);

    await host.music.run("people.role", { userId: UserId.make(otherHost.id), role: "guest" });
    await drainScheduled(backend);
    clockAt(START);

    const ended = await backend.run(async (ctx) =>
      ctx.db
        .query("jams")
        .withIndex("by_code", (q) => q.eq("code", otherCode))
        .unique(),
    );

    expect([ended?.status, ended?.endedReason]).toEqual(["ended", "host"]);
    expect(await accountsLeft(backend, [guest.id])).toEqual([]);
    expect(await createGuest(backend, otherCode)).toBe("signup_closed");
    // The admin's own Jam goes on.
    expect((await host.music.read("jam.get", {}))?.code).toBe(code);
  });

  it("make no account from the link of a host who is a guest, should their Jam still run", async () => {
    const { backend, host } = await guestsAllowed(await setup({}, false));
    const otherHost = await signUp(backend, "member");
    const otherCode = (await otherHost.music.run("jam.start", {})).code;

    // Made a guest behind the handlers' back, as an old deployment could leave it.
    await backend.run(async (ctx) => {
      await ctx.db.patch(otherHost.id, { role: "guest" });
    });

    expect(await createGuest(backend, otherCode)).toBe("signup_closed");
    expect((await host.music.read("jam.get", {}))?.status).toBe("active");
  });

  it.each(["suspended", "removed"] as const)(
    "go, with the Jam, when its host is %s",
    async (change) => {
      const { backend, host, member, code } = await guestsAllowed(await setup({}, false));
      const otherHost = await signUp(backend, "member");
      const otherCode = (await otherHost.music.run("jam.start", {})).code;
      const guest = await joinAsGuest(backend, otherCode);

      await member.music.run("jam.join", { code: otherCode });
      await host.music.run(change === "suspended" ? "people.suspend" : "people.remove", {
        userId: UserId.make(otherHost.id),
      });

      // At once, not when the cron next looks.
      expect((await member.music.read("jam.get", {}))?.endedReason).toBe("host");
      await drainScheduled(backend);
      expect(await accountsLeft(backend, [guest.id, member.id])).toEqual([member.id]);
      // The host's own Jam is untouched.
      expect((await host.music.read("jam.get", {}))?.code).toBe(code);
    },
  );

  it("are limited per Jam and per hour", async () => {
    const { backend, code } = await guestsAllowed(await setup());

    const guests = (count: number) =>
      Promise.all(Array.from({ length: count }, () => createGuest(backend, code)));

    expect(await guests(GUESTS_PER_JAM_PER_HOUR)).toEqual(
      Array.from({ length: GUESTS_PER_JAM_PER_HOUR }, () => ok),
    );
    expect(await createGuest(backend, code)).toBe("rate_limited");

    // The allowance comes back over the hour, up to the Jam's cap.
    clockAt(START + 60 * 60 * 1000);
    expect(await guests(GUESTS_PER_JAM_PER_HOUR)).toContain(ok);
    clockAt(START + 3 * 60 * 60 * 1000);
    await guests(GUESTS_PER_JAM_PER_HOUR);

    expect(await guestCount(backend)).toBe(MAX_GUESTS_PER_JAM);
    expect(await createGuest(backend, code)).toBe("signup_closed");
  });

  it("are limited across all Jams on the server", async () => {
    const { backend, code } = await guestsAllowed(await setup());

    const others = await Promise.all(
      [1, 2, 3].map(async () => {
        const host = await signUp(backend, "member");

        return (await host.music.run("jam.start", {})).code;
      }),
    );

    const codes = [code, ...others];
    const perJam = GUESTS_PER_HOUR / GUESTS_PER_JAM_PER_HOUR;

    // Each Jam within its own limit, until the server's runs out.
    const made = await Promise.all(
      codes
        .slice(0, perJam)
        .flatMap((jamCode) =>
          Array.from({ length: GUESTS_PER_JAM_PER_HOUR }, () => createGuest(backend, jamCode)),
        ),
    );

    expect(made.every((outcome) => outcome === ok)).toBe(true);
    expect(await createGuest(backend, pick(codes, perJam))).toBe("rate_limited");
  });

  it("can't come straight back as someone new after the host removes one", async () => {
    const { backend, host, member, code } = await guestsAllowed(await setup({}, false));
    const removed = await joinAsGuest(backend, code);

    await host.music.run("jam.remove", { userId: UserId.make(removed.id) });

    // The same link now asks the host about everyone new: a new guest, and anyone else.
    const again = await joinAsGuest(backend, code);

    expect((await again.music.read("jam.get", {}))?.role).toBe("pending");
    expect(await member.music.run("jam.join", { code })).toMatchObject({ status: "pending" });
    expect(await backend.query(api.setup.jam, { code })).toMatchObject({ state: "approval" });
    expect(await host.music.read("jam.get", {})).toMatchObject({
      approvalAfterRemoval: true,
      settings: { join: "open" },
    });

    // A new link lets people straight in again.
    const { code: fresh } = await host.music.run("jam.relink", {});
    const newcomer = await joinAsGuest(backend, fresh);

    expect((await newcomer.music.read("jam.get", {}))?.role).toBe("member");
    expect((await host.music.read("jam.get", {}))?.approvalAfterRemoval).toBe(false);
  });

  it("keep asking the host after one is turned away, even once the Jam is open", async () => {
    const { backend, host, code } = await guestsAllowed(await setup({ join: "approval" }, false));
    const turnedAway = await joinAsGuest(backend, code);

    await host.music.run("jam.approve", { userId: UserId.make(turnedAway.id), approve: false });
    await host.music.run("jam.settings", { join: "open" });
    const again = await joinAsGuest(backend, code);

    expect((await again.music.read("jam.get", {}))?.role).toBe("pending");
    expect((await host.music.read("jam.get", {}))?.approvalAfterRemoval).toBe(true);
    // The flag that explains the host's settings is the host's alone, waiting or let in.
    expect((await again.music.read("jam.get", {}))?.approvalAfterRemoval).toBe(false);
    await host.music.run("jam.approve", { userId: UserId.make(again.id), approve: true });
    expect(await again.music.read("jam.get", {})).toMatchObject({
      role: "member",
      approvalAfterRemoval: false,
    });
  });

  it("go, and the link asks, when the host removes one who already left", async () => {
    const { backend, host, code } = await guestsAllowed(await setup({}, false));
    const guest = await joinAsGuest(backend, code);

    await guest.music.run("jam.leave", {});
    await host.music.run("jam.remove", { userId: UserId.make(guest.id) });
    await drainScheduled(backend);

    expect(await accountsLeft(backend, [guest.id])).toEqual([]);
    expect((await host.music.read("jam.get", {}))?.approvalAfterRemoval).toBe(true);
  });

  it("can't start a Jam of their own, whose link would make more guests", async () => {
    const { backend, code } = await guestsAllowed(await setup());
    const guest = await joinAsGuest(backend, code);
    const invitedGuest = await signUp(backend, "guest");

    // Nor can a guest an admin invited: only members and admins hand out links that make accounts.
    expect(await failureCode(guest.music.run("jam.start", {}))).toBe("forbidden");
    expect(await failureCode(invitedGuest.music.run("jam.start", {}))).toBe("forbidden");
  });

  it("see only playlists shared with them by name, not ones shared with everyone", async () => {
    const { backend, host, code } = await guestsAllowed(await setup());
    const guest = await joinAsGuest(backend, code);
    const invitedGuest = await signUp(backend, "guest");

    const { playlistId: everyone } = await host.music.run("playlists.create", { name: "Everyone" });
    const { playlistId: named } = await host.music.run("playlists.create", { name: "Named" });

    await host.music.run("playlists.visibility", { playlistId: everyone, visibility: "shared" });
    await host.music.run("playlists.share", {
      playlistId: named,
      userId: UserId.make(guest.id),
      role: "viewer",
    });

    const opens = (user: User, playlistId: typeof everyone) =>
      failureCode(user.music.read("playlists.get", { playlistId }));

    expect(await opens(guest, everyone)).toBe("not_found");
    expect(await opens(guest, named)).toBe(ok);
    // A guest an admin invited is a person they know, and sees what's shared with everyone.
    expect(await opens(invitedGuest, everyone)).toBe(ok);
  });

  it("previews a link without signing in", async () => {
    const { backend, host, code } = await setup();
    const preview = await backend.query(api.setup.jam, { code });

    // Whose Jam and how to get in; nothing of what plays or who listens.
    const { name: hostName } = await host.music.read("account.me", {});

    expect(preview).toEqual({ state: "open", hostName, guestAccounts: false });

    await host.music.run("jam.end", {});
    expect(await backend.query(api.setup.jam, { code })).toEqual({ state: "ended" });
    expect(await backend.query(api.setup.jam, { code: "nope" })).toEqual({ state: "invalid" });
  });
});
