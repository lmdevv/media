import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import { keepsFocusOnClick, shortcutYields } from "./focus-policy";
import type { ControlKind } from "./focus-policy";

const KINDS: ReadonlyArray<ControlKind> = ["none", "text", "slider", "toggle", "radio", "control"];

const SHORTCUT_KEYS = [" ", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "/", "l", "n", "d"];

const kind = fc.constantFrom(...KINDS);

describe("shortcutYields", () => {
  it("lets Space through to the shortcut while a button or link has focus", () => {
    expect(shortcutYields(" ", "control", false)).toBe(false);
  });

  it("runs every shortcut while the page itself has focus", () => {
    fc.assert(
      fc.property(fc.constantFrom(...SHORTCUT_KEYS, "Enter"), (key) => {
        expect(shortcutYields(key, "none", false)).toBe(false);
      }),
    );
  });

  it("leaves Enter to whatever control has focus", () => {
    for (const focused of KINDS.filter((other) => other !== "none")) {
      expect(shortcutYields("Enter", focused, false), focused).toBe(true);
    }
  });

  it("leaves every key to a text field", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), (key) => {
        expect(shortcutYields(key, "text", false)).toBe(true);
      }),
    );
  });

  it("leaves Space, and only Space and Enter, to a checkbox or switch", () => {
    expect(shortcutYields(" ", "toggle", false)).toBe(true);
    expect(shortcutYields("ArrowLeft", "toggle", false)).toBe(false);
    expect(shortcutYields("l", "toggle", false)).toBe(false);
  });

  it("leaves Space and the arrows to a radio button", () => {
    expect(shortcutYields(" ", "radio", false)).toBe(true);
    expect(shortcutYields("ArrowDown", "radio", false)).toBe(true);
    expect(shortcutYields("n", "radio", false)).toBe(false);
  });

  it("leaves the arrows, Home, End, and paging to a slider, and Space to the shortcut", () => {
    for (const key of ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"]) {
      expect(shortcutYields(key, "slider", false), key).toBe(true);
    }

    expect(shortcutYields("PageUp", "slider", false)).toBe(true);
    expect(shortcutYields(" ", "slider", false)).toBe(false);
  });

  it("yields every key while a menu or dialog is open, whatever has focus", () => {
    fc.assert(
      fc.property(kind, fc.constantFrom(...SHORTCUT_KEYS), (focused, key) => {
        expect(shortcutYields(key, focused, true)).toBe(true);
      }),
    );
  });
});

describe("keepsFocusOnClick", () => {
  it("keeps focus only on text fields and sliders, which typing and arrows need", () => {
    expect(KINDS.filter((focused) => keepsFocusOnClick(focused))).toEqual(["text", "slider"]);
  });
});
