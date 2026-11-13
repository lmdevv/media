import { register } from "../../commands/music/lyrics";
import { fail } from "../core/lib/errors";
import { reachOf } from "../core/permissions/grants";
import { trackPlayer } from "./access";
import type { LocalLyricSet } from "./validators";

type Body = LocalLyricSet["body"];

type SyncedSet = LocalLyricSet & { readonly body: Extract<Body, { readonly lines: unknown }> };

type PlainSet = LocalLyricSet & { readonly body: Extract<Body, { readonly text: unknown }> };

const isSynced = (set: LocalLyricSet): set is SyncedSet => "lines" in set.body;

const isPlain = (set: LocalLyricSet): set is PlainSet => "text" in set.body;

/** A lyric file beside the song beats a tag inside it. */
const originRank = (set: LocalLyricSet): number => ("fileName" in set.origin ? 0 : 1);

/** Word timing beats line timing. */
const wordRank = (set: SyncedSet): number =>
  set.body.lines.some((line) => line.words !== null) ? 0 : 1;

/** The first set in `sets` that `rank` puts first, or undefined. */
const best = <Lyrics extends LocalLyricSet>(
  sets: ReadonlyArray<Lyrics>,
  rank: (set: Lyrics) => number,
): Lyrics | undefined =>
  sets.reduce<Lyrics | undefined>(
    (found, set) => (found === undefined || rank(set) < rank(found) ? set : found),
    undefined,
  );

/** A stored lyric set as the music commands answer it. */
const presented = (set: LocalLyricSet) => ({
  kind: set.kind,
  lang: set.lang,
  origin:
    "fileName" in set.origin
      ? { type: "sidecar" as const, fileName: set.origin.fileName, format: set.origin.format }
      : { type: "embedded" as const, tag: set.origin.tag },
  body:
    "lines" in set.body
      ? { type: "synced" as const, lines: set.body.lines }
      : { type: "plain" as const, text: set.body.text },
});

/**
 * The lyrics to show from a song's own lyric sets, as old music's `resolveLyrics` picked them
 * without LRCLIB, which comes with its lookups: its synced main lyrics, else its plain main
 * lyrics, a file beside the song beating a tag inside it, and word timing beating line timing;
 * among sets still equal, the first. Every other set is kept in `extras`.
 */
const resolve = (sets: ReadonlyArray<LocalLyricSet>) => {
  const main = sets.filter((set) => set.kind === "main");
  const synced = best(main.filter(isSynced), (set) => originRank(set) * 2 + wordRank(set));
  const chosen = synced ?? best(main.filter(isPlain), originRank);

  if (chosen === undefined) return { status: "none" as const };

  return {
    status: synced === undefined ? ("plain" as const) : ("synced" as const),
    source: "file" as const,
    main: presented(chosen),
    extras: sets.flatMap((set) => (set === chosen ? [] : [presented(set)])),
  };
};

export const { get } = register({
  get: async (ctx, { trackId }, caller) => {
    const track = await ctx.db.get(trackId);
    const reach = await reachOf(ctx.db, caller);

    if (track === null || !(await trackPlayer(ctx.db, reach)(track))) {
      return fail("not_found", "No such track");
    }

    const row = await ctx.db
      .query("localLyrics")
      .withIndex("by_track", (q) => q.eq("trackId", track._id))
      .first();

    return resolve(row?.sets ?? []);
  },
});
