import { Effect, Result } from "effect";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import { generatedCommands } from "./generated/commands";
import { buildArgs, deriveFlags, FlagType, kebabCase, optionsFor, tokenize } from "./flags";
import type { ParsedTokens } from "./flags";

const tokens = (
  values: ParsedTokens["values"],
  positionals: ReadonlyArray<string> = [],
): ParsedTokens => ({
  values,
  positionals,
});

const argsOf = (name: string) => {
  const command = generatedCommands.find((candidate) => candidate.name === name);

  if (command === undefined) throw new Error(`No generated command ${name}`);

  return command.args;
};

describe("flag derivation", () => {
  it("kebab-cases field names", () => {
    expect(kebabCase("apiKeyId")).toBe("api-key-id");
    fc.assert(
      fc.property(fc.stringMatching(/^[a-z][a-zA-Z]{0,20}$/u), (key) => {
        expect(kebabCase(key)).toMatch(/^[a-z][a-z-]*$/u);
      }),
    );
  });

  it("types flags from the schema and takes the one required text as the positional", () => {
    const flags = deriveFlags(argsOf("movies.titles.search"));

    expect(flags.flags.map((spec) => [spec.flag, spec.type, spec.required])).toStrictEqual([
      ["query", FlagType.Text(), true],
      ["limit", FlagType.Number({ integer: false }), false],
    ]);
    expect(flags.positional?.key).toBe("query");
  });

  it("reads literal unions as choices and arrays as lists", () => {
    const { flags } = deriveFlags(argsOf("core.auth.apiKeys.create"));
    const scopes = flags.find((spec) => spec.key === "scopes");

    expect(FlagType.$is("List")(scopes?.type ?? FlagType.Text())).toBe(true);
  });

  it("derives a flag set for every generated command", () => {
    for (const command of generatedCommands) {
      expect(() => deriveFlags(command.args), command.name).not.toThrow();
    }
  });
});

describe("flag tokenization", () => {
  it("rejects value words for every generated boolean flag", () => {
    for (const command of generatedCommands) {
      const set = deriveFlags(command.args);

      for (const spec of set.flags.filter((flag) => FlagType.$is("Boolean")(flag.type))) {
        for (const flag of [`--${spec.flag}`, `--no-${spec.flag}`]) {
          for (const word of ["true", "false", "yes", "no", "FALSE"]) {
            const parsed = Effect.runSync(
              Effect.result(tokenize(optionsFor(set, {}), [flag, word], command.name)),
            );

            expect(Result.isFailure(parsed) && parsed.failure.message, command.name).toBe(
              `--${spec.flag} takes no value: use --${spec.flag} or --no-${spec.flag}`,
            );
          }
        }
      }
    }
  });

  it("keeps a boolean-looking positional after --", () => {
    const set = deriveFlags(argsOf("core.connect.targets.control"));

    const parsed = Effect.runSync(
      tokenize(optionsFor(set, {}), ["--playing", "--", "false"], "auth targets control"),
    );

    expect(buildArgs(set, parsed, "auth targets control")).toStrictEqual(
      Result.succeed({ deviceId: "false", playing: true }),
    );
  });
});

describe("argument building", () => {
  const set = deriveFlags(argsOf("movies.titles.search"));

  it("takes --json, then the positional, then flags", () => {
    const built = buildArgs(
      set,
      tokens({ json: '{"query":"from json","limit":3}', limit: "7" }, ["alien covenant"]),
      "movies titles search",
    );

    expect(built).toStrictEqual(Result.succeed({ query: "alien covenant", limit: 7 }));
  });

  it("rejects a positional supplied again by its flag", () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (positional, explicit) => {
        const built = buildArgs(
          set,
          tokens({ query: explicit }, [positional]),
          "movies titles search",
        );

        expect(Result.isFailure(built) && built.failure.message).toBe(
          "--query and the <query> argument both supply query; use only one",
        );
      }),
    );
  });

  it("requires quotes around a scalar positional containing spaces", () => {
    const built = buildArgs(set, tokens({}, ["alien", "covenant"]), "movies titles search");

    expect(Result.isFailure(built) && built.failure.message).toBe(
      "Expected one value for --query; quote values containing spaces or use --query <value>",
    );
  });

  it("names a missing required flag", () => {
    const built = buildArgs(set, tokens({}), "movies titles search");

    expect(Result.isFailure(built) && built.failure.message).toBe("Missing --query");
  });

  it("accepts several list positionals and rejects supplying their flag too", () => {
    const list = deriveFlags(argsOf("music.queue.add"));

    expect(buildArgs(list, tokens({}, ["a", "b"]), "music queue add")).toStrictEqual(
      Result.succeed({ trackIds: ["a", "b"] }),
    );
    expect(
      Result.isFailure(
        buildArgs(list, tokens({ "track-ids": ["c"] }, ["a", "b"]), "music queue add"),
      ),
    ).toBe(true);
  });

  it("rejects numbers and choices it cannot read", () => {
    expect(Result.isFailure(buildArgs(set, tokens({ limit: "lots" }, ["x"]), "t"))).toBe(true);

    const keys = deriveFlags(argsOf("core.auth.apiKeys.create"));

    const bad = buildArgs(
      keys,
      tokens({ name: "k", scopes: ["account,root"] }),
      "auth api-keys create",
    );

    expect(Result.isFailure(bad) && bad.failure.message).toContain("--scopes must be one of");
  });
});
