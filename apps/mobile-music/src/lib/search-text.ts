/**
 * Accent-insensitive search text. Convex full-text search matches characters literally, so the
 * backend stores folded copies of titles and names and folds every query the same way: a search
 * for "doppelganger" finds "Doppelgänger". Clients fold too when they rank results locally.
 */

/** Combining Diacritical Marks: the accents NFD splits off Latin, Greek, and Cyrillic letters. */
const DIACRITICS = /[\u0300-\u036F]/gu;

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
 * Lowercases `text` and strips accents, so text that differs only in case or accents folds to the
 * same string. Other scripts keep their marks: only the Latin, Greek, and Cyrillic accent block
 * is removed, and the result is recomposed (NFC), so kana and Hangul come back unchanged.
 * Display the original text; the folded copy is only for matching.
 */
export const foldSearchText = (text: string): string =>
  text
    .toLowerCase()
    .normalize("NFD")
    .replaceAll(DIACRITICS, "")
    .normalize("NFC")
    .replaceAll(LETTER, (letter) => LETTERS.get(letter) ?? letter);
