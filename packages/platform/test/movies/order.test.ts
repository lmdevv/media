import { setTimeout as sleep } from "node:timers/promises";

import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { api, internal } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { inOrder } from "../../convex/core/lib/inOrder";
import { runFunction } from "../admin";
import { member } from "../devices";
import type { Member } from "../devices";
import { movie, seedLibraries, seedLibrary, share, show, song } from "../probe";
import { unique } from "../sign-in";
import { coreStackFromEnvFile } from "../stack-env";
import type { CoreStack } from "../stack-env";
import { seasonOf } from "./shelf";

const stack = coreStackFromEnvFile();

const ProgressOrder = Schema.Struct({
  rows: Schema.Finite,
  lastEpisodeId: Schema.NullOr(Schema.String),
});

// SAFETY: a type predicate, not checked by the compiler. A Convex id is an opaque string, and the
// stack stored these through a `v.id(...)` validator, which checks each again when sent back.
const isId =
  <Table extends "users" | "titles">(_table: Table) =>
  (value: unknown): value is Id<Table> =>
    Schema.is(Schema.String)(value);

/** The arguments of a page of marking a whole show, as Convex stored them for `markRest`. */
const MarkPage = Schema.fromJsonString(
  Schema.Tuple([
    Schema.Struct({
      userId: Schema.declare(isId("users")),
      titleId: Schema.declare(isId("titles")),
      watched: Schema.Boolean,
      at: Schema.Finite,
      generation: Schema.Finite,
      cursor: Schema.String,
    }),
  ]),
);

const ScheduledMarks = Schema.Array(Schema.Struct({ state: Schema.String, args: MarkPage }));

/** The pages scheduled for marking `titleId`, newest first. */
const markPagesOf = async (core: CoreStack, titleId: Id<"titles">) =>
  (await runFunction(core, internal.movies.historyProbe.scheduledMarks, {}, ScheduledMarks)).filter(
    ({ args: [page] }) => page.titleId === titleId,
  );

const byCodeUnits = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

/** Every title `who` lists, in the list's order, a page at a time. */
const listAll = async (
  who: Member,
  sort: "name" | "added" | "year",
  genre: string,
  cursor: string | null = null,
  titles: ReadonlyArray<{ readonly id: string; readonly name: string }> = [],
): Promise<ReadonlyArray<{ readonly id: string; readonly name: string }>> => {
  const page = await who.signedIn.client.query(api.movies.titles.list, {
    paginationOpts: { numItems: 100, cursor },
    sort,
    genre,
  });

  const next = [...titles, ...page.page.map(({ id, name }) => ({ id, name }))];

  return page.isDone ? next : listAll(who, sort, genre, page.continueCursor, next);
};

const progressOrder = (core: CoreStack, userId: Id<"users">, titleId: Id<"titles">) =>
  runFunction(core, internal.movies.probe.progressOrder, { userId, titleId }, ProgressOrder);

const waitForRows = async (
  core: CoreStack,
  userId: Id<"users">,
  titleId: Id<"titles">,
  rows: number,
  deadline = Date.now() + 60_000,
): Promise<typeof ProgressOrder.Type> => {
  const order = await progressOrder(core, userId, titleId);

  if (order.rows === rows) return order;

  if (Date.now() > deadline) throw new Error(`${order.rows} progress rows, not ${rows}`);

  await sleep(250);

  return waitForRows(core, userId, titleId, rows, deadline);
};

