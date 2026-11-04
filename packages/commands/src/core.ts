import { v } from "convex/values";

import { query } from "./command.ts";
import type { Command } from "./command.ts";

/** The core's commands: the server itself, accounts, devices, and the other shared modules. */
export const core = [
  query("core.server.info", {
    summary: "Show this server's name and version",
    scope: "public",
    args: {},
    result: v.object({ name: v.string(), version: v.string() }),
  }),
] as const satisfies ReadonlyArray<Command>;
