import { useState } from "react";
import { toast } from "sonner";

import { describeFailure } from "@/lib/failure";

/** A command a screen runs from a button: which one is running, and how to start one. */
export interface Actions<Name extends string> {
  /** The action running now, so its button and its neighbors wait. */
  readonly running: Name | null;
  /**
   * Runs `call` as `name`. Shows `success` as a toast after it succeeds and the failure as a toast
   * after it fails; resolves with the result, or `undefined` after a failure.
   */
  readonly run: <A>(name: Name, call: () => Promise<A>, success?: string) => Promise<A | undefined>;
}

/** One screen part's commands, one at a time. */
export const useActions = <Name extends string>(): Actions<Name> => {
  const [running, setRunning] = useState<Name | null>(null);

  const run = async <A>(
    name: Name,
    call: () => Promise<A>,
    success?: string,
  ): Promise<A | undefined> => {
    setRunning(name);

    try {
      const result = await call();

      if (success !== undefined) toast.success(success);

      return result;
    } catch (cause) {
      toast.error(describeFailure(cause));

      return undefined;
    } finally {
      setRunning(null);
    }
  };

  return { running, run };
};
