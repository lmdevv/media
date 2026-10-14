/**
 * Paginated lists: albums, artists, and songs page over the libraries the viewer reads, and liked
 * songs page too, against convex-test.
 */
import type { TrackId } from "@music/commands/ids";
import { describe, expect, it } from "vitest";

import { libraryQueries } from "../convex/handlers/library";
import { compareText } from "../convex/lib/pages";
import { loadViewer } from "../convex/lib/viewer";
import { allTracks, makeBackend, seedLibrary, signUp, trackIds, upsertFiles } from "./backend";
import type { User } from "./backend";

interface Page<Item> {
  readonly items: ReadonlyArray<Item>;
  readonly cursor: string;
  readonly done: boolean;
}

/** Every page of a list, in order. */
const pages = async <Item>(
  read: (cursor: string | null) => Promise<Page<Item>>,
): Promise<ReadonlyArray<ReadonlyArray<Item>>> => {
  const collect = async (
    cursor: string | null,
    seen: ReadonlyArray<ReadonlyArray<Item>>,
  ): Promise<ReadonlyArray<ReadonlyArray<Item>>> => {
    const page = await read(cursor);
    const all = [...seen, page.items];

    return page.done ? all : collect(page.cursor, all);
  };

  return collect(null, []);
};

/** Songs with repeated titles, in a folder of their own. */
const files = (prefix: string) =>
  ["Intro", "Intro", "Outro", "Intro", "Bridge"].map((title, index) => ({
    path: `${prefix}/${index}.flac`,
    title,
  }));

const titles = (user: User, limit: number) =>
  pages((cursor) => user.music.read("tracks.list", { cursor, limit })).then((all) =>
    all.map((page) => page.map((track) => track.title)),
  );

/** A member, and an admin with a small shared library between two large private ones. */
const setup = async () => {
  const backend = makeBackend();
  const admin = await signUp(backend, "admin");
  const member = await signUp(backend, "member");

  // The admin's private library sorts before and after the shared one, by title and by date.
  await seedLibrary(backend, admin, { name: "Aaa", count: 150, visibility: "private" });
  await seedLibrary(backend, admin, { name: "Shared", count: 12 });
  await seedLibrary(backend, admin, { name: "Zzz", count: 150, visibility: "private" });

  return { backend, admin, member };
};

describe("lists for a member who reads only part of the catalog", () => {
  it("pages through only the readable songs, with no empty pages", async () => {
    const { member } = await setup();
    const all = await titles(member, 5);

    expect(all.map((page) => page.length)).toEqual([5, 5, 2]);
    expect(all.flat()).toEqual(
      Array.from({ length: 12 }, (_, index) => `Shared ${String(index + 1).padStart(4, "0")}`),
    );
  });

  it("reads only the readable libraries' rows for a page", async () => {
    const { member } = await setup();

    const read = await member.as.query(async (ctx) => {
      const viewer = await loadViewer(ctx);
      const before = (await ctx.meta.getTransactionMetrics()).documentsRead.used;
      await libraryQueries["tracks.list"](ctx, viewer, { limit: 5 });

      return (await ctx.meta.getTransactionMetrics()).documentsRead.used - before;
    });

    // The library list, the page's songs and one more, and their likes: never the 300 others.
    expect(read).toBeLessThan(20);
  });

  it("shows the readable library's albums on Home, past others' newer ones", async () => {
    const { member } = await setup();
    const home = await member.music.read("library.home", {});

    expect(home.recentlyAdded.map((album) => album.title)).toEqual(["Shared Album"]);
  });

  it("pages albums and artists the same way", async () => {
    const { member } = await setup();

    const albums = await pages((cursor) => member.music.read("albums.list", { cursor, limit: 1 }));

    const artists = await pages((cursor) =>
      member.music.read("artists.list", { cursor, limit: 1 }),
    );

    expect(albums.map((page) => page.map((album) => album.title))).toEqual([["Shared Album"]]);
    expect(artists.map((page) => page.map((artist) => artist.name))).toEqual([["Shared Artist"]]);
  });
});

