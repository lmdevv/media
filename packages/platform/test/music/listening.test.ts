import { describe, expect, it } from "vitest";

import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { eventually } from "../core/jobs/driver";
import { member } from "../devices";
import type { Member } from "../devices";
import { guestOf } from "../guests";
import { refusal, signIn, unique } from "../sign-in";
import { coreStackFromEnvFile } from "../stack-env";
import { allPages, explicitKid, musicShelf, onAlbum, trackAt } from "./shelf";

const stack = coreStackFromEnvFile();

const SONGS = [
  onAlbum("Listen One", "Opening"),
  onAlbum("Listen One", "Explicit", true),
  onAlbum("Listen Two", "Elsewhere"),
];

const likedIds = async (who: Member): Promise<ReadonlyArray<string>> =>
  (
    await allPages((cursor) =>
      who.signedIn.client.query(api.music.likes.list, { paginationOpts: { numItems: 2, cursor } }),
    )
  ).rows.map((track) => track.id);

/** The album of a song `who` may see, read from the song list. */
const albumOf = async (who: Member, trackId: Id<"tracks">): Promise<Id<"albums">> => {
  const { rows } = await allPages((cursor) =>
    who.signedIn.client.query(api.music.tracks.list, { paginationOpts: { numItems: 200, cursor } }),
  );

  const found = rows.find((track) => track.id === trackId);

  if (found === undefined) throw new Error(`${trackId} is not listed`);

  return found.albumId;
};

const historyOf = async (who: Member) =>
  (
    await allPages((cursor) =>
      who.signedIn.client.query(api.music.history.list, {
        paginationOpts: { numItems: 2, cursor },
      }),
    )
  ).rows;

