import { describe, expect, it } from "vitest";

import { api } from "../../convex/_generated/api";
import { inOrder } from "../../convex/core/lib/inOrder";
import type { Id } from "../../convex/_generated/dataModel";
import { member, sharedAdmin } from "../devices";
import type { Member } from "../devices";
import { share } from "../probe";
import { refusal, signIn, unique } from "../sign-in";
import { coreStackFromEnvFile } from "../stack-env";
import { claimScan, finishScan, musicLibrary, trackIdsAt, upsertAll } from "./catalog";
import { musicTrack } from "./scanned";
import { allPages, at, explicitKid, musicShelf, onAlbum, trackAt } from "./shelf";

const stack = coreStackFromEnvFile();

const SONGS = [
  onAlbum("Shared Album", "First"),
  onAlbum("Shared Album", "Second"),
  onAlbum("Shared Album", "Third", true),
  onAlbum("Shared Album", "Fourth"),
];

const sharedWith = async (who: Member): Promise<ReadonlyArray<Id<"playlists">>> =>
  (
    await allPages((cursor) =>
      who.signedIn.client.query(api.music.playlists.shared, {
        paginationOpts: { numItems: 20, cursor },
      }),
    )
  ).rows.map((playlist) => playlist.id);

const ownedBy = async (who: Member): Promise<ReadonlyArray<Id<"playlists">>> =>
  (
    await allPages((cursor) =>
      who.signedIn.client.query(api.music.playlists.list, {
        paginationOpts: { numItems: 20, cursor },
      }),
    )
  ).rows.map((playlist) => playlist.id);

const itemsOf = async (who: Member, playlistId: Id<"playlists">) =>
  (
    await allPages((cursor) =>
      who.signedIn.client.query(api.music.playlists.items, {
        playlistId,
        paginationOpts: { numItems: 2, cursor },
      }),
    )
  ).rows;

