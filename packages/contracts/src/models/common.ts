import { Schema } from "effect";

/** The result of a command that only reports success. */
export const Ok = Schema.Struct({ ok: Schema.Literal(true) });

/** The result of a command that only succeeds. */
export interface Ok extends Schema.Schema.Type<typeof Ok> {}

/** An opaque continuation cursor from a previous page. */
export const Cursor = Schema.String;

/**
 * A page of `item`. `nextCursor` is null on the last page. A page may hold fewer items than asked
 * for, even none, when filtering hides records; keep reading until `nextCursor` is null.
 */
export const Page = <Item extends Schema.Top>(item: Item) =>
  Schema.Struct({ items: Schema.Array(item), nextCursor: Schema.NullOr(Cursor) });
