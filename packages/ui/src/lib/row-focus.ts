const MEDIA_ROW_ATTRIBUTE = "data-media-row";

const FOCUSABLE = "a[href], button:not([disabled]), [tabindex]:not([tabindex='-1'])";

/**
 * The cards of a row track, in order, each with the element that takes its focus: the card itself
 * when it is focusable, else its first focusable element. A card's other controls, such as an info
 * link, belong to it, so arrows move from them to the next card.
 */
export function rowCards(
  track: Element,
): ReadonlyArray<{ readonly card: Element; readonly item: HTMLElement }> {
  return [...track.children].flatMap((card) => {
    const item = card.matches(FOCUSABLE) ? card : card.querySelector(FOCUSABLE);

    return item instanceof HTMLElement ? [{ card, item }] : [];
  });
}

/** The index of the card holding `element`, or -1. */
export function rowIndexOf(
  cards: ReadonlyArray<{ readonly card: Element }>,
  element: Element | null,
): number {
  return element === null ? -1 : cards.findIndex(({ card }) => card.contains(element));
}

const scrollBehavior = (): ScrollBehavior =>
  window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";

/** Focus a card and bring it into view without jumping past it. */
export function focusRowItem(item: HTMLElement): void {
  item.focus({ preventScroll: true });
  item.scrollIntoView({ block: "nearest", inline: "nearest", behavior: scrollBehavior() });
}

/**
 * Move keyboard focus to the next (`1`) or previous (`-1`) media row on the page, keeping the
 * column when the target row is long enough. With nothing focused in a row, `1` enters the first
 * row and `-1` the last.
 *
 * @returns Whether focus moved.
 */
export function moveRowFocus(direction: 1 | -1): boolean {
  const tracks = [...document.querySelectorAll(`[${MEDIA_ROW_ATTRIBUTE}]`)];
  const active = document.activeElement;
  const current = tracks.findIndex((track) => active !== null && track.contains(active));

  const target =
    tracks[current === -1 ? (direction === 1 ? 0 : tracks.length - 1) : current + direction];

  if (target === undefined) return false;

  const column =
    current === -1 ? 0 : Math.max(0, rowIndexOf(rowCards(tracks[current] ?? target), active));

  const cards = rowCards(target);
  const item = cards[Math.min(column, cards.length - 1)]?.item;

  if (item === undefined) return false;

  focusRowItem(item);
  item.closest("section")?.scrollIntoView({ block: "nearest", behavior: scrollBehavior() });

  return true;
}
