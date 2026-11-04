import { ConvexError } from "convex/values";
import { describe, expect, it } from "vitest";

import { requireCaller } from "../../convex/core/lib/caller";

describe("requireCaller", () => {
  it("rejects every scoped call while the core has no sign-in", async () => {
    const auth = { getUserIdentity: async () => null };

    const rejection = await requireCaller({ auth }, "signed-in").then(
      () => undefined,
      (cause: unknown) => cause,
    );

    expect(rejection).toBeInstanceOf(ConvexError);
    expect(rejection).toMatchObject({ data: { code: "unauthenticated", scope: "signed-in" } });
  });
});
