import { KeychainWriteFailed } from "./keychain";
import { describe, expect, it } from "vitest";

import { describeFailure } from "./failure";

describe("describeFailure", () => {
  it("asks to unlock the iPhone when the keychain refused the sign-in's records", () => {
    expect(
      describeFailure(new KeychainWriteFailed({ key: "media.app.x", message: "refused" })),
    ).toBe("This iPhone couldn’t save your sign-in. Unlock it and try again.");
  });
});
