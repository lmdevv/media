import { singleWriterRule } from "./single-writer.ts";

/**
 * The music tables, the catalog's and what each person keeps of it, which no module outside
 * `music/` writes either.
 */
export const MUSIC_TABLES: ReadonlySet<string> = new Set([
  "artists",
  "albums",
  "tracks",
  "localLyrics",
  "playlists",
  "playlistItems",
  "likes",
  "plays",
  "playQueues",
  "playQueueEntries",
]);

/**
 * Route every insert, patch, replace, and delete of a music table through the music store in
 * `music/write.ts`, which fits each document within its bound and charges the call's meter for
 * each read and write (`single-writer.ts`). `music/catalog.ts` reaches the database only through
 * that store.
 */
export const musicWriterRule = singleWriterRule({
  dir: "packages/platform/convex/music/",
  writer: "packages/platform/convex/music/write.ts",
  tables: MUSIC_TABLES,
  coreInserts: new Set(["libraries", "grants"]),
  writes: new Set(["insert", "patch", "replace", "delete"]),
  description:
    "Require music-table writes to go through the music store in packages/platform/convex/music/write.ts.",
  messages: {
    direct:
      "Write music tables through the music store in packages/platform/convex/music/write.ts, which fits each document within its bound and charges the call's budget for each read and write (ADR 0024).",
    hidden:
      "Call a database's insert, patch, replace, or delete directly by name, so the table it writes is visible; write music tables through packages/platform/convex/music/write.ts (ADR 0024).",
  },
  storeOnly: {
    modules: ["packages/platform/convex/music/catalog.ts"],
    message:
      "Reach the database here only through the music store in packages/platform/convex/music/write.ts, which charges the call's budget for each read and write (ADR 0024).",
  },
});
