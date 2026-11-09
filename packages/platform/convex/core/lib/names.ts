/**
 * Control, private-use, unassigned, and surrogate code points, line and paragraph separators, and
 * the bidirectional controls that reorder what others see. Zero-width joiners stay: emoji
 * sequences and several scripts need them.
 */
const UNPRINTABLE =
  /[\p{Cc}\p{Co}\p{Cn}\p{Cs}\p{Zl}\p{Zp}\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/u;

const VISIBLE = /[^\p{White_Space}\p{Default_Ignorable_Code_Point}\p{M}\u2800]/u;

/**
 * A name other people see, such as a guest's or a Cast receiver's: `typed` in NFKC form and
 * trimmed, or null when it holds an unprintable character or no visible one.
 */
export const printableName = (typed: string): string | null => {
  const name = typed.normalize("NFKC").trim();

  return !UNPRINTABLE.test(name) && VISIBLE.test(name) ? name : null;
};
