import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import type { ConvexHttpClient } from "convex/browser";
import type { FunctionReturnType } from "convex/server";
import { Schema } from "effect";
import { beforeAll, describe, expect, it } from "vitest";

import { api, internal } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { logMark, runFunction, usageSince } from "../admin";
import { member } from "../devices";
import type { Member } from "../devices";
import { makeTree } from "../core/libraries/files";
import { seedLibrary, show } from "../probe";
import { refusal } from "../sign-in";
import { coreStackFromEnvFile } from "../stack-env";
import { claimJob, finishJob, moviesLibrary, upsert, upsertAll } from "./catalog";
import type { Lease } from "./catalog";
import {
  advance,
  ensureLibrary,
  scansPending,
  startImport,
  writeAllWatch,
  writeCollections,
  writeEdits,
  writeWatch,
} from "./importing";
import type { Checkpoint } from "./importing";
import { movieFile, scannedTitle } from "./scanned";
import { fileIn, shelfOf, titleIn } from "./shelf";
import type { Shelf } from "./shelf";

const stack = coreStackFromEnvFile();

/** Convex's per-call limits (ADR 0013). */
const READS_MAX = 32_000;

const WRITES_MAX = 16_000;

const BYTES_MAX = 16 * 1024 * 1024;

const LIBRARIES: Checkpoint = { phase: "libraries", unit: 0, cursor: 0 };

const START: Checkpoint = { phase: "watchState", unit: 0, cursor: 0 };

const label = (what: string): string => `${what}-${Math.random().toString(36).slice(2, 8)}`;

type Run = FunctionReturnType<typeof api.movies.imports.get>;

const EpisodeState = Schema.Struct({
  episodeId: Schema.declare(
    // SAFETY: a type predicate, not checked by the compiler. The stack answered this id through
    // `v.id("episodes")`, which checks it again whenever a test sends it back.
    (value: unknown): value is Id<"episodes"> => Schema.is(Schema.String)(value),
  ),
  watched: Schema.NullOr(Schema.Boolean),
  positionMs: Schema.NullOr(Schema.Finite),
  generation: Schema.Finite,
});

const MarkPage = Schema.fromJsonString(
  Schema.Tuple([
    Schema.Struct({
      userId: Schema.declare(
        // SAFETY: a type predicate, not checked by the compiler. Convex stored this id through
        // `v.id("users")`, which checks it again when the page is sent back.
        (value: unknown): value is Id<"users"> => Schema.is(Schema.String)(value),
      ),
      titleId: Schema.declare(
        // SAFETY: as above, for `v.id("titles")`.
        (value: unknown): value is Id<"titles"> => Schema.is(Schema.String)(value),
      ),
      watched: Schema.Boolean,
      at: Schema.Finite,
      generation: Schema.Finite,
      cursor: Schema.String,
    }),
  ]),
);

/** The pages scheduled for marking `titleId`, newest first. */
const markPagesOf = async (titleId: Id<"titles">) =>
  stack === undefined
    ? []
    : (
        await runFunction(
          stack,
          internal.movies.historyProbe.scheduledMarks,
          {},
          Schema.Array(Schema.Struct({ state: Schema.String, args: MarkPage })),
        )
      ).filter(({ args: [page] }) => page.titleId === titleId);

/** Waits until `check` answers something, for up to a minute. */
const eventually = async <Value>(
  check: () => Promise<Value | undefined>,
  deadline = Date.now() + 60_000,
): Promise<Value> => {
  const found = await check();

  if (found !== undefined) return found;

  if (Date.now() > deadline) throw new Error("Timed out");

  await sleep(250);

  return eventually(check, deadline);
};

const runOf = (who: Member, importId: Id<"imports">): Promise<Run> =>
  who.signedIn.client.query(api.movies.imports.get, { importId });

