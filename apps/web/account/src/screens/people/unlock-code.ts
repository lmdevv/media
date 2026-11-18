/** An unlock code is 4 to 7 ASCII digits, one shorter than the shortest password (ADR 0006). */
export const UNLOCK_CODE = { min: 4, max: 7 } as const;

const PATTERN = new RegExp(`^[0-9]{${UNLOCK_CODE.min},${UNLOCK_CODE.max}}$`, "u");

/** Whether `text` has the shape of an unlock code. */
export const isUnlockCode = (text: string): boolean => PATTERN.test(text);

/** Keeps the ASCII digits of what was typed, up to the longest code. */
export const codeDigits = (typed: string): string =>
  typed.replaceAll(/[^0-9]/gu, "").slice(0, UNLOCK_CODE.max);
