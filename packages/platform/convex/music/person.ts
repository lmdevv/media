import type { Doc, Id } from "../_generated/dataModel";
import type { DatabaseReader } from "../_generated/server";
import { fail } from "../core/lib/errors";
import type { Reach } from "../core/permissions/grants";
import { callReads } from "../movies/reads";
import { CALL_COST, addCost, cost, meterFrom } from "./budget";
import type { Cost, Meter } from "./budget";
import { libraryGates, trackPlayer } from "./access";
import { DOCUMENT_BYTES, TABLE_BYTES } from "./fit";
import { trackFacts } from "./items";
import type { MusicStore } from "./write";

/**
 * What a person's music mutations share: a meter that starts at what every call reads before its
 * own rows, deciding tracks on that meter, and reading many tracks without passing Convex's
 * limits whatever they hold (ADR 0005, ADR 0024).
 */

/** Songs one command takes at most, as old music's `TrackIds` did. */
const TRACKS_IN_MAX = 2000;

/** Refuses a list of songs that is empty or longer than `max`. */
export const requireTrackIds = (
  trackIds: ReadonlyArray<Id<"tracks">>,
  max: number = TRACKS_IN_MAX,
): void => {
  if (trackIds.length === 0 || trackIds.length > max) {
    fail("invalid_args", `Name 1 to ${max} songs`);
  }
};

/** A meter that starts at what the caller, their session, and their reach cost to read. */
export const personMeter = (reach: Reach): Meter => {
  const fixed = callReads(reach);

  return meterFrom(cost(fixed.ranges, 0, fixed.bytes));
};

/** What deciding a library for the caller of `reach` reads: it, and one grant query a key. */
const libraryCost = (reach: Reach): Cost => {
  const keys = reach.direct.length + reach.groups.length;

  return cost(1 + keys, 0, (1 + keys) * DOCUMENT_BYTES.small);
};

/**
 * What deciding one track for a guest reads at most (`playableBy`): the track and its library
 * again, whether their link covers it, and its album, then the same for their link's maker with
 * the maker's grants on the library.
 */
const GUEST_TRACK_COST = cost(
  24,
  0,
  2 * TABLE_BYTES.tracks + TABLE_BYTES.albums + 24 * DOCUMENT_BYTES.small,
);

/** Decides one action on tracks and says what one decision may cost beyond the track itself. */
export interface Decider {
  readonly decide: (track: Doc<"tracks">) => Promise<boolean>;
  readonly most: Cost;
}

/**
 * Decides `play` on tracks as `trackPlayer` does, charging `meter` for what it reads: each
 * library once for a person, and every track for a guest, whose decisions read again.
 */
export const playDecider = (db: DatabaseReader, reach: Reach, meter: Meter): Decider => {
  const player = trackPlayer(db, reach, () => {
    meter.charge(libraryCost(reach));
  });

  if (reach.lent === null) return { decide: player, most: libraryCost(reach) };

  return {
    decide: async (track) => {
      meter.charge(GUEST_TRACK_COST);

      return player(track);
    },
    most: GUEST_TRACK_COST,
  };
};

/**
 * Decides `view` on tracks through their libraries' grants and each track's facts, charging
 * `meter` for each library once.
 */
export const viewDecider = (db: DatabaseReader, reach: Reach, meter: Meter): Decider => {
  const gates = libraryGates(db, reach, "view", () => {
    meter.charge(libraryCost(reach));
  });

  return {
    decide: async (track) => (await gates(track.libraryId))?.admits(trackFacts(track)) ?? false,
    most: libraryCost(reach),
  };
};

/** A track asked for, as read, and whether the decider allowed it. */
export interface Decided {
  readonly id: Id<"tracks">;
  readonly track: Doc<"tracks"> | null;
  readonly allowed: boolean;
}

/** How many more of something costing `per` fit between `used` and `limit`. */
const left = (limit: number, used: number, per: number): number =>
  per === 0 ? Number.POSITIVE_INFINITY : Math.floor((limit - used) / per);

const roomFor = (meter: Meter, reserve: Cost, each: Cost): number => {
  const spent = addCost(meter.spent(), reserve);

  return Math.min(
    left(CALL_COST.work.ranges, spent.work.ranges, each.work.ranges),
    left(CALL_COST.readBytes, spent.readBytes, each.readBytes),
  );
};

/**
 * Reads `ids` through the store in order and decides each, a chunk at a time: as many as the
 * meter can still pay for, each at the track bound with its decision's worst case, keeping
 * `reserve` for the rest of the call. Each read and decision is charged at what it really cost,
 * so a library decided once makes the next chunk larger, and the call stays inside Convex's limits
 * whatever the tracks hold. Real tracks are far below their bound, so 2,000 fit in a call; when
 * the meter cannot pay for one more, the call is refused with `invalid_args` before it writes.
 */
export const readDecided = async (
  store: MusicStore,
  decider: Decider,
  ids: ReadonlyArray<Id<"tracks">>,
  reserve: Cost,
  done: ReadonlyArray<Decided> = [],
): Promise<ReadonlyArray<Decided>> => {
  if (ids.length === 0) return done;

  const each = addCost(cost(1, 0, TABLE_BYTES.tracks), decider.most);
  const count = Math.min(ids.length, roomFor(store.meter, reserve, each));

  if (count < 1)
    return fail("invalid_args", "These songs are too many to take at once; send fewer");

  const chunk = ids.slice(0, count);
  const read = await Promise.all(chunk.map(async (id) => store.get("tracks", id)));

  const decided = await Promise.all(
    chunk.map(async (id, index) => {
      const track = read[index] ?? null;

      return { id, track, allowed: track !== null && (await decider.decide(track)) };
    }),
  );

  return readDecided(store, decider, ids.slice(count), reserve, [...done, ...decided]);
};
