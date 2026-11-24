import { setTimeout as sleep } from "node:timers/promises";

import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { api, internal } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { runFunction } from "../admin";
import { member } from "../devices";
import type { Member } from "../devices";
import { share } from "../probe";
import { refusal } from "../sign-in";
import { coreStackFromEnvFile } from "../stack-env";
import type { CoreStack } from "../stack-env";
import {
  AlbumId,
  ArtistId,
  TrackId,
  claimScan,
  finishScan,
  musicLibrary,
  rowsOf,
  totalsOf,
  trackIdsAt,
  upsertAll,
} from "./catalog";
import type { Lease } from "./catalog";
import { musicTrack } from "./scanned";
import type { ScannedTrack } from "./scanned";
import { allPages } from "./shelf";

const stack = coreStackFromEnvFile();

const Credit = Schema.Struct({ artistId: ArtistId, name: Schema.String });

const Named = Schema.Struct({ id: Schema.String, name: Schema.String });

const State = Schema.Struct({
  artists: Schema.Array(
    Schema.Struct({
      id: ArtistId,
      name: Schema.String,
      albumCount: Schema.Finite,
      trackCount: Schema.NullOr(Schema.Finite),
    }),
  ),
  albums: Schema.Array(
    Schema.Struct({
      id: AlbumId,
      title: Schema.String,
      artistName: Schema.String,
      artistId: ArtistId,
      artistKey: Schema.NullOr(Schema.String),
      credits: Schema.NullOr(Schema.Array(Credit)),
      trackCount: Schema.Finite,
    }),
  ),
  tracks: Schema.Array(
    Schema.Struct({
      id: TrackId,
      path: Schema.String,
      albumId: AlbumId,
      artistId: ArtistId,
      credits: Schema.NullOr(Schema.Array(Credit)),
      missing: Schema.Boolean,
    }),
  ),
  credits: Schema.Array(
    Schema.Struct({
      text: Schema.String,
      uses: Schema.Finite,
      artists: Schema.Array(Schema.String),
    }),
  ),
  parts: Schema.Array(Schema.Struct({ part: Schema.String, credit: Schema.String })),
  songs: Schema.Array(Schema.Struct({ credit: Schema.String, trackId: TrackId })),
  trackLinks: Schema.Array(Named),
  albumLinks: Schema.Array(Named),
});

type State = typeof State.Type;

/** Waits until no credit recheck or rewrite is scheduled or running. */
const settle = async (core: CoreStack, deadline = Date.now() + 60_000): Promise<void> => {
  const pending = await runFunction(core, internal.music.creditsProbe.work, {}, Schema.Finite);

  if (pending === 0) return;

  if (Date.now() > deadline) throw new Error(`${pending} credit rechecks are still running`);

  await sleep(100);

  return settle(core, deadline);
};

const stateOf = (core: CoreStack, libraryId: Id<"libraries">): Promise<State> =>
  runFunction(core, internal.music.creditsProbe.state, { libraryId }, State);

/** Checks that the counters equal the totals recounted from the rows. */
const expectExact = async (core: CoreStack, libraryId: Id<"libraries">) => {
  const rows = await rowsOf(core, libraryId);

  expect(await totalsOf(core, libraryId)).toEqual({
    tracks: rows.tracks,
    albums: rows.albums,
    artists: rows.artists,
    durationMs: rows.durationMs,
  });
};

/** A scan held on a new music library of `admin`'s, with one folder. */
const heldScan = async (core: CoreStack, admin: Member, name: string) => {
  const library = await musicLibrary(admin, name);
  const lease = await claimScan(core, library.scanJobId);
  const [root] = library.roots;

  if (root === undefined) throw new Error("the library has no folder");

  return { ...library, lease, root };
};

/** A song at `root/<file>.flac` by `artist` on `album`, with `fields` over those. */
const song = (
  root: string,
  file: string,
  artist: string,
  album: string,
  fields: Partial<ScannedTrack> = {},
): ScannedTrack =>
  musicTrack(`${root}/${file}.flac`, 1000, 1, { title: file, artist, album, ...fields });

/** Writes `tracks` under the scan lease and waits for the rechecks they caused. */
const scan = async (core: CoreStack, lease: Lease, tracks: ReadonlyArray<ScannedTrack>) => {
  await upsertAll(core, lease, tracks);
  await settle(core);
};

