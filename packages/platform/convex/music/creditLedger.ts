import {
  MAX_CREDIT_OVERRIDES,
  MAX_CREDIT_PARTS,
  MAX_KEPT_PARTS,
  creditParts,
  creditRuns,
  distinctNames,
  isCombined,
  resolveCredit,
  staysWhole,
} from "@media/contracts/artist-credits";
import type { CreditOverride } from "@media/contracts/artist-credits";

import type { Id } from "../_generated/dataModel";
import { inOrder } from "../core/lib/inOrder";
import { cost, repeated, sumCost } from "./budget";
import type { Cost } from "./budget";
import { keyOf, resolvedWithin } from "./fit";
import { atBound } from "./write";
import type { MusicStore, Stored } from "./write";

/**
 * A library's credit strings in one mutation, through the music store (ADR 0024, "Artist
 * credits"): how each resolves, which songs and albums name it, and the evidence they make. A
 * string resolves from the library as the mutation found it, so a name that gains or loses its
 * last whole credit in the mutation changes no string the mutation resolves; `settle` answers the
 * names whose evidence changed, and the caller rechecks every combined string they are part of
 * (`music/credits:recheck`) once the mutation commits. Only songs on disk and albums with a song
 * on disk use a string: a missing file's tags are not the library's now. Resolved credits
 * therefore depend only on the tags of the library's files on disk and its managers' corrections,
 * never on the order the tags arrived in.
 */

/** The most names one scheduled recheck carries (`music/credits:recheck`). */
export const RECHECK_KEYS = 64;

/** A name's share of scheduling a recheck: a write, and its key at a key's longest. */
export const SCHEDULING = cost(0, 1, 0, 1600);

/**
 * Settling a credit string of one part at a call's end: its row read, when nothing earlier in the
 * call read it, then inserted, patched, or deleted, and a recheck of the combined strings it is
 * part of when its evidence changed.
 */
export const SINGLE_SETTLING = sumCost([
  atBound.read("artistCredits"),
  atBound.patch("artistCredits"),
  SCHEDULING,
]);

/** Settling a combined credit string: also its parts' rows, inserted or found and deleted. */
export const COMBINED_SETTLING = sumCost([
  SINGLE_SETTLING,
  repeated(atBound.read("creditParts"), MAX_CREDIT_PARTS),
  repeated(atBound.delete("creditParts"), MAX_CREDIT_PARTS),
]);

/** Runs of two to `MAX_KEPT_PARTS` parts in a string of `MAX_CREDIT_PARTS` parts. */
const RUNS_LOOKED_UP = Array.from(
  { length: MAX_KEPT_PARTS - 1 },
  (_, longer) => MAX_CREDIT_PARTS - longer - 1,
).reduce((sum, runs) => sum + runs, 0);

/**
 * Resolving one credit string fresh: its row, and the rows of its parts and of its runs of up to
 * `MAX_KEPT_PARTS` parts, each read once a call. The library's corrections are read before the
 * call's first item (`prepare`).
 */
export const RESOLVING = repeated(
  atBound.read("artistCredits"),
  1 + MAX_CREDIT_PARTS + RUNS_LOOKED_UP,
);

/** Recording one song's gained or lost use of a combined string: its row found, then written. */
export const USE_RECORDING = sumCost([
  atBound.read("creditTracks"),
  atBound.delete("creditTracks"),
]);

/** How a song's or an album's tags changed which credit strings they name. */
export interface CreditUse {
  /** The song naming them, whose combined strings find it again; null for an album. */
  readonly trackId: Id<"tracks"> | null;
  readonly gained: ReadonlyArray<string>;
  readonly lost: ReadonlyArray<string>;
}

export interface CreditLedger {
  /** Reads the library's corrections, which every fresh resolution needs, once a call. */
  readonly prepare: () => Promise<void>;
  /**
   * The artists `text` credits now: as its row stores them, or, for a string the library does not
   * name yet, resolved fresh, which `settle` stores with its row.
   */
  readonly artistsOf: (text: string) => Promise<ReadonlyArray<string>>;
  /** How `text` resolves from the library's evidence as the call found it, whatever is stored. */
  readonly resolveFresh: (text: string) => Promise<ReadonlyArray<string>>;
  /** The row of a credit string by key, as the call found it, read once a call. */
  readonly row: (key: string) => Promise<Stored<"artistCredits"> | null>;
  /** Records which credit strings a song's or an album's tags gained and lost. */
  readonly use: (change: CreditUse) => Promise<void>;
  /**
   * Settles the call's uses: inserts, patches, and deletes each string's row and its parts' rows.
   * Answers the keys of the names whose evidence changed: a name of one part that gained its first
   * whole credit or lost its last, and the first part of a combined string that stays whole and
   * so keeps its parts together in longer credits.
   */
  readonly settle: () => Promise<ReadonlyArray<string>>;
}

interface Found {
  readonly row: Stored<"artistCredits"> | null;
  /** Its uses as the call found it. */
  readonly committed: number;
}

/**
 * The credit strings of `libraryId` in one mutation, charging `owe` once a call for each string
 * whose row `settle` writes.
 */
