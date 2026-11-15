import { Image } from "expo-image";
import { useEffect, useState } from "react";

import { artKey, blurhashAverage, parseHex, playerTint } from "@/lib/art-tint";
import type { Rgb } from "@/lib/art-tint";
import { useThemeColor } from "@/lib/theme-color";

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
