import { describe, expect, it } from "vitest";

import { commands } from "../src/index.ts";

describe("the core's commands", () => {
  it("let a caller with no session reach only these, so there is no open sign-up", () => {
    expect(
      commands.filter((command) => command.scope === "public").map((command) => command.name),
    ).toEqual([
      "core.server.info",
      "core.auth.deviceCodes.start",
      "core.accounts.invites.lookup",
      "core.accounts.resetLinks.lookup",
    ]);
  });
});
