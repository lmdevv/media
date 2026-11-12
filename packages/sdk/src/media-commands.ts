import type { ArgsSchema, MediaCommand, WireSchema } from "@media/contracts/command";
import { mediaCommands } from "@media/contracts/media-commands";
import type {
  MediaCommandArgs,
  MediaCommandName,
  MediaCommandResult,
} from "@media/contracts/media-commands";
import { Effect, Option } from "effect";

import { encodeArgs } from "./calls";
import { baseUrl, requestJson } from "./media-http";
import { withBearer } from "./media-server";
import type { MediaServerOptions } from "./media-server";

const callMedia = <Command extends MediaCommand<ArgsSchema, WireSchema>>(
  options: MediaServerOptions,
  name: string,
  command: Command,
  args: Command["args"]["Type"],
): Promise<Command["result"]["Type"]> =>
  withBearer(options, (bearer) =>
    Effect.gen(function* () {
      const wire = yield* encodeArgs(name, command.args, args);

      return yield* requestJson(
        {
          operation: name,
          url: `${baseUrl(options.url)}${command.route.path}`,
          method: command.route.method,
          body: Option.some(wire),
          bearer,
        },
        command.result,
      );
    }),
  );

/** Runs the media command `name` with `args`, as `MediaServer.run` does. */
export const runMediaCommand = <Name extends MediaCommandName>(
  options: MediaServerOptions,
  name: Name,
  args: MediaCommandArgs<Name>,
): Promise<MediaCommandResult<Name>> => callMedia(options, name, mediaCommands[name], args);
