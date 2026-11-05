import { itemTypes } from "../../../commands/access";
import type { DomainItem, ItemType, Level } from "../../../commands/access";
import type { Doc, Id } from "../../_generated/dataModel";
import type { DatabaseReader } from "../../_generated/server";
import { probeFacts } from "../libraryProbe";
import { fail } from "../lib/errors";
import { levelOn } from "./grants";
import { can, itemOf } from "./policy";
import type { ContentFacts, Principal } from "./policy";

type RefOf<T extends ItemType> = Extract<DomainItem["ref"], { readonly type: T }>;

type IdOf = { readonly [T in ItemType]: RefOf<T>["id"] };

/** An item's library, and the facts restrictions read about it. */
interface Placed {
  readonly library: Doc<"libraries">;
  readonly facts: ContentFacts;
}

/**
 * One loader per item type, or this fails to compile: a domain that adds an item type adds its
 * loader here. Each answers null for a missing row or one outside its type's domain.
 */
type Loaders = {
  readonly [T in ItemType]: (db: DatabaseReader, id: IdOf[T]) => Promise<Placed | null>;
};

/** A probe item, when its library holds the content of `type`'s domain. */
const probeOf =
  (type: ItemType) =>
  async (db: DatabaseReader, id: Id<"probeItems">): Promise<Placed | null> => {
    const row = await db.get(id);
    const library = row === null ? null : await db.get(row.libraryId);

    return row !== null && library?.kind === itemTypes[type].domain
      ? { library, facts: probeFacts(library, row) }
      : null;
  };

const loaders: Loaders = {
  probeMovie: probeOf("probeMovie"),
  probeTrack: probeOf("probeTrack"),
};

const placeOf = <T extends ItemType>(
  db: DatabaseReader,
  ref: { readonly type: T; readonly id: IdOf[T] },
): Promise<Placed | null> => loaders[ref.type](db, ref.id);

/**
 * Decides for `viewer` whether they may play each item asked about: it exists in a library of its
 * domain, and `can` allows `play` on it at the level their grants give on that library. Reads each
 * item and its library, and each library's grants once per checker.
 */
export const playableBy = (
  db: DatabaseReader,
  viewer: Principal,
): ((item: DomainItem) => Promise<boolean>) => {
  const levels = new Map<Id<"libraries">, Promise<Level | null>>();

  return async (item) => {
    const placed = await placeOf(db, item.ref);

    if (placed === null) return false;

    const { library } = placed;

    const level =
      levels.get(library._id) ?? levelOn(db, viewer, { type: "library", id: library._id });

    levels.set(library._id, level);

    return can(viewer, "play", itemOf(library, await level, placed.facts)).allowed;
  };
};

/** Refuses an item `viewer` may not play as if it did not exist. */
export const requirePlayable = async (
  db: DatabaseReader,
  viewer: Principal,
  item: DomainItem,
): Promise<void> => {
  if (!(await playableBy(db, viewer)(item))) fail("not_found", "No such item");
};
