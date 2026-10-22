/**
 * Now Playing's background follows the artwork (B01, H05): the theme's player color keeps its
 * lightness, and takes the hue and a little of the chroma of the cover's average color. Paper's
 * `--color-player-light` and `--color-dark-player` are this tint for Blue Lines, so a cover with
 * no color (or none loaded yet) falls back to them.
 */

/** An sRGB color, 0 to 255 per channel. */
export interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

interface Oklch {
  readonly l: number;
  readonly c: number;
  readonly h: number;
}

const BASE83 =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz#$%*+,-.:;=?@[]^_{|}~";

/** How much of the cover's chroma the tint keeps, and the most it may reach. */
const CHROMA_SHARE = 0.15;

const MAX_CHROMA = 0.016;

const decode83 = (text: string): number | null => {
  let value = 0;

  for (const char of text) {
    const digit = BASE83.indexOf(char);

    if (digit < 0) return null;
    value = value * 83 + digit;
  }

  return value;
};

/**
 * The average color of an image from its BlurHash: the hash's first component (characters 2 to
 * 5) is the image's mean color in sRGB. Null for a string that is not a BlurHash.
 */
export const blurhashAverage = (hash: string): Rgb | null => {
  if (hash.length < 6) return null;
  const value = decode83(hash.slice(2, 6));

  if (value === null || value > 0xff_ff_ff) return null;

  return { r: value >> 16, g: (value >> 8) & 255, b: value & 255 };
};

/** The cache key of a cover: its path, since the query only carries a URL signature. */
export const artKey = (url: string): string => url.split("?")[0] ?? url;

const toLinear = (channel: number): number => {
  const value = channel / 255;

  return value <= 0.040_45 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
};

const fromLinear = (value: number): number => {
  const clamped = Math.min(1, Math.max(0, value));
  const encoded = clamped <= 0.003_130_8 ? clamped * 12.92 : 1.055 * clamped ** (1 / 2.4) - 0.055;

  return Math.round(encoded * 255);
};

const toOklch = ({ r, g, b }: Rgb): Oklch => {
  const lr = toLinear(r);
  const lg = toLinear(g);
  const lb = toLinear(b);
  const l = Math.cbrt(0.412_221_470_8 * lr + 0.536_332_536_3 * lg + 0.051_445_992_9 * lb);
  const m = Math.cbrt(0.211_903_498_2 * lr + 0.680_699_545_1 * lg + 0.107_396_956_6 * lb);
  const s = Math.cbrt(0.088_302_461_9 * lr + 0.281_718_837_6 * lg + 0.629_978_700_5 * lb);
  const lightness = 0.210_454_255_3 * l + 0.793_617_785 * m - 0.004_072_046_8 * s;
  const a = 1.977_998_495_1 * l - 2.428_592_205 * m + 0.450_593_709_9 * s;
  const bAxis = 0.025_904_037_1 * l + 0.782_771_766_2 * m - 0.808_675_766 * s;

  return { l: lightness, c: Math.hypot(a, bAxis), h: Math.atan2(bAxis, a) };
};

const fromOklch = ({ l: lightness, c, h }: Oklch): Rgb => {
  const a = c * Math.cos(h);
  const bAxis = c * Math.sin(h);
  const l = (lightness + 0.396_337_777_4 * a + 0.215_803_757_3 * bAxis) ** 3;
  const m = (lightness - 0.105_561_345_8 * a - 0.063_854_172_8 * bAxis) ** 3;
  const s = (lightness - 0.089_484_177_5 * a - 1.291_485_548 * bAxis) ** 3;

  return {
    r: fromLinear(4.076_741_662_1 * l - 3.307_711_591_3 * m + 0.230_969_929_2 * s),
    g: fromLinear(-1.268_438_004_6 * l + 2.609_757_401_1 * m - 0.341_319_396_5 * s),
    b: fromLinear(-0.004_196_086_3 * l - 0.703_418_614_7 * m + 1.707_614_701 * s),
  };
};

const hex = (channel: number): string => channel.toString(16).padStart(2, "0");

/** `#rrggbb` for a color. */
const toHex = ({ r, g, b }: Rgb): string => `#${hex(r)}${hex(g)}${hex(b)}`;

/** The color of a `#rrggbb` or `#rrggbbaa` string, ignoring alpha; null for anything else. */
export const parseHex = (color: string): Rgb | null => {
  const match = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})(?:[\da-f]{2})?$/i.exec(color.trim());

  if (match === null) return null;
  const [, r = "0", g = "0", b = "0"] = match;

  return { r: Number.parseInt(r, 16), g: Number.parseInt(g, 16), b: Number.parseInt(b, 16) };
};

/**
 * The player background for a cover whose average color is `art`, over the theme's player color
 * `base`: the base's lightness, the cover's hue, and a small, capped share of the cover's chroma, so
 * text stays readable over any cover in either theme.
 */
export const playerTint = (art: Rgb, base: Rgb): string => {
  const cover = toOklch(art);
  const theme = toOklch(base);

  return toHex(
    fromOklch({ l: theme.l, c: Math.min(cover.c * CHROMA_SHARE, MAX_CHROMA), h: cover.h }),
  );
};