export const creditLedger = (
  store: MusicStore,
  libraryId: Id<"libraries">,
  owe: (key: string, work: Cost) => void,
): CreditLedger => {
  const found = new Map<string, Promise<Found>>();
  const fresh = new Map<string, ReadonlyArray<string>>();
  const deltas = new Map<string, { readonly text: string; readonly uses: number }>();
  let overrides: Promise<ReadonlyMap<string, CreditOverride>> | null = null;

  const lookup = (key: string): Promise<Found> => {
    const known = found.get(key);

    if (known !== undefined) return known;

    const read = store
      .first("artistCredits", (q) =>
        q.withIndex("by_library_key", (index) => index.eq("libraryId", libraryId).eq("key", key)),
      )
      .then((row) => ({ row, committed: row?.uses ?? 0 }));

    found.set(key, read);

    return read;
  };

  const overridesOf = (): Promise<ReadonlyMap<string, CreditOverride>> => {
    overrides ??= store
      .take(
        "creditOverrides",
        (q) => q.withIndex("by_library_key", (index) => index.eq("libraryId", libraryId)),
        MAX_CREDIT_OVERRIDES,
      )
      .then((rows) => new Map(rows.map((row) => [row.key, row.mode])));

    return overrides;
  };

  const resolveFresh = async (text: string): Promise<ReadonlyArray<string>> => {
    if (!isCombined(text)) return distinctNames([text]);

    const names = [
      ...creditParts(text).map((part) => part.name),
      ...creditRuns(text, MAX_KEPT_PARTS),
    ];

    const [corrections, rows] = await Promise.all([
      overridesOf(),
      Promise.all(names.map(async (name) => [keyOf(name), await lookup(keyOf(name))] as const)),
    ]);

    const evidence = new Map(rows);

    return resolvedWithin(
      resolveCredit(text, {
        known: (name) => (evidence.get(keyOf(name))?.committed ?? 0) > 0,
        kept: (name) => {
          const key = keyOf(name);
          const one = evidence.get(key);

          return (
            corrections.get(key) === "together" ||
            (one?.row !== null &&
              one?.row !== undefined &&
              one.committed > 0 &&
              staysWhole(one.row.text, one.row.artists))
          );
        },
        override: (name) => corrections.get(keyOf(name)) ?? null,
      }),
    );
  };

  const artistsOf = async (text: string): Promise<ReadonlyArray<string>> => {
    if (!isCombined(text)) return distinctNames([text]);

    const key = keyOf(text);
    const { row } = await lookup(key);

    if (row !== null) return row.artists;

    const known = fresh.get(key);

    if (known !== undefined) return known;

    const artists = await resolveFresh(text);

    fresh.set(key, artists);

    return artists;
  };

  const tracksRow = (key: string, trackId: Id<"tracks">) =>
    store.first("creditTracks", (q) =>
      q.withIndex("by_library_credit", (index) =>
        index.eq("libraryId", libraryId).eq("creditKey", key).eq("trackId", trackId),
      ),
    );

  const move = async (text: string, step: 1 | -1, trackId: Id<"tracks"> | null): Promise<void> => {
    const key = keyOf(text);
    const previous = deltas.get(key);

    owe(`credit:${key}`, isCombined(text) ? COMBINED_SETTLING : SINGLE_SETTLING);
    deltas.set(key, { text: previous?.text ?? text, uses: (previous?.uses ?? 0) + step });

    if (trackId === null || !isCombined(text)) return;

    const row = await tracksRow(key, trackId);

    if (step === 1 && row === null) {
      await store.insertCreditTrack({ libraryId, creditKey: key, trackId });
    } else if (step === -1 && row !== null) {
      await store.deleteCreditTrack(row._id);
    }
  };

  const partRows = (key: string, text: string) =>
    distinctNames(creditParts(text).map((part) => part.name)).map((name) => ({
      libraryId,
      partKey: keyOf(name),
      creditKey: key,
    }));

  const settleOne = async (key: string, text: string, uses: number): Promise<string | null> => {
    const { row, committed } = await lookup(key);
    const next = Math.max(0, committed + uses);
    const combined = isCombined(text);
    let artists = row?.artists ?? distinctNames([text]);

    if (row === null && next > 0) {
      artists = combined ? (fresh.get(key) ?? (await resolveFresh(text))) : distinctNames([text]);
      await store.insertCredit({
        libraryId,
        key,
        text,
        combined,
        uses: next,
        artists: [...artists],
      });
      await Promise.all(
        (combined ? partRows(key, text) : []).map(async (part) => store.insertCreditPart(part)),
      );
    } else if (row !== null && next === 0) {
      await store.deleteCredit(row._id);
      await Promise.all(
        (row.combined ? partRows(key, row.text) : []).map(async (part) => {
          const stale = await store.first("creditParts", (q) =>
            q.withIndex("by_library_part", (index) =>
              index
                .eq("libraryId", libraryId)
                .eq("partKey", part.partKey)
                .eq("creditKey", part.creditKey),
            ),
          );

          if (stale !== null) await store.deleteCreditPart(stale._id);
        }),
      );
    } else if (row !== null && next !== row.uses) {
      await store.setCreditUses(row._id, next);
    }

    if (committed > 0 === next > 0) return null;

    const parts = creditParts(row?.text ?? text);
    const first = parts[0];

    if (parts.length === 1) return key;

    return first !== undefined &&
      parts.length <= MAX_KEPT_PARTS &&
      staysWhole(row?.text ?? text, artists)
      ? keyOf(first.name)
      : null;
  };

  return {
    prepare: async () => {
      await overridesOf();
    },
    artistsOf,
    resolveFresh,
    row: async (key) => (await lookup(key)).row,
    use: async ({ trackId, gained, lost }) => {
      await inOrder(lost, async (text) => move(text, -1, trackId));
      await inOrder(gained, async (text) => move(text, 1, trackId));
    },
    settle: async () => {
      const settled = await inOrder([...deltas], async ([key, { text, uses }]) =>
        uses === 0 ? null : settleOne(key, text, uses),
      );

      deltas.clear();

      return [...new Set(settled.filter((key) => key !== null))];
    },
  };
};
