/**
 * The command dispatcher. Every client (web, command menu, CLI, agents) calls `read` for query
 * commands and `run` for mutation commands; arguments and results are checked against the shared
 * registry in `@music/commands`.
 */
import { argsDecoder, resultDecoder } from "@music/commands/codec";
import { can, forbiddenMessage } from "@music/commands/permissions";
import { commands, isCommandName } from "@music/commands/registry";
import type {
  CommandArgs,
  CommandName,
  CommandResultEncoded,
  MutationName,
  QueryName,
} from "@music/commands/registry";
import { v } from "convex/values";
import { Result } from "effect";

import type { MutationCtx, QueryCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server";
import { adminMutations, adminQueries } from "./handlers/admin";
import { collectionMutations, collectionQueries } from "./handlers/collection";
import { downloadMutations, downloadQueries } from "./handlers/downloads";
import { jamMutations, jamQueries } from "./handlers/jams";
import { libraryQueries } from "./handlers/library";
import { lyricsQueries } from "./handlers/lyrics";
import { peopleMutations, peopleQueries } from "./handlers/people";
import { playbackMutations, playbackQueries } from "./handlers/playback";
import type { MutationHandlers, QueryHandlers } from "./handlers/types";
import { fail } from "./lib/errors";
import { noteHostActivity } from "./lib/jams";
import { loadViewer } from "./lib/viewer";
import type { Viewer } from "./lib/viewer";

const queryHandlers: QueryHandlers = {
  ...libraryQueries,
  ...playbackQueries,
  ...collectionQueries,
  ...adminQueries,
  ...peopleQueries,
  ...jamQueries,
  ...downloadQueries,
  ...lyricsQueries,
};

const mutationHandlers: MutationHandlers = {
  ...playbackMutations,
  ...collectionMutations,
  ...adminMutations,
  ...peopleMutations,
  ...jamMutations,
  ...downloadMutations,
};

const isQueryName = (name: CommandName): name is QueryName => commands[name].kind === "query";

const isMutationName = (name: CommandName): name is MutationName =>
  commands[name].kind === "mutation";

const authorize = async (ctx: QueryCtx, name: CommandName): Promise<Viewer> => {
  const viewer = await loadViewer(ctx);
  const { access } = commands[name];

  if (!can(viewer.role, access)) return fail("forbidden", forbiddenMessage(access));

  return viewer;
};

const checked = <Name extends CommandName>(
  name: Name,
  result: CommandResultEncoded<Name>,
): CommandResultEncoded<Name> => {
  const decoded = resultDecoder(name)(result);

  if (Result.isFailure(decoded)) {
    return fail("internal", `${name} produced an invalid result: ${decoded.failure.message}`);
  }

  return result;
};

const executeQuery = async <Name extends QueryName>(
  ctx: QueryCtx,
  name: Name,
  args: CommandArgs<Name>,
): Promise<CommandResultEncoded<Name>> => {
  const viewer = await authorize(ctx, name);
  const handler: QueryHandlers[Name] = queryHandlers[name];

  return checked(name, await handler(ctx, viewer, args));
};

const executeMutation = async <Name extends MutationName>(
  ctx: MutationCtx,
  name: Name,
  args: CommandArgs<Name>,
): Promise<CommandResultEncoded<Name>> => {
  const viewer = await authorize(ctx, name);
  const handler: MutationHandlers[Name] = mutationHandlers[name];

  await noteHostActivity(ctx, viewer.id);

  return checked(name, await handler(ctx, viewer, args));
};

/** Runs a query command. Subscribable from the web app. */
export const read = query({
  args: { name: v.string(), args: v.any() },
  handler: async (ctx, { name, args }) => {
    if (!isCommandName(name) || !isQueryName(name)) {
      return fail("invalid_args", `Unknown query command ${name}`);
    }

    const decoded = argsDecoder(name)(args);

    if (Result.isFailure(decoded)) return fail("invalid_args", decoded.failure.message);

    return executeQuery(ctx, name, decoded.success);
  },
});

/** Runs a mutation command. */
export const run = mutation({
  args: { name: v.string(), args: v.any() },
  handler: async (ctx, { name, args }) => {
    if (!isCommandName(name) || !isMutationName(name)) {
      return fail("invalid_args", `Unknown mutation command ${name}`);
    }

    const decoded = argsDecoder(name)(args);

    if (Result.isFailure(decoded)) return fail("invalid_args", decoded.failure.message);

    return executeMutation(ctx, name, decoded.success);
  },
});