describe.skipIf(stack === undefined)("music playlists", { timeout: 180_000 }, () => {
  it("share as old music did: viewers view, collaborators edit, everyone views a shared one", async () => {
    if (stack === undefined) return;

    const [aiko, mateo, sam] = await Promise.all([
      member(stack, "aiko"),
      member(stack, "mateo", "admin"),
      member(stack, "sam"),
    ]);

    const shelf = await musicShelf(stack, [aiko, mateo, sam], SONGS);

    const { playlistId } = await aiko.signedIn.client.mutation(api.music.playlists.create, {
      name: "Road trip",
      description: "  For the car  ",
      trackIds: [trackAt(shelf, 0), trackAt(shelf, 1)],
    });

    expect(await ownedBy(aiko)).toContain(playlistId);
    expect(await aiko.signedIn.client.query(api.music.playlists.get, { playlistId })).toMatchObject(
      {
        name: "Road trip",
        description: "For the car",
        trackCount: 2,
        access: "owner",
        visibility: "private",
        sharedWithPeople: false,
      },
    );

    // Private: an admin holds no grant on it, so it reads as missing to Mateo (ADR 0005).
    expect(
      await refusal(mateo.signedIn.client.query(api.music.playlists.get, { playlistId })),
    ).toBe("not_found");

    await aiko.signedIn.client.mutation(api.music.playlists.share, {
      playlistId,
      userId: mateo.userId,
    });

    expect(await sharedWith(mateo)).toContain(playlistId);
    expect(await sharedWith(sam)).not.toContain(playlistId);
    expect(await refusal(sam.signedIn.client.query(api.music.playlists.get, { playlistId }))).toBe(
      "not_found",
    );
    expect(
      await mateo.signedIn.client.query(api.music.playlists.get, { playlistId }),
    ).toMatchObject({
      access: "viewer",
      owner: { id: aiko.userId },
    });
    expect(
      await refusal(
        mateo.signedIn.client.mutation(api.music.playlists.addTracks, {
          playlistId,
          trackIds: [trackAt(shelf, 3)],
        }),
      ),
    ).toBe("forbidden");

    await aiko.signedIn.client.mutation(api.music.playlists.share, {
      playlistId,
      userId: mateo.userId,
      role: "collaborator",
    });

    await mateo.signedIn.client.mutation(api.music.playlists.addTracks, {
      playlistId,
      trackIds: [trackAt(shelf, 3)],
    });

    expect((await itemsOf(aiko, playlistId)).map((entry) => entry.track?.title)).toEqual([
      "First",
      "Second",
      "Fourth",
    ]);
    expect(
      await refusal(
        mateo.signedIn.client.mutation(api.music.playlists.update, { playlistId, name: "Mine" }),
      ),
    ).toBe("forbidden");

    expect(await aiko.signedIn.client.query(api.music.playlists.sharing, { playlistId })).toEqual({
      visibility: "private",
      people: [{ person: { id: mateo.userId, name: mateo.username }, role: "collaborator" }],
    });

    await aiko.signedIn.client.mutation(api.music.playlists.visibility, {
      playlistId,
      visibility: "shared",
    });

    expect(await sam.signedIn.client.query(api.music.playlists.get, { playlistId })).toMatchObject({
      access: "viewer",
      visibility: "shared",
      sharedWithPeople: true,
    });
    expect(await sharedWith(sam)).not.toContain(playlistId);

    await aiko.signedIn.client.mutation(api.music.playlists.unshare, { playlistId });

    expect(await refusal(sam.signedIn.client.query(api.music.playlists.get, { playlistId }))).toBe(
      "not_found",
    );
    expect(await sharedWith(mateo)).not.toContain(playlistId);
    expect(await aiko.signedIn.client.query(api.music.playlists.sharing, { playlistId })).toEqual({
      visibility: "private",
      people: [],
    });
  });

  it("never shares a playlist with a group or with a second manager", async () => {
    if (stack === undefined) return;
    const admin = await sharedAdmin(stack);
    const [aiko, mateo] = await Promise.all([member(stack, "aiko"), member(stack, "mateo")]);

    const { groupId } = await admin.signedIn.client.mutation(api.core.permissions.groups.create, {
      name: `family-${unique()}`,
    });

    const { playlistId } = await aiko.signedIn.client.mutation(api.music.playlists.create, {
      name: "Grouped",
    });

    const resource = { type: "playlist" as const, id: playlistId };

    expect(
      await refusal(
        aiko.signedIn.client.mutation(api.core.permissions.grants.set, {
          resource,
          principal: { kind: "group", groupId },
          level: "view",
        }),
      ),
    ).toBe("invalid_args");
    expect(
      await refusal(
        aiko.signedIn.client.mutation(api.core.permissions.grants.set, {
          resource,
          principal: { kind: "user", userId: mateo.userId },
          level: "manage",
        }),
      ),
    ).toBe("invalid_args");
    expect(
      await refusal(
        aiko.signedIn.client.mutation(api.core.permissions.grants.set, {
          resource,
          principal: { kind: "household" },
          level: "edit",
        }),
      ),
    ).toBe("invalid_args");

    // The core's own grants commands share a playlist the way the music commands do.
    await aiko.signedIn.client.mutation(api.core.permissions.grants.set, {
      resource,
      principal: { kind: "user", userId: mateo.userId },
      level: "edit",
    });

    expect(await sharedWith(mateo)).toContain(playlistId);
  });

  it("lets a person leave a playlist shared with them, and never its owner", async () => {
    if (stack === undefined) return;
    const [aiko, mateo] = await Promise.all([member(stack, "aiko"), member(stack, "mateo")]);

    const { playlistId } = await aiko.signedIn.client.mutation(api.music.playlists.create, {
      name: "Leave me",
    });

    await aiko.signedIn.client.mutation(api.music.playlists.share, {
      playlistId,
      userId: mateo.userId,
    });
    await mateo.signedIn.client.mutation(api.music.playlists.unshare, {
      playlistId,
      userId: mateo.userId,
    });

    expect(await sharedWith(mateo)).not.toContain(playlistId);
    expect(
      await refusal(
        aiko.signedIn.client.mutation(api.music.playlists.unshare, {
          playlistId,
          userId: aiko.userId,
        }),
      ),
    ).toBe("conflict");

    // Shared with everyone, not with Mateo by name: there is nothing of his to leave.
    await aiko.signedIn.client.mutation(api.music.playlists.visibility, {
      playlistId,
      visibility: "shared",
    });

    expect(
      await refusal(
        mateo.signedIn.client.mutation(api.music.playlists.unshare, {
          playlistId,
          userId: mateo.userId,
        }),
      ),
    ).toBe("not_found");
    expect(
      await mateo.signedIn.client.query(api.music.playlists.get, { playlistId }),
    ).toMatchObject({
      access: "viewer",
    });
    expect(
      await refusal(
        aiko.signedIn.client.mutation(api.music.playlists.share, {
          playlistId,
          userId: aiko.userId,
        }),
      ),
    ).toBe("invalid_args");
  });

  it("edits entries in order, greys out songs a person may not play, and deletes", async () => {
    if (stack === undefined) return;
    const aiko = await member(stack, "aiko");
    const kid = await explicitKid(stack, "kid");
    const shelf = await musicShelf(stack, [aiko, kid], SONGS);

    const { playlistId } = await aiko.signedIn.client.mutation(api.music.playlists.create, {
      name: "Order",
    });

    const { itemIds } = await aiko.signedIn.client.mutation(api.music.playlists.addTracks, {
      playlistId,
      trackIds: [trackAt(shelf, 0), trackAt(shelf, 1), trackAt(shelf, 2), trackAt(shelf, 3)],
    });

    const first = at(itemIds, 0);
    const second = at(itemIds, 1);
    const third = at(itemIds, 2);
    const fourth = at(itemIds, 3);

    const titles = async () =>
      (await itemsOf(aiko, playlistId)).map((entry) => entry.track?.title ?? null);

    await aiko.signedIn.client.mutation(api.music.playlists.moveItem, {
      playlistId,
      itemId: fourth,
    });

    expect(await titles()).toEqual(["Fourth", "First", "Second", "Third"]);

    await aiko.signedIn.client.mutation(api.music.playlists.moveItem, {
      playlistId,
      itemId: fourth,
      afterItemId: second,
    });

    expect(await titles()).toEqual(["First", "Second", "Fourth", "Third"]);

    // Thirty moves into one gap close it, and the playlist is renumbered without losing an entry.
    await inOrder(
      Array.from({ length: 15 }, (_, round) => round),
      async () => {
        await aiko.signedIn.client.mutation(api.music.playlists.moveItem, {
          playlistId,
          itemId: third,
          afterItemId: first,
        });
        await aiko.signedIn.client.mutation(api.music.playlists.moveItem, {
          playlistId,
          itemId: fourth,
          afterItemId: first,
        });
      },
    );

    expect(await titles()).toEqual(["First", "Fourth", "Third", "Second"]);

    await aiko.signedIn.client.mutation(api.music.playlists.share, {
      playlistId,
      userId: kid.userId,
    });

    const kidView = await itemsOf(kid, playlistId);
    const explicit = kidView.find((entry) => entry.itemId === third);

    expect(explicit).toMatchObject({ track: null, available: false, reason: "no_access" });

    await aiko.signedIn.client.mutation(api.music.playlists.removeItem, {
      playlistId,
      itemId: first,
    });

    expect(await aiko.signedIn.client.query(api.music.playlists.get, { playlistId })).toMatchObject(
      {
        trackCount: 3,
        durationMs: 3000,
      },
    );
    expect(
      await refusal(
        aiko.signedIn.client.mutation(api.music.playlists.removeItem, {
          playlistId,
          itemId: first,
        }),
      ),
    ).toBe("not_found");

    await aiko.signedIn.client.mutation(api.music.playlists.remove, { playlistId });

    expect(await refusal(aiko.signedIn.client.query(api.music.playlists.get, { playlistId }))).toBe(
      "not_found",
    );
    expect(await ownedBy(aiko)).not.toContain(playlistId);
    expect(await sharedWith(kid)).not.toContain(playlistId);
  });

  it("refuses names and songs old music refused, and more than 2,000 entries", async () => {
    if (stack === undefined) return;
    const aiko = await member(stack, "aiko");
    const sam = await member(stack, "sam");
    const shelf = await musicShelf(stack, [aiko], SONGS);
    const hidden = await musicShelf(stack, [sam], SONGS);

    expect(
      await refusal(aiko.signedIn.client.mutation(api.music.playlists.create, { name: "   " })),
    ).toBe("invalid_args");
    expect(
      await refusal(
        aiko.signedIn.client.mutation(api.music.playlists.create, { name: "x".repeat(121) }),
      ),
    ).toBe("invalid_args");
    expect(
      await refusal(
        aiko.signedIn.client.mutation(api.music.playlists.create, {
          name: "Reversed",
          description: "Play \u202Edrawkcab",
        }),
      ),
    ).toBe("invalid_args");

    const { playlistId } = await aiko.signedIn.client.mutation(api.music.playlists.create, {
      name: "Limits",
    });

    expect(
      await refusal(
        aiko.signedIn.client.mutation(api.music.playlists.addTracks, {
          playlistId,
          trackIds: [trackAt(shelf, 0), trackAt(hidden, 0)],
        }),
      ),
    ).toBe("not_found");
    expect((await itemsOf(aiko, playlistId)).length).toBe(0);

    const many = Array.from({ length: 2000 }, (_, n) => trackAt(shelf, n % 4));

    await aiko.signedIn.client.mutation(api.music.playlists.addTracks, {
      playlistId,
      trackIds: many,
    });

    expect(await aiko.signedIn.client.query(api.music.playlists.get, { playlistId })).toMatchObject(
      {
        trackCount: 2000,
      },
    );
    expect(
      await refusal(
        aiko.signedIn.client.mutation(api.music.playlists.addTracks, {
          playlistId,
          trackIds: [trackAt(shelf, 0)],
        }),
      ),
    ).toBe("conflict");
  });

  it("refuses sharing from an API key, as the core's grants do", async () => {
    if (stack === undefined) return;
    const [aiko, mateo] = await Promise.all([member(stack, "aiko"), member(stack, "mateo")]);

    const { playlistId } = await aiko.signedIn.client.mutation(api.music.playlists.create, {
      name: "Keys",
    });

    const { key } = await aiko.signedIn.client.action(api.core.auth.apiKeys.create, {
      name: `edit-${unique()}`,
      scopes: ["music:read", "music:edit"],
    });

    const agent = await signIn(stack, "apiKey", { key });

    expect(
      await refusal(
        agent.client.mutation(api.music.playlists.share, { playlistId, userId: mateo.userId }),
      ),
    ).toBe("forbidden");

    await agent.client.mutation(api.music.playlists.update, { playlistId, name: "Renamed" });

    expect(await aiko.signedIn.client.query(api.music.playlists.get, { playlistId })).toMatchObject(
      {
        name: "Renamed",
      },
    );
  });
  it("takes off the length an entry added, even after a rescan changed the song's", async () => {
    if (stack === undefined) return;
    const admin = await sharedAdmin(stack);
    const aiko = await member(stack, "aiko");
    const { libraryId, scanJobId, roots } = await musicLibrary(admin, `Drift ${unique()}`);
    const path = `${at(roots, 0)}/Drift/Long.flac`;
    const scan = await claimScan(stack, scanJobId);

    await upsertAll(stack, scan, [musicTrack(path, 1000, 1, { durationMs: 120_000 })]);
    await share(admin, libraryId, { kind: "user", userId: aiko.userId }, "view");

    const trackId = at(await trackIdsAt(stack, libraryId, [path]), 0);

    if (trackId === null) throw new Error("the scan wrote no track");

    const { playlistId } = await aiko.signedIn.client.mutation(api.music.playlists.create, {
      name: "Drift",
      trackIds: [trackId],
    });

    expect(
      (await aiko.signedIn.client.query(api.music.playlists.get, { playlistId })).durationMs,
    ).toBe(120_000);

    // A rescan finds the file changed and half as long; the playlist keeps what the entry added.
    await upsertAll(stack, scan, [musicTrack(path, 2000, 2, { durationMs: 60_000 })]);
    await finishScan(stack, scan);

    const [entry] = await itemsOf(aiko, playlistId);

    if (entry === undefined) throw new Error("the playlist has no entry");

    expect(entry.durationMs).toBe(60_000);

    await aiko.signedIn.client.mutation(api.music.playlists.removeItem, {
      playlistId,
      itemId: entry.itemId,
    });

    expect(await aiko.signedIn.client.query(api.music.playlists.get, { playlistId })).toMatchObject(
      { trackCount: 0, durationMs: 0 },
    );
  });
});
