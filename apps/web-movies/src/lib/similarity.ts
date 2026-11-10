const fold = (text: string): string =>
  text
    .normalize("NFD")
    .replaceAll(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replaceAll(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

const pairs = (text: string): ReadonlyArray<string> => {
  const folded = fold(text);

  return Array.from({ length: Math.max(0, folded.length - 1) }, (_, index) =>
    folded.slice(index, index + 2),
  ).filter((pair) => !pair.includes(" "));
};

/** Similarity from 0 (nothing shared) to 1 (the same letters in the same pairs). */
export const similarity = (a: string, b: string): number => {
  const left = pairs(a);
  const right = [...pairs(b)];

  if (left.length === 0 || right.length === 0) return fold(a) === fold(b) && fold(a) !== "" ? 1 : 0;

  let shared = 0;

  for (const pair of left) {
    const index = right.indexOf(pair);

    if (index !== -1) {
      shared += 1;
      right.splice(index, 1);
    }
  }

  return (2 * shared) / (left.length + pairs(b).length);
};

/** The longest word of a query, the best handle for finding what a misspelled query meant. */
export const longestWord = (query: string): string =>
  fold(query)
    .split(" ")
    .reduce((longest, word) => (word.length > longest.length ? word : longest), "");
