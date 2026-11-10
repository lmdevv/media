import type { Doc } from "../_generated/dataModel";
import type { DatabaseReader } from "../_generated/server";
import type { ItemGate } from "../core/permissions/grants";
import { titleFacts } from "./items";
import { titlesOf } from "./reads";
import type { ReadBudget } from "./reads";

type Kind = Doc<"titles">["kind"];

type Title = Doc<"titles">;

/** The newest titles a merge found, and whether it read every library as far as it needed. */
export interface Newest {
  readonly titles: ReadonlyArray<Title>;
  readonly complete: boolean;
}

interface Stream {
  readonly gate: ItemGate;
  readonly buffer: ReadonlyArray<Title>;
  readonly last: Title | null;
  readonly ended: boolean;
  readonly batch: number;
}

/**
 * Titles a library's first read takes: one, so a merge across many libraries reads little from
 * each, and a library whose titles keep coming out newest reads twice as many each time.
 */
const FIRST_BATCH = 1;

const newerFirst = (left: Title, right: Title): number =>
  right.addedAt - left.addedAt || right._creationTime - left._creationTime;

/** The newest titles of a library, of `kind` or of any kind, after `last` in that order. */
const batchOf = async (
  db: DatabaseReader,
  gate: ItemGate,
  kind: Kind | undefined,
  last: Title | null,
  count: number,
): Promise<ReadonlyArray<Title>> => {
  const libraryId = gate.library._id;

  const ofLibrary = () =>
    kind === undefined
      ? {
          start: () =>
            db
              .query("titles")
              .withIndex("by_library_added", (q) => q.eq("libraryId", libraryId))
              .order("desc"),
          tie: (title: Title) =>
            db
              .query("titles")
              .withIndex("by_library_added", (q) =>
                q
                  .eq("libraryId", libraryId)
                  .eq("addedAt", title.addedAt)
                  .lt("_creationTime", title._creationTime),
              )
              .order("desc"),
          past: (title: Title) =>
            db
              .query("titles")
              .withIndex("by_library_added", (q) =>
                q.eq("libraryId", libraryId).lt("addedAt", title.addedAt),
              )
              .order("desc"),
        }
      : {
          start: () =>
            db
              .query("titles")
              .withIndex("by_library_kind_added", (q) =>
                q.eq("libraryId", libraryId).eq("kind", kind),
              )
              .order("desc"),
          tie: (title: Title) =>
            db
              .query("titles")
              .withIndex("by_library_kind_added", (q) =>
                q
                  .eq("libraryId", libraryId)
                  .eq("kind", kind)
                  .eq("addedAt", title.addedAt)
                  .lt("_creationTime", title._creationTime),
              )
              .order("desc"),
          past: (title: Title) =>
            db
              .query("titles")
              .withIndex("by_library_kind_added", (q) =>
                q.eq("libraryId", libraryId).eq("kind", kind).lt("addedAt", title.addedAt),
              )
              .order("desc"),
        };

  const ranges = ofLibrary();

  if (last === null) return ranges.start().take(count);

  const tied = await ranges.tie(last).take(count);

  return tied.length >= count
    ? tied
    : [...tied, ...(await ranges.past(last).take(count - tied.length))];
};

/** Reads a stream's next batch when the budget pays for it, or ends it as spent. */
const refill = async (
  db: DatabaseReader,
  stream: Stream,
  kind: Kind | undefined,
  budget: ReadBudget,
  want: number,
): Promise<{ readonly stream: Stream; readonly spent: boolean }> => {
  const cost = stream.last === null ? titlesOf(stream.batch) : titlesOf(stream.batch, 2);

  if (!budget.take(cost)) return { stream: { ...stream, ended: true }, spent: true };

  const read = await batchOf(db, stream.gate, kind, stream.last, stream.batch);

  return {
    stream: {
      gate: stream.gate,
      buffer: read,
      last: read.at(-1) ?? stream.last,
      ended: read.length < stream.batch,
      batch: Math.min(want, stream.batch * 2),
    },
    spent: false,
  };
};

interface Merge {
  readonly streams: ReadonlyArray<Stream>;
  readonly found: ReadonlyArray<Title>;
  readonly spent: boolean;
}

const mergeStep = async (
  db: DatabaseReader,
  merge: Merge,
  kind: Kind | undefined,
  budget: ReadBudget,
  want: number,
): Promise<Merge> => {
  if (merge.found.length >= want) return merge;

  const refilled = await Promise.all(
    merge.streams.map(async (stream) =>
      stream.buffer.length === 0 && !stream.ended
        ? refill(db, stream, kind, budget, want)
        : { stream, spent: false },
    ),
  );

  const streams = refilled.map((one) => one.stream);
  const spent = merge.spent || refilled.some((one) => one.spent);

  const newest = streams.reduce<number>((best, stream, index) => {
    const head = stream.buffer[0];
    const current = streams[best]?.buffer[0];

    return head !== undefined && (current === undefined || newerFirst(head, current) < 0)
      ? index
      : best;
  }, -1);

  const from = streams[newest];
  const head = from?.buffer[0];

  if (from === undefined || head === undefined) return { streams, found: merge.found, spent };

  const next = streams.map((stream, index) =>
    index === newest
      ? {
          gate: stream.gate,
          buffer: stream.buffer.slice(1),
          last: stream.last,
          ended: stream.ended,
          batch: stream.batch,
        }
      : stream,
  );

  const admitted = head.purging !== true && from.gate.admits(titleFacts(head));

  return mergeStep(
    db,
    { streams: next, found: admitted ? [...merge.found, head] : merge.found, spent },
    kind,
    budget,
    want,
  );
};

/**
 * The `want` most recently added titles, of `kind` or of any kind, across the libraries of
 * `gates` that each library's gate admits, newest first. It merges the libraries' own newest
 * titles from their `(library, kind, added)` index a batch at a time, reading a library further
 * only while its titles are still among the newest, so every library counts and none reads more
 * than the merge needs. Every read is charged to `budget`; when it runs out, the merge answers
 * the newest it found among what it read, and says so.
 */
export const newestAcross = async (
  db: DatabaseReader,
  gates: ReadonlyArray<ItemGate>,
  kind: Kind | undefined,
  want: number,
  budget: ReadBudget,
): Promise<Newest> => {
  const merged = await mergeStep(
    db,
    {
      streams: gates.map((gate) => ({
        gate,
        buffer: [],
        last: null,
        ended: false,
        batch: FIRST_BATCH,
      })),
      found: [],
      spent: false,
    },
    kind,
    budget,
    want,
  );

  return { titles: merged.found, complete: !merged.spent };
};
