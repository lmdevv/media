import { assert, describe, it } from "vitest";

import type { AnyCommand, CommandGroup } from "./command";
import { mediaCommands } from "./media-commands";

const entries: ReadonlyArray<readonly [string, AnyCommand]> = Object.entries(mediaCommands);

const ADMIN_GROUPS: ReadonlySet<CommandGroup> = new Set(["backups", "migration"]);

const MANAGE_GROUPS: ReadonlySet<CommandGroup> = new Set(["libraries", "metadata"]);

describe("media commands", () => {
  it("gives every media command its own route under /api", () => {
    const routes = entries.map(([, command]) => `${command.route.method} ${command.route.path}`);

    assert.isAbove(routes.length, 0);
    assert.strictEqual(new Set(routes).size, routes.length);
  });

  it("keeps administration behind admin and manage scopes", () => {
    for (const [name, command] of entries) {
      if (ADMIN_GROUPS.has(command.group)) assert.strictEqual(command.scope, "admin", name);

      if (MANAGE_GROUPS.has(command.group)) assert.strictEqual(command.scope, "manage", name);
    }
  });

  it("keeps the media-service scope and anonymous calls out of media commands", () => {
    for (const [name, command] of entries) {
      assert.notStrictEqual(command.scope, "media-service", name);
      assert.notStrictEqual(command.scope, "public", name);
    }
  });
});
