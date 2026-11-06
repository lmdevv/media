import { useState } from "react";

import { describeFailure } from "@/lib/failure";

/** Where one command a form sends stands: not sent, running, done, or failed with a line to show. */
export type ActionStatus =
  | { readonly kind: "idle" }
  | { readonly kind: "pending" }
  | { readonly kind: "done" }
  | { readonly kind: "failed"; readonly message: string };

const IDLE: ActionStatus = { kind: "idle" };

/** A command a form sends, with how it stands. */
export interface Action<Input> {
  readonly status: ActionStatus;
  readonly run: (input: Input) => Promise<void>;
  /** Back to idle, such as when the form changes what it would send. */
  readonly reset: () => void;
}

/** The status of `action`, and a `run` that sends it and records how it went. */
export const useAction = <Input>(action: (input: Input) => Promise<void>): Action<Input> => {
  const [status, setStatus] = useState<ActionStatus>(IDLE);

  const run = async (input: Input): Promise<void> => {
    setStatus({ kind: "pending" });

    try {
      await action(input);
      setStatus({ kind: "done" });
    } catch (cause) {
      setStatus({ kind: "failed", message: describeFailure(cause) });
    }
  };

  return { status, run, reset: () => setStatus(IDLE) };
};
