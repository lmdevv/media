import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { hostOf, inviteLink, resetLink } from "./links";
import { ServerOrigin } from "./server";

const origin = Schema.decodeSync(ServerOrigin)("http://100.94.55.81:8093");

describe("links", () => {
  it("builds the invite and reset links the web app opens", () => {
    expect(inviteLink(origin, "abc123")).toBe("http://100.94.55.81:8093/invite/abc123");
    expect(resetLink(origin, "t/k")).toBe("http://100.94.55.81:8093/reset/t%2Fk");
  });

  it("names the server by its host", () => {
    expect(hostOf(origin)).toBe("100.94.55.81:8093");
  });
});
