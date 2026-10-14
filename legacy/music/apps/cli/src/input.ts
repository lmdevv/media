import { Context, Effect, Redacted } from "effect";

import { InputError } from "./errors";
import { PromptCancelled, promptHidden, readStdin, stdinIsTerminal } from "./terminal";

/** Where the CLI reads secrets it is not given on the command line. */
export interface Interface {
  /** Whether a person is at the terminal, so a prompt can ask them. */
  readonly interactive: Effect.Effect<boolean>;
  /** All of standard input, for `--key-stdin`. */
  readonly readAll: Effect.Effect<Redacted.Redacted, InputError>;
  /** Asks for a secret without echoing what the user types. */
  readonly promptSecret: (question: string) => Effect.Effect<Redacted.Redacted, InputError>;
}

export class Input extends Context.Service<Input, Interface>()("@music/cli/Input") {}

/** Reads the process's standard input and prompts on its terminal. */
export const processInput: Interface = Input.of({
  interactive: Effect.sync(stdinIsTerminal),
  readAll: Effect.tryPromise({
    try: readStdin,
    catch: (cause) => new InputError({ message: "Could not read standard input", cause }),
  }).pipe(Effect.map(Redacted.make)),
  promptSecret: (question) =>
    Effect.tryPromise({
      try: () => promptHidden(question),
      catch: (cause) =>
        new InputError({
          message: cause instanceof PromptCancelled ? "Cancelled" : "Could not read the terminal",
          cause,
        }),
    }).pipe(Effect.map(Redacted.make)),
});
