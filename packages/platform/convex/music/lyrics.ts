import { register } from "../../commands/music/lyrics";
import { holdKind, activeJobFor } from "../core/jobs/store";
import { fail } from "../core/lib/errors";
import { requireServer } from "../core/permissions/authorize";
import { reachOf } from "../core/permissions/grants";
import { callBudget } from "../movies/reads";
import { trackPlayer, walkMusicLibraries } from "./access";
import { NO_COST, meterFrom } from "./budget";
import { lookupOf, remoteLyricsOn, startBackfill } from "./lyricLookups";
import type { LyricSet } from "./validators";
import { musicStore } from "./write";

type Body = LyricSet["body"];

type SyncedSet = LyricSet & { readonly body: Extract<Body, { readonly lines: unknown }> };

type PlainSet = LyricSet & { readonly body: Extract<Body, { readonly text: unknown }> };

const isSynced = (set: LyricSet): set is SyncedSet => "lines" in set.body;

const isPlain = (set: LyricSet): set is PlainSet => "text" in set.body;

/** A lyric file beside the song beats a tag inside it, and both beat LRCLIB. */
const originRank = (set: LyricSet): number => {
  if ("fileName" in set.origin) return 0;

  return "tag" in set.origin ? 1 : 2;
};

/** Word timing beats line timing. */
const wordRank = (set: SyncedSet): number =>
  set.body.lines.some((line) => line.words !== null) ? 0 : 1;

/** The first set in `sets` that `rank` puts first, or undefined. */
const best = <Lyrics extends LyricSet>(
  sets: ReadonlyArray<Lyrics>,
  rank: (set: Lyrics) => number,
): Lyrics | undefined =>
  sets.reduce<Lyrics | undefined>(
    (found, set) => (found === undefined || rank(set) < rank(found) ? set : found),
    undefined,
  );

const bestSynced = (sets: ReadonlyArray<LyricSet>): SyncedSet | undefined =>
  best(
    sets.filter((set) => set.kind === "main").filter(isSynced),
    (set) => originRank(set) * 2 + wordRank(set),
  );

const bestPlain = (sets: ReadonlyArray<LyricSet>): PlainSet | undefined =>
  best(sets.filter((set) => set.kind === "main").filter(isPlain), originRank);

const originOf = (origin: LyricSet["origin"]) => {
  if ("fileName" in origin) {
    return { type: "sidecar" as const, fileName: origin.fileName, format: origin.format };
  }

  return "tag" in origin
    ? { type: "embedded" as const, tag: origin.tag }
    : { type: "lrclib" as const, recordId: origin.recordId };
};

/** A stored lyric set as the music commands answer it. */
const presented = (set: LyricSet) => ({
  kind: set.kind,
  lang: set.lang,
  origin: originOf(set.origin),
  body:
    "lines" in set.body
      ? { type: "synced" as const, lines: set.body.lines }
      : { type: "plain" as const, text: set.body.text },
});

/** The chosen set from `source`, with every other set from the same source in `extras`. */
const chosen = (
  status: "synced" | "plain",
  source: "file" | "lrclib",
  sets: ReadonlyArray<LyricSet>,
  main: LyricSet,
) => ({
  status,
  source,
  main: presented(main),
  extras: sets.flatMap((set) => (set === main ? [] : [presented(set)])),
});

/** What LRCLIB is known to hold for the song now, as old music's `LyricsLookup` said. */
type Remote =
  | { readonly state: "none" }
  | { readonly state: "pending" }
  | { readonly state: "instrumental" }
  | { readonly state: "found"; readonly sets: ReadonlyArray<LyricSet> };

/**
 * The lyrics to show, as old music's `resolveLyrics` picked them: the song's synced lyrics, then
 * LRCLIB's synced lyrics, then the song's plain lyrics, then LRCLIB's plain lyrics; the song's own
 * lyrics also beat an LRCLIB instrumental answer. Among one source's sets, a file beside the song
 * beats a tag inside it, and word timing beats line timing; among sets still equal, the first.
 * While a lookup is pending, the song's plain lyrics show as its fallback, since LRCLIB may find
 * synced ones.
 */
const resolve = (local: ReadonlyArray<LyricSet>, remote: Remote) => {
  const localSynced = bestSynced(local);

  if (localSynced !== undefined) return chosen("synced", "file", local, localSynced);

  const found = remote.state === "found" ? remote.sets : [];
  const remoteSynced = bestSynced(found);

  if (remoteSynced !== undefined) return chosen("synced", "lrclib", found, remoteSynced);

  const pending = remote.state === "pending";
  const localPlain = bestPlain(local);

  if (localPlain !== undefined) {
    return pending
      ? { status: "pending" as const, fallback: presented(localPlain) }
      : chosen("plain", "file", local, localPlain);
  }

  const remotePlain = bestPlain(found);

  if (remotePlain !== undefined) return chosen("plain", "lrclib", found, remotePlain);

  if (remote.state === "instrumental") return { status: "instrumental" as const };

  return pending ? { status: "pending" as const, fallback: null } : { status: "none" as const };
};

export const { get, status, configure, backfill } = register({
  get: async (ctx, { trackId }, caller) => {
    const track = await ctx.db.get(trackId);
    const reach = await reachOf(ctx.db, caller);

    if (track === null || !(await trackPlayer(ctx.db, reach)(track))) {
      return fail("not_found", "No such track");
    }

    const [local, lookup, answer] = await Promise.all([
      ctx.db
        .query("localLyrics")
        .withIndex("by_track", (q) => q.eq("trackId", track._id))
        .first(),
      lookupOf(track),
      ctx.db
        .query("lrclibLyrics")
        .withIndex("by_track", (q) => q.eq("trackId", track._id))
        .first(),
    ]);

    const current = lookup !== null && answer?.revision === lookup.revision ? answer.answer : null;

    const remote = async (): Promise<Remote> => {
      if (current?.status === "found") return { state: "found", sets: current.sets };

      if (current?.status === "instrumental") return { state: "instrumental" };

      // With lookups off, a queued lookup will not run, so it counts as no answer, as in old music.
      const waiting =
        lookup !== null &&
        current === null &&
        (await remoteLyricsOn(ctx.db)) &&
        (await activeJobFor(ctx.db, lookup)) !== null;

      return waiting ? { state: "pending" } : { state: "none" };
    };

    return resolve(local?.sets ?? [], await remote());
  },
  status: async (ctx, _args, caller) => {
    requireServer(caller, "configureLyrics");

    return { remote: await remoteLyricsOn(ctx.db) };
  },
  configure: async (ctx, { remote }, caller) => {
    requireServer(caller, "configureLyrics");

    await musicStore(ctx.db, meterFrom(NO_COST)).setRemoteLyrics(remote);
    // Off holds the kind, so no claim hands the server a lookup and no request reaches LRCLIB;
    // queued lookups stay and run when lookups are on again, as in old music.
    await holdKind(ctx, "music.lyrics", !remote);

    return null;
  },
  backfill: async (ctx, _args, caller) => {
    requireServer(caller, "configureLyrics");

    if (!(await remoteLyricsOn(ctx.db))) {
      return fail(
        "conflict",
        "Lyrics lookups on LRCLIB are off. Turn them on with music.lyrics.configure first",
      );
    }

    const reach = await reachOf(ctx.db, caller);
    const { gates } = await walkMusicLibraries(ctx.db, reach, callBudget(reach));
    const libraryIds = gates.map((gate) => gate.library._id);

    await startBackfill(ctx, libraryIds);

    return { libraries: libraryIds.length };
  },
});
