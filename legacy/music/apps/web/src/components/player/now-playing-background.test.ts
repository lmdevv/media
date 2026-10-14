import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import { placeholderColors } from "../../lib/art";

import { nowPlayingBackground } from "./now-playing-background";

describe("nowPlayingBackground", () => {
  it("washes a cover's colors radially into the dark background on desktop", () => {
    expect(nowPlayingBackground(["rgb(200 120 40)", "rgb(40 20 10)"], "radial")).toEqual({
      backgroundImage:
        "radial-gradient(ellipse 110% 90% at 22% 35% in oklab, " +
        "oklch(from rgb(200 120 40) min(l, 0.46) c h) 0%, " +
        "oklch(from rgb(40 20 10) min(l, 0.27) c h) 55%, " +
        "var(--color-dark-bg) 100%)",
    });
  });

  it("fades a cover's colors down into the dark background on phones", () => {
    expect(nowPlayingBackground(["rgb(200 120 40)", "rgb(40 20 10)"], "linear")).toEqual({
      backgroundImage:
        "linear-gradient(in oklab 180deg, " +
        "oklch(from rgb(200 120 40) min(l, 0.46) c h) 0%, " +
        "oklch(from rgb(40 20 10) min(l, 0.27) c h) 60%, " +
        "var(--color-dark-bg) 100%)",
    });
  });

  it("adds no colors or sizes of its own beyond the cover tints and the background token", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }),
        fc.constantFrom("radial" as const, "linear" as const),
        (seed, layout) => {
          const colors = placeholderColors(seed);
          const { backgroundImage } = nowPlayingBackground(colors, layout);
          const [light, deep] = colors;

          // Strip the two cover tints; whatever is left is the builder's own CSS.
          const rest = (backgroundImage ?? "")
            .replace(`oklch(from ${light} min(l, 0.46) c h)`, "")
            .replace(`oklch(from ${deep} min(l, 0.27) c h)`, "");

          expect(rest).toContain("var(--color-dark-bg) 100%");
          expect(rest).not.toMatch(/#|rgb|oklab\(|oklch|px|rem/);
        },
      ),
    );
  });
});
