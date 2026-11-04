import { describe, expect, it } from "vitest";

import { linkState } from "./link-state";

describe("linkState", () => {
  it("takes the server's word, except an open link past its time", () => {
    expect(linkState({ state: "open", expiresAt: 10 }, 9)).toBe("open");
    expect(linkState({ state: "open", expiresAt: 10 }, 10)).toBe("expired");
    expect(linkState({ state: "used", expiresAt: 10 }, 99)).toBe("used");
    expect(linkState({ state: "invalid" }, 0)).toBe("invalid");
  });
});
