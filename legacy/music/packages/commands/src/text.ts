/**
 * Text that people type and others read: names and descriptions of playlists, Jams, libraries,
 * devices, keys, and people. Decoding drops control and invisible format characters
 * (`CONTROL_CHARACTER`), so none can be stored on any path. A terminal acts on them when the CLI prints the text, which would let one
 * person rewrite what another sees. Line breaks and tabs become spaces, since every field is one
 * line, and the result is trimmed.
 */
import { Schema, SchemaGetter } from "effect";

const WHITESPACE_CONTROLS = new Set(["\t", "\n", "\v", "\f", "\r", "\u0085", "\u2028", "\u2029"]);

/**
 * A control character: C0, DEL, and C1 (Unicode's `Cc`), the line and paragraph separators (`Zl`,
 * `Zp`), and the format characters (`Cf`: bidi marks and overrides, zero-width spaces, the Arabic
 * letter mark, invisible tags), which can make text read differently from what it holds. The zero
 * width joiner (U+200D) stays: emoji sequences need it. The CLI escapes the same set when it prints.
 */
export const CONTROL_CHARACTER = /(?!\u200D)[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

export const isControlCharacter = (character: string): boolean => CONTROL_CHARACTER.test(character);

/** Whether `text` holds any control character. */
export const hasControlCharacter = (text: string): boolean =>
  Array.from(text).some(isControlCharacter);

const cleanCharacter = (character: string): string => {
  if (WHITESPACE_CONTROLS.has(character)) return " ";

  return isControlCharacter(character) ? "" : character;
};

/** `text` without control characters, line breaks and tabs turned into spaces, and trimmed. */
export const cleanText = (text: string): string => Array.from(text, cleanCharacter).join("").trim();

const clean = SchemaGetter.transform(cleanText);

/** Any typed text, cleaned as it decodes. */
export const Text = Schema.String.pipe(Schema.decode({ decode: clean, encode: clean }));

/**
 * A character that shows on its own: not whitespace, not a format character, not a combining mark
 * (such as U+034F, the combining grapheme joiner), and not one of the Hangul fillers (U+115F,
 * U+1160, U+3164, U+FFA0) or the blank Braille pattern (U+2800), which draw nothing.
 */
const VISIBLE = /[^\s\p{Cf}\p{M}\u115F\u1160\u3164\uFFA0\u2800]/u;

/** Whether cleaned text shows nothing at all. */
export const isBlank = (text: string): boolean => !VISIBLE.test(text);

const notBlank = Schema.makeFilter((text: string) => !isBlank(text) || "Name can't be blank");

export const Name = Text.check(notBlank, Schema.isMaxLength(120));

/**
 * A name that may be left out: empty means "not given", as a form sends it; anything else must
 * show, like a `Name`.
 */
export const OptionalName = Text.check(
  Schema.makeFilter((text: string) => text.length === 0 || !isBlank(text) || "Name can't be blank"),
  Schema.isMaxLength(120),
);

export const Description = Text.check(Schema.isMaxLength(500));
