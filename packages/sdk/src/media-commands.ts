import type { ArgsSchema, MediaCommand, WireSchema } from "@media/contracts/command";
import { commands } from "@media/contracts/commands";
import type { CommandArgs, CommandResult } from "@media/contracts/commands";
import { Effect, Option } from "effect";

import { encodeArgs } from "./calls";
import { baseUrl, requestJson } from "./media-http";
import { bearerOf } from "./media-server";
import type { MediaServerOptions } from "./media-server";
import type { MediaName } from "./movies-client";

const callMedia = <Command extends MediaCommand<ArgsSchema, WireSchema>>(
  options: MediaServerOptions,
  name: string,
  command: Command,
  args: Command["args"]["Type"],
): Promise<Command["result"]["Type"]> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const wire = yield* encodeArgs(name, command.args, args);

      return yield* requestJson(
        {
          operation: name,
          url: `${baseUrl(options.url)}${command.route.path}`,
          method: command.route.method,
          body: Option.some(wire),
          bearer: yield* bearerOf(options),
        },
        command.result,
      );
    }),
  );

/** Runs the media command `name` with `args`, as `MediaServer.run` does. */
export const runMediaCommand = <Name extends MediaName>(
  options: MediaServerOptions,
  name: Name,
  args: CommandArgs<Name>,
): Promise<CommandResult<Name>> => callMedia(options, name, commands[name], args);
