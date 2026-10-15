import type { PageResult } from "@/components/library/page-chain";

/**
 * Reads a paginated list once, page after page, until it ends or holds `max` items. Each request
 * needs the previous page's cursor, so pages load one after another.
 */
export const readPages = async <Item>(
  read: (cursor: string | null) => Promise<PageResult<Item>>,
  max: number,
): Promise<ReadonlyArray<Item>> => {
  const collect = async (
    cursor: string | null,
    loaded: ReadonlyArray<Item>,
  ): Promise<ReadonlyArray<Item>> => {
    const page = await read(cursor);

    // A page that says more follow must move the cursor, or this would ask for it forever.
    if (!page.done && page.cursor === cursor) {
      throw new Error("The list stopped advancing; load it again");
    }

    const items = [...loaded, ...page.items];

    return page.done || items.length >= max ? items.slice(0, max) : collect(page.cursor, items);
  };

  return collect(null, []);
};