describe("lists for a viewer who reads every library", () => {
  it("merges songs with the same title across libraries without losing or repeating any", async () => {
    const backend = makeBackend();
    const admin = await signUp(backend, "admin");
    const one = await seedLibrary(backend, admin, { name: "One", count: 0 });
    const two = await seedLibrary(backend, admin, { name: "Two", count: 0 });

    await upsertFiles(backend, one.libraryId, files("one"));
    await upsertFiles(backend, two.libraryId, files("two"));

    const everything = (await titles(admin, 200)).flat();

    expect(everything).toEqual([
      "Bridge",
      "Bridge",
      ...Array.from({ length: 6 }, () => "Intro"),
      "Outro",
      "Outro",
    ]);

    const counts = await Promise.all(
      [1, 2, 3, 4, 7].map(async (limit) => {
        const paged = await pages((cursor) => admin.music.read("tracks.list", { cursor, limit }));

        return new Set(paged.flat().map((track) => track.id)).size;
      }),
    );

    expect(counts).toEqual([10, 10, 10, 10, 10]);
  });

  it("keeps a page's range when it gets the next page's cursor, as rows are added", async () => {
    const backend = makeBackend();
    const admin = await signUp(backend, "admin");
    const { libraryId } = await seedLibrary(backend, admin, { name: "Old", count: 0 });

    await upsertFiles(
      backend,
      libraryId,
      ["A", "B", "C", "D", "E", "F"].map((album) => ({ path: `${album}.flac`, album })),
    );

    const first = await admin.music.read("albums.list", { limit: 3 });
    const second = await admin.music.read("albums.list", { cursor: first.cursor, limit: 3 });

    await upsertFiles(backend, libraryId, [{ path: "New.flac", album: "New" }]);

    const firstAgain = await admin.music.read("albums.list", {
      cursor: null,
      end: first.cursor,
      limit: 3,
    });

    const secondAgain = await admin.music.read("albums.list", { cursor: first.cursor, limit: 3 });

    expect([...firstAgain.items, ...secondAgain.items].map((album) => album.title)).toEqual([
      "New",
      ...[...first.items, ...second.items].map((album) => album.title),
    ]);
  });

  it(
    "ends an overgrown page early and says where, so no row is lost",
    { timeout: 60_000 },
    async () => {
      const backend = makeBackend();
      const admin = await signUp(backend, "admin");
      const { libraryId } = await seedLibrary(backend, admin, { name: "Old", count: 0 });

      await upsertFiles(backend, libraryId, [
        { path: "a.flac", album: "A" },
        { path: "b.flac", album: "B" },
      ]);

      const first = await admin.music.read("albums.list", { limit: 1 });

      // A scan adds 1,001 newer albums while the first page is on screen with `end`.
      await Array.from({ length: 11 }, (_, batch) =>
        Array.from({ length: batch === 10 ? 1 : 100 }, (__, index) => {
          const name = `New ${batch * 100 + index}`;

          return { path: `${name}.flac`, album: name };
        }),
      ).reduce(async (previous, batch) => {
        await previous;
        await upsertFiles(backend, libraryId, batch);
      }, Promise.resolve());

      const grown = await admin.music.read("albums.list", { end: first.cursor, limit: 1 });

      expect(grown.items).toHaveLength(1000);
      expect(grown.cursor).not.toBe(first.cursor);

      const between = await admin.music.read("albums.list", {
        cursor: grown.cursor,
        end: first.cursor,
        limit: 1,
      });

      expect(between.cursor).toBe(first.cursor);
      expect([...grown.items, ...between.items].map((album) => album.title)).toContain("B");
      expect(grown.items.length + between.items.length).toBe(1002);
    },
  );

  it("refuses a cursor that is not one of its own", async () => {
    const backend = makeBackend();
    const admin = await signUp(backend, "admin");
    await seedLibrary(backend, admin, { name: "Some", count: 1 });

    await expect(admin.music.read("albums.list", { cursor: "not a cursor" })).rejects.toThrow(
      /cursor/u,
    );
  });
});

describe("liked songs", () => {
  it("pages past a thousand likes, newest first", { timeout: 60_000 }, async () => {
    const backend = makeBackend();
    const admin = await signUp(backend, "admin");
    await seedLibrary(backend, admin, { name: "Many", count: 1100 });
    const many = trackIds(await allTracks(admin), "Many");

    // Liked in title order, straight into the table: 1,100 `likes.set` calls take too long here.
    await backend.run(async (ctx) => {
      await many.reduce(async (previous, trackId) => {
        await previous;
        const id = ctx.db.normalizeId("tracks", trackId);

        if (id !== null) await ctx.db.insert("likes", { userId: admin.id, trackId: id });
      }, Promise.resolve());
    });

    // And one through the command, which lands first.
    const [first] = many;

    if (first === undefined) throw new Error("Seed missing");
    await admin.music.run("likes.set", { trackId: first, liked: false });
    await admin.music.run("likes.set", { trackId: first, liked: true });

    const liked = await pages((cursor) => admin.music.read("likes.page", { cursor, limit: 200 }));
    const ids: ReadonlyArray<TrackId> = liked.flat().map((track) => track.id);

    expect(ids).toHaveLength(1100);
    expect(ids).toEqual([first, ...many.slice(1).toReversed()]);
  });
});

describe("compareText", () => {
  it("orders by code point, as Convex orders index keys", () => {
    // UTF-16 puts the emoji (a surrogate pair from U+D83D) before U+FF01; code points don't.
    expect(["！", "😀"].toSorted()).toEqual(["😀", "！"]);
    expect(compareText("😀", "！")).toBeGreaterThan(0);
    expect(compareText("abc", "abd")).toBeLessThan(0);
    expect(compareText("ab", "abc")).toBeLessThan(0);
    expect(compareText("same", "same")).toBe(0);
  });
});
