import { createPlatform } from "@media/sdk/promise";
import { Predicate } from "effect";
import { expect, it } from "vitest";

import { SAVED_QUERIES } from "./held-home";

it.each(SAVED_QUERIES)("saves %s, a query the platform client follows", async (name) => {
  const platform = createPlatform({
    url: "http://127.0.0.1:9",
    signInUrl: "http://127.0.0.1:9/api/auth/sign-in",
    connection: "http",
  });

  const method = name
    .split(".")
    .reduce<unknown>(
      (node, part) => (Predicate.hasProperty(node, part) ? node[part] : undefined),
      platform,
    );

  expect(Predicate.hasProperty(method, "watch")).toBe(true);
  await platform.dispose();
});