describe.skipIf(stack === undefined)("music listening", { timeout: 240_000 }, () => {
  it("likes a song once across sessions, newest first, and unlikes it", async () => {
    if (stack === undefined) return;
    const aiko = await member(stack, "aiko");
    const shelf = await musicShelf(stack, [aiko], SONGS);
    const [opening, , elsewhere] = shelf.library.itemIds;

    if (opening === undefined || elsewhere === undefined) throw new Error("no songs");

    await aiko.signedIn.client.mutation(api.music.likes.set, { trackId: opening, liked: true });
    await aiko.signedIn.client.mutation(api.music.likes.set, { trackId: opening, liked: true });
    await aiko.signedIn.client.mutation(api.music.likes.set, { trackId: elsewhere, liked: true });

    expect(await likedIds(aiko)).toEqual([elsewhere, opening]);

    const listed = await aiko.signedIn.client.query(api.music.albums.tracks, {
      albumId: await albumOf(aiko, opening),
      paginationOpts: { numItems: 10, cursor: null },
    });

    expect(listed.page.find((track) => track.id === opening)?.liked).toBe(true);

    await aiko.signedIn.client.mutation(api.music.likes.set, { trackId: opening, liked: false });

    expect(await likedIds(aiko)).toEqual([elsewhere]);
  });

  it("records a play once per start, and offline plays once however often they are sent", async () => {
    if (stack === undefined) return;
    const aiko = await member(stack, "aiko");
    const shelf = await musicShelf(stack, [aiko], SONGS);
    const trackId = trackAt(shelf, 0);
    const started = await aiko.signedIn.client.mutation(api.music.play.start, { trackId });

    expect(started.trackId).toBe(trackId);
    expect(started.ticket.length).toBeGreaterThan(0);

    expect(
      await aiko.signedIn.client.mutation(api.music.play.report, {
        trackId,
        playbackId: started.playbackId,
      }),
    ).toEqual({ recorded: true });
    expect(
      await aiko.signedIn.client.mutation(api.music.play.report, {
        trackId,
        playbackId: started.playbackId,
      }),
    ).toEqual({ recorded: false });

    const sentAt = Date.now();

    const plays = [
      { trackId: trackAt(shelf, 2), playedAt: sentAt - 60_000 },
      { trackId: trackAt(shelf, 2), playedAt: sentAt - 30_000 },
    ];

    expect(
      await aiko.signedIn.client.mutation(api.music.play.reportOffline, { plays, sentAt }),
    ).toEqual({ recorded: 2 });
    expect(
      await aiko.signedIn.client.mutation(api.music.play.reportOffline, { plays, sentAt }),
    ).toEqual({ recorded: 0 });

    const history = await historyOf(aiko);

    expect(history.map((entry) => entry.track.id)).toEqual([
      trackId,
      trackAt(shelf, 2),
      trackAt(shelf, 2),
    ]);
  });

  it("refuses a start as not_found without a grant, for a kid's explicit song, and when missing", async () => {
    if (stack === undefined) return;
    const [aiko, sam] = await Promise.all([member(stack, "aiko"), member(stack, "sam")]);
    const kid = await explicitKid(stack, "kid");
    const shelf = await musicShelf(stack, [aiko, kid], SONGS);

    expect(
      await refusal(
        sam.signedIn.client.mutation(api.music.play.start, { trackId: trackAt(shelf, 0) }),
      ),
    ).toBe("not_found");
    expect(
      await refusal(
        kid.signedIn.client.mutation(api.music.play.start, { trackId: trackAt(shelf, 1) }),
      ),
    ).toBe("not_found");
    expect(
      await refusal(
        kid.signedIn.client.mutation(api.music.likes.set, {
          trackId: trackAt(shelf, 1),
          liked: true,
        }),
      ),
    ).toBe("not_found");
    expect(
      (await kid.signedIn.client.mutation(api.music.play.start, { trackId: trackAt(shelf, 0) }))
        .trackId,
    ).toBe(trackAt(shelf, 0));

    const { key } = await aiko.signedIn.client.action(api.core.auth.apiKeys.create, {
      name: `read-${unique()}`,
      scopes: ["music:read"],
    });

    const reader = await signIn(stack, "apiKey", { key });

    expect(
      await refusal(reader.client.mutation(api.music.play.start, { trackId: trackAt(shelf, 0) })),
    ).toBe("forbidden");
  });

  it("starts a song for a guest whose link covers its album, and no song of another album", async () => {
    if (stack === undefined) return;
    const aiko = await member(stack, "aiko");
    const maker = await member(stack, "link-maker", "admin");
    const shelf = await musicShelf(stack, [aiko], SONGS, maker);
    const opening = trackAt(shelf, 0);

    const albumId = await albumOf(aiko, opening);

    const guest = await guestOf(stack, shelf.manager, {
      domain: "music",
      ref: { type: "album", id: albumId },
    });

    expect(
      (await guest.signedIn.client.mutation(api.music.play.start, { trackId: opening })).trackId,
    ).toBe(opening);
    expect(
      await refusal(
        guest.signedIn.client.mutation(api.music.play.start, { trackId: trackAt(shelf, 2) }),
      ),
    ).toBe("not_found");
    expect(
      await refusal(
        guest.signedIn.client.query(api.music.albums.list, {
          paginationOpts: { numItems: 5, cursor: null },
        }),
      ),
    ).toBe("forbidden");
  });

  it("deletes a removed library's songs from likes, history, playlists, and queues", async () => {
    if (stack === undefined) return;
    const admin = await member(stack, "purge-admin", "admin");
    const aiko = await member(stack, "aiko");
    const shelf = await musicShelf(stack, [aiko], SONGS, admin);
    const kept = await musicShelf(stack, [aiko], [onAlbum("Kept", "Stays")]);
    const gone = trackAt(shelf, 0);
    const stays = trackAt(kept, 0);

    await aiko.signedIn.client.mutation(api.music.likes.set, { trackId: gone, liked: true });

    const started = await aiko.signedIn.client.mutation(api.music.play.start, { trackId: gone });

    await aiko.signedIn.client.mutation(api.music.play.report, {
      trackId: gone,
      playbackId: started.playbackId,
    });

    const { playlistId } = await aiko.signedIn.client.mutation(api.music.playlists.create, {
      name: "Mixed",
      trackIds: [gone, stays],
    });

    await aiko.signedIn.client.mutation(api.music.queue.autoplay, { on: false });
    await aiko.signedIn.client.mutation(api.music.queue.play, { trackIds: [gone, stays] });

    await admin.signedIn.client.mutation(api.core.libraries.remove, {
      libraryId: shelf.library.libraryId,
    });

    await eventually(
      "the purge to shrink the playlist",
      async () => {
        const playlist = await aiko.signedIn.client.query(api.music.playlists.get, { playlistId });

        return playlist.trackCount === 1 ? playlist : null;
      },
      60_000,
    );

    expect(await likedIds(aiko)).not.toContain(gone);
    expect((await historyOf(aiko)).map((entry) => entry.track.id)).not.toContain(gone);

    const queue = await aiko.signedIn.client.query(api.music.queue.get, {});

    const entries = await aiko.signedIn.client.query(api.music.queue.list, {
      paginationOpts: { numItems: 10, cursor: null },
    });

    expect(queue.count).toBe(1);
    expect(entries.page.map((entry) => entry.track.id)).toEqual([stays]);
    expect(queue.current).toBe(entries.page[0]?.itemId ?? null);
  });
});
