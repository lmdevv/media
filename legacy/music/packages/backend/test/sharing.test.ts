/**
 * Playlist sharing through the real dispatcher: who can open, play, edit, and manage a playlist
 * (owners, collaborators, viewers, anyone with the link, guests, strangers, and people whose share
 * was revoked), collaborator edits and their attribution, reordering, and share links.
 */
import { PlaylistId, PlaylistItemId, UserId } from "@music/commands/ids";
import type { PlaylistId as PlaylistIdType, TrackId } from "@music/commands/ids";
import { describe, expect, it } from "vitest";

import { allTracks, drainScheduled, makeBackend, seedLibrary, signUp, trackIds } from "./backend";
import type { User } from "./backend";
import { failureCode } from "./harness";

const pick = <Item>(list: ReadonlyArray<Item>, position: number): Item => {
  const item = list[position];

  if (item === undefined) throw new Error(`Nothing at ${position}`);

  return item;
};

const setup = async () => {
  const backend = makeBackend();
  const owner = await signUp(backend, "owner");
  const member = await signUp(backend, "member");
  await seedLibrary(backend, owner, { name: "Rock", count: 4 });
  const rock = trackIds(await allTracks(owner), "Rock");

  const { playlistId } = await owner.music.run("playlists.create", {
    name: "Road trip",
    trackIds: rock.slice(0, 3),
  });

  return { backend, owner, member, rock, playlistId };
};

const userId = (user: User) => UserId.make(user.id);

/** Every playlist action, each run as `user` against `playlistId`; resolves to its outcome. */
const attempts = (user: User, playlistId: PlaylistIdType, song: TrackId) => ({
  get: () => user.music.read("playlists.get", { playlistId }),
  add: () => user.music.run("playlists.add", { playlistId, trackIds: [song] }),
  remove: async () => {
    const { items } = await user.music.read("playlists.get", { playlistId });

    return user.music.run("playlists.remove", { playlistId, itemId: pick(items, 0).itemId });
  },
  move: async () => {
    const { items } = await user.music.read("playlists.get", { playlistId });

    return user.music.run("playlists.move", { playlistId, itemId: pick(items, 0).itemId });
  },
  rename: () => user.music.run("playlists.update", { playlistId, name: "Renamed" }),
  sharing: () => user.music.read("playlists.sharing", { playlistId }),
  visibility: () => user.music.run("playlists.visibility", { playlistId, visibility: "shared" }),
  delete: () => user.music.run("playlists.delete", { playlistId }),
});

type Action = keyof ReturnType<typeof attempts>;

const ACTIONS: ReadonlyArray<Action> = [
  "get",
  "add",
  "remove",
  "move",
  "rename",
  "sharing",
  "visibility",
  "delete",
];

/** The outcome of every action, in `ACTIONS` order. Destructive ones run last. */
const outcomes = async (user: User, playlistId: PlaylistIdType, song: TrackId) => {
  const run = attempts(user, playlistId, song);
  const results: Array<string> = [];

  // One after another: later actions see what earlier ones changed, as a person would.
  await ACTIONS.reduce(async (previous, action) => {
    await previous;
    results.push(await failureCode(run[action]()));
  }, Promise.resolve());

  return Object.fromEntries(ACTIONS.map((action, position) => [action, results[position]]));
};

const ok = "succeeded";

