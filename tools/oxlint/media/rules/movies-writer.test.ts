import { RuleTester } from "oxlint/plugins-dev";
import { describe, it } from "vitest";

import { moviesWriterRule } from "./movies-writer.ts";

RuleTester.describe = describe;
RuleTester.it = it;

const movies = "/repo/packages/platform/convex/movies/example.ts";
const core = "/repo/packages/platform/convex/core/example.ts";
const writer = "/repo/packages/platform/convex/movies/write.ts";

const inMovies = (code: string) => ({ code, filename: movies });
const inCore = (code: string) => ({ code, filename: core });

new RuleTester().run("movies-writer", moviesWriterRule, {
  valid: [
    inMovies(`await insertTitle(ctx.db, fields);`),
    inMovies(`await ctx.db.insert("libraries", { name });`),
    inMovies(`const db = ctx.db; await db.insert("grants", grant);`),
    inMovies(`await ctx.db.delete(id); const row = await ctx.db.get(id);`),
    inMovies(`const { query } = ctx.db; const page = ctx.db.query("titles");`),
    inCore(`await ctx.db.patch(user._id, { role });`),
    inCore(`const store = ctx.db; await store.insert("users", user);`),
    inCore(`const rows = await ctx.db.table("users").query().take(10);`),
    { code: `await db.insert("titles", fitTitle(fields)); await db.patch(id, f);`, filename: writer },
  ],
  invalid: [
    { ...inMovies(`await ctx.db.insert("titles", fields);`), errors: [{ messageId: "direct" }] },
    { ...inMovies(`await ctx.db.patch(person._id, patch);`), errors: [{ messageId: "direct" }] },
    { ...inMovies(`await db.replace(id, doc);`), errors: [{ messageId: "direct" }] },
    { ...inMovies(`await ctx.db.insert(table, fields);`), errors: [{ messageId: "direct" }] },
    { ...inCore(`await ctx.db.insert("people", person);`), errors: [{ messageId: "direct" }] },
    { ...inCore(`await ctx.db.patch("titles", id, fields);`), errors: [{ messageId: "direct" }] },
    {
      ...inMovies(`const store = ctx.db; await store.insert("episodes", row);`),
      errors: [{ messageId: "direct" }],
    },
    {
      ...inMovies(`let store; store = ctx.db; await store.patch(id, fields);`),
      errors: [{ messageId: "direct" }],
    },
    {
      ...inMovies(`const { db } = ctx; await db.patch(id, fields);`),
      errors: [{ messageId: "direct" }],
    },
    {
      ...inMovies(`const write = async ({ db: store }) => store.replace(id, doc);`),
      errors: [{ messageId: "direct" }],
    },
    {
      ...inCore(`const { db: store } = ctx; await store.insert("mediaFiles", file);`),
      errors: [{ messageId: "direct" }],
    },
    { ...inMovies(`await ctx.db["insert"]("titles", f);`), errors: [{ messageId: "direct" }] },
    { ...inCore(`await ctx["db"]["patch"]("credits", id, f);`), errors: [{ messageId: "direct" }] },
    { ...inMovies(`await ctx.db[method]("titles", f);`), errors: [{ messageId: "hidden" }] },
    { ...inCore(`await ctx.db[method]("titles", f);`), errors: [{ messageId: "hidden" }] },
    {
      ...inMovies(`const { insert } = ctx.db; await insert("titles", f);`),
      errors: [{ messageId: "hidden" }],
    },
    {
      ...inCore(`const { patch: put, ...rest } = ctx.db;`),
      errors: [{ messageId: "hidden" }, { messageId: "hidden" }],
    },
    { ...inCore(`const put = ctx.db.insert;`), errors: [{ messageId: "hidden" }] },
    { ...inMovies(`const put = ctx.db.patch.bind(ctx.db);`), errors: [{ messageId: "hidden" }] },
    {
      ...inMovies(`await ctx.db.table("libraries").insert(row);`),
      errors: [{ messageId: "hidden" }],
    },
    { ...inCore(`await ctx.db.table("titles").patch(id, f);`), errors: [{ messageId: "hidden" }] },
    { ...inCore(`const { table } = ctx.db;`), errors: [{ messageId: "hidden" }] },
  ],
});
