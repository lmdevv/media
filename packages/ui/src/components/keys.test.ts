import { describe, expect, it } from "vitest";

import { ariaKeyShortcuts, keyLabels } from "./keys";

describe("keyLabels", () => {
  it("draws modifiers as symbols on macOS", () => {
    expect(keyLabels("Mod+K", "mac")).toEqual(["⌘", "K"]);
    expect(keyLabels("Shift+Enter", "mac")).toEqual(["⇧", "↵"]);
    expect(keyLabels("Alt+Enter", "mac")).toEqual(["⌥", "↵"]);
    expect(keyLabels("Shift+ArrowLeft", "mac")).toEqual(["⇧", "←"]);
    expect(keyLabels("Mod+Shift+K", "mac")).toEqual(["⇧", "⌘", "K"]);
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

describe("ariaKeyShortcuts", () => {
  it("spells out the platform's modifier", () => {
    expect(ariaKeyShortcuts("Mod+K", "mac")).toBe("Meta+K");
    expect(ariaKeyShortcuts("Mod+K", "linux")).toBe("Control+K");
    expect(ariaKeyShortcuts("Mod+Shift+K", "windows")).toBe("Control+Shift+K");
  });

  it("names single keys as the attribute does", () => {
    expect(ariaKeyShortcuts("G", "mac")).toBe("G");
    expect(ariaKeyShortcuts("Space", "linux")).toBe("Space");
  });

  it("leaves out sequences, which the attribute cannot express", () => {
    expect(ariaKeyShortcuts(["G", "H"], "mac")).toBeUndefined();
  });
});
