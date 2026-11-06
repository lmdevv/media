import { buttonVariants } from "@media/ui/lib/button-variants";
import { Link } from "@tanstack/react-router";
import { useState } from "react";

import { AuthPage, PageTitle } from "@/components/auth-page";
import { useAccountActions } from "@/session/account";

import { AccountForm } from "./entry/account-form";
import { useSubmission } from "./entry/submission";
import type { Submission } from "./entry/submission";

const LINES = { Unauthenticated: "Wrong username or password." } as const;

/** Sign in with a username and password; `adding` signs someone else in on this browser. */
export function SignInScreen({ adding }: { readonly adding: boolean }) {
  const { signIn } = useAccountActions();
  const { submission, submit, edit } = useSubmission(LINES);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  return (
    <SignInView
      adding={adding}
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
  adding,
  username,
  password,
  submission,
  onUsernameChange,
  onPasswordChange,
  onSubmit,
}: {
  readonly adding: boolean;
  readonly username: string;
  readonly password: string;
  readonly submission: Submission;
  readonly onUsernameChange: (username: string) => void;
  readonly onPasswordChange: (password: string) => void;
  readonly onSubmit: () => void;
}) {
  return (
    <AuthPage>
      <PageTitle>{adding ? "Add someone." : "Sign in."}</PageTitle>
      <div className="flex flex-col gap-4">
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
        {adding ? (
          <Link
            to="/"
            className={buttonVariants({ variant: "subtle", size: "lg", className: "w-full" })}
          >
            Cancel
          </Link>
        ) : null}
      </div>
    </AuthPage>
  );
}
