import { staticMemberName } from "./ast.ts";
import { resolveVariable } from "./scope.ts";

import type { ESTree, SourceCode } from "@oxlint/plugins";

export function isEffectImport(
  sourceCode: SourceCode,
  identifier: ESTree.IdentifierReference,
  namespace: boolean,
): boolean {
  const variable = resolveVariable(sourceCode, identifier);

  return (
    variable?.defs.some((definition) => {
      if (
        definition.type !== "ImportBinding" ||
        definition.parent?.type !== "ImportDeclaration" ||
        definition.parent.source.value !== "effect"
      ) {
        return false;
      }

      if (namespace) return definition.node.type === "ImportNamespaceSpecifier";

      if (definition.node.type !== "ImportSpecifier") return false;
      const imported = definition.node.imported;

      return (
        (imported.type === "Identifier" ? imported.name : imported.value) ===
        "Effect"
      );
    }) ?? false
  );
}

export function isEffectMethod(
  sourceCode: SourceCode,
  node: ESTree.Expression,
  method: "fn" | "gen",
): boolean {
  if (staticMemberName(node) !== method || node.type !== "MemberExpression") {
    return false;
  }

  const object = node.object;

  if (object.type === "Identifier") {
    return isEffectImport(sourceCode, object, false);
  }

  if (
    staticMemberName(object) !== "Effect" ||
    object.type !== "MemberExpression" ||
    object.object.type !== "Identifier"
  ) {
    return false;
  }

  return isEffectImport(sourceCode, object.object, true);
}

/** Whether a module imports Effect or one of its platform packages. */
export function importsEffect(program: ESTree.Program): boolean {
  return program.body.some(
    (statement) =>
      statement.type === "ImportDeclaration" &&
      statement.importKind !== "type" &&
      (statement.source.value === "effect" ||
        statement.source.value.startsWith("effect/") ||
        statement.source.value.startsWith("@effect/")),
  );
}
