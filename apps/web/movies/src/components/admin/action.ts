import { useCallback, useState } from "react";
import { toast } from "sonner";

import { describeFailure } from "@media/ui/lib/failure";
import { useLatest } from "@/lib/use-latest";

/** Options for {@link useAction}. */
export interface ActionOptions<Result> {
  /** The toast after success, built from the result. */
  readonly success?: (result: Result) => string;
  /** Show failures inline instead of as a toast; the hook still reports them through `error`. */
  readonly quiet?: boolean;
  /** Runs after a success, such as closing the dialog that started the action. */
  readonly onSuccess?: (result: Result) => void;
}

/** What {@link useAction} returns. */
export interface ActionState<Args extends ReadonlyArray<unknown>, Result> {
  /** Runs the action; resolves with its result, or `undefined` after a failure. */
  readonly run: (...args: Args) => Promise<Result | undefined>;
  readonly pending: boolean;
  /** The last failure's sentence, cleared when the action runs again. */
  readonly error: string | undefined;
  readonly reset: () => void;
}

/**
 * Wraps a command call with the feedback every action needs: `pending` while it runs, then an
 * optional success toast, and the failure as a toast (or inline with `quiet`).
 */
export const useAction = <Args extends ReadonlyArray<unknown>, Result>(
  action: (...args: Args) => Promise<Result>,
  options: ActionOptions<Result> = {},
): ActionState<Args, Result> => {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const latest = useLatest({ action, options });

  const run = useCallback(
    async (...args: Args): Promise<Result | undefined> => {
      setPending(true);
      setError(undefined);

      try {
        const result = await latest.current.action(...args);
        const success = latest.current.options.success;

        if (success !== undefined) toast.success(success(result));

        latest.current.options.onSuccess?.(result);

        return result;
      } catch (cause) {
        const message = describeFailure(cause);

        setError(message);

        if (latest.current.options.quiet !== true) toast.error(message);

        return undefined;
      } finally {
        setPending(false);
      }
    },
    [latest],
  );

  const reset = useCallback(() => setError(undefined), []);

  return { run, pending, error, reset };
};
