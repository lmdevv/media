import { defineRule } from "@oxlint/plugins";

import { staticMemberName } from "../../shared/ast.ts";
import { importsEffect } from "../../shared/effect.ts";
import { resolveVariable } from "../../shared/scope.ts";

type PlatformService = "childProcess" | "fileSystem";

const moduleServices = new Map<string, PlatformService>([
  ["child_process", "childProcess"],
  ["fs", "fileSystem"],
  ["fs/promises", "fileSystem"],
]);

const bunServices = new Map<string, PlatformService>([
  ["$", "childProcess"],
  ["file", "fileSystem"],
  ["spawn", "childProcess"],
  ["spawnSync", "childProcess"],
  ["write", "fileSystem"],
]);

/** Prefer Effect's platform services over direct process and file system APIs in Effect modules. */
export const preferPlatformServicesRule = defineRule({
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Prefer Effect's ChildProcessSpawner and FileSystem services over Node or Bun process and file system APIs in modules that use Effect.",
    },
    messages: {
      childProcess:
        "Use Effect's `ChildProcessSpawner` service (`effect/process`) instead of `{{api}}`, so scope cleanup, interruption, and test layers apply.",
      fileSystem:
        "Use Effect's `FileSystem` service instead of `{{api}}`, so failures stay typed and tests can provide a layer.",
    },
  },
  create(context) {
    let enabled = false;

    return {
      Program(node) {
        enabled = importsEffect(node);
      },
      ImportDeclaration(node) {
        if (!enabled || node.importKind === "type") return;
        const source = node.source.value;
        const service = moduleServices.get(source.replace(/^node:/u, ""));

        if (service) {
          context.report({ node, messageId: service, data: { api: source } });

          return;
        }

        if (source !== "bun") return;

        for (const specifier of node.specifiers) {
          if (
            specifier.type !== "ImportSpecifier" ||
            specifier.importKind === "type"
          ) {
            continue;
          }

          const imported =
            specifier.imported.type === "Identifier"
              ? specifier.imported.name
              : specifier.imported.value;

          const bunService = bunServices.get(imported);

          if (bunService) {
            context.report({
              node: specifier,
              messageId: bunService,
              data: { api: `Bun.${imported}` },
            });
          }
        }
      },
      MemberExpression(node) {
        const name = staticMemberName(node);
        const service = name ? bunServices.get(name) : undefined;

        if (
          !enabled ||
          !service ||
          node.object.type !== "Identifier" ||
          node.object.name !== "Bun" ||
          (resolveVariable(context.sourceCode, node.object)?.defs.length ?? 0) >
            0
        ) {
          return;
        }

        context.report({
          node,
          messageId: service,
          data: { api: `Bun.${name}` },
        });
      },
    };
  },
});
