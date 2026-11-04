import type { GenericValidator, PropertyValidators } from "convex/values";
import { Match, Predicate } from "effect";

import { cliRefusals } from "./cli.ts";
import { commandKinds, domains } from "./command.ts";
import type { CommandKind, CommandName, Domain } from "./command.ts";
import { byCodeUnits } from "./order.ts";
import { contentDomains, scopes } from "./scopes.ts";
import type { ContentDomain, Scope } from "./scopes.ts";

/**
 * A declaration as the generator receives it. Node strips types without checking them when it runs
 * the generator, so `check` trusts none of these fields; every `Command` is one.
 */
export interface Declaration {
  readonly name: string;
  readonly kind?: string;
  readonly scope?: string;
  readonly refusesKeys?: boolean;
  readonly summary?: string;
  readonly args?: PropertyValidators;
  readonly result?: GenericValidator;
}

/**
 * A value a command takes or returns, parsed from its Convex validator. There is no `any` case, so
 * no output can carry `v.any()`.
 */
export type Wire =
  | { readonly kind: "string" }
  | { readonly kind: "float64" }
  | { readonly kind: "int64" }
  | { readonly kind: "boolean" }
  | { readonly kind: "null" }
  | { readonly kind: "bytes" }
  | { readonly kind: "id"; readonly table: string }
  | { readonly kind: "literal"; readonly value: string | number | boolean | bigint }
  | { readonly kind: "array"; readonly element: Wire }
  | { readonly kind: "record"; readonly key: Wire; readonly value: Wire }
  | { readonly kind: "union"; readonly members: ReadonlyArray<Wire> }
  | { readonly kind: "object"; readonly fields: ReadonlyArray<WireField> };

/** One field of an object or of a command's arguments. */
export interface WireField {
  readonly name: string;
  readonly optional: boolean;
  readonly wire: Wire;
}

/** A declaration that passed `check`. Every output is written from these alone. */
export interface CheckedCommand {
  readonly name: CommandName;
  readonly domain: Domain;
  /** The Convex module under `convex/`, such as `core/server`. */
  readonly module: string;
  /** The function's export in that module, such as `info`; the Convex path is `core/server:info`. */
  readonly exportName: string;
  readonly kind: CommandKind;
  readonly scope: Scope;
  readonly refusesKeys: boolean;
  readonly summary: string;
  readonly args: ReadonlyArray<WireField>;
  readonly result: Wire;
}

/** Why the generator refuses a declaration. */
export type Refusal =
  | { readonly reason: "bad-name"; readonly name: string; readonly detail: string }
  | { readonly reason: "duplicate-name"; readonly name: string }
  | { readonly reason: "nested-name"; readonly name: string; readonly inside: string }
  | { readonly reason: "case-clash"; readonly name: string; readonly module: string }
  | { readonly reason: "unknown-kind"; readonly name: string; readonly kind: string }
  | { readonly reason: "no-scope"; readonly name: string }
  | { readonly reason: "unknown-scope"; readonly name: string; readonly scope: string }
  | { readonly reason: "public-refuses-keys"; readonly name: string }
  | {
      readonly reason: "domain-scope";
      readonly name: string;
      readonly domain: Domain;
      readonly scope: Scope;
    }
  | { readonly reason: "bad-summary"; readonly name: string }
  | { readonly reason: "no-validator"; readonly name: string; readonly at: string }
  | { readonly reason: "args-object"; readonly name: string }
  | { readonly reason: "any-validator"; readonly name: string; readonly at: string }
  | {
      readonly reason: "unsupported-validator";
      readonly name: string;
      readonly at: string;
      readonly kind: string;
    }
  | { readonly reason: "optional-result"; readonly name: string }
  | {
      readonly reason: "cli-clash";
      readonly name: string;
      readonly other: string;
      readonly path: string;
    };

/** The outcome of `check`: every command parsed, or every refusal found. */
export type Checked =
  | { readonly ok: true; readonly commands: ReadonlyArray<CheckedCommand> }
  | { readonly ok: false; readonly refusals: ReadonlyArray<Refusal> };

type Parsed<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly refusals: ReadonlyArray<Refusal> };

const ok = <T>(value: T): Parsed<T> => ({ ok: true, value });

const refuse = <T>(refusal: Refusal): Parsed<T> => ({ ok: false, refusals: [refusal] });

