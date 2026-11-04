import type { CheckedCommand } from "../check.ts";
import { cliGroups, cliPath, isPaginated, secretsOf } from "../cli.ts";
import type { Emitted, Target } from "../outputs.ts";
import { GENERATED_NOTE } from "../note.ts";
import { fieldsSchema, wireSchema } from "../render.ts";

const entry = (command: CheckedCommand): string =>
  [
    "coreCommand({",
    `name: ${JSON.stringify(command.name)},`,
    `path: ${JSON.stringify(cliPath(command))},`,
    `kind: ${JSON.stringify(command.kind)},`,
    `scope: ${JSON.stringify(command.scope)},`,
    `refusesKeys: ${String(command.refusesKeys)},`,
    `summary: ${JSON.stringify(command.summary)},`,
    `secrets: ${JSON.stringify(secretsOf(command.args))},`,
    `paginated: ${String(isPaginated(command.args))},`,
    `args: ${fieldsSchema(command.args)},`,
    `result: ${wireSchema(command.result)},`,
    `method: (platform) => platform.${command.name},`,
    "}),",
  ].join("\n");

/** The CLI's generated command list. */
export const cliTarget = (root: string): Target => ({
  root,
  emit: (commands) => [
    {
      path: "groups.ts",
      text: [
        ...GENERATED_NOTE.map((line) => `// ${line}`),
        "",
        "/** The CLI groups, in help order; a group can have no commands yet. */",
        `export const coreGroups = ${JSON.stringify(cliGroups)} as const;`,
        "",
      ].join("\n"),
    } satisfies Emitted,
    {
      path: "commands.ts",
      text: [
        [
          ...GENERATED_NOTE.map((line) => `// ${line}`),
          "",
          'import { Schema } from "effect";',
          "",
          'import { coreCommand } from "../core/command";',
        ].join("\n"),
        [
          "/** Every command in the command list, at its CLI path, by name. */",
          `export const generatedCommands = [\n${commands.map(entry).join("\n")}\n];`,
        ].join("\n"),
      ]
        .join("\n\n")
        .concat("\n"),
    } satisfies Emitted,
  ],
});
