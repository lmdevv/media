import { describe, expect, it } from "vitest";

import { clearOf } from "./color";

describe("clearOf", () => {
  it("keeps the color and drops the alpha", () => {
    expect(clearOf("#ffffff")).toBe("#ffffff00");
    expect(clearOf("#1F1F1FEB")).toBe("#1F1F1F00");
    expect(clearOf("#000")).toBe("#00000000");
  });

  it("fades anything else to clear", () => {
    expect(clearOf("transparent")).toBe("transparent");
    expect(clearOf("rgb(0, 0, 0)")).toBe("transparent");
  });
});
