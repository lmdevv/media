import { COVER_SIZES } from "@media/contracts/artwork";
import type { CoverSize } from "@media/contracts/artwork";

/**
 * True when a browser draws an image shrunk by `factor` as sharply as the original: Chromium shrinks
 * from mipmaps, so a copy 2 to 2.8, 4 to 5.6, or 8 to 11 times its box comes out soft, and one
 * 1.4 to 2, 2.8 to 4, or 5.7 to 8 times it sharp. Measured with copies 1.45 to 9.6 times a 166- and a
 * 232-pixel box: sharpness against one high-quality pass was 0.62 to 0.84 in the first bands and
 * 0.90 to 1.09 in the second; Safari draws as iOS does, as sharply in every second band.
 */
const drawsSharp = (factor: number): boolean =>
  factor >= Math.SQRT2 && Math.log2(factor) % 1 >= 0.5;

/**
 * The copy the web app asks for of a cover drawn `pixels` device pixels big: the one of exactly that
 * size, drawn pixel for pixel, or else the smallest the browser shrinks sharply (`drawsSharp`), or
 * undefined when only the original is.
 */
export const webCoverSize = (pixels: number): CoverSize | undefined => {
  const drawn = Math.round(pixels);

  return (
    COVER_SIZES.find((size) => size === drawn) ??
    COVER_SIZES.find((size) => drawsSharp(size / pixels))
  );
};
