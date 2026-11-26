import { describe, expect, it } from "vitest";

import { commands } from "../src/index.ts";

describe("the core's commands", () => {
  it("let a caller with no session reach only these, so there is no open sign-up", () => {
    // Revoking proves itself with the session's own refresh token, so it needs no session.
    // Presence says only whether the media server beats, less than its open health route says.
    expect(
      commands.filter((command) => command.scope === "public").map((command) => command.name),
    ).toEqual([
      "core.server.info",
      "core.server.presence",
      "core.auth.sessions.revoke",
      "core.auth.deviceCodes.start",
      "core.accounts.invites.lookup",
      "core.accounts.resetLinks.lookup",
      "core.devices.picker.show",
      "core.devices.approvals.request",
    ]);
  });
});
