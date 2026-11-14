import { register } from "../../commands/core/jobs";
import type { Level } from "../../commands/access";
import type { Doc, Id } from "../_generated/dataModel";
import { trackFacts } from "../music/items";
import { viewOf } from "./jobs/admin";
import { paginateAtMost } from "./lib/paginate";
import { decidableRows, levelOn, reachOf } from "./permissions/grants";
import { can, itemOf, resourceOf } from "./permissions/policy";

/**
 * What one listed job reads besides its library's grants: the job, a lyrics lookup's track, and
 * the library of a scan or that track.
 */
const JOB_ROW_READS = 3;

/** The most jobs one page lists. A job's payload is at most a few KiB (ADR 0012). */
const JOBS_PAGE_MAX = 100;

/** A library the caller sees, and their level on it. */
interface SeenLibrary {
  readonly doc: Doc<"libraries">;
  readonly level: Level;
}

export const { list } = register({
  /**
   * Every kind of job, newest first, as old music's jobs page listed its own. A scan shows only
   * where the caller sees its library, and its error, which may name the folders, only to the
   * library's managers, as `core.libraries.get` shows it. A lyrics lookup names a song, so it
   * shows only where the caller may see that song, as `music.lyrics.get` and the backfill decide
   * through its library. The stack suite's probe jobs never run on a server and are left out.
   */
  list: async (ctx, { status, paginationOpts }, caller) => {
    const reach = await reachOf(ctx.db, caller);
    const rows = Math.max(1, Math.min(JOBS_PAGE_MAX, decidableRows(reach, JOB_ROW_READS)));

    const page =
      status === undefined
        ? await paginateAtMost(
            ctx.db,
            { table: "jobs", index: "by_creation_time", order: "desc" },
            paginationOpts,
            rows,
          )
        : await paginateAtMost(
            ctx.db,
            {
              table: "jobs",
              index: "by_status",
              range: (q) => q.eq("status", status),
              order: "desc",
            },
            paginationOpts,
            rows,
          );

    const libraries = new Map<Id<"libraries">, Promise<SeenLibrary | null>>();

    const libraryOf = (libraryId: Id<"libraries">): Promise<SeenLibrary | null> => {
      const known = libraries.get(libraryId);

      if (known !== undefined) return known;

      const seen = (async () => {
        const doc = await ctx.db.get(libraryId);

        if (doc === null) return null;

        const level = await levelOn(ctx.db, reach, { type: "library", id: libraryId });

        return level !== null && can(caller, "view", resourceOf("library", doc, level)).allowed
          ? { doc, level }
          : null;
      })();

      libraries.set(libraryId, seen);

      return seen;
    };

    const listed = await Promise.all(
      page.page.map(async (job) => {
        const { payload } = job;

        if (
          payload.kind === "probe.capped" ||
          payload.kind === "probe.wide" ||
          payload.kind === "probe.items"
        ) {
          return [];
        }

        const view = viewOf(job);

        const row = {
          jobId: view.id,
          status: view.status,
          attempts: view.attempts,
          done: view.done,
          total: view.total,
          message: view.message,
          canceling: view.canceling,
          createdAt: view.createdAt,
          finishedAt: view.finishedAt,
        };

        if (payload.kind === "movies.scan" || payload.kind === "music.scan") {
          const library = await libraryOf(payload.libraryId);

          return library === null
            ? []
            : [
                {
                  ...row,
                  kind: payload.kind,
                  library: {
                    libraryId: library.doc._id,
                    name: library.doc.name,
                    level: library.level,
                  },
                  error: library.level === "manage" ? view.error : null,
                },
              ];
        }

        if (payload.kind === "music.lyrics") {
          const track = await ctx.db.get(payload.trackId);
          const library = track === null ? null : await libraryOf(track.libraryId);

          return track === null ||
            library === null ||
            !can(caller, "view", itemOf(library.doc, library.level, trackFacts(track))).allowed
            ? []
            : [{ ...row, kind: payload.kind, library: null, error: view.error }];
        }

        return [{ ...row, kind: payload.kind, library: null, error: view.error }];
      }),
    );

    return { ...page, page: listed.flat() };
  },
});