describe.skipIf(stack === undefined)("movies lists across libraries", { timeout: 240_000 }, () => {
  it("show the newest movies however many music libraries are shared first", async () => {
    if (stack === undefined) return;

    const label = unique();
    const manager = await member(stack, "shelves-manager");
    const viewer = await member(stack, "shelves-viewer");

    const music = await seedLibraries(
      stack,
      manager,
      Array.from({ length: 140 }, (_, n) => ({
        name: `tunes ${label} ${n}`,
        kind: "music" as const,
        items: [song(`song ${n}`, false)],
      })),
    );

    const films = await seedLibraries(
      stack,
      manager,
      Array.from({ length: 10 }, (_, n) => ({
        name: `films ${label} ${n}`,
        kind: "movies" as const,
        items: [movie(`Gem ${label} ${n}`, 0)],
      })),
    );

    const musicIds = music.map((library) => library.libraryId).toSorted(byCodeUnits);

    const film = films.find(
      (library) => musicIds.filter((id) => byCodeUnits(id, library.libraryId) < 0).length >= 64,
    );

    if (film === undefined) throw new Error("no movies library sorts after 64 music libraries");

    const before = musicIds.filter((id) => byCodeUnits(id, film.libraryId) < 0).slice(0, 64);
    const principal = { kind: "user", userId: viewer.userId } as const;

    await inOrder([...before, film.libraryId], async (libraryId) =>
      share(manager, libraryId, principal, "view"),
    );

    const [titleId] = film.itemIds;
    const home = await viewer.signedIn.client.query(api.movies.titles.home, {});

    expect(home.recentlyAddedMovies.map((title) => title.id)).toContain(titleId);
  });

  it("sort the title list across libraries, not one library after another", async () => {
    if (stack === undefined) return;

    const label = unique();
    const viewer = await member(stack, "sorted-viewer");

    const [first, second] = await seedLibraries(stack, viewer, [
      {
        name: `sorted ${label} a`,
        kind: "movies",
        items: [{ ...movie(`Mike ${label}`, 0), genres: [label] }],
      },
      {
        name: `sorted ${label} b`,
        kind: "movies",
        items: [
          { ...movie(`Alpha ${label}`, 0), genres: [label] },
          { ...movie(`Zulu ${label}`, 0), genres: [label] },
        ],
      },
    ]);

    const ours = new Set<string>([...(first?.itemIds ?? []), ...(second?.itemIds ?? [])]);
    const listed = await listAll(viewer, "name", label);

    expect(listed.filter((title) => ours.has(title.id)).map((title) => title.name)).toEqual([
      `Alpha ${label}`,
      `Mike ${label}`,
      `Zulu ${label}`,
    ]);
  });

  it("list every episode of a long season, a page at a time", async () => {
    if (stack === undefined) return;

    const viewer = await member(stack, "season-viewer");

    const seeded = await seedLibrary(stack, viewer, {
      name: `season ${unique()}`,
      kind: "movies",
      items: [show("Long Season", 0, 501)],
    });

    const [titleId] = seeded.itemIds;

    if (titleId === undefined) throw new Error("no show seeded");

    const episodes = await seasonOf(viewer.signedIn.client, titleId, 1);

    expect(episodes.map((episode) => episode.episodeNumber)).toEqual(
      Array.from({ length: 501 }, (_, n) => n + 1),
    );
  });

  it("resume a show at the episode played last, past a thousand progress rows", async () => {
    if (stack === undefined) return;

    const viewer = await member(stack, "progress-viewer");

    const seeded = await seedLibrary(stack, viewer, {
      name: `progress ${unique()}`,
      kind: "movies",
      items: [show("Very Long Show", 0, 1001)],
    });

    const [titleId] = seeded.itemIds;

    if (titleId === undefined) throw new Error("no show seeded");

    const client = viewer.signedIn.client;

    await client.mutation(api.movies.history.markWatched, { titleId });

    const order = await waitForRows(stack, viewer.userId, titleId, 1001);
    const episodeId = seeded.episodeIds[0]?.find((id) => id === order.lastEpisodeId);

    if (episodeId === undefined) throw new Error("the last progress row names no seeded episode");

    const started = await client.mutation(api.movies.play.start, { titleId, episodeId });

    await client.mutation(api.movies.play.report, {
      fileId: started.file.id,
      positionMs: 60_000,
      durationMs: 600_000,
      event: "pause",
      startedAt: started.startedAt,
      playbackId: started.playbackId,
    });

    const detail = await client.query(api.movies.titles.get, { titleId });

    expect(detail.nextEpisode?.id).toBe(episodeId);
  });

  it("drop a scheduled page of marking a show once a newer mark moved its history", async () => {
    if (stack === undefined) return;

    const viewer = await member(stack, "fence-viewer");

    const seeded = await seedLibrary(stack, viewer, {
      name: `fence ${unique()}`,
      kind: "movies",
      items: [show("Fenced Show", 0, 501)],
    });

    const [titleId] = seeded.itemIds;

    if (titleId === undefined) throw new Error("no show seeded");

    const client = viewer.signedIn.client;

    await client.mutation(api.movies.history.markWatched, { titleId });
    await waitForRows(stack, viewer.userId, titleId, 501);

    const [watchedPage] = (await markPagesOf(stack, titleId)).map(({ args: [page] }) => page);

    expect(watchedPage).toMatchObject({ watched: true });

    await client.mutation(api.movies.history.markUnwatched, { titleId });
    await waitForRows(stack, viewer.userId, titleId, 0);

    if (watchedPage === undefined) throw new Error("no page scheduled");

    // The watched mark's second page, delivered late: the unwatched mark superseded it.
    await runFunction(stack, internal.movies.history.markRest, watchedPage, Schema.Null);

    expect((await progressOrder(stack, viewer.userId, titleId)).rows).toBe(0);
  });
});
