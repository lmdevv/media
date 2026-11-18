import { describe, expect, it } from "vitest";

import { cn } from "./utils";

describe("cn", () => {
  it("keeps a theme text size next to a theme text color", () => {
    expect(cn("text-micro/3.5", "text-on-accent")).toBe("text-micro/3.5 text-on-accent");
    expect(cn("text-label/label text-danger")).toBe("text-label/label text-danger");
  });

  it("still lets a later class of the same group win", () => {
    expect(cn("text-label", "text-body")).toBe("text-body");
    expect(cn("rounded-control", "rounded-pill")).toBe("rounded-pill");
    expect(cn("text-text", "text-danger")).toBe("text-danger");
  });

  it("knows the labelled theme literals", () => {
    expect(cn("text-small/5", "text-text-muted")).toBe("text-small/5 text-text-muted");
    expect(cn("font-hero", "text-text")).toBe("font-hero text-text");
    expect(cn("border-control border-text-muted")).toBe("border-control border-text-muted");
    expect(cn("border-control", "border-radio-checked")).toBe("border-radio-checked");
    expect(cn("rounded-bar", "rounded-control")).toBe("rounded-control");
  });
});
