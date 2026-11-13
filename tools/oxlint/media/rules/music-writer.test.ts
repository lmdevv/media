import { RuleTester } from "oxlint/plugins-dev";
import { describe, it } from "vitest";

import { musicWriterRule } from "./music-writer.ts";

RuleTester.describe = describe;
RuleTester.it = it;

const music = "/repo/packages/platform/convex/music/example.ts";
const core = "/repo/packages/platform/convex/core/example.ts";
const writer = "/repo/packages/platform/convex/music/write.ts";
const catalog = "/repo/packages/platform/convex/music/catalog.ts";

const inMusic = (code: string) => ({ code, filename: music });
const inCore = (code: string) => ({ code, filename: core });
const inCatalog = (code: string) => ({ code, filename: catalog });

new RuleTester().run("music-writer", musicWriterRule, {
  valid: [
    inMusic(`await store.insertTrack(fields); await store.deleteAlbum(id);`),
    inMusic(`await ctx.db.insert("libraries", { name });`),
    inMusic(`const db = ctx.db; await db.insert("grants", grant);`),
    inMusic(`const row = await ctx.db.get(id); const page = ctx.db.query("tracks");`),
    inCore(`await ctx.db.patch(user._id, { role });`),
    inCore(`await ctx.db.delete(row._id);`),
    inCore(`await ctx.db.delete("schemaMigrations", id);`),
    inCore(`const rows = ctx.db.table("users").query();`),
    inCatalog(`const found = await store.first("albums", (q) => q.withIndex("by_artist"));`),
    inCatalog(`const batch = { store, meter: store.meter };`),
    inCatalog(`import type { PaginationOptions } from "convex/server";`),
    {
      code: `await db.insert("tracks", fitTrack(f)); await db.patch("tracks", id, f); await db.delete("albums", id);`,
      filename: writer,
    },
  ],
  invalid: [
    { ...inMusic(`await ctx.db.insert("tracks", fields);`), errors: [{ messageId: "direct" }] },
    { ...inMusic(`await ctx.db.patch(album._id, patch);`), errors: [{ messageId: "direct" }] },
    { ...inMusic(`await ctx.db.delete(album._id);`), errors: [{ messageId: "direct" }] },
    { ...inMusic(`await db.replace(id, doc);`), errors: [{ messageId: "direct" }] },
    { ...inMusic(`await ctx.db.delete("counters", id);`), errors: [{ messageId: "direct" }] },
    { ...inCore(`await ctx.db.insert("albums", album);`), errors: [{ messageId: "direct" }] },
    { ...inCore(`await ctx.db.delete("tracks", id);`), errors: [{ messageId: "direct" }] },
    {
      ...inCore(`await ctx.db.patch("localLyrics", id, fields);`),
      errors: [{ messageId: "direct" }],
    },
    {
      ...inMusic(`const { db: store } = ctx; await store.delete(id);`),
      errors: [{ messageId: "direct" }],
    },
    { ...inMusic(`await ctx.db[method]("tracks", f);`), errors: [{ messageId: "hidden" }] },
    {
      ...inMusic(`const { delete: drop } = ctx.db; await drop(id);`),
      errors: [{ messageId: "hidden" }],
    },
    {
      ...inMusic(`await ctx.db.table("libraries").insert(row);`),
      errors: [{ messageId: "hidden" }],
    },
    { ...inCore(`await ctx.db.table("artists").delete(id);`), errors: [{ messageId: "hidden" }] },
    { ...inCore(`await ctx.db.table(name).patch(id, f);`), errors: [{ messageId: "hidden" }] },
    { ...inCore(`const { table } = ctx.db;`), errors: [{ messageId: "hidden" }] },
    {
      ...inCatalog(`const rows = await ctx.db.query("tracks").take(2);`),
      errors: [{ messageId: "store" }],
    },
    {
      ...inCatalog(`const read = (db) => db.get(id);`),
      errors: [{ messageId: "store" }, { messageId: "store" }],
    },
    {
      ...inCatalog(`const { db: d } = ctx; await d.insert("tracks", f);`),
      errors: [{ messageId: "store" }],
    },
    {
      ...inCatalog(`import type { GenericDatabaseWriter } from "convex/server";`),
      errors: [{ messageId: "store" }],
    },
    {
      ...inCatalog(`import type { MutationCtx } from "../_generated/server";`),
      errors: [{ messageId: "store" }],
    },
  ],
});
