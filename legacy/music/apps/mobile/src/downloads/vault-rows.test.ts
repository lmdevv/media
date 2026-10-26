import { DatabaseSync } from "node:sqlite";

import { AlbumId, ArtistId, DeviceId, DownloadPinId, TrackId } from "@music/commands/ids";
import { LyricsRevision } from "@music/commands/lyrics";
import type { OfflineLyrics } from "@music/commands/lyrics";
import { VaultChange } from "@music/sdk/downloads";
import type { NewLyrics, StoredCopy } from "@music/sdk/downloads";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { commitVault, loadVault, prepareVault, readLyrics } from "./vault-rows";
import type { VaultDatabase } from "./vault-rows";

/** Rows as expo-sqlite returns them: the vault stores only text, integers, and nulls. */
const decodeRows = Schema.decodeUnknownSync(
  Schema.Array(
    Schema.Record(Schema.String, Schema.NullOr(Schema.Union([Schema.String, Schema.Finite]))),
  ),
);

/** A real SQLite database in memory, behind the calls expo-sqlite answers. */
const sqlite = () => {
  const raw = new DatabaseSync(":memory:");

  const db = {
    execAsync: async (sql) => {
      raw.exec(sql);
    },
    getAllAsync: async (sql, params) => decodeRows(raw.prepare(sql).all(...params)),
    runAsync: async (sql, params) => raw.prepare(sql).run(...params),
  } satisfies VaultDatabase;

  return { raw, db };
};

/** The tables of a vault made before downloads kept lyrics. */
const BEFORE_LYRICS = `
CREATE TABLE copies (
  track_id TEXT PRIMARY KEY NOT NULL,
  rev TEXT NOT NULL,
  profile TEXT NOT NULL,
  file TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  art_hash TEXT,
  track TEXT NOT NULL
);
CREATE TABLE pins (pin_id TEXT PRIMARY KEY NOT NULL, pin TEXT NOT NULL, members TEXT NOT NULL);
CREATE TABLE art (hash TEXT PRIMARY KEY NOT NULL, file TEXT NOT NULL, bytes INTEGER NOT NULL);
CREATE TABLE removals (target_key TEXT PRIMARY KEY NOT NULL, target TEXT NOT NULL);
`;

const SONG = TrackId.make("t1");

const COPY: StoredCopy = {
  track: {
    id: SONG,
    title: "Unfinished Sympathy",
    artist: "Massive Attack",
    artistId: ArtistId.make("artist"),
    album: "Blue Lines",
    albumId: AlbumId.make("blue-lines"),
    trackNumber: 1,
    discNumber: 1,
    durationMs: 308_000,
    codec: "AAC",
    lossless: false,
    bitrate: 96_000,
    sampleRate: 44_100,
    bitDepth: null,
    artUrl: null,
  },
  rev: "r1",
  profile: "original",
  file: "audio/t1.r1.original.m4a",
  bytes: 1234,
  artHash: null,
};

const SYNCED: OfflineLyrics = {
  _tag: "Synced",
  source: "file",
  main: {
    kind: "main",
    lang: null,
    origin: { _tag: "Sidecar", fileName: "sympathy.lrc", format: "lrc" },
    body: {
      _tag: "Synced",
      lines: [
        { text: "Really hurt", startMs: 12_000, endMs: null, words: null, voice: null },
        { text: "You really hurt me", startMs: 15_500, endMs: 18_000, words: null, voice: "v1" },
      ],
    },
  },
  extras: [],
};

const LYRICS: NewLyrics = {
  trackId: SONG,
  rev: LyricsRevision.make("v1-abc"),
  lyrics: SYNCED,
  bytes: 321,
};

/** How the vault lists `kept`: without the lyrics themselves. */
const listed = ({ trackId, rev, bytes }: NewLyrics) =>
  new Map([[trackId, { trackId, rev, bytes }]]);

