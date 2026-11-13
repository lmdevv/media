import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { member } from "../devices";
import type { Member } from "../devices";
import { runServer, runServerAs } from "../service";
import { refusal } from "../sign-in";
import { coreStackFromEnvFile } from "../stack-env";
import type { CoreStack } from "../stack-env";
import {
  Written,
  catalogRowsOf,
  claimScan,
  finishScan,
  knownFiles,
  leftOf,
  markMissing,
  moveAll,
  musicLibrary,
  rowsOf,
  totalsOf,
  trackIdsAt,
  trackState,
  upsert,
  upsertAll,
  Saved,
} from "./catalog";
import type { Lease } from "./catalog";
import { musicTrack, plainLyrics } from "./scanned";
import type { ScannedTrack } from "./scanned";

const stack = coreStackFromEnvFile();

/** An artwork hash no earlier run of the suite used, as the stack keeps their rows. */
const freshArt = (): string => `${crypto.randomUUID().replaceAll("-", "")}${"0".repeat(32)}`;

const ART_A = freshArt();

const ART_B = freshArt();

const ART_C = freshArt();

const first = <T>(values: ReadonlyArray<T | null | undefined>): T => {
  const [value] = values;

  if (value === undefined || value === null) throw new Error("no value");

  return value;
};

/** A scan held on a new music library of `admin`'s, with one folder. */
const heldScan = async (core: CoreStack, admin: Member, name: string) => {
  const library = await musicLibrary(admin, name);
  const lease = await claimScan(core, library.scanJobId);
  const [root] = library.roots;

  if (root === undefined) throw new Error("the library has no folder");

  return { ...library, lease, root };
};

/** Checks that the counters equal the totals recounted from the rows. */
const expectExact = async (core: CoreStack, libraryId: Id<"libraries">) => {
  const rows = await rowsOf(core, libraryId);
  const totals = await totalsOf(core, libraryId);

  expect(totals).toEqual({
    tracks: rows.tracks,
    albums: rows.albums,
    artists: rows.artists,
    durationMs: rows.durationMs,
  });

  return totals;
};

const album = (
  root: string,
  artist: string,
  title: string,
  count: number,
  fields: Partial<ScannedTrack> = {},
) =>
  Array.from({ length: count }, (_, n) =>
    musicTrack(`${root}/${artist}/${title}/${n}.flac`, 1000 + n, 1, {
      artist,
      album: title,
      durationMs: 60_000 + n,
      trackNumber: n + 1,
      ...fields,
    }),
  );

