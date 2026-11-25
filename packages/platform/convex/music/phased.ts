import type { PaginationOptions, PaginationResult } from "convex/server";

/**
 * A paginated list read in two parts, each one Convex paginated query on its own index: an
 * artist's rows through their links, then the rows a release before artist credits filed under
 * the artist, which have no links until their first scan since (ADR 0024, "Artist credits"). A
 * cursor names its part: `links:<cursor>` within the links, `linksDone:<cursor>` once they ended
 * there, which starts the second part, and `before:<cursor>` within it. A reactive client's
 * `endCursor` and the `splitCursor` it splits at name their part the same way, so a page pinned
 * to its end reads the same rows again.
 */

type Part = "links" | "before";

/** One part's page from `cursor`, up to `endCursor` when a reactive client pins it. */
export type PartPage<Row> = (options: PaginationOptions) => Promise<PaginationResult<Row>>;

const CURSOR = /^(links|linksDone|before):(.*)$/su;

/** Where a cursor stands within a two-part list. */
interface Position {
  readonly part: Part;
  /** The cursor within the part, null for its start. */
  readonly inner: string | null;
  /** The links ended at `inner`: the next page starts the second part. */
  readonly ended: boolean;
}

/** A cursor's position; any other cursor starts the list. */
const parse = (cursor: string | null | undefined): Position => {
  const match = CURSOR.exec(cursor ?? "");
  const kind = match?.[1];
  const inner = match?.[2] ?? "";

  if (kind === "before")
    return { part: "before", inner: inner.length === 0 ? null : inner, ended: false };

  if (kind === "linksDone") return { part: "links", inner, ended: true };

  return {
    part: "links",
    inner: kind === "links" && inner.length > 0 ? inner : null,
    ended: false,
  };
};

/** The end a pinned page of `part` reads to, or none when the client named another part's. */
const endWithin = (part: Part, endCursor: string | null | undefined): string | undefined => {
  if (endCursor === null || endCursor === undefined) return undefined;

  const end = parse(endCursor);

  return end.part === part && end.inner !== null ? end.inner : undefined;
};

/** `options` for one part: its cursor within the part, and the end a pinned page reads to. */
const withEnd = (
  options: PaginationOptions,
  cursor: string | null,
  endCursor: string | undefined,
): PaginationOptions => {
  const within: PaginationOptions = { ...options, cursor };

  if (endCursor === undefined) delete within.endCursor;
  else within.endCursor = endCursor;

  return within;
};

/** Names the part of a page's cursors. */
const named = <Row>(
  page: PaginationResult<Row>,
  part: Part,
  continueCursor: string,
  isDone: boolean,
): PaginationResult<Row> => {
  const result: PaginationResult<Row> = { ...page, continueCursor, isDone };

  const split = page.splitCursor;

  if (split !== null && split !== undefined) result.splitCursor = `${part}:${split}`;

  return result;
};

/** One page of a list read through `links`, then through `before`. */
export const phasedPage = async <Row>(
  options: PaginationOptions,
  links: PartPage<Row>,
  before: PartPage<Row>,
): Promise<PaginationResult<Row>> => {
  const at = parse(options.cursor);

  if (at.part === "before" || at.ended) {
    const cursor = at.part === "before" ? at.inner : null;
    const page = await before(withEnd(options, cursor, endWithin("before", options.endCursor)));

    return named(page, "before", `before:${page.continueCursor}`, page.isDone);
  }

  const page = await links(withEnd(options, at.inner, endWithin("links", options.endCursor)));

  return page.isDone
    ? named(page, "links", `linksDone:${page.continueCursor}`, false)
    : named(page, "links", `links:${page.continueCursor}`, false);
};
