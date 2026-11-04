import type { ESTree } from "@oxlint/plugins";

export type FunctionNode = ESTree.Function | ESTree.ArrowFunctionExpression;

export type TypeAssertion = ESTree.TSAsExpression | ESTree.TSTypeAssertion;

export function nearestEnclosingFunction(
  node: ESTree.Node,
): FunctionNode | null {
  let current: ESTree.Node | null = node.parent;

  while (current) {
    if (
      current.type === "FunctionDeclaration" ||
      current.type === "FunctionExpression" ||
      current.type === "ArrowFunctionExpression"
    ) {
      return current;
    }

    current = current.parent;
  }

  return null;
}

export function staticMemberName(node: ESTree.Node): string | null {
  if (node.type !== "MemberExpression" || node.computed) return null;

  return node.property.type === "Identifier" ? node.property.name : null;
}