describe.skipIf(stack === undefined)("music scanner", { timeout: 180_000 }, () => {
  it("write tracks under their albums and artists, with exact totals across rescans", async () => {
    if (stack === undefined) return;
    const admin = await member(stack, "scan-admin", "admin");
    const { libraryId, lease, root } = await heldScan(stack, admin, "Records");

    const tracks: ReadonlyArray<ScannedTrack> = [
      ...album(root, "Sintel Band", "First", 12),
      ...album(root, "Sintel Band", "Second", 8),
      ...album(root, "Other", "Third", 5, { albumArtist: "Various" }),
    ];

    await upsertAll(stack, lease, tracks);

    expect(await expectExact(stack, libraryId)).toEqual({
      tracks: 25,
      albums: 3,
      artists: 2,
      durationMs: tracks.reduce((sum, track) => sum + track.durationMs, 0),
    });
    expect(await catalogRowsOf(stack, libraryId)).toEqual({ albums: 3, artists: 2 });
    expect((await admin.signedIn.client.query(api.core.libraries.get, { libraryId })).items).toBe(
      25,
    );

    await upsertAll(stack, lease, tracks);
    await expectExact(stack, libraryId);
    expect(await catalogRowsOf(stack, libraryId)).toEqual({ albums: 3, artists: 2 });

    const known = await knownFiles(stack, lease);

    expect(known.map((file) => file.path).toSorted()).toEqual(
      tracks.map((track) => track.path).toSorted(),
    );
    expect(known.find((file) => file.path === tracks[0]?.path)).toMatchObject({
      artist: "Sintel Band",
      album: "First",
      missing: false,
      lyricsBytes: null,
    });

    await finishScan(stack, lease);
  });

  it("keep a missing track's row off the totals, and bring it back", async () => {
    if (stack === undefined) return;
    const admin = await member(stack, "missing-admin", "admin");
    const { libraryId, lease, root } = await heldScan(stack, admin, "Missing");
    const lone = album(root, "Solo", "Lone", 1);
    const pair = album(root, "Duo", "Pair", 2);

    await upsertAll(stack, lease, [...lone, ...pair]);

    const lonePath = first(lone).path;

    expect(await markMissing(stack, lease, [lonePath, lonePath])).toMatchObject({
      value: { done: 2, marked: 1 },
    });
    expect(await expectExact(stack, libraryId)).toMatchObject({
      tracks: 2,
      albums: 1,
      artists: 1,
    });
    expect(await catalogRowsOf(stack, libraryId)).toEqual({ albums: 2, artists: 2 });
    expect((await knownFiles(stack, lease)).find((file) => file.path === lonePath)).toMatchObject({
      missing: true,
    });

    const [loneId] = await trackIdsAt(stack, libraryId, [lonePath]);

    await upsertAll(stack, lease, lone);

    expect(await trackIdsAt(stack, libraryId, [lonePath])).toEqual([loneId]);
    expect(await expectExact(stack, libraryId)).toMatchObject({
      tracks: 3,
      albums: 2,
      artists: 2,
    });

    await finishScan(stack, lease);
  });

  it("move a track to its new path keeping its id, and mark the old path missing otherwise", async () => {
    if (stack === undefined) return;
    const admin = await member(stack, "move-admin", "admin");
    const { libraryId, lease, root } = await heldScan(stack, admin, "Moves");
    const [one, two] = album(root, "Mover", "Moving", 2);

    if (one === undefined || two === undefined) throw new Error("two tracks");

    await upsertAll(stack, lease, [one, two]);

    const [oneId, twoId] = await trackIdsAt(stack, libraryId, [one.path, two.path]);
    const renamed = { ...one, path: `${root}/Mover/Moving/renamed.flac` };
    const ontoTwo = { ...one, path: two.path };

    const answers = await moveAll(stack, lease, [
      { from: one.path, track: renamed },
      { from: `${root}/Mover/Moving/never.flac`, track: ontoTwo },
    ]);

    expect(answers.map((call) => call.moved)).toEqual([1]);
    expect(await trackIdsAt(stack, libraryId, [renamed.path, one.path, two.path])).toEqual([
      oneId,
      null,
      twoId,
    ]);
    expect(await expectExact(stack, libraryId)).toMatchObject({ tracks: 2, albums: 1 });

    await finishScan(stack, lease);
  });

  it("delete an album a retag emptied, then its artist, and release their artwork", async () => {
    if (stack === undefined) return;
    const admin = await member(stack, "retag-admin", "admin");
    const { libraryId, lease, root } = await heldScan(stack, admin, "Retags");
    const [song] = album(root, "Before", "Old", 1);

    if (song === undefined) throw new Error("one track");

    await upsertAll(stack, lease, [{ ...song, artHash: ART_A }]);

    const [songId] = await trackIdsAt(stack, libraryId, [song.path]);
    const before = await trackState(stack, first([songId]));

    const retagged = await upsert(stack, lease, [
      { ...song, artist: "After", album: "New", artHash: ART_B },
    ]);

    expect(retagged).toMatchObject({ outcome: "held", value: { done: 1 } });
    expect(retagged.outcome === "held" ? new Set(retagged.value.released) : null).toEqual(
      new Set([ART_A]),
    );

    const after = await trackState(stack, first([songId]));

    expect(after?.albumId).not.toBe(before?.albumId);
    expect(await catalogRowsOf(stack, libraryId)).toEqual({ albums: 1, artists: 1 });
    expect(await expectExact(stack, libraryId)).toMatchObject({
      tracks: 1,
      albums: 1,
      artists: 1,
    });
    expect(
      await runServer(
        stack,
        api.music.art.inUse,
        { hashes: [ART_A, ART_B, ART_C] },
        Schema.Struct({ inUse: Schema.Array(Schema.String) }),
      ),
    ).toEqual({ inUse: [ART_B] });

    await finishScan(stack, lease);
  });

  it("follow a replaced cover, and fall back to another track's art when one goes", async () => {
    if (stack === undefined) return;
    const admin = await member(stack, "art-admin", "admin");
    const { lease, root } = await heldScan(stack, admin, "Covers");
    const [one, two] = album(root, "Painter", "Covers", 2);

    if (one === undefined || two === undefined) throw new Error("two tracks");

    await upsertAll(stack, lease, [
      { ...one, artHash: ART_A, folderArt: "cover.jpg:1:1" },
      { ...two, artHash: ART_B },
    ]);

    const used = async () =>
      (
        await runServer(
          stack,
          api.music.art.inUse,
          { hashes: [ART_A, ART_B, ART_C] },
          Schema.Struct({ inUse: Schema.Array(Schema.String) }),
        )
      ).inUse;

    expect(await used()).toEqual([ART_A, ART_B]);

    await upsertAll(stack, lease, [{ ...one, artHash: ART_C, folderArt: "cover.jpg:2:2" }]);

    expect(await used()).toEqual([ART_B, ART_C]);

    const dropped = await upsert(stack, lease, [{ ...one, folderArt: "cover.jpg:2:2" }]);

    expect(dropped.outcome === "held" ? dropped.value.released : null).toContain(ART_C);
    expect(await used()).toEqual([ART_B]);

    const HashPage = Schema.Struct({
      hashes: Schema.Array(Schema.String),
      cursor: Schema.String,
      done: Schema.Boolean,
    });

    const allHashes = async (
      cursor: string | null = null,
      seen: ReadonlyArray<string> = [],
    ): Promise<ReadonlyArray<string>> => {
      const page = await runServer(
        stack,
        api.music.art.hashes,
        { table: "albums", cursor },
        HashPage,
      );

      const next = [...seen, ...page.hashes];

      return page.done ? next : allHashes(page.cursor, next);
    };

    const listed = await allHashes();

    expect(listed).toContain(ART_B);
    expect(listed).not.toContain(ART_C);
    expect(new Set(listed).size).toBe(listed.length);

    await finishScan(stack, lease);
  });

  it("save, replace, and drop a track's own lyrics, and refuse malformed ones", async () => {
    if (stack === undefined) return;
    const admin = await member(stack, "lyrics-admin", "admin");
    const { libraryId, lease, root } = await heldScan(stack, admin, "Lyrics");
    const [song] = album(root, "Singer", "Words", 1);

    if (song === undefined) throw new Error("one track");

    await upsertAll(stack, lease, [{ ...song, lyrics: [plainLyrics("La la la")] }]);

    const [songId] = await trackIdsAt(stack, libraryId, [song.path]);
    const id = first([songId]);

    expect(await leftOf(stack, [id])).toEqual({ tracks: 1, lyrics: 1 });
    expect((await trackState(stack, id))?.lyricsBytes).toBeGreaterThan(0);

    const save = (lyrics: ScannedTrack["lyrics"]) =>
      runServer(
        stack,
        api.music.scanner.lyrics,
        {
          lease,
          tracks: [{ path: song.path, lyricsFiles: "song.txt:1:2", lyricsReader: 2, lyrics }],
        },
        Saved,
      );

    expect(await save([plainLyrics("Na na na", "pt-BR")])).toEqual({
      outcome: "held",
      value: { done: 1, saved: 1 },
    });
    expect((await knownFiles(stack, lease))[0]).toMatchObject({
      lyricsFiles: "song.txt:1:2",
      lyricsReader: 2,
    });
    expect(await save([])).toMatchObject({ value: { saved: 1 } });
    expect(await leftOf(stack, [id])).toEqual({ tracks: 1, lyrics: 0 });
    expect((await trackState(stack, id))?.lyricsBytes).toBeNull();
    expect(await refusal(save([plainLyrics("Bad", "EN!")]))).toMatch(/not lyric sets/u);
    expect(await refusal(save([plainLyrics("")]))).toMatch(/not lyric sets/u);

    await finishScan(stack, lease);
  });

  it("skip a path over the filesystem's limit, and refuse one outside the folders", async () => {
    if (stack === undefined) return;
    const admin = await member(stack, "bounds-admin", "admin");
    const { libraryId, lease, root } = await heldScan(stack, admin, "Bounds");
    const long = musicTrack(`${root}/${"x".repeat(4200)}.flac`);
    const [kept] = album(root, "Kept", "Kept", 1);

    if (kept === undefined) throw new Error("one track");

    const endless = musicTrack(`${root}/Kept/Kept/endless.flac`, 1, 1, {
      artist: "Kept",
      album: "Kept",
      durationMs: 1e20,
    });

    expect(await upsert(stack, lease, [long, kept, endless])).toMatchObject({ value: { done: 3 } });
    expect(await expectExact(stack, libraryId)).toMatchObject({
      tracks: 2,
      durationMs: kept.durationMs + 2 ** 32,
    });
    expect(await refusal(upsert(stack, lease, [musicTrack("/elsewhere/a.flac")]))).toMatch(
      /not a path inside/u,
    );

    await finishScan(stack, lease);
  });

  it("refuse a person's session, and change no row", async () => {
    if (stack === undefined) return;
    const admin = await member(stack, "guard-admin", "admin");
    const { libraryId, lease, root } = await heldScan(stack, admin, "Guarded");

    await upsertAll(stack, lease, album(root, "Guard", "Guard", 3));

    const before = await totalsOf(stack, libraryId);

    const asPerson = (tracks: ReadonlyArray<ScannedTrack>) =>
      runServerAs(
        stack,
        admin.signedIn,
        api.music.scanner.upsert,
        { lease, tracks: [...tracks] },
        Written,
      );

    expect(await refusal(asPerson(album(root, "Guard", "More", 3)))).toBe("forbidden");
    expect(
      await refusal(
        runServerAs(
          stack,
          admin.signedIn,
          api.music.art.inUse,
          { hashes: [] },
          Schema.Struct({ inUse: Schema.Array(Schema.String) }),
        ),
      ),
    ).toBe("forbidden");
    expect(await totalsOf(stack, libraryId)).toEqual(before);

    await finishScan(stack, lease);
  });

  it("refuse every write after the scan's lease was released", async () => {
    if (stack === undefined) return;
    const admin = await member(stack, "stale-admin", "admin");
    const { libraryId, lease, root } = await heldScan(stack, admin, "Stale");
    const tracks = album(root, "Late", "Late", 2);

    await upsertAll(stack, lease, tracks.slice(0, 1));
    await finishScan(stack, lease);

    const stale: Lease = lease;

    expect((await upsert(stack, stale, tracks.slice(1))).outcome).not.toBe("held");
    expect((await markMissing(stack, stale, [first(tracks).path])).outcome).not.toBe("held");
    expect(await expectExact(stack, libraryId)).toMatchObject({ tracks: 1 });
  });
});