describe("who can do what with a playlist", () => {
  it("lets the owner do everything", async () => {
    const { owner, rock, playlistId } = await setup();

    expect(await outcomes(owner, playlistId, pick(rock, 3))).toEqual({
      get: ok,
      add: ok,
      remove: ok,
      move: ok,
      rename: ok,
      sharing: ok,
      visibility: ok,
      delete: ok,
    });
  });

  it("lets a collaborator change the songs, not the playlist", async () => {
    const { owner, member, rock, playlistId } = await setup();
    await owner.music.run("playlists.share", {
      playlistId,
      userId: userId(member),
      role: "collaborator",
    });

    expect(await outcomes(member, playlistId, pick(rock, 3))).toEqual({
      get: ok,
      add: ok,
      remove: ok,
      move: ok,
      rename: "forbidden",
      sharing: "forbidden",
      visibility: "forbidden",
      delete: "forbidden",
    });
  });

  it("lets a viewer, or anyone signed in when it is shared by link, only open it", async () => {
    const { backend, owner, member, rock, playlistId } = await setup();
    const passerby = await signUp(backend, "member");
    await owner.music.run("playlists.share", { playlistId, userId: userId(member) });
    await owner.music.run("playlists.visibility", { playlistId, visibility: "shared" });

    const viewerOnly = {
      get: ok,
      add: "forbidden",
      remove: "forbidden",
      move: "forbidden",
      rename: "forbidden",
      sharing: "forbidden",
      visibility: "forbidden",
      delete: "forbidden",
    };

    expect(await outcomes(member, playlistId, pick(rock, 3))).toEqual(viewerOnly);
    expect(await outcomes(passerby, playlistId, pick(rock, 3))).toEqual(viewerOnly);
  });

  it("hides a private playlist from everyone else as not found", async () => {
    const { member, rock, playlistId } = await setup();
    const results = await outcomes(member, playlistId, pick(rock, 3));

    expect(new Set(Object.values(results))).toEqual(new Set(["not_found"]));
  });

  it("closes a playlist again when the owner stops sharing or revokes someone", async () => {
    const { backend, owner, member, rock, playlistId } = await setup();
    const other = await signUp(backend, "member");
    await owner.music.run("playlists.share", { playlistId, userId: userId(member) });
    await owner.music.run("playlists.share", {
      playlistId,
      userId: userId(other),
      role: "collaborator",
    });
    await owner.music.run("playlists.visibility", { playlistId, visibility: "shared" });

    await owner.music.run("playlists.unshare", { playlistId, userId: userId(other) });
    // Revoked by name, but the link still lets them view it.
    expect(await failureCode(other.music.read("playlists.get", { playlistId }))).toBe(ok);
    expect(
      await failureCode(
        other.music.run("playlists.add", { playlistId, trackIds: [pick(rock, 3)] }),
      ),
    ).toBe("forbidden");

    await owner.music.run("playlists.unshare", { playlistId });
    expect(await owner.music.read("playlists.sharing", { playlistId })).toEqual({
      visibility: "private",
      people: [],
    });
    expect(await failureCode(member.music.read("playlists.get", { playlistId }))).toBe("not_found");
    expect(await failureCode(other.music.read("playlists.get", { playlistId }))).toBe("not_found");
    expect(await member.music.read("playlists.shared", {})).toEqual([]);
  });

  it("lets someone leave a playlist shared with them, but not remove others", async () => {
    const { backend, owner, member, playlistId } = await setup();
    const other = await signUp(backend, "member");
    await owner.music.run("playlists.share", { playlistId, userId: userId(member) });
    await owner.music.run("playlists.share", { playlistId, userId: userId(other) });

    expect(
      await failureCode(
        member.music.run("playlists.unshare", { playlistId, userId: userId(other) }),
      ),
    ).toBe("forbidden");
    expect(await failureCode(member.music.run("playlists.unshare", { playlistId }))).toBe(
      "forbidden",
    );

    await member.music.run("playlists.unshare", { playlistId, userId: userId(member) });
    expect(await failureCode(member.music.read("playlists.get", { playlistId }))).toBe("not_found");
    expect(await failureCode(other.music.read("playlists.get", { playlistId }))).toBe(ok);

    // Someone who only has the link has nothing to leave, and is told so.
    await owner.music.run("playlists.visibility", { playlistId, visibility: "shared" });
    expect(
      await failureCode(
        member.music.run("playlists.unshare", { playlistId, userId: userId(member) }),
      ),
    ).toBe("not_found");
  });

  it("refuses unknown playlists, people, and sharing with yourself", async () => {
    const { owner, playlistId } = await setup();

    expect(
      await failureCode(owner.music.run("playlists.share", { playlistId, userId: userId(owner) })),
    ).toBe("invalid_args");
    expect(
      await failureCode(
        owner.music.run("playlists.share", { playlistId, userId: UserId.make("nobody") }),
      ),
    ).toBe("not_found");
    expect(
      await failureCode(
        owner.music.read("playlists.get", { playlistId: PlaylistId.make("nothing") }),
      ),
    ).toBe("not_found");
  });
});

