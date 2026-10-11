import { Context, Effect } from "effect";

/** Where the CLI writes. Results go to stdout; errors, progress, and hints go to stderr. */
export interface Interface {
  readonly out: (text: string) => Effect.Effect<void>;
  readonly err: (text: string) => Effect.Effect<void>;
}

export class Output extends Context.Service<Output, Interface>()("@music/cli/Output") {}

/** Writes to the process streams, one line per call. */
export const processOutput: Interface = Output.of({
  out: (text) =>
    Effect.sync(() => {
      process.stdout.write(`${text}\n`);
    }),
  err: (text) =>
    Effect.sync(() => {
      process.stderr.write(`${text}\n`);
    }),
});