/** The names each track at a path credits, by its title. */
const creditsByTitle = (
  state: State,
  root: string,
): Readonly<Record<string, ReadonlyArray<string>>> =>
  Object.fromEntries(
    state.tracks.map((track) => [
      track.path.slice(root.length + 1, -".flac".length),
      (track.credits ?? []).map((credit) => credit.name),
    ]),
  );

const albumOf = (state: State, artistName: string, title: string) => {
  const found = state.albums.find(
    (album) => album.artistName === artistName && album.title === title,
  );

  if (found === undefined) throw new Error(`no album ${artistName} / ${title}`);

  return found;
};

const artistOf = (state: State, name: string) => {
  const found = state.artists.find((artist) => artist.name === name);

  if (found === undefined) throw new Error(`no artist ${name}`);

  return found;
};

const trackOf = async (core: CoreStack, libraryId: Id<"libraries">, path: string) => {
  const [trackId] = await trackIdsAt(core, libraryId, [path]);

  return Schema.decodeUnknownSync(TrackId)(trackId);
};

/** The titles of every song on an artist's page, in its order. */
const songsOn = async (who: Member, artistId: Id<"artists">) => {
  const listed = await allPages((cursor) =>
    who.signedIn.client.query(api.music.artists.tracks, {
      artistId,
      paginationOpts: { numItems: 50, cursor },
    }),
  );

  return listed.rows.map((track) => track.title);
};

