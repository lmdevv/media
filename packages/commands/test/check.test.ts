import { v } from "convex/values";
import type { PropertyValidators } from "convex/values";
import { describe, expect, it } from "vitest";

import { check, refusalMessage } from "../src/check.ts";
import type { Declaration } from "../src/check.ts";
import { query } from "../src/command.ts";
import { fixtures } from "./fixtures.ts";

const info = {
  name: "core.server.info",
  kind: "query",
  scope: "public",
  summary: "Show this server's name and version",
  args: {},
  result: v.object({ name: v.string() }),
} as const satisfies Declaration;

const named = (name: string): Declaration => ({ ...info, name });

const refusalsOf = (declarations: ReadonlyArray<Declaration>): ReadonlyArray<string> => {
  const checked = check(declarations);

  return checked.ok ? [] : checked.refusals.map(refusalMessage);
};

describe("check", () => {
  it("names each command's Convex module and export from its name, sorted by name", () => {
    const checked = check(fixtures);

    expect(
      checked.ok &&
        checked.commands.map((command) => [command.name, command.module, command.exportName]),
    ).toEqual([
      ["core.server.info", "core/server", "info"],
      ["core.server.rename", "core/server", "rename"],
      ["music.playlists.load", "music/playlists", "load"],
    ]);
  });

  it("refuses a command with no scope", () => {
    const { scope: _, ...unscoped } = info;

    expect(refusalsOf([unscoped])).toEqual([
      "core.server.info: refused, no scope (declare one of: public, signed-in, account)",
    ]);
  });

  it("refuses a scope or a kind it does not know", () => {
    expect(refusalsOf([{ ...info, scope: "movies:read", kind: "subscription" }])).toEqual([
      'core.server.info: refused, unknown kind "subscription" (declare it with query, mutation, or action)',
      'core.server.info: refused, unknown scope "movies:read" (declare one of: public, signed-in, account)',
    ]);
  });

  it("refuses v.any() wherever it sits", () => {
    expect(
      refusalsOf([
        {
          ...info,
          args: { filter: v.optional(v.record(v.string(), v.any())) },
          result: v.object({ items: v.array(v.union(v.string(), v.any())) }),
        },
      ]),
    ).toEqual([
      "core.server.info: refused, v.any() at args.filter{value} (declare the value's type)",
      "core.server.info: refused, v.any() at result.items[]|1 (declare the value's type)",
    ]);
  });

  it("refuses a declaration with no arguments or result validator", () => {
    const { args: _args, result: _result, ...bare } = info;

    expect(refusalsOf([bare])).toEqual([
      "core.server.info: refused, no Convex validator at args",
      "core.server.info: refused, no Convex validator at result",
    ]);
  });

  it("refuses a value that is not a Convex validator, and args written as v.object(...)", () => {
    const stripped = v.string();
    const wrapped: PropertyValidators = {};

    Reflect.deleteProperty(stripped, "isConvexValidator");
    Object.assign(wrapped, v.object({ name: v.string() }));

    expect(
      refusalsOf([
        { ...info, args: { name: stripped } },
        { ...info, name: "core.server.rename", args: wrapped },
      ]),
    ).toEqual([
      "core.server.info: refused, no Convex validator at args.name",
      "core.server.rename: refused, args is an object of validators, not v.object(...)",
    ]);
  });

  it("refuses a literal that has no source form", () => {
    expect(refusalsOf([{ ...info, result: v.literal(Number.NaN) }])).toEqual([
      "core.server.info: refused, a literal validator at result is not supported",
    ]);
  });

  it("refuses a summary the outputs cannot carry as written", () => {
    expect(
      ["Match a/*/b */ path", "Show `info`", "# Server", "Restart it?"].map(
        (summary) => refusalsOf([{ ...info, summary }]).length,
      ),
    ).toEqual([1, 1, 1, 1]);
  });

  it("refuses module names that differ only in case", () => {
    expect(refusalsOf([named("core.ab.x"), named("core.aB.y")])).toEqual([
      "core.ab.x: refused, its module differs from core/aB only in case, which is one file on macOS",
      "core.aB.y: refused, its module differs from core/ab only in case, which is one file on macOS",
    ]);
  });

  it("refuses an optional result and a summary that is not one line", () => {
    expect(
      refusalsOf([{ ...info, summary: "Show\nthe server", result: v.optional(v.string()) }]),
    ).toEqual([
      "core.server.info: refused, the summary must be one line of plain text with no closing punctuation, backticks, */, or leading #",
      "core.server.info: refused, the result cannot be optional (return v.union(..., v.null()) instead)",
    ]);
  });

  it("refuses names that cannot map to a Convex function", () => {
    expect(
      refusalsOf(
        [
          "core.server",
          "photos.server.info",
          "core.server.Info",
          "core.lib.info",
          "core.schema.info",
          "core.server.delete",
        ].map(named),
      ),
    ).toEqual([
      "core.server: refused, bad name: a name is a domain, a module, and a function",
      "photos.server.info: refused, bad name: a name starts with core, movies, or music",
      'core.server.Info: refused, bad name: "Info" is not camelCase letters and digits',
      "core.lib.info: refused, bad name: lib and schema are reserved module names",
      "core.schema.info: refused, bad name: lib and schema are reserved module names",
      'core.server.delete: refused, bad name: "delete" is a reserved word',
    ]);
  });

  it("refuses a name that another name would turn into a module", () => {
    expect(refusalsOf([info, named("core.server.info.detail")])).toEqual([
      "core.server.info: refused, core.server.info.detail would make its function a module too (rename one of them)",
    ]);
  });

  it("refuses a name declared twice", () => {
    expect(refusalsOf([info, query("core.server.info", info)])).toEqual([
      "core.server.info: refused, declared more than once",
    ]);
  });
});
