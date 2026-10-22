import { fieldsOf, offeredCommands, outcomeOf } from "@music/commands/forms";
import { Job, Library } from "@music/commands/models";
import type { JobStatus } from "@music/commands/models";
import { commands } from "@music/commands/registry";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  actionSections,
  editField,
  formArgs,
  actionTitle,
  formDefaults,
  jobLine,
  missingMessage,
  parseResultRoute,
  outcomeSecret,
  resultParams,
  toggleOption,
} from "./actions";

const owner = offeredCommands({ role: "owner", playing: false });

const member = offeredCommands({ role: "member", playing: false });

const headings = (query: string, offered = owner) =>
  actionSections(offered, query).map((group) => group.section);

const names = (query: string, offered = owner) =>
  actionSections(offered, query).flatMap((group) => group.actions.map((action) => action.name));

const library = (
  id: string,
  fields: { readonly manageable: boolean; readonly path: string | null },
) =>
  Schema.decodeSync(Library)({
    id,
    name: id,
    path: fields.path,
    manageable: fields.manageable,
    accessControl: "full",
    visibility: "shared",
    ownerId: "u1",
    ownerName: "Lee",
    readable: true,
    trackCount: 0,
    lastScanAt: null,
    scanning: false,
  });

const job = (status: JobStatus, fields: Partial<Record<"done" | "total", number | null>> = {}) =>
  Schema.decodeSync(Job)({
    id: "j1",
    kind: "scan",
    status,
    libraryId: "l1",
    label: "Scan /music",
    done: fields.done ?? 0,
    total: fields.total ?? null,
    message: status === "done" ? "28 files, 0 updated, 0 missing" : null,
    error: status === "failed" ? "The folder is gone." : null,
    createdAt: 0,
    startedAt: null,
    finishedAt: null,
  });

describe("actionSections", () => {
  it("shows every offered command under its heading, in display order", () => {
    expect(headings("")).toEqual(["Listening", "Playlists", "Account", "Administration"]);
    expect(names("").toSorted()).toEqual(owner.map((action) => action.name).toSorted());
  });

  it("never shows Administration to members", () => {
    expect(headings("", member)).toEqual(["Listening", "Playlists", "Account"]);
    expect(names("scan", member)).toEqual([]);
  });

  it("matches the summary, the command name, and the heading, ignoring case and accents", () => {
    expect(names("rescan")).toEqual(["libraries.scan"]);
    expect(names("libraries.scan")).toEqual(["libraries.scan"]);
    expect(names("LIBRARY FOLDER ÀDD")).toEqual(["libraries.create"]);
    expect(names("administration").length).toBeGreaterThan(0);
    expect(
      names("administration").every((name) =>
        ["libraries", "jobs", "people", "server"].includes(commands[name].group),
      ),
    ).toBe(true);
  });

  it("returns nothing when no command matches", () => {
    expect(actionSections(owner, "zzzz")).toEqual([]);
  });
});

describe("missingMessage", () => {
  it("names the required fields that are still empty", () => {
    const fields = fieldsOf("libraries.create") ?? [];

    expect(missingMessage(fields.slice(0, 1))).toBe("Name is required.");
    expect(missingMessage(fields.slice(0, 2))).toBe("Name and Folder path are required.");
    expect(missingMessage(fields)).toBe("Name, Folder path, and Visibility are required.");
  });
});

describe("formDefaults", () => {
  it("starts required switches off and leaves optional ones unset", () => {
    expect(formDefaults("likes.set", fieldsOf("likes.set") ?? [], undefined)).toEqual({
      liked: false,
    });
    expect(formDefaults("queue.add", fieldsOf("queue.add") ?? [], undefined)).toEqual({});
  });

  it("picks the only library a rescan can use", () => {
    const fields = fieldsOf("libraries.scan") ?? [];
    const music = library("l1", { manageable: true, path: "/music" });
    const unreadable = library("l2", { manageable: false, path: null });

    expect(formDefaults("libraries.scan", fields, [music, unreadable])).toEqual({
      libraryId: "l1",
    });
    expect(
      formDefaults("libraries.scan", fields, [
        music,
        library("l3", { manageable: true, path: "/vinyl" }),
      ]),
    ).toEqual({});
    expect(formDefaults("libraries.delete", fieldsOf("libraries.delete") ?? [], [music])).toEqual(
      {},
    );
  });
});

describe("toggleOption", () => {
  const [single] = fieldsOf("libraries.scan") ?? [];
  const [optional] = fieldsOf("playlists.unshare")?.slice(1) ?? [];
  const [many] = fieldsOf("queue.add") ?? [];

  it("picks one option, keeps a required one, and clears an optional one", () => {
    if (single === undefined || optional === undefined) throw new Error("fields changed");

    expect(toggleOption(single, undefined, "l1")).toBe("l1");
    expect(toggleOption(single, "l1", "l2")).toBe("l2");
    expect(toggleOption(single, "l1", "l1")).toBe("l1");
    expect(toggleOption(optional, "u1", "u1")).toBeUndefined();
  });

  it("adds and drops options of a list", () => {
    if (many === undefined) throw new Error("fields changed");

    expect(toggleOption(many, undefined, "t1")).toEqual(["t1"]);
    expect(toggleOption(many, ["t1"], "t2")).toEqual(["t1", "t2"]);
    expect(toggleOption(many, ["t1", "t2"], "t1")).toEqual(["t2"]);
  });
});

