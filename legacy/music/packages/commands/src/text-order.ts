/**
 * Maps a UTF-16 code unit so that comparing mapped units orders strings by code point: surrogates
 * (U+D800 to U+DFFF, the halves of characters beyond U+FFFF) move above U+E000 to U+FFFF.
 */
const codePointRank = (unit: number): number =>
  unit >= 0xe000 ? unit - 0x800 : unit >= 0xd800 ? unit + 0x2000 : unit;

/**
 * Orders text by code point, as Convex orders index keys, rather than by UTF-16 unit as `<` and
 * `Array.prototype.sort` do: the two disagree when one string has a character beyond U+FFFF (an
 * emoji) where the other has one from U+E000 to U+FFFF. Anything that merges or splits Convex
 * index ranges must agree with the index. It allocates nothing, so sorting a whole library's
 * paths with it stays cheap.
 */
export const compareText = (left: string, right: string): number => {
  const length = Math.min(left.length, right.length);

  for (let position = 0; position < length; position += 1) {
    const leftUnit = left.charCodeAt(position);
    const rightUnit = right.charCodeAt(position);

    if (leftUnit !== rightUnit) return codePointRank(leftUnit) - codePointRank(rightUnit);
  }

  return left.length - right.length;
};
