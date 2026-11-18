/** Letters in a device sign-in's user code, such as `HDKR-BGTL` without its dash. */
export const USER_CODE_LENGTH = 8;

/** The code's letters as typed into the boxes: upper-cased, letters only, at most eight. */
export const codeLetters = (typed: string): string =>
  typed
    .toUpperCase()
    .replaceAll(/[^A-Z]/gu, "")
    .slice(0, USER_CODE_LENGTH);

/** The code as the core shows it, `HDKR-BGTL`, once all eight letters are in. */
export const formatUserCode = (letters: string): string | null =>
  letters.length === USER_CODE_LENGTH ? `${letters.slice(0, 4)}-${letters.slice(4)}` : null;
