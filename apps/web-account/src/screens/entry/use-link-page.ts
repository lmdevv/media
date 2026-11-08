import { useState } from "react";

import { linkStateOf } from "./link-page";
import type { LinkForm, LinkState } from "./link-page";
import type { Lookup } from "./lookup";
import { passwordProblem } from "./password";
import { useSubmission } from "./submission";
import type { FailureLines } from "./submission";

/** An invite or reset link page's state and form. */
export interface LinkPage<Found> {
  readonly state: LinkState<Found>;
  readonly form: LinkForm;
}

/**
 * An invite or reset link's page: its lookup's state and the form that signs in with it. The
 * sign-in uses the link up, and its lookup then refuses it, so the page holds the link it
 * submitted with until the sign-in navigates away or fails.
 */
export const useLinkPage = <Found>(
  lookup: Lookup<Found>,
  lines: FailureLines,
  signIn: (credentials: { readonly username: string; readonly password: string }) => Promise<void>,
): LinkPage<Found> => {
  const { submission, submit, refuse, edit } = useSubmission(lines);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [submitted, setSubmitted] = useState<Found | null>(null);
  const looked = linkStateOf(lookup);

  const state: LinkState<Found> =
    submitted !== null && submission.kind === "submitting"
      ? { kind: "open", link: submitted }
      : looked;

  const onSubmit = (): void => {
    const problem = passwordProblem(password);

    if (problem !== null) {
      refuse(problem);

      return;
    }

    if (looked.kind === "open") setSubmitted(looked.link);

    void submit(() => signIn({ username: username.trim(), password }));
  };

  return {
    state,
    form: {
      username,
      password,
      submission,
      onUsernameChange: (next) => {
        setUsername(next);
        edit();
      },
      onPasswordChange: (next) => {
        setPassword(next);
        edit();
      },
      onSubmit,
    },
  };
};
