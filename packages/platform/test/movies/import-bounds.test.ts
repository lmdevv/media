import {
  IMPORT_COLLECTIONS_MAX,
  IMPORT_ITEMS_MAX,
  IMPORT_MEMBERS_MAX,
  IMPORT_PLAN_MAX,
} from "@media/contracts/server-functions";
import { describe, expect, it } from "vitest";

import { IMPORT_BOUNDS } from "../../convex/movies/bounds";

describe("the importer's write limits", () => {
  it("match what the server sends per call", () => {
    expect({
      items: IMPORT_BOUNDS.items,
      collections: IMPORT_BOUNDS.collections,
      members: IMPORT_BOUNDS.members,
      plan: {
        users: IMPORT_BOUNDS.users,
        pathMappings: IMPORT_BOUNDS.pathMappings,
        libraries: IMPORT_BOUNDS.libraries,
        libraryRoots: IMPORT_BOUNDS.libraryRoots,
      },
    }).toEqual({
      items: IMPORT_ITEMS_MAX,
      collections: IMPORT_COLLECTIONS_MAX,
      members: IMPORT_MEMBERS_MAX,
      plan: IMPORT_PLAN_MAX,
    });
  });
});
