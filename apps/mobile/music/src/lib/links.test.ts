import { describe, expect, it } from "vitest";

import { hostOf, inviteLink, resetLink } from "./links";

const server = "http://100.94.55.81:8093";

describe("links", () => {
  it("builds the account client's invite and reset links, the code after #", () => {
    expect(inviteLink(server, "mi_abc.123")).toBe("http://100.94.55.81:8093/invite#mi_abc.123");
    expect(resetLink(server, "mr_abc.123")).toBe("http://100.94.55.81:8093/reset#mr_abc.123");
  });

  it("names the server by its host", () => {
    expect(hostOf(server)).toBe("100.94.55.81:8093");
  });
});