describe.skipIf(stack === undefined)("music artist credits", { timeout: 240_000 }, () => {
  it("split a combined credit only on evidence, and list a shared song once on each artist's page", async () => {
    if (stack === undefined) return;
    const admin = await member(stack, "credits-admin", "admin");
    const { libraryId, lease, root } = await heldScan(stack, admin, "Credits");

    const tracks = [
      song(root, "Solo", "Mora", "Solo"),
      song(root, "Collab", "Mora & JHAYCO", "Collab", { albumArtist: "Mora & JHAYCO" }),
      song(root, "Carnaval", "Celia Cruz", "Greatest Hits"),
      song(root, "Quimbara", "Celia Cruz & Johnny Pacheco", "Greatest Hits"),
      song(root, "Babel", "Mumford & Sons", "Babel"),
      song(root, "Alone", "Alexis", "Alone"),
      song(root, "Together", "Alexis y Fido", "Together"),
      song(root, "Jon", "Jon Z", "Jon"),
      song(root, "Both", "Jon Z X Ele A", "Both"),
      song(root, "Port", "Adam Port", "Port"),
      song(root, "Move", "Rampa, Adam Port & &ME", "Move"),
      song(root, "Bad Times", "Imael Angel", "BAD TIMES", {
        albumArtist: "Imael Angel, Imael Angel",
      }),
      song(root, "Ozuna", "Ozuna", "Ozuna"),
      song(root, "Revol", "Revol, Ozuna & Cosculluela", "Revol"),
      song(root, "TOA (feat. Young Miko)", "Bad Bunny", "Singles"),
      song(root, "El Perdón (with Enrique Iglesias)", "Nicky Jam & Enrique Iglesias", "Singles"),
      song(root, "Farruko", "Farruko", "Farruko"),
      song(
        root,
        "Si Es Trucho Es Trucho (feat. Farruko & El Alfa) - Remix",
        "Axel Rulay, Farruko, El Alfa",
        "Trucho",
      ),
    ];

    await scan(stack, lease, tracks);

    const state = await stateOf(stack, libraryId);

    expect(creditsByTitle(state, root)).toEqual({
      Solo: ["Mora"],
      Collab: ["Mora", "JHAYCO"],
      Carnaval: ["Celia Cruz"],
      Quimbara: ["Celia Cruz", "Johnny Pacheco"],
      Babel: ["Mumford & Sons"],
      Alone: ["Alexis"],
      Together: ["Alexis y Fido"],
      Jon: ["Jon Z"],
      Both: ["Jon Z X Ele A"],
      Port: ["Adam Port"],
      Move: ["Rampa", "Adam Port", "&ME"],
      "Bad Times": ["Imael Angel"],
      Ozuna: ["Ozuna"],
      Revol: ["Revol", "Ozuna", "Cosculluela"],
      "TOA (feat. Young Miko)": ["Bad Bunny", "Young Miko"],
      "El Perdón (with Enrique Iglesias)": ["Nicky Jam", "Enrique Iglesias"],
      Farruko: ["Farruko"],
      "Si Es Trucho Es Trucho (feat. Farruko & El Alfa) - Remix": [
        "Axel Rulay",
        "Farruko",
        "El Alfa",
      ],
    });

    // Splitting never merges or divides albums: two "Greatest Hits", each under its album artist.
    const solo = albumOf(state, "Celia Cruz", "Greatest Hits");
    const duet = albumOf(state, "Celia Cruz & Johnny Pacheco", "Greatest Hits");

    expect(solo.id).not.toBe(duet.id);
    expect(duet.credits?.map((credit) => credit.name)).toEqual(["Celia Cruz", "Johnny Pacheco"]);
    expect(albumOf(state, "Mora & JHAYCO", "Collab").credits?.map((one) => one.name)).toEqual([
      "Mora",
      "JHAYCO",
    ]);
    expect(
      albumOf(state, "Imael Angel, Imael Angel", "BAD TIMES").credits?.map((one) => one.name),
    ).toEqual(["Imael Angel"]);

    // No combined artist is left, and a featured artist is credited without an album.
    const names = state.artists.map((artist) => artist.name);

    expect(names).not.toContain("Mora & JHAYCO");
    expect(names).not.toContain("Celia Cruz & Johnny Pacheco");
    expect(names).toContain("Mumford & Sons");
    expect(artistOf(state, "Young Miko")).toMatchObject({ albumCount: 0, trackCount: 1 });
    expect(artistOf(state, "Celia Cruz")).toMatchObject({ albumCount: 2, trackCount: 2 });
    expect(artistOf(state, "Johnny Pacheco")).toMatchObject({ albumCount: 1, trackCount: 1 });
    await expectExact(stack, libraryId);

    // Every credited artist's page lists the shared song once; searching either name finds it.
    expect(await songsOn(admin, artistOf(state, "Mora").id)).toEqual(["Collab", "Solo"]);
    expect(await songsOn(admin, artistOf(state, "JHAYCO").id)).toEqual(["Collab"]);
    expect(await songsOn(admin, artistOf(state, "Young Miko").id)).toEqual([
      "TOA (feat. Young Miko)",
    ]);

    const jhayco = await admin.signedIn.client.query(api.music.artists.get, {
      artistId: artistOf(state, "JHAYCO").id,
    });

    expect(jhayco.artist).toMatchObject({ name: "JHAYCO", albumCount: 1, trackCount: 1 });
    expect(jhayco.topTracks.map((track) => track.title)).toEqual(["Collab"]);
    expect(jhayco.topTracks[0]).toMatchObject({
      artist: "Mora & JHAYCO",
      credits: [
        { artistId: artistOf(state, "Mora").id, name: "Mora" },
        { artistId: artistOf(state, "JHAYCO").id, name: "JHAYCO" },
      ],
    });

    const celiaAlbums = await admin.signedIn.client.query(api.music.artists.albums, {
      artistId: artistOf(state, "Celia Cruz").id,
      paginationOpts: { numItems: 20, cursor: null },
    });

    expect(celiaAlbums.page.map((album) => album.artist).toSorted()).toEqual([
      "Celia Cruz",
      "Celia Cruz & Johnny Pacheco",
    ]);

    const searched = await Promise.all(
      ["jhayco", "mora"].map(async (query) =>
        admin.signedIn.client.query(api.music.library.search, { query }),
      ),
    );

    for (const found of searched) {
      expect(found.tracks.map((track) => track.title)).toContain("Collab");
    }

    const youngMiko = await admin.signedIn.client.query(api.music.library.search, {
      query: "young miko",
    });

    expect(youngMiko.artists.map((artist) => artist.name)).toEqual(["Young Miko"]);

    // A rescan of the same tags writes nothing new.
    await scan(stack, lease, tracks);
    expect(await stateOf(stack, libraryId)).toEqual(state);
    await expectExact(stack, libraryId);
    await finishScan(stack, lease);
  });

  it("credit separate artist values as they are, and a compilation's songs to their own artists", async () => {
    if (stack === undefined) return;
    const admin = await member(stack, "credits-values", "admin");
    const { libraryId, lease, root } = await heldScan(stack, admin, "Values");

    await scan(stack, lease, [
      song(root, "Boogie", "Earth, Wind & Fire & The Emotions", "Boogie", {
        artists: ["Earth, Wind & Fire", "The Emotions"],
        albumArtists: ["Earth, Wind & Fire", "The Emotions"],
        albumArtist: "Earth, Wind & Fire & The Emotions",
      }),
      song(root, "One More Time", "Daft Punk", "Hits", { albumArtist: "Various Artists" }),
      song(root, "Sexy Boy", "Air", "Hits", { albumArtist: "Various Artists" }),
    ]);

    const state = await stateOf(stack, libraryId);

    expect(creditsByTitle(state, root)).toEqual({
      Boogie: ["Earth, Wind & Fire", "The Emotions"],
      "One More Time": ["Daft Punk"],
      "Sexy Boy": ["Air"],
    });
    expect(
      albumOf(state, "Earth, Wind & Fire & The Emotions", "Boogie").credits?.map((one) => one.name),
    ).toEqual(["Earth, Wind & Fire", "The Emotions"]);

    const compilation = albumOf(state, "Various Artists", "Hits");

    expect(compilation.credits?.map((one) => one.name)).toEqual(["Various Artists"]);
    expect(artistOf(state, "Various Artists")).toMatchObject({ albumCount: 1, trackCount: 0 });
    expect(artistOf(state, "Daft Punk")).toMatchObject({ albumCount: 0, trackCount: 1 });
    expect(await songsOn(admin, artistOf(state, "Various Artists").id)).toEqual([]);
    expect(await songsOn(admin, artistOf(state, "Daft Punk").id)).toEqual(["One More Time"]);

    const variousAlbums = await admin.signedIn.client.query(api.music.artists.albums, {
      artistId: artistOf(state, "Various Artists").id,
      paginationOpts: { numItems: 20, cursor: null },
    });

    expect(variousAlbums.page.map((album) => album.title)).toEqual(["Hits"]);
    await expectExact(stack, libraryId);
    await finishScan(stack, lease);
  });

  it("re-resolve a combined credit when a name gains its own credit and loses it again", async () => {
    if (stack === undefined) return;
    const admin = await member(stack, "credits-evidence", "admin");
    const { libraryId, lease, root } = await heldScan(stack, admin, "Evidence");
    const duet = song(root, "Duet", "Calvin Harris & Clementine Douglas", "Blessings");

    await scan(stack, lease, [duet]);

    const whole = await stateOf(stack, libraryId);

    expect(creditsByTitle(whole, root)).toEqual({ Duet: ["Calvin Harris & Clementine Douglas"] });
    expect(artistOf(whole, "Calvin Harris & Clementine Douglas")).toMatchObject({
      albumCount: 1,
      trackCount: 1,
    });

    await scan(stack, lease, [song(root, "Solo", "Calvin Harris", "Solo")]);

    const split = await stateOf(stack, libraryId);

    expect(creditsByTitle(split, root)).toEqual({
      Duet: ["Calvin Harris", "Clementine Douglas"],
      Solo: ["Calvin Harris"],
    });
    expect(
      albumOf(split, "Calvin Harris & Clementine Douglas", "Blessings").credits?.map(
        (one) => one.name,
      ),
    ).toEqual(["Calvin Harris", "Clementine Douglas"]);
    expect(split.artists.map((artist) => artist.name)).not.toContain(
      "Calvin Harris & Clementine Douglas",
    );
    expect(artistOf(split, "Calvin Harris")).toMatchObject({ albumCount: 2, trackCount: 2 });
    expect(albumOf(split, "Calvin Harris & Clementine Douglas", "Blessings").id).toBe(
      albumOf(whole, "Calvin Harris & Clementine Douglas", "Blessings").id,
    );
    await expectExact(stack, libraryId);

    // The solo song is retagged: its name loses its only whole credit, and the duet is one again.
    await scan(stack, lease, [song(root, "Solo", "Somebody Else", "Solo")]);

    const again = await stateOf(stack, libraryId);

    expect(creditsByTitle(again, root)).toEqual({
      Duet: ["Calvin Harris & Clementine Douglas"],
      Solo: ["Somebody Else"],
    });
    expect(again.artists.map((artist) => artist.name).toSorted()).toEqual([
      "Calvin Harris & Clementine Douglas",
      "Somebody Else",
    ]);
    await expectExact(stack, libraryId);
    await finishScan(stack, lease);
  });

  it("keep a credit together or split it as a manager corrects it, until the correction goes", async () => {
    if (stack === undefined) return;
    const admin = await member(stack, "credits-manager", "admin");
    const viewer = await member(stack, "credits-viewer");
    const { libraryId, lease, root } = await heldScan(stack, admin, "Corrections");

    await scan(stack, lease, [
      song(root, "Nacho", "Nacho", "Nacho"),
      song(root, "Duo", "Chino & Nacho", "Duo"),
      song(root, "Wuki", "Wuki & Lee Foss", "Wuki"),
      song(root, "Bad Bunny", "Bad Bunny", "Bad Bunny"),
      song(root, "Reggaeton", "Bad Bunny & Zion & Lennox", "Reggaeton"),
      song(root, "Pink", "PinkPantheress", "Pink"),
      song(root, "Pair", "CA7RIEL & Paco Amoroso", "Pair"),
      song(root, "Trio", "CA7RIEL & Paco Amoroso, PinkPantheress", "Trio"),
    ]);

    expect(creditsByTitle(await stateOf(stack, libraryId), root)).toMatchObject({
      Duo: ["Chino", "Nacho"],
      Wuki: ["Wuki & Lee Foss"],
      Reggaeton: ["Bad Bunny", "Zion", "Lennox"],
      // A whole credit elsewhere in the library stays one artist inside a longer one.
      Trio: ["CA7RIEL & Paco Amoroso", "PinkPantheress"],
    });

    const correct = (name: string, mode: "together" | "split") =>
      admin.signedIn.client.mutation(api.music.credits.setOverride, { libraryId, name, mode });

    await correct("Chino & Nacho", "together");
    await correct("Wuki & Lee Foss", "split");
    await correct("Zion & Lennox", "together");
    await settle(stack);

    expect(creditsByTitle(await stateOf(stack, libraryId), root)).toMatchObject({
      Duo: ["Chino & Nacho"],
      Wuki: ["Wuki", "Lee Foss"],
      Reggaeton: ["Bad Bunny", "Zion & Lennox"],
    });

    const listed = await admin.signedIn.client.query(api.music.credits.list, {
      libraryId,
      paginationOpts: { numItems: 50, cursor: null },
    });

    expect(listed.page.find((credit) => credit.name === "Chino & Nacho")).toEqual({
      name: "Chino & Nacho",
      artists: ["Chino & Nacho"],
      override: "together",
      uses: 2,
    });

    const corrections = await admin.signedIn.client.query(api.music.credits.overrides, {
      libraryId,
      paginationOpts: { numItems: 50, cursor: null },
    });

    expect(corrections.page.map((one) => one.name).toSorted()).toEqual([
      "Chino & Nacho",
      "Wuki & Lee Foss",
      "Zion & Lennox",
    ]);
    await expectExact(stack, libraryId);

    await Promise.all(
      ["Chino & Nacho", "Wuki & Lee Foss", "Zion & Lennox"].map(async (name) =>
        admin.signedIn.client.mutation(api.music.credits.removeOverride, { libraryId, name }),
      ),
    );

    await settle(stack);

    const after = await stateOf(stack, libraryId);

    expect(creditsByTitle(after, root)).toMatchObject({
      Duo: ["Chino", "Nacho"],
      Wuki: ["Wuki & Lee Foss"],
      Reggaeton: ["Bad Bunny", "Zion", "Lennox"],
    });
    expect(after.artists.map((artist) => artist.name)).not.toContain("Chino & Nacho");
    await expectExact(stack, libraryId);

    // Only a manager corrects credits, and only a credit with separators.
    await share(admin, libraryId, { kind: "user", userId: viewer.userId }, "view");
    expect(
      await refusal(
        viewer.signedIn.client.mutation(api.music.credits.setOverride, {
          libraryId,
          name: "Chino & Nacho",
          mode: "together",
        }),
      ),
    ).toBe("forbidden");
    expect(
      await refusal(
        viewer.signedIn.client.query(api.music.credits.list, {
          libraryId,
          paginationOpts: { numItems: 10, cursor: null },
        }),
      ),
    ).toBe("forbidden");
    expect(await refusal(correct("Nacho", "split"))).toBe("invalid_args");
    await finishScan(stack, lease);
  });

  it("adopt rows a release before credits wrote, keeping track and album ids, the same on every rescan", async () => {
    if (stack === undefined) return;
    const admin = await member(stack, "credits-migration", "admin");
    const { libraryId, lease, root } = await heldScan(stack, admin, "Before credits");

    const before = [
      { file: "Solo", artist: "Mora", album: "Solo" },
      { file: "Collab", artist: "Mora & JHAYCO", album: "Collab" },
      { file: "Quimbara", artist: "Celia Cruz & Johnny Pacheco", album: "Celia & Johnny" },
      { file: "Feature", artist: "Bad Bunny", album: "Collab", albumArtist: "Mora & JHAYCO" },
      // A tag repeated per artist, which that release read as its first value alone.
      { file: "Lucky", artist: "Daft Punk", album: "RAM" },
    ];

    await runFunction(
      stack,
      internal.music.creditsProbe.seedBeforeCredits,
      {
        libraryId,
        tracks: before.map(({ file, artist, album, albumArtist }) => {
          const path = `${root}/${file}.flac`;

          return albumArtist === undefined
            ? { path, title: file, artist, album }
            : { path, title: file, artist, album, albumArtist };
        }),
      },
      Schema.Array(TrackId),
    );

    const old = await stateOf(stack, libraryId);
    const collabId = await trackOf(stack, libraryId, `${root}/Collab.flac`);

    expect(old.artists.map((artist) => artist.name).toSorted()).toEqual([
      "Celia Cruz & Johnny Pacheco",
      "Daft Punk",
      "Mora",
      "Mora & JHAYCO",
    ]);
    await admin.signedIn.client.mutation(api.music.likes.set, { trackId: collabId, liked: true });

    // Until the scan reaches them, the rows read as that release wrote them.
    const combinedArtist = artistOf(old, "Mora & JHAYCO").id;

    const page = await admin.signedIn.client.query(api.music.artists.get, {
      artistId: combinedArtist,
    });

    expect(page.topTracks.map((track) => track.title)).toEqual(["Collab", "Feature"]);
    expect(page.topTracks.find((track) => track.title === "Feature")?.credits).toEqual([
      { artistId: combinedArtist, name: "Bad Bunny" },
    ]);
    expect((await songsOn(admin, combinedArtist)).toSorted()).toEqual(["Collab", "Feature"]);

    const oldAlbums = await allPages((cursor) =>
      admin.signedIn.client.query(api.music.artists.albums, {
        artistId: combinedArtist,
        paginationOpts: { numItems: 20, cursor },
      }),
    );

    expect(oldAlbums.rows.map((album) => album.title)).toEqual(["Collab"]);

    const tracks = before.map(({ file, artist, album, albumArtist }) =>
      file === "Lucky"
        ? song(root, file, "Daft Punk & Pharrell Williams", album, {
            artists: ["Daft Punk", "Pharrell Williams"],
          })
        : song(root, file, artist, album, albumArtist === undefined ? {} : { albumArtist }),
    );

    await scan(stack, lease, tracks);

    const adopted = await stateOf(stack, libraryId);

    expect(adopted.tracks.map((track) => track.id)).toEqual(old.tracks.map((track) => track.id));
    expect(adopted.albums.map((album) => album.id)).toEqual(old.albums.map((album) => album.id));
    expect(creditsByTitle(adopted, root)).toEqual({
      Solo: ["Mora"],
      Collab: ["Mora", "JHAYCO"],
      Quimbara: ["Celia Cruz & Johnny Pacheco"],
      Feature: ["Bad Bunny"],
      Lucky: ["Daft Punk", "Pharrell Williams"],
    });
    expect(adopted.artists.map((artist) => artist.name).toSorted()).toEqual([
      "Bad Bunny",
      "Celia Cruz & Johnny Pacheco",
      "Daft Punk",
      "JHAYCO",
      "Mora",
      "Pharrell Williams",
    ]);
    expect(albumOf(adopted, "Daft Punk & Pharrell Williams", "RAM").credits).toEqual([
      { artistId: artistOf(adopted, "Daft Punk").id, name: "Daft Punk" },
      { artistId: artistOf(adopted, "Pharrell Williams").id, name: "Pharrell Williams" },
    ]);
    expect(adopted.albums.every((album) => album.artistKey !== null)).toBe(true);
    await expectExact(stack, libraryId);

    const liked = await admin.signedIn.client.query(api.music.likes.list, {
      paginationOpts: { numItems: 10, cursor: null },
    });

    expect(liked.page.map((track) => track.id)).toEqual([collabId]);

    await scan(stack, lease, tracks);
    expect(await stateOf(stack, libraryId)).toEqual(adopted);
    await expectExact(stack, libraryId);
    await finishScan(stack, lease);
  });
});
