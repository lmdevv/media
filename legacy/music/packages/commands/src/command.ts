import type { Schema } from "effect";

import type { Capability } from "./permissions";

/** Where a command shows up in the command menu and the CLI help. */
export type CommandGroup =
  | "library"
  | "search"
  | "playback"
  | "queue"
  | "playlists"
  | "likes"
  | "devices"
  | "downloads"
  | "jams"
  | "libraries"
  | "jobs"
  | "keys"
  | "people"
  | "server"
  | "account";

/**
 * One user action. Clients encode `args`, the backend decodes them with the same schema, and the
 * result travels back encoded with `result`.
 */
export interface Command<
  Kind extends "query" | "mutation",
  Args extends Schema.Codec<unknown, unknown>,
  Result extends Schema.Codec<unknown, unknown>,
> {
  readonly summary: string;
  readonly group: CommandGroup;
  /** `query` reads and can be subscribed to; `mutation` changes state. */
  readonly kind: Kind;
  /** The capability the caller needs; see `permissions.ts`. */
  readonly access: Capability;
  /** The result carries a `jobId` the caller can wait on. */
  readonly job: boolean;
  readonly args: Args;
  readonly result: Result;
}

/** Defines a command while keeping its exact schema types. */
export const command = <
  const Kind extends "query" | "mutation",
  Args extends Schema.Codec<unknown, unknown>,
  Result extends Schema.Codec<unknown, unknown>,
>(
  definition: Command<Kind, Args, Result>,
): Command<Kind, Args, Result> => definition;
