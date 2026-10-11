import { errorMessage } from "@music/sdk/errors";
import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";

/** The message to show for any thrown value; server failures carry their own wording. */
export const describeFailure = (cause: unknown): string =>
  cause instanceof Error ? errorMessage(cause) : "Something went wrong. Try again.";

/** Shows a failure as an error toast. */
export const toastFailure = (cause: unknown): void => {
  toast.error(describeFailure(cause));
};

/** Options for {@link useAction}. */
export interface ActionOptions<Result> {
  /** Builds the toast shown after success from the action's result. */
  readonly success?: (result: Result) => string;
}

/**
 * Wraps an async action with the immediate feedback every action needs: `pending` while it runs,
 * then a success toast (when given) or an error toast. Resolves with the result, or `undefined`
 * after a failure, so callers can continue only on success.
 */
export const useAction = <Args extends ReadonlyArray<unknown>, Result>(
  action: (...args: Args) => Promise<Result>,
  options: ActionOptions<Result> = {},
): readonly [run: (...args: Args) => Promise<Result | undefined>, pending: boolean] => {
  const [pending, setPending] = useState(false);
  const latest = useRef(options);

  latest.current = options;

  const run = useCallback(
    async (...args: Args): Promise<Result | undefined> => {
      setPending(true);

      try {
        const result = await action(...args);
        const success = latest.current.success;

        if (success !== undefined) toast.success(success(result));

        return result;
      } catch (cause) {
        toastFailure(cause);

        return undefined;
      } finally {
        setPending(false);
      }
    },
    [action],
  );

  return [run, pending] as const;
};
