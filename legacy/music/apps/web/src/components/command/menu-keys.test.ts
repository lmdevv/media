import { describe, expect, it } from "vitest";

import { menuKeyOf } from "./menu-keys";

const press = (
  key: string,
  modifiers: {
    readonly ctrlKey?: boolean;
    readonly altKey?: boolean;
    readonly metaKey?: boolean;
    readonly shiftKey?: boolean;
    readonly isComposing?: boolean;
  } = {},
) =>
  menuKeyOf({
    key,
    ctrlKey: modifiers.ctrlKey ?? false,
    altKey: modifiers.altKey ?? false,
    metaKey: modifiers.metaKey ?? false,
    shiftKey: modifiers.shiftKey ?? false,
    isComposing: modifiers.isComposing ?? false,
  });

describe("menuKeyOf", () => {
  it("moves with the arrow keys", () => {
    expect(press("ArrowDown")).toBe("next");
    expect(press("ArrowUp")).toBe("previous");
  });

  it("moves with Ctrl+J and Ctrl+P", () => {
    expect(press("j", { ctrlKey: true })).toBe("next");
    expect(press("p", { ctrlKey: true })).toBe("previous");
  });

  it("leaves Ctrl+N (a new browser window) and Ctrl+K (the menu toggle) alone", () => {
    expect(press("n", { ctrlKey: true })).toBeNull();
    expect(press("k", { ctrlKey: true })).toBeNull();
  });

  it("leaves Ctrl with other modifiers, and the letters alone, to the field", () => {
    expect(press("j")).toBeNull();
    expect(press("j", { ctrlKey: true, shiftKey: true })).toBeNull();
    expect(press("p", { ctrlKey: true, shiftKey: true })).toBeNull();
    expect(press("p", { ctrlKey: true, altKey: true })).toBeNull();
    expect(press("p", { ctrlKey: true, metaKey: true })).toBeNull();
  });

  it("runs on Enter unless an input method is composing text", () => {
    expect(press("Enter")).toBe("run");
    expect(press("Enter", { isComposing: true })).toBeNull();
  });

  it("ignores other keys", () => {
    expect(press("a")).toBeNull();
    expect(press("Escape")).toBeNull();
  });
});
