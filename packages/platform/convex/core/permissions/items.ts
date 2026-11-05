import { itemTypes } from "../../../commands/access";
import type { DomainItem, ItemType, Level } from "../../../commands/access";
import type { Doc, Id } from "../../_generated/dataModel";
import type { DatabaseReader } from "../../_generated/server";
import { probeFacts } from "../libraryProbe";
import { fail } from "../lib/errors";
import { levelOn, reachOf } from "./grants";
import type { Reach } from "./grants";
import { can, itemOf } from "./policy";
import type { ContentFacts, Principal } from "./policy";

type RefOf<T extends ItemType> = Extract<DomainItem["ref"], { readonly type: T }>;

type IdOf = { readonly [T in ItemType]: RefOf<T>["id"] };

/** An item's library, and the facts restrictions read about it. */
interface Placed {
  readonly library: Doc<"libraries">;
  readonly facts: ContentFacts;
}

/** How one item type is placed: a loader, and the most documents it reads. */
interface Loader<T extends ItemType> {
  readonly reads: number;
  readonly load: (db: DatabaseReader, id: IdOf[T]) => Promise<Placed | null>;
}

/**
 * One loader per item type, or this fails to compile: a domain that adds an item type adds its
 * loader here. Each answers null for a missing row or one outside its type's domain.
 */
type Loaders = { readonly [T in ItemType]: Loader<T> };

type ProbeType = "probeMovie" | "probeTrack";

/** A probe item, when its library holds the content of `type`'s domain. */
const probeOf = (type: ProbeType): Loader<ProbeType> => ({
  reads: 2,
  load: async (db, id) => {
    const row = await db.get(id);
    const library = row === null ? null : await db.get(row.libraryId);

    return row !== null && library?.kind === itemTypes[type].domain
      ? { library, facts: probeFacts(library, row) }
      : null;
  },
});

const loaders: Loaders = {
  probeMovie: probeOf("probeMovie"),
  probeTrack: probeOf("probeTrack"),
};

/** The most documents placing one item reads, besides its library's grants. */
export const ITEM_READS = Math.max(...Object.values(loaders).map((loader) => loader.reads));

const placeOf = <T extends ItemType>(
  db: DatabaseReader,
  ref: { readonly type: T; readonly id: IdOf[T] },
): Promise<Placed | null> => loaders[ref.type].load(db, ref.id);

/**
 * Decides for the principal of `reach` whether they may play each item asked about: it exists in
 * a library of its domain, and `can` allows `play` on it at the level their grants give on that
 * library. One checker reads each library's grants once.
 */
export const playableBy = (
  db: DatabaseReader,
  reach: Reach,
): ((item: DomainItem) => Promise<boolean>) => {
  const levels = new Map<Id<"libraries">, Promise<Level | null>>();

  return async (item) => {
    const placed = await placeOf(db, item.ref);

    if (placed === null) return false;

    const { library } = placed;

    const level =
      levels.get(library._id) ?? levelOn(db, reach, { type: "library", id: library._id });

    levels.set(library._id, level);

    return can(reach.principal, "play", itemOf(library, await level, placed.facts)).allowed;
  };
};

/** Whether `viewer` may play `item`, for a call that decides one item. */
export const mayPlay = async (
  db: DatabaseReader,
  viewer: Principal,
  item: DomainItem,
): Promise<boolean> => playableBy(db, await reachOf(db, viewer))(item);

/** Refuses an item `viewer` may not play as if it did not exist. */
export const requirePlayable = async (
  db: DatabaseReader,
  viewer: Principal,
  item: DomainItem,
): Promise<void> => {
  if (!(await mayPlay(db, viewer, item))) fail("not_found", "No such item");
};
