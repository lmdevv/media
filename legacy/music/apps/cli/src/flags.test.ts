import { TrackId } from "@music/commands/ids";
import { commands } from "@music/commands/registry";
import type { CommandName } from "@music/commands/registry";
import { Effect, Result, Schema } from "effect";
import { array, assert, property, stringMatching } from "fast-check";
import { describe, expect, it } from "vitest";

import { validateArgs } from "./api";
import type { UsageError } from "./errors";
import type { WireArgs } from "./flags";
import {
  buildArgs,
  deriveFlags,
  FlagType,
  flagUsage,
  kebabCase,
  optionsFor,
  tokenize,
} from "./flags";

/** Parses argv for a registry command the way the CLI does, without validating. */
const argsFor = (
  name: CommandName,
  argv: ReadonlyArray<string>,
): Result.Result<WireArgs, UsageError> => {
  const set = deriveFlags(commands[name].args);

  return Effect.runSync(
    Effect.result(
      tokenize(optionsFor(set, {}), argv, name).pipe(
        Effect.flatMap((tokens) => Effect.fromResult(buildArgs(set, tokens, name))),
      ),
    ),
  );
};

const messageOf = (result: Result.Result<WireArgs, UsageError>): string =>
  Result.match(result, { onSuccess: () => "", onFailure: (error) => error.message });

describe("deriveFlags", () => {
  it("derives one flag per field kind", () => {
    const Sample = Schema.Struct({
      title: Schema.String,
      count: Schema.Int,
      ratio: Schema.Finite,
      on: Schema.Boolean,
      mode: Schema.Literals(["off", "all"]),
      tags: Schema.Array(Schema.String),
      sizes: Schema.Array(Schema.Int),
      trackId: TrackId,
      note: Schema.optionalKey(Schema.String),
      cursor: Schema.optionalKey(Schema.NullOr(Schema.String)),
      nested: Schema.Struct({ value: Schema.String }),
    });

    expect(deriveFlags(Sample).flags).toEqual([
      { key: "title", flag: "title", type: FlagType.Text(), required: true },
      { key: "count", flag: "count", type: FlagType.Number({ integer: true }), required: true },
      { key: "ratio", flag: "ratio", type: FlagType.Number({ integer: false }), required: true },
      { key: "on", flag: "on", type: FlagType.Boolean(), required: true },
      {
        key: "mode",
        flag: "mode",
        type: FlagType.Choice({ choices: ["off", "all"] }),
        required: true,
      },
      { key: "tags", flag: "tags", type: FlagType.List({ item: FlagType.Text() }), required: true },
      {
        key: "sizes",
        flag: "sizes",
        type: FlagType.List({ item: FlagType.Number({ integer: true }) }),
        required: true,
      },
      { key: "trackId", flag: "track-id", type: FlagType.Text(), required: true },
      { key: "note", flag: "note", type: FlagType.Text(), required: false },
      { key: "cursor", flag: "cursor", type: FlagType.Text(), required: false },
      { key: "nested", flag: "nested", type: FlagType.Json(), required: true },
    ]);
  });

  it("offers a positional argument only when exactly one non-boolean field is required", () => {
    expect(deriveFlags(commands["playlists.create"].args).positional?.key).toBe("name");
    expect(deriveFlags(commands["playback.play"].args).positional?.key).toBe("trackIds");
    expect(deriveFlags(commands["search"].args).positional?.key).toBe("query");
    expect(deriveFlags(commands["likes.set"].args).positional?.key).toBe("trackId");
    expect(deriveFlags(commands["playlists.rename"].args).positional).toBeNull();
    expect(deriveFlags(commands["playback.shuffle"].args).positional).toBeNull();
    expect(deriveFlags(commands["playlists.list"].args)).toEqual({ flags: [], positional: null });
  });

  it("covers every registry command without falling back to JSON flags", () => {
    const jsonFlags = Object.entries(commands).flatMap(([name, command]) =>
      deriveFlags(command.args).flags.flatMap((spec) =>
        FlagType.$is("Json")(spec.type) ? [`${name} --${spec.flag}`] : [],
      ),
    );

    expect(jsonFlags).toEqual(["devices.reconcile --plays", "devices.reconcile --resume"]);
  });

  it("renders usage for each flag type", () => {
    const usages = deriveFlags(commands["playback.play"].args).flags.map(flagUsage);

    expect(usages).toEqual(["--track-ids <id,...>", "--index <int>", "--device-id <id>"]);
    expect(deriveFlags(commands["playback.repeat"].args).flags.map(flagUsage)).toEqual([
      "--mode <off|all|one>",
    ]);
    expect(deriveFlags(commands["playback.shuffle"].args).flags.map(flagUsage)).toEqual([
      "--on | --no-on",
    ]);
  });

  it("kebab-cases field names", () => {
    expect(kebabCase("apiKeyId")).toBe("api-key-id");
    expect(kebabCase("query")).toBe("query");
  });
});

