import { Result, Schema } from "effect";
import { describe, expect, it } from "vitest";

import { argsDecoder } from "./codec";
import { fieldsOf, missingFields, offeredCommands, outcomeOf, rawArgs } from "./forms";
import type { Role } from "./models";
import { commands, isCommandName } from "./registry";

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
    expect(fieldsOf("playback.play")?.[1]?.field).toEqual({
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

    expect(unreadable).toEqual(["devices.reconcile"]);
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

describe("missingFields", () => {
  const fields = fieldsOf("libraries.create") ?? [];

  it("names required fields that are unset or blank, and skips optional ones", () => {
    expect(missingFields(fields, { name: "  " }).map((field) => field.name)).toEqual([
      "name",
      "path",
    ]);
    expect(missingFields(fields, { name: "Music", path: "/music" })).toEqual([]);
  });

  it("counts an empty selection as missing", () => {
    const ids = fieldsOf("queue.add") ?? [];

    expect(missingFields(ids, { trackIds: [] }).map((field) => field.name)).toEqual(["trackIds"]);
    expect(missingFields(ids, { trackIds: ["t1"] })).toEqual([]);
  });
});

const names = (role: Role, playing: boolean) =>
  offeredCommands({ role, playing }).map((entry) => entry.name);

describe("offeredCommands", () => {
  it("offers only mutations whose arguments have form fields", () => {
    for (const { name, fields } of offeredCommands({ role: "owner", playing: true })) {
      expect(commands[name].kind).toBe("mutation");
      expect(fields).toEqual(fieldsOf(name));
    }
  });

  it("never offers the commands only players send", () => {
    const offered = names("owner", true);

    expect(offered).not.toContain("devices.heartbeat");
    expect(offered).not.toContain("devices.reconcile");
    expect(offered).not.toContain("playback.report");
  });

  it("offers each command to the roles that may run it", () => {
    expect(names("owner", true)).toContain("libraries.scan");
    expect(names("owner", true)).toContain("people.transfer");
    expect(names("admin", true)).toContain("libraries.scan");
    expect(names("admin", true)).not.toContain("people.transfer");
    expect(names("member", true)).not.toContain("libraries.scan");
    expect(names("member", true)).toContain("keys.create");
    expect(names("guest", true)).not.toContain("keys.create");
    expect(names("guest", true).every((name) => commands[name].access === "user")).toBe(true);
  });

  it("offers playback and queue controls only while a song is loaded", () => {
    expect(names("member", true)).toEqual(
      expect.arrayContaining(["playback.pause", "queue.clear"]),
    );
    expect(names("member", false)).not.toContain("playback.pause");
    expect(names("member", false)).not.toContain("queue.clear");
    // Starting playback needs nothing loaded.
    expect(names("member", false)).toContain("playback.play");
  });
});

describe("outcomeOf", () => {
  it("follows the job a scan starts", () => {
    const result = Schema.decodeSync(commands["libraries.scan"].result)({ jobId: "j1" });

    expect(outcomeOf(result)).toEqual({ kind: "job", jobId: "j1" });
  });

  it("follows the job when a result also carries other IDs", () => {
    const result = Schema.decodeSync(commands["libraries.create"].result)({
      libraryId: "l1",
      jobId: "j2",
    });

    expect(outcomeOf(result)).toEqual({ kind: "job", jobId: "j2" });
  });

  it("shows a new key", () => {
    const result = Schema.decodeSync(commands["keys.create"].result)({
      key: "mk_secret",
      apiKey: { id: "k1", name: "Laptop", prefix: "mk_", createdAt: 0, lastUsedAt: null },
    });

    expect(outcomeOf(result)).toEqual({ kind: "key", key: "mk_secret" });
  });

  it("shows a new invite's code", () => {
    const result = Schema.decodeSync(commands["invites.create"].result)({
      id: "i1",
      code: "abc123",
      email: null,
      role: "member",
      status: "open",
      createdAt: 0,
      expiresAt: 1,
      acceptedAt: null,
    });

    expect(outcomeOf(result)).toEqual({ kind: "invite", code: "abc123" });
  });

  it("shows a new password reset link", () => {
    const result = Schema.decodeSync(commands["people.reset"].result)({
      userId: "u1",
      token: "reset-token",
      expiresAt: 1,
    });

    expect(outcomeOf(result)).toEqual({ kind: "reset", token: "reset-token" });
  });

  it("opens a new playlist", () => {
    const result = Schema.decodeSync(commands["playlists.create"].result)({ playlistId: "p1" });

    expect(outcomeOf(result)).toEqual({ kind: "playlist", playlistId: "p1" });
  });

  it("shows nothing for a plain acknowledgement", () => {
    const result = Schema.decodeSync(commands["playback.pause"].result)({ ok: true });

    expect(outcomeOf(result)).toEqual({ kind: "none" });
  });
});
