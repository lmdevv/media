import { describe, expect, it } from "vitest";

import { chooseSurface, shownSurface } from "./play-on";

describe("chooseSurface", () => {
  it("opens the sheet on phones, the popover with a speaker button, the dialog without one", () => {
    expect(chooseSurface({ desktop: false, popoverMounted: true, nowPlayingOpen: false })).toBe(
      "sheet",
    );
    expect(chooseSurface({ desktop: true, popoverMounted: true, nowPlayingOpen: false })).toBe(
      "popover",
    );
    expect(chooseSurface({ desktop: true, popoverMounted: false, nowPlayingOpen: false })).toBe(
      "dialog",
    );
  });

  it("opens the dialog over the desktop Now Playing, which covers the speaker button", () => {
    expect(chooseSurface({ desktop: true, popoverMounted: true, nowPlayingOpen: true })).toBe(
      "dialog",
    );
    expect(chooseSurface({ desktop: false, popoverMounted: true, nowPlayingOpen: true })).toBe(
      "sheet",
    );
  });
});

describe("shownSurface", () => {
  it("shows nothing while closed", () => {
    expect(shownSurface(null, true)).toBeNull();
  });

  it("keeps the surface Play on opened on", () => {
    expect(shownSurface("dialog", true)).toBe("dialog");
    expect(shownSurface("popover", true)).toBe("popover");
  });

  it("shows one picker across the breakpoint", () => {
    expect(shownSurface("popover", false)).toBe("sheet");
    expect(shownSurface("dialog", false)).toBe("sheet");
    expect(shownSurface("sheet", true)).toBe("dialog");
  });
});