const historyOf = async (client: ConvexHttpClient) =>
  (
    await client.query(api.movies.history.list, {
      paginationOpts: { numItems: 100, cursor: null },
    })
  ).page.map((entry) => ({
    name: entry.episode?.name ?? entry.title.name,
    watched: entry.progress.watched,
    positionMs: entry.progress.positionMs,
  }));

const listOf = async (client: ConvexHttpClient) =>
  (
    await client.query(api.movies.myList.list, { paginationOpts: { numItems: 100, cursor: null } })
  ).page
    .map((title) => title.name)
    .toSorted();

type Collection = FunctionReturnType<typeof api.movies.collections.list>["page"][number];

const collectionNamed = async (
  client: ConvexHttpClient,
  name: string,
  cursor: string | null = null,
): Promise<Collection | null> => {
  const page = await client.query(api.movies.collections.list, {
    paginationOpts: { numItems: 20, cursor },
  });

  const found = page.page.find((collection) => collection.name === name);

  if (found !== undefined) return found;

  return page.isDone ? null : collectionNamed(client, name, page.continueCursor);
};

const held = <Value>(answer: { readonly outcome: string; readonly value?: Value }): Value => {
  if (answer.outcome !== "held" || answer.value === undefined) {
    throw new Error(`The import call answered ${answer.outcome}`);
  }

  return answer.value;
};

const play = async (who: Member, titleId: Id<"titles">, positionMs: number) => {
  const started = await who.signedIn.client.mutation(api.movies.play.start, { titleId });

  await who.signedIn.client.mutation(api.movies.play.report, {
    fileId: started.file.id,
    positionMs,
    event: "tick",
    playbackId: started.playbackId,
    startedAt: started.startedAt,
  });
};

