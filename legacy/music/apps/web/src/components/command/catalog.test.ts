import { commands } from "@music/commands/registry";
import { describe, expect, it } from "vitest";

import { offeredCommands, offeredScreens } from "./catalog";
import { fieldsOf } from "./fields";

const names = (admin: boolean, playing: boolean) =>
  offeredCommands({ admin, playing }).map((entry) => entry.name);

describe("offeredCommands", () => {
  it("offers only mutations whose arguments have form fields", () => {
    for (const { name, fields } of offeredCommands({ admin: true, playing: true })) {
      expect(commands[name].kind).toBe("mutation");
      expect(fields).toEqual(fieldsOf(name));
    }
  });

  it("never offers the commands only players send", () => {
    const offered = names(true, true);

    expect(offered).not.toContain("devices.heartbeat");
    expect(offered).not.toContain("playback.report");
  });

  it("offers admin commands to admins only", () => {
    expect(names(true, true)).toContain("libraries.scan");
    expect(names(false, true)).not.toContain("libraries.scan");
    expect(names(false, true).every((name) => commands[name].access === "user")).toBe(true);
  });

  it("offers playback and queue controls only while a song is loaded", () => {
    expect(names(false, true)).toEqual(expect.arrayContaining(["playback.pause", "queue.clear"]));
    expect(names(false, false)).not.toContain("playback.pause");
    expect(names(false, false)).not.toContain("queue.clear");
    // Starting playback needs nothing loaded.
    expect(names(false, false)).toContain("playback.play");
  });
});

describe("offeredScreens", () => {
  it("hides screens whose query is for admins from everyone else", () => {
    const member = offeredScreens(false).map((screen) => screen.name);
    const admin = offeredScreens(true).map((screen) => screen.name);

    expect(admin).toContain("people.list");
    expect(member).not.toContain("people.list");
    expect(member).toContain("library.home");
    expect(admin.slice(0, 2)).toEqual(["library.home", "search"]);
  });
});
