/**
 * Fully clear versions of theme colors, for gradients that fade a color out. Fading to plain
 * `transparent` (clear black) passes through gray on a light page, so a fade ends on the same
 * color at zero alpha.
 */

const HEX = /^#(?<digits>[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/iu;

/** `color` with zero alpha: `#ffffff` becomes `#ffffff00`. Anything but hex fades to clear. */
export const clearOf = (color: string): string => {
  const digits = HEX.exec(color)?.groups?.digits;

  if (digits === undefined) return "transparent";

  const full =
    digits.length <= 4
      ? digits.slice(0, 3).replaceAll(/./gu, (digit) => `${digit}${digit}`)
      : digits.slice(0, 6);

  return `#${full}00`;
};
