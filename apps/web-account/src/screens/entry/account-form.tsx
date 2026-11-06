import { Button } from "@media/ui/components/button";
import { FieldError, TextField } from "@media/ui/components/text-field";
import { Link } from "@tanstack/react-router";
import { Match } from "effect";
import { ArrowRightIcon, LockIcon } from "lucide-react";
import type { FormEvent } from "react";

import { PasswordField } from "@/components/auth-page";

import { PASSWORD_RULE, passwordHint } from "./password";
import type { Submission } from "./submission";

/**
 * Which credentials the form asks for: a username and the person's password (`signIn`), a new
 * username and password (`newAccount`), or a new password for the username a link names
 * (`newPassword`), which shows read-only so a password manager files the password under it.
 */
export type AccountFields = "signIn" | "newAccount" | "newPassword";

/** The username and password fields of every sign-in page, its failure line, and its submit. */
export function AccountForm({
  fields,
  username,
  password,
  submission,
  submitLabel,
  onUsernameChange,
  onPasswordChange,
  onSubmit,
}: {
  readonly fields: AccountFields;
  readonly username: string;
  readonly password: string;
  readonly submission: Submission;
  readonly submitLabel: string;
  readonly onUsernameChange: (username: string) => void;
  readonly onPasswordChange: (password: string) => void;
  readonly onSubmit: () => void;
}) {
  const choosing = fields !== "signIn";

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    onSubmit();
  };

  return (
    <form className="flex flex-col gap-8" onSubmit={submit}>
      <div className="flex flex-col gap-4">
        {fields === "newPassword" ? (
          <TextField
            label="Username"
            name="username"
            autoComplete="username"
            readOnly
            value={username}
            className="[&_input]:bg-transparent [&_input]:text-text-muted"
            trailing={<LockIcon className="size-4" strokeWidth={1.75} aria-hidden />}
          />
        ) : (
          <TextField
            label="Username"
            name="username"
            autoComplete="username"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            required
            value={username}
            onChange={(event) => onUsernameChange(event.target.value)}
          />
        )}
        <PasswordField
          label={fields === "newPassword" ? "New password" : "Password"}
          labelAction={
            choosing ? (
              <span className="text-label/caption text-text-muted">{PASSWORD_RULE}</span>
            ) : undefined
          }
          name="password"
          autoComplete={choosing ? "new-password" : "current-password"}
          required
          value={password}
          hint={choosing ? passwordHint(password) : undefined}
          onChange={(event) => onPasswordChange(event.target.value)}
        />
        <SubmissionLine submission={submission} />
      </div>
      <Button
        type="submit"
        size="lg"
        className="w-full"
        disabled={submission.kind === "submitting"}
      >
        {submitLabel}
        <ArrowRightIcon strokeWidth={2} aria-hidden />
      </Button>
    </form>
  );
}

function SubmissionLine({ submission }: { readonly submission: Submission }) {
  return Match.value(submission).pipe(
    Match.discriminatorsExhaustive("kind")({
      idle: () => null,
      submitting: () => null,
      failed: ({ message }) => <FieldError>{message}</FieldError>,
      sharedDevice: () => (
        <FieldError>
          This browser is a shared device. Open your tile from its picker instead.{" "}
          <Link to="/" className="font-semibold text-text underline underline-offset-2">
            Go to the picker
          </Link>
        </FieldError>
      ),
    }),
  );
}
