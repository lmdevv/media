import type { Command } from "./command.ts";
import { core } from "./core.ts";
import { movies } from "./movies.ts";

/** Every command in every domain. */
export const commands = [...core, ...movies] satisfies ReadonlyArray<Command>;
