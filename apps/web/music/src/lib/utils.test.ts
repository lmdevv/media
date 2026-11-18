import { describe, expect, it } from "vitest";

import { cn } from "./utils";

describe("cn", () => {
  it("keeps a colour beside a token font size", () => {
    expect(cn("text-text", "text-md")).toBe("text-text text-md");
    expect(cn("text-text-muted", "text-phone-body")).toBe("text-text-muted text-phone-body");
  });

  it("lets a later token font size replace an earlier one", () => {
    expect(cn("text-sm", "text-phone-large-title")).toBe("text-phone-large-title");
  });

  it("keeps a border colour beside a token border width", () => {
    expect(cn("border-hairline", "border-border")).toBe("border-hairline border-border");
    expect(cn("border-b-hairline border-border", "border-b-field")).toBe(
      "border-border border-b-field",
    );
  });

  it("lets a token radius, shadow, or spacing replace the default", () => {
    expect(cn("rounded-md", "rounded-phone-art")).toBe("rounded-phone-art");
    expect(cn("shadow-sm", "shadow-dialog")).toBe("shadow-dialog");
    expect(cn("pt-4", "pt-safe-top")).toBe("pt-safe-top");
    expect(cn("max-w-dialog", "max-w-vw-inset")).toBe("max-w-vw-inset");
  });
});