describe("guests", () => {
  it("see playlists shared with them, without the library songs they can't read", async () => {
    const { backend, owner, playlistId } = await setup();
    const guest = await signUp(backend, "guest");
    await owner.music.run("playlists.share", { playlistId, userId: userId(guest) });

    const [shared] = await guest.music.read("playlists.shared", {});

    expect([shared?.id, shared?.access, shared?.owner?.id]).toEqual([
      playlistId,
      "viewer",
      owner.id,
    ]);

    // A guest hears no library until added to it: every song is an unavailable row.
    const { items } = await guest.music.read("playlists.get", { playlistId });

    // Nothing about the song shows, not even its IDs: only its place and length.
    const lengths = new Set((await allTracks(owner)).map((track) => track.durationMs));

    expect(items.map((item) => [item.available, item.reason, item.track])).toEqual([
      [false, "no_access", null],
      [false, "no_access", null],
      [false, "no_access", null],
    ]);
    expect(items.every((item) => lengths.has(item.durationMs))).toBe(true);
  });

  it("can't share or look people up, but can keep their own playlists", async () => {
    const { backend, owner } = await setup();
    const guest = await signUp(backend, "guest");
    const { playlistId } = await guest.music.run("playlists.create", { name: "Mine" });

    expect(await failureCode(guest.music.read("people.directory", {}))).toBe("forbidden");
    expect(
      await failureCode(guest.music.run("playlists.share", { playlistId, userId: userId(owner) })),
    ).toBe("forbidden");
    expect(
      await failureCode(
        guest.music.run("playlists.visibility", { playlistId, visibility: "shared" }),
      ),
    ).toBe("forbidden");
  });
});

describe("collaborating", () => {
  it("records who added each song and lets collaborators add only what they can read", async () => {
    const { backend, owner, member, rock, playlistId } = await setup();
    await seedLibrary(backend, owner, {
      name: "Secret",
      count: 1,
      visibility: "private",
    });
    const [secret] = trackIds(await allTracks(owner), "Secret");

    if (secret === undefined) throw new Error("Seed missing");
    await owner.music.run("playlists.share", {
      playlistId,
      userId: userId(member),
      role: "collaborator",
    });

    await member.music.run("playlists.add", { playlistId, trackIds: [pick(rock, 3)] });
    expect(
      await failureCode(member.music.run("playlists.add", { playlistId, trackIds: [secret] })),
    ).toBe("not_found");

    // The owner adds a song from their private library: the collaborator sees it, unavailable.
    await owner.music.run("playlists.add", { playlistId, trackIds: [secret] });
    const { items } = await member.music.read("playlists.get", { playlistId });

    expect(items.map((item) => [item.track?.id ?? null, item.addedBy?.id, item.reason])).toEqual([
      [pick(rock, 0), owner.id, null],
      [pick(rock, 1), owner.id, null],
      [pick(rock, 2), owner.id, null],
      [pick(rock, 3), member.id, null],
      [null, owner.id, "no_access"],
    ]);
  });

  it("reorders by entry, and two people moving at once both land where they asked", async () => {
    const { owner, member, playlistId } = await setup();
    await owner.music.run("playlists.share", {
      playlistId,
      userId: userId(member),
      role: "collaborator",
    });

    const order = async () =>
      (await owner.music.read("playlists.get", { playlistId })).items.map((item) => item.itemId);

    const [a, b, c] = await order();

    if (a === undefined || b === undefined || c === undefined) throw new Error("Seed missing");

    // The owner moves c to the top while the collaborator, from the same view, moves a after b.
    await owner.music.run("playlists.move", { playlistId, itemId: c });
    await member.music.run("playlists.move", { playlistId, itemId: a, afterItemId: b });
    expect(await order()).toEqual([c, b, a]);

    // Moving after an entry someone just removed fails instead of guessing.
    await owner.music.run("playlists.remove", { playlistId, itemId: b });
    expect(
      await failureCode(
        member.music.run("playlists.move", { playlistId, itemId: a, afterItemId: b }),
      ),
    ).toBe("not_found");
    expect(
      await failureCode(
        member.music.run("playlists.move", {
          playlistId,
          itemId: PlaylistItemId.make(b),
          afterItemId: b,
        }),
      ),
    ).toBe("invalid_args");
  });

  it("keeps the order through many moves between the same two entries", async () => {
    const { owner, playlistId } = await setup();

    const order = async () =>
      (await owner.music.read("playlists.get", { playlistId })).items.map((item) => item.itemId);

    const [a, b, c] = await order();

    if (a === undefined || b === undefined || c === undefined) throw new Error("Seed missing");

    // Each move halves the gap after `a`; past the precision limit the playlist renumbers.
    await Array.from({ length: 60 }).reduce<Promise<void>>(async (previous, _, round) => {
      await previous;
      await owner.music.run("playlists.move", {
        playlistId,
        itemId: round % 2 === 0 ? c : b,
        afterItemId: a,
      });
    }, Promise.resolve());

    expect(await order()).toEqual([a, b, c]);
  });
});

