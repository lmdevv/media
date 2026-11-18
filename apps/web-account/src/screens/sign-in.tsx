import { useState } from "react";

import { AuthPage, PageTitle } from "@/components/auth-page";
import { useAccountActions } from "@/session/account";

import { AccountForm } from "./entry/account-form";
import { useSubmission } from "./entry/submission";
import type { Submission } from "./entry/submission";

const LINES = { Unauthenticated: "Wrong username or password." } as const;

/** Sign in with a username and password. */
export function SignInScreen() {
  const { signIn } = useAccountActions();
  const { submission, submit, edit } = useSubmission(LINES);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  return (
    <SignInView
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
      onSubmit={() =>
        void submit(() => signIn({ kind: "password", username: username.trim(), password }))
      }
    />
  );
}

/** The sign-in page for `submission`, without the session it signs in to. */
export function SignInView({
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
      <PageTitle>Sign in.</PageTitle>
      <AccountForm
        fields="signIn"
        username={username}
        password={password}
        submission={submission}
        submitLabel="Sign in"
        onUsernameChange={onUsernameChange}
        onPasswordChange={onPasswordChange}
        onSubmit={onSubmit}
      />
    </AuthPage>
  );
}
