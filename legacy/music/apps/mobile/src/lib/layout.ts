/**
 * Which of Paper's layouts a window gets (page 25). The phone design runs below `tablet`, which
 * covers every iPhone and an iPad app in narrow Split View; the iPad design runs from `tablet`;
 * from `wide` (iPad landscape, the 13-inch in portrait) two panes fit side by side.
 */

/** The layout a window width gets. */
export type WidthClass = "phone" | "tablet" | "wide";

/** The widths, in points, where the iPad layouts start: Paper's `--breakpoint-*` tokens. */
export interface Breakpoints {
  readonly tablet: number;
  readonly wide: number;
}

/** The layout for a window `width` points across. */
export const widthClassOf = (width: number, { tablet, wide }: Breakpoints): WidthClass => {
  if (width >= wide) return "wide";

  return width >= tablet ? "tablet" : "phone";
};

/**
 * The layout of a page `content` points across in a window of class `window`. A window with an iPad
 * layout keeps one however little room its sidebar and margins leave, as `tablet:` variants do.
 */
export const contentClassOf = (
  window: WidthClass,
  content: number,
  breakpoints: { readonly tablet: number; readonly wide: number },
): WidthClass =>
  window === "phone" ? "phone" : widthClassOf(Math.max(content, breakpoints.tablet), breakpoints);

/**
 * Whether an iPad header's art fits beside `text` points of text in a page `width` points across,
 * inside its `edge`s with `gap` between them; a narrower page stacks them.
 */
export const fitsSideBySide = (
  width: number,
  edge: number,
  { art, gap, text }: { readonly art: number; readonly gap: number; readonly text: number },
): boolean => width - 2 * edge >= art + gap + text;

/**
 * How many cards at least `min` points wide fit across `width` with `gap` between them, never
 * fewer than one. The cards then stretch to fill the row.
 */
export const columnsOf = (width: number, min: number, gap: number): number =>
  Math.max(1, Math.floor((width + gap) / (min + gap)));

/** `items` in rows of `columns`, in order; the last row holds what is left. */
export const rowsOf = <Item>(
  items: ReadonlyArray<Item>,
  columns: number,
): ReadonlyArray<ReadonlyArray<Item>> =>
  Array.from({ length: Math.ceil(items.length / columns) }, (_, row) =>
    items.slice(row * columns, (row + 1) * columns),
  );
