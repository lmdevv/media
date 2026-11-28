import { Image } from "expo-image";
import { useEffect, useState } from "react";

import { artKey, blurhashAverage, parseHex, playerTint } from "@/lib/art-tint";
import type { Rgb } from "@/lib/art-tint";
import { artSource } from "@/lib/media-url";
import { useThemeColor } from "@/lib/theme-color";
import { useServer } from "@/session/connection";
import { coverUnread } from "@/session/media-requests";

const averages = new Map<string, Rgb>();

/**
 * The player background for the cover at `artUrl`, or null to use `--color-player` (no cover, or
 * its color is still being read).
 */
export const useArtTint = (artUrl: string | null): string | null => {
  const base = parseHex(useThemeColor("--color-player"));
  const { mediaUrl } = useServer();
  const key = artUrl === null ? null : artKey(artUrl);
  const [, setRead] = useState<string | null>(null);

  useEffect(() => {
    if (artUrl === null || key === null || averages.has(key)) return undefined;
    let current = true;

    const read = async () => {
      // The average of one pixel needs only the smallest copy, and this download skips the cache.
      const smallest = artSource(mediaUrl, artUrl, 1)?.uri ?? artUrl;
      const hash = await Image.generateBlurhashAsync(smallest, [1, 1]).catch(coverUnread(smallest));
      const average = hash === null ? null : blurhashAverage(hash);

      if (average === null) return;
      averages.set(key, average);

      if (current) setRead(key);
    };

    void read();

    return () => {
      current = false;
    };
  }, [artUrl, key, mediaUrl]);

  const average = key === null ? undefined : averages.get(key);

  return average === undefined || base === null ? null : playerTint(average, base);
};
