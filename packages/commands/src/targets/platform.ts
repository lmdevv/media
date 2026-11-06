import {
  downloadItem,
  downloadKinds,
  domainItem,
  grantPrincipal,
  itemTypes,
  level,
  levels,
  libraryId,
  resourceId,
  resourceType,
  resourceTypes,
  restrictions,
} from "../access.ts";
import { fieldsSource, wireSource } from "../render.ts";
import { downloadQuality, settingRows } from "../settings.ts";
import type { SettingScope } from "../settings.ts";
import { wireOf } from "../check.ts";
import type { CheckedCommand } from "../check.ts";
import type { CommandKind } from "../command.ts";
import type { Emitted, Target } from "../outputs.ts";
import { byCodeUnits } from "../order.ts";
import {
  assignableRoles,
  contentDomains,
  contentVerbs,
  credentialScopes,
  domainScopes,
  roleScopes,
  roles,
  scopes,
  serviceScopes,
} from "../scopes.ts";
import { GENERATED_NOTE } from "../note.ts";

const CONTEXTS = {
  query: "QueryCtx",
  mutation: "MutationCtx",
  action: "ActionCtx",
} as const satisfies { readonly [Kind in CommandKind]: string };

const CALLER_CHECKS = {
  query: "requireCaller",
  mutation: "requireCaller",
  action: "requireActionCaller",
} as const satisfies { readonly [Kind in CommandKind]: string };

const literalUnion = (values: ReadonlyArray<string>): string =>
  values.length === 0 ? "never" : values.map((value) => JSON.stringify(value)).join(" | ");

const literalValidator = (values: ReadonlyArray<string>): string =>
  `v.union(${values.map((value) => `v.literal(${JSON.stringify(value)})`).join(", ")})`;

