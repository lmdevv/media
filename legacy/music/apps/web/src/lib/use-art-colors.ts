import { useEffect, useState } from "react";

import { placeholderColors } from "./art";

const SAMPLE = 8;

/** Averages a loaded image to one CSS color, or null when the image is cross-origin tainted. */
const averageColor = (image: HTMLImageElement): string | null => {
  const canvas = document.createElement("canvas");
  canvas.width = SAMPLE;
  canvas.height = SAMPLE;

  const context = canvas.getContext("2d");

  if (context === null) return null;

  try {
    context.drawImage(image, 0, 0, SAMPLE, SAMPLE);
    const pixels = context.getImageData(0, 0, SAMPLE, SAMPLE).data;
    let red = 0;
    let green = 0;
    let blue = 0;

    for (let offset = 0; offset < pixels.length; offset += 4) {
      red += pixels[offset] ?? 0;
      green += pixels[offset + 1] ?? 0;
      blue += pixels[offset + 2] ?? 0;
    }

    const count = pixels.length / 4;

    return `rgb(${Math.round(red / count)} ${Math.round(green / count)} ${Math.round(blue / count)})`;
  } catch {
    return null;
  }
};

/**
 * The colors that tint Now Playing (the runtime `--color-art`): sampled from the cover when it
 * loads with CORS, otherwise the cover's placeholder colors.
 */
export const useArtColors = (url: string | null, seed: string): readonly [string, string] => {
  const [sampled, setSampled] = useState<{ readonly url: string; readonly color: string } | null>(
    null,
  );

  useEffect(() => {
    if (url === null) return;

    const image = new Image();
    image.crossOrigin = "anonymous";
    image.decoding = "async";
    image.addEventListener("load", () => {
      const color = averageColor(image);

      if (color !== null) setSampled({ url, color });
    });
    image.src = url;
  }, [url]);

  if (sampled !== null && sampled.url === url) return [sampled.color, sampled.color];

  return placeholderColors(seed);
};