describe("the vault's rows", () => {
  it("list the lyrics they keep, read them by song, and keep them no more once deleted", async () => {
    const { db } = sqlite();
    await prepareVault(db);

    await commitVault(db, VaultChange.PutLyrics({ lyrics: [LYRICS] }));
    expect((await loadVault(db)).lyrics).toEqual(listed(LYRICS));
    expect(await readLyrics(db, SONG)).toEqual({ rev: LYRICS.rev, lyrics: SYNCED });

    const newer = { ...LYRICS, rev: LyricsRevision.make("v1-def") };
    await commitVault(db, VaultChange.PutLyrics({ lyrics: [newer] }));
    expect((await loadVault(db)).lyrics).toEqual(listed(newer));
    expect(await readLyrics(db, SONG)).toEqual({ rev: newer.rev, lyrics: SYNCED });

    await commitVault(db, VaultChange.DeleteLyrics({ trackIds: [SONG] }));
    expect((await loadVault(db)).lyrics.size).toBe(0);
    expect(await readLyrics(db, SONG)).toBeNull();
  });

  it("write and delete many songs' lyrics at once", async () => {
    const { db } = sqlite();
    await prepareVault(db);

    const many = Array.from({ length: 250 }, (_, index) => ({
      ...LYRICS,
      trackId: TrackId.make(`t${String(index)}`),
    }));

    await commitVault(db, VaultChange.PutLyrics({ lyrics: many }));
    expect((await loadVault(db)).lyrics.size).toBe(250);

    await commitVault(
      db,
      VaultChange.DeleteLyrics({ trackIds: many.slice(1).map(({ trackId }) => trackId) }),
    );
    expect([...(await loadVault(db)).lyrics.keys()]).toEqual([TrackId.make("t0")]);
  });

  it("gain a lyrics table in a vault made before it, keeping what it held", async () => {
    const { db, raw } = sqlite();
    raw.exec(BEFORE_LYRICS);
    await commitVault(db, VaultChange.PutCopy({ copy: COPY }));

    await prepareVault(db);
    await commitVault(db, VaultChange.PutLyrics({ lyrics: [LYRICS] }));
    const rows = await loadVault(db);

    expect(rows.copies).toEqual(new Map([[SONG, COPY]]));
    expect(rows.lyrics).toEqual(listed(LYRICS));
  });

  it("delete lyrics that no longer read as lyrics once read, and keep the rest", async () => {
    const { db, raw } = sqlite();
    await prepareVault(db);
    await commitVault(db, VaultChange.PutLyrics({ lyrics: [LYRICS] }));

    raw
      .prepare("INSERT INTO lyrics (track_id, rev, lyrics, bytes) VALUES (?, ?, ?, ?)")
      .run("t2", "v1-xyz", JSON.stringify({ _tag: "Synced", lines: "not lines" }), 10);

    expect(await readLyrics(db, TrackId.make("t2"))).toBeNull();
    expect(raw.prepare("SELECT track_id FROM lyrics").all()).toEqual([{ track_id: "t1" }]);
    expect(await readLyrics(db, SONG)).toEqual({ rev: LYRICS.rev, lyrics: SYNCED });
  });

  it("drop a lyrics listing that no longer reads", async () => {
    const { db, raw } = sqlite();
    await prepareVault(db);
    await commitVault(db, VaultChange.PutLyrics({ lyrics: [LYRICS] }));

    raw
      .prepare("INSERT INTO lyrics (track_id, rev, lyrics, bytes) VALUES (?, ?, ?, ?)")
      .run("t2", "", "{}", 10);

    expect([...(await loadVault(db)).lyrics.keys()]).toEqual([SONG]);
    expect(raw.prepare("SELECT track_id FROM lyrics").all()).toEqual([{ track_id: "t1" }]);
  });

  it("keep pins, copies, and removals as before", async () => {
    const { db } = sqlite();
    await prepareVault(db);
    const pinId = DownloadPinId.make("pin");
    const target = { kind: "album", id: AlbumId.make("blue-lines") } as const;

    await commitVault(db, VaultChange.PutCopy({ copy: COPY }));
    await commitVault(
      db,
      VaultChange.PutPin({
        pin: {
          pin: {
            id: pinId,
            deviceId: DeviceId.make("phone"),
            target,
            createdAt: 1,
            available: false,
          },
          members: [{ trackId: SONG, state: "fetchable" }],
        },
      }),
    );
    await commitVault(db, VaultChange.PutRemoval({ key: "album:blue-lines", target }));
    const rows = await loadVault(db);

    expect(rows.copies.get(SONG)).toEqual(COPY);
    expect(rows.pins.get(pinId)?.members).toEqual([{ trackId: SONG, state: "fetchable" }]);
    expect(rows.removals.get("album:blue-lines")).toEqual(target);
  });
});
