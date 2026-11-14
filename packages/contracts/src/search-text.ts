/** Combining Diacritical Marks: the accents NFD splits off Latin, Greek, and Cyrillic letters. */
const DIACRITICS = /[̀-ͯ]/gu;

/** Letters that carry no separable accent but that people type without one. */
const LETTERS = new Map([
  ["ß", "ss"],
  ["æ", "ae"],
  ["œ", "oe"],
  ["ø", "o"],
  ["ł", "l"],
  ["đ", "d"],
  ["ð", "d"],
  ["þ", "th"],
  ["ı", "i"],
]);

const LETTER = /[ßæœøłđðþı]/gu;

/**
 * Lowercases `text` and strips accents, as old music's `foldSearchText` does, so search matches
 * "Doppelgänger" for "doppelganger". Only the Latin, Greek, and Cyrillic accent block goes, and
 * the result is recomposed, so kana and Hangul come back unchanged.
 */
export const foldSearchText = (text: string): string =>
  text
    .toLowerCase()
    .normalize("NFD")
    .replaceAll(DIACRITICS, "")
    .normalize("NFC")
    .replaceAll(LETTER, (letter) => LETTERS.get(letter) ?? letter);
