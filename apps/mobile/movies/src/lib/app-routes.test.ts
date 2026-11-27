import { fileURLToPath } from "node:url";

import { MOVIES_ROUTES } from "@media/contracts/app-routes";
import { routePatternsUnder } from "@media/mobile-core/testing/route-patterns";
import { describe, expect, it } from "vitest";

describe("route patterns", () => {
  it("lists every route pattern the app's route files make, and no other", () => {
    expect(routePatternsUnder(fileURLToPath(new URL("../app", import.meta.url)))).toEqual(
      MOVIES_ROUTES.toSorted(),
    );
  });
});