describe.skipIf(stack === undefined)("the Jellyfin and Plex importer", { timeout: 300_000 }, () => {
  let shelf: Shelf;

  beforeAll(async () => {
    if (stack === undefined) return;

    shelf = await shelfOf(stack, label("import"));
  }, 180_000);

  const watchItem = (
    who: Member,
    name: string,
    values: Partial<{
      /** A show's own state: a favorite, with no file. */
      readonly show: boolean;
      readonly watched: boolean;
      readonly positionMs: number;
      readonly lastPlayedAt: number | null;
      readonly favorite: boolean;
    }>,
  ) => ({
    userId: who.userId,
    titleId: titleIn(shelf, name),
    episodeId: null,
    fileId: values.show === true ? null : fileIn(shelf, name),
    watched: values.watched ?? false,
    positionMs: values.positionMs ?? 0,
    playCount: 0,
    lastPlayedAt: values.lastPlayedAt ?? null,
    favorite: values.favorite ?? false,
  });

  it("start only for an owner or an admin, and join an import of the server already running", async () => {
    if (stack === undefined) return;

    const serverId = label("den");
    const users = [{ sourceUserId: "a", userId: shelf.aiko.userId, history: "full" as const }];

    expect(await refusal(startImport(stack, shelf.aiko, { serverId, users }))).toBe("forbidden");

    const first = await startImport(stack, shelf.owner, { serverId, users });
    const again = await startImport(stack, shelf.outsider, { serverId, users });
    const other = await startImport(stack, shelf.owner, { serverId: label("other"), users });

    expect(first.created).toBe(true);
    expect(again).toEqual({ ...first, created: false });
    expect(other.jobId).not.toBe(first.jobId);

    expect(await refusal(runOf(shelf.aiko, first.importId))).toBe("forbidden");

    expect(await runOf(shelf.owner, first.importId)).toMatchObject({
      importId: first.importId,
      phase: "libraries",
      users: 1,
      job: { jobId: first.jobId, status: "queued" },
    });

    const listed = await shelf.owner.signedIn.client.query(api.movies.imports.list, {
      paginationOpts: { numItems: 10, cursor: null },
    });

    expect(listed.page.map((run) => run.importId)).toContain(first.importId);

    const lease = await claimJob(stack, "movies.import.jellyfin", first.jobId);

    expect(await startImport(stack, shelf.owner, { serverId, users })).toEqual(again);

    await finishJob(stack, lease);

    const next = await startImport(stack, shelf.owner, { serverId, users });

    expect(next.created).toBe(true);
    expect(next.importId).not.toBe(first.importId);

    await Promise.all(
      [next.jobId, other.jobId].map(async (jobId) =>
        runFunction(stack, internal.core.jobs.admin.cancel, { jobId }, Schema.Unknown),
      ),
    );
  });

  it("write each mapped user's progress, history, and list, keep newer progress, and resume from the checkpoint", async () => {
    if (stack === undefined) return;

    const { aiko, mateo, sam, owner } = shelf;
    const serverId = label("watch");
    const yesterday = Date.now() - 24 * 60 * 60 * 1000;

    await play(aiko, titleIn(shelf, "Sintel"), 100_000);

    const started = await startImport(stack, owner, {
      serverId,
      users: [
        { sourceUserId: "aiko", userId: aiko.userId, history: "full" },
        { sourceUserId: "mateo", userId: mateo.userId, history: "full" },
      ],
    });

    const lease = await claimJob(stack, "movies.import.jellyfin", started.jobId);

    held(await advance(stack, lease, LIBRARIES, START));

    const items = [
      watchItem(aiko, "Big Buck Bunny", { watched: true, lastPlayedAt: yesterday, favorite: true }),
      watchItem(aiko, "Sintel", { positionMs: 5_000, lastPlayedAt: yesterday }),
      watchItem(aiko, "Pioneer One", { show: true, favorite: true }),
      watchItem(mateo, "Tears of Steel", { positionMs: 60_000, lastPlayedAt: yesterday }),
      watchItem(sam, "Big Buck Bunny", { watched: true, lastPlayedAt: yesterday, favorite: true }),
    ];

    const wrote = held(await writeWatch(stack, lease, START, items, 3));

    expect(wrote).toMatchObject({ done: 5, at: { ...START, cursor: 5 } });

    expect(held(await writeWatch(stack, lease, START, items))).toMatchObject({
      done: 0,
      at: wrote.at,
    });

    expect(await historyOf(aiko.signedIn.client)).toEqual(
      expect.arrayContaining([
        { name: "Big Buck Bunny", watched: true, positionMs: 0 },
        { name: "Sintel", watched: false, positionMs: 100_000 },
      ]),
    );
    expect(await listOf(aiko.signedIn.client)).toEqual(["Big Buck Bunny", "Pioneer One"]);
    expect(await historyOf(mateo.signedIn.client)).toEqual([
      { name: "Tears of Steel", watched: false, positionMs: 60_000 },
    ]);
    expect(await historyOf(sam.signedIn.client)).toEqual([]);
    expect(await listOf(sam.signedIn.client)).toEqual([]);

    expect((await runOf(owner, started.importId)).imported).toEqual({
      librariesAdded: 0,
      watched: 1,
      inProgress: 1,
      favorites: 2,
      collections: 0,
      overrides: 0,
      keptLocal: 1,
      unmatched: 3,
    });

    const boxKey = `jellyfin:${serverId}:box`;
    const boxName = label("Fixture Box");

    const atCollections = held(
      await advance(stack, lease, wrote.at, { ...START, phase: "collections" }),
    ).at;

    const box = (names: ReadonlyArray<string>) => ({
      sourceKey: boxKey,
      name: boxName,
      sortName: null,
      titleIds: names.map((name) => titleIn(shelf, name)),
    });

    const collected = held(
      await writeCollections(stack, lease, atCollections, [box(["Sintel", "Big Buck Bunny"])]),
    );

    expect(collected).toMatchObject({ done: 1, at: { ...atCollections, cursor: 1 } });

    const atEdits = held(
      await advance(stack, lease, collected.at, { phase: "overrides", unit: 0, cursor: 0 }),
    ).at;

    const edited = held(
      await writeEdits(stack, lease, atEdits, [
        {
          titleId: titleIn(shelf, "Tears of Steel"),
          overrides: { name: "Tears of Steel (Director's Cut)", year: 2012.5 },
          externalIds: { tmdb: "133701", imdb: null, tvdb: null },
        },
      ]),
    );

    expect(edited.done).toBe(1);
    held(await advance(stack, lease, edited.at, { phase: "done", unit: 0, cursor: 0 }));
    await finishJob(stack, lease);

    const titleDetail = await owner.signedIn.client.query(api.movies.titles.get, {
      titleId: titleIn(shelf, "Tears of Steel"),
    });

    expect(titleDetail.name).toBe("Tears of Steel (Director's Cut)");
    expect(titleDetail.year).toBe(2012);
    expect(titleDetail.externalIds.tmdb).toBe("133701");

    expect(
      (await collectionNamed(aiko.signedIn.client, boxName))?.titles.map((title) => title.name),
    ).toEqual(["Sintel", "Big Buck Bunny"]);

    expect(await runOf(owner, started.importId)).toMatchObject({
      phase: "done",
      imported: { collections: 1, overrides: 1 },
      job: { status: "succeeded" },
    });

    const again = await startImport(stack, owner, {
      serverId,
      users: [{ sourceUserId: "aiko", userId: aiko.userId, history: "full" }],
    });

    const relet = await claimJob(stack, "movies.import.jellyfin", again.jobId);

    held(await advance(stack, relet, LIBRARIES, START));

    const rewrote = held(await writeWatch(stack, relet, START, items.slice(0, 3)));

    const atBox = held(
      await advance(stack, relet, rewrote.at, { ...START, phase: "collections" }),
    ).at;

    held(await writeCollections(stack, relet, atBox, [box(["Big Buck Bunny"])]));
    await finishJob(stack, relet);

    expect((await runOf(owner, again.importId)).imported).toMatchObject({
      watched: 0,
      favorites: 0,
    });
    expect(await listOf(aiko.signedIn.client)).toEqual(["Big Buck Bunny", "Pioneer One"]);
    expect(
      (await collectionNamed(aiko.signedIn.client, boxName))?.titles.map((title) => title.name),
    ).toEqual(["Big Buck Bunny"]);
  });

  it("move to the next items in the write that ends a user, refuse a checkpoint that moves back, and write nothing once canceled", async () => {
    if (stack === undefined) return;

    const started = await startImport(stack, shelf.owner, {
      serverId: label("cancel"),
      users: [{ sourceUserId: "aiko", userId: shelf.aiko.userId, history: "full" }],
    });

    const lease = await claimJob(stack, "movies.import.jellyfin", started.jobId);

    held(await advance(stack, lease, LIBRARIES, START));
    const at = held(await advance(stack, lease, START, { ...START, cursor: 2 })).at;

    expect(await refusal(advance(stack, lease, at, START))).toBe("invalid_args");

    // A write that reaches the end of its user moves straight to where the next items start.
    const item = watchItem(shelf.aiko, "Unrated Short", { watched: true, lastPlayedAt: 1 });
    const collections: Checkpoint = { phase: "collections", unit: 0, cursor: 0 };

    expect(await refusal(writeWatch(stack, lease, at, [item], 0, START))).toBe("invalid_args");
    expect(held(await writeWatch(stack, lease, at, [item], 0, collections))).toMatchObject({
      done: 1,
      at: collections,
    });

    await runFunction(
      stack,
      internal.core.jobs.admin.cancel,
      { jobId: started.jobId },
      Schema.Unknown,
    );

    const later = watchItem(shelf.aiko, "Sintel", { watched: true, lastPlayedAt: Date.now() });

    expect(await writeCollections(stack, lease, collections, [])).toEqual({ outcome: "canceled" });
    expect(await writeWatch(stack, lease, collections, [later])).toEqual({ outcome: "canceled" });
    expect(await historyOf(shelf.aiko.signedIn.client)).not.toContainEqual(
      expect.objectContaining({ name: "Sintel", watched: true }),
    );
  });

  it("write 400 items over titles at their bound in calls inside Convex's limits", async () => {
    if (stack === undefined) return;

    const owner = await member(stack, label("import-budget"), "admin");

    const people = await Promise.all([
      member(stack, label("first")),
      member(stack, label("second")),
    ]);

    const { libraryId, scanJobId, roots } = await moviesLibrary(owner, label("Wide titles"));
    const root = roots[0] ?? "";
    const scan = await claimJob(stack, "movies.scan", scanJobId, 120_000);
    const overview = "o".repeat(70_000);

    const films = Array.from({ length: 200 }, (_, n) =>
      movieFile(join(root, `${n}.mkv`), 1, 1, {
        ...scannedTitle("movie", `wide:${n}`, `Wide ${n}`),
        overview,
      }),
    );

    // A request body holds a few MiB, so the films go 40 at a time.
    const scanFrom = async (from: number): Promise<void> => {
      if (from >= films.length) return;

      await upsertAll(stack, scan, films.slice(from, from + 40));
      await scanFrom(from + 40);
    };

    await scanFrom(0);

    await finishJob(stack, scan);

    const titleIds = async (
      cursor: string | null = null,
      found: ReadonlyArray<Id<"titles">> = [],
    ): Promise<ReadonlyArray<Id<"titles">>> => {
      const page = await owner.signedIn.client.query(api.movies.titles.list, {
        paginationOpts: { numItems: 100, cursor },
        libraryId,
      });

      const next = [...found, ...page.page.map((title) => title.id)];

      return page.isDone ? next : titleIds(page.continueCursor, next);
    };

    const wide = await titleIds();

    const started = await startImport(stack, owner, {
      serverId: label("wide"),
      users: people.map((who, n) => ({
        sourceUserId: String(n),
        userId: who.userId,
        history: "full" as const,
      })),
    });

    const lease: Lease = await claimJob(stack, "movies.import.jellyfin", started.jobId, 120_000);

    held(await advance(stack, lease, LIBRARIES, START));

    const items = people.flatMap((who) =>
      wide.map((titleId) => ({
        userId: who.userId,
        titleId,
        episodeId: null,
        fileId: null,
        watched: true,
        positionMs: 0,
        playCount: 1,
        lastPlayedAt: 1,
        favorite: true,
      })),
    );

    expect(items).toHaveLength(400);

    const mark = await logMark(stack);
    const written = await writeAllWatch(stack, lease, START, items);

    const usage = await usageSince(
      stack,
      mark,
      api.movies.imports.writeWatchState,
      written.dones.length,
    );

    expect(written.dones.length).toBeGreaterThan(1);
    expect(written.at).toEqual({ ...START, cursor: 400 });
    expect(
      usage
        .filter((call) => call.committed)
        .every(
          (call) => call.reads < READS_MAX && call.writes < WRITES_MAX && call.bytes < BYTES_MAX,
        ),
    ).toBe(true);

    expect((await runOf(owner, started.importId)).imported).toMatchObject({
      watched: 400,
      favorites: 400,
    });

    await finishJob(stack, lease);
  });
  it("add a library for folders no library covers, shared as the source showed it, and wait for its scan", async () => {
    if (stack === undefined) return;

    const { owner, aiko, sam, outsider } = shelf;
    const covered = await moviesLibrary(owner, label("Covered here"));
    const coveredScan = await claimJob(stack, "movies.scan", covered.scanJobId);

    await finishJob(stack, coveredScan);

    const [everyoneRoot, aikoRoot, hiddenRoot] = await Promise.all([
      makeTree(["Gem.mkv"]),
      makeTree([]),
      makeTree([]),
    ]);

    const names = {
      everyone: label("Everyone films"),
      aiko: label("Aiko films"),
      hidden: label("Hidden films"),
    };

    const started = await startImport(stack, owner, {
      serverId: label("libraries"),
      users: [
        { sourceUserId: "aiko", userId: aiko.userId, history: "full" },
        { sourceUserId: "sam", userId: sam.userId, history: "full" },
      ],
      libraries: [
        { name: names.everyone, roots: [everyoneRoot], access: { kind: "everyone" } },
        { name: names.aiko, roots: [aikoRoot], access: { kind: "users", users: [0] } },
        { name: names.hidden, roots: [hiddenRoot], access: { kind: "users", users: [] } },
        {
          name: label("Already here"),
          roots: [join(covered.roots[0] ?? "", "inside")],
          access: { kind: "everyone" },
        },
      ],
    });

    const lease = await claimJob(stack, "movies.import.jellyfin", started.jobId);

    const covering = async (at: Checkpoint, left: number): Promise<Checkpoint> => {
      if (left === 0) return at;

      return covering(held(await ensureLibrary(stack, lease, at)).at, left - 1);
    };

    const afterLibraries = await covering(LIBRARIES, 4);

    expect(afterLibraries).toEqual({ ...LIBRARIES, cursor: 4 });
    expect((await runOf(owner, started.importId)).imported.librariesAdded).toBe(3);

    const seen = async (who: Member) =>
      (
        await who.signedIn.client.query(api.core.libraries.list, {
          paginationOpts: { numItems: 200, cursor: null },
        })
      ).page
        .filter((library) => Object.values(names).includes(library.name))
        .map((library) => [library.name, library.level] as const)
        .toSorted(([left], [right]) => left.localeCompare(right));

    expect(await seen(sam)).toEqual([[names.everyone, "view"]]);
    expect(await seen(aiko)).toEqual(
      [
        [names.aiko, "view"],
        [names.everyone, "view"],
      ].toSorted(([left = ""], [right = ""]) => left.localeCompare(right)),
    );
    expect(await seen(outsider)).toEqual([[names.everyone, "view"]]);
    expect((await seen(owner)).map(([, level]) => level)).toEqual(["manage", "manage", "manage"]);

    expect(held(await scansPending(stack, lease)).pending).toBe(3);

    const libraries = await owner.signedIn.client.query(api.core.libraries.list, {
      paginationOpts: { numItems: 200, cursor: null },
    });

    const scanOf = async (name: string) => {
      const listed = libraries.page.find((library) => library.name === name);

      if (listed === undefined) throw new Error(`no library ${name}`);

      const detail = await owner.signedIn.client.query(api.core.libraries.get, {
        libraryId: listed.libraryId,
      });

      if (detail.scan === null) throw new Error(`no scan of ${name}`);

      return claimJob(stack, "movies.scan", detail.scan.jobId);
    };

    const everyoneScan = await scanOf(names.everyone);

    const landed = await upsert(stack, everyoneScan, [movieFile(join(everyoneRoot, "Gem.mkv"))]);

    if (landed.outcome !== "held") throw new Error(`upsert answered ${landed.outcome}`);

    const [gem] = landed.value.files;

    if (gem === undefined) throw new Error("the scan wrote no file");

    await finishJob(stack, everyoneScan);
    await finishJob(stack, await scanOf(names.aiko));
    await finishJob(stack, await scanOf(names.hidden));

    expect(held(await scansPending(stack, lease)).pending).toBe(0);

    const scanned = held(
      await advance(stack, lease, afterLibraries, { ...LIBRARIES, phase: "scanning" }),
    ).at;

    const watching = held(await advance(stack, lease, scanned, START)).at;

    held(
      await writeWatch(stack, lease, watching, [
        {
          userId: sam.userId,
          titleId: gem.titleId,
          episodeId: null,
          fileId: gem.fileId,
          watched: true,
          positionMs: 0,
          playCount: 1,
          lastPlayedAt: Date.now() - 60_000,
          favorite: false,
        },
      ]),
    );

    await finishJob(stack, lease);

    expect(await historyOf(sam.signedIn.client)).toContainEqual({
      name: "Gem.mkv",
      watched: true,
      positionMs: 0,
    });
  });

  it("leave a whole-show mark a person made during the import to finish over older imported progress", async () => {
    if (stack === undefined) return;

    const viewer = await member(stack, label("mark-viewer"));

    const seeded = await seedLibrary(stack, viewer, {
      name: label("Long shows"),
      kind: "movies",
      items: [show(label("Long Show"), 0, 501)],
    });

    const [titleId] = seeded.itemIds;

    if (titleId === undefined) throw new Error("no show seeded");

    const episode = (number: number) =>
      runFunction(
        stack,
        internal.movies.probe.episodeProgress,
        { userId: viewer.userId, titleId, seasonNumber: 1, episodeNumber: number },
        EpisodeState,
      );

    // The person marks the whole show watched. Its first page commits; the page for the last
    // episode has not run yet, which taking that row away stands in for.
    await viewer.signedIn.client.mutation(api.movies.history.markWatched, { titleId });

    const page = await eventually(async () => {
      const [found] = (await markPagesOf(titleId)).map(({ args: [args] }) => args);

      return found;
    });

    await eventually(async () => ((await episode(501)).watched === true ? true : undefined));

    const last = await episode(501);

    await runFunction(
      stack,
      internal.movies.probe.forgetProgress,
      { userId: viewer.userId, titleId, episodeId: last.episodeId },
      Schema.Null,
    );

    const started = await startImport(stack, shelf.owner, {
      serverId: label("mark"),
      users: [{ sourceUserId: "viewer", userId: viewer.userId, history: "full" }],
    });

    const lease = await claimJob(stack, "movies.import.jellyfin", started.jobId);

    held(await advance(stack, lease, LIBRARIES, START));
    held(
      await writeWatch(stack, lease, START, [
        {
          userId: viewer.userId,
          titleId,
          episodeId: last.episodeId,
          fileId: null,
          watched: false,
          positionMs: 5000,
          playCount: 1,
          lastPlayedAt: 1,
          favorite: false,
        },
      ]),
    );

    await finishJob(stack, lease);

    expect((await episode(501)).generation).toBe(last.generation);

    // The mark's page for the last episode runs now, as it would have after the import's write.
    await runFunction(stack, internal.movies.history.markRest, page, Schema.Null);

    expect(await episode(501)).toMatchObject({ watched: true, generation: last.generation });

    // A whole-show unwatched mark is the person's word too: older source progress stays out.
    await viewer.signedIn.client.mutation(api.movies.history.markUnwatched, { titleId });
    await eventually(async () => ((await episode(501)).watched === null ? true : undefined));

    const again = await startImport(stack, shelf.owner, {
      serverId: label("unmarked"),
      users: [{ sourceUserId: "viewer", userId: viewer.userId, history: "full" }],
    });

    const relet = await claimJob(stack, "movies.import.jellyfin", again.jobId);
    const second = await episode(2);

    held(await advance(stack, relet, LIBRARIES, START));

    const older = {
      userId: viewer.userId,
      titleId,
      episodeId: second.episodeId,
      fileId: null,
      watched: true,
      positionMs: 0,
      playCount: 1,
      lastPlayedAt: 1,
      favorite: false,
    };

    const wrote = held(await writeWatch(stack, relet, START, [older]));

    expect((await episode(2)).watched).toBeNull();

    held(
      await writeWatch(stack, relet, wrote.at, [
        { ...older, episodeId: last.episodeId, lastPlayedAt: Date.now() + 1000 },
      ]),
    );

    await finishJob(stack, relet);

    expect((await episode(501)).watched).toBe(true);
  });
});
