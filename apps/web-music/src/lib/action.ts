import { describeFailure, isFailure, toastFailure } from "@media/ui/lib/failure";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

export { describeFailure, toastFailure };

/** Whether `error` is the server saying the item a screen shows doesn't exist (any more). */
export const isNotFoundFailure = (error: Error): boolean => isFailure(error, "NotFound");

/** Whether `error` is the server saying this browser's session ended. */
export const isSignedOutFailure = (error: Error): boolean => isFailure(error, "Unauthenticated");

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

  useEffect(() => {
    latest.current = options;
  });

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
