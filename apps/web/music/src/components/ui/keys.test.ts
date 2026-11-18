import { describe, expect, it } from "vitest";

import { keyLabels } from "./keys";

describe("keyLabels", () => {
  it("draws modifiers as symbols on macOS", () => {
    expect(keyLabels("Mod+K", "mac")).toEqual(["⌘", "K"]);
    expect(keyLabels("Shift+Enter", "mac")).toEqual(["⇧", "↵"]);
    expect(keyLabels("Alt+Enter", "mac")).toEqual(["⌥", "↵"]);
    expect(keyLabels("Shift+ArrowLeft", "mac")).toEqual(["⇧", "←"]);
  });

  it("names modifiers in words on Linux and Windows", () => {
    expect(keyLabels("Mod+K", "linux")).toEqual(["Ctrl", "K"]);
    expect(keyLabels("Shift+Enter", "linux")).toEqual(["Shift", "↵"]);
    expect(keyLabels("Mod+Enter", "windows")).toEqual(["Ctrl", "↵"]);
  });

  it("names Space in words and shortens Escape", () => {
    expect(keyLabels("Space", "mac")).toEqual(["Space"]);
    expect(keyLabels("Space", "linux")).toEqual(["Space"]);
    expect(keyLabels("Escape", "linux")).toEqual(["Esc"]);
  });

  it("gives every step of a sequence its own caps", () => {
    expect(keyLabels(["G", "Mod+K"], "mac")).toEqual(["G", "⌘", "K"]);
  });
});
