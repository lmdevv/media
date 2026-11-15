import { describe, expect, it } from "vitest";

import { deviceKind, thisBrowserKind } from "./player-actions";

describe("deviceKind", () => {
  it("tells a computer's browser by the name the account client gave it", () => {
    expect(deviceKind("Firefox on Linux")).toBe("web");
    expect(deviceKind("Safari on iPad")).toBe("web");
    expect(deviceKind("Chrome")).toBe("web");
    expect(deviceKind("Browser on Windows")).toBe("web");
  });

  it("counts a browser on a phone as a phone, as old music did", () => {
    expect(deviceKind("Safari on iPhone")).toBe("phone");
    expect(deviceKind("Chrome on Android")).toBe("phone");
  });

  it("takes any other name for the phone app", () => {
    expect(deviceKind("Aiko's iPhone")).toBe("phone");
    expect(deviceKind("Chrome cast in the kitchen")).toBe("phone");
  });
});

describe("thisBrowserKind", () => {
  it("counts an iPhone or an Android phone as a phone, and a computer or tablet as a browser", () => {
    expect(thisBrowserKind("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)")).toBe("phone");
    expect(thisBrowserKind("Mozilla/5.0 (Linux; Android 15) Mobile Safari/537.36")).toBe("phone");
    expect(thisBrowserKind("Mozilla/5.0 (Linux; Android 15) Safari/537.36")).toBe("web");
    expect(thisBrowserKind("Mozilla/5.0 (X11; Linux x86_64) Chrome/140.0")).toBe("web");
  });
});
