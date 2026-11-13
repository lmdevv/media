import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

/** A product domain whose tables one module writes (ADR 0024). */
export interface SingleWriter {
  /** The domain's folder, such as `packages/platform/convex/movies/`. */
  readonly dir: string;
  /** The one module that writes the domain's tables. */
  readonly writer: string;
  /** The domain's tables, which no module outside its folder writes either. */
  readonly tables: ReadonlySet<string>;
  /** Core tables a module in the domain's folder may insert into: the stack probe's. */
  readonly coreInserts: ReadonlySet<string>;
  /** The database methods that write a document, for the domain's writer to own. */
  readonly writes: ReadonlySet<string>;
  readonly description: string;
  readonly messages: {
    /** A write outside the writer. */
    readonly direct: string;
    /** A write whose table the code hides. */
    readonly hidden: string;
  };
  /**
   * Modules in the domain's folder that reach the database only through the writer, and what to
   * report there: any `db` name or member, any import from `_generated/server`, and any import of
   * Convex's generic database or context types.
   */
  readonly storeOnly?: { readonly modules: ReadonlyArray<string>; readonly message: string };
}

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

const DATABASE_TYPES = "_generated/server";

/** Convex's generic database and function context types, which hold a database. */
const GENERIC_DATABASE = /^Generic(?:Database|MutationCtx|QueryCtx|ActionCtx)/u;

/** Whether an import names a database: any import of the generated server, or a generic type. */
const importsDatabase = (node: ESTree.ImportDeclaration): boolean =>
  node.source.value.endsWith(DATABASE_TYPES) ||
  (node.source.value === "convex/server" &&
    node.specifiers.some(
      (specifier) =>
        specifier.type === "ImportSpecifier" &&
        GENERIC_DATABASE.test(nameOf(specifier.imported, false) ?? ""),
    ));

/**
 * Route every write of a domain's tables through its writer, which fits each document within the
 * bound the reads reserve for it. A database is `db`, any member named `db` (`ctx.db`,
 * `ctx["db"]`), or a name it was given (`const store = ctx.db`, `{ db: store }`). In the domain's
 * folder, any write on one but an insert into a core table is reported, since a patch, a replace,
 * or a delete may name only an id; elsewhere, a write that names a domain table is. Taking a write
 * method off a database without calling it (`const { insert } = ctx.db`, `ctx.db.patch.bind`),
 * calling one through a computed name (`ctx.db[method]`), or scoping a database to a table
 * (`ctx.db.table("titles")`), which writes without naming it, hides its table and is reported.
 */
export const singleWriterRule = (domain: SingleWriter) =>
  defineRule({
    meta: {
      type: "problem",
      docs: { description: domain.description },
      messages:
        domain.storeOnly === undefined
          ? domain.messages
          : { ...domain.messages, store: domain.storeOnly.message },
    },
    create(context) {
      const file = context.filename.replaceAll("\\", "/");
      const inDomain = file.includes(domain.dir);

      if (file.endsWith(domain.writer)) return {};

      if (domain.storeOnly?.modules.some((module) => file.endsWith(module)) === true) {
        return {
          ImportDeclaration(node) {
            if (importsDatabase(node)) context.report({ node, messageId: "store" });
          },
          MemberExpression(node) {
            if (nameOf(node.property, node.computed) === "db") {
              context.report({ node, messageId: "store" });
            }
          },
          // A `db` name anywhere but as a member, which `MemberExpression` reports: a variable,
          // a parameter, or a key taking one apart (`const { db: d } = ctx`).
          Identifier(node) {
            const parent = node.parent;

            const member =
              parent.type === "MemberExpression" && parent.property === node && !parent.computed;

            if (node.name === "db" && !member) context.report({ node, messageId: "store" });
          },
        };
      }

      const aliases = new Set<string>(["db"]);
      const members: Array<ESTree.MemberExpression> = [];
      const patterns: Array<{
        readonly pattern: ESTree.ObjectPattern;
        readonly from: ESTree.Node;
      }> = [];

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

        const direct = inDomain
          ? method !== "insert" || table === null || !domain.coreInserts.has(table)
          : table !== null && domain.tables.has(table);

        if (direct) context.report({ node: call, messageId: "direct" });
      };

      /** A database scoped to a table: in the domain's folder, or naming its table or none. */
      const reportTable = (call: ESTree.CallExpression): void => {
        const table = tableOf(call);

        if (inDomain || table === null || domain.tables.has(table)) {
          context.report({ node: call, messageId: "hidden" });
        }
      };

      return {
        VariableDeclarator(node) {
          if (node.init === null) return;

          if (node.id.type === "Identifier" && isDatabase(node.init)) aliases.add(node.id.name);

          if (node.id.type === "ObjectPattern") {
            patterns.push({ pattern: node.id, from: node.init });
          }
        },
        AssignmentExpression(node) {
          if (node.left.type === "Identifier" && isDatabase(node.right)) {
            aliases.add(node.left.name);
          }
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

              if (
                property.type === "RestElement" ||
                name === null ||
                name === "table" ||
                domain.writes.has(name)
              ) {
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
            } else if (name === "table") {
              if (called) reportTable(parent);
              else context.report({ node: member, messageId: "hidden" });
            } else if (domain.writes.has(name)) {
              if (called) reportWrite(parent, name);
              else context.report({ node: member, messageId: "hidden" });
            }
          }
        },
      };
    },
  });