const refusalsOf = <T>(parsed: Parsed<T>): ReadonlyArray<Refusal> =>
  parsed.ok ? [] : parsed.refusals;

const all = <T>(parts: ReadonlyArray<Parsed<T>>): Parsed<ReadonlyArray<T>> => {
  const refusals = parts.flatMap(refusalsOf);

  return refusals.length > 0
    ? { ok: false, refusals }
    : ok(parts.flatMap((part) => (part.ok ? [part.value] : [])));
};

const map = <A, B>(parsed: Parsed<A>, f: (value: A) => B): Parsed<B> =>
  parsed.ok ? ok(f(parsed.value)) : parsed;

const SEGMENT = /^[a-z][a-zA-Z0-9]*$/u;

/** Module names Convex or the core reserve: Convex skips `schema.ts`, and `lib/` holds helpers. */
const RESERVED_MODULES: ReadonlySet<string> = new Set(["lib", "schema"]);

const RESERVED_EXPORTS: ReadonlySet<string> = new Set(
  (
    "await break case catch class const continue debugger default delete do else enum export " +
    "extends false finally for function if implements import in instanceof interface let new null " +
    "package private protected public return static super switch this throw true try typeof var " +
    "void while with yield"
  ).split(" "),
);

const DOMAIN_LIST = new Intl.ListFormat("en", { type: "disjunction" }).format(domains);

const isCommandName = (name: string): name is CommandName =>
  name.split(".").length >= 3 && domains.some((domain) => name.startsWith(`${domain}.`));

/**
 * Summary text the outputs cannot carry as written: a line break or a comment end breaks the
 * JSDoc, a backtick or a leading `#` changes the Markdown reference, and the outputs add the stop.
 */
