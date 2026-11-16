/**
 * What a member of a 500-song Jam costs the core, over live subscriptions as the music clients make
 * them (ADR 0017): `core.together.get`, every page of the session's queue, which carries its songs'
 * details, and the details of the song playing and the one queued first. Counts the documents each
 * query run read, from the function log, when the member first loads the Jam and when the host
 * pauses it.
 */
import { ConvexClient } from "convex/browser";
import type { FunctionArgs, FunctionReference, FunctionReturnType } from "convex/server";
import { describe, expect, it } from "vitest";

import type { DomainItem } from "../../../commands/access";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { inOrder } from "../../../convex/core/lib/inOrder";
import { followLog, logMark } from "../../admin";
import { member } from "../../devices";
import { seedLibraries, share, song } from "../../probe";
import { coreStackFromEnvFile } from "../../stack-env";
import { sleep, waitFor } from "../../together";

const stack = coreStackFromEnvFile();

const MUSIC = "music" as const;

const LIBRARIES = 10;

const SONGS_EACH = 50;

/** Entries the clients ask for per page (`QUEUE_PAGE` in `@media/player`). */
const QUEUE_PAGE = 200;

type Page = FunctionReturnType<typeof api.core.together.queue>;

type View = FunctionReturnType<typeof api.core.together.get>;

const musicTrack = (id: Id<"tracks">): DomainItem => ({
  domain: MUSIC,
  ref: { type: "track", id },
});

/** The reads of each run of `callable` the function log shows from `mark`, cached ones left out. */
const readsOf = (log: ReturnType<typeof followLog>, callable: FunctionReference<"query">) =>
  log
    .usage(callable)
    .filter((call) => call.committed)
    .map((call) => call.reads);

const sum = (values: ReadonlyArray<number>): number =>
  values.reduce((total, value) => total + value, 0);

describe.skipIf(stack === undefined)("a 500-song Jam's member", { timeout: 600_000 }, () => {
  it("reads the Jam once as it loads, and only its clock when the host pauses", async () => {
    if (stack === undefined) return;
    const host = await member(stack, "jam-host");
    const guest = await member(stack, "jam-guest");

    const libraries = await seedLibraries(
      stack,
      host,
      Array.from({ length: LIBRARIES }, (_, at) => ({
        name: `jam-${at}`,
        kind: "music" as const,
        items: Array.from({ length: SONGS_EACH }, (_song, n) => song(`jam-${at}-${n}`, false)),
      })),
    );

    await inOrder(libraries, async ({ libraryId }) =>
      share(host, libraryId, { kind: "user", userId: guest.userId }, "view"),
    );

    const songs = libraries.flatMap((library) => library.itemIds).map(musicTrack);
    const [first] = songs;

    if (first === undefined) throw new Error("seeded no song");

    const { sessionId, link } = await host.signedIn.client.action(api.core.together.create, {
      item: first,
    });

    await guest.signedIn.client.mutation(api.core.together.join, { domain: MUSIC, link });

    const fill = async (rest: ReadonlyArray<DomainItem>): Promise<void> => {
      if (rest.length === 0) return;

      const { taken } = await host.signedIn.client.mutation(api.core.together.addItems, {
        domain: MUSIC,
        sessionId,
        items: [...rest],
      });

      if (taken > 0) await fill(rest.slice(taken));
    };

    await fill(songs);
    await host.signedIn.client.mutation(api.core.together.control, {
      domain: MUSIC,
      op: { kind: "play" },
      sessionId,
    });

    const client = new ConvexClient(stack.url, { logger: false });

    client.setAuth(async () => guest.signedIn.token);

    const loaded = new Map<string, boolean>();
    const pages: Array<Page | undefined> = [];
    const stops: Array<() => void> = [];
    let latest: View | undefined;

    const follow = <Query extends FunctionReference<"query">>(
      key: string,
      query: Query,
      args: FunctionArgs<Query>,
      then?: (value: FunctionReturnType<Query>) => void,
    ): void => {
      if (loaded.has(key)) return;

      loaded.set(key, false);
      stops.push(
        client.onUpdate(query, args, (value) => {
          loaded.set(key, true);
          then?.(value);
        }),
      );
    };

    const songDetails = (trackId: Id<"tracks">): void => {
      follow(`track:${trackId}`, api.music.tracks.get, { trackId });
    };

    const pageAt = (index: number, cursor: string | null): void => {
      follow(
        `page:${index}`,
        api.core.together.queue,
        { domain: MUSIC, paginationOpts: { numItems: QUEUE_PAGE, cursor } },
        (page) => {
          pages[index] = page;

          // Each page carries its songs' details; a client reads the song queued first on its own.
          const next = index === 0 ? page.page[0]?.item : undefined;

          if (next?.ref.type === "track") songDetails(next.ref.id);

          if (!page.isDone) pageAt(index + 1, page.continueCursor);
        },
      );
    };

    const settled = (): boolean =>
      [...loaded.values()].every(Boolean) && pages.at(-1)?.isDone === true;

    const loadMark = await logMark(stack);
    const loadLog = followLog(stack, loadMark);

    follow("get", api.core.together.get, { domain: MUSIC }, (view) => {
      latest = view;

      if (view?.state === "joined" && view.item?.ref.type === "track") {
        songDetails(view.item.ref.id);
      }
    });
    pageAt(0, null);

    expect(await waitFor(settled, 120_000)).toBe(true);
    await sleep(2_000);
    await loadLog.catchUp();

    const queued = pages.flatMap((page) => page?.page ?? []);

    const load = {
      get: readsOf(loadLog, api.core.together.get),
      queue: readsOf(loadLog, api.core.together.queue),
      tracks: readsOf(loadLog, api.music.tracks.get),
    };

    const pauseMark = await logMark(stack);
    const pauseLog = followLog(stack, pauseMark);

    await host.signedIn.client.mutation(api.core.together.control, {
      domain: MUSIC,
      op: { kind: "pause" },
      sessionId,
    });

    const paused = (): boolean => latest?.state === "joined" && latest.clock.status === "paused";

    expect(await waitFor(paused, 30_000)).toBe(true);
    await sleep(3_000);
    await pauseLog.catchUp();

    const pause = {
      get: readsOf(pauseLog, api.core.together.get),
      queue: readsOf(pauseLog, api.core.together.queue),
      tracks: readsOf(pauseLog, api.music.tracks.get),
    };

    for (const stop of stops) stop();
    await client.close();

    const line = (label: string, runs: typeof load): string =>
      `${label}: ${sum([...runs.get, ...runs.queue, ...runs.tracks])} reads in ` +
      `${runs.get.length + runs.queue.length + runs.tracks.length} runs ` +
      `(get ${runs.get.length} runs, ${sum(runs.get)} reads; ` +
      `queue ${runs.queue.length} runs, ${sum(runs.queue)} reads; ` +
      `song details ${runs.tracks.length} runs, ${sum(runs.tracks)} reads)`;

    process.stdout.write(
      `[jam cost] a member of a Jam of ${queued.length} queued songs, ${pages.length} pages. ` +
        `${line("First load", load)}. ${line("One pause", pause)}\n`,
    );

    expect(queued).toHaveLength(songs.length);
    expect(queued.every((row) => row.track !== null)).toBe(true);
    // The song playing and the one queued first are read on their own, no other.
    expect(load.tracks.length).toBeLessThanOrEqual(2);
    // A pause moves the clock alone: no page of the queue runs again.
    expect(pause.queue).toEqual([]);
    expect(pause.get.length).toBeGreaterThan(0);
  });
});
