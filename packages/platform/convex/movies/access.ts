import type { Level } from "../../commands/access";
import type { Doc, Id } from "../_generated/dataModel";
import type { DatabaseReader } from "../_generated/server";
import { fail } from "../core/lib/errors";
import { levelOn, reachOf, visiblePage } from "../core/permissions/grants";
import type { ItemGate, Reach } from "../core/permissions/grants";
import { can, contentNeeds, itemOf, resourceOf } from "../core/permissions/policy";
import type { ContentAction, Principal } from "../core/permissions/policy";
import { titleFacts } from "./items";

const BROWSABLE_LIBRARIES_MAX = 64;

const NO_TITLE = "No such title";

/** A title the caller may act on, its library, and the level their grants give them there. */
export interface TitleAccess {
  readonly title: Doc<"titles">;
  readonly library: Doc<"libraries">;
  readonly level: Level;
  readonly reach: Reach;
}

type Decided =
  | { readonly kind: "missing" }
  | {
      readonly kind: "refused";
      readonly refusal: "hidden" | "forbidden";
      readonly scope: boolean;
      readonly level: Level | null;
    }
  | { readonly kind: "allowed"; readonly access: TitleAccess };

const decideTitle = async (
  db: DatabaseReader,
  caller: Principal,
  action: ContentAction,
  titleId: Id<"titles">,
): Promise<Decided> => {
  const [found, reach] = await Promise.all([db.get(titleId), reachOf(db, caller)]);
  const title = found?.purging === true ? null : found;
  const library = title === null ? null : await db.get(title.libraryId);

  if (title === null || library === null || library.kind !== "movies") return { kind: "missing" };

  const level = await levelOn(db, reach, { type: "library", id: library._id });
  const decision = can(caller, action, itemOf(library, level, titleFacts(title)));

  if (!decision.allowed) {
    return {
      kind: "refused",
      refusal: decision.refusal,
      scope: decision.because === "scope",
      level,
    };
  }

  return level === null
    ? { kind: "missing" }
    : { kind: "allowed", access: { title, library, level, reach } };
};

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
  const decided = await decideTitle(db, caller, action, titleId);

  if (decided.kind === "allowed") return decided.access;

  if (decided.kind === "missing" || decided.refusal === "hidden") {
    return fail("not_found", NO_TITLE);
  }

  const needs = contentNeeds(action, "movies");

  return fail(
    "forbidden",
    decided.scope
      ? `This session lacks the ${needs.scope} scope`
      : `This needs ${needs.level} access, and you have ${decided.level ?? "none"}`,
  );
};

/** Whether `caller` may do `action` to `titleId`, decided as `requireTitle` decides it. */
export const mayActOnTitle = async (
  db: DatabaseReader,
  caller: Principal,
  action: ContentAction,
  titleId: Id<"titles">,
): Promise<boolean> => (await decideTitle(db, caller, action, titleId)).kind === "allowed";

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

/** The gate of one library for `caller`, or null when it is not a movies library they see. */
export const libraryGate = async (
  db: DatabaseReader,
  caller: Principal,
  reach: Reach,
  libraryId: Id<"libraries">,
): Promise<ItemGate | null> => {
  const library = await db.get(libraryId);

  return library === null
    ? null
    : gateFor(caller, library, await levelOn(db, reach, libraryRef(library)));
};

/**
 * Whether `caller` may see titles, deciding each library once per call through `can()`. A title
 * being purged or in a library of another domain is not seen.
 */
export type TitleViewer = (title: Doc<"titles">) => Promise<boolean>;

/** A `TitleViewer` for one call, reading each library and its grants at most once. */
export const titleViewer = (db: DatabaseReader, caller: Principal, reach: Reach): TitleViewer => {
  const gates = new Map<Id<"libraries">, Promise<ItemGate | null>>();

  return async (title) => {
    if (title.purging === true) return false;

    const gate = gates.get(title.libraryId) ?? libraryGate(db, caller, reach, title.libraryId);

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

/** Shared libraries one step of a library walk reads, music ones included. */
const WALK_STEP = 16;

/** Pages of shared libraries one call reads while looking for the next movies library. */
const WALK_PAGES_MAX = 4;

/**
 * Where a walk through the libraries shared with a caller goes next: a movies library's gate,
 * the last library read when the call's reads ran out first, or the end.
 */
export type NextLibrary =
  | { readonly kind: "library"; readonly gate: ItemGate }
  | { readonly kind: "resume"; readonly after: Id<"libraries"> }
  | { readonly kind: "end" };

/**
 * The first movies library shared with `caller` whose id comes after `after`, or the first one
 * at all for null, read through `visiblePage` over the caller's grants. One call reads a few
 * pages at most and then answers where to resume, so it stays bounded however many libraries the
 * caller sees and never ends a walk early.
 */
export const nextBrowsableLibrary = async (
  db: DatabaseReader,
  caller: Principal,
  after: Id<"libraries"> | null,
  pages = WALK_PAGES_MAX,
): Promise<NextLibrary> => {
  const visible = await visiblePage({ db }, caller, "library", {
    numItems: WALK_STEP,
    cursor: after,
  });

  const gate = visible.page
    .map(({ doc, level }) => gateFor(caller, doc, level))
    .find((found) => found !== null);

  if (gate !== undefined) return { kind: "library", gate };

  const last =
    visible.continueCursor === "" ? null : db.normalizeId("libraries", visible.continueCursor);

  if (visible.isDone || last === null) return { kind: "end" };

  return pages <= 1
    ? { kind: "resume", after: last }
    : nextBrowsableLibrary(db, caller, last, pages - 1);
};
