import { fieldsSource, wireSource } from "../render.ts";
import type { CheckedCommand } from "../check.ts";
import type { CommandKind } from "../command.ts";
import type { Emitted, Target } from "../outputs.ts";
import { byCodeUnits } from "../order.ts";
import { scopes } from "../scopes.ts";
import { GENERATED_NOTE } from "../note.ts";

const CONTEXTS = {
  query: "QueryCtx",
  mutation: "MutationCtx",
  action: "ActionCtx",
} as const satisfies { readonly [Kind in CommandKind]: string };

const header = `${GENERATED_NOTE.map((line) => `// ${line}`).join("\n")}\n\n`;

const moduleAlias = (module: string): string => module.replaceAll("/", "_");

const byModule = (
  commands: ReadonlyArray<CheckedCommand>,
): ReadonlyArray<readonly [string, ReadonlyArray<CheckedCommand>]> =>
  [...Map.groupBy(commands, (command) => command.module)].toSorted(([left], [right]) =>
    byCodeUnits(left, right),
  );

/** `Record<string, never>` for an object with no fields, which `Infer` would give as `{}`. */
const EMPTY_OBJECT = "Record<string, never>";

const types = (command: CheckedCommand) => ({
  args: command.args.length === 0 ? EMPTY_OBJECT : `Infer<typeof ${command.exportName}Args>`,
  result:
    command.result.kind === "object" && command.result.fields.length === 0
      ? EMPTY_OBJECT
      : `Infer<typeof ${command.exportName}Result>`,
});

const contract = (module: string, commands: ReadonlyArray<CheckedCommand>): Emitted => {
  const up = "../".repeat(module.split("/").length);
  const group = module.replaceAll("/", ".");
  const kinds = [...new Set(commands.map((command) => command.kind))].toSorted();
  const scoped = commands.some((command) => command.scope !== "public");

  const validators = commands.flatMap((command) => [
    `const ${command.exportName}Args = v.object(${fieldsSource(command.args)});`,
    `const ${command.exportName}Result = ${wireSource(command.result)};`,
  ]);

  const handlers = commands.map((command) => {
    const { args, result } = types(command);
    const caller = command.scope === "public" ? "" : ", caller: Caller";

    return [
      `/** \`${command.name}\` (${command.kind}, ${command.scope}): ${command.summary}. */`,
      `readonly ${command.exportName}: (ctx: ${CONTEXTS[command.kind]}, args: ${args}${caller}) => ${result} | Promise<${result}>;`,
    ].join("\n");
  });

  const refs = commands.map((command) => {
    const { args, result } = types(command);

    return `readonly ${command.exportName}: FunctionReference<"${command.kind}", "public", ${args}, ${result}>;`;
  });

  const registrations = commands.map((command) => {
    const call =
      command.scope === "public"
        ? `handlers.${command.exportName}(ctx, args)`
        : `handlers.${command.exportName}(ctx, args, await requireCaller(ctx, "${command.scope}"))`;

    return [
      `${command.exportName}: ${command.kind}({`,
      `args: ${command.exportName}Args,`,
      `returns: ${command.exportName}Result,`,
      `handler: async (ctx, args) => ${call},`,
      `}),`,
    ].join("\n");
  });

  const imports = [
    `import type { FunctionReference } from "convex/server";`,
    `import { v } from "convex/values";`,
    `import type { Infer } from "convex/values";`,
    "",
    `import { ${kinds.join(", ")} } from "${up}convex/_generated/server";`,
    `import type { ${kinds.map((kind) => CONTEXTS[kind]).join(", ")} } from "${up}convex/_generated/server";`,
    ...(scoped
      ? [
          `import { requireCaller } from "${up}convex/core/lib/caller";`,
          `import type { Caller } from "${up}convex/core/lib/caller";`,
        ]
      : []),
  ];

  const text = [
    header + imports.join("\n"),
    validators.join("\n\n"),
    `/** The handlers \`convex/${module}.ts\` passes to \`register\`, one per \`${group}\` command. */\nexport interface Handlers {\n${handlers.join("\n\n")}\n}`,
    `/** The \`api\` reference of each \`${group}\` command; \`commands/refs.ts\` checks them. */\nexport interface Refs {\n${refs.join("\n")}\n}`,
    `/** Registers the \`${group}\` commands as public Convex functions with their declared arguments and result. */\nexport const register = (handlers: Handlers) => ({\n${registrations.join("\n")}\n});`,
  ].join("\n\n");

  return { path: `${module}.ts`, text: `${text}\n` };
};

const refsFile = (modules: ReadonlyArray<readonly [string, ReadonlyArray<CheckedCommand>]>) => {
  const imports = modules.map(
    ([module]) => `import type { Refs as ${moduleAlias(module)} } from "./${module}";`,
  );

  const entries = modules.flatMap(([module, commands]) =>
    commands.map(
      (command) =>
        `"${command.name}": api.${command.name} satisfies ${moduleAlias(module)}["${command.exportName}"],`,
    ),
  );

  return {
    path: "refs.ts",
    text: [
      `${header}import { api } from "../convex/_generated/api";`,
      imports.join("\n"),
      [
        "/**",
        " * Every command's `api` reference by name. It fails to compile when a command's Convex module is",
        " * missing or does not export it from `register`, or when `convex/_generated` is stale: run",
        " * `pnpm --filter @media/commands generate` with the dev stack up.",
        " */",
        `export const commandRefs = {\n${entries.join("\n")}\n} as const;`,
      ].join("\n"),
    ].join("\n\n"),
  };
};

const scopesFile = (): Emitted => {
  const callerScopes = scopes.filter((scope) => scope !== "public");

  return {
    path: "scopes.ts",
    text: [
      header,
      "/** A scope that needs a signed-in caller: every command scope but `public`. */\n",
      `export type CallerScope = ${callerScopes.length === 0 ? "never" : callerScopes.map((scope) => JSON.stringify(scope)).join(" | ")};\n`,
    ].join(""),
  };
};

/**
 * The core's Convex functions: for each Convex module, a contract with the module's validators,
 * its `Handlers` type, and `register`, which the hand-written module at `convex/<module>.ts` calls.
 * Also the caller scopes and `refs.ts`, which checks `api` against the declarations.
 */
export const platformTarget = (root: string): Target => ({
  root,
  emit: (commands) => {
    const modules = byModule(commands);

    return modules.length === 0
      ? [scopesFile()]
      : [
          ...modules.map(([module, inModule]) => contract(module, inModule)),
          refsFile(modules),
          scopesFile(),
        ];
  },
});
