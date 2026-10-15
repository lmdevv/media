import type { Role } from "@music/commands/models";
import { commands } from "@music/commands/registry";
import { describe, expect, it } from "vitest";

import { offeredCommands, offeredScreens } from "./catalog";
import { fieldsOf } from "./fields";

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

describe("offeredScreens", () => {
  it("hides screens whose query is for admins from everyone else", () => {
    const member = offeredScreens("member").map((screen) => screen.name);
    const admin = offeredScreens("admin").map((screen) => screen.name);
    const owner = offeredScreens("owner").map((screen) => screen.name);
    const guest = offeredScreens("guest").map((screen) => screen.name);

    expect(owner).toEqual(admin);
    expect(guest).not.toContain("keys.list");
    expect(member).toContain("keys.list");

    expect(admin).toContain("people.list");
    expect(member).not.toContain("people.list");
    expect(member).toContain("library.home");
    expect(admin.slice(0, 2)).toEqual(["library.home", "search"]);
  });
});
