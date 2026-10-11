/**
 * Artwork placeholders. Paper draws covers as two-stop gradients; without art files the app uses
 * the same family, chosen deterministically from the item's ID so a cover never changes between
 * screens. These colors stand in for artwork content, so they are not theme tokens.
 */
const PLACEHOLDERS: ReadonlyArray<readonly [from: string, to: string]> = [
  ["oklab(41.7% -0.018 -0.091)", "oklab(23.8% -0.009 -0.057)"],
  ["oklab(83.4% 0.005 0.117)", "oklab(78.1% 0.068 0.107)"],
  ["oklab(86.9% -0.010 -0.016)", "oklab(53.5% -0.016 -0.036)"],
  ["oklab(37.7% 0.097 0.015)", "oklab(21.3% 0.045 0.008)"],
  ["oklab(74.4% -0.032 0.013)", "oklab(91.3% -0.0007 0.025)"],
  ["oklab(48.8% 0.118 -0.178)", "oklab(64.9% 0.137 0.130)"],
  ["oklab(22.6% 0 0)", "oklab(72.8% 0.003 0.062)"],
  ["oklab(61.2% 0.193 0.079)", "oklab(83.9% 0.007 0.138)"],
  ["oklab(58.6% -0.076 -0.011)", "oklab(88.6% -0.004 0.066)"],
  ["oklab(21.8% 0 0)", "oklab(36.5% 0.014 0.027)"],
  ["oklab(37.5% -0.030 -0.032)", "oklab(63% -0.101 -0.005)"],
  ["oklab(34.8% 0 0)", "oklab(58% 0 0)"],
  ["oklab(58.7% 0.071 0.109)", "oklab(27.1% 0.030 0.043)"],
];

const hash = (seed: string): number => {
  let value = 2166136261;

  for (const char of seed) {
    value ^= char.codePointAt(0) ?? 0;
    value = Math.imul(value, 16777619);
  }

  // Final avalanche so IDs that differ only in their last characters spread across the palette.
  value ^= value >>> 16;
  value = Math.imul(value, 2246822507);
  value ^= value >>> 13;
  value = Math.imul(value, 3266489909);
  value ^= value >>> 16;

  return value >>> 0;
};

const pick = (seed: string): readonly [string, string] =>
  PLACEHOLDERS[hash(seed) % PLACEHOLDERS.length] ?? [
    "oklab(41.7% -0.018 -0.091)",
    "oklab(23.8% -0.009 -0.057)",
  ];

/** The CSS background for a placeholder cover. `angle` is 140° for squares, 160° for circles. */
export const placeholderGradient = (seed: string, angle = 140): string => {
  const [from, to] = pick(seed);

  return `linear-gradient(in oklab ${angle}deg, ${from} 0%, ${to} 100%)`;
};

/** The placeholder gradient at a fixed position, for decorative art walls. */
export const placeholderAt = (index: number, angle = 140): string => {
  const [from, to] = PLACEHOLDERS[index % PLACEHOLDERS.length] ?? pick("");

  return `linear-gradient(in oklab ${angle}deg, ${from} 0%, ${to} 100%)`;
};

const lightness = (color: string): number => Number(/oklab\(([\d.]+)%/.exec(color)?.[1] ?? "0");

/** The lighter and darker stops of a cover's placeholder, lighter first, to tint Now Playing. */
export const placeholderColors = (seed: string): readonly [string, string] => {
  const [from, to] = pick(seed);

  return lightness(from) >= lightness(to) ? [from, to] : [to, from];
};

/**
 * Now Playing tints from a cover color, clamped dark enough that white text stays readable over
 * light covers. `level` picks the glow (`light`) or the shade (`deep`).
 */
export const artTint = (color: string, level: "light" | "deep"): string =>
  `oklch(from ${color} min(l, ${level === "light" ? 0.46 : 0.27}) c h)`;
