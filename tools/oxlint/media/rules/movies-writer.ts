import { singleWriterRule } from "./single-writer.ts";

/** The movies tables, which no module outside `movies/` writes either. */
export const MOVIES_TABLES: ReadonlySet<string> = new Set([
  "titles",
  "titleGenres",
  "seasons",
  "episodes",
  "people",
  "credits",
  "mediaFiles",
  "collections",
  "collectionItems",
  "watchProgress",
  "myList",
  "watchMarks",
  "importPlans",
]);

/**
 * Route every insert, patch, and replace of a movies table through `movies/write.ts`, which fits
 * each document within the bound the reads reserve for it (`single-writer.ts`).
 */
export const moviesWriterRule = singleWriterRule({
  dir: "packages/platform/convex/movies/",
  writer: "packages/platform/convex/movies/write.ts",
  tables: MOVIES_TABLES,
  coreInserts: new Set(["libraries", "grants"]),
  writes: new Set(["insert", "patch", "replace"]),
  description: "Require movies-table writes to go through packages/platform/convex/movies/write.ts.",
  messages: {
    direct:
      "Write movies tables through packages/platform/convex/movies/write.ts, which fits each document within the bound its reads reserve (ADR 0024).",
    hidden:
      "Call a database's insert, patch, or replace directly by name, so the table it writes is visible; write movies tables through packages/platform/convex/movies/write.ts (ADR 0024).",
  },
});