describe("jobLine", () => {
  it("says where a scan is", () => {
    expect(jobLine(job("pending"))).toBe("Scan queued · Waiting for scanner");
    expect(jobLine(job("running", { done: 804, total: 1248 }))).toBe(
      "Running · 804 of 1,248 files",
    );
    expect(jobLine(job("running", { done: 12 }))).toBe("Running · 12 files");
    expect(jobLine(job("done"))).toBe("Done · 28 files, 0 updated, 0 missing");
    expect(jobLine(job("failed"))).toBe("Failed · The folder is gone.");
    expect(jobLine(job("cancelled"))).toBe("Cancelled");
  });
});

const newKey = (result: (typeof commands)["keys.create"]["result"]["Encoded"]) =>
  parseResultRoute(
    resultParams(outcomeOf(Schema.decodeSync(commands["keys.create"].result)(result))),
  );

describe("result route", () => {
  it("never puts a new API key in the route", () => {
    const params = newKey({
      key: "mk_secret",
      apiKey: { id: "k1", name: "Laptop", prefix: "mk_", createdAt: 0, lastUsedAt: null },
    });

    expect(params).toEqual({ kind: "key" });
    expect(JSON.stringify(params)).not.toContain("mk_secret");
  });

  it("reads back every other outcome from its parameters", () => {
    const scan = outcomeOf(Schema.decodeSync(commands["libraries.scan"].result)({ jobId: "j1" }));

    const playlist = outcomeOf(
      Schema.decodeSync(commands["playlists.create"].result)({ playlistId: "p1" }),
    );

    expect(parseResultRoute(resultParams(scan))).toEqual({ kind: "job", jobId: "j1" });
    expect(parseResultRoute(resultParams(playlist))).toEqual({
      kind: "playlist",
      playlistId: "p1",
    });
  });

  it("keeps invite codes and reset tokens out of the route, for the secret slot", () => {
    const invite = outcomeOf(
      Schema.decodeSync(commands["invites.create"].result)({
        id: "i1",
        code: "invite-secret",
        email: null,
        role: "member",
        status: "open",
        createdAt: 0,
        expiresAt: 1,
        acceptedAt: null,
      }),
    );

    const reset = outcomeOf(
      Schema.decodeSync(commands["people.reset"].result)({
        userId: "u1",
        token: "reset-secret",
        expiresAt: 1,
      }),
    );

    expect(parseResultRoute(resultParams(invite))).toEqual({ kind: "invite" });
    expect(parseResultRoute(resultParams(reset))).toEqual({ kind: "reset" });
    expect(outcomeSecret(invite)).toBe("invite-secret");
    expect(outcomeSecret(reset)).toBe("reset-secret");
  });

  it("refuses parameters that describe no outcome", () => {
    expect(parseResultRoute({ kind: "job" })).toBeNull();
    expect(parseResultRoute({ kind: "playlist", playlistId: "" })).toBeNull();
    expect(parseResultRoute({ kind: "launch" })).toBeNull();
  });
});

describe("actionTitle", () => {
  it("keeps a summary's first clause, before the CLI details", () => {
    expect(actionTitle(commands["queue.add"].summary)).toBe("Add songs to the queue");
    expect(actionTitle(commands["jam.join"].summary)).toBe("Join a Jam by its code or link");
    expect(actionTitle(commands["libraries.delete"].summary)).toBe(
      "Remove a library folder from the index",
    );
    expect(actionTitle(commands["libraries.scan"].summary)).toBe("Rescan a library folder");
  });

  it("titles every offered command with words", () => {
    for (const { name } of offeredCommands({ role: "owner", playing: true })) {
      expect(actionTitle(commands[name].summary).length).toBeGreaterThan(3);
    }
  });
});

describe("editField", () => {
  it("clears entries picked from another playlist when the playlist changes", () => {
    const fields = fieldsOf("playlists.remove") ?? [];
    const picked = editField(fields, { playlistId: "p1", itemId: "e1" }, "playlistId", "p2");

    expect(picked["playlistId"]).toBe("p2");
    expect(picked["itemId"]).toBeUndefined();
    expect(editField(fields, { playlistId: "p1", itemId: "e1" }, "itemId", "e2")).toEqual({
      playlistId: "p1",
      itemId: "e2",
    });
  });
});

describe("formArgs", () => {
  it("reads a decimal comma in number fields", () => {
    const fields = fieldsOf("playback.volume") ?? [];

    expect(formArgs(fields, { volume: "0,5" })).toEqual({ volume: 0.5 });
  });
});
