import type { Command } from "./command.ts";
import { core } from "./core.ts";

/** Every command in every domain. */
export const commands = [...core] satisfies ReadonlyArray<Command>;
