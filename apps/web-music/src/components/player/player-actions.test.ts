import { describe, expect, it } from "vitest";

import { thisBrowserKind } from "./player-actions";

describe("thisBrowserKind", () => {
  it("counts an iPhone or an Android phone as a phone, and a computer or tablet as a browser", () => {
    expect(thisBrowserKind("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)")).toBe("phone");
    expect(thisBrowserKind("Mozilla/5.0 (Linux; Android 15) Mobile Safari/537.36")).toBe("phone");
    expect(thisBrowserKind("Mozilla/5.0 (Linux; Android 15) Safari/537.36")).toBe("web");
    expect(thisBrowserKind("Mozilla/5.0 (X11; Linux x86_64) Chrome/140.0")).toBe("web");
  });
});