const UNSAFE_SUMMARY = /\*\/|[\n\r\u2028\u2029`]|^#|[.?!:;,]$/u;

const scopeDomain = (scope: Scope): ContentDomain | null =>
  contentDomains.find((domain) => scope.startsWith(`${domain}:`)) ?? null;

const outsideDomain = (domain: Domain, scope: Scope): boolean =>
  domain === "core" ? scopeDomain(scope) !== null : scopeDomain(scope) !== domain;

const scopesOf = (domain: Domain): ReadonlyArray<Scope> =>
  scopes.filter((scope) => scopeDomain(scope) === (domain === "core" ? null : domain));

const moduleOf = (name: string): string => name.split(".").slice(0, -1).join("/");

const parseName = (
  name: string,
): Parsed<Pick<CheckedCommand, "name" | "domain" | "module" | "exportName">> => {
  const segments = name.split(".");
  const domain = domains.find((known) => known === segments[0]);
  const exportName = segments.at(-1) ?? "";
  const modulePath = segments.slice(1, -1);
  const badSegment = segments.find((segment) => !SEGMENT.test(segment));

  const bad = (detail: string) => refuse<never>({ reason: "bad-name", name, detail });

  if (segments.length < 3) return bad("a name is a domain, a module, and a function");

  if (domain === undefined) return bad(`a name starts with ${DOMAIN_LIST}`);

  if (badSegment !== undefined) return bad(`"${badSegment}" is not camelCase letters and digits`);

  if (modulePath.some((segment) => RESERVED_MODULES.has(segment))) {
    return bad("lib and schema are reserved module names");
  }

  if (RESERVED_EXPORTS.has(exportName)) return bad(`"${exportName}" is a reserved word`);

  if (!isCommandName(name)) return bad("a name is a domain, a module, and a function");

  return ok({ name, domain, module: moduleOf(name), exportName });
};

const parseFields = (
  name: string,
  at: string,
  fields: PropertyValidators,
): Parsed<ReadonlyArray<WireField>> =>
  all(
    Object.entries(fields).map(([field, validator]) =>
      map(parseWire(name, `${at}.${field}`, validator), (wire) => ({
        name: field,
        optional: validator.isOptional === "optional",
        wire,
      })),
    ),
  );

const parseWire = (name: string, at: string, validator: GenericValidator): Parsed<Wire> =>
  !Predicate.hasProperty(validator, "isConvexValidator")
    ? refuse({ reason: "no-validator", name, at })
    : Match.value(validator).pipe(
        Match.discriminatorsExhaustive("kind")({
          string: (): Parsed<Wire> => ok({ kind: "string" }),
          float64: (): Parsed<Wire> => ok({ kind: "float64" }),
          int64: (): Parsed<Wire> => ok({ kind: "int64" }),
          boolean: (): Parsed<Wire> => ok({ kind: "boolean" }),
          null: (): Parsed<Wire> => ok({ kind: "null" }),
          bytes: (): Parsed<Wire> => ok({ kind: "bytes" }),
          id: (id): Parsed<Wire> => ok({ kind: "id", table: id.tableName }),
          literal: (literal): Parsed<Wire> =>
            Predicate.isString(literal.value) ||
            (Predicate.isNumber(literal.value) && Number.isFinite(literal.value)) ||
            Predicate.isBoolean(literal.value) ||
            Predicate.isBigInt(literal.value)
              ? ok({ kind: "literal", value: literal.value })
              : refuse({ reason: "unsupported-validator", name, at, kind: "literal" }),
          array: (array): Parsed<Wire> =>
            map(parseWire(name, `${at}[]`, array.element), (element) => ({
              kind: "array",
              element,
            })),
          record: (record): Parsed<Wire> => {
            const key = parseWire(name, `${at}{key}`, record.key);
            const value = parseWire(name, `${at}{value}`, record.value);

            return key.ok && value.ok
              ? ok({ kind: "record", key: key.value, value: value.value })
              : { ok: false, refusals: [...refusalsOf(key), ...refusalsOf(value)] };
          },
          union: (union): Parsed<Wire> =>
            map(
              all(union.members.map((member, index) => parseWire(name, `${at}|${index}`, member))),
              (members) => ({ kind: "union", members }),
            ),
          object: (object): Parsed<Wire> =>
            map(parseFields(name, at, object.fields), (fields) => ({ kind: "object", fields })),
          any: (): Parsed<Wire> => refuse({ reason: "any-validator", name, at }),
          commitTs: (): Parsed<Wire> =>
            refuse({ reason: "unsupported-validator", name, at, kind: "commitTs" }),
        }),
      );

const parseCommand = (declaration: Declaration): Parsed<CheckedCommand> => {
  const { name } = declaration;
  const named = parseName(name);
  const kind = commandKinds.find((known) => known === declaration.kind);
  const scope = scopes.find((known) => known === declaration.scope);
  const summary = declaration.summary?.trim() ?? "";
  const refusesKeys = declaration.refusesKeys === true;

  const args =
    declaration.args === undefined
      ? refuse<never>({ reason: "no-validator", name, at: "args" })
      : Predicate.hasProperty(declaration.args, "isConvexValidator")
        ? refuse<never>({ reason: "args-object", name })
        : parseFields(name, "args", declaration.args);

  const result =
    declaration.result === undefined
      ? refuse<never>({ reason: "no-validator", name, at: "result" })
      : parseWire(name, "result", declaration.result);

  const refusals: ReadonlyArray<Refusal> = [
    ...refusalsOf(named),
    ...(kind === undefined
      ? [{ reason: "unknown-kind", name, kind: String(declaration.kind) } as const]
      : []),
    ...(declaration.scope === undefined
      ? [{ reason: "no-scope", name } as const]
      : scope === undefined
        ? [{ reason: "unknown-scope", name, scope: declaration.scope } as const]
        : []),
    ...(named.ok && scope !== undefined && outsideDomain(named.value.domain, scope)
      ? [{ reason: "domain-scope", name, domain: named.value.domain, scope } as const]
      : []),
    ...(refusesKeys && declaration.scope === "public"
      ? [{ reason: "public-refuses-keys", name } as const]
      : []),
    ...(summary === "" || UNSAFE_SUMMARY.test(summary)
      ? [{ reason: "bad-summary", name } as const]
      : []),
    ...refusalsOf(args),
    ...refusalsOf(result),
    ...(declaration.result?.isOptional === "optional"
      ? [{ reason: "optional-result", name } as const]
      : []),
  ];

  return named.ok &&
    kind !== undefined &&
    scope !== undefined &&
    args.ok &&
    result.ok &&
    refusals.length === 0
    ? ok({
        ...named.value,
        kind,
        scope,
        refusesKeys,
        summary,
        args: args.value,
        result: result.value,
      })
    : { ok: false, refusals };
};

/**
 * Parses every declaration and collects every refusal, so one run reports all of them. The
 * commands come back sorted by name, so outputs do not depend on declaration order.
 */
export const check = (declarations: ReadonlyArray<Declaration>): Checked => {
  const counts = Map.groupBy(declarations, (declaration) => declaration.name);

  const duplicates = [...counts].flatMap(([name, group]): ReadonlyArray<Refusal> =>
    group.length > 1 ? [{ reason: "duplicate-name", name }] : [],
  );

  const names = [...counts.keys()].filter(isCommandName);

  const modulesByFold = Map.groupBy(new Set(names.map(moduleOf)), (module) => module.toLowerCase());

  const clashes = names.flatMap((name): ReadonlyArray<Refusal> => {
    const module = moduleOf(name);

    const others = (modulesByFold.get(module.toLowerCase()) ?? []).filter(
      (other) => other !== module,
    );

    return others.length > 0 ? [{ reason: "case-clash", name, module: others.join(", ") }] : [];
  });

  const nested = names.flatMap((name): ReadonlyArray<Refusal> =>
    names.flatMap((inside): ReadonlyArray<Refusal> =>
      inside.startsWith(`${name}.`) ? [{ reason: "nested-name", name, inside }] : [],
    ),
  );

  const parsed = all(declarations.map(parseCommand));

  const crossed = [...duplicates, ...nested, ...clashes];

  if (!parsed.ok || crossed.length > 0) {
    return { ok: false, refusals: [...crossed, ...refusalsOf(parsed)] };
  }

  const placed = cliRefusals(parsed.value);

  if (placed.length > 0) return { ok: false, refusals: placed };

  return {
    ok: true,
    commands: parsed.value.toSorted((left, right) => byCodeUnits(left.name, right.name)),
  };
};

/** One line that says which declaration was refused, why, and what to declare instead. */
export const refusalMessage = (refusal: Refusal): string =>
  `${refusal.name}: refused, ${Match.value(refusal).pipe(
    Match.discriminatorsExhaustive("reason")({
      "bad-name": (bad) => `bad name: ${bad.detail}`,
      "duplicate-name": () => "declared more than once",
      "nested-name": (nested) =>
        `${nested.inside} would make its function a module too (rename one of them)`,
      "unknown-kind": (unknown) =>
        `unknown kind "${unknown.kind}" (declare it with query, mutation, or action)`,
      "no-scope": () => `no scope (declare one of: ${scopes.join(", ")})`,
      "unknown-scope": (unknown) =>
        `unknown scope "${unknown.scope}" (declare one of: ${scopes.join(", ")})`,
      "domain-scope": (outside) =>
        `${outside.domain === "core" ? "a core command" : `a ${outside.domain} command`} cannot declare ${outside.scope} (declare one of: ${scopesOf(outside.domain).join(", ")})`,
      "public-refuses-keys": () =>
        "a public command has no session to refuse (drop refusesKeys or declare a scope)",
      "bad-summary": () =>
        "the summary must be one line of plain text with no closing punctuation, backticks, */, or leading #",
      "case-clash": (clash) =>
        `its module differs from ${clash.module} only in case, which is one file on macOS`,
      "no-validator": (missing) => `no Convex validator at ${missing.at}`,
      "args-object": () => "args is an object of validators, not v.object(...)",
      "any-validator": (any) => `v.any() at ${any.at} (declare the value's type)`,
      "unsupported-validator": (unsupported) =>
        `a ${unsupported.kind} validator at ${unsupported.at} is not supported`,
      "optional-result": () =>
        "the result cannot be optional (return v.union(..., v.null()) instead)",
      "cli-clash": (clash) =>
        `its CLI path \`media ${clash.path}\` is ${clash.other}'s or starts it (rename a module or function)`,
    }),
  )}`;

/**
 * A shared validator's wire form, for an output that renders it as source.
 *
 * @throws Error when `check` would refuse the validator, such as `v.any()`; the shared validators
 *   are code, so that is a defect.
 */
export const wireOf = (at: string, validator: GenericValidator): Wire => {
  const parsed = parseWire(at, at, validator);

  if (!parsed.ok) throw new Error(parsed.refusals.map(refusalMessage).join("\n"));

  return parsed.value;
};
