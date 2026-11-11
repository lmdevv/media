import { Predicate } from "effect";
import { useState } from "react";

import { describeFailure } from "@media/ui/lib/failure";
import type { FailureTag } from "@media/ui/lib/failure";
import { SharedDeviceError } from "@/session/account";

/** What a sign-in form's submit is doing. */
export type Submission =
  | { readonly kind: "idle" }
  | { readonly kind: "submitting" }
  | { readonly kind: "failed"; readonly message: string }
  /** The sign-in worked, but this browser is a shared device, whose picker opens tiles instead. */
  | { readonly kind: "sharedDevice" };

/** The line a form shows for each expected failure it explains in its own words. */
export type FailureLines = Partial<Record<FailureTag, string>>;

const IDLE: Submission = { kind: "idle" };

const RATE_LIMITED = "Too many tries. Wait a few minutes, then try again.";

/** The line for `cause`: the form's own for its tag, else the general one. */
export const failureLine = (cause: unknown, lines: FailureLines): string => {
  const own = Object.entries({ RateLimited: RATE_LIMITED, ...lines }).find(([tag]) =>
    Predicate.isTagged(cause, tag),
  );

  return own?.[1] ?? describeFailure(cause);
};

/**
 * A form's submission. A sign-in that works navigates away, so the form stays `submitting` until it
 * unmounts and never submits twice.
 */
export const useSubmission = (lines: FailureLines) => {
  const [submission, setSubmission] = useState<Submission>(IDLE);

  return {
    submission,
    submit: async (run: () => Promise<void>): Promise<void> => {
      setSubmission({ kind: "submitting" });

      try {
        await run();
      } catch (cause) {
        setSubmission(
          cause instanceof SharedDeviceError
            ? { kind: "sharedDevice" }
            : { kind: "failed", message: failureLine(cause, lines) },
        );
      }
    },
    /** Shows `message` without submitting, for a check the form makes itself. */
    refuse: (message: string): void => setSubmission({ kind: "failed", message }),
    /** Clears a failure once the person edits the form; a submit in flight stays. */
    edit: (): void => setSubmission((current) => (current.kind === "submitting" ? current : IDLE)),
  };
};
