import { describe, expect, it } from "vitest";

import { api } from "../../convex/_generated/api";
import { member } from "../devices";
import type { Member } from "../devices";
import { share } from "../probe";
import { refusal, signIn, unique } from "../sign-in";
import { coreStackFromEnvFile } from "../stack-env";
import { claimScan, finishScan, musicLibrary, trackIdsAt, upsert } from "./catalog";
import { musicTrack, plainLyrics } from "./scanned";
import type { LyricSet } from "./scanned";
import { allPages, at, explicitKid, musicShelf, ofOurs, onAlbum, trackAt } from "./shelf";

const stack = coreStackFromEnvFile();

const SONGS = [
  onAlbum("Alpha", "Loud Song", true),
  onAlbum("Alpha", "Quiet Song"),
  onAlbum("Alpha", "Middle Song"),
  onAlbum("Beta", "Another Song"),
  onAlbum("Beta", "Last Song"),
];

const syncedLyrics = (fileName: string, words: boolean): LyricSet => ({
  kind: "main",
  lang: "en",
  origin: { _tag: "Sidecar", fileName, format: "lrc" },
  body: {
    _tag: "Synced",
    lines: [
      {
        text: "Hello",
        startMs: 0,
        endMs: 1000,
        words: words ? [{ text: "Hello", startMs: 0, endMs: 1000 }] : null,
        voice: null,
      },
    ],
  },
});

const songsOf = async (who: Member) =>
  allPages((cursor) =>
    who.signedIn.client.query(api.music.tracks.list, {
      paginationOpts: { numItems: 200, cursor },
    }),
  );

const albumsOf = async (who: Member) =>
  allPages((cursor) =>
    who.signedIn.client.query(api.music.albums.list, {
      paginationOpts: { numItems: 200, cursor },
    }),
  );

