import { useState } from "react";

import { AuthPage, PageTitle } from "@/components/auth-page";
import { useAccountActions } from "@/session/account";

import { AccountForm } from "./entry/account-form";
import { passwordProblem } from "./entry/password";
import { useSubmission } from "./entry/submission";
import type { Submission } from "./entry/submission";

const LINES = { Conflict: "This server has an owner now. Sign in instead." } as const;

/** Create the server's first account, its owner. */
export function SetUpOwnerScreen() {
  const { signIn } = useAccountActions();
  const { submission, submit, refuse, edit } = useSubmission(LINES);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  const onSubmit = (): void => {
    const problem = passwordProblem(password);

    if (problem !== null) {
      refuse(problem);

      return;
    }

    void submit(() => signIn({ kind: "setUpOwner", username: username.trim(), password }));
  };

  return (
    <SetUpOwnerView
      username={username}
      password={password}
      submission={submission}
      onUsernameChange={(next) => {
        setUsername(next);
        edit();
      }}
      onPasswordChange={(next) => {
        setPassword(next);
        edit();
      }}
      onSubmit={onSubmit}
    />
  );
}

/** The first-owner page for `submission`, without the session it creates. */
export function SetUpOwnerView({
  username,
  password,
  submission,
  onUsernameChange,
  onPasswordChange,
  onSubmit,
}: {
  readonly username: string;
  readonly password: string;
  readonly submission: Submission;
  readonly onUsernameChange: (username: string) => void;
  readonly onPasswordChange: (password: string) => void;
  readonly onSubmit: () => void;
}) {
  return (
    <AuthPage>
      <PageTitle>Set up your server.</PageTitle>
      <AccountForm
        fields="newAccount"
        username={username}
        password={password}
        submission={submission}
        submitLabel="Create owner account"
        onUsernameChange={onUsernameChange}
        onPasswordChange={onPasswordChange}
        onSubmit={onSubmit}
      />
    </AuthPage>
  );
}
