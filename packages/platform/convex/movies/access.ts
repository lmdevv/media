import type { Level } from "../../commands/access";
import type { Doc, Id } from "../_generated/dataModel";
import type { DatabaseReader } from "../_generated/server";
import { fail } from "../core/lib/errors";
import { PAGE_ROWS_MAX } from "../core/lib/paginate";
import { levelOn, reachOf, visiblePage } from "../core/permissions/grants";
import type { ItemGate, Reach } from "../core/permissions/grants";
import { can, contentNeeds, itemOf, resourceOf } from "../core/permissions/policy";
import type { ContentAction, Principal } from "../core/permissions/policy";
import { titleFacts } from "./items";
import { libraryCheck, readsOf } from "./reads";
import type { ReadBudget } from "./reads";

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
const libraryGate = async (
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

/** Whether a title is seen, hidden, or could not be decided within the call's read budget. */
export type Seen = "seen" | "hidden" | "spent";

/** Decides titles for one call, charging each library's first check to the call's budget. */
export type BudgetedViewer = (title: Doc<"titles">) => Promise<Seen>;

/**
 * A `TitleViewer` that charges `budget` for each library it decides, once per library, and
 * answers `spent` instead of reading a library the budget cannot pay for.
 */
export const budgetedViewer = (
  db: DatabaseReader,
  caller: Principal,
  reach: Reach,
  budget: ReadBudget,
): BudgetedViewer => {
  const gates = new Map<Id<"libraries">, Promise<ItemGate | null>>();
  const cost = libraryCheck(reach);

  return async (title) => {
    if (title.purging === true) return "hidden";

    const known = gates.get(title.libraryId);

    if (known === undefined && !budget.take(cost)) return "spent";

    const gate = known ?? libraryGate(db, caller, reach, title.libraryId);

    gates.set(title.libraryId, gate);

    return (await gate)?.admits(titleFacts(title)) === true ? "seen" : "hidden";
  };
};

/** The movies libraries a walk found, and whether it reached the last library shared. */
export interface Walked {
  readonly gates: ReadonlyArray<ItemGate>;
  readonly complete: boolean;
}

/** How many of `reach`'s grant keys hold any library grant: one small query per key. */
const grantingKeys = async (db: DatabaseReader, reach: Reach): Promise<number> => {
  const found = await Promise.all(
    [...reach.direct, ...reach.groups].map(async (key) =>
      db
        .query("grants")
        .withIndex("by_principal_resource", (q) =>
          q.eq("principal", key).eq("resourceType", "library"),
        )
        .first(),
    ),
  );

  return found.filter((grant) => grant !== null).length;
};

/**
 * Every movies library shared with `caller`, in id order, each with the gate `can()` decides its
 * titles through. It pages the caller's grants with `visiblePage`, as many rows a step as both
 * `visiblePage`'s own sizing and `budget` allow, keeping each step's continuation, so music
 * libraries and libraries the caller cannot browse never push a movies library out. A step is
 * charged a range per grant key, rows only for the keys that hold library grants, and a read per
 * library considered. It stops only at the last library or when `budget` cannot pay for another
 * step, and says which.
 */
export const walkMovieLibraries = async (
  db: DatabaseReader,
  caller: Principal,
  reach: Reach,
  budget: ReadBudget,
): Promise<Walked> => {
  const keys = reach.direct.length + reach.groups.length;

  if (!budget.take(readsOf(keys, keys))) {
    return { gates: [], complete: false };
  }

  const granting = await grantingKeys(db, reach);

  return walkFrom(db, caller, reach, budget, granting, null, []);
};

const walkFrom = async (
  db: DatabaseReader,
  caller: Principal,
  reach: Reach,
  budget: ReadBudget,
  granting: number,
  cursor: string | null,
  found: ReadonlyArray<ItemGate>,
): Promise<Walked> => {
  const groups = reach.groups.length;
  const keys = reach.direct.length + groups;
  const room = budget.left();
  const fits = Math.floor((PAGE_ROWS_MAX - groups - keys) / (keys + 1));
  const documents = Math.min(room.documents, Math.floor(room.bytes / readsOf(0, 1).bytes));

  const rows = Math.min(
    fits,
    room.ranges - 1 - keys,
    Math.floor((documents - groups - granting) / (granting + 1)),
  );

  const step = readsOf(1 + keys + rows, groups + granting * (rows + 1) + rows);

  if (rows < 1 || !budget.take(step)) return { gates: found, complete: false };

  const page = await visiblePage({ db }, caller, "library", { numItems: rows, cursor });

  const gates = [
    ...found,
    ...page.page.flatMap(({ doc, level }) => {
      const gate = gateFor(caller, doc, level);

      return gate === null ? [] : [gate];
    }),
  ];

  return page.isDone
    ? { gates, complete: true }
    : walkFrom(db, caller, reach, budget, granting, page.continueCursor, gates);
};
