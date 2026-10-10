import { encodeArgs } from "@music/commands/codec";
import type { CommandArgs, CommandResult, MutationName, QueryName } from "@music/commands/registry";
import { useConvex, useQuery } from "convex/react";
import { useCallback, useMemo } from "react";

import { decodeCommandResult } from "./client";
import { readCommand, runCommand } from "./functions";

/**
 * Subscribes to a query command. Returns `undefined` while loading. Pass `"skip"` to pause.
 * Throws on server errors, so wrap screens in an error boundary.
 */
export const useRead = <Name extends QueryName>(
  name: Name,
  args: CommandArgs<Name> | "skip",
): CommandResult<Name> | undefined => {
  const wireArgs = args === "skip" ? "skip" : { name, args: encodeArgs(name, args) };
  const key = wireArgs === "skip" ? "skip" : JSON.stringify(wireArgs.args);
  // Re-create the args object only when its JSON changes, so the subscription stays stable.
  const stableArgs = useMemo(() => wireArgs, [name, key]);
  const wire = useQuery(readCommand, stableArgs);

  return useMemo(
    () => (wire === undefined ? undefined : decodeCommandResult(name, wire)),
    [name, wire],
  );
};

/** Returns a function that runs a mutation command and resolves with its decoded result. */
export const useRun = <Name extends MutationName>(
  name: Name,
): ((args: CommandArgs<Name>) => Promise<CommandResult<Name>>) => {
  const convex = useConvex();

  return useCallback(
    async (args) =>
      decodeCommandResult(
        name,
        await convex.mutation(runCommand, { name, args: encodeArgs(name, args) }),
      ),
    [convex, name],
  );
};

/** Returns a function that reads a query command once, without subscribing. */
export const useReadOnce = <Name extends QueryName>(
  name: Name,
): ((args: CommandArgs<Name>) => Promise<CommandResult<Name>>) => {
  const convex = useConvex();

  return useCallback(
    async (args) =>
      decodeCommandResult(
        name,
        await convex.query(readCommand, { name, args: encodeArgs(name, args) }),
      ),
    [convex, name],
  );
};
