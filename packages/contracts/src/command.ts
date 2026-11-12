import type { Schema } from "effect";

import type { CommandAccess } from "./scopes";

/** Where a media command appears in CLI help. */
export type CommandGroup = "libraries" | "metadata" | "backups" | "migration" | "diagnostics";

/** A Convex function path such as `titles:list`: the module under `convex/`, a colon, and the export. */
export type FunctionPath = `${string}:${string}`;

/** A schema for wire values: no services needed to decode or encode it. */
export type WireSchema = Schema.Codec<unknown>;

/** Arguments are always an object, matching Convex's object argument validators. */
export type ArgsSchema = WireSchema & { readonly fields: Schema.Struct.Fields };

/**
 * A command implemented by the media service over HTTP. The SDK sends the caller's core session
 * token as a bearer token; the media service checks the scope with the core.
 */
export interface MediaCommand<Args extends ArgsSchema, Result extends WireSchema> {
  /** One line for CLI help. */
  readonly summary: string;
  readonly group: CommandGroup;
  /** Who may call it; the server enforces this on every call. */
  readonly scope: CommandAccess;
  readonly args: Args;
  readonly result: Result;
  readonly route: { readonly method: "GET" | "POST"; readonly path: `/api/${string}` };
}

/** Any media command. */
export type AnyCommand = MediaCommand<ArgsSchema, WireSchema>;
