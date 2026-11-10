import { accountCommands, credentialCommands, userCommands } from "./account";
import { libraryCommands, maintenanceCommands, metadataCommands } from "./admin";
import type { AnyCommand } from "./command";
import { diagnosticsCommands } from "./diagnostics";
import { importCommands } from "./imports";
import { roomCommands } from "./rooms";
import { browseCommands, historyCommands, playbackCommands, profileCommands } from "./viewing";

/** Every command by name. */
export const commands = {
  ...accountCommands,
  ...userCommands,
  ...credentialCommands,
  ...profileCommands,
  ...browseCommands,
  ...historyCommands,
  ...playbackCommands,
  ...roomCommands,
  ...libraryCommands,
  ...metadataCommands,
  ...maintenanceCommands,
  ...importCommands,
  ...diagnosticsCommands,
} satisfies Record<string, AnyCommand>;

/** The registry's type. */
export type Commands = typeof commands;

/** A command name such as `titles.list`. */
export type CommandName = keyof Commands;

/** Names of commands of one kind. */
export type CommandNameOfKind<Kind extends AnyCommand["kind"]> = {
  readonly [Name in CommandName]: Commands[Name]["kind"] extends Kind ? Name : never;
}[CommandName];

/** Decoded arguments of a command. */
export type CommandArgs<Name extends CommandName> = Commands[Name]["args"]["Type"];

/** Decoded result of a command. */
export type CommandResult<Name extends CommandName> = Commands[Name]["result"]["Type"];

const names: ReadonlySet<string> = new Set(Object.keys(commands));

/** Whether `name` is a registered command, for parsing names typed into the CLI or menu. */
export const isCommandName = (name: string): name is CommandName => names.has(name);
