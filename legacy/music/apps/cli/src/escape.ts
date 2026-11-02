import { CONTROL_CHARACTER } from "@music/commands/text";

const CONTROL = new RegExp(CONTROL_CHARACTER.source, "gu");

const CONTROL_BUT_LAYOUT = new RegExp(`(?![\\n\\t])${CONTROL_CHARACTER.source}`, "gu");

const escapeUnit = (unit: number): string => `\\u${unit.toString(16).padStart(4, "0")}`;

const escapeCharacter = (character: string): string =>
  Array.from({ length: character.length }, (_, index) =>
    escapeUnit(character.charCodeAt(index)),
  ).join("");

/**
 * `text` with every control character written out, line breaks and tabs included: for anything
 * from the server placed inside a line, where a line break would fake another line.
 */
export const escapeControlCharacters = (text: string): string =>
  text.replaceAll(CONTROL, escapeCharacter);

/**
 * Output the CLI built itself, with only the line breaks and tabs it laid out kept. Escaped JSON
 * stays valid JSON that decodes to the same value: control characters can only appear inside its
 * strings, where `\u009b` means the same character.
 */
export const terminalSafe = (text: string): string =>
  text.replaceAll(CONTROL_BUT_LAYOUT, escapeCharacter);