describe("lists and links", () => {
  it("lists playlists shared with you by name, with your access", async () => {
    const { owner, member, playlistId } = await setup();
    await owner.music.run("playlists.share", {
      playlistId,
      userId: userId(member),
      role: "collaborator",
    });

    const shared = await member.music.read("playlists.shared", {});
    const [mine] = await owner.music.read("playlists.list", {});

    expect(shared.map((playlist) => [playlist.id, playlist.access])).toEqual([
      [playlistId, "collaborator"],
    ]);
    expect([mine?.access, mine?.sharedWithPeople]).toEqual(["owner", true]);
    expect(await member.music.read("playlists.list", {})).toEqual([]);
  });

  it("lists people to share with by name only, without suspended people or yourself", async () => {
    const { backend, owner, member } = await setup();
    const suspended = await signUp(backend, "member");
    await owner.music.run("people.suspend", { userId: userId(suspended) });

    const directory = await member.music.read("people.directory", {});

    expect(directory.map((person) => person.id)).toEqual([owner.id]);
    expect(Object.keys(directory[0] ?? {}).toSorted()).toEqual(["id", "name", "role"]);
  });

  it("links to what you can open, and treats the rest as not found", async () => {
    const { backend, owner, member, rock, playlistId } = await setup();

    const [song] = await owner.music
      .read("playlists.get", { playlistId })
      .then((detail) => detail.items.map((item) => item.track));

    if (song === undefined || song === null) throw new Error("Seed missing");

    expect(await member.music.read("links.get", { kind: "track", id: song.id })).toEqual({
      path: `/albums/${song.albumId}?track=${song.id}`,
      title: song.title,
    });
    expect(await member.music.read("links.get", { kind: "album", id: song.albumId })).toEqual({
      path: `/albums/${song.albumId}`,
      title: song.album,
    });
    expect(
      await failureCode(member.music.read("links.get", { kind: "playlist", id: playlistId })),
    ).toBe("not_found");
    // An ID of another kind names nothing of this one.
    expect(await failureCode(member.music.read("links.get", { kind: "album", id: song.id }))).toBe(
      "not_found",
    );

    const guest = await signUp(backend, "guest");

    expect(
      await failureCode(guest.music.read("links.get", { kind: "track", id: pick(rock, 0) })),
    ).toBe("not_found");
  });

  it("closes a removed person's playlists at once, before the batches reach them", async () => {
    const { backend, owner, member } = await setup();
    const friend = await signUp(backend, "member");
    const { playlistId } = await member.music.run("playlists.create", { name: "Mine" });

    await member.music.run("playlists.share", { playlistId, userId: userId(friend) });
    await member.music.run("playlists.visibility", { playlistId, visibility: "shared" });
    await owner.music.run("people.remove", { userId: userId(member) });

    // No batch has run: the playlist is still stored, and nobody can open or list it.
    expect(await failureCode(friend.music.read("playlists.get", { playlistId }))).toBe("not_found");
    expect(await failureCode(owner.music.read("playlists.get", { playlistId }))).toBe("not_found");
    expect(await friend.music.read("playlists.shared", {})).toEqual([]);
  });

  it("keeps a guest's playlists to themselves until they may share again", async () => {
    const { backend, owner, member } = await setup();
    const friend = await signUp(backend, "member");
    const { playlistId } = await member.music.run("playlists.create", { name: "Mine" });

    await member.music.run("playlists.share", { playlistId, userId: userId(friend) });
    await owner.music.run("people.role", { userId: userId(member), role: "guest" });

    expect(await failureCode(friend.music.read("playlists.get", { playlistId }))).toBe("not_found");
    expect(await friend.music.read("playlists.shared", {})).toEqual([]);
    expect(await failureCode(member.music.read("playlists.get", { playlistId }))).toBe("succeeded");

    await owner.music.run("people.role", { userId: userId(member), role: "member" });
    expect(await failureCode(friend.music.read("playlists.get", { playlistId }))).toBe("succeeded");
  });

  it("closes a suspended person's playlists to others until they're unsuspended", async () => {
    const { backend, owner, member } = await setup();
    const friend = await signUp(backend, "member");
    const { playlistId } = await member.music.run("playlists.create", { name: "Mine" });

    await member.music.run("playlists.share", { playlistId, userId: userId(friend) });
    await member.music.run("playlists.visibility", { playlistId, visibility: "shared" });
    await owner.music.run("people.suspend", { userId: userId(member) });

    expect(await failureCode(friend.music.read("playlists.get", { playlistId }))).toBe("not_found");
    expect(await friend.music.read("playlists.shared", {})).toEqual([]);

    await owner.music.run("people.unsuspend", { userId: userId(member) });
    expect(await failureCode(friend.music.read("playlists.get", { playlistId }))).toBe("succeeded");
  });

  it("shares again without taking edit rights away, and never with someone suspended", async () => {
    const { backend, owner, member, playlistId } = await setup();
    const suspended = await signUp(backend, "member");

    await owner.music.run("playlists.share", {
      playlistId,
      userId: userId(member),
      role: "collaborator",
    });
    await owner.music.run("playlists.share", { playlistId, userId: userId(member) });

    const sharing = await owner.music.read("playlists.sharing", { playlistId });

    expect(sharing.people.map((share) => share.role)).toEqual(["collaborator"]);

    await owner.music.run("people.suspend", { userId: userId(suspended) });
    expect(
      await failureCode(
        owner.music.run("playlists.share", { playlistId, userId: userId(suspended) }),
      ),
    ).toBe("not_found");
  });

  it("removes a removed person's shares and the shares of their playlists", async () => {
    const { backend, owner, member, playlistId } = await setup();
    const { playlistId: theirs } = await member.music.run("playlists.create", { name: "Theirs" });
    await member.music.run("playlists.share", { playlistId: theirs, userId: userId(owner) });
    await owner.music.run("playlists.share", { playlistId, userId: userId(member) });

    await owner.music.run("people.remove", { userId: userId(member) });
    await drainScheduled(backend);

    const shares = await backend.run(async (ctx) => ctx.db.query("playlistShares").collect());

    expect(shares).toEqual([]);
    expect(await owner.music.read("playlists.shared", {})).toEqual([]);
  });
});