const tuple = (values: ReadonlyArray<string>): string =>
  `[${values.map((value) => JSON.stringify(value)).join(", ")}] as const`;

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

  const checks = [
    ...new Set(
      commands.flatMap((command) => [
        ...(command.scope === "public" ? [] : [CALLER_CHECKS[command.kind]]),
        ...(command.refusesKeys ? ["refuseKeys"] : []),
      ]),
    ),
  ].toSorted();

  const validators = commands.flatMap((command) => [
    `const ${command.exportName}Args = v.object(${fieldsSource(command.args)});`,
    `const ${command.exportName}Result = ${wireSource(command.result)};`,
  ]);

  const handlers = commands.map((command) => {
    const { args, result } = types(command);
    const caller = command.scope === "public" ? "" : ", caller: Caller";

    const keys = command.refusesKeys ? ", API keys refused" : "";

    return [
      `/** \`${command.name}\` (${command.kind}, ${command.scope}${keys}): ${command.summary}. */`,
      `readonly ${command.exportName}: (ctx: Omit<${CONTEXTS[command.kind]}, "auth">, args: ${args}${caller}) => ${result} | Promise<${result}>;`,
    ].join("\n");
  });

  const refs = commands.map((command) => {
    const { args, result } = types(command);

    return `readonly ${command.exportName}: FunctionReference<"${command.kind}", "public", ${args}, ${result}>;`;
  });

  const registrations = commands.map((command) => {
    const check = `await ${CALLER_CHECKS[command.kind]}(ctx, "${command.scope}")`;

    const call =
      command.scope === "public"
        ? `handlers.${command.exportName}(ctx, args)`
        : `handlers.${command.exportName}(ctx, args, ${command.refusesKeys ? `refuseKeys(${check})` : check})`;

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
    ...(checks.length > 0
      ? [
          `import { ${checks.join(", ")} } from "${up}convex/core/auth/caller";`,
          `import type { Caller } from "${up}convex/core/auth/caller";`,
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
    text:
      [
        `${header}import { v } from "convex/values";`,
        [
          "/** A scope that needs a signed-in caller: every command scope but `public`. */",
          `export type CallerScope = ${literalUnion(callerScopes)};`,
        ].join("\n"),
        [
          "/** `CallerScope` as a Convex validator. */",
          `export const callerScope = ${literalValidator(callerScopes)};`,
        ].join("\n"),
        [
          "/** The scopes a sign-in credential can hold, in declaration order. */",
          `export const credentialScopes = ${tuple(credentialScopes)};`,
        ].join("\n"),
        [
          "/** A scope a sign-in credential can hold. */",
          "export type CredentialScope = (typeof credentialScopes)[number];",
        ].join("\n"),
        [
          "/** `CredentialScope` as a Convex validator, for stored credentials and their arguments. */",
          `export const credentialScope = ${literalValidator(credentialScopes)};`,
        ].join("\n"),
        [
          "/** The scopes only a service principal's API key holds. No role allows one. */",
          `export const serviceScopes = ${tuple(serviceScopes)};`,
        ].join("\n"),
        [
          "/** A scope only a service principal's API key holds. */",
          "export type ServiceScope = (typeof serviceScopes)[number];",
        ].join("\n"),
        [
          "/** `ServiceScope` as a Convex validator. */",
          `export const serviceScope = ${literalValidator(serviceScopes)};`,
        ].join("\n"),
        [
          "/** A scope an API key can hold, a credential scope or a service scope, as a Convex validator. */",
          "export const keyScope = v.union(credentialScope, serviceScope);",
        ].join("\n"),
        [
          "/** The content domains' scopes, the only scopes a session on a shared device holds. */",
          `export const domainScopes = ${tuple(domainScopes)};`,
        ].join("\n"),
        [
          "/** A user's platform role. The owner is the admin who holds the server. */",
          `export type Role = ${literalUnion(roles)};`,
        ].join("\n"),
        [
          "/** `Role` as a Convex validator. */",
          `export const role = ${literalValidator(roles)};`,
        ].join("\n"),
        [
          "/** A role an admin can give someone. */",
          `export type AssignableRole = ${literalUnion(assignableRoles)};`,
        ].join("\n"),
        [
          "/** `AssignableRole` as a Convex validator. */",
          `export const assignableRole = ${literalValidator(assignableRoles)};`,
        ].join("\n"),
        [
          "/**",
          " * Every scope each role allows. A password session holds all of its role's scopes; an API key",
          " * or a device holds the ones it was given, cut to its role's on each call.",
          " */",
          `export const roleScopes = {\n${roles.map((name) => `${name}: ${tuple(roleScopes[name])},`).join("\n")}\n} as const satisfies { readonly [R in Role]: ReadonlyArray<CredentialScope> };`,
        ].join("\n"),
        [
          "/** A domain that holds content. */",
          `export type ContentDomain = ${literalUnion(contentDomains)};`,
        ].join("\n"),
        [
          "/** `ContentDomain` as a Convex validator. */",
          `export const contentDomain = ${literalValidator(contentDomains)};`,
        ].join("\n"),
        [
          "/** What a credential may do in a content domain: the part after the colon of its scope. */",
          `export type ContentVerb = ${literalUnion(contentVerbs)};`,
        ].join("\n"),
      ].join("\n\n") + "\n",
  };
};

const shared = (name: string, docs: string, validator: Parameters<typeof wireOf>[1]): string =>
  `/** ${docs} */\nexport const ${name} = ${wireSource(wireOf(name, validator))};`;

const local = (name: string, docs: string, validator: Parameters<typeof wireOf>[1]): string =>
  `/** ${docs} */\nconst ${name} = ${wireSource(wireOf(name, validator))};`;

const accessFile = (): Emitted => ({
  path: "access.ts",
  text:
    [
      `${header}import { v } from "convex/values";\nimport type { Infer } from "convex/values";`,
      [
        "/** Grant levels, weakest first. Each level allows what the ones before it allow. */",
        `export const levels = ${tuple(levels)};`,
      ].join("\n"),
      ["/** A grant level. */", "export type Level = (typeof levels)[number];"].join("\n"),
      shared("level", "`Level` as a Convex validator.", level),
      [
        "/** Every resource type a grant can name, and the table that holds its rows. */",
        `export const resourceTypes = ${JSON.stringify(resourceTypes)} as const;`,
      ].join("\n"),
      [
        "/** A resource type a grant can name. */",
        "export type ResourceType = keyof typeof resourceTypes;",
      ].join("\n"),
      shared("resourceType", "`ResourceType` as a Convex validator.", resourceType),
      shared("resourceId", "The id of a row of any resource type.", resourceId),
      [
        "/** Every kind of domain item a device can keep for offline play, the table that holds it, and what its download serves. */",
        `export const downloadKinds = ${JSON.stringify(downloadKinds)} as const;`,
      ].join("\n"),
      [
        "/** A kind of domain item a device can keep. */",
        "export type DownloadKind = keyof typeof downloadKinds;",
      ].join("\n"),
      shared(
        "downloadItem",
        "One item a device can keep: its kind, and the id of its row in that kind's table.",
        downloadItem,
      ),
      [
        "/** One item a device can keep. */",
        "export type DownloadItem = Infer<typeof downloadItem>;",
      ].join("\n"),
      local(
        "libraryId",
        "A library's id, which the allowed-libraries restriction lists.",
        libraryId,
      ),
      ["/** A library's id. */", "export type LibraryId = Infer<typeof libraryId>;"].join("\n"),
      [
        "/** Every type of item a group session can hold, its domain, and the table of its rows. */",
        `export const itemTypes = ${JSON.stringify(itemTypes)} as const;`,
      ].join("\n"),
      [
        "/** A type of item a group session can hold. */",
        "export type ItemType = keyof typeof itemTypes;",
      ].join("\n"),
      shared(
        "domainItem",
        "An item with its domain; each domain pairs only with its own item types.",
        domainItem,
      ),
      [
        "/** An item with its domain. */",
        "export type DomainItem = Infer<typeof domainItem>;",
      ].join("\n"),
      local(
        "grantPrincipal",
        "Who a grant reaches: one user, a group's members, or every person on the server but guests.",
        grantPrincipal,
      ),
      [
        "/** Who a grant reaches. */",
        "export type GrantPrincipal = Infer<typeof grantPrincipal>;",
      ].join("\n"),
      shared(
        "restrictions",
        "A kid's limits, which an admin sets on a member (ADR 0005).",
        restrictions,
      ),
      [
        "/**",
        " * A kid's limits. `maxMovieAge` is the highest minimum viewer age a movie may carry, 0 to 21 (PG",
        " * is 7), or null for no cap. `libraries` is null for every library the person's grants reach.",
        " */",
        "export type Restrictions = Infer<typeof restrictions>;",
      ].join("\n"),
    ].join("\n\n") + "\n",
});

const inScope = (scope: SettingScope) => settingRows.filter(([, row]) => row.scope === scope);

const storedFields = (scope: SettingScope): string =>
  fieldsSource(
    inScope(scope).map(([name, row]) => ({
      name,
      optional: true,
      wire: wireOf(name, row.value),
    })),
  );

const defaults = (scope: SettingScope): string =>
  `{\n${inScope(scope)
    .map(([name, row]) => `${name}: ${JSON.stringify(row.default)},`)
    .join("\n")}\n} as const`;

const settingsFile = (): Emitted => ({
  path: "settings.ts",
  text:
    [
      `${header}import { v } from "convex/values";\nimport type { Infer } from "convex/values";`,
      [
        "/**",
        " * Every setting from the settings table (ADR 0019): who holds its value, the domains whose",
        " * players read it, and what a value must satisfy beyond its validator.",
        " */",
        `export const settingTable = {\n${settingRows
          .map(
            ([name, row]) =>
              `${name}: ${JSON.stringify({ scope: row.scope, domains: row.domains, check: row.check })},`,
          )
          .join("\n")}\n} as const;`,
      ].join("\n"),
      "export type SettingName = keyof typeof settingTable;",
      shared(
        "downloadQuality",
        "The quality a device keeps downloads at, as the `downloadQuality` setting and each download hold it.",
        downloadQuality,
      ),
      [
        "/** A quality a device keeps downloads at. */",
        "export type DownloadQuality = Infer<typeof downloadQuality>;",
      ].join("\n"),
      [
        "/** The settings that follow the person, as stored fields; a missing one is its default. */",
        `export const userSettingFields = ${storedFields("user")};`,
      ].join("\n"),
      [
        "/** The settings a person keeps per device, as stored fields; a missing one is its default. */",
        `export const deviceSettingFields = ${storedFields("device")};`,
      ].join("\n"),
      [
        "/** The settings that follow the person, in table order. */",
        `export const userSettingNames = ${tuple(inScope("user").map(([name]) => name))};`,
      ].join("\n"),
      [
        "/** The settings a person keeps per device, in table order. */",
        `export const deviceSettingNames = ${tuple(inScope("device").map(([name]) => name))};`,
      ].join("\n"),
      [
        "/** Each setting that follows the person, before anyone changed it. */",
        `export const userSettingDefaults = ${defaults("user")};`,
      ].join("\n"),
      [
        "/** Each setting a person keeps per device, before anyone changed it. */",
        `export const deviceSettingDefaults = ${defaults("device")};`,
      ].join("\n"),
    ].join("\n\n") + "\n",
});

/**
 * The core's Convex functions: for each Convex module, a contract with the module's validators,
 * its `Handlers` type, and `register`, which the hand-written module at `convex/<module>.ts` calls.
 * Also the scopes and roles, the access validators the schema and the commands share, the settings
 * table, and `refs.ts`, which checks `api` against the declarations.
 */
export const platformTarget = (root: string): Target => ({
  root,
  emit: (commands) => {
    const modules = byModule(commands);

    return modules.length === 0
      ? [accessFile(), scopesFile(), settingsFile()]
      : [
          accessFile(),
          ...modules.map(([module, inModule]) => contract(module, inModule)),
          refsFile(modules),
          scopesFile(),
          settingsFile(),
        ];
  },
});
