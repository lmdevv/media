/**
 * Now Playing's background color for the current cover. Expo Image reduces the cover to a 1×1
 * BlurHash, whose first component is the cover's average color, so no pixels cross into
 * JavaScript and no native module is added. Each cover's color is remembered for the session.
 */
import { Image } from "expo-image";
import { useEffect, useState } from "react";

import { artKey, blurhashAverage, parseHex, playerTint } from "@/lib/art-tint";
import type { Rgb } from "@/lib/art-tint";
import { useThemeColor } from "@/lib/theme-color";

/** Average colors by cover. A cover that failed to load is not remembered, so it is read again. */
const averages = new Map<string, Rgb>();

/**
 * The player background for the cover at `artUrl`, or null to use `--color-player` (no cover, or
 * its color is still being read).
 */
export const useArtTint = (artUrl: string | null): string | null => {
  const base = parseHex(useThemeColor("--color-player"));
  const key = artUrl === null ? null : artKey(artUrl);
  const [, setRead] = useState<string | null>(null);

  useEffect(() => {
    if (artUrl === null || key === null || averages.has(key)) return undefined;
    let current = true;

    const read = async () => {
      const hash = await Image.generateBlurhashAsync(artUrl, [1, 1]).catch(() => null);
      const average = hash === null ? null : blurhashAverage(hash);

      if (average === null) return;
      averages.set(key, average);

      if (current) setRead(key);
    };

    void read();

    return () => {
      current = false;
    };
  }, [artUrl, key]);

  const average = key === null ? undefined : averages.get(key);

  return average === undefined || base === null ? null : playerTint(average, base);
};
