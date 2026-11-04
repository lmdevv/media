import { v } from "convex/values";

import { action, mutation, query } from "../src/command.ts";
import type { Command } from "../src/command.ts";

export const fixtures = [
  query("core.server.info", {
    summary: "Show this server's name and version",
    scope: "public",
    args: {},
    result: v.object({ name: v.string(), version: v.string() }),
  }),
  mutation("core.server.rename", {
    summary: "Rename this server",
    scope: "account",
    refusesKeys: true,
    args: { name: v.string(), note: v.optional(v.string()) },
    result: v.null(),
  }),
  action("music.playlists.load", {
    summary: "Load a playlist from a file or another service",
    scope: "music:edit",
    args: {
      source: v.union(v.literal("spotify"), v.literal("file")),
      tracks: v.array(v.object({ title: v.string(), seconds: v.number() })),
      tags: v.record(v.string(), v.boolean()),
      owner: v.id("users"),
      size: v.int64(),
      cover: v.optional(v.bytes()),
      "dry-run": v.literal(true),
      version: v.literal(2n),
    },
    result: v.union(v.object({ playlistId: v.id("playlists") }), v.null()),
  }),
] as const satisfies ReadonlyArray<Command>;
