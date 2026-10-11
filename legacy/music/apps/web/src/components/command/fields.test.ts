import { argsDecoder } from "@music/commands/codec";
import { commands, isCommandName } from "@music/commands/registry";
import { Result } from "effect";
import { describe, expect, it } from "vitest";

import { fieldsOf, rawArgs } from "./fields";

describe("fieldsOf", () => {
  it("reads literal unions as choices", () => {
    expect(fieldsOf("playback.repeat")).toEqual([
      {
        name: "mode",
        label: "Mode",
        optional: false,
        field: { kind: "choice", options: ["off", "all", "one"] },
      },
    ]);
  });

  it("reads number bounds and integers from the schema checks", () => {
    expect(fieldsOf("playback.volume")?.[0]?.field).toEqual({
      kind: "number",
      integer: false,
      min: 0,
      max: 1,
    });
    expect(fieldsOf("playback.jump")?.[0]?.field).toEqual({
      kind: "number",
      integer: true,
      min: 0,
      max: null,
    });
  });

  it("turns ID fields into pickers and keeps optional flags", () => {
    expect(fieldsOf("queue.add")).toEqual([
      {
        name: "trackIds",
        label: "Songs",
        optional: false,
        field: { kind: "ids", entity: "track" },
      },
      {
        name: "next",
        label: "Play next instead of at the end",
        optional: true,
        field: { kind: "boolean" },
      },
    ]);
    expect(
      fieldsOf("libraries.create")?.map((field) => [field.name, field.field.kind, field.optional]),
    ).toEqual([
      ["name", "text", false],
      ["path", "text", false],
      ["visibility", "choice", true],
    ]);
  });

  it("describes every command a person can run from the menu", () => {
    const unreadable = Object.keys(commands)
      .filter(isCommandName)
      .filter((name) => fieldsOf(name) === null);

    expect(unreadable).toEqual([]);
  });
});

describe("rawArgs", () => {
  it("builds arguments the registry schema accepts", () => {
    const fields = fieldsOf("playback.volume") ?? [];
    const decoded = argsDecoder("playback.volume")(rawArgs(fields, { volume: "0.4" }));

    expect(Result.isSuccess(decoded) ? decoded.success : null).toEqual({ volume: 0.4 });
  });

  it("leaves empty optional fields out and lets the schema reject bad values", () => {
    const fields = fieldsOf("queue.add") ?? [];

    expect(rawArgs(fields, { trackIds: ["t1"], next: undefined })).toEqual({ trackIds: ["t1"] });
    expect(
      Result.isFailure(
        argsDecoder("playback.volume")(rawArgs(fieldsOf("playback.volume") ?? [], { volume: "2" })),
      ),
    ).toBe(true);
  });
});
