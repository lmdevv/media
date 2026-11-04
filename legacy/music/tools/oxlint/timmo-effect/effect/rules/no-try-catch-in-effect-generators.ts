import { defineRule } from "@oxlint/plugins";

import { nearestEnclosingFunction } from "../../shared/ast.ts";
import { isEffectMethod } from "../../shared/effect.ts";

import type { FunctionNode } from "../../shared/ast.ts";
import type { ESTree, SourceCode } from "@oxlint/plugins";

function isDirectArgument(
  owner: FunctionNode,
  call: ESTree.CallExpression,
): boolean {
  return call.arguments.some((argument) => argument === owner);
}

function isRecognisedEffectGenerator(
  sourceCode: SourceCode,
  owner: FunctionNode,
): boolean {
  const parent = owner.parent;

  if (parent.type !== "CallExpression" || !isDirectArgument(owner, parent)) {
    return false;
  }

  if (isEffectMethod(sourceCode, parent.callee, "gen")) return true;

  const factoryCall = parent.callee;

  return (
    factoryCall.type === "CallExpression" &&
    isEffectMethod(sourceCode, factoryCall.callee, "fn")
  );
}

/** Keep expected failures in the Effect error channel inside Effect generators. */
export const noTryCatchInEffectGeneratorsRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow synchronous try/catch owned by recognised Effect generator callbacks.",
    },
    messages: {
      useEffectErrorChannel:
        "Keep expected failures in the Effect error channel. Use Effect.try for synchronous throwing work, Effect.tryPromise for asynchronous throwing work, Effect-returning schema APIs for decoding, and Effect recovery combinators for recovery.",
    },
  },
  create(context) {
    return {
      TryStatement(node) {
        if (!node.handler) return;
        const owner = nearestEnclosingFunction(node);

        if (
          !owner?.generator ||
          !isRecognisedEffectGenerator(context.sourceCode, owner)
        ) {
          return;
        }

        context.report({ node, messageId: "useEffectErrorChannel" });
      },
    };
  },
});
