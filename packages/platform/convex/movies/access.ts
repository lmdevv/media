import type { Level } from "../../commands/access";
import type { Doc, Id } from "../_generated/dataModel";
import type { DatabaseReader } from "../_generated/server";
import { fail } from "../core/lib/errors";
import { levelOn, reachOf, visiblePage } from "../core/permissions/grants";
import type { ItemGate, Reach } from "../core/permissions/grants";
import { can, contentNeeds, itemOf, resourceOf } from "../core/permissions/policy";
import type { ContentAction, Principal } from "../core/permissions/policy";
import { titleFacts } from "./items";

/**
 * Most libraries shared with a caller that a list across libraries reads, music ones included:
 * home rows, search, genres, and the title list with no library named. Each one past it still
 * lists by name.
 */
export const BROWSABLE_LIBRARIES_MAX = 64;

const NO_TITLE = "No such title";

/** A title the caller may act on, its library, and the level their grants give them there. */
export interface TitleAccess {
  readonly title: Doc<"titles">;
  readonly library: Doc<"libraries">;
  readonly level: Level;
  readonly reach: Reach;
}

/**
 * Loads `titleId` and decides `action` on it for `caller` through `can()`, at the level their
 * grants give on its library and with its facts. A title being purged, one in no movies library,
 * and one the caller may not see all fail `not_found` alike; one they see but may not do this to
 * fails `forbidden`. Reads the title, its library, the caller's reach, and the library's grants.
 */
export const requireTitle = async (
  db: DatabaseReader,
  caller: Principal,
  action: ContentAction,
  titleId: Id<"titles">,
): Promise<TitleAccess> => {
  const [found, reach] = await Promise.all([db.get(titleId), reachOf(db, caller)]);
  const title = found?.purging === true ? null : found;
  const library = title === null ? null : await db.get(title.libraryId);

  if (title === null || library === null || library.kind !== "movies") {
    return fail("not_found", NO_TITLE);
  }

  const level = await levelOn(db, reach, { type: "library", id: library._id });
  const decision = can(caller, action, itemOf(library, level, titleFacts(title)));

  if (!decision.allowed) {
    const needs = contentNeeds(action, "movies");

    if (decision.refusal === "hidden") return fail("not_found", NO_TITLE);

    return fail(
      "forbidden",
      decision.because === "scope"
        ? `This session lacks the ${needs.scope} scope`
        : `This needs ${needs.level} access, and you have ${level ?? "none"}`,
    );
  }

  return level === null ? fail("not_found", NO_TITLE) : { title, library, level, reach };
};

const libraryRef = (library: Doc<"libraries">) => ({ type: "library", id: library._id }) as const;

const gateFor = (
  caller: Principal,
  library: Doc<"libraries">,
  level: Level | null,
): ItemGate | null =>
  library.kind !== "movies" ||
  level === null ||
  !can(caller, "view", resourceOf("library", library, level)).allowed
    ? null
    : {
        library,
        level,
        admits: (facts) => can(caller, "view", itemOf(library, level, facts)).allowed,
      };

/**
 * Whether `caller` may see titles, deciding each library once per call through `can()`. A title
 * being purged or in a library of another domain is not seen.
 */
export type TitleViewer = (title: Doc<"titles">) => Promise<boolean>;

/** A `TitleViewer` for one call, reading each library and its grants at most once. */
export const titleViewer = (db: DatabaseReader, caller: Principal, reach: Reach): TitleViewer => {
  const gates = new Map<Id<"libraries">, Promise<ItemGate | null>>();

  const gateOf = async (libraryId: Id<"libraries">): Promise<ItemGate | null> => {
    const library = await db.get(libraryId);

    return library === null
      ? null
      : gateFor(caller, library, await levelOn(db, reach, libraryRef(library)));
  };

  return async (title) => {
    if (title.purging === true) return false;

    const gate = gates.get(title.libraryId) ?? gateOf(title.libraryId);

    gates.set(title.libraryId, gate);

    return (await gate)?.admits(titleFacts(title)) ?? false;
  };
};

/**
 * The movies libraries shared with `caller`, in id order, each with the gate `can()` decides its
 * titles through. It reads the caller's grants, not every library, so it reaches the first
 * `BROWSABLE_LIBRARIES_MAX` libraries they may see however many the server holds.
 */
export const browsableLibraries = async (
  db: DatabaseReader,
  caller: Principal,
): Promise<ReadonlyArray<ItemGate>> => {
  const visible = await visiblePage({ db }, caller, "library", {
    numItems: BROWSABLE_LIBRARIES_MAX,
    cursor: null,
  });

  return visible.page.flatMap(({ doc, level }) => {
    const gate = gateFor(caller, doc, level);

    return gate === null ? [] : [gate];
  });
};
