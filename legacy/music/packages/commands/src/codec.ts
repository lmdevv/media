import { Schema } from "effect";

import type { CommandArgs, CommandArgsEncoded, CommandName, Commands } from "./registry";
import { commands } from "./registry";

type ArgsDecoder<Name extends CommandName> = ReturnType<
  typeof Schema.decodeUnknownResult<Commands[Name]["args"]>
>;

type ResultDecoder<Name extends CommandName> = ReturnType<
  typeof Schema.decodeUnknownResult<Commands[Name]["result"]>
>;

/** The decoder for a command's wire arguments. Run it where the arguments arrive. */
export const argsDecoder = <Name extends CommandName>(name: Name): ArgsDecoder<Name> =>
  Schema.decodeUnknownResult(commands[name].args);

/** The decoder for a command's wire result. Run it where the result arrives. */
export const resultDecoder = <Name extends CommandName>(name: Name): ResultDecoder<Name> =>
  Schema.decodeUnknownResult(commands[name].result);

/** Encodes decoded arguments for the wire. Throws only if the value breaks its own type. */
export const encodeArgs = <Name extends CommandName>(
  name: Name,
  args: CommandArgs<Name>,
): CommandArgsEncoded<Name> => Schema.encodeSync(commands[name].args)(args);