describe.skipIf(stack === undefined)("music browsing", { timeout: 180_000 }, () => {
  it("lists albums, songs, and artists by each person's grants and a kid's explicit filter", async () => {
    if (stack === undefined) return;
    const [aiko, sam] = await Promise.all([member(stack, "aiko"), member(stack, "sam")]);
    const kid = await explicitKid(stack, "kid");
    const shelf = await musicShelf(stack, [aiko, kid], SONGS);
    const ours = new Set<string>(shelf.library.itemIds);
    const loud = trackAt(shelf, 0);

    const aikoSongs = await songsOf(aiko);
    const kidSongs = await songsOf(kid);
    const samSongs = await songsOf(sam);

    const titles = aikoSongs.rows.filter((track) => ours.has(track.id)).map((track) => track.title);

    expect(titles).toEqual(["Another Song", "Last Song", "Loud Song", "Middle Song", "Quiet Song"]);
    expect(new Set(ofOurs(aikoSongs.rows, ours)).size).toBe(5);
    expect(ofOurs(kidSongs.rows, ours)).not.toContain(loud);
    expect(ofOurs(kidSongs.rows, ours)).toHaveLength(4);
    expect(ofOurs(samSongs.rows, ours)).toEqual([]);

    const aikoAlbums = (await albumsOf(aiko)).rows.filter((album) =>
      ["Alpha", "Beta"].includes(album.title),
    );

    expect(aikoAlbums.map((album) => album.title).toSorted()).toEqual(["Alpha", "Beta"]);
    expect(
      (await albumsOf(sam)).rows.filter((album) => aikoAlbums.some((one) => one.id === album.id)),
    ).toEqual([]);

    const alpha = at(
      aikoAlbums.filter((album) => album.title === "Alpha"),
      0,
    );

    expect(
      await aiko.signedIn.client.query(api.music.albums.get, { albumId: alpha.id }),
    ).toMatchObject({
      album: { title: "Alpha", artist: "Seed Artist", trackCount: 3 },
      format: "FLAC",
    });
    expect(
      await refusal(sam.signedIn.client.query(api.music.albums.get, { albumId: alpha.id })),
    ).toBe("not_found");

    const tracksOf = async (who: Member) =>
      (
        await who.signedIn.client.query(api.music.albums.tracks, {
          albumId: alpha.id,
          paginationOpts: { numItems: 50, cursor: null },
        })
      ).page.map((track) => track.title);

    expect((await tracksOf(aiko)).toSorted()).toEqual(["Loud Song", "Middle Song", "Quiet Song"]);
    expect((await tracksOf(kid)).toSorted()).toEqual(["Middle Song", "Quiet Song"]);

    const artist = await aiko.signedIn.client.query(api.music.artists.get, {
      artistId: alpha.artistId,
    });

    expect(artist.artist).toMatchObject({ name: "Seed Artist", albumCount: 2 });
    expect(artist.topTracks).toHaveLength(5);

    const kidArtist = await kid.signedIn.client.query(api.music.artists.get, {
      artistId: alpha.artistId,
    });

    expect(kidArtist.topTracks.map((track) => track.id)).not.toContain(loud);
    expect(
      await refusal(sam.signedIn.client.query(api.music.artists.get, { artistId: alpha.artistId })),
    ).toBe("not_found");

    const artistAlbums = await aiko.signedIn.client.query(api.music.artists.albums, {
      artistId: alpha.artistId,
      paginationOpts: { numItems: 10, cursor: null },
    });

    expect(artistAlbums.page.map((album) => album.title).toSorted()).toEqual(["Alpha", "Beta"]);

    const artists = await allPages((cursor) =>
      aiko.signedIn.client.query(api.music.artists.list, {
        paginationOpts: { numItems: 200, cursor },
      }),
    );

    expect(artists.rows.map((row) => row.id)).toContain(alpha.artistId);

    const samArtists = await allPages((cursor) =>
      sam.signedIn.client.query(api.music.artists.list, {
        paginationOpts: { numItems: 200, cursor },
      }),
    );

    expect(samArtists.rows.map((row) => row.id)).not.toContain(alpha.artistId);
  });

  it("searches only what each person may play, and hides explicit songs from a kid", async () => {
    if (stack === undefined) return;
    const aiko = await member(stack, "search-aiko");
    const kid = await explicitKid(stack, "search-kid");
    const word = `zq${unique()}`;

    const shelf = await musicShelf(
      stack,
      [aiko, kid],
      [onAlbum(`${word} Album`, `${word} Loud`, true), onAlbum(`${word} Album`, `${word} Calm`)],
    );

    const loud = trackAt(shelf, 0);
    const found = await aiko.signedIn.client.query(api.music.library.search, { query: word });
    const kidFound = await kid.signedIn.client.query(api.music.library.search, { query: word });

    expect(found.tracks.map((track) => track.id).toSorted()).toEqual(
      [...shelf.library.itemIds].toSorted(),
    );
    expect(found.albums.map((album) => album.title)).toEqual([`${word} Album`]);
    expect(kidFound.tracks.map((track) => track.id)).toEqual([trackAt(shelf, 1)]);
    expect(kidFound.tracks.map((track) => track.id)).not.toContain(loud);
    expect(
      await refusal(
        aiko.signedIn.client.query(api.music.library.search, { query: word, limit: 51 }),
      ),
    ).toBe("invalid_args");
  });

  it("shows home rows and totals from the libraries a person sees, and plays they made", async () => {
    if (stack === undefined) return;
    const aiko = await member(stack, "home-aiko");
    const shelf = await musicShelf(stack, [aiko], SONGS);
    const before = await aiko.signedIn.client.query(api.music.library.home, {});

    expect(before.stats.tracks).toBeGreaterThanOrEqual(5);
    expect(before.stats.albums).toBeGreaterThanOrEqual(2);
    expect(before.recentlyPlayed).toEqual([]);

    const started = await aiko.signedIn.client.mutation(api.music.play.start, {
      trackId: trackAt(shelf, 1),
    });

    await aiko.signedIn.client.mutation(api.music.play.report, {
      trackId: trackAt(shelf, 1),
      playbackId: started.playbackId,
    });

    const after = await aiko.signedIn.client.query(api.music.library.home, {});

    expect(after.recentlyPlayed.map((album) => album.title)).toEqual(["Alpha"]);
    expect(after.recentlyPlayedArtists.map((artist) => artist.name)).toEqual(["Seed Artist"]);
  });

  it("refuses catalog reads to a key without music:read", async () => {
    if (stack === undefined) return;
    const aiko = await member(stack, "key-aiko");

    const { key } = await aiko.signedIn.client.action(api.core.auth.apiKeys.create, {
      name: `play-${unique()}`,
      scopes: ["music:play"],
    });

    const speaker = await signIn(stack, "apiKey", { key });

    expect(
      await refusal(
        speaker.client.query(api.music.albums.list, {
          paginationOpts: { numItems: 5, cursor: null },
        }),
      ),
    ).toBe("forbidden");
  });

  it("answers a song's own lyrics, synced before plain and a file before a tag", async () => {
    if (stack === undefined) return;
    const admin = await member(stack, "lyrics-admin", "admin");
    const aiko = await member(stack, "lyrics-aiko");
    const { libraryId, scanJobId, roots } = await musicLibrary(admin, `Lyrics ${unique()}`);
    const root = at(roots, 0);
    const lease = await claimScan(stack, scanJobId);

    const embedded: LyricSet = {
      ...syncedLyrics("x", true),
      origin: { _tag: "Embedded", tag: "id3:SYLT" },
    };

    await upsert(stack, lease, [
      musicTrack(`${root}/A/Album/synced.flac`, 1000, 1, {
        lyrics: [plainLyrics("Plain words"), embedded, syncedLyrics("synced.lrc", false)],
      }),
      musicTrack(`${root}/A/Album/plain.flac`, 1000, 1, { lyrics: [plainLyrics("Only plain")] }),
      musicTrack(`${root}/A/Album/none.flac`),
    ]);
    await finishScan(stack, lease);
    await share(admin, libraryId, { kind: "user", userId: aiko.userId }, "view");

    const [synced, plain, none] = await trackIdsAt(stack, libraryId, [
      `${root}/A/Album/synced.flac`,
      `${root}/A/Album/plain.flac`,
      `${root}/A/Album/none.flac`,
    ]);

    if (synced === null || plain === null || none === null || synced === undefined) {
      throw new Error("the scan wrote no tracks");
    }

    const lyricsOf = (trackId: NonNullable<typeof synced>) =>
      aiko.signedIn.client.query(api.music.lyrics.get, { trackId });

    const best = await lyricsOf(synced);

    expect(best).toMatchObject({
      status: "synced",
      source: "file",
      main: { origin: { type: "sidecar", fileName: "synced.lrc" } },
    });
    expect("extras" in best ? best.extras : []).toHaveLength(2);
    expect(await lyricsOf(plain ?? synced)).toMatchObject({
      status: "plain",
      main: { body: { type: "plain", text: "Only plain" } },
    });
    expect(await lyricsOf(none ?? synced)).toEqual({ status: "none" });

    const sam = await member(stack, "lyrics-sam");

    expect(
      await refusal(sam.signedIn.client.query(api.music.lyrics.get, { trackId: synced })),
    ).toBe("not_found");
  });
  it("shows a song a person may see, with its album, as old music's links did", async () => {
    if (stack === undefined) return;
    const [aiko, sam] = await Promise.all([member(stack, "aiko"), member(stack, "sam")]);
    const kid = await explicitKid(stack, "kid");
    const shelf = await musicShelf(stack, [aiko, kid], SONGS);
    const quiet = trackAt(shelf, 1);
    const loud = trackAt(shelf, 0);

    const song = await aiko.signedIn.client.query(api.music.tracks.get, { trackId: quiet });

    expect(song).toMatchObject({ id: quiet, title: "Quiet Song", album: "Alpha", liked: false });

    const album = await aiko.signedIn.client.query(api.music.albums.get, { albumId: song.albumId });

    expect(album.album.title).toBe("Alpha");
    expect(await refusal(sam.signedIn.client.query(api.music.tracks.get, { trackId: quiet }))).toBe(
      "not_found",
    );
    expect(await refusal(kid.signedIn.client.query(api.music.tracks.get, { trackId: loud }))).toBe(
      "not_found",
    );
  });
});
