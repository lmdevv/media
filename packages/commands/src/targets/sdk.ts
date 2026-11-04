import type { CheckedCommand } from "../check.ts";
import type { Emitted, Target } from "../outputs.ts";
import { GENERATED_NOTE } from "../note.ts";
import { fieldsSchema, wireSchema } from "../render.ts";

type Node =
  | { readonly kind: "leaf"; readonly command: CheckedCommand }
  | { readonly kind: "branch"; readonly children: ReadonlyMap<string, Node> };

const tree = (commands: ReadonlyArray<CheckedCommand>, depth = 0): Node => ({
  kind: "branch",
  children: new Map(
    [...Map.groupBy(commands, (command) => command.name.split(".")[depth] ?? "")].map(
      ([segment, group]) => {
        const endingHere = group.find((command) => command.name.split(".").length === depth + 1);

        return [
          segment,
          endingHere === undefined ? tree(group, depth + 1) : { kind: "leaf", command: endingHere },
        ];
      },
    ),
  ),
});

const declarationName = (command: CheckedCommand): string => command.name.replaceAll(".", "_");

const declaration = (command: CheckedCommand): string =>
  [
    `const ${declarationName(command)} = ${command.kind}({`,
    `name: ${JSON.stringify(command.name)},`,
    `path: ${JSON.stringify(`${command.module}:${command.exportName}`)},`,
    `args: ${fieldsSchema(command.args)},`,
    `result: ${wireSchema(command.result)},`,
    `});`,
  ].join("\n");

const methods = (node: Node): string =>
  node.kind === "leaf"
    ? `method.${node.command.kind}(${declarationName(node.command)})`
    : `{\n${[...node.children]
        .map(([segment, child]) =>
          child.kind === "leaf"
            ? `/** \`${child.command.name}\` (${child.command.kind}, ${child.command.scope}${child.command.refusesKeys ? ", API keys refused" : ""}): ${child.command.summary}. */\n${segment}: ${methods(child)},`
            : `${segment}: ${methods(child)},`,
        )
        .join("\n")}\n}`;

const header = `${GENERATED_NOTE.map((line) => `// ${line}`).join("\n")}\n\n`;

const commandsFile = (commands: ReadonlyArray<CheckedCommand>): Emitted => {
  const kinds = [...new Set(commands.map((command) => command.kind))].toSorted();
  const root = methods(tree(commands));

  return {
    path: "commands.ts",
    text: [
      [
        `${header}import { Schema } from "effect";`,
        "",
        `import { ${kinds.join(", ")} } from "../command";`,
        `import type { EffectBuilder, PromiseBuilder } from "../command";`,
      ].join("\n"),
      commands.map(declaration).join("\n\n"),
      [
        "/**",
        " * Every command as an Effect method, nested by name: `core.server.info` is",
        " * `platform.core.server.info()`.",
        " */",
        `export const effectMethods = (method: EffectBuilder) => (${root});`,
      ].join("\n"),
      [
        "/** Every command as a Promise method, nested by name as `effectMethods` is. */",
        `export const promiseMethods = (method: PromiseBuilder) => (${root});`,
      ].join("\n"),
    ]
      .join("\n\n")
      .concat("\n"),
  };
};

/**
 * The SDK's commands: a private declaration per command with the Convex function it calls and
 * Effect schemas for its arguments and result, and a method tree per entry point that gives each
 * one a method at its name's path, so `core.server.info` is `platform.core.server.info()`.
 */
export const sdkTarget = (root: string): Target => ({
  root,
  emit: (commands) => [commandsFile(commands)],
});
