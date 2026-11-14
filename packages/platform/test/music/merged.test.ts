import { describe, expect, it } from "vitest";

import { api } from "../../convex/_generated/api";
import { logMark, usageSince } from "../admin";
import type { CallUsage } from "../admin";
import { member, sharedAdmin } from "../devices";
import { seedLibraries, share, shareThroughEveryGroup } from "../probe";
import type { MusicLibrary } from "../probe";
import { refusal, unique } from "../sign-in";
import { coreStackFromEnvFile } from "../stack-env";
import { claimScan, finishScan, markMissingAll, musicLibrary, upsertAll } from "./catalog";
import { musicTrack } from "./scanned";
import { at, onAlbum } from "./shelf";
import type { Page } from "./shelf";

const stack = coreStackFromEnvFile();

/** Libraries the person sees, each through their own grant and each of sixteen groups. */
const LIBRARIES = 40;

/** Songs of each seeded library; the last of each shares one title across every library. */
const SONGS = 6;

/** A small page, so the list takes many pages and each merges many libraries. */
const PAGE = 9;

const pad = (n: number): string => String(n).padStart(4, "0");

const withinLimits = (usage: ReadonlyArray<CallUsage>): boolean =>
  usage.length > 0 &&
  usage.every(
    (call) =>
      call.committed &&
      call.reads < 32_000 &&
      call.bytes < 16 * 1024 * 1024 &&
      call.writes < 16_000,
  );

/** Every page of a list from the start, calling `between` after each, and every page read. */
const pagesWith = async <Row>(
  read: (cursor: string | null) => Promise<Page<Row>>,
  between: (pages: number) => Promise<void>,
  cursor: string | null = null,
  pages: ReadonlyArray<Page<Row>> = [],
): Promise<ReadonlyArray<Page<Row>>> => {
  const page = await read(cursor);
  const seen = [...pages, page];

  if (page.isDone) return seen;

  await between(seen.length);

  return pagesWith(read, between, page.continueCursor, seen);
};

