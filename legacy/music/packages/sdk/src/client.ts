import { encodeArgs, resultDecoder } from "@music/commands/codec";
import type {
  CommandArgs,
  CommandName,
  CommandResult,
  MutationName,
  QueryName,
} from "@music/commands/registry";
import type { FunctionArgs, FunctionReturnType } from "convex/server";
import { Result } from "effect";

import { readCommand, runCommand } from "./functions";

type ReadFunction = typeof readCommand;

type RunFunction = typeof runCommand;

/** The two calls a Convex client offers. `ConvexHttpClient` and `ConvexReactClient` both fit. */
export interface CommandTransport {
  query(
    reference: ReadFunction,
    args: FunctionArgs<ReadFunction>,
  ): Promise<FunctionReturnType<ReadFunction>>;
  mutation(
    reference: RunFunction,
    args: FunctionArgs<RunFunction>,
  ): Promise<FunctionReturnType<RunFunction>>;
}

/** The server returned a result that does not match the registry. This is a defect. */
export class InvalidResultError extends Error {
  override readonly name = "InvalidResultError";
}

/** Decodes a wire result for `name`, throwing `InvalidResultError` on a contract mismatch. */
export const decodeCommandResult = <Name extends CommandName>(
  name: Name,
  wire: FunctionReturnType<ReadFunction> | FunctionReturnType<RunFunction>,
): CommandResult<Name> => {
  const decoded = resultDecoder(name)(wire);

  if (Result.isFailure(decoded)) {
    throw new InvalidResultError(
      `${name} returned an unexpected result: ${decoded.failure.message}`,
    );
  }

  return decoded.success;
};

/** A typed client for every registry command over any Convex transport. */
export interface MusicClient {
  readonly read: <Name extends QueryName>(
    name: Name,
    args: CommandArgs<Name>,
  ) => Promise<CommandResult<Name>>;
  readonly run: <Name extends MutationName>(
    name: Name,
    args: CommandArgs<Name>,
  ) => Promise<CommandResult<Name>>;
}

/** Wraps a Convex client so callers use command names and decoded types. */
export const makeMusicClient = (transport: CommandTransport): MusicClient => ({
  read: async (name, args) =>
    decodeCommandResult(
      name,
      await transport.query(readCommand, { name, args: encodeArgs(name, args) }),
    ),
  run: async (name, args) =>
    decodeCommandResult(
      name,
      await transport.mutation(runCommand, { name, args: encodeArgs(name, args) }),
    ),
});
