import { v } from "convex/values";
import { describe, expect, it } from "vitest";

import { check, refusalMessage } from "../src/check.ts";
import type { Declaration } from "../src/check.ts";
import { cliPath, isPaginated, secretsOf } from "../src/cli.ts";
import { commands } from "../src/index.ts";

const checked = check(commands);

const placed = checked.ok ? checked.commands : [];

const declared = (name: string, scope: string): Declaration => ({
  name,
  kind: "mutation",
  scope,
  summary: "Do something",
  args: {},
  result: v.null(),
});

const refusalsOf = (declarations: ReadonlyArray<Declaration>): ReadonlyArray<string> => {
  const result = check(declarations);

  return result.ok ? [] : result.refusals.map(refusalMessage);
};

describe("CLI placement", () => {
  it("puts admin-scoped core commands under admin and the rest under auth", () => {
    expect(
      Object.fromEntries(placed.map((command) => [command.name, cliPath(command).join(" ")])),
    ).toEqual({
      "core.accounts.invites.create": "admin invites create",
      "core.accounts.invites.list": "admin invites list",
      "core.accounts.invites.lookup": "auth invites lookup",
      "core.accounts.invites.revoke": "admin invites revoke",
      "core.accounts.me.changePassword": "auth me change-password",
      "core.accounts.me.rename": "auth me rename",
      "core.accounts.resetLinks.create": "admin reset-links create",
      "core.accounts.resetLinks.lookup": "auth reset-links lookup",
      "core.accounts.users.create": "admin users create",
      "core.accounts.users.handOverOwnership": "admin users hand-over-ownership",
      "core.accounts.users.list": "admin users list",
      "core.accounts.users.setRole": "admin users set-role",
      "core.auth.apiKeys.create": "auth api-keys create",
      "core.auth.apiKeys.endAll": "auth api-keys end-all",
      "core.auth.apiKeys.revoke": "auth api-keys revoke",
      "core.auth.deviceCodes.approve": "auth device-codes approve",
      "core.auth.deviceCodes.deny": "auth device-codes deny",
      "core.auth.deviceCodes.lookup": "auth device-codes lookup",
      "core.auth.deviceCodes.start": "auth device-codes start",
      "core.auth.sessions.current": "auth sessions current",
      "core.auth.sessions.end": "auth sessions end",
      "core.auth.sessions.endAll": "auth sessions end-all",
      "core.permissions.groups.addMember": "admin groups add-member",
      "core.permissions.groups.create": "admin groups create",
      "core.permissions.groups.list": "admin groups list",
      "core.permissions.groups.members": "admin groups members",
      "core.permissions.groups.remove": "admin groups remove",
      "core.permissions.groups.removeMember": "admin groups remove-member",
      "core.permissions.groups.rename": "admin groups rename",
      "core.restrictions.get": "auth restrictions get",
      "core.restrictions.set": "admin restrictions set",
      "core.server.info": "auth server info",
    });
  });

  it("keeps a product domain's word, and puts its admin commands under admin", () => {
    expect(cliPath({ name: "movies.titles.list", domain: "movies", scope: "signed-in" })).toEqual([
      "movies",
      "titles",
      "list",
    ]);
    expect(cliPath({ name: "music.scans.start", domain: "music", scope: "admin" })).toEqual([
      "admin",
      "music",
      "scans",
      "start",
    ]);
  });

  it("refuses two commands on one CLI path", () => {
    expect(
      refusalsOf([
        declared("core.accounts.users.remove", "admin"),
        declared("core.people.users.remove", "admin"),
      ]),
    ).toEqual([
      "core.accounts.users.remove: refused, its CLI path `media admin users remove` is core.people.users.remove's or starts it (rename a module or function)",
      "core.people.users.remove: refused, its CLI path `media admin users remove` is core.accounts.users.remove's or starts it (rename a module or function)",
    ]);
  });

  it("keeps password arguments off the command line and pages lists", () => {
    const named = (name: string) => placed.find((command) => command.name === name)?.args ?? [];

    expect(secretsOf(named("core.accounts.users.create"))).toEqual([
      { field: "password", variable: "MEDIA_ARG_PASSWORD" },
    ]);
    expect(secretsOf(named("core.accounts.me.changePassword"))).toEqual([
      { field: "currentPassword", variable: "MEDIA_ARG_CURRENT_PASSWORD" },
      { field: "newPassword", variable: "MEDIA_ARG_NEW_PASSWORD" },
    ]);
    expect(
      placed.filter((command) => isPaginated(command.args)).map((command) => command.name),
    ).toEqual([
      "core.accounts.invites.list",
      "core.accounts.users.list",
      "core.permissions.groups.list",
      "core.permissions.groups.members",
    ]);
  });
});
