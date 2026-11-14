import { describe, expect, it } from "vitest";

import { api } from "../../convex/_generated/api";
import { inOrder } from "../../convex/core/lib/inOrder";
import { logMark, usageSince } from "../admin";
import { member, sharedAdmin } from "../devices";
import { share } from "../probe";
import { unique } from "../sign-in";
import { coreStackFromEnvFile } from "../stack-env";
import { claimScan, finishScan, musicLibrary, upsertAll } from "./catalog";
import { musicTrack } from "./scanned";
import { allPages, at } from "./shelf";

const stack = coreStackFromEnvFile();

/** Songs in a library the member cannot see, all sorting before theirs. */
const HIDDEN = 40_000;

/** Songs the member sees. */
const SEEN = 20;

/**
 * Writes `titles` into a new music library through the scanner, as the server would, and answers
 * the library.
 */
const libraryOf = async (
  core: NonNullable<typeof stack>,
  name: string,
  titles: ReadonlyArray<string>,
) => {
  const admin = await sharedAdmin(core);
  const { libraryId, scanJobId, roots } = await musicLibrary(admin, name);
  const root = at(roots, 0);
  const lease = await claimScan(core, scanJobId, 600_000);

  await upsertAll(
    core,
    lease,
    titles.map((title, n) =>
      musicTrack(`${root}/Album ${Math.floor(n / 20)}/${n}.flac`, 1000, 1, { title }),
    ),
  );
  await finishScan(core, lease);

  return { admin, libraryId };
};

describe.skipIf(stack === undefined)("music list pages", { timeout: 1_800_000 }, () => {
  it("gives a member their songs on the first page when 40,000 they cannot see sort before them", async () => {
    if (stack === undefined) return;
    const run = unique();

    // `!` sorts before letters and digits, so these come first in every library's title order.
    await libraryOf(
      stack,
      `Hidden ${run}`,
      Array.from({ length: HIDDEN }, (_, n) => `!a ${run} ${String(n).padStart(5, "0")}`),
    );

    const titles = Array.from(
      { length: SEEN },
      (_, n) => `!b ${run} ${String(n).padStart(2, "0")}`,
    );

    const { admin, libraryId } = await libraryOf(stack, `Seen ${run}`, titles);
    const viewer = await member(stack, "pages-viewer");

    await share(admin, libraryId, { kind: "user", userId: viewer.userId }, "view");

    const ours = (page: { readonly page: ReadonlyArray<{ readonly title: string }> }) =>
      page.page.map((track) => track.title).filter((title) => title.includes(run));

    // Each run reads every page once: Convex answers a read it answered before from its cache,
    // which the function log does not show.
    const pagesAt = async (numItems: number) => {
      const mark = await logMark(stack);

      const first = await viewer.signedIn.client.query(api.music.tracks.list, {
        paginationOpts: { numItems, cursor: null },
      });

      const listed = first.isDone
        ? { rows: first.page, calls: 0 }
        : await allPages(
            (cursor) =>
              viewer.signedIn.client.query(api.music.tracks.list, {
                paginationOpts: { numItems, cursor },
              }),
            first.continueCursor,
          );

      const rows = [...(first.isDone ? [] : first.page), ...listed.rows];
      const calls = listed.calls + 1;

      return {
        first: ours(first),
        rows,
        calls,
        usage: await usageSince(stack, mark, api.music.tracks.list, calls),
      };
    };

    // No page comes back empty while rows are left: old music's ADS-112 took 205 calls here.
    const checked = await inOrder([200, 100], async (numItems) => {
      const { first, rows, calls, usage } = await pagesAt(numItems);

      return {
        first,
        ours: ours({ page: rows }),
        unwasted: calls <= Math.ceil(rows.length / numItems) + 1,
        bounded: usage.every((call) => call.committed && call.reads < 1000),
      };
    });

    expect(checked).toEqual([
      { first: titles, ours: titles, unwasted: true, bounded: true },
      { first: titles, ours: titles, unwasted: true, bounded: true },
    ]);
  });
});
