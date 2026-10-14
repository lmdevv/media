/**
 * The chain's cursors after the page at `cursor` reported that it ends at `next`. A page that is
 * not the last ends where the following page starts, unless it outgrew the most rows one page
 * holds; then a page starting at `next` goes in between, so no row falls out of the list.
 */
export const splitChain = (
  cursors: ReadonlyArray<string | null>,
  cursor: string | null,
  next: string,
): ReadonlyArray<string | null> => {
  const at = cursors.indexOf(cursor);

  if (at === -1 || at === cursors.length - 1 || cursors.includes(next)) return cursors;

  return [...cursors.slice(0, at + 1), next, ...cursors.slice(at + 1)];
};