describe.skipIf(stack === undefined)(
  "music lists merged across libraries",
  { timeout: 300_000 },
  () => {
    it("pages songs, albums, and artists across a person's libraries, each row once in order, while songs come and go", async () => {
      if (stack === undefined) return;
      const admin = await sharedAdmin(stack);

      const [manager, viewer] = await Promise.all([
        member(stack, "merge-manager"),
        member(stack, "merge-viewer"),
      ]);

      const prefix = `Merge ${unique()}`;
      const title = (k: number, what = ""): string => `${prefix} ${pad(k)}${what}`;

      // Song j of library i is title j * 40 + i, so neighbouring titles come from different
      // libraries and every page merges many; each library's last song has one title they share.
      const seeded = await seedLibraries(
        stack,
        manager,
        Array.from({ length: LIBRARIES }, (_, i): MusicLibrary => ({
          name: `${prefix} ${i}`,
          kind: "music",
          items: Array.from({ length: SONGS }, (_song, j) =>
            onAlbum(`${prefix} album`, j === SONGS - 1 ? title(9000) : title(j * LIBRARIES + i)),
          ),
        })),
      );

      await shareThroughEveryGroup(
        admin,
        manager,
        viewer,
        seeded.map((library) => library.libraryId),
      );

      // One more library the scanner writes into while the person pages.
      const live = await musicLibrary(admin, `${prefix} live`);
      const root = at(live.roots, 0);
      const lease = await claimScan(stack, live.scanJobId, 300_000);

      const file = (name: string) =>
        musicTrack(`${root}/Live/${name}.flac`, 1000, 1, { title: name, album: `${prefix} live` });

      await upsertAll(
        stack,
        lease,
        Array.from({ length: 20 }, (_, n) => file(title(10 * n + 5, " live"))),
      );
      await share(admin, live.libraryId, { kind: "user", userId: viewer.userId }, "view");

      const doomed = [title(105, " live"), title(115, " live"), title(185, " live")];
      const early = [title(0, " early"), title(1, " early")];
      const late = [title(230, " late"), title(231, " late"), title(8999, " late")];

      // After the second page the scanner adds songs before the cursor and after it, and removes
      // two not yet reached; after the tenth it removes one more and adds one past it.
      const churn = async (pages: number): Promise<void> => {
        if (pages === 2) {
          await upsertAll(
            stack,
            lease,
            [...early, ...late.slice(0, 2)].map((name) => file(name)),
          );
          await markMissingAll(
            stack,
            lease,
            doomed.slice(0, 2).map((name) => `${root}/Live/${name}.flac`),
          );
        }

        if (pages === 10) {
          await upsertAll(stack, lease, [file(at(late, 2))]);
          await markMissingAll(stack, lease, [`${root}/Live/${at(doomed, 2)}.flac`]);
        }
      };

      const mark = await logMark(stack);

      const pages = await pagesWith(
        (cursor) =>
          viewer.signedIn.client.query(api.music.tracks.list, {
            paginationOpts: { numItems: PAGE, cursor },
          }),
        churn,
      );

      await finishScan(stack, lease);

      const ours = pages
        .flatMap((page) => page.page)
        .filter((track) => track.title.startsWith(prefix));

      const titles = ours.map((track) => track.title);

      const expected = [
        ...seeded.flatMap((_, i) =>
          Array.from({ length: SONGS - 1 }, (__, j) => title(j * LIBRARIES + i)),
        ),
        ...Array.from({ length: LIBRARIES }, () => title(9000)),
        ...Array.from({ length: 20 }, (_, n) => title(10 * n + 5, " live")).filter(
          (name) => !doomed.includes(name),
        ),
        ...late,
      ];

      expect(new Set(ours.map((track) => track.id)).size).toBe(ours.length);
      expect(titles.toSorted()).toEqual(expected.toSorted());
      expect(titles.map((name) => name.toLowerCase())).toEqual(
        titles.map((name) => name.toLowerCase()).toSorted(),
      );
      expect(pages.slice(0, -1).every((page) => page.page.length === PAGE)).toBe(true);
      expect(withinLimits(await usageSince(stack, mark, api.music.tracks.list, pages.length))).toBe(
        true,
      );

      const albums = await pagesWith(
        (cursor) =>
          viewer.signedIn.client.query(api.music.albums.list, {
            paginationOpts: { numItems: PAGE, cursor },
          }),
        async () => undefined,
      );

      const ourAlbums = albums
        .flatMap((page) => page.page)
        .filter((album) => album.title.startsWith(prefix));

      expect(new Set(ourAlbums.map((album) => album.id)).size).toBe(LIBRARIES + 1);
      expect(ourAlbums).toHaveLength(LIBRARIES + 1);

      // Every seeded library has its own `Seed Artist`, so 40 artists tie on one name.
      const artists = await pagesWith(
        (cursor) =>
          viewer.signedIn.client.query(api.music.artists.list, {
            paginationOpts: { numItems: PAGE, cursor },
          }),
        async () => undefined,
      );

      const seedArtists = artists
        .flatMap((page) => page.page)
        .filter((artist) => artist.name === "Seed Artist");

      expect(new Set(seedArtists.map((artist) => artist.id)).size).toBe(seedArtists.length);
      expect(seedArtists.length).toBeGreaterThanOrEqual(LIBRARIES);
    });

    it("refuses a cursor that did not come from the list", async () => {
      if (stack === undefined) return;
      const viewer = await member(stack, "cursor-viewer");

      const first = await viewer.signedIn.client.query(api.music.tracks.list, {
        paginationOpts: { numItems: 1, cursor: null },
      });

      const albumsAt = (cursor: string) =>
        refusal(
          viewer.signedIn.client.query(api.music.albums.list, {
            paginationOpts: { numItems: 5, cursor },
          }),
        );

      expect(await albumsAt("not a cursor")).toBe("invalid_args");

      // A song's cursor holds a title where an album's holds a time.
      if (first.page.length > 0) expect(await albumsAt(first.continueCursor)).toBe("invalid_args");
    });
  },
);
