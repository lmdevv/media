import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

/** The one module that writes the movies tables (ADR 0024). */
const WRITER = "packages/platform/convex/movies/write.ts";

const MOVIES_DIR = "packages/platform/convex/movies/";

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

/** Core tables a module in `movies/` may insert into: the stack probe's libraries and grants. */
const CORE_INSERTS: ReadonlySet<string> = new Set(["libraries", "grants"]);

const WRITES: ReadonlySet<string> = new Set(["insert", "patch", "replace"]);

/** A member's name: an identifier, a string in brackets, or null for any other computed key. */
const nameOf = (key: ESTree.Node, computed: boolean): string | null => {
  if (!computed && key.type === "Identifier") return key.name;

  return key.type === "Literal" && typeof key.value === "string" ? key.value : null;
};

const unwrapped = (node: ESTree.Node): ESTree.Node =>
  node.type === "TSNonNullExpression" ||
  node.type === "TSAsExpression" ||
  node.type === "ParenthesizedExpression"
    ? unwrapped(node.expression)
    : node;

/** The table a write call names as its first argument, or null when it names none. */
const tableOf = (node: ESTree.CallExpression): string | null => {
  const [first] = node.arguments;

  return first?.type === "Literal" && typeof first.value === "string" ? first.value : null;
};

/**
 * Route every insert, patch, and replace of a movies table through `movies/write.ts`, which fits
 * each document within the bound the reads reserve for it. A database is `db`, any member named
 * `db` (`ctx.db`, `ctx["db"]`), or a name it was given (`const store = ctx.db`, `{ db: store }`).
 * In `movies/`, any write on one but an insert into a core table is reported, since a patch or a
 * replace names only an id; elsewhere, a write that names a movies table is. Taking a write
 * method off a database without calling it (`const { insert } = ctx.db`, `ctx.db.patch.bind`),
 * or calling one through a computed name (`ctx.db[method]`), hides its table and is reported.
 */
export const moviesWriterRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Require movies-table writes to go through packages/platform/convex/movies/write.ts.",
    },
    messages: {
      direct:
        "Write movies tables through packages/platform/convex/movies/write.ts, which fits each document within the bound its reads reserve (ADR 0024).",
      hidden:
        "Call a database's insert, patch, or replace directly by name, so the table it writes is visible; write movies tables through packages/platform/convex/movies/write.ts (ADR 0024).",
    },
  },
  create(context) {
    const file = context.filename.replaceAll("\\", "/");
    const inMovies = file.includes(MOVIES_DIR);

    if (file.endsWith(WRITER)) return {};

    const aliases = new Set<string>(["db"]);
    const members: Array<ESTree.MemberExpression> = [];
    const patterns: Array<{ readonly pattern: ESTree.ObjectPattern; readonly from: ESTree.Node }> =
      [];

    const isDatabase = (candidate: ESTree.Node): boolean => {
      const node = unwrapped(candidate);

      if (node.type === "Identifier") return aliases.has(node.name);

      return node.type === "MemberExpression" && nameOf(node.property, node.computed) === "db";
    };

    /** Names a pattern gives the `db` it takes apart: `{ db }` and `{ db: store }`. */
    const aliasFrom = (pattern: ESTree.ObjectPattern): void => {
      for (const property of pattern.properties) {
        if (property.type !== "Property" || nameOf(property.key, property.computed) !== "db") {
          continue;
        }

        const value =
          property.value.type === "AssignmentPattern" ? property.value.left : property.value;

        if (value.type === "Identifier") aliases.add(value.name);
      }
    };

    const reportWrite = (call: ESTree.CallExpression, method: string): void => {
      const table = tableOf(call);

      const direct = inMovies
        ? method !== "insert" || table === null || !CORE_INSERTS.has(table)
        : table !== null && MOVIES_TABLES.has(table);

      if (direct) context.report({ node: call, messageId: "direct" });
    };

    return {
      VariableDeclarator(node) {
        if (node.init === null) return;

        if (node.id.type === "Identifier" && isDatabase(node.init)) aliases.add(node.id.name);

        if (node.id.type === "ObjectPattern") patterns.push({ pattern: node.id, from: node.init });
      },
      AssignmentExpression(node) {
        if (node.left.type === "Identifier" && isDatabase(node.right)) aliases.add(node.left.name);
      },
      ObjectPattern(node) {
        aliasFrom(node);
      },
      MemberExpression(node) {
        members.push(node);
      },
      "Program:exit"() {
        for (const { pattern, from } of patterns) {
          if (!isDatabase(from)) continue;

          for (const property of pattern.properties) {
            const name =
              property.type === "Property" ? nameOf(property.key, property.computed) : null;

            if (property.type === "RestElement" || name === null || WRITES.has(name)) {
              context.report({ node: property, messageId: "hidden" });
            }
          }
        }

        for (const member of members) {
          if (!isDatabase(member.object)) continue;

          const name = nameOf(member.property, member.computed);
          const parent = member.parent;
          const called = parent.type === "CallExpression" && parent.callee === member;

          if (name === null) {
            context.report({ node: member, messageId: "hidden" });
          } else if (WRITES.has(name)) {
            if (called) reportWrite(parent, name);
            else context.report({ node: member, messageId: "hidden" });
          }
        }
      },
    };
  },
});
