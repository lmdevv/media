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
      "core.connect.player.report": "auth player report",
      "core.connect.player.requested": "auth player requested",
      "core.connect.targets.control": "auth targets control",
      "core.connect.targets.list": "auth targets list",
      "core.devices.approvals.approve": "auth approvals approve",
      "core.devices.approvals.deny": "auth approvals deny",
      "core.devices.approvals.pending": "auth approvals pending",
      "core.devices.approvals.request": "auth approvals request",
      "core.devices.picker.show": "auth picker show",
      "core.devices.registry.enroll": "auth registry enroll",
      "core.devices.registry.list": "admin registry list",
      "core.devices.registry.remove": "admin registry remove",
      "core.devices.registry.setMode": "admin registry set-mode",
      "core.devices.tiles.setListed": "auth tiles set-listed",
      "core.devices.tiles.setLock": "admin tiles set-lock",
      "core.devices.unlockCodes.reset": "admin unlock-codes reset",
      "core.devices.unlockCodes.set": "auth unlock-codes set",
      "core.downloads.add": "auth downloads add",
      "core.downloads.fetch": "auth downloads fetch",
      "core.downloads.list": "auth downloads list",
      "core.downloads.remove": "auth downloads remove",
      "core.downloads.setCap": "admin downloads set-cap",
      "core.downloads.usage": "auth downloads usage",
      "core.libraries.create": "admin libraries create",
      "core.libraries.get": "auth libraries get",
      "core.libraries.list": "auth libraries list",
      "core.libraries.remove": "auth libraries remove",
      "core.libraries.rename": "auth libraries rename",
      "core.libraries.scan": "auth libraries scan",
      "core.libraries.setFolders": "admin libraries set-folders",
      "core.permissions.grants.list": "auth grants list",
      "core.permissions.grants.remove": "auth grants remove",
      "core.permissions.grants.set": "auth grants set",
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
      "core.settings.get": "auth settings get",
      "core.settings.set": "auth settings set",
      "core.together.add": "auth together add",
      "core.together.admit": "auth together admit",
      "core.together.block": "auth together block",
      "core.together.configure": "auth together configure",
      "core.together.control": "auth together control",
      "core.together.create": "auth together create",
      "core.together.get": "auth together get",
      "core.together.heartbeat": "auth together heartbeat",
      "core.together.join": "auth together join",
      "core.together.leave": "auth together leave",
      "core.together.queue": "auth together queue",
      "core.together.remove": "auth together remove",
    });
  });

  it("puts a content domain's commands under its own group", () => {
    expect(cliPath({ name: "movies.titles.list", domain: "movies", scope: "movies:read" })).toEqual(
      ["movies", "titles", "list"],
    );
  });

  it("refuses two commands on one CLI path", () => {
    expect(
      refusalsOf([
        declared("core.accounts.users.remove", "admin"),
        declared("core.people.users.remove", "admin"),
      ]),
    ).toEqual([
      "core.accounts.users.remove: refused, its CLI path `media admin users remove` is also core.people.users.remove's (rename a module or function)",
      "core.people.users.remove: refused, its CLI path `media admin users remove` is also core.accounts.users.remove's (rename a module or function)",
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
      "core.devices.registry.list",
      "core.downloads.list",
      "core.libraries.list",
      "core.permissions.grants.list",
      "core.permissions.groups.list",
      "core.permissions.groups.members",
      "core.together.queue",
    ]);
  });
});