describe("buildArgs", () => {
  it("converts each flag type to its wire value", () => {
    expect(argsFor("albums.list", ["--limit", "20", "--cursor", "abc"])).toEqual(
      Result.succeed({ limit: 20, cursor: "abc" }),
    );
    expect(argsFor("playback.volume", ["--volume", "0.5"])).toEqual(
      Result.succeed({ volume: 0.5 }),
    );
    expect(argsFor("playback.shuffle", ["--on"])).toEqual(Result.succeed({ on: true }));
    expect(argsFor("playback.shuffle", ["--no-on"])).toEqual(Result.succeed({ on: false }));
    expect(argsFor("playback.repeat", ["one"])).toEqual(Result.succeed({ mode: "one" }));
    expect(argsFor("search", ["daft", "punk", "--limit", "5"])).toEqual(
      Result.succeed({ query: "daft punk", limit: 5 }),
    );
  });

  it("accepts lists repeated, comma-separated, or positional", () => {
    assert(
      property(array(stringMatching(/^[a-z0-9]{1,8}$/u), { minLength: 1, maxLength: 6 }), (ids) => {
        const expected = Result.succeed({ trackIds: ids });

        expect(argsFor("playback.play", ["--track-ids", ids.join(",")])).toEqual(expected);
        expect(
          argsFor(
            "playback.play",
            ids.flatMap((id) => ["--track-ids", id]),
          ),
        ).toEqual(expected);
        expect(argsFor("playback.play", ids)).toEqual(expected);
      }),
    );
  });

  it("merges --args JSON under explicit flags", () => {
    expect(
      argsFor("playlists.create", [
        "--args",
        '{"name":"From JSON","description":"d"}',
        "--name",
        "Flag",
      ]),
    ).toEqual(Result.succeed({ name: "Flag", description: "d" }));
  });

  it("explains missing, malformed, and unknown flags", () => {
    expect(messageOf(argsFor("playlists.rename", ["--name", "x"]))).toBe("Missing --playlist-id");
    expect(messageOf(argsFor("playback.shuffle", []))).toBe("Missing --on or --no-on");
    expect(messageOf(argsFor("albums.list", ["--limit", "ten"]))).toBe(
      '--limit expects an integer, got "ten"',
    );
    expect(messageOf(argsFor("playback.repeat", ["--mode", "twice"]))).toBe(
      '--mode must be one of off, all, one; got "twice"',
    );
    expect(messageOf(argsFor("playlists.list", ["--colour", "red"]))).toBe(
      "Unknown option '--colour'",
    );
    expect(messageOf(argsFor("playlists.list", ["extra"]))).toBe(
      'Unexpected argument "extra"; pass values with flags',
    );
    expect(messageOf(argsFor("playlists.create", ["--args", "[1]"]))).toBe(
      "--args expects a JSON object",
    );
  });
});

const validationMessage = (name: CommandName, args: WireArgs): string =>
  Result.match(validateArgs(name, args, name), {
    onSuccess: () => "",
    onFailure: (error) => error.message,
  });

describe("validateArgs", () => {
  it("checks values against the registry schema and names the flag", () => {
    expect(validationMessage("playback.volume", { volume: 2 })).toBe(
      "--volume: Expected a value between 0 and 1",
    );
    expect(validationMessage("albums.list", { limit: 500 })).toBe(
      "--limit: Expected a value between 1 and 200",
    );
    expect(validationMessage("libraries.create", { name: "x", path: "relative" })).toBe(
      '--path: Expected a string starting with "/"',
    );
  });

  it("reports every invalid field at once", () => {
    expect(validationMessage("playback.play", { trackIds: [], index: -1 })).toBe(
      [
        "--track-ids: Expected a value with a length of at least 1",
        "--index: Expected a value greater than or equal to 0",
      ].join("\n"),
    );
  });

  it("accepts valid arguments unchanged", () => {
    expect(validateArgs("playlists.create", { name: "Road trip" }, "playlists create")).toEqual(
      Result.succeed({ name: "Road trip" }),
    );
  });
});
