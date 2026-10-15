import { Context, Effect } from "effect";

import { terminalSafe } from "./escape";

/** Where the CLI writes. Results go to stdout; errors, progress, and hints go to stderr. */
export interface Interface {
  readonly out: (text: string) => Effect.Effect<void>;
  readonly err: (text: string) => Effect.Effect<void>;
}

export class Output extends Context.Service<Output, Interface>()("@music/cli/Output") {}

/**
 * An Output writing each call as one line through `write`. Every line passes through
 * `terminalSafe`, so nothing the server sent reaches the terminal as a control sequence, whichever
 * path printed it; the call sites escape server text too, line breaks included.
 */
export const lineOutput = (write: {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}): Interface =>
  Output.of({
    out: (text) =>
      Effect.sync(() => {
        write.out(`${terminalSafe(text)}\n`);
      }),
    err: (text) =>
      Effect.sync(() => {
        write.err(`${terminalSafe(text)}\n`);
      }),
  });

/** Writes to the process streams. */
export const processOutput: Interface = lineOutput({
  out: (line) => {
    process.stdout.write(line);
  },
  err: (line) => {
    process.stderr.write(line);
  },
});
