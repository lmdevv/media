import { commands } from "@media/contracts/commands";
import { Result } from "effect";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import { buildArgs, deriveFlags, FlagType, kebabCase } from "./flags";
import type { ParsedTokens } from "./flags";

const tokens = (
  values: ParsedTokens["values"],
  positionals: ReadonlyArray<string> = [],
): ParsedTokens => ({
  values,
  positionals,
});

describe("flag derivation", () => {
  it("kebab-cases field names", () => {
    expect(kebabCase("apiKeyId")).toBe("api-key-id");
    fc.assert(
      fc.property(fc.stringMatching(/^[a-z][a-zA-Z]{0,20}$/u), (key) => {
        expect(kebabCase(key)).toMatch(/^[a-z][a-z-]*$/u);
      }),
    );
  });

  it("types flags from the schema and defaults profile and device", () => {
    const flags = deriveFlags(commands["titles.search"].args);

    expect(
      flags.flags.map((spec) => [spec.flag, spec.type, spec.required, spec.defaulted]),
    ).toStrictEqual([
      ["profile-id", FlagType.Text(), true, true],
      ["query", FlagType.Text(), true, false],
      ["limit", FlagType.Number({ integer: true }), false, false],
    ]);
    expect(flags.positional?.key).toBe("query");
  });

  it("reads literal unions as choices and arrays as lists", () => {
    const { flags } = deriveFlags(commands["apiKeys.create"].args);
    const scopes = flags.find((spec) => spec.key === "scopes");

    expect(scopes?.type).toStrictEqual(
      FlagType.List({ item: FlagType.Choice({ choices: ["read", "play", "manage", "admin"] }) }),
    );
  });

  it("derives a flag set for every registry command", () => {
    for (const [name, command] of Object.entries(commands)) {
      expect(() => deriveFlags(command.args), name).not.toThrow();
    }
  });
});

describe("argument building", () => {
  const set = deriveFlags(commands["titles.search"].args);

  it("fills defaults, then --json, then the positional, then flags", () => {
    const built = buildArgs(
      set,
      tokens({ json: '{"query":"from json","limit":3}', limit: "7" }, ["alien", "covenant"]),
      "titles search",
      { profileId: "p1", deviceId: "d1" },
    );

    expect(built).toStrictEqual(
      Result.succeed({ profileId: "p1", query: "alien covenant", limit: 7 }),
    );
  });

  it("names a missing required flag", () => {
    const built = buildArgs(set, tokens({}), "titles search", { profileId: "p1" });

    expect(Result.isFailure(built) && built.failure.message).toBe("Missing --query");
  });

  it("rejects numbers and choices it cannot read", () => {
    expect(Result.isFailure(buildArgs(set, tokens({ limit: "lots" }, ["x"]), "t", {}))).toBe(true);

    const keys = deriveFlags(commands["apiKeys.create"].args);

    const bad = buildArgs(
      keys,
      tokens({ name: "k", scopes: ["read,root"] }),
      "api-keys create",
      {},
    );

    expect(Result.isFailure(bad) && bad.failure.message).toContain("--scopes must be one of");
  });
});
