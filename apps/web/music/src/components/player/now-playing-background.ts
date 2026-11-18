import type { CSSProperties } from "react";

import { artTint } from "../../lib/art";

/**
 * The art-tinted backdrop behind Now Playing: the cover's glow fading through its shade into the
 * dark background token. Desktop uses the `radial` wash from the top left; phones use a `linear`
 * fade from the top.
 *
 * @param colors - The cover's lighter and darker colors, lighter first (as `useArtColors` returns).
 */
export const nowPlayingBackground = (
  [light, deep]: readonly [light: string, deep: string],
  layout: "radial" | "linear",
): CSSProperties => {
  const glow = artTint(light, "light");
  const shade = artTint(deep, "deep");

  return {
    backgroundImage:
      layout === "radial"
        ? `radial-gradient(ellipse 110% 90% at 22% 35% in oklab, ${glow} 0%, ${shade} 55%, var(--color-dark-bg) 100%)`
        : `linear-gradient(in oklab 180deg, ${glow} 0%, ${shade} 60%, var(--color-dark-bg) 100%)`,
  };
};
