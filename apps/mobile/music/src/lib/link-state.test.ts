import { Expired, NotFound } from "@media/contracts/errors";
import { describe, expect, it } from "vitest";

import { linkState } from "./link-state";

describe("linkState", () => {
  it("takes the core's word, except an open link past its time", () => {
    expect(linkState(undefined, 0)).toBe("loading");
    expect(linkState({ expiresAt: 10 }, 9)).toBe("open");
    expect(linkState({ expiresAt: 10 }, 10)).toBe("expired");
  });

  it("reads a used or run-out link as expired, and any other refusal as invalid", () => {
    expect(linkState(new Expired({ message: "This link no longer works" }), 0)).toBe("expired");
    expect(linkState(new NotFound({ message: "No such link" }), 0)).toBe("invalid");
  });
});
