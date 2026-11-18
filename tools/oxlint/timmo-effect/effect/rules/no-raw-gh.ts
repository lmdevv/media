// Modified by [media]: private helper comments removed (see ../../UPSTREAM.md).
import { defineRule } from "@oxlint/plugins";

import { staticMemberName } from "../../shared/ast.ts";
import { resolveVariable } from "../../shared/scope.ts";

import type { ESTree, SourceCode } from "@oxlint/plugins";

const PACKAGE = "@timmo001/effect-gh";

const rawMethods = new Set(["execute", "json", "stream"]);

function isEffectGhImport(
  sourceCode: SourceCode,
  identifier: ESTree.IdentifierReference,
  name: string,
): boolean {
  return (
    resolveVariable(sourceCode, identifier)?.defs.some((definition) => {
      if (
        definition.type !== "ImportBinding" ||
        definition.parent?.type !== "ImportDeclaration" ||
        definition.parent.source.value !== PACKAGE ||
        definition.node.type !== "ImportSpecifier"
      ) {
        return false;
      }

      const imported = definition.node.imported;

      return (
        (imported.type === "Identifier" ? imported.name : imported.value) ===
        name
      );
    }) ?? false
  );
}

function isYieldGh(sourceCode: SourceCode, node: ESTree.Node | null): boolean {
  return (
    node?.type === "YieldExpression" &&
    node.delegate &&
    node.argument?.type === "Identifier" &&
    isEffectGhImport(sourceCode, node.argument, "Gh")
  );
}

function isGhBinding(
  sourceCode: SourceCode,
  identifier: ESTree.IdentifierReference,
): boolean {
  return (
    resolveVariable(sourceCode, identifier)?.defs.some(
      (definition) =>
        definition.type === "Variable" &&
        definition.node.type === "VariableDeclarator" &&
        isYieldGh(sourceCode, definition.node.init),
    ) ?? false
  );
}

const launcherName = /spawn|exec|run|command/i;

function calleeName(callee: ESTree.Expression): string | null {
  if (callee.type === "Identifier") return callee.name;

  return staticMemberName(callee);
}

function launchesGh(node: ESTree.CallExpression): boolean {
  const [command, argv] = node.arguments;

  if (command?.type === "Literal")
    return command.value === "gh" && argv !== undefined;

  if (command?.type !== "ArrayExpression") return false;
  const first = command.elements[0];

  return (
    first?.type === "Literal" &&
    first.value === "gh" &&
    launcherName.test(calleeName(node.callee) ?? "")
  );
}

/** Route gh through effect-gh's typed operations instead of raw argv or direct spawns. */
export const noRawGhRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Use @timmo001/effect-gh typed operations instead of the raw Gh methods, Api.raw, or spawning gh directly.",
    },
    messages: {
      rawGh:
        "Use a typed effect-gh operation instead of `Gh.{{method}}` with raw argv. Add one to effect-gh if the command has none.",
      rawApi:
        "Use `Api.json`, `Api.pages`, `Api.empty`, `Api.text` or `Api.headers` instead of `Api.raw`, so the response is typed.",
      spawnGh:
        "Run gh through a typed @timmo001/effect-gh operation instead of spawning it directly.",
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        const callee = node.callee;
        const method = staticMemberName(callee);

        if (callee.type === "MemberExpression" && method !== null) {
          const object = callee.object;

          if (
            rawMethods.has(method) &&
            (isYieldGh(context.sourceCode, object) ||
              (object.type === "Identifier" &&
                isGhBinding(context.sourceCode, object)))
          ) {
            context.report({ node, messageId: "rawGh", data: { method } });

            return;
          }

          if (
            method === "raw" &&
            object.type === "Identifier" &&
            isEffectGhImport(context.sourceCode, object, "Api")
          ) {
            context.report({ node, messageId: "rawApi" });

            return;
          }
        }

        if (launchesGh(node)) context.report({ node, messageId: "spawnGh" });
      },
    };
  },
});
